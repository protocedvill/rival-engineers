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

import { ProtoFacts, RecipeFacts } from "../modules/facts"
import { encodeWells } from "../modules/generators"
import { GeneratorName, SOLAR_MAX_UNITS, smelterMaxFurnaces } from "../modules/generators"
import { ModuleDef, Rate } from "../modules/types"
import { availableTiers, BeltTier, decideOverflow, OverflowDecision } from "../planner/capacity"
import { edgeByRole, LogicalGraph, nodeByRole, NodeKind, rateIn } from "../planner/logical"
import { requiredRates, SupplyEdge, SupplyNode } from "./growth-plan"
import { LayoutPolicy } from "../planner/policy"
import { familyOfRole as roleFamily, nodeServes, rolePower, stampNodeFacts } from "./node-facts"
import type { Serves } from "./node-facts"
import { solveNow, SolveResult } from "./solver"
import { addEntities, buildSeconds, BuildEstimate } from "./power-choice"

/** A module kind: a generator, or "curated" (params.id names the curated module). */
export type ModuleKind = GeneratorName | "curated"

export type MakeModule = (this: void, generator: ModuleKind, params: Record<string, unknown>) => ModuleDef

export interface DesignContext {
  /** B205 (user, 2026-11-12): the pole new modules use once it is researched (medium); unset: each generator's default. */
  pole?: string
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
  /**
   * D76: roles being retired. Their consumers get a replacement under a distinct parallel role whose edge merges into
   * the belt the retiring provider still feeds, so both feed the consumer until the old one goes (its belt goes with it
   * and the replacement's edge is routed again).
   */
  retiring?: Record<string, boolean>
  /** Actual output capacity of built provider roles by role (used only for a short provider). */
  providerCaps?: Record<string, number>
  /**
   * B97: the consumer ports (`role.port`) each built provider role feeds now (its belt edges). A built provider the design
   * has left out keeps them first ("Built first", user decision 2026-10-29).
   */
  providerFeeds?: Record<string, Record<string, boolean>>
  /**
   * M7 (C): items/s below which a top-up into a belt that still feeds its consumer (a merge edge: a short provider's
   * residual, a retiring provider's replacement) gets no provider. 0 = always plan one.
   */
  minTopUp?: number
  /** B71: consumer ports (`role.port`) that cannot take a merged residual: a short provider keeps them whole. */
  noMerge?: Record<string, boolean>
  /** B72: provider roles whose plan folded them into a shared mine whose route then failed: they need a site of their own. */
  ownSite?: Record<string, boolean>
  enabled: Record<string, boolean>
  /** Technologies the faction can research now or later (the research goal): designs may use what they unlock. */
  plannable?: Record<string, boolean>
  /** Resource entities the faction knows about. */
  resources: string[]
  /** D42 / D51: the chest for module buffer depots (smelter columns, assembler rows, circuit blocks), "" or absent = none. */
  buffer?: string
  /**
   * M7d.5 (user request in-session 2026-11-04): the construction-robot stock row puts its robots straight into a
   * roboport at its head, which is the network's hub (`storage` storage chests beside it); its buffer chest is the
   * crew's supply. Absent: robots are collected from the buffer chest only.
   */
  robotHub?: { robot: string; roboport: string; storageChest: string; storage: number }
  /** D51 / M7c.8: the products whose assembler rows get that buffer (absent: gear rows only). */
  bufferRows?: string[]
  /** Burner fuel (coal) and entity choices (config defaults, from prototypes). */
  fuel: string
  assembler: string
  furnace: string
  electricDrill: string
  burnerDrill: string
  lab: string
  boiler: string
  engine: string
  /**
   * M7c: assemblers to choose from, best first: a row uses the first whose crafting categories include its recipe's
   * (engines need assembler 2). Absent: `assembler` only.
   */
  assemblers?: string[]
  /** M7c: most ingredients an assembler row takes (2: v1; 3: engines, advanced circuits, blue packs; 4: robot frames). Default 2. */
  rowInputs?: number
  /** M7c: fluid chains (refinery recipe making the intermediate, the machines) and the offshore-pumped fluid. */
  fluidSource?: string
  refinery?: string
  chemPlant?: string
  pumpjack?: string
  /** The fluid an offshore pump gives (water). */
  pumpedFluid?: string
  /**
   * M7d.4 (D81): once this recipe (advanced oil processing) is enabled, petroleum gas and lubricant come from one oil
   * complex per cluster (role `oil-complex`), chemistry recipes from pipe-fed chemistry rows and fluid assembler recipes
   * (electric engines) from assembler rows with a manifold. Default "advanced-oil-processing".
   */
  advancedOil?: string
  /** M7d.4: the fluids the oil complex makes (default petroleum gas and lubricant). */
  oilComplexOutputs?: string[]
  /** M7d.5: built oil-complex roles that have a lubricant plant, so they can serve lubricant demand. */
  oilLube?: Record<string, boolean>
  /**
   * M7d.4: generators of the roles already in the factory graph. A built (or building) fluid chain keeps its role as
   * a fluid chain after the switch to the oil complex: only new providers and parallel ones use the new modules.
   */
  builtGenerators?: Record<string, string>
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
   * of the item could not be placed (the first one takes them all and grows). `blocked` is an exact
   * `provider=>consumer.port` deny-list: the historical assignment stays visible, but the design must not preserve it.
   * `draw` (M7c, user-approved 2026-11-01): `item@consumer role@port` → the rate a built consumer was measured taking;
   * a demand counts at least that (consumers with room take what they can, not what was planned).
   */
  sharing?: { keep: Record<string, string>; spare: Record<string, Record<string, number>>; fallback?: Record<string, string[]>; split?: Record<string, boolean>; blocked?: Record<string, boolean>; draw?: Record<string, number> }
  /**
   * M6/B66: built steam blocks that can't grow any more (their expansion keeps failing, e.g. the shore is taken), in
   * role order from `power` (`power`, `power#2`, ...), with what each can supply. Each keeps that capacity and the
   * excess goes to the next steam block, a new one after the last. Absent: the steam block grows.
   */
  powerCaps?: { role: string; capacity: number }[]
  /**
   * M6: the largest share of the stage target production cluster 1 may take (0..1): some of its modules (the previous
   * stage's) can't grow far enough, so the other clusters make the rest. Absent: equal shares.
   */
  cluster1Max?: number
  /**
   * B184 (user, 2026-11-11): steam-block roles that found no shore: planned as inland blocks (`water: "pipe"`) fed by a
   * water-pump module, which needs only a small shore anywhere in reach of a pipe.
   */
  inlandPower?: Record<string, boolean>
  /**
   * B185 (user, 2026-11-11; trigger proposed): the steam blocks' fuel can't be found. Built steam blocks keep their
   * capacity (`powerCaps` lists them all) and the rest of the power comes from solar fields.
   */
  solarPower?: boolean
  /** B194: `powerCaps` as in steam mode, for a forced-solar design whose solar fields can't be built yet. */
  steamCaps?: { role: string; capacity: number }[]
  /**
   * B185 (user, 2026-11-11): tiles from the base to the nearest known coal patch no mine uses (`math.huge`: none). A new
   * power role is a solar field when that builds faster than a steam block with a mine there and a belt back
   * (`solarFaster`). Absent: never compared (steam unless `solarPower`).
   */
  coalDistance?: number
  /** B57/B61: consumer ports proved sealed while their module waits to relocate; plan no provider for them. */
  noFeed?: Record<string, boolean>
  /**
   * M7d.5 (user, 2026-11-07): from the first blue-science stage on, every new furnace stack is planned at
   * `smelterMaxFurnaces` instead of the smallest column that covers its demand. Growth and sharing policy are unchanged.
   */
  maxSmelters?: boolean
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
  /**
   * M7d.5 (D77, P49): items the faction stocks rather than consumes (construction robots, roboports): each is a sink, a
   * two-machine assembler row whose buffer head collects the product for the crew, planned at `perSecond`.
   */
  stock?: { item: string; perSecond: number }[]
}

/** M7d.5 (P49, approved "about 50"): construction robots stocked, and the time the stock line is sized to make them in. */
export const ROBOT_STOCK = 50
/** M7d.5 (agent, proposed): roboports stocked for the first network (3 x 3 at logistic spacing covers ~210 tiles square). */
export const ROBOPORT_STOCK = 10
/** M7d.5 (agent, proposed): game seconds the stock lines are sized to fill their stock in. */
export const STOCK_FILL_SECONDS = 1800

/**
 * M7d.5 (D77, P48): once the technology unlocking construction robots is researched, the faction stocks robots and
 * roboports (each only while its recipe is enabled). `researched` and `enabled` read the force.
 */
export function robotStock(researched: (this: void, tech: string) => boolean, enabled: (this: void, recipe: string) => boolean): { item: string; perSecond: number }[] {
  if (!researched("construction-robotics")) return []
  const out: { item: string; perSecond: number }[] = []
  if (enabled("construction-robot")) out.push({ item: "construction-robot", perSecond: ROBOT_STOCK / STOCK_FILL_SECONDS })
  if (enabled("roboport")) out.push({ item: "roboport", perSecond: ROBOPORT_STOCK / STOCK_FILL_SECONDS })
  return out
}

/** B205 (agent, proposed): of each building the generated stock makes (`buildStock`), how many the factory keeps. */
export const BUILD_STOCK = 10
/** B205 (agent, proposed): a building gets a stock row once the design's modules place at least this many. */
export const BUILD_STOCK_MIN = 10

/**
 * B205 (user, in-session 2026-11-12: "try and get the rest higher up so we can have bots actually building"; D79's
 * generated mall): once the mall is in the design, every building the design's modules place at least
 * `BUILD_STOCK_MIN` times that neither the mall nor another stock row makes gets a stock row of its own (labs, stone
 * furnaces, steam engines and boilers, medium poles...), while its recipe is enabled and machines can make its chain.
 * Its buffer head is a passive provider once researched, so robots build from it. `have`: items already stocked.
 * Only once the faction has robots coming (a built robot-cell or roboport module): before that nothing builds from the
 * stock, and its rows (each with feeder rows, at a few hundredths a second) joined the robot chain's cluster, which then
 * took ~40 game min to plan and failed (b205-222, min 300-420: still no robots).
 */
