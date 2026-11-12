import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { abandonParts } from "../planner/conflicts"
import { findModule } from "../planner/layout"
import { dropOrphans } from "../planner/orphans"
import type { LayoutState } from "../planner/layout"
import type { Rect } from "../planner/grid"
import * as LG from "../planner/logical"
import type { LogicalGraph, LogicalNode } from "../planner/logical"
import { sealedInputs } from "../planner/placement"
import { decodeWells } from "../modules/generators"
import * as RT from "../planner/runtime"
import { markDirty, terrainView } from "../planner/terrain"
import { findEntities } from "../work"
import { resyncReserved } from "./evict"
import type { FactoryState } from "./factory"
import * as RE from "./retire"
import * as CS from "./constraints"

// P36 (a, proposed; an exception to D28 limited to power fuel, like D43 for bootstrap sites): a steam block's fuel
// producer (a coal outpost feeding a power node) whose drills have less than `factory-power-fuel-minutes` of ore left at
// its planned rate is given up: its entities are deconstructed, its module and routes (with their splitter taps) leave
// the layout and its node and edges the graph. The design then misses the steam block's fuel producer and plans a new
// one (a power goal) on fresh ore; consumers that tapped the old one get new producers the same way. The crew hand-feeds
// any empty boiler (D54, factory.ts upkeep), so electric drills on a dark network can't deadlock the rebuild.

/** How often the ore under steam-block fuel producers is counted (find_entities per drill). */
const FUEL_CHECK_TICKS = 3600
/**
 * M7c (agent guess, proposed): a mine whose ore lasts less than this many retirement lead times at full output takes no
 * new consumers (seed 11: the blue line's iron smelter tapped an iron mine that was retired ~40 game-min later).
 */
const MINE_TAP_LIFE_LEADS = 2

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

