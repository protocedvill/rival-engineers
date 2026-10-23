// Factory design (SPEC §5.5 goal graph, §5.8): from a stage target ("labs consume R red packs/s") to the module
// instances and flows that make it, and the diff against what the faction has. Pure: no Factorio globals.
//
// 1. The ratio solver (solver.ts, D21) walks the recipe graph down to raw resources; its consumers-first item order
//    drives the module walk below, and it reports locked recipes (what research must unblock).
// 2. Module selection (generators first, D34 / LayoutPolicy.moduleSelection): each demanded item gets a producer from
//    an ordered list of structural rules over prototypes (resource → mining outpost; one-ingredient furnace recipe →
//    smelter column; a two-ingredient recipe with a one-ingredient intermediate → red line, or a circuit block when
//    the intermediate yields ≥ 2; otherwise an assembler row). Each module is **sized** to its demand by growing its
//    generator parameter in steps (the same quanta `ModuleDef.expand` uses) until its output covers it.
// 3. Topology (D22): point-to-point gives every consumer port its own producer; splitter-tap shares one producer per
//    item (its consumers tap its belt).
// 4. Power and fuel last: the electric demand of every module sizes the steam block; the fuel of furnaces and boilers
//    is then mined (electric drills add power: iterate to a fixed point).
// 5. Capacity (D24/D25): every flow is checked against the usable capacity of the belt it would ride. Remedies in the
//    policy's order: a faster researched tier for that edge; otherwise the whole target is split into n production
//    clusters (parallel routes need parallel port pairs, i.e. module copies). A module that cannot grow big enough
//    splits the target the same way.

import { ProtoFacts } from "../modules/facts"
import { GeneratorName } from "../modules/generators"
import { ModuleDef, Rate } from "../modules/types"
import { availableTiers, BeltTier, decideOverflow, OverflowDecision } from "../planner/capacity"
import { edgeByRole, LogicalGraph, nodeByRole, NodeKind, rateIn } from "../planner/logical"
import { LayoutPolicy } from "../planner/policy"
import { solveNow, SolveResult } from "./solver"

/** A module kind: a generator, or "curated" (params.id names the curated module). */
export type ModuleKind = GeneratorName | "curated"

export type MakeModule = (this: void, generator: ModuleKind, params: Record<string, unknown>) => ModuleDef

export interface DesignContext {
  facts: ProtoFacts
  /** Module factory (runtime: the memoised library; T1: the generators with a facts table). */
  make: MakeModule
  /** Technologies researched and recipes enabled for the faction's force. */
  researched: Record<string, boolean>
  /**
   * Existing provider roles whose output cannot be expanded (B60). The design still uses their whole capacity for
   * the consumers they already serve, then plans a parallel provider for the residual; it never grows such a role to
   * an impossible rate or replaces it.
   */
  providerShort?: Record<string, boolean>
  /** Actual output capacity of built provider roles by role (used only for a short provider). */
  providerCaps?: Record<string, number>
  enabled: Record<string, boolean>
  /** Technologies the faction can research now or later (the research goal): designs may use what they unlock. */
  plannable?: Record<string, boolean>
  /** Resource entities the faction knows about. */
  resources: string[]
  /** D42 / D51: the chest for module buffer depots (smelter columns, assembler rows, circuit blocks), "" or absent = none. */
  buffer?: string
  /** Burner fuel (coal) and entity choices (config defaults, from prototypes). */
  fuel: string
  assembler: string
  furnace: string
  electricDrill: string
  burnerDrill: string
  lab: string
  boiler: string
  engine: string
  /** Science packs the labs take (one belt port each). */
  packs: string[]
  /** Seconds per research unit the lab count is sized for. */
  researchUnitTime: number
  tiers: BeltTier[]
  policy: LayoutPolicy
  /**
   * B2 (D36): items whose producer feeds these consumer roles through splitter taps (one producer, role `item`), decided
   * when splitters were worth researching. Other demands for the item stay point-to-point.
   */
  taps?: Record<string, string[]>
  /**
   * Curated modules by the item they make (M6: the green science line). Generators come first (D34); a curated module
   * is used for an item no generator rule can make with a producible input chain.
   */
  curated?: Record<string, string>
  /**
   * B19 (M6): providers are shared through splitter taps once splitters can be built. `keep`: `item@consumer role`
   * (already fed) → its producer's role (it keeps it). New consumers of an item first tap a producer of it with spare capacity
   * (`spare`: item → producer role → planned output minus what its edges carry), else share one new producer per cluster
   * (`item*>first consumer`). Absent: point-to-point.
   * `fallback` (P36 (b), proposed): item → built producer roles, nearest first, that new consumers tap when a new producer
   * of the item could not be placed (the first one takes them all and grows).
   */
  sharing?: { keep: Record<string, string>; spare: Record<string, Record<string, number>>; fallback?: Record<string, string[]> }
  /**
   * M6: the most the built steam block can supply when it can't grow any more (its expansion keeps failing, e.g. the
   * shore is taken): the excess gets a second steam block (`power#2`). Absent: the steam block grows.
   */
  powerCap?: number
  /**
   * M6: the largest share of the stage target production cluster 1 may take (0..1): some of its modules (the previous
   * stage's) can't grow far enough, so the other clusters make the rest. Absent: equal shares.
   */
  cluster1Max?: number
}