export function buildStock(ctx: DesignContext, d: Design, target: DesignTarget, have: Record<string, boolean>): { item: string; perSecond: number }[] {
  if (target.mall === undefined) return []
  let robots = false
  for (const [, gen] of pairs(ctx.builtGenerators ?? {})) if (gen === "robot-cell" || gen === "roboport") robots = true
  if (!robots) return []
  const made: Record<string, boolean> = { ...have }
  const [ok, mall] = pcall(ctx.make, "curated", { id: target.mall.id })
  if (ok) for (const p of (mall as ModuleDef).ports) if (p.kind === "chest-out" && p.item !== undefined) made[p.item] = true
  const count: Record<string, number> = {}
  const items: string[] = []
  for (const n of d.nodes) {
    for (const e of n.def.entities) {
      const item = ctx.facts.itemToPlace(e.name) ?? e.name
      if (count[item] === undefined) items.push(item)
      count[item] = (count[item] ?? 0) + 1
    }
  }
  items.sort()
  const out: { item: string; perSecond: number }[] = []
  for (const item of items) {
    if (made[item] || count[item] < BUILD_STOCK_MIN) continue
    const recipe = ctx.facts.recipeForItem(item)
    if (recipe === undefined || ctx.enabled[recipe] !== true) continue
    if (!chainProducible(ctx, item, 0, ctx.rowInputs ?? 2)) continue
    out.push({ item, perSecond: BUILD_STOCK / STOCK_FILL_SECONDS })
  }
  return out
}

/** B185 (agent, proposed): of each solar-field building, how many the factory keeps stocked. */
export const POWER_STOCK = 25

/**
 * B194 (`m7-b193` seed 3333, min ~170): whether machines can make a solar-field building down to raw resources. A stock
 * row for one they can't make failed the whole design ("no module makes wood": the field had small poles then; it has
 * medium poles since the user's 2026-11-12 decision).
 */
function machineMade(ctx: DesignContext, entity: string): boolean {
  return chainProducible(ctx, ctx.facts.itemToPlace(entity) ?? entity, 0, ctx.rowInputs ?? 2)
}

/**
 * B194: whether machines can make every solar-field building (the design researches what is missing). Forced solar
 * (`solarPower`) waited forever on an accumulator stock row the design could not plan (its batteries need advanced oil
 * processing); while this is false, new power stays steam and the coal search goes on.
 */
export function solarBuildable(ctx: DesignContext): boolean {
  const [ok, made] = pcall(ctx.make, "solar-field", { units: 1 })
  if (!ok) return false
  for (const e of (made as ModuleDef).entities) if (!machineMade(ctx, e.name)) return false
  return true
}

/**
 * B185 (user, 2026-11-11: "all stuff for the solar fields should also be crafted automatically"): once a design has a
 * solar field, every building of one (panels, accumulators, poles) is made by machines and stocked like robots: an assembler row
 * with a buffer head, its inputs from the design. Each only while its recipe is enabled.
 */
export function powerStock(ctx: DesignContext, enabled: (this: void, recipe: string) => boolean): { item: string; perSecond: number }[] {
  const [ok, made] = pcall(ctx.make, "solar-field", { units: 1 })
  if (!ok) return []
  const out: { item: string; perSecond: number }[] = []
  const seen: Record<string, boolean> = {}
  for (const e of (made as ModuleDef).entities) {
    const item = ctx.facts.itemToPlace(e.name) ?? e.name
    if (seen[item]) continue
    seen[item] = true
    const recipe = ctx.facts.recipeForItem(item)
    if (recipe === undefined || !enabled(recipe)) continue
    if (!machineMade(ctx, e.name)) continue
    out.push({ item, perSecond: POWER_STOCK / STOCK_FILL_SECONDS })
  }
  out.sort((a, b) => (a.item < b.item ? -1 : 1))
  return out
}

/** M7d.5: the graph role of a stock sink for `item`. */
export function stockRole(item: string): string {
  return `stock:${item}`
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
  /** A route-infeasible provider split must use an independent site, not complete the old provider's mine. */
  newSite?: boolean
  /** D69: facts minted with the role (`node-facts.ts`), set once the design is complete. */
  homeCluster?: number
  family?: string
  serves?: Serves
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
/** B185 (proposed): most solar fields one design adds (each up to `SOLAR_MAX_UNITS` units). */
const MAX_SOLAR_FIELDS = 8

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

/**
 * Whether every ingredient of `item`'s recipe has a generator (down to raw resources). M7c: judged with two-ingredient
 * rows, so a validated curated module (v1's green line) keeps its item even when three-ingredient rows are on; those
 * serve only items no curated module covers (engines, advanced circuits, blue packs). The first M7 soak (`m7x-11`)
 * replaced the green line with a generated inserter row whose circuit route could not be placed.
 */
function chainProducible(ctx: DesignContext, item: string, depth: number, rowInputs = 2): boolean {
  if (depth > 8) return false
  if (resourceFor(ctx, item) !== undefined) return true
  const cell = CELLS[item]
  if (cell !== undefined) {
    for (const ing of cell.inputs) if (!chainProducible(ctx, ing, depth + 1, rowInputs)) return false
    return true
  }
  const gen = generatorRule({ ...ctx, rowInputs }, item)
  if (gen === undefined) return false
  // B194: a pumped fluid (water) has no recipe, the pump needs nothing; the oil complex (only once advanced oil
  // processing is enabled) takes crude oil and water, and its products' recipes are not named after them.
  if (gen === "water-pump" || gen === "oil-complex") return true
  const rn = ctx.facts.recipeForItem(item)
  const r = rn !== undefined ? ctx.facts.recipe(rn) : undefined
  if (r === undefined) return false
  for (const ing of r.ingredients) if (!chainProducible(ctx, ing.name, depth + 1, rowInputs)) return false
  return true
}

/**
 * M7d.5: self-contained production cells and the only inputs that cross their boundary. The intermediate (copper
 * cable, gears, pipes, robot frames) is made and consumed inside one module; the design graph sees one provider and
 * no intermediate route.
 */
const CELLS: Record<string, { generator: GeneratorName; inputs: string[] }> = {
  "advanced-circuit": { generator: "circuit-block", inputs: ["electronic-circuit", "plastic-bar", "copper-plate"] },
  "engine-unit": { generator: "engine-cell", inputs: ["steel-plate", "iron-plate"] },
  "construction-robot": { generator: "robot-cell", inputs: ["electric-engine-unit", "battery", "steel-plate", "electronic-circuit"] },
}

function generatorRule(ctx: DesignContext, item: string): GeneratorName | undefined {
  const cell = CELLS[item]
  if (cell !== undefined) return cell.generator
  const fluid = ctx.facts.isFluid?.(item) === true
  // M7c: a fluid resource is pumped (pumpjack field), the offshore-pumped fluid comes from a water pump, and other fluids
  // are made and used inside a module (a fluid chain's petroleum): no producer of their own.
  if (resourceFor(ctx, item) !== undefined) return fluid ? "pumpjack-field" : "mining-outpost"
  const adv = advancedOil(ctx)
  if (fluid) {
    if (item === (ctx.pumpedFluid ?? "water")) return "water-pump"
    if (!adv) return undefined
    if ((ctx.oilComplexOutputs ?? OIL_COMPLEX_OUTPUTS).indexOf(item) >= 0) return "oil-complex"
    // M7d.4: a chemistry fluid (sulfuric acid) comes from a chemistry row's manifold.
    const fr = recipeOf(ctx, item)
    return fr !== undefined && chemRowFits(ctx, fr) ? "chem-row" : undefined
  }
  const r = recipeOf(ctx, item)
  if (r === undefined) return undefined
  if (r.ingredients.some((i) => i.fluid === true)) {
    if (adv) {
      // M7d.4: fluids by pipe from their own providers (the oil complex, a water pump, an acid row).
      if (chemRowFits(ctx, r)) return "chem-row"
      const fluids = r.ingredients.filter((i) => i.fluid === true).length
      const solids = r.ingredients.length - fluids
      if (fluids === 1 && solids >= 1 && solids <= 2 && machineFor(ctx, r.category) !== undefined) return "assembler-row"
    }
    return fluidSourceFor(ctx, r) !== undefined ? "fluid-chain" : undefined
  }
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
  if (r.ingredients.length >= 1 && r.ingredients.length <= (ctx.rowInputs ?? 2) && machineFor(ctx, r.category) !== undefined) return "assembler-row"
  return undefined
}

/** M7d.4: the fluids the oil complex makes, by default. */
const OIL_COMPLEX_OUTPUTS = ["petroleum-gas", "lubricant"]

function advancedOil(ctx: DesignContext): boolean {
  return ctx.enabled[ctx.advancedOil ?? "advanced-oil-processing"] === true
}

function recipeOf(ctx: DesignContext, item: string): RecipeFacts | undefined {
  const rn = ctx.facts.recipeForItem(item)
  return rn !== undefined ? ctx.facts.recipe(rn) : undefined
}

/** M7d.4: a chemical-plant recipe a chemistry row takes (1–2 fluids, at most 2 solids, one product). */
function chemRowFits(ctx: DesignContext, r: RecipeFacts): boolean {
  if ((ctx.facts.entity(ctx.chemPlant ?? "chemical-plant")?.craftingCategories ?? []).indexOf(r.category) < 0) return false
  const fluids = r.ingredients.filter((i) => i.fluid === true).length
  return fluids >= 1 && fluids <= 2 && r.ingredients.length - fluids <= 2 && r.products.length === 1
}

/** M7c: the first assembler whose crafting categories include `category`. */
function machineFor(ctx: DesignContext, category: string): string | undefined {
  for (const m of ctx.assemblers ?? [ctx.assembler]) if ((ctx.facts.entity(m)?.craftingCategories ?? []).indexOf(category) >= 0) return m
  return undefined
}

/** M7c: the refinery recipe making the fluid a chemistry recipe uses, from a fluid it does not (crude oil → petroleum). */
function fluidSourceFor(ctx: DesignContext, r: RecipeFacts): RecipeFacts | undefined {
  const src = ctx.facts.recipe(ctx.fluidSource ?? "basic-oil-processing")
  if (src === undefined) return undefined
  for (const p of src.products) if (p.fluid === true && r.ingredients.some((i) => i.name === p.name)) return src
  return undefined
}

/** M7d.4: the largest oil complex the design plans (refineries); a bigger need takes a parallel complex. */
const OIL_COMPLEX_MAX_REFINERIES = 12
/** M7d.4: the most lubricant plants an oil complex sizing tries. */
const OIL_COMPLEX_MAX_LUBE = 6

/** M7c: crude per second of a nominal well (100% yield) when a pumpjack field is sized before its field is known. */
const NOMINAL_WELL = 10

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
    const max = smelterMaxFurnaces(ctx.facts, recipe, ctx.furnace)
    // M7d.5 (user, 2026-11-07): from the first blue stage on, a furnace stack is always planned at its maximum feasible
    // size. The stage target still decides how many stacks exist; it no longer decides how tall each one is.
    // B175 (user, 2026-11-09): only a stack fed by ore (the size is the ore lane's); steel from plates is sized to need.
    const fromOre = (ctx.facts.recipe(recipe)?.ingredients ?? []).some((i) => resourceFor(ctx, i.name) !== undefined)
    if (ctx.maxSmelters === true && fromOre) out.push({ recipe, furnaces: max, furnace: ctx.furnace, fuel: ctx.fuel, buffer: ctx.buffer ?? "" })
    else for (let n = 4; n <= max; n += 4) out.push({ recipe, furnaces: n, furnace: ctx.furnace, fuel: ctx.fuel, buffer: ctx.buffer ?? "" })
  } else if (gen === "red-line") {
    for (let u = 1; u <= 12; u++) out.push({ recipe: ctx.facts.recipeForItem(item), units: u, machine: ctx.assembler })
  } else if (gen === "circuit-block") {
    for (let u = 1; u <= 8; u++) out.push({ recipe: ctx.facts.recipeForItem(item), units: u, machine: ctx.assembler, buffer: ctx.buffer ?? "" })
  } else if (gen === "engine-cell") {
    const recipe = ctx.facts.recipeForItem(item)!
    const machine = machineFor(ctx, ctx.facts.recipe(recipe)?.category ?? "crafting") ?? "assembling-machine-2"
    for (let n = 2; n <= 24; n += 2) out.push({ count: n, machine, buffer: ctx.buffer ?? "iron-chest" })
  } else if (gen === "robot-cell") {
    const recipe = ctx.facts.recipeForItem(item)!
    const machine = machineFor(ctx, ctx.facts.recipe(recipe)?.category ?? "crafting") ?? ctx.assembler
    for (let n = 2; n <= 24; n += 2) out.push({ count: n, machine, buffer: ctx.buffer ?? "iron-chest" })
  } else if (gen === "assembler-row") {
    const recipe = ctx.facts.recipeForItem(item)!
    const machine = machineFor(ctx, ctx.facts.recipe(recipe)?.category ?? "crafting") ?? ctx.assembler
    // D51: of the assembler rows only those of `bufferRows` get a buffer (gears; M7c.8, the user: engine units, which
    // pumps need and only an assembler makes). M7c.8 (seed 11): a chemical science pack row had one; its 2 slots hold
    // 400 packs, so the starved row's every pack went into the chest and none reached the labs.
    const buffer = (ctx.bufferRows ?? ["iron-gear-wheel"]).indexOf(item) >= 0 ? ctx.buffer ?? "" : ""
    for (let n = 2; n <= 24; n += 2) out.push({ recipe, count: n, machine, buffer })
  } else if (gen === "fluid-chain") {
    // Fewest machines first: plants, then refineries for them.
    const recipe = ctx.facts.recipeForItem(item)!
    for (let c = 1; c <= 8; c++) for (let r = 1; r <= 2 * c + 1; r++) out.push({ recipe, chemPlants: c, refineries: r, source: ctx.fluidSource ?? "basic-oil-processing", refinery: ctx.refinery ?? "oil-refinery", chemPlant: ctx.chemPlant ?? "chemical-plant" })
  } else if (gen === "chem-row") {
    const recipe = ctx.facts.recipeForItem(item)!
    for (let c = 1; c <= 12; c++) out.push({ recipe, chemPlants: c, chemPlant: ctx.chemPlant ?? "chemical-plant" })
  } else if (gen === "oil-complex") {
    // Petroleum: refineries only; lubricant: one plant per 2 refineries at least (`expandOilComplex` sizes both at once).
    const lube = item === "lubricant"
    for (let r = 1; r <= OIL_COMPLEX_MAX_REFINERIES; r++) out.push({ refineries: r, lubePlants: lube ? math.max(1, math.ceil(r / 2)) : 0, refinery: ctx.refinery ?? "oil-refinery", chemPlant: ctx.chemPlant ?? "chemical-plant" })
  } else if (gen === "pumpjack-field") {
    // Sized on nominal wells (100%, in a row 7 tiles apart): the runtime generates the module from a real field when it
    // plans it, and that field must yield at least this much.
    const resource = resourceFor(ctx, item)!
    for (let n = 1; n <= 16; n++) {
      const wells: { x: number; y: number; perSecond: number }[] = []
      for (let i = 0; i < n; i++) wells.push({ x: 7 * i, y: 0, perSecond: NOMINAL_WELL })
      out.push({ wells: encodeWells(wells), resource, pumpjack: ctx.pumpjack ?? "pumpjack" })
    }
  } else if (gen === "water-pump") {
    out.push({})
  } else if (gen === "steam-block") {
    for (let b = 1; b <= 10; b++) out.push({ boilers: b, fuel: ctx.fuel, boiler: ctx.boiler, engine: ctx.engine })
  } else if (gen === "solar-field") {
    for (let u = 1; u <= SOLAR_MAX_UNITS; u++) out.push({ units: u })
  }
  // B205 (user, 2026-11-12): medium poles everywhere once researched (a solar field has them anyway).
  if (ctx.pole !== undefined && gen !== "solar-field") for (const p of out) p.pole = ctx.pole
  return out
}

