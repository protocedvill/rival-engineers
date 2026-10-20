import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { abandonParts } from "../planner/conflicts"
import { findModule } from "../planner/layout"
import * as LG from "../planner/logical"
import type { LogicalGraph, LogicalNode } from "../planner/logical"
import { markDirty } from "../planner/terrain"
import { findEntities } from "../work"
import { resyncReserved } from "./evict"
import type { FactoryState } from "./factory"

// P36 (a, proposed; an exception to D28 limited to power fuel, like D43 for bootstrap sites): a steam block's fuel
// producer (a coal outpost feeding a power node) whose drills have less than `factory-power-fuel-minutes` of ore left at
// its planned rate is given up: its entities are deconstructed, its module and routes (with their splitter taps) leave
// the layout and its node and edges the graph. The design then misses the steam block's fuel producer and plans a new
// one (a power goal) on fresh ore; consumers that tapped the old one get new producers the same way. The crew hand-feeds
// any empty boiler (D54, factory.ts upkeep), so electric drills on a dark network can't deadlock the rebuild.

/** How often the ore under steam-block fuel producers is counted (find_entities per drill). */
const FUEL_CHECK_TICKS = 3600

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
 * ore runs low. `busy`: a plan or growth works on a copy of the layout now (relocate after it). Returns the role given
 * up, if any.
 */
export function checkPowerFuel(ctx: FuelCtx, busy: boolean): string | undefined {
  const { f, config } = ctx
  const lead = config.factoryPowerFuelMinutes
  if (lead <= 0 || busy || ctx.tick % FUEL_CHECK_TICKS >= config.brainIntervalTicks) return undefined
  for (const id of [...f.graph.nodeOrder]) {
    const n = f.graph.nodes[id]
    if (n === undefined || n.lifecycle !== "built" || n.kind !== "module" || !feedsPower(f.graph, n)) continue
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
    relocate(ctx, n, `P36 ${n.role}`, string.format("runs out (%.1f min of %s left at %.2f/s%s)", minutes, resource, rate, left.dry ? ", every drill dry" : ""))
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
    relocate(ctx, n, `D54 ${n.role}`, `uses ${drill}: electric drills are researched`)
    return n.role
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

export function relocate(ctx: FuelCtx, n: LogicalNode, what: string, why: string): void {
  const f = ctx.f
  const m = findModule(f.layout, n.id)!
  const r = abandonParts(ctx.surface, ctx.faction, f.layout, { modules: [n.id], routes: [], poles: [] }, ctx.config.factoryBuildPriority)
  // Belt edges from it lose their routes (their consumers get producers again from the design); taps on its routes went
  // with them (ripRoute), so edges whose physical route is gone are dropped too.
  const gone: Record<string, boolean> = {}
  for (const rid of r.routes) gone[rid] = true
  for (const eid of [...f.graph.edgeOrder]) {
    const e = f.graph.edges[eid]
    if (e.kind !== "belt") continue
    let lost = false
    for (const p of e.physical ?? []) if (gone[p]) lost = true
    if (lost) LG.removeEdge(f.graph, eid)
  }
  LG.removeNode(f.graph, n.id)
  if (f.growFails !== undefined) delete f.growFails[n.role]
  if (f.noTap !== undefined) delete f.noTap[n.role]
  if (f.cluster1Caps !== undefined) delete f.cluster1Caps[n.role]
  f.fuelRelocations = (f.fuelRelocations ?? 0) + 1
  resyncReserved(ctx.faction, f.layout)
  // Its ore tiles are worked out: the terrain is scanned again before the next plan.
  markDirty(ctx.faction.surface, { x: m.rect.x - 8, y: m.rect.y - 8 }, { x: m.rect.x + m.rect.w + 8, y: m.rect.y + m.rect.h + 8 })
  log(`[rival-engineers] faction ${ctx.faction.name}: ${what} (${n.id}) ${why}: ${r.clearJobs.length} entities to deconstruct, ${r.routes.length} routes dropped; the design plans a new one`)
}
