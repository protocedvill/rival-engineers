import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { abandonParts } from "../planner/conflicts"
import { planAdoption } from "../planner/adoption"
import { adoptRoute, findModule } from "../planner/layout"
import * as LG from "../planner/logical"
import type { LogicalGraph, LogicalNode } from "../planner/logical"
import { sealedInputs } from "../planner/placement"
import * as RT from "../planner/runtime"
import { markDirty, terrainView } from "../planner/terrain"
import { connectionId } from "../shared/ids"
import { findEntities } from "../work"
import { resyncReserved } from "./evict"
import type { FactoryState } from "./factory"
import * as HO from "./handover"

// P36 (a, proposed; an exception to D28 limited to power fuel, like D43 for bootstrap sites): a steam block's fuel
// producer (a coal outpost feeding a power node) whose drills have less than `factory-power-fuel-minutes` of ore left at
// its planned rate is given up: its entities are deconstructed, its module and routes (with their splitter taps) leave
// the layout and its node and edges the graph. The design then misses the steam block's fuel producer and plans a new
// one (a power goal) on fresh ore; consumers that tapped the old one get new producers the same way. The crew hand-feeds
// any empty boiler (D54, factory.ts upkeep), so electric drills on a dark network can't deadlock the rebuild.

/** How often the ore under steam-block fuel producers is counted (find_entities per drill). */
const FUEL_CHECK_TICKS = 3600

/**
 * Goalpost 1 safety valve: how long a retiring provider may wait for a built replacement before it is deconstructed
 * anyway (game-minutes). Without it, a provider whose replacement can never be placed would starve its consumers
 * forever instead of falling back to today's deconstruct-and-replan.
 */
const HANDOVER_MAX_MINUTES = 10

/** Whether `n` (a built module) feeds a power node through a belt. */
function feedsPower(g: LogicalGraph, n: LogicalNode): boolean {
  for (const e of LG.edgesFrom(g, n.id)) if (e.kind === "belt" && g.nodes[e.to]?.kind === "power") return true
  return false
}

/** Whether a power node has a fuel belt from a built producer. */
export function powerFuelled(g: LogicalGraph, power: LogicalNode): boolean {
  for (const e of LG.edgesInto(g, power.id)) if (e.kind === "belt" && e.from !== undefined && g.nodes[e.from]?.lifecycle === "built") return true
  return false
}

/** Whether every drill of `n`'s mine has run dry (true when it has no module, resource or drills left). */
function mineDry(ctx: FuelCtx, n: LogicalNode): boolean {
  const m = findModule(ctx.f.layout, n.id)
  const resource = m?.def.anchor?.resource
  if (m === undefined || resource === undefined) return true
  const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
  const drills = findEntities(ctx.surface, { type: "mining-drill", force: ctx.faction.force, area })
  return drills.length === 0 || oreLeft(ctx.surface, drills, resource).dry
}

/** Ore left (summed over the distinct resource tiles its drills reach) and whether every drill has run dry. */
function oreLeft(surface: LuaSurface, drills: LuaEntity[], resource: string): { amount: number; dry: boolean } {
  const seen: Record<string, boolean> = {}
  let amount = 0
  let dry = drills.length > 0
  for (const d of drills) {
    if (d.status !== defines.entity_status.no_minable_resources) dry = false
    for (const e of findEntities(surface, { type: "resource", name: resource, area: d.mining_area })) {
      const k = `${e.position.x},${e.position.y}`
      if (seen[k]) continue
      seen[k] = true
      amount += e.amount
    }
  }
  return { amount, dry }
}

/**
 * P36 (a): checks every built fuel producer of a steam block once per FUEL_CHECK_TICKS and gives up the first one whose
 * ore runs low. D67 (user, 2026-10-28): every other factory mine too, at `factory-mine-lead-minutes`; the handover is
 * started ahead (soak vps-d66 seed 8646103: three science mines ran dry 200-220 game-min after being built, and each
 * handover began only then, so lab clusters starved for the whole move). `busy`: a plan or growth works on a copy of the layout now (relocate after it). Returns the role given
 * up, if any.
 */