export interface DesignTarget {
  /** Science pack consumed by the labs, packs/s. */
  item: string
  perSecond: number
  /** M6: more packs the labs consume at the same time (30 red + 30 green: the green pack here). */
  also?: { item: string; perSecond: number }[]
  /**
   * A mall (material supply for buildings) as a second sink: a curated module whose `chest-out` ports the crew empties,
   * planned at `utilization` of its full-speed inputs (it only runs while its chests have room).
   */
  mall?: { id: string; utilization: number }
}

export interface DesignPort {
  port: string
  item: string
  /** Planned items/s through the port. */
  rate: number
}

export interface DesignNode {
  role: string
  kind: NodeKind
  generator: ModuleKind
  params: Record<string, unknown>
  def: ModuleDef
  /** Main product and its planned rate (packs/s for labs, W for power). */
  item: string
  need: number
  /** Output capacity for `item` at full speed. */
  capacity: number
  inputs: DesignPort[]
  /** Electric demand at full speed (W); power nodes: supply. */
  powerW: number
  /** Production cluster (1-based) when the target is split. */
  cluster: number
}

export interface DesignEdge {
  role: string
  item: string
  from: string
  fromPort: string
  to: string
  toPort: string
  rate: number
  /** Rate at the next stage target (policy headroom, D27). */
  headroomRate: number
  belt: string
  decision: OverflowDecision
  /** B60: this edge feeds a consumer already fed by another provider; the router side-loads it into that route. */
  merge?: boolean
}

export interface Design {
  target: DesignTarget
  nodes: DesignNode[]
  edges: DesignEdge[]
  electricW: number
  clusters: number
  /** Technologies the design's modules need that are not researched (research unblocks these first). */
  techs: string[]
  /** D24 remedies applied (edge role → what). */
  overflow: Record<string, string>
  errors: string[]
  solve: SolveResult
}

const EPS = 1e-9

// ---------------------------------------------------------------------------------------------------------
// Module rules (generators first)

/**
 * Electric drills for mining outposts: enabled now, or unlockable by research the faction will do (`plannable`), so
 * production designs don't change once the research is done.
 */
function electricDrills(ctx: DesignContext): boolean {
  const recipe = ctx.facts.recipeForItem(ctx.electricDrill) ?? ctx.electricDrill
  if (ctx.enabled[recipe]) return true
  const tech = ctx.facts.unlockedBy(recipe)
  return tech !== undefined && ctx.plannable?.[tech] === true
}

/** Electric drills can be built now (their recipe is enabled), not only planned for. */
function electricDrillsNow(ctx: DesignContext): boolean {
  return ctx.enabled[ctx.facts.recipeForItem(ctx.electricDrill) ?? ctx.electricDrill] === true
}

function resourceFor(ctx: DesignContext, item: string): string | undefined {
  for (const res of ctx.resources) if (ctx.facts.resourceProduct(res) === item) return res
  return undefined
}

/** The generator that makes `item`, by structure of its recipe. */
export function generatorFor(ctx: DesignContext, item: string): GeneratorName | undefined {
  return generatorRule(ctx, item)
}

/**
 * The module that makes `item`: a generator whose inputs can all be made (recursively), else a curated module that
 * makes it (generators first, D34; the green line is curated because an inserter has three ingredients).
 */
export function producerFor(ctx: DesignContext, item: string): ModuleKind | undefined {
  const gen = generatorRule(ctx, item)
  const curated = ctx.curated?.[item]
  if (gen !== undefined && (curated === undefined || chainProducible(ctx, item, 0))) return gen
  return curated !== undefined ? "curated" : gen
}

/** Whether every ingredient of `item`'s recipe has a generator (down to raw resources). */
function chainProducible(ctx: DesignContext, item: string, depth: number): boolean {
  if (depth > 8) return false
  if (resourceFor(ctx, item) !== undefined) return true
  const gen = generatorRule(ctx, item)
  if (gen === undefined) return false
  const rn = ctx.facts.recipeForItem(item)
  const r = rn !== undefined ? ctx.facts.recipe(rn) : undefined
  if (r === undefined) return false
  for (const ing of r.ingredients) if (!chainProducible(ctx, ing.name, depth + 1)) return false
  return true
}

function generatorRule(ctx: DesignContext, item: string): GeneratorName | undefined {
  if (resourceFor(ctx, item) !== undefined) return "mining-outpost"
  const rn = ctx.facts.recipeForItem(item)
  const r = rn !== undefined ? ctx.facts.recipe(rn) : undefined
  if (r === undefined) return undefined
  const furnaceCats = ctx.facts.entity(ctx.furnace)?.craftingCategories ?? []
  if (furnaceCats.indexOf(r.category) >= 0 && r.ingredients.length === 1) return "smelter-column"
  if (r.ingredients.length === 2) {
    for (const ing of r.ingredients) {
      const sn = ctx.facts.recipeForItem(ing.name)
      const sub = sn !== undefined ? ctx.facts.recipe(sn) : undefined
      if (sub === undefined || sub.category !== r.category || sub.ingredients.length !== 1) continue
      let amount = 1
      for (const p of sub.products) if (p.name === ing.name) amount = p.amount
      return amount >= 2 ? "circuit-block" : "red-line"
    }
  }
  if (r.ingredients.length >= 1 && r.ingredients.length <= 2) return "assembler-row"
  return undefined
}