function kindOf(gen: ModuleKind): NodeKind {
  if (gen === "mining-outpost") return "outpost"
  if (gen === "steam-block" || gen === "solar-field") return "power"
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
function sizeModule(ctx: DesignContext, gen: ModuleKind, item: string, need: number, extra?: Record<string, unknown>): Sized | undefined {
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
  for (const base of sizes(ctx, gen, item)) {
    const params = extra !== undefined ? { ...base, ...extra } : base
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
/**
 * M7d.5: a stock sink: the smallest assembler row (two machines) with a buffer head; the crew collects from its buffer
 * chest. Planned at the share of its full rate that `st.perSecond` needs, like the mall (its inputs are demands).
 */
function addStock(ctx: DesignContext, w: Walk, st: { item: string; perSecond: number }, cluster: number): void {
  const recipe = ctx.facts.recipeForItem(st.item)
  const r = recipe !== undefined ? ctx.facts.recipe(recipe) : undefined
  if (r === undefined) {
    w.errors.push(`stock ${st.item}: no recipe`)
    return
  }
  const machine = machineFor(ctx, r.category) ?? ctx.assembler
  const hub = ctx.robotHub !== undefined && ctx.robotHub.robot === st.item ? ctx.robotHub : undefined
  // M7d.5 (user, 2026-11-07): the construction-robot stock is one self-contained cell: frames, robots and the first
  // roboport. The cell's first buffer chest fills the roboport, so the stock becomes an active network.
  const stockRoleName = stockRole(st.item)
  const builtStock = ctx.builtGenerators?.[stockRoleName]
  const cell = producerFor(ctx, st.item) === "robot-cell" && (builtStock === undefined || builtStock === "robot-cell")
  const params: Record<string, unknown> = cell
    ? { count: 2, machine, buffer: ctx.buffer !== undefined && ctx.buffer !== "" ? ctx.buffer : "iron-chest", roboport: hub?.roboport ?? "roboport" }
    : { recipe, count: 2, machine, buffer: ctx.buffer !== undefined && ctx.buffer !== "" ? ctx.buffer : "iron-chest" }
  if (!cell && hub !== undefined) {
    params.roboport = hub.roboport
    params.storageChest = hub.storageChest
    params.storage = hub.storage
  }
  const [ok, made] = pcall(ctx.make, cell ? "robot-cell" : "assembler-row", params)
  if (!ok) {
    w.errors.push(`stock ${st.item}: ${tostring(made)}`)
    return
  }
  const def = made as ModuleDef
  const full = outputRate(def, st.item)
  if (full <= EPS) return
  const utilization = math.min(1, st.perSecond / full)
  const role = stockRole(st.item)
  const inputs = inputPorts(def, utilization)
  w.nodes.push({ role, kind: "sink", generator: cell ? "robot-cell" : "assembler-row", params, def, item: st.item, need: utilization, capacity: 1, inputs, powerW: powerOf(def.rates.inputs) * utilization, cluster })
  for (const p of inputs) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: role, toPort: p.port })
}

/** Adds a demand unless a sealed port is waiting for its consumer's relocation (B57/B61). */
function addDemand(w: Walk, item: string, rate: number, to: string, toPort: string): void {
  if (w.ctx.noFeed?.[`${to}.${toPort}`] === true) return
  w.demands.push({ item, rate, to, toPort })
}

function inputPorts(def: ModuleDef, utilization: number): DesignPort[] {
  const out: DesignPort[] = []
  const count: Record<string, number> = {}
  // M7c: fluid inputs (`pipe-in`) are demands too.
  const isIn = (k: string): boolean => k === "belt-in" || k === "pipe-in"
  for (const p of def.ports) if (isIn(p.kind) && p.item !== undefined) count[p.item] = (count[p.item] ?? 0) + 1
  for (const p of def.ports) {
    if (!isIn(p.kind) || p.item === undefined) continue
    let rate = 0
    for (const r of def.rates.inputs) if (r.item === p.item) rate += r.perSecond
    out.push({ port: p.id, item: p.item, rate: (rate * utilization) / count[p.item] })
  }
  return out
}

function outPort(def: ModuleDef, item: string): string {
  for (const p of def.ports) if ((p.kind === "belt-out" || p.kind === "pipe-out") && p.item === item) return p.id
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
  /**
   * B199: built capacity (`providerCaps`) already given to consumers, per role, shared by every cluster's walk. Each
   * cluster walks its share of the target and its consumers may tap the same built provider: counted per walk, the merged
   * design asked a short provider for twice its capacity and planned no parallel provider (seed 11, min 222).
   */
  builtUsed: Record<string, number>
}

/** B199: what is left of a built provider's capacity after the walks so far. */
function builtLeft(w: Walk, role: string): number | undefined {
  const cap = w.ctx.providerCaps?.[role]
  return cap === undefined ? undefined : math.max(0, cap - (w.builtUsed[role] ?? 0))
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

/**
 * The next free provider role for a parallel provider (`coal>power`, `coal>power~2`, ...). B68: `~N`, not `#N`: `#N` is
 * also a consumer's suffix (`power#2`, `labs#2`), so `coal>power#2` was both the second coal provider of `power` and the
 * coal supply of `power#2`, and the design merged the two into one node.
 */
function parallelRole(w: Walk, role: string, avoidBuilt = false, spent = false): string {
  // TSTL wraps `string.match`'s returns in a 0-based TS array; [0] is the first capture (empty when no match).
  const m = string.match(role ?? "", "^(.*)~%d+$")
  const base = m[0] !== undefined ? m[0] : (role ?? "provider")
  let n = 2
  for (;;) {
    const candidate = `${base}~${n}`
    // A built provider may not have been emitted into this design yet (or its exact feed may have just been denied).
    // Its role is still occupied: reusing it makes diffDesign bind the replacement to the old graph node.
    let used = candidate === role || (avoidBuilt && w.ctx.providerCaps?.[candidate] !== undefined)
    // B199: a built provider another cluster's walk already used up.
    if (spent && (builtLeft(w, candidate) ?? 1) <= EPS) used = true
    for (const node of w.nodes) if (node.role === candidate) used = true
    if (!used) return candidate
    n++
  }
}

/**
 * Add one provider node. `fixedCapacity` is set when the node is the existing, unexpandable half of a provider group:
 * its design capacity is the real capacity, so the diff does not ask this provider to grow again.
 */
function addProducer(w: Walk, item: string, rate: number, consumers: Demand[], shared = false, sharedRole?: string, fixedCapacity?: number, mergePorts?: Record<string, boolean>, newSite = false): void {
  const ctx = w.ctx
  let gen = producerFor(ctx, item)
  // M7d.4: a fluid chain already in the factory stays one under its role after the switch to pipe-fed rows.
  const builtRole = sharedRole ?? (ctx.policy.topology === "splitter-tap" || shared ? `${item}${w.suffix}` : `${item}>${consumers[0].to}`)
  if (gen === "chem-row" && ctx.builtGenerators?.[builtRole] === "fluid-chain") {
    const r = recipeOf(ctx, item)
    if (r !== undefined && fluidSourceFor(ctx, r) !== undefined) gen = "fluid-chain"
  }
  // M7d.5: an old save's built row keeps its generator until it is replaced. The new cell's ports (engine-cell iron
  // input, circuit-block split copper, robot-cell frame inputs) do not exist on an assembler row built before the
  // change; planning to them failed "no belt-in port". New roles still get the cell.
  const builtGen = ctx.builtGenerators?.[builtRole]
  if (builtGen !== undefined && builtGen !== gen && (builtGen === "assembler-row" || builtGen === "circuit-block" || builtGen === "engine-cell" || builtGen === "robot-cell")) {
    if (gen === "engine-cell" || gen === "robot-cell" || gen === "circuit-block" || gen === "assembler-row") gen = builtGen
  }
  if (gen === undefined) {
    w.errors.push(`no module makes ${item}`)
    return
  }
  // D54: a steam block only asks for coal once electric drills are enabled, so no producer here needs burner drills.
  let role = sharedRole ?? (ctx.policy.topology === "splitter-tap" || shared ? `${item}${w.suffix}` : `${item}>${consumers[0].to}`)
  if (role === undefined || role === "") role = `${item}${w.suffix}`
  // D76: the retiring provider's role is still in the graph, so reusing it would make the diff think its replacement
  // already exists. Plan the replacement under a fresh parallel role, merging into the belt the old provider still feeds.
  if (sharedRole === undefined && ctx.retiring !== undefined && ctx.retiring[role] === true) {
    const ports: Record<string, boolean> = {}
    for (const c of consumers) ports[`${c.to}.${c.toPort}`] = true
    mergePorts = mergePorts ?? ports
    role = parallelRole(w, role, true)
    // B81: a replacement never shares the provider it replaces. Folded into the retiring whole-patch mine (D52), it was
    // an alias of that mine and was dropped with it (vps-d68a 5480563 n18).
    newSite = true
  }
  // B97 (user decision in-session 2026-10-29, "Built first"; sweep 3e1c4d7 seed 7625436): built providers of this role's
  // family (`role`, `role~2`, ...) that the design has not used keep the consumers they feed, at their real capacity and
  // under their own roles; only the rest is this role's. Parallel roles are numbered as the design walks, so when a
  // group changed (its first provider gone) a built `~2` dropped out of the design and starved with nothing planning
  // its inputs.
  // Also on the sharing path (a shared role chosen for these consumers, `sharedRole`): sweep 3e1c4d7 seed 7625436's
  // group was planned there, all three consumers on `~3`, and the built `~2` feeding the same ports was left out.
  if (fixedCapacity === undefined && ctx.providerFeeds !== undefined) {
    const family = roleFamily(role)
    const roles: string[] = []
    for (const [r] of pairs(ctx.providerCaps ?? {})) roles.push(r as string)
    roles.sort()
    const joins: Record<string, boolean> = { ...(mergePorts ?? {}) }
    for (const r of roles) {
      const cap = builtLeft(w, r)!
      const feeds = ctx.providerFeeds[r]
      if (r === role || roleFamily(r) !== family || cap <= EPS || feeds === undefined || ctx.retiring?.[r] === true) continue
      if (w.nodes.some((n) => n.role === r)) continue
      const kept = consumers.filter((c) => feeds[`${c.to}.${c.toPort}`] === true)
      if (kept.length === 0) continue
      consumers = consumers.filter((c) => feeds[`${c.to}.${c.toPort}`] !== true)
      const split = splitDemand(kept, cap)
      let keptRate = 0
      for (const c of split.keep) keptRate += c.rate
      addProducer(w, item, keptRate, split.keep, shared, r, cap)
      rate -= keptRate
      // What it can't carry joins its belt from the provider this role plans.
      for (const c of split.rest) {
        joins[`${c.to}.${c.toPort}`] = true
        consumers.push(c)
      }
    }
    if (consumers.length === 0 || rate <= EPS) return
    if (next(joins)[0] !== undefined) mergePorts = joins
  }
  // M7 (C, user request in-session 2026-11-03): a top-up into a belt that still feeds its consumer (a merge edge) below
  // `factory-min-top-up` items/s gets no provider: seed 11 g111 planned a coal mine and a 550-tile belt for 0.004/s.
  const minTopUp = ctx.minTopUp ?? 0
  if (fixedCapacity === undefined && minTopUp > 0 && mergePorts !== undefined) {
    const kept = consumers.filter((c) => !(mergePorts![`${c.to}.${c.toPort}`] === true && c.rate < minTopUp - EPS))
    if (kept.length < consumers.length) {
      for (const c of consumers) if (kept.indexOf(c) < 0) rate -= c.rate
      consumers = kept
      if (consumers.length === 0 || rate <= EPS) return
    }
  }
  const capacity = fixedCapacity ?? builtLeft(w, role)
  // B60: a built provider that cannot grow keeps its existing consumers at its real capacity. The residual gets a
  // distinct parallel role, rather than one oversized node that can never be satisfied.
  // B199: another cluster's walk may have used all of it; then everything goes to the parallel role, merging into the
  // belts the provider feeds.
  const builtCap = ctx.providerCaps?.[role] ?? 0
  if (fixedCapacity === undefined && capacity !== undefined && builtCap > EPS && ctx.providerShort?.[role] === true && rate > capacity + EPS) {
    const split = splitDemand(consumers, capacity)
    const mergePorts: Record<string, boolean> = {}
    for (const c of split.keep) mergePorts[`${c.to}.${c.toPort}`] = true
    const feeds = ctx.providerFeeds?.[role]
    if (feeds !== undefined) for (const c of split.rest) if (feeds[`${c.to}.${c.toPort}`] === true) mergePorts[`${c.to}.${c.toPort}`] = true
    // B71: the residual of a straddled port that takes no merge is dropped; that consumer gets what this provider makes.
    // B80: a consumer moved whole whose port takes no merge stays whole on this provider too (its belt still feeds it,
    // and no second belt can get in: vps-b79-r1459426).
    if (ctx.noMerge !== undefined) {
      const noMerge = ctx.noMerge
      const rest: Demand[] = []
      for (const c of split.rest) {
        const port = `${c.to}.${c.toPort}`
        if (!noMerge[port]) rest.push(c)
        else if (!mergePorts[port]) split.keep.push(c)
      }
      split.rest = rest
    }
    if (split.keep.length > 0) addProducer(w, item, capacity, split.keep, shared, role, capacity)
    if (split.rest.length > 0) addProducer(w, item, rate - capacity, split.rest, shared, parallelRole(w, role, false, true), undefined, mergePorts)
    return
  }
  const s = sizeModule(ctx, gen, item, rate)
  if (s === undefined) {
    w.errors.push(`${gen} for ${item}: no valid size`)
    return
  }
  if (s.short) w.short = true
  if (ctx.providerCaps?.[role] !== undefined) w.builtUsed[role] = (w.builtUsed[role] ?? 0) + rate
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
    // D65 (user, 2026-10-28): a module draws power in proportion to how busy it is, like its inputs. Nameplate draw
    // sized power ~7x above the measured load and, once B66 let the excess plan real steam blocks, used up coal patches.
    powerW: powerOf(s.def.rates.inputs) * util,
    cluster: w.cluster,
    newSite: newSite || ctx.ownSite?.[role] === true || undefined,
  }
  w.nodes.push(node)
  const from = outPort(s.def, item)
  for (const c of consumers) w.edges.push(edge(w, node.role, from, c, mergePorts?.[`${c.to}.${c.toPort}`] === true))
  for (const p of node.inputs) if (p.rate > EPS) addDemand(w, p.item, p.rate, role, p.port)
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
  // M7c (user-approved 2026-11-01): a built consumer counts at what it was measured drawing when that is more than its
  // plan (seed 11: two 4-furnace iron columns planned at 0.47/s drew a mine's whole 1/s; the blue line sharing it
  // starved). Producers are sized and tapped for the real draw.
  if (shared.draw !== undefined) {
    const draw = shared.draw
    mine = mine.map((d) => {
      const m = draw[`${item}@${d.to}@${d.toPort}`]
      return m !== undefined && m > d.rate ? { ...d, rate: m } : d
    })
  }
  const byProducer: Record<string, Demand[]> = {}
  const producers: string[] = []
  const fresh: Demand[] = []
  const alone: Demand[] = []
  // Consumer ports whose existing belt a retiring provider's replacement must side-load into (D76).
  const mergePorts: Record<string, boolean> = {}
  // M7 (B, user request in-session 2026-11-03): which retiring provider fed each such port.
  const heirOf: Record<string, string> = {}
  for (const d of mine) {
    let p: string | undefined = shared.keep[`${item}@${d.to}@${d.toPort}`] ?? shared.keep[`${item}@${d.to}`]
    if (p !== undefined && shared.blocked?.[`${p}=>${d.to}.${d.toPort}`] === true) p = undefined
    // D76: the provider is retiring. Its consumer needs a replacement that side-loads into the belt it still feeds.
    if (p !== undefined && w.ctx.retiring?.[p] === true) {
      mergePorts[`${d.to}.${d.toPort}`] = true
      heirOf[`${d.to}.${d.toPort}`] = p
      p = undefined
    }
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
  // M7d.5: a provider with spare but **no consumer in this walk** is still a valid tap. Its old consumer may sit in a
  // different goal (the water line feeding an older sulfur row). Without this, every new fluid consumer got a new
  // provider and its line was planned through the built base, while a same-fluid line with room ran beside the port.
  const assign = producers.slice()
  for (const [p] of pairs(spare)) if (assign.indexOf(p as string) < 0) assign.push(p as string)
  assign.sort()
  for (const p of assign) {
    let room = spare[p] ?? 0
    if (room <= EPS) continue
    if (byProducer[p] === undefined) {
      byProducer[p] = []
      producers.push(p)
    }
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
  producers.sort()
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
  // D68 (user, 2026-10-28): the consumers of a group split into parallel providers (B61) tap the fallback producer too,
  // instead of a parallel provider per consumer that may find no free patch at all (vps-b80d 1264816).
  if (fb !== undefined) {
    for (const p of [...producers]) {
      if (p === fb || shared.split?.[p] !== true) continue
      if (byProducer[fb] === undefined) {
        byProducer[fb] = []
        producers.push(fb)
      }
      for (const d of byProducer[p]) byProducer[fb].push(d)
      byProducer[p] = []
    }
  }
  // A new steam block (power#2) may tap a built producer, but never waits in a new shared group.
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (!isPowerRole(fresh[i].to)) continue
    alone.push(fresh[i])
    fresh.splice(i, 1)
  }
  // M7 (B, user request in-session 2026-11-03; seed 11 g108/g111): the consumers a retiring provider still feeds get
  // one replacement group per retiring provider, apart from the new consumers. Mixed into the blue line's new fuel
  // group, the coal tap tree of a worked-out base mine could not be reached from one site with the blue line 500 tiles
  // away; the group was split per consumer and g111 planned eight coal mines, one per smelter top-up.
  const heirs: Record<string, Demand[]> = {}
  const heirRoles: string[] = []
  for (let i = 0; i < fresh.length; i++) {
    const port = `${fresh[i].to}.${fresh[i].toPort}`
    const p = heirOf[port]
    if (p === undefined) continue
    // A port that took no merge (B71, learned from a failed plan: seed 11 g111's sealed copper-smelter fuel line) keeps
    // the retiring provider's belt until that provider is gone; then it is fed again like any consumer.
    if (w.ctx.noMerge?.[port] === true) {
      fresh.splice(i, 1)
      i--
      continue
    }
    if (heirs[p] === undefined) {
      heirs[p] = []
      heirRoles.push(p)
    }
    heirs[p].push(fresh[i])
    fresh.splice(i, 1)
    i--
  }
  heirRoles.sort()
  for (const p of producers) {
    // A shared provider planned for several consumers can be route-infeasible: no one site reaches all of them.
    // After such a plan failure the factory marks the role; give each consumer its own parallel provider instead.
    if (shared.split?.[p] === true) {
      for (const d of byProducer[p]) addProducer(w, item, d.rate, [d], true, parallelRole(w, p, true), undefined, mergePorts, true)
      continue
    }
    let total = 0
    for (const d of byProducer[p]) total += d.rate
    addProducer(w, item, total, byProducer[p], true, p)
  }
  for (const p of heirRoles) {
    const group = heirs[p]
    if (group.length < 2) {
      for (const d of group) alone.push(d)
      continue
    }
    const role = parallelRole(w, p, true)
    if (shared.split?.[role] === true) {
      for (const d of group) addProducer(w, item, d.rate, [d], true, parallelRole(w, role, true), undefined, mergePorts, true)
      continue
    }
    let total = 0
    for (const d of group) total += d.rate
    addProducer(w, item, total, group, true, role, undefined, mergePorts, true)
  }
  if (fresh.length >= 2) {
    const role = `${item}*>${fresh[0].to}`
    if (shared.split?.[role] === true) {
      // The previous plan could not reach every consumer from one site. One parallel provider per consumer.
      // M7 (seed 11 g78): each still side-loads into the belt a retiring provider feeds (D76). Without `mergePorts` the
      // three coal replacements of a dry mine each routed onto a smelter's fuel port that the old belt still held: every
      // plan failed "no path" after a full search, at 26 ms a tick for over an hour of game time.
      for (const d of fresh) addProducer(w, item, d.rate, [d], true, parallelRole(w, role, true), undefined, mergePorts, true)
    } else {
      let total = 0
      let replacing = false
      for (const d of fresh) {
        total += d.rate
        if (mergePorts[`${d.to}.${d.toPort}`]) replacing = true
      }
      // B81: a group that replaces a retiring provider never shares it (see addProducer).
      addProducer(w, item, total, fresh, true, role, undefined, mergePorts, replacing)
    }
  } else for (const d of fresh) alone.push(d)
  for (const d of alone) addProducer(w, item, d.rate, [d], false, undefined, undefined, mergePorts, mergePorts[`${d.to}.${d.toPort}`] === true)
}

/** Expands every pending demand for `item` (point-to-point: one producer each; splitter-tap: one for all). */
/**
 * M7d.4 (D81): one oil complex per cluster makes every petroleum and lubricant demand pending in the walk (they are
 * fluids, expanded together in the walk's leftover passes): sized for both at once, each consumer fed from its
 * product's port. A built complex too small for the need keeps what it can feed; the rest goes to a parallel complex.
 */
function expandOilComplex(w: Walk): void {
  const ctx = w.ctx
  const outs = ctx.oilComplexOutputs ?? OIL_COMPLEX_OUTPUTS
  const mine: Demand[] = []
  const rest: Demand[] = []
  for (const d of w.demands) (outs.indexOf(d.item) >= 0 ? mine : rest).push(d)
  if (mine.length === 0) return
  w.demands = rest
  const role = `oil-complex${w.suffix}`
  // Consumers an existing oil complex already feeds keep it; only new consumers need this plan.
  const fresh: Demand[] = []
  for (const d of mine) {
    const kept = ctx.sharing?.keep[`${d.item}@${d.to}@${d.toPort}`] ?? ctx.sharing?.keep[`${d.item}@${d.to}`]
    if (kept !== undefined && isOilComplexRole(kept)) continue
    fresh.push(d)
  }
  if (fresh.length === 0) return
  let needPet = 0
  let needLube = 0
  for (const d of fresh) {
    if (d.item === outs[0]) needPet += d.rate
    if (d.item === outs[1]) needLube += d.rate
  }
  // The oil family (base and ~N) is one provider group. Reuse a built role with a lubricant plant when lubricant is
  // needed, otherwise any family role with enough capacity. This is the B19 sharing path the old early return skipped.
  const family: string[] = []
  for (const [r] of pairs(ctx.providerCaps ?? {})) {
    const name = r as string
    if (string.sub(name, 1, role.length) !== role) continue
    const tail = string.sub(name, role.length + 1, role.length + 1)
    if (name === role || tail === "~") family.push(name)
  }
  family.sort()
  for (const r of family) {
    const cap = ctx.providerCaps?.[r] ?? 0
    if (cap + EPS < needPet) continue
    if (needLube > EPS && ctx.oilLube?.[r] !== true) continue
    addOilComplex(w, r, fresh, cap)
    return
  }
  // No single built role covers it: one new complex for the whole residual. B193: a built complex holds the base role
  // even when this walk has not emitted it (it lacked a lubricant plant): reusing the role bound the new complex to it.
  const taken = w.nodes.some((n) => n.role === role) || ctx.providerCaps?.[role] !== undefined
  addOilComplex(w, taken ? parallelRole(w, role, true) : role, fresh)
}

/** Whether `role` is a member of an oil family: the base complex or a cluster/parallel one (`#2`, `~2`). */
export function isOilComplexRole(role: string): boolean {
  const base = "oil-complex"
  return string.sub(role, 1, base.length) === base
}

function addOilComplex(w: Walk, role: string, consumers: Demand[], fixedCapacity?: number): void {
  const ctx = w.ctx
  const outs = ctx.oilComplexOutputs ?? OIL_COMPLEX_OUTPUTS
  const need: Record<string, number> = {}
  for (const d of consumers) need[d.item] = (need[d.item] ?? 0) + d.rate
  const pet = outs[0]
  let chosen: { params: Record<string, unknown>; def: ModuleDef } | undefined
  let short = true
  for (let r = 1; r <= OIL_COMPLEX_MAX_REFINERIES && short; r++) {
    for (let lp = 0; lp <= ((need[outs[1]] ?? 0) > EPS ? OIL_COMPLEX_MAX_LUBE : 0); lp++) {
      const params: Record<string, unknown> = { refineries: r, lubePlants: lp, refinery: ctx.refinery ?? "oil-refinery", chemPlant: ctx.chemPlant ?? "chemical-plant" }
      const [ok, def] = pcall(ctx.make, "oil-complex", params)
      if (!ok) continue
      const d = def as ModuleDef
      chosen = { params, def: d }
      const fits = outs.every((o) => outputRate(d, o) + EPS >= (need[o] ?? 0))
      // A built complex keeps the size that matches its capacity, but must still make every demanded output (a 1/0
      // complex cannot serve lubricant).
      if (fixedCapacity !== undefined ? outputRate(d, pet) + EPS >= fixedCapacity && fits : fits) {
        short = false
        break
      }
    }
  }
  if (chosen === undefined) {
    w.errors.push("oil-complex: no valid size")
    return
  }
  if (short) w.short = true
  let util = 0
  for (const o of outs) {
    const c = outputRate(chosen.def, o)
    if (c > EPS) util = math.max(util, (need[o] ?? 0) / c)
  }
  util = math.min(1, util)
  const node: DesignNode = {
    role,
    kind: "module",
    generator: "oil-complex",
    params: chosen.params,
    def: chosen.def,
    item: pet,
    need: need[pet] ?? 0,
    capacity: fixedCapacity ?? outputRate(chosen.def, pet),
    inputs: inputPorts(chosen.def, util),
    powerW: powerOf(chosen.def.rates.inputs) * util,
    cluster: w.cluster,
  }
  w.nodes.push(node)
  for (const c of consumers) w.edges.push(edge(w, role, outPort(chosen.def, c.item), c))
  for (const p of node.inputs) if (p.rate > EPS) addDemand(w, p.item, p.rate, role, p.port)
}

function expandItem(w: Walk, item: string): void {
  // Petroleum/lubricant are expanded once, after all other consumers are known (see `designCluster`).
  if (producerFor(w.ctx, item) === "oil-complex") return
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

function designCluster(ctx: DesignContext, target: DesignTarget, order: string[], cluster: number, clusters: number, builtUsed: Record<string, number>): Walk {
  const suffix = clusterSuffix(cluster, clusters)
  const w: Walk = { ctx, cluster, suffix, nodes: [], edges: [], demands: [], errors: [], short: false, builtUsed }
  const items = targetItems(target)
  const frac = clusterFraction(ctx, cluster, clusters)
  // Labs consume one of each pack per research unit: sized for the fastest pack rate at the configured unit time.
  let rate = 0
  for (const t of items) rate = math.max(rate, t.perSecond * frac)
  const speed = ctx.facts.entity(ctx.lab)?.researchSpeed ?? 1
  const labs = math.max(2, 2 * math.ceil((rate * ctx.researchUnitTime) / speed / 2 - EPS))
  let packs = [...ctx.packs]
  for (const t of items) if (packs.indexOf(t.item) < 0) packs = [t.item]
  const labParams = { labs, packs, lab: ctx.lab, unitTime: ctx.researchUnitTime, pole: ctx.pole }
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
    w.nodes.push({ role: "mall", kind: "sink", generator: "curated", params: { id: target.mall.id }, def, item: "mall", need: target.mall.utilization, capacity: 1, inputs, powerW: powerOf(def.rates.inputs) * target.mall.utilization, cluster })
    for (const p of inputs) if (p.rate > EPS) w.demands.push({ item: p.item, rate: p.rate, to: "mall", toPort: p.port })
  }
  if (cluster === 1) for (const st of target.stock ?? []) addStock(ctx, w, st, cluster)
  const oilOuts = ctx.oilComplexOutputs ?? OIL_COMPLEX_OUTPUTS
  for (const item of order) if (item !== ctx.fuel && oilOuts.indexOf(item) < 0) expandItem(w, item)
  // M7c: a module may ask for an item the recipe walk never reaches (a fluid chain's crude oil and water: its petroleum
  // has no recipe of its own). Expand those too, until nothing new is asked for.
  // M7d.5 (user, 2026-11-08): petroleum and lubricant are deliberately left in `w.demands` until every other consumer
  // has added its draw. Expanding them item by item created one new oil complex per consumer (24 tiny complexes).
  for (let pass = 0; pass < 4; pass++) {
    const left: string[] = []
    for (const d of w.demands) if (d.item !== ctx.fuel && oilOuts.indexOf(d.item) < 0 && left.indexOf(d.item) < 0) left.push(d.item)
    if (left.length === 0) break
    for (const item of left) expandItem(w, item)
  }
  // One oil family decision for the whole stage: all petroleum and lubricant demands are known here.
  if (w.demands.some((d) => oilOuts.indexOf(d.item) >= 0)) expandOilComplex(w)
  // The oil complex's own inputs (crude, water, ...) may not have been expanded yet.
  for (let pass = 0; pass < 4; pass++) {
    const left: string[] = []
    for (const d of w.demands) if (d.item !== ctx.fuel && oilOuts.indexOf(d.item) < 0 && left.indexOf(d.item) < 0) left.push(d.item)
    if (left.length === 0) break
    for (const item of left) expandItem(w, item)
  }
  for (const d of w.demands) if (d.item !== ctx.fuel) w.errors.push(`unplanned demand for ${d.item}`)
  return w
}

/**
 * B65 (phase 2, prototype): re-size every producer from the demand its final edges actually carry.
 *
 * The walk sizes a producer when it creates it, from the consumers known at that moment, and attaches later consumers to
 * its *nameplate* spare. The provider's own inputs are never re-sized, so a node can end up carrying more edges than
 * its feed supplies (seed 3891760: a copper smelter planned 0.183/s carrying 0.827/s for 270 game-min). `requiredRates`
 * propagates the edges' demand up the input ratios to a fixpoint; raising each node's `need` to that value makes the
 * plan and the diff see the truth, so `diffDesign` asks a short provider to grow (or it stays within its module's
 * capacity and simply runs at the rate its consumers asked for).
 *
 * Growth by expansion units and forking a new module are still decided by `diffDesign`; this pass only removes the
 * stale sizing that kept those decisions from being made at all.
 */
function supplyPass(ctx: DesignContext, all: DesignNode[], allEdges: DesignEdge[]): void {
  const nodes: SupplyNode[] = []
  const edges: SupplyEdge[] = []
  for (const n of all) {
    if (n.kind === "sink") continue
    const out = rateIn(n.def.rates.outputs, n.item)
    const inputs: { item: string; perOutput: number }[] = []
    if (out > EPS) for (const r of n.def.rates.inputs) if (r.item !== "electricity" && r.perSecond > EPS) inputs.push({ item: r.item, perOutput: r.perSecond / out })
    nodes.push({ role: n.role, item: n.item, planned: n.need, capacity: out, unitRate: 0, maxUnits: 0, inputs })
  }
  if (nodes.length === 0) return
  for (const e of allEdges) edges.push({ from: e.from, to: e.to, item: e.item, rate: e.rate })
  const req = requiredRates(nodes, edges)
  for (const n of all) {
    if (n.kind === "sink") continue
    let want = req[n.role] ?? 0
    // B199: a built provider that cannot grow stays at its real capacity (B60); what its consumers lack beyond it was
    // dropped on purpose (B71: a port that takes no merge). Raised, it only became a grow spec nothing could meet.
    const cap = ctx.providerCaps?.[n.role]
    if (cap !== undefined && ctx.providerShort?.[n.role] === true) want = math.min(want, math.max(n.need, cap))
    if (want <= n.need + EPS) continue
    n.need = want
    n.inputs = inputPorts(n.def, n.capacity > EPS ? math.min(1, want / n.capacity) : 1)
  }
}

/** Whether a role is the power node or a fuel supply of it, while the design walks (graph nodes: `nodeServes`). */
const isPowerRole = rolePower

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
    // B185: in solar mode the built steam block stays at its capacity (and its fuel); solar fields make the rest.
    const capped = ctx.solarPower === true && ctx.powerCaps !== undefined ? math.min(estimate, ctx.powerCaps[0].capacity) : estimate
    const s = sizeModule(ctx, "steam-block", "electricity", capped, steamExtra(ctx, `power${w.suffix}`))
    if (s === undefined) {
      w.errors.push("steam-block: no valid size")
      return estimate
    }
    if (s.short && report !== undefined) report.short = true
    else if (s.short) w.short = true
    const util = s.capacity > EPS ? math.min(1, capped / s.capacity) : 1
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
    steamDemands(ctx, w, steam.role, steam.inputs)
    let total = extraW
    for (const n of w.nodes) if (n.kind !== "power") total += n.powerW
    steam.need = total
    if (total <= s.capacity + EPS || math.abs(total - estimate) < EPS) return total
    estimate = total
  }
  return estimate
}