export function checkMineOre(ctx: FuelCtx, busy: boolean): string | undefined {
  const { f, config } = ctx
  if (config.factoryPowerFuelMinutes <= 0 && config.factoryMineLeadMinutes <= 0) return undefined
  if (busy || ctx.tick % FUEL_CHECK_TICKS >= config.brainIntervalTicks) return undefined
  for (const id of [...f.graph.nodeOrder]) {
    const n = f.graph.nodes[id]
    // B70: mines are `outpost` nodes; this checked `module` only and never fired (no P36 line in any M6 soak).
    if (n === undefined || n.lifecycle !== "built" || (n.kind !== "outpost" && n.kind !== "module")) continue
    if (f.handover?.[n.role] !== undefined) continue
    const power = feedsPower(f.graph, n)
    const lead = power ? config.factoryPowerFuelMinutes : config.factoryMineLeadMinutes
    if (lead <= 0) continue
    // A goal still building a connection from it (a new tap on its route) finishes first.
    let used = false
    for (const g of f.goals) if (g.status === "building" || g.status === "planning") for (const e of g.edges) if (e.from === n.role) used = true
    if (used) continue
    const m = findModule(f.layout, id)
    const resource = m?.def.anchor?.resource
    if (m === undefined || resource === undefined) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    const drills = findEntities(ctx.surface, { type: "mining-drill", force: ctx.faction.force, area })
    if (drills.length === 0) continue
    let rate = 0
    for (const e of LG.edgesFrom(f.graph, id)) if (e.kind === "belt") rate += e.plannedRate
    if (rate <= 0) rate = LG.rateIn(n.capacity.outputs, n.item ?? resource)
    const left = oreLeft(ctx.surface, drills, resource)
    const minutes = rate > 0 ? left.amount / rate / 60 : math.huge
    if (!left.dry && minutes >= lead) continue
    // D67: a dry mine that feeds no power is D55's (claim more of its patch first, else relocate).
    if (left.dry && !power) continue
    const what = power ? `P36 ${n.role}` : `D67 ${n.role}`
    const why = string.format("runs out (%.1f min of %s left at %.2f/s%s)", minutes, resource, rate, left.dry ? ", every drill dry" : "")
    // Goalpost 1: a producer that still has ore is not deconstructed before its replacement feeds its consumers.
    if (!left.dry) {
      if (beginHandover(ctx, n, what, why)) return n.role
      continue
    }
    relocate(ctx, n, what, why)
    return n.role
  }
  return undefined
}

/**
 * D54 (user, 2026-10-19): once electric drills can be built, a built factory outpost still on burner drills (one that
 * can't grow, like the steam block's old coal mine) is given up like a P36 relocation, one at a time; the design plans
 * it again with electric drills. Bootstrap sites are not factory outposts and stay. Returns the role given up, if any.
 */
export function replaceBurnerOutposts(ctx: FuelCtx & { force: LuaForce; electricDrill: string }, busy: boolean): string | undefined {
  const { f, config } = ctx
  if (busy || ctx.tick % FUEL_CHECK_TICKS >= config.brainIntervalTicks) return undefined
  if (ctx.force.recipes[ctx.electricDrill]?.enabled !== true) return undefined
  for (const id of [...f.graph.nodeOrder]) {
    const n = f.graph.nodes[id]
    if (n === undefined || n.lifecycle !== "built") continue
    const drill = findModule(f.layout, id)?.canonical.params?.drill
    if (typeof drill !== "string" || drill === ctx.electricDrill || prototypes.entity[drill]?.burner_prototype === undefined) continue
    // A goal still building a connection from it finishes first.
    let used = false
    for (const g of f.goals) if (g.status === "building" || g.status === "planning") for (const e of g.edges) if (e.from === n.role) used = true
    if (used) continue
    // Goalpost 1: the burner outpost still works; retirement waits for its replacement to be connected.
    return beginHandover(ctx, n, `D54 ${n.role}`, `uses ${drill}: electric drills are researched`) ? n.role : undefined
  }
  return undefined
}

interface FuelCtx {
  faction: FactionState
  f: FactoryState
  config: Config
  surface: LuaSurface
  tick: number
}

/** B51: how far (Manhattan steps over free ground) an input lane must lead out, as B45's `portEscape` (B57: 32). */
const LANE_ESCAPE = 32