/** M7c: whether a resource yields a fluid (crude oil): its wells never run dry the way ore does. */
function fluidResource(resource: string): boolean {
  const product = prototypes.entity[resource]?.mineable_properties.products?.[0]
  return product !== undefined && product.type === "fluid"
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
 * ore runs low. D67 (user, 2026-10-28): every other factory mine too, at `factory-mine-lead-minutes`; its retirement
 * starts ahead (soak vps-d66 seed 8646103: three science mines ran dry 200-220 game-min after being built, and each
 * replacement began only then, so lab clusters starved for the whole move). `busy`: a plan or growth works on a copy of the layout now (relocate after it). Returns the role given
 * up, if any.
 */
export function checkMineOre(ctx: FuelCtx, busy: boolean): string | undefined {
  const { f, config } = ctx
  if (config.factoryPowerFuelMinutes <= 0 && config.factoryMineLeadMinutes <= 0) return undefined
  if (busy || ctx.tick % FUEL_CHECK_TICKS >= config.brainIntervalTicks) return undefined
  // Rebuilt each check (a removed or replaced mine leaves no stale entry).
  const before = f.oreLeft ?? {}
  f.oreLeft = {}
  for (const id of [...f.graph.nodeOrder]) {
    const n = f.graph.nodes[id]
    // B70: mines are `outpost` nodes; this checked `module` only and never fired (no P36 line in any M6 soak).
    if (n === undefined || n.lifecycle !== "built" || (n.kind !== "outpost" && n.kind !== "module")) continue
    if (f.retiring?.[n.role] !== undefined) continue
    const power = feedsPower(f.graph, n)
    const lead = power ? config.factoryPowerFuelMinutes : config.factoryMineLeadMinutes
    if (lead <= 0) continue
    const m = findModule(f.layout, id)
    const resource = m?.def.anchor?.resource
    if (m === undefined || resource === undefined) continue
    // M7c: a fluid well's yield falls to a floor instead of running out: no ore count, no lead time.
    if (fluidResource(resource)) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    const drills = findEntities(ctx.surface, { type: "mining-drill", force: ctx.faction.force, area })
    if (drills.length === 0) continue
    const left = oreLeft(ctx.surface, drills, resource)
    // M7c: the design reads it to keep new consumers off a mine that runs out soon (stage.ts `oreRunsOut`).
    f.oreLeft ??= {}
    f.oreLeft[n.role] = { amount: left.amount, minMinutes: lead * MINE_TAP_LIFE_LEADS }
    const full = LG.rateIn(n.capacity.outputs, n.item ?? resource)
    const was = before[n.role]
    const short = (o: { amount: number; minMinutes: number } | undefined): boolean => o !== undefined && full > 0 && o.amount / full / 60 < o.minMinutes
    if (short(f.oreLeft[n.role]) && !short(was)) {
      log(string.format("[rival-engineers] faction %s: %s has %.0f min of %s left at full output (%.2f/s): no new consumers tap it", ctx.faction.name, n.role, left.amount / full / 60, resource, full))
    }
    // A goal still building a connection from it (a new tap on its route) finishes first.
    let used = false
    for (const g of f.goals) if (g.status === "building" || g.status === "planning") for (const e of g.edges) if (e.from === n.role) used = true
    if (used) continue
    let rate = 0
    for (const e of LG.edgesFrom(f.graph, id)) if (e.kind === "belt") rate += e.plannedRate
    if (rate <= 0) rate = LG.rateIn(n.capacity.outputs, n.item ?? resource)
    const minutes = rate > 0 ? left.amount / rate / 60 : math.huge
    if (!left.dry && minutes >= lead) continue
    // D67: a dry mine that feeds no power is D55's (claim more of its patch first, else relocate).
    if (left.dry && !power) continue
    const what = power ? `P36 ${n.role}` : `D67 ${n.role}`
    const why = string.format("runs out (%.1f min of %s left at %.2f/s%s)", minutes, resource, rate, left.dry ? ", every drill dry" : "")
    // D76: a producer that still has ore keeps producing while its replacement is planned and built.
    if (!left.dry) {
      if (beginRetire(ctx, n, what, why)) return n.role
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
    // D76: the burner outpost still works; it retires once its replacement is built.
    return beginRetire(ctx, n, `D54 ${n.role}`, `uses ${drill}: electric drills are researched`) ? n.role : undefined
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

/**
 * M7d.5: a fixed-site raw provider whose only failure is its power pole line is not helped by a region-radius retry:
 * the site is across ground the line cannot cross. Only the failed goal's **own** new modules are marked (the plan's
 * layout also holds the whole base): a mine's patch is remembered dead under the placement's own D57 key and terrain
 * stamp (`sitePatches`, as `noteDeadPatch` does), so the next plan's patch search skips it until that ground changes;
 * a pumpjack field's wells are not offered again.
 */
export function markUnreachableMinePatches(ctx: FuelCtx, goal: string, layout: LayoutState, own: string[], sites: Record<string, { key: string; area: Rect }> | undefined): void {
  const mine: Record<string, boolean> = {}
  for (const id of own) mine[id] = true
  const t = storage.terrains?.[ctx.f.terrain]
  const stamp = t !== undefined ? terrainView(t).stamp : undefined
  for (const m of layout.modules) {
    if (mine[m.id] !== true || m.fixed === true) continue
    if (m.def.generator === "pumpjack-field" && typeof m.def.params?.wells === "string") {
      // A crude field whose pumpjack provider cannot reach power is not offered again; another field may be nearer.
      const wells = decodeWells(m.def.params.wells as string)
      ctx.f.badWells ??= {}
      let added = 0
      for (const w of wells) {
        const key = `${w.x},${w.y}`
        if (ctx.f.badWells[key] !== true) {
          ctx.f.badWells[key] = true
          added++
        }
      }
      if (added > 0) log(`[rival-engineers] faction ${ctx.faction.name}: ${goal} pumpjack field has no pole path; marking ${added} well(s) bad for later plans`)
      continue
    }
    const site = sites?.[m.id]
    if (m.def.generator !== "mining-outpost" || site === undefined || stamp === undefined) continue
    ctx.f.deadPatches ??= {}
    ctx.f.deadPatches[site.key] = stamp(site.area)
    log(`[rival-engineers] faction ${ctx.faction.name}: ${goal} outpost patch ${site.key} has no pole path; marking it dead for later plans`)
  }
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

/** Every belt feed in the graph: provider role → consumer port, and whether the provider is built. */
function retireFeeds(g: LogicalGraph): RE.RetireFeed[] {
  const out: RE.RetireFeed[] = []
  for (const id of g.edgeOrder) {
    const e = g.edges[id]
    if (e === undefined || e.kind !== "belt" || e.from === undefined || e.toPort === undefined) continue
    const p = g.nodes[e.from]
    if (p !== undefined) out.push({ role: p.role, port: `${e.to}.${e.toPort}`, built: p.lifecycle === "built" })
  }
  return out
}

/**
 * D76: mark a provider as retiring. The design plans a parallel provider for its consumers (the old role still exists
 * in the graph); the old one keeps producing until `serviceRetiring` deconstructs it.
 */
export function beginRetire(ctx: FuelCtx, n: LogicalNode, what: string, why: string): boolean {
  const f = ctx.f
  f.retiring ??= {}
  if (!RE.beginRetire(f.retiring, n.role, n.id, ctx.tick, why, retireFeeds(f.graph))) return false
  log(`[rival-engineers] faction ${ctx.faction.name}: ${what} (${n.id}) ${why}: retiring, it keeps producing until a replacement is built or its drills run dry (D76)`)
  return true
}

/**
 * D76: deconstructs retiring providers whose drills ran dry or whose replacement feeds every consumer port they fed
 * (checked once a minute, like the ore). One whose replacement can never be built keeps producing.
 */
export function serviceRetiring(ctx: FuelCtx): void {
  const f = ctx.f
  if (f.retiring === undefined || ctx.tick % FUEL_CHECK_TICKS >= ctx.config.brainIntervalTicks) return
  const roles: string[] = []
  for (const id of f.graph.nodeOrder) roles.push(f.graph.nodes[id].role)
  RE.pruneRetiring(f.retiring, roles)
  const feeds = retireFeeds(f.graph)
  for (const [role] of pairs(f.retiring)) {
    const rec = f.retiring[role as string]
    const n = f.graph.nodes[rec.node]
    if (n === undefined) continue
    const heir = RE.replacement(rec, feeds)
    if (heir === undefined && !mineDry(ctx, n)) continue
    delete f.retiring[role as string]
    relocate(ctx, n, `retire ${n.role}`, heir !== undefined ? `replaced${heir !== "" ? ` by ${heir}` : ""} (${rec.why})` : `drills dry (${rec.why})`)
  }
}

export function relocate(ctx: FuelCtx, n: LogicalNode, what: string, why: string, depth = 0): void {
  const f = ctx.f
  const m = findModule(f.layout, n.id)!
  const r = abandonParts(ctx.surface, ctx.faction, f.layout, { modules: [n.id], routes: [], poles: [] }, ctx.config.factoryBuildPriority)
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
  const droppedRoles: string[] = []
  for (const eid of [...f.graph.edgeOrder]) {
    const e = f.graph.edges[eid]
    if (e.kind !== "belt") continue
    let lost = false
    for (const p of e.physical ?? []) if (gone[p]) lost = true
    if (e.from === n.id) lost = true
    if (!lost) continue
    LG.removeEdge(f.graph, eid)
    droppedRoles.push(e.role)
    if (e.to !== undefined && consumers.indexOf(e.to) < 0) consumers.push(e.to)
    const from = e.from !== undefined ? f.graph.nodes[e.from] : undefined
    if (from !== undefined && drop.indexOf(from) < 0 && findModule(f.layout, from.id) === undefined) drop.push(from)
  }
  // B202: a dropped alias takes all its edges, and their surviving routes go with what taps them (planner/orphans.ts).
  const orphans = dropOrphans(f.graph, f.layout, drop.map((d) => d.id), droppedRoles, gone)
  for (const c of orphans.consumers) if (consumers.indexOf(c) < 0) consumers.push(c)
  if (orphans.routes.length > 0) {
    const o = abandonParts(ctx.surface, ctx.faction, f.layout, { modules: [], routes: orphans.routes, poles: [] }, ctx.config.factoryBuildPriority)
    for (const id of o.clearJobs) r.clearJobs.push(id)
    for (const rid of orphans.routes) r.routes.push(rid)
  }
  for (const d of drop) {
    LG.removeNode(f.graph, d.id)
    CS.dropRole(f.constraints, d.role)
  }
  f.fuelRelocations = (f.fuelRelocations ?? 0) + 1
  resyncReserved(ctx.faction, f.layout)
  // Its ore tiles are worked out: the terrain is scanned again before the next plan.
  markDirty(ctx.faction.surface, { x: m.rect.x - 8, y: m.rect.y - 8 }, { x: m.rect.x + m.rect.w + 8, y: m.rect.y + m.rect.h + 8 })
  log(`[rival-engineers] faction ${ctx.faction.name}: ${what} (${n.id}) ${why}: ${r.clearJobs.length} entities to deconstruct, ${r.routes.length} routes dropped${drop.length > 1 ? `, ${drop.length - 1} aliased nodes dropped` : ""}; the design plans a new one`)
  // B51: a consumer left with a walled-in input lane goes too (once, not further down the chain).
  if (depth > 0) return
  for (const c of sealedConsumers(ctx, consumers)) {
    if (f.graph.nodes[c.id] === undefined) continue
    relocate(ctx, c, `B51 ${c.role}`, "lost its feed and its input lane is walled in", depth + 1)
  }
}