/**
 * M6/B66: the steam blocks after `power` for what it can't supply. Each capped block (`powerCaps`) carries at most its
 * real capacity, so the diff never asks it to grow; the rest goes to the next role, a new block after the last capped
 * one. Before B66 the excess always went to `power#2`, so once it could not grow either nothing planned a third.
 */
function extraSteam(ctx: DesignContext, w: Walk, electric: number, caps: { role: string; capacity: number }[]): void {
  let rest = electric - caps[0].capacity
  // B185: a built steam block is not asked to grow past what it makes (its fuel is what is missing).
  // B200 (`m7-b199` seed 3333, min 117-194): in steam mode too. The capped block kept the whole need while the next
  // block carried the excess as well; the diff pools power (M7d.5), so 22.3 MW were asked of 18 MW built and the capped
  // block was grown forever (3 failed expansions, no other goal).
  for (const n of w.nodes) if (n.role === caps[0].role) n.need = math.min(n.need, caps[0].capacity)
  for (let i = 1; rest > EPS; i++) {
    const cap = caps[i]
    const take = cap !== undefined ? math.min(rest, cap.capacity) : rest
    if (cap === undefined && (ctx.solarPower === true || solarFaster(ctx, w, `power#${i + 1}`, take))) {
      addSolar(ctx, w, i + 1, take)
      return
    }
    addSteam(ctx, w, cap?.role ?? `power#${i + 1}`, take, cap?.capacity)
    rest -= take
    if (cap === undefined) return
  }
}