/**
 * B51 (seed 3333): the modules among `ids` with a belt input that no edge feeds any more and whose lane no longer leads
 * out: built routes and other modules walled it in while a tap fed it. No plan can feed such a port.
 */
function sealedConsumers(ctx: FuelCtx, ids: string[]): LogicalNode[] {
  const f = ctx.f
  const t = storage.terrains?.[f.terrain]
  if (t === undefined) return []
  const view = RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t))
  const out: LogicalNode[] = []
  for (const id of ids) {
    const n = f.graph.nodes[id]
    // Production modules only: power is hand-fed when its fuel stops (D54), and labs and mines have no such lane.
    if (n === undefined || n.kind !== "module" || out.indexOf(n) >= 0) continue
    const fed: Record<string, boolean> = {}
    for (const e of LG.edgesInto(f.graph, id)) if (e.kind === "belt" && e.toPort !== undefined) fed[e.toPort] = true
    if (sealedInputs(f.layout, view, id, fed, LANE_ESCAPE).length > 0) out.push(n)
  }
  return out
}

/**
 * Goalpost 1: mark a provider as retiring. The design plans its replacement (a parallel role, because the old role
 * still exists in the graph) and nothing is deconstructed until that replacement feeds every consumer port it served.
 * `serviceHandovers` retires it.
 */
export function beginHandover(ctx: FuelCtx, n: LogicalNode, what: string, why: string): boolean {
  const f = ctx.f
  f.handover ??= {}
  if (!HO.beginHandover(f.handover, n.role, n.id, ctx.tick, why)) return false
  log(`[rival-engineers] faction ${ctx.faction.name}: ${what} (${n.id}) ${why}: handing over, the replacement is connected before deconstruction (goalpost 1)`)
  return true
}

/**
 * Goalpost 1: retires providers whose handover is complete. A `stalled` handover (no replacement appeared in
 * HANDOVER_MAX_MINUTES) is retired anyway, so a replacement that can never be built cannot starve the consumers;
 * a mine whose drills still find ore is kept until they run dry (it still feeds them).
 */
export function serviceHandovers(ctx: FuelCtx): void {
  const f = ctx.f
  if (f.handover === undefined) return
  const feeds: HO.HandoverFeed[] = []
  for (const eid of f.graph.edgeOrder) {
    const e = f.graph.edges[eid]
    if (e.kind !== "belt" || e.from === undefined || e.toPort === undefined) continue
    const p = f.graph.nodes[e.from]
    if (p === undefined) continue
    feeds.push({ role: p.role, node: p.id, toModule: e.to, toPort: e.toPort, built: p.lifecycle === "built" })
  }
  const roles: string[] = []
  for (const id of f.graph.nodeOrder) roles.push(f.graph.nodes[id].role)
  HO.pruneHandovers(f.handover, roles)
  for (const [role] of pairs(f.handover)) {
    const rec = f.handover[role as string]
    const n = f.graph.nodes[rec.node]
    if (n === undefined) continue
    const v = HO.handoverVerdict(rec, feeds, ctx.tick, HANDOVER_MAX_MINUTES)
    if (v === "waiting") continue
    // D67: a mine handed over ahead still feeds its consumers; the safety valve waits until its drills run dry (checked
    // once a minute), or a slow replacement would retire a mine with most of its lead time of ore left. B73 (soak dbg-d67
    // seed 8646103): a D55 mine that is short because one of its 4 drills ran dry still made 1.5/s of 1.7/s; retiring
    // it at the valve left the cluster with nothing. So any mine with ore is kept (mineDry is true for non-mines).
    if (v === "stalled" && (ctx.tick % FUEL_CHECK_TICKS >= ctx.config.brainIntervalTicks || !mineDry(ctx, n))) continue
    delete f.handover[role as string]
    relocate(ctx, n, `handover ${n.role}`, v === "stalled" ? `no replacement within ${HANDOVER_MAX_MINUTES} game-min (${rec.why})` : `replacement connected (${rec.why})`)
  }
}