/** Candidate parameter sets for a generator, smallest first. */
function sizes(ctx: DesignContext, gen: GeneratorName, item: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (gen === "mining-outpost") {
    const resource = resourceFor(ctx, item)!
    const electric = electricDrills(ctx)
    const drill = electric ? ctx.electricDrill : ctx.burnerDrill
    if (electric) {
      out.push({ resource, rows: 2, sides: 1, drill })
      for (let rows = 2; rows <= 24; rows += 2) out.push({ resource, rows, sides: 2, drill })
    } else {
      out.push({ resource, rows: 1, sides: 1, drill })
      for (let rows = 1; rows <= 16; rows++) out.push({ resource, rows, sides: 2, drill })
    }
  } else if (gen === "smelter-column") {
    const recipe = ctx.facts.recipeForItem(item)!
    for (let n = 4; n <= 48; n += 4) out.push({ recipe, furnaces: n, furnace: ctx.furnace, fuel: ctx.fuel, buffer: ctx.buffer ?? "" })
  } else if (gen === "red-line") {
    for (let u = 1; u <= 12; u++) out.push({ recipe: ctx.facts.recipeForItem(item), units: u, machine: ctx.assembler })
  } else if (gen === "circuit-block") {
    for (let u = 1; u <= 8; u++) out.push({ recipe: ctx.facts.recipeForItem(item), units: u, machine: ctx.assembler, buffer: ctx.buffer ?? "" })
  } else if (gen === "assembler-row") {
    for (let n = 2; n <= 24; n += 2) out.push({ recipe: ctx.facts.recipeForItem(item), count: n, machine: ctx.assembler, buffer: ctx.buffer ?? "" })
  } else if (gen === "steam-block") {
    for (let b = 1; b <= 10; b++) out.push({ boilers: b, fuel: ctx.fuel, boiler: ctx.boiler, engine: ctx.engine })
  }
  return out
}

function kindOf(gen: ModuleKind): NodeKind {
  if (gen === "mining-outpost") return "outpost"
  if (gen === "steam-block") return "power"
  if (gen === "lab-array") return "labs"
  return "module"
}

function outputRate(def: ModuleDef, item: string): number {
  let v = 0
  for (const r of def.rates.outputs) if (r.item === item) v += r.perSecond
  return v
}

function powerOf(rates: Rate[]): number {
  let w = 0
  for (const r of rates) if (r.kind === "power" || r.item === "electricity") w += r.perSecond
  return w
}

interface Sized {
  params: Record<string, unknown>
  def: ModuleDef
  capacity: number
  /** Even the biggest size is short of the need. */
  short: boolean
}

/** The smallest size of `gen` whose output of `item` covers `need`. */
function sizeModule(ctx: DesignContext, gen: ModuleKind, item: string, need: number): Sized | undefined {
  if (gen === "curated") {
    const id = ctx.curated?.[item]
    if (id === undefined) return undefined
    const [ok, def] = pcall(ctx.make, "curated", { id })
    if (!ok) return undefined
    const d = def as ModuleDef
    const capacity = outputRate(d, item)
    // Not expandable: one size (a bigger need splits the target into production clusters, D24).
    return { params: { id }, def: d, capacity, short: capacity + EPS < need }
  }
  let last: Sized | undefined
  for (const params of sizes(ctx, gen, item)) {
    const [ok, def] = pcall(ctx.make, gen, params)
    if (!ok) break
    const d = def as ModuleDef
    const capacity = outputRate(d, item)
    last = { params, def: d, capacity, short: capacity + EPS < need }
    if (!last.short) return last
    // At its expansion cap: bigger sizes do not exist for this layout (belt lane limits).
    if (d.expand !== undefined && d.expand.maxUnits <= 0) break
  }
  return last
}

/** Input ports of a module with their planned rates at `utilization` of full speed. */
function inputPorts(def: ModuleDef, utilization: number): DesignPort[] {
  const out: DesignPort[] = []
  const count: Record<string, number> = {}
  for (const p of def.ports) if (p.kind === "belt-in" && p.item !== undefined) count[p.item] = (count[p.item] ?? 0) + 1
  for (const p of def.ports) {
    if (p.kind !== "belt-in" || p.item === undefined) continue
    let rate = 0
    for (const r of def.rates.inputs) if (r.item === p.item) rate += r.perSecond
    out.push({ port: p.id, item: p.item, rate: (rate * utilization) / count[p.item] })
  }
  return out
}

function outPort(def: ModuleDef, item: string): string {
  for (const p of def.ports) if (p.kind === "belt-out" && p.item === item) return p.id
  return "out"
}

// ---------------------------------------------------------------------------------------------------------
// The walk

interface Demand {
  item: string
  rate: number
  to: string
  toPort: string
}

interface Walk {
  ctx: DesignContext
  cluster: number
  suffix: string
  nodes: DesignNode[]
  edges: DesignEdge[]
  demands: Demand[]
  errors: string[]
  /** A module could not be sized big enough. */
  short: boolean
}

/**
 * Splits a provider's consumers into the part its existing capacity keeps and the residual that needs a parallel
 * provider. A consumer that straddles the capacity is split into two demands on the same port; the residual edge is
 * marked `merge`, so the router side-loads it into the existing route instead of competing for the input port.
 */
function splitDemand(consumers: Demand[], capacity: number): { keep: Demand[]; rest: Demand[] } {
  const keep: Demand[] = []
  const rest: Demand[] = []
  let room = math.max(0, capacity)
  for (const c of consumers) {
    if (room <= EPS) {
      rest.push(c)
      continue
    }
    if (c.rate <= room + EPS) {
      keep.push(c)
      room -= c.rate
      continue
    }
    keep.push({ ...c, rate: room })
    rest.push({ ...c, rate: c.rate - room })
    room = 0
  }
  return { keep, rest }
}