/**
 * B185: solar fields for `need` W, from role `power#first` on: each as big as needed up to `SOLAR_MAX_UNITS`, the rest
 * in the next. Nothing to feed: no fuel, no water.
 */
function addSolar(ctx: DesignContext, w: Walk, first: number, need: number): void {
  let rest = need
  for (let i = first; rest > EPS && i < first + MAX_SOLAR_FIELDS; i++) {
    const s = sizeModule(ctx, "solar-field", "electricity", rest)
    if (s === undefined || s.capacity <= EPS) {
      w.errors.push(`power#${i} solar-field: no valid size`)
      return
    }
    const take = math.min(rest, s.capacity)
    const role = `power#${i}`
    w.nodes.push({ role, kind: "power", generator: "solar-field", params: s.params, def: s.def, item: "electricity", need: take, capacity: s.capacity, inputs: [], powerW: s.capacity, cluster: w.cluster })
    rest -= take
  }
}

/**
 * B185 (user, 2026-11-11): whether solar fields for `need` W build faster than a steam block with its own coal mine on
 * the nearest free coal patch (`coalDistance`) and a belt and pole line back. Solar only counts when every one of its
 * buildings has an enabled recipe; materials come at the plate rate of the design's smelter columns.
 */
function solarFaster(ctx: DesignContext, w: Walk, role: string, need: number): boolean {
  if (ctx.coalDistance === undefined) return false
  const solar = sizeModule(ctx, "solar-field", "electricity", need)
  if (solar === undefined || solar.capacity <= EPS) return false
  for (const e of solar.def.entities) {
    const recipe = ctx.facts.recipeForItem(ctx.facts.itemToPlace(e.name) ?? e.name)
    if (recipe === undefined || ctx.enabled[recipe] !== true) return false
  }
  if (!solarBuildable(ctx)) return false
  if (ctx.coalDistance === math.huge) return true
  const steam = sizeModule(ctx, "steam-block", "electricity", need, steamExtra(ctx, role))
  if (steam === undefined) return true
  let plates = 0
  for (const n of w.nodes) if (n.generator === "smelter-column") plates += n.capacity
  const fields = need / solar.capacity
  const sun: BuildEstimate = { entities: [], walkTiles: 0 }
  for (const e of solar.def.entities) addEntities(sun.entities, e.name, fields)
  const coal: BuildEstimate = { entities: [], walkTiles: 2 * ctx.coalDistance }
  let pole: string | undefined
  for (const e of steam.def.entities) {
    addEntities(coal.entities, e.name, 1)
    if (pole === undefined && ctx.facts.entity(e.name)?.wireReach !== undefined) pole = e.name
  }
  const drill = ctx.facts.entity(ctx.electricDrill)
  let ore: string | undefined
  for (const r of ctx.resources) if (ctx.facts.resourceProduct(r) === ctx.fuel) ore = r
  const time = ore !== undefined ? ctx.facts.resourceMiningTime(ore) : undefined
  const fuelJ = ctx.facts.fuelValue(ctx.fuel)
  if (drill?.miningSpeed !== undefined && time !== undefined && fuelJ > 0) addEntities(coal.entities, ctx.electricDrill, math.ceil(need / fuelJ / (drill.miningSpeed / time)))
  const belt = ctx.tiers[0]?.belt
  if (belt !== undefined) addEntities(coal.entities, belt, ctx.coalDistance)
  const reach = pole !== undefined ? ctx.facts.entity(pole)?.wireReach ?? 0 : 0
  if (pole !== undefined && reach > 0) addEntities(coal.entities, pole, math.ceil(ctx.coalDistance / reach))
  return buildSeconds(ctx.facts, sun, plates) < buildSeconds(ctx.facts, coal, plates)
}