export function relocate(ctx: FuelCtx, n: LogicalNode, what: string, why: string, depth = 0): void {
  const f = ctx.f
  const m = findModule(f.layout, n.id)!
  // Provider handover (goalpost 1): a consumer already fed by this provider keeps its belt. The replacement side-loads
  // into that route (`Route.merge`), so the route is adopted by the replacement connection instead of ripped with the
  // module, and the consumer never loses its feed while the crew deconstructs the old one.
  const adopt = planAdoption(f.graph, f.layout, n.id)
  const adoptIds = adopt.map((a) => a.rid)
  const r = abandonParts(ctx.surface, ctx.faction, f.layout, { modules: [n.id], routes: [], poles: [] }, ctx.config.factoryBuildPriority, adoptIds)
  // Re-home the adopted routes to the replacement connection and keep them in its flow.
  for (const a of adopt) {
    if (!adoptRoute(f.layout, a.rid, connectionId(a.conn), a.from)) continue
    const heir = f.graph.edges[a.heir]
    if (heir !== undefined) heir.physical = [...(heir.physical ?? []), a.rid]
  }
  // D55/P36: the replacement goal waits for these clear jobs; until then the old footprint is still `OWN` on the map.
  if (r.clearJobs.length > 0) {
    f.relocation ??= {}
    f.relocation[n.role] = r.clearJobs
  }
  // Belt edges from it lose their routes (their consumers get producers again from the design); taps on its routes went
  // with them (ripRoute), so edges whose physical route is gone are dropped too.
  const gone: Record<string, boolean> = {}
  for (const rid of r.routes) gone[rid] = true
  // D52 aliases: a node that shared its whole-patch mine has no module of its own and fed through its routes; it goes
  // with it (the design plans its role again), or later goals connect to its missing port.
  const drop: LogicalNode[] = [n]
  const consumers: string[] = []
  for (const eid of [...f.graph.edgeOrder]) {
    const e = f.graph.edges[eid]
    if (e.kind !== "belt") continue
    let lost = false
    for (const p of e.physical ?? []) if (gone[p]) lost = true
    // A handover keeps the route but never the retiring edge: the node it starts from is gone.
    if (e.from === n.id) lost = true
    if (!lost) continue
    LG.removeEdge(f.graph, eid)
    if (e.to !== undefined && consumers.indexOf(e.to) < 0) consumers.push(e.to)
    const from = e.from !== undefined ? f.graph.nodes[e.from] : undefined
    if (from !== undefined && drop.indexOf(from) < 0 && findModule(f.layout, from.id) === undefined) drop.push(from)
  }
  for (const d of drop) {
    LG.removeNode(f.graph, d.id)
    if (f.growFails !== undefined) delete f.growFails[d.role]
    if (f.noTap !== undefined) delete f.noTap[d.role]
    if (f.providerShort !== undefined) delete f.providerShort[d.role]
    if (f.providerSplit !== undefined) delete f.providerSplit[d.role]
    if (f.providerNoTap !== undefined) for (const [key] of pairs(f.providerNoTap)) if (string.find(key as string, `${d.role}=>`, 1, true)[0] === 1) delete f.providerNoTap[key as string]
    if (f.cluster1Caps !== undefined) delete f.cluster1Caps[d.role]
  }
  f.fuelRelocations = (f.fuelRelocations ?? 0) + 1
  resyncReserved(ctx.faction, f.layout)
  // Its ore tiles are worked out: the terrain is scanned again before the next plan.
  markDirty(ctx.faction.surface, { x: m.rect.x - 8, y: m.rect.y - 8 }, { x: m.rect.x + m.rect.w + 8, y: m.rect.y + m.rect.h + 8 })
  log(`[rival-engineers] faction ${ctx.faction.name}: ${what} (${n.id}) ${why}: ${r.clearJobs.length} entities to deconstruct, ${r.routes.length} routes dropped, ${adopt.length} adopted${drop.length > 1 ? `, ${drop.length - 1} aliased nodes dropped` : ""}; the design plans a new one`)
  // B51: a consumer left with a walled-in input lane goes too (once, not further down the chain).
  if (depth > 0) return
  for (const c of sealedConsumers(ctx, consumers)) {
    if (f.graph.nodes[c.id] === undefined) continue
    relocate(ctx, c, `B51 ${c.role}`, "lost its feed and its input lane is walled in", depth + 1)
  }
}