/** The next free provider role for a parallel provider (`coal>power`, `coal>power#2`, ...). */
function parallelRole(w: Walk, role: string): string {
  // TSTL wraps `string.match`'s returns in a 0-based TS array; [0] is the first capture (empty when no match).
  const m = string.match(role ?? "", "^(.*)#%d+$")
  const base = m[0] !== undefined ? m[0] : (role ?? "provider")
  let n = 2
  for (;;) {
    const candidate = `${base}#${n}`
    let used = false
    for (const node of w.nodes) if (node.role === candidate) used = true
    if (!used) return candidate
    n++
  }
}

/**
 * Add one provider node. `fixedCapacity` is set when the node is the existing, unexpandable half of a provider group:
 * its design capacity is the real capacity, so the diff does not ask this provider to grow again.
 */
function addProducer(w: Walk, item: string, rate: number, consumers: Demand[], shared = false, sharedRole?: string, fixedCapacity?: number, mergePorts?: Record<string, boolean>): void {
  const ctx = w.ctx
  const gen = producerFor(ctx, item)
  if (gen === undefined) {
    w.errors.push(`no module makes ${item}`)
    return
  }
  // D54: a steam block only asks for coal once electric drills are enabled, so no producer here needs burner drills.
  let role = sharedRole ?? (ctx.policy.topology === "splitter-tap" || shared ? `${item}${w.suffix}` : `${item}>${consumers[0].to}`)
  if (role === undefined || role === "") role = `${item}${w.suffix}`
  const capacity = fixedCapacity ?? ctx.providerCaps?.[role]
  // B60: a built provider that cannot grow keeps its existing consumers at its real capacity. The residual gets a
  // distinct parallel role, rather than one oversized node that can never be satisfied.
  if (fixedCapacity === undefined && capacity !== undefined && capacity > EPS && ctx.providerShort?.[role] === true && rate > capacity + EPS) {
    const split = splitDemand(consumers, capacity)
    const mergePorts: Record<string, boolean> = {}
    for (const c of split.keep) mergePorts[`${c.to}.${c.toPort}`] = true
    addProducer(w, item, capacity, split.keep, shared, role, capacity)
    if (split.rest.length > 0) addProducer(w, item, rate - capacity, split.rest, shared, parallelRole(w, role), undefined, mergePorts)
    return
  }
  const s = sizeModule(ctx, gen, item, rate)
  if (s === undefined) {
    w.errors.push(`${gen} for ${item}: no valid size`)
    return
  }
  if (s.short) w.short = true
  const util = (fixedCapacity ?? s.capacity) > EPS ? math.min(1, rate / (fixedCapacity ?? s.capacity)) : 1
  const node: DesignNode = {
    role,
    kind: kindOf(gen),
    generator: gen,
    params: s.params,
    def: s.def,
    item,
    need: rate,
    capacity: fixedCapacity ?? s.capacity,
    inputs: inputPorts(s.def, util),
    powerW: powerOf(s.def.rates.inputs),
    cluster: w.cluster,
  }
  w.nodes.push(node)
  const from = outPort(s.def, item)
  for (const c of consumers) w.edges.push(edge(w, node.role, from, c, mergePorts?.[`${c.to}.${c.toPort}`] === true))
  for (const p of node.inputs) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: role, toPort: p.port })
}

function edge(w: Walk, from: string, fromPort: string, c: Demand, merge = false): DesignEdge {
  return {
    role: `${from}=>${c.to}.${c.toPort}`,
    item: c.item,
    from,
    fromPort,
    to: c.to,
    toPort: c.toPort,
    rate: c.rate,
    headroomRate: c.rate * w.ctx.policy.headroom,
    belt: w.ctx.tiers[0]?.belt ?? "transport-belt",
    decision: { action: "none" },
    merge: merge || undefined,
  }
}

/**
 * B19: consumers already fed keep their producer (grouped by it, under its role); new consumers tap a producer of the
 * item with spare capacity, else share one new producer (`item*>first consumer`); a lone new consumer gets its own.
 * The steam block never waits for production: its fuel demand is never a new shared consumer.
 */
function expandShared(w: Walk, item: string, mine: Demand[], shared: NonNullable<DesignContext["sharing"]>): void {
  const byProducer: Record<string, Demand[]> = {}
  const producers: string[] = []
  const fresh: Demand[] = []
  const alone: Demand[] = []
  for (const d of mine) {
    const p = shared.keep[`${item}@${d.to}`]
    if (p !== undefined) {
      if (byProducer[p] === undefined) {
        byProducer[p] = []
        producers.push(p)
      }
      byProducer[p].push(d)
    } else fresh.push(d)
  }
  producers.sort()
  const spare = shared.spare[item] ?? {}
  for (const p of producers) {
    let room = spare[p] ?? 0
    if (room <= EPS) continue
    const rest: Demand[] = []
    for (const d of fresh) {
      if (d.rate <= room + EPS) {
        room -= d.rate
        byProducer[p].push(d)
      } else rest.push(d)
    }
    fresh.length = 0
    for (const d of rest) fresh.push(d)
  }
  // P36 (b): no room for a new producer of this item: the nearest built one takes the new consumers (and grows),
  // a steam block too (a built producer never makes it wait).
  const fb = shared.fallback?.[item]?.[0]
  if (fb !== undefined && fresh.length > 0) {
    if (byProducer[fb] === undefined) {
      byProducer[fb] = []
      producers.push(fb)
    }
    for (const d of fresh) byProducer[fb].push(d)
    fresh.length = 0
  }
  // A new steam block (power#2) may tap a built producer, but never waits in a new shared group.
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (!isPowerRole(fresh[i].to)) continue
    alone.push(fresh[i])
    fresh.splice(i, 1)
  }
  for (const p of producers) {
    let total = 0
    for (const d of byProducer[p]) total += d.rate
    addProducer(w, item, total, byProducer[p], true, p)
  }
  if (fresh.length >= 2) {
    let total = 0
    for (const d of fresh) total += d.rate
    addProducer(w, item, total, fresh, true, `${item}*>${fresh[0].to}`)
  } else for (const d of fresh) alone.push(d)
  for (const d of alone) addProducer(w, item, d.rate, [d])
}

/** Expands every pending demand for `item` (point-to-point: one producer each; splitter-tap: one for all). */
function expandItem(w: Walk, item: string): void {
  const mine: Demand[] = []
  const rest: Demand[] = []
  for (const d of w.demands) (d.item === item ? mine : rest).push(d)
  if (mine.length === 0) return
  w.demands = rest
  if (w.ctx.policy.topology === "splitter-tap") {
    let total = 0
    for (const d of mine) total += d.rate
    addProducer(w, item, total, mine)
    return
  }
  const shared = w.ctx.sharing
  if (shared !== undefined) {
    expandShared(w, item, mine, shared)
    return
  }
  // B2: the consumers recorded for splitter taps share one producer (the power node's fuel stays its own, so the
  // power goal never waits for production).
  const tapped = w.ctx.taps?.[item]
  const group: Demand[] = []
  const single: Demand[] = []
  for (const d of mine) (tapped !== undefined && tapped.indexOf(d.to) >= 0 && !isPowerRole(d.to) ? group : single).push(d)
  if (group.length >= 2) {
    let total = 0
    for (const d of group) total += d.rate
    addProducer(w, item, total, group, true)
  } else for (const d of group) single.push(d)
  for (const d of single) addProducer(w, item, d.rate, [d])
}

/** Every pack of a target with its rate (packs/s). */
export function targetItems(target: DesignTarget): { item: string; perSecond: number }[] {
  return [{ item: target.item, perSecond: target.perSecond }, ...(target.also ?? [])]
}

/**
 * Role suffix of production cluster `c` of `clusters`. Cluster 1 keeps the plain roles, so a stage that splits its
 * target into clusters (M6: two green lines) reuses and grows the modules the previous stage built as its first cluster.
 */
export function clusterSuffix(c: number, clusters: number): string {
  return clusters > 1 && c > 1 ? `#${c}` : ""
}

/** The share of the stage target cluster `c` of `n` makes: equal, unless cluster 1 is capped (`cluster1Max`). */
export function clusterFraction(ctx: DesignContext, c: number, n: number): number {
  const cap = ctx.cluster1Max
  if (cap === undefined || cap >= 1 / n || n < 2) return 1 / n
  return c === 1 ? cap : (1 - cap) / (n - 1)
}

function designCluster(ctx: DesignContext, target: DesignTarget, order: string[], cluster: number, clusters: number): Walk {
  const suffix = clusterSuffix(cluster, clusters)
  const w: Walk = { ctx, cluster, suffix, nodes: [], edges: [], demands: [], errors: [], short: false }
  const items = targetItems(target)
  const frac = clusterFraction(ctx, cluster, clusters)
  // Labs consume one of each pack per research unit: sized for the fastest pack rate at the configured unit time.
  let rate = 0
  for (const t of items) rate = math.max(rate, t.perSecond * frac)
  const speed = ctx.facts.entity(ctx.lab)?.researchSpeed ?? 1
  const labs = math.max(2, 2 * math.ceil((rate * ctx.researchUnitTime) / speed / 2 - EPS))
  let packs = [...ctx.packs]
  for (const t of items) if (packs.indexOf(t.item) < 0) packs = [t.item]
  const labParams = { labs, packs, lab: ctx.lab, unitTime: ctx.researchUnitTime }
  const labDef = ctx.make("lab-array", labParams)
  const labRole = `labs${suffix}`
  const labNode: DesignNode = { role: labRole, kind: "labs", generator: "lab-array", params: labParams, def: labDef, item: "research-unit", need: rate, capacity: rate, inputs: [], powerW: powerOf(labDef.rates.inputs), cluster }
  w.nodes.push(labNode)
  for (const t of items) {
    let port: string | undefined
    for (const p of labDef.ports) if (p.kind === "belt-in" && p.item === t.item) port = p.id
    const r = t.perSecond * frac
    labNode.inputs.push({ port: port ?? `in-${t.item}`, item: t.item, rate: r })
    w.demands.push({ item: t.item, rate: r, to: labRole, toPort: port ?? `in-${t.item}` })
  }
  if (target.mall !== undefined && cluster === 1) {
    const def = ctx.make("curated", { id: target.mall.id })
    const inputs = inputPorts(def, target.mall.utilization)
    w.nodes.push({ role: "mall", kind: "sink", generator: "curated", params: { id: target.mall.id }, def, item: "mall", need: target.mall.utilization, capacity: 1, inputs, powerW: powerOf(def.rates.inputs), cluster })
    for (const p of inputs) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: "mall", toPort: p.port })
  }
  for (const item of order) if (item !== ctx.fuel) expandItem(w, item)
  for (const d of w.demands) if (d.item !== ctx.fuel) w.errors.push(`unplanned demand for ${d.item}`)
  return w
}

/** Whether a role is the power node or a fuel supply of it ("power", "power#2", "coal>power", ...). */
export function isPowerRole(role: string): boolean {
  return string.match(role, "^power#?%d*$")[0] !== undefined || string.match(role, ">power#?%d*$")[0] !== undefined
}

/**
 * Power and fuel for everything designed so far: the steam block sized to the electric demand, then every fuel
 * demand (furnaces and boilers). Electric fuel drills add demand, so this iterates to a fixed point. D54 (user,
 * 2026-10-19): until electric drills are enabled now, the steam block has no fuel supply (no burner mine, no belt): the
 * crew hand-feeds its boilers (factory.ts upkeep). Once they are, its coal comes from an electric mine that can grow.
 */
function designPower(ctx: DesignContext, w: Walk, extraW = 0, report?: { short: boolean }): number {
  const core = [...w.nodes]
  const coreEdges = [...w.edges]
  const fuelDemands = [...w.demands]
  let estimate = extraW
  for (const n of core) estimate += n.powerW
  for (let iter = 0; iter < 5; iter++) {
    w.nodes = [...core]
    w.edges = [...coreEdges]
    w.demands = [...fuelDemands]
    if (estimate <= EPS) {
      expandItem(w, ctx.fuel)
      return 0
    }
    const s = sizeModule(ctx, "steam-block", "electricity", estimate)
    if (s === undefined) {
      w.errors.push("steam-block: no valid size")
      return estimate
    }
    if (s.short && report !== undefined) report.short = true
    else if (s.short) w.short = true
    const util = s.capacity > EPS ? math.min(1, estimate / s.capacity) : 1
    const steam: DesignNode = {
      role: `power${w.suffix}`,
      kind: "power",
      generator: "steam-block",
      params: s.params,
      def: s.def,
      item: "electricity",
      need: estimate,
      capacity: s.capacity,
      inputs: inputPorts(s.def, util),
      powerW: s.capacity,
      cluster: w.cluster,
    }
    w.nodes.push(steam)
    if (electricDrillsNow(ctx)) for (const p of steam.inputs) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: steam.role, toPort: p.port })
    expandItem(w, ctx.fuel)
    let total = extraW
    for (const n of w.nodes) if (n.kind !== "power") total += n.powerW
    steam.need = total
    if (total <= s.capacity + EPS || math.abs(total - estimate) < EPS) return total
    estimate = total
  }
  return estimate
}

/** M6: a second steam block (role `power#2`) for what the first can't supply, with its own fuel supply. */
function secondSteam(ctx: DesignContext, w: Walk, extraW: number): void {
  const s = sizeModule(ctx, "steam-block", "electricity", extraW)
  if (s === undefined) {
    w.errors.push("second steam-block: no valid size")
    return
  }
  const util = s.capacity > EPS ? math.min(1, extraW / s.capacity) : 1
  const role = "power#2"
  w.nodes.push({ role, kind: "power", generator: "steam-block", params: s.params, def: s.def, item: "electricity", need: extraW, capacity: s.capacity, inputs: inputPorts(s.def, util), powerW: s.capacity, cluster: w.cluster })
  if (electricDrillsNow(ctx)) for (const p of inputPorts(s.def, util)) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: role, toPort: p.port })
  expandItem(w, ctx.fuel)
}

function checkEdges(ctx: DesignContext, w: Walk, overflow: Record<string, string>, sharedPower = false): number {
  const available = availableTiers(ctx.tiers, ctx.researched)
  let split = 1
  for (const e of w.edges) {
    if (sharedPower && isPowerRole(e.to)) {
      // Still a faster tier when researched; never a cluster split.
      const tier = ctx.tiers[0]
      if (tier === undefined) continue
      const d = decideOverflow({ demand: e.rate, edge: { tier, lanes: 2, utilization: ctx.policy.utilization }, available, order: ctx.policy.overflow.order, maxParallel: ctx.policy.overflow.maxParallel })
      e.decision = d.action === "upgrade-tier" ? d : { action: "none" }
      if (d.action === "upgrade-tier") {
        e.belt = d.belt
        overflow[e.role] = `upgrade-tier → ${d.belt}`
      } else if (d.action !== "none") overflow[e.role] = `shared power fuel over capacity (${d.action} not applied)`
      continue
    }
    const tier = ctx.tiers[0]
    if (tier === undefined) break
    const limits = { tier, lanes: 2, utilization: ctx.policy.utilization }
    const d = decideOverflow({ demand: e.rate, edge: limits, available, order: ctx.policy.overflow.order, maxParallel: ctx.policy.overflow.maxParallel })
    e.decision = d
    if (d.action === "upgrade-tier") {
      e.belt = d.belt
      overflow[e.role] = `upgrade-tier → ${d.belt}`
    } else if (d.action === "parallel-route") {
      split = math.max(split, d.routes)
      overflow[e.role] = `parallel-route × ${d.routes} (as production clusters)`
    } else if (d.action === "new-producer-cluster") {
      const usable = tier.laneCapacity * 2 * ctx.policy.utilization
      split = math.max(split, math.ceil(e.rate / usable - EPS))
      overflow[e.role] = `new-producer-cluster: ${d.reason}`
    }
  }
  return split
}

/**
 * A built producer shared by consumers in several clusters (B19 keep, P36 (b) fallback) is designed once per cluster
 * walk: merge those copies into the first (needs, input rates and electric demand add up), so the diff sees the whole
 * demand on the one graph node and grows it.
 */
export function mergeShared(nodes: DesignNode[]): void {
  const first: Record<string, DesignNode> = {}
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const f = first[n.role]
    if (f === undefined) {
      first[n.role] = n
      continue
    }
    f.need += n.need
    f.powerW += n.powerW
    for (const p of n.inputs) {
      let hit = false
      for (const q of f.inputs) if (q.port === p.port) {
        q.rate += p.rate
        hit = true
      }
      if (!hit) f.inputs.push({ ...p })
    }
    nodes.splice(i, 1)
    i--
  }
}

/** Solves and designs the factory for a stage target. */
export function design(ctx: DesignContext, target: DesignTarget): Design {
  const solveJob = solveNow(
    {
      targets: targetItems(target),
      machines: [ctx.assembler, ctx.furnace],
      drills: [electricDrills(ctx) ? ctx.electricDrill : ctx.burnerDrill],
      resources: ctx.resources,
      fuel: ctx.fuel,
      boiler: ctx.boiler,
      engine: ctx.engine,
      enabled: ctx.enabled,
    },
    ctx.facts,
  )
  const order = solveJob.order
  const overflow: Record<string, string> = {}
  let clusters = ctx.cluster1Max !== undefined && ctx.cluster1Max < 1 ? 2 : 1
  let walks: Walk[] = []
  let electric = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    walks = []
    electric = 0
    let split = clusters
    let short = false
    for (let c = 1; c <= clusters; c++) walks.push(designCluster(ctx, target, order, c, clusters))
    // One steam block (in cluster 1) for every cluster: the other clusters mine their own fuel (their electric coal
    // drills add demand), then cluster 1's power is sized for the whole factory.
    // If even the largest steam block can't, every cluster gets its own (power#c).
    const snap = walks.map((w) => ({ nodes: [...w.nodes], edges: [...w.edges], demands: [...w.demands] }))
    let others = 0
    for (let c = 2; c <= clusters; c++) {
      const w = walks[c - 1]
      expandItem(w, ctx.fuel)
      for (const n of w.nodes) others += n.powerW
    }
    const probe = { short: false }
    electric = designPower(ctx, walks[0], others, clusters > 1 ? probe : undefined)
    if (ctx.powerCap !== undefined && electric > ctx.powerCap + EPS) secondSteam(ctx, walks[0], electric - ctx.powerCap)
    let shared = clusters > 1
    if (probe.short) {
      shared = false
      electric = 0
      walks.forEach((w, i) => {
        w.nodes = snap[i].nodes
        w.edges = snap[i].edges
        w.demands = snap[i].demands
      })
      for (const w of walks) electric += designPower(ctx, w)
    }
    for (const w of walks) {
      // A shared steam block's flows don't shrink with more clusters: they never split the target.
      split = math.max(split, clusters * checkEdges(ctx, w, overflow, shared))
      if (w.short) short = true
    }
    if (short && split === clusters) split = clusters + 1
    if (split <= clusters) break
    clusters = split
  }
  const nodes: DesignNode[] = []
  const edges: DesignEdge[] = []
  const errors: string[] = []
  for (const w of walks) {
    for (const n of w.nodes) nodes.push(n)
    for (const e of w.edges) edges.push(e)
    for (const x of w.errors) errors.push(x)
  }
  mergeShared(nodes)
  const techs: string[] = []
  for (const n of nodes) for (const t of n.def.requiresTech) if (!ctx.researched[t] && techs.indexOf(t) < 0) techs.push(t)
  techs.sort()
  return { target, nodes, edges, electricW: electric, clusters, techs, overflow, errors, solve: solveJob.result }
}

// ---------------------------------------------------------------------------------------------------------
// Goal diff

export interface Growth {
  role: string
  /** The existing graph node (module instance) to grow. */
  node: string
  units: number
  need: number
  have: number
  /** D55: a worked-out whole-patch mine moves to the next free part of its patch instead of growing. */
  reclaim?: boolean
}

export interface DesignDiff {
  /** Design nodes with no node of their role in the graph. */
  missing: DesignNode[]
  /** Existing nodes short of their design need: grow them (expand-first) by this many units. */
  grow: Growth[]
  /** Design edges with no edge of their role in the graph. */
  missingEdges: DesignEdge[]
}

/** Units of `def.expand` needed to add `extra` of `item` at full speed. */
export function unitsFor(def: ModuleDef, item: string, extra: number): number | undefined {
  const e = def.expand
  if (e === undefined) return undefined
  let per = 0
  for (const r of e.perUnit.rates.outputs) if (r.item === item) per += r.perSecond
  if (per <= EPS) return undefined
  const k = math.ceil(extra / per - EPS)
  return k <= e.maxUnits ? k : undefined
}

/**
 * B20: leftover-ghost rounds that placed nothing in a row: a round whose leftover count did not drop counts one more,
 * any progress resets it. `limit` reached (> 0) means escalate.
 */
export function stuckRounds(prev: number | undefined, lastLeft: number | undefined, left: number, limit: number): { stuck: number; escalate: boolean } {
  const stuck = lastLeft !== undefined && left >= lastLeft ? (prev ?? 0) + 1 : 0
  return limit > 0 && stuck >= limit ? { stuck: 0, escalate: true } : { stuck, escalate: false }
}

/** Labs in a module (undefined without a module). */
function labCount(def: ModuleDef | undefined, lab: string): number | undefined {
  if (def === undefined) return undefined
  let n = 0
  for (const e of def.entities) if (e.name === lab) n++
  return n
}

export function diffDesign(d: Design, g: LogicalGraph, canonical: (this: void, node: string) => ModuleDef | undefined): DesignDiff {
  const missing: DesignNode[] = []
  const grow: Growth[] = []
  for (const n of d.nodes) {
    const have = nodeByRole(g, n.role)
    if (have === undefined) {
      missing.push(n)
      continue
    }
    // A sink (the mall) has no output rate to grow: its "need" is the utilization it was planned at (M6a.2: every
    // failing seed listed "mall short (0/0.25): cannot grow").
    if (n.kind === "sink") continue
    const def = canonical(have.id)
    if (n.kind === "labs") {
      // Labs by count (their declared rate depends on the unit time they were sized for): grow by pairs (expand units).
      const want = (n.params.labs as number | undefined) ?? 0
      const lab = (n.params.lab as string | undefined) ?? "lab"
      const got = labCount(def, lab)
      if (got === undefined || got >= want) continue
      const per = def?.expand !== undefined ? labCount({ ...def, entities: def.expand.unit.entities } as ModuleDef, lab) ?? 0 : 0
      const k = per > 0 ? math.ceil((want - got) / per - EPS) : -1
      grow.push({ role: n.role, node: have.id, units: def?.expand !== undefined && k >= 1 && k <= def.expand.maxUnits ? k : -1, need: want, have: got })
      continue
    }
    const cap = rateIn(have.capacity.outputs, n.item)
    if (cap + 1e-6 >= n.need) continue
    const units = def !== undefined ? unitsFor(def, n.item, n.need - cap) : undefined
    // `units = -1` means this provider has no expansion unit. The caller records it as a fixed-capacity group member
    // and the design plans a parallel provider for the residual (B60); this provider is never deconstructed for it.
    grow.push({ role: n.role, node: have.id, units: units ?? -1, need: n.need, have: cap })
  }
  const missingEdges: DesignEdge[] = []
  for (const e of d.edges) if (edgeByRole(g, e.role) === undefined) missingEdges.push(e)
  return { missing, grow, missingEdges }
}

/**
 * Goal kinds; "repair" comes from the reconciler (M5b): missing pieces of a route or pole line re-placed; "temp" builds
 * D38 temporary factories (chest cells), outside the design.
 */
export type GoalKind = "power" | "labs" | "production" | "mall" | "grow" | "repair" | "temp" | "radar"

export interface GoalSpec {
  kind: GoalKind
  /** Production goals: one per production cluster (M6: a stage split into clusters plans and builds them in turn). */
  cluster?: number
  nodes: DesignNode[]
  edges: DesignEdge[]
  growth?: Growth
  /** Unresearched technologies the goal's modules need. */
  techs: string[]
}

/**
 * Build goals from a diff, in build order: power (the steam block and its fuel supply), labs, then the production
 * chain, then growth of existing modules. An edge belongs to the goal that builds its later end.
 */
export function goalsFrom(diff: DesignDiff, researched: Record<string, boolean>): GoalSpec[] {
  const goals: GoalSpec[] = []
  const byKind: Record<string, GoalSpec> = {}
  const goalOf: Record<string, GoalSpec> = {}
  const keys: string[] = []
  const get = (kind: GoalKind, cluster = 1): GoalSpec => {
    const key = kind === "production" || kind === "labs" ? `${kind}#${cluster}` : kind
    let gs = byKind[key]
    if (gs === undefined) {
      gs = { kind, nodes: [], edges: [], techs: [] }
      if (kind === "production" || kind === "labs") gs.cluster = cluster
      byKind[key] = gs
      keys.push(key)
    }
    return gs
  }
  for (const n of diff.missing) {
    const kind: GoalKind = n.kind === "labs" ? "labs" : isPowerRole(n.role) ? "power" : n.role === "mall" || string.match(n.role, ">mall$")[0] !== undefined ? "mall" : "production"
    const gs = get(kind, n.cluster)
    gs.nodes.push(n)
    goalOf[n.role] = gs
    for (const t of n.def.requiresTech) if (!researched[t] && gs.techs.indexOf(t) < 0) gs.techs.push(t)
  }
  const rank: Record<GoalKind, number> = { power: 1, labs: 2, production: 3, mall: 4, grow: 5, repair: 6, temp: 7, radar: 8 }
  for (const e of diff.missingEdges) {
    const a = goalOf[e.from]
    const b = goalOf[e.to]
    let gs = a ?? b ?? get("production")
    if (a !== undefined && b !== undefined && rank[b.kind] > rank[a.kind]) gs = b
    gs.edges.push(e)
  }
  // Build order: power, then each cluster's labs and production in turn (cluster 1 first), the mall after cluster 1.
  let clusters = 1
  for (const k of keys) {
    const [c] = string.match(k, "#(%d+)$")
    if (c !== undefined) clusters = math.max(clusters, tonumber(c)!)
  }
  const order = ["power"]
  for (let c = 1; c <= clusters; c++) {
    order.push(`labs#${c}`, `production#${c}`)
    if (c === 1) order.push("mall")
  }
  for (const k of order) if (byKind[k] !== undefined) goals.push(byKind[k])
  for (const gr of diff.grow) goals.push({ kind: "grow", nodes: [], edges: [], growth: gr, techs: [] })
  for (const gs of goals) gs.techs.sort()
  return goals
}