/** One steam block after the first, with its own fuel supply; `fixedCapacity` for a built block that can't grow. */
function addSteam(ctx: DesignContext, w: Walk, role: string, extraW: number, fixedCapacity?: number): void {
  const s = sizeModule(ctx, "steam-block", "electricity", extraW, steamExtra(ctx, role))
  if (s === undefined) {
    w.errors.push(`${role} steam-block: no valid size`)
    return
  }
  const util = s.capacity > EPS ? math.min(1, extraW / s.capacity) : 1
  const capacity = fixedCapacity ?? s.capacity
  w.nodes.push({ role, kind: "power", generator: "steam-block", params: s.params, def: s.def, item: "electricity", need: extraW, capacity, inputs: inputPorts(s.def, util), powerW: capacity, cluster: w.cluster })
  steamDemands(ctx, w, role, inputPorts(s.def, util))
}

/** B184: the inland variant's params for a steam-block role that found no shore. */
function steamExtra(ctx: DesignContext, role: string): Record<string, unknown> | undefined {
  return ctx.inlandPower?.[role] === true ? { water: "pipe" } : undefined
}

/**
 * A steam block's input demands: its fuel once electric drills mine it (before that the crew feeds it), and an inland
 * block's water (B184) always.
 */
function steamDemands(ctx: DesignContext, w: Walk, role: string, inputs: DesignPort[]): void {
  const drills = electricDrillsNow(ctx)
  let water: string | undefined
  for (const p of inputs) {
    if (p.rate <= EPS) continue
    const fluid = ctx.facts.isFluid?.(p.item) === true
    if (!fluid && !drills) continue
    w.demands.push({ item: p.item, rate: p.rate, to: role, toPort: p.port })
    if (fluid) water = p.item
  }
  expandItem(w, ctx.fuel)
  if (water !== undefined) expandItem(w, water)
}

export function checkEdges(ctx: DesignContext, w: Walk, overflow: Record<string, string>, sharedPower = false, splitRates: Record<string, number> = {}, prevRates: Record<string, number> = {}): number {
  const available = availableTiers(ctx.tiers, ctx.researched)
  let split = 1
  for (const e of w.edges) {
    // M7c.9: a fluid edge is a pipe, not a belt (a pipe carries ~1000/s within the pipeline extent, M7b finding): belt
    // capacity never limits it. Seed 11 split a 54/s crude edge into ×4 clusters per attempt (2 → 1250 clusters).
    if (ctx.facts.isFluid?.(e.item) === true) continue
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
    } else if (d.action === "parallel-route" || d.action === "new-producer-cluster") {
      // M7c.9: more clusters only help an edge whose rate they split. One that did not shrink since the previous
      // attempt (cluster 1 capped by cluster1Max, a provider shared by every cluster) stays as it is.
      const prev = prevRates[e.role]
      if (prev !== undefined && e.rate >= prev - EPS) {
        overflow[e.role] = `${d.action}: more clusters do not split it (${string.format("%.4g", e.rate)}/s)`
        continue
      }
      splitRates[e.role] = e.rate
      if (d.action === "parallel-route") {
        split = math.max(split, d.routes)
        overflow[e.role] = `parallel-route × ${d.routes} (as production clusters)`
      } else {
        const usable = tier.laneCapacity * 2 * ctx.policy.utilization
        split = math.max(split, math.ceil(e.rate / usable - EPS))
        overflow[e.role] = `new-producer-cluster: ${d.reason}`
      }
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

/**
 * B189 (`m7-solar` seed 222, g191/g195/g197): the edges of a node designed once per cluster walk come out once per walk
 * too, under one role. `mergeShared` merged the nodes but the copies stayed: goal g191 asked the planner for 16
 * connections, 12 of them repeats, and each repeat of a crude line found the first copy's pipe on its port's outside
 * tile ("no pipe path", sealed start 0 tiles) on every attempt. Merge them like the nodes: the rates add up, and a
 * copy's overflow decision (a faster belt) is kept.
 */
export function mergeSharedEdges(edges: DesignEdge[]): void {
  const first: Record<string, DesignEdge> = {}
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const f = first[e.role]
    if (f === undefined) {
      first[e.role] = e
      continue
    }
    f.rate += e.rate
    f.headroomRate += e.headroomRate
    if (f.decision.action === "none" && e.decision.action !== "none") {
      f.decision = e.decision
      f.belt = e.belt
    }
    if (e.merge === true) f.merge = true
    edges.splice(i, 1)
    i--
  }
}

/** Solves and designs the factory for a stage target. */
export function design(ctx: DesignContext, target: DesignTarget): Design {
  // B194: forced solar whose buildings machines can't make yet (no batteries without crude oil) stays steam for now.
  if (ctx.solarPower === true && !solarBuildable(ctx)) {
    const steam = { ...ctx, solarPower: false }
    steam.powerCaps = ctx.steamCaps
    ctx = steam
  }
  const d = designOnce(ctx, target)
  const have: Record<string, boolean> = {}
  for (const st of target.stock ?? []) have[st.item] = true
  const extra: { item: string; perSecond: number }[] = []
  // B185 (user, 2026-11-11): a design with a solar field stocks its buildings, made by machines.
  if (d.nodes.some((n) => n.generator === "solar-field")) {
    for (const st of powerStock(ctx, (r) => ctx.enabled[r] === true)) {
      if (have[st.item]) continue
      have[st.item] = true
      extra.push(st)
    }
  }
  // B205: and every building its modules place in numbers (the generated stock); once more with those rows.
  for (const st of buildStock(ctx, d, target, have)) extra.push(st)
  return extra.length > 0 ? designOnce(ctx, { ...target, stock: [...(target.stock ?? []), ...extra] }) : d
}

function designOnce(ctx: DesignContext, target: DesignTarget): Design {
  const solveJob = solveNow(
    {
      // M7d.5: stock items are roots of the item order too (not lab packs: `targetItems` sizes the labs).
      targets: [...targetItems(target), ...(target.stock ?? [])],
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
  let prevRates: Record<string, number> = {}
  for (let attempt = 0; attempt < 4; attempt++) {
    walks = []
    electric = 0
    let split = clusters
    const splitRates: Record<string, number> = {}
    let short = false
    const builtUsed: Record<string, number> = {}
    for (let c = 1; c <= clusters; c++) walks.push(designCluster(ctx, target, order, c, clusters, builtUsed))
    // One steam block (in cluster 1) for every cluster: the other clusters mine their own fuel (their electric coal
    // drills add demand), then cluster 1's power is sized for the whole factory.
    // If even the largest steam block can't, every cluster gets its own (power#c).
    const snap = walks.map((w) => ({ nodes: [...w.nodes], edges: [...w.edges], demands: [...w.demands] }))
    const usedSnap = { ...builtUsed }
    let others = 0
    for (let c = 2; c <= clusters; c++) {
      const w = walks[c - 1]
      expandItem(w, ctx.fuel)
      for (const n of w.nodes) others += n.powerW
    }
    const probe = { short: false }
    electric = designPower(ctx, walks[0], others, clusters > 1 ? probe : undefined)
    if (ctx.powerCaps !== undefined && electric > ctx.powerCaps[0].capacity + EPS) extraSteam(ctx, walks[0], electric, ctx.powerCaps)
    let shared = clusters > 1
    if (probe.short) {
      shared = false
      electric = 0
      walks.forEach((w, i) => {
        w.nodes = snap[i].nodes
        w.edges = snap[i].edges
        w.demands = snap[i].demands
      })
      for (const [r] of pairs(builtUsed)) builtUsed[r as string] = usedSnap[r as string]
      for (const w of walks) electric += designPower(ctx, w)
    }
    for (const w of walks) {
      // A shared steam block's flows don't shrink with more clusters: they never split the target.
      split = math.max(split, clusters * checkEdges(ctx, w, overflow, shared, splitRates, prevRates))
      if (w.short) short = true
    }
    if (short && split === clusters) split = clusters + 1
    if (split <= clusters) break
    clusters = split
    prevRates = splitRates
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
  mergeSharedEdges(edges)
  supplyPass(ctx, nodes, edges)
  for (const n of nodes) stampNodeFacts(n)
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
  // M7d.5 (user, 2026-11-08): electricity is one pool. Steam blocks feed one grid, so a cluster's block is not short
  // while the installed power capacity as a whole covers the design's total need. Without this, a blocked cluster-3
  // block (9 MW built vs 15.1 MW allocated) was grown forever although the other blocks had 17 MW of spare capacity.
  let powerNeed = 0
  let powerHave = 0
  for (const n of d.nodes) if (n.kind === "power") powerNeed += n.need
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    if (n.kind === "power") powerHave += rateIn(n.capacity.outputs, "electricity")
  }
  const powerPoolShort = powerNeed > powerHave + 1e-6
  for (const n of d.nodes) {
    const have = nodeByRole(g, n.role)
    if (have === undefined) {
      missing.push(n)
      continue
    }
    // A sink (the mall) has no output rate to grow: its "need" is the utilization it was planned at (M6a.2: every
    // failing seed listed "mall short (0/0.25): cannot grow").
    if (n.kind === "sink") continue
    // One power pool: while the pool covers the total need, no individual steam block is asked to grow.
    if (n.kind === "power" && !powerPoolShort) continue
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
export type GoalKind = "power" | "labs" | "production" | "mall" | "grow" | "repair" | "temp" | "radar" | "robots"

export interface GoalSpec {
  kind: GoalKind
  /** Production goals: one per production cluster (M6: a stage split into clusters plans and builds them in turn). */
  cluster?: number
  /** M7d.5: the dependency layer of a split production goal (`raw`, `metals`, ...), for ordering and diagnostics. */
  phase?: string
  /** Internal build-order key (`power`, `labs#1`, `production#1@metals`, ...). */
  key?: string
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
/**
 * Production layers, raw first: each layer plans only its own providers, then waits for that goal to be built. Raw
 * resources and smelter metals are split by item: one plan for six coal mines plus two large ore mines was still a
 * multi-minute site search.
 *
 * B175 (user, 2026-11-09): the metals come before the oil field and its water. A pumpjack takes steel to craft, so on a
 * map with no steel yet the raw-oil goal could never finish building, and every later goal waited on it.
 *
 * B178 (user, 2026-11-10: "general rule"): the same deadlock with engine units. A long crude pipeline takes pumps, a pump
 * takes an engine unit, and the engine cell sat in a layer after the oil goal (m7-fresh6 seeds 11, 3333 and 44444). The
 * `materials` layer, before the oil field, holds every provider of a build material (`buildMaterials`) whose own
 * unbuilt inputs all come from earlier layers.
 *
 * B209 (m7-b208 seed 44444): `restore` comes first and holds only connections between two built modules. It places no
 * module and feeds machines that already stand. Last in the order, the water routes a rebuilt oil complex took with it
 * waited 80+ game-minutes behind a 12-module stock goal that kept failing, and the robot chain stood without acid.
 */
export const PRODUCTION_LAYERS = ["restore", "raw-ore", "raw-coal", "metals-iron", "metals-copper", "metals-steel", "metals-other", "materials", "raw-oil", "raw-water", "oil", "chemicals", "circuits", "parts", "robot", "other"] as const
export type ProductionLayer = typeof PRODUCTION_LAYERS[number]

/** M7d.5 (user, 2026-11-07): the layer of a production provider; smaller layers keep each plan to a handful of modules. */
export function productionLayer(n: DesignNode): ProductionLayer {
  if (n.generator === "mining-outpost") return n.item === "coal" ? "raw-coal" : "raw-ore"
  if (n.generator === "pumpjack-field") return "raw-oil"
  if (n.generator === "water-pump") return "raw-water"
  if (n.generator === "smelter-column") {
    if (n.item === "iron-plate") return "metals-iron"
    if (n.item === "copper-plate") return "metals-copper"
    if (n.item === "steel-plate") return "metals-steel"
    return "metals-other"
  }
  if (n.generator === "oil-complex") return "oil"
  if (n.generator === "chem-row" || n.generator === "fluid-chain") return "chemicals"
  if (n.generator === "circuit-block" || n.generator === "engine-cell") return "circuits"
  if (n.generator === "robot-cell") return "robot"
  if (n.generator === "assembler-row" || n.generator === "red-line") return "parts"
  return "other"
}

/**
 * B178: items the crew needs to build what `nodes` and `edges` place but cannot hand-craft (smelted, or made only in a
 * machine: steel, engine units...). Every placed entity is expanded through its hand-craftable recipes (the facts'
 * `handCategories`); an item with no recipe is a raw resource, gathered. A fluid edge may take any of `fluidParts` (pipes,
 * pipe-to-ground, pumps on a long line).
 */
export function buildMaterials(facts: ProtoFacts, nodes: DesignNode[], edges: DesignEdge[], fluidParts: string[] = []): Record<string, boolean> {
  const hand = facts.handCategories?.() ?? { crafting: true }
  const out: Record<string, boolean> = {}
  const seen: Record<string, boolean> = {}
  const visit = (item: string): void => {
    if (seen[item]) return
    seen[item] = true
    const name = facts.recipeForItem(item)
    const r = name !== undefined ? facts.recipe(name) : undefined
    if (r === undefined) return
    if (!hand[r.category] || r.ingredients.some((i) => i.fluid === true)) {
      out[item] = true
      return
    }
    for (const i of r.ingredients) visit(i.name)
  }
  const place = (entity: string): void => visit(facts.itemToPlace(entity) ?? entity)
  for (const n of nodes) for (const e of n.def.entities) place(e.name)
  for (const e of edges) {
    if (facts.isFluid?.(e.item) === true) for (const p of fluidParts) place(p)
    else place(e.belt)
  }
  return out
}

/**
 * B178: each missing node's production layer, with providers of a build material moved to `materials` when every
 * unbuilt provider feeding them is in a layer before it (an engine cell fed by steel and iron smelters; not an
 * advanced-circuit block, whose plastic comes from oil).
 */
function materialLayers(diff: DesignDiff, materials: Record<string, boolean>): Record<string, ProductionLayer> {
  const layers: Record<string, ProductionLayer> = {}
  const index: Record<string, number> = {}
  for (let i = 0; i < PRODUCTION_LAYERS.length; i++) index[PRODUCTION_LAYERS[i]] = i
  // Only production providers count: power and the mall are goals of their own, built before (power) or beside them.
  for (const n of diff.missing) if (n.kind !== "labs" && nodeServes(n) !== "power" && nodeServes(n) !== "mall") layers[n.role] = productionLayer(n)
  const cut = index["materials"]
  let moved = true
  while (moved) {
    moved = false
    for (const n of diff.missing) {
      if (layers[n.role] === undefined || !materials[n.item] || index[layers[n.role]] <= cut) continue
      let early = true
      for (const e of diff.missingEdges) if (e.to === n.role && layers[e.from] !== undefined && index[layers[e.from]] >= cut) early = false
      if (!early) continue
      layers[n.role] = "materials"
      moved = true
    }
  }
  return layers
}

export function goalsFrom(diff: DesignDiff, researched: Record<string, boolean>, waitsOnTrigger?: (this: void, tech: string) => boolean, splitProduction = false, materials: Record<string, boolean> = {}): GoalSpec[] {
  const goals: GoalSpec[] = []
  const byKind: Record<string, GoalSpec> = {}
  const goalOf: Record<string, GoalSpec> = {}
  const keys: string[] = []
  const get = (kind: GoalKind, cluster = 1, late = false, layer: ProductionLayer = "other"): GoalSpec => {
    const suffix = splitProduction && kind === "production" ? `@${layer}` : ""
    const key = (kind === "production" || kind === "labs" ? `${kind}#${cluster}` : kind) + suffix + (late ? "~trigger" : "")
    let gs = byKind[key]
    if (gs === undefined) {
      gs = { kind, nodes: [], edges: [], techs: [], key }
      if (kind === "production" || kind === "labs") gs.cluster = cluster
      if (splitProduction && kind === "production") gs.phase = layer + (late ? "~trigger" : "")
      byKind[key] = gs
      keys.push(key)
    }
    return gs
  }
  const layers = materialLayers(diff, materials)
  for (const n of diff.missing) {
    const serves = nodeServes(n)
    const kind: GoalKind = n.kind === "labs" ? "labs" : serves === "power" ? "power" : serves === "mall" ? "mall" : "production"
    // M7c: a node needing a technology that a trigger blocks (`oil-processing` fires when crude is first mined, and
    // `plastics`, `advanced-circuit`... come after it) goes in a later goal of its kind, so the rest (the pumpjack field
    // that fires the trigger) is built first instead of the whole goal waiting for a research no lab can do.
    let late = false
    // Only goals that wait for their technologies (production, mall): labs and power never did.
    if (waitsOnTrigger !== undefined && (kind === "production" || kind === "mall")) for (const t of n.def.requiresTech) if (!researched[t] && waitsOnTrigger(t)) late = true
    const gs = get(kind, n.cluster, late, kind === "production" ? (layers[n.role] ?? productionLayer(n)) : "other")
    gs.nodes.push(n)
    goalOf[n.role] = gs
    for (const t of n.def.requiresTech) if (!researched[t] && gs.techs.indexOf(t) < 0) gs.techs.push(t)
  }
  // A missing edge whose endpoints are both built already still needs a route; create its production goal before the
  // order is fixed (it would otherwise fall outside every goal). B209: in the `restore` layer, first.
  for (const e of diff.missingEdges) if (goalOf[e.from] === undefined && goalOf[e.to] === undefined) get("production", 1, false, "restore")
  // Build order: power, then each cluster's labs and production layers in turn (cluster 1 first), the mall after
  // cluster 1. An edge belongs to the later endpoint's goal in this order: a consumer's input route is planned with
  // the consumer, and a provider feeding a built consumer is planned with the provider.
  let clusters = 1
  for (const k of keys) {
    const [c] = string.match(k, "#(%d+)")
    if (c !== undefined) clusters = math.max(clusters, tonumber(c)!)
  }
  const order = ["power"]
  for (let c = 1; c <= clusters; c++) {
    order.push(`labs#${c}`)
    if (splitProduction) {
      for (const layer of PRODUCTION_LAYERS) order.push(`production#${c}@${layer}`, `production#${c}@${layer}~trigger`)
    } else {
      order.push(`production#${c}`, `production#${c}~trigger`)
    }
    if (c === 1) order.push("mall")
  }
  order.push("mall~trigger")
  const orderIndex: Record<string, number> = {}
  for (let i = 0; i < order.length; i++) orderIndex[order[i]] = i
  for (const e of diff.missingEdges) {
    const a = goalOf[e.from]
    const b = goalOf[e.to]
    let gs = a ?? b
    if (a !== undefined && b !== undefined) {
      const ai = a.key !== undefined ? (orderIndex[a.key] ?? -1) : -1
      const bi = b.key !== undefined ? (orderIndex[b.key] ?? -1) : -1
      gs = bi > ai ? b : a
    }
    gs ??= get("production", 1, false, "restore")
    gs.edges.push(e)
  }
  for (const k of order) if (byKind[k] !== undefined) goals.push(byKind[k])
  // A fallback goal created for a fully-built edge and any other key not in the fixed order still belongs at the end.
  for (const k of keys) if (byKind[k] !== undefined && goals.indexOf(byKind[k]) < 0) goals.push(byKind[k])
  for (const gr of diff.grow) goals.push({ kind: "grow", nodes: [], edges: [], growth: gr, techs: [] })
  for (const gs of goals) gs.techs.sort()
  return goals
}