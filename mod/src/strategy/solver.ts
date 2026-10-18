// Factory Graph solver (SPEC §5.8, D21): from target rates (items/s) and the available recipes, machines and
// resources, compute per-recipe machine counts and item rates down to raw resources, plus the fuel and electricity
// the machines draw and the boilers, engines and mining drills that supply them. Everything comes from prototype
// facts (`ProtoFacts`), never from vanilla tables.
//
// v1 is a recursive **ratio solver**: the red/green chain is a DAG with one recipe per item and no byproducts, so
// demand propagates from the targets down the recipe graph in topological order (each item is expanded once, after
// every consumer added its demand). It sits behind the `Solver` interface so an LP solver can replace it later (P3:
// oil, byproducts, cycles). Like all heavy work it is a resumable state machine (§5.6): `stepSolve` does at most
// `budget` work units per call. Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"

export interface SolveTarget {
  item: string
  /** Items per second. */
  perSecond: number
}

export interface SolveProblem {
  targets: SolveTarget[]
  /** Crafting machines the faction may build, in preference order: the first whose categories include a recipe's wins. */
  machines: string[]
  /** Mining drills in preference order (the first is used for every resource). */
  drills: string[]
  /** Resource entities known on the map: an item one of them yields is raw (mined). */
  resources: string[]
  /** Items not expanded even if a recipe makes them (supplied from outside: crew, another plan). */
  raw?: string[]
  /** The fuel burners and boilers burn (coal). Absent: fuel is not accounted. */
  fuel?: string
  /** Steam power: the boiler and the engine it feeds. Absent: electricity is reported but no boilers. */
  boiler?: string
  engine?: string
  /** Recipes that are unlocked; others are still used for planning but reported in `locked`. Absent: all. */
  enabled?: Record<string, boolean>
}

export interface RecipeLine {
  recipe: string
  /** The product this line exists for. */
  item: string
  /** Crafts per second. */
  crafts: number
  machine: string
  /** Fractional machine count at full speed (ceil it to build). */
  machines: number
  category: string
  /** Electric draw (W) or fuel burnt (items/s) of these machines at the computed load. */
  powerW: number
  fuelPerSecond: number
}

export interface MiningLine {
  resource: string
  item: string
  perSecond: number
  drill: string
  drills: number
  powerW: number
  fuelPerSecond: number
}

export interface ItemFlow {
  produced: number
  consumed: number
}

export interface SolveResult {
  lines: RecipeLine[]
  mining: MiningLine[]
  /** Every item's rates (targets count as consumed). */
  items: Record<string, ItemFlow>
  /** Raw items/s needed (mined or supplied from outside), fuel included. */
  raw: Record<string, number>
  /** Total electric demand of machines and electric drills (W). */
  electricW: number
  /** Fuel burnt by burner machines and burner drills (items/s), excluding boilers. */
  burnerFuel: number
  /** Steam supply sized to `electricW`: boilers and engines (fractional) and their fuel (items/s). */
  boilers: number
  engines: number
  boilerFuel: number
  /** Recipes used that are not enabled, with the technology unlocking them (if known). */
  locked: { recipe: string; tech?: string }[]
  /** Items that could not be expanded (no recipe, no resource, no machine). */
  errors: string[]
}

export interface SolveJob {
  problem: SolveProblem
  phase: "order" | "expand" | "energy" | "done" | "failed"
  /** Items, consumers before their ingredients. */
  order: string[]
  idx: number
  demand: Record<string, number>
  result: SolveResult
  /** Fuel and power fixed point iterations done. */
  iterations: number
  work: number
  reason?: string
}

/** The solver interface (D21): start a job, step it under a budget until it is done or failed. */
export interface Solver {
  id: string
  start(this: void, problem: SolveProblem, facts: ProtoFacts): SolveJob
  /** Advances the job by about `budget` work units. Returns true when it has finished. */
  step(this: void, job: SolveJob, facts: ProtoFacts, budget: number): boolean
}

const EPS = 1e-12
const MAX_ITERATIONS = 20

function emptyResult(): SolveResult {
  return { lines: [], mining: [], items: {}, raw: {}, electricW: 0, burnerFuel: 0, boilers: 0, engines: 0, boilerFuel: 0, locked: [], errors: [] }
}

function flow(r: SolveResult, item: string): ItemFlow {
  let f = r.items[item]
  if (f === undefined) {
    f = { produced: 0, consumed: 0 }
    r.items[item] = f
  }
  return f
}

/** The resource (of the problem's) yielding `item`, if any. */
function resourceFor(p: SolveProblem, facts: ProtoFacts, item: string): string | undefined {
  for (const res of p.resources) if (facts.resourceProduct(res) === item) return res
  return undefined
}

function isRaw(p: SolveProblem, facts: ProtoFacts, item: string): boolean {
  if (p.raw !== undefined && p.raw.indexOf(item) >= 0) return true
  if (resourceFor(p, facts, item) !== undefined) return true
  return facts.recipeForItem(item) === undefined
}

/** The machine (first in preference order) that can craft a category. */
export function machineFor(p: SolveProblem, facts: ProtoFacts, category: string): string | undefined {
  for (const m of p.machines) {
    const f = facts.entity(m)
    if (f?.craftingCategories !== undefined && f.craftingCategories.indexOf(category) >= 0) return m
  }
  return undefined
}

function productAmount(facts: ProtoFacts, recipe: string, item: string): number {
  const r = facts.recipe(recipe)
  if (r === undefined) return 1
  for (const pr of r.products) if (pr.name === item) return pr.amount
  return 1
}

/** Watts a machine draws at full speed (J/tick × 60). */
function drawW(facts: ProtoFacts, entity: string): number {
  return (facts.entity(entity)?.energyPerTick ?? 0) * 60
}

/** Consumers-first order of every item reachable from the targets (DFS post-order, reversed). */
function topoOrder(p: SolveProblem, facts: ProtoFacts): { order: string[]; cycle?: string } {
  const state: Record<string, number> = {} // 1 visiting, 2 done
  const post: string[] = []
  let cycle: string | undefined
  const visit = (item: string): void => {
    if (state[item] === 2 || cycle !== undefined) return
    if (state[item] === 1) {
      cycle = item
      return
    }
    state[item] = 1
    if (!isRaw(p, facts, item)) {
      const r = facts.recipe(facts.recipeForItem(item)!)
      if (r !== undefined) for (const ing of r.ingredients) visit(ing.name)
    }
    state[item] = 2
    post.push(item)
  }
  const roots = p.targets.map((t) => t.item)
  if (p.fuel !== undefined) roots.push(p.fuel)
  for (const item of roots) visit(item)
  const order: string[] = []
  for (let i = post.length - 1; i >= 0; i--) order.push(post[i])
  return { order, cycle }
}

function startJob(this: void, problem: SolveProblem, facts: ProtoFacts): SolveJob {
  void facts
  const demand: Record<string, number> = {}
  for (const t of problem.targets) demand[t.item] = (demand[t.item] ?? 0) + t.perSecond
  return { problem, phase: "order", order: [], idx: 0, demand, result: emptyResult(), iterations: 0, work: 0 }
}

/** Expands one item: a recipe line (and its ingredients' demand) or a raw entry. */
function expandItem(job: SolveJob, facts: ProtoFacts, item: string): void {
  const p = job.problem
  const r = job.result
  const need = job.demand[item] ?? 0
  if (need <= EPS) return
  flow(r, item)
  if (isRaw(p, facts, item)) {
    r.raw[item] = (r.raw[item] ?? 0) + need
    return
  }
  const recipeName = facts.recipeForItem(item)!
  const recipe = facts.recipe(recipeName)
  if (recipe === undefined) {
    r.errors.push(`${item}: unknown recipe ${recipeName}`)
    return
  }
  const machine = machineFor(p, facts, recipe.category)
  if (machine === undefined) {
    r.errors.push(`${item}: no machine for category ${recipe.category}`)
    return
  }
  if (p.enabled !== undefined && !p.enabled[recipeName]) {
    let listed = false
    for (const l of r.locked) if (l.recipe === recipeName) listed = true
    if (!listed) r.locked.push({ recipe: recipeName, tech: facts.unlockedBy(recipeName) })
  }
  const crafts = need / productAmount(facts, recipeName, item)
  const mf = facts.entity(machine)!
  const machines = (crafts * recipe.energy) / (mf.craftingSpeed ?? 1)
  r.lines.push({ recipe: recipeName, item, crafts, machine, machines, category: recipe.category, powerW: 0, fuelPerSecond: 0 })
  for (const pr of recipe.products) flow(r, pr.name).produced += crafts * pr.amount
  for (const ing of recipe.ingredients) {
    job.demand[ing.name] = (job.demand[ing.name] ?? 0) + crafts * ing.amount
    flow(r, ing.name).consumed += crafts * ing.amount
  }
}

/**
 * Mining, fuel and power: a fixed point, since electric coal drills need power whose boilers burn coal. Each
 * iteration recomputes mining for every raw resource item from the item demand plus the current fuel estimate.
 */
function energyIteration(job: SolveJob, facts: ProtoFacts): boolean {
  const p = job.problem
  const r = job.result
  const fuelValue = p.fuel !== undefined ? facts.fuelValue(p.fuel) : 0
  // Machines.
  let electric = 0
  let burner = 0
  for (const l of r.lines) {
    const f = facts.entity(l.machine)
    const w = l.machines * drawW(facts, l.machine)
    l.powerW = f?.electric ? w : 0
    l.fuelPerSecond = f?.burner && fuelValue > 0 ? w / fuelValue : 0
    if (f?.electric) electric += w
    if (f?.burner) burner += w
  }
  const machineElectric = electric
  const machineBurner = burner
  // Mining: raw demand of resource items, plus fuel (burners and boilers, from the last iteration).
  const prevFuel = r.burnerFuel + r.boilerFuel
  const mining: MiningLine[] = []
  const drill = p.drills[0]
  const df = drill !== undefined ? facts.entity(drill) : undefined
  const rawItems: string[] = []
  for (const [item] of pairs(r.raw)) rawItems.push(item as string)
  if (p.fuel !== undefined && r.raw[p.fuel] === undefined && prevFuel > EPS) rawItems.push(p.fuel)
  rawItems.sort()
  let drillElectric = 0
  let drillBurner = 0
  for (const item of rawItems) {
    const res = resourceFor(p, facts, item)
    if (res === undefined || df === undefined) continue
    const perSecond = (r.raw[item] ?? 0) + (item === p.fuel ? prevFuel : 0)
    const perDrill = (df.miningSpeed ?? 0.5) / (facts.resourceMiningTime(res) ?? 1)
    const drills = perSecond / perDrill
    const w = drills * drawW(facts, drill!)
    const line: MiningLine = { resource: res, item, perSecond, drill: drill!, drills, powerW: df.electric ? w : 0, fuelPerSecond: df.burner && fuelValue > 0 ? w / fuelValue : 0 }
    if (df.electric) drillElectric += w
    if (df.burner) drillBurner += w
    mining.push(line)
  }
  electric = machineElectric + drillElectric
  burner = machineBurner + drillBurner
  const burnerFuel = fuelValue > 0 ? burner / fuelValue : 0
  let boilers = 0
  let engines = 0
  let boilerFuel = 0
  if (p.boiler !== undefined) {
    const bw = drawW(facts, p.boiler)
    boilers = bw > 0 ? electric / bw : 0
    // A boiler turns fuel into steam at its rated power (efficiency 1 in vanilla 2.0).
    boilerFuel = fuelValue > 0 ? electric / fuelValue : 0
  }
  if (p.engine !== undefined) {
    const ew = (facts.entity(p.engine)?.maxPowerPerTick ?? 0) * 60
    engines = ew > 0 ? electric / ew : 0
  }
  const changed = math.abs(burnerFuel + boilerFuel - prevFuel) > 1e-9 || math.abs(electric - r.electricW) > 1e-6
  r.mining = mining
  r.electricW = electric
  r.burnerFuel = burnerFuel
  r.boilers = boilers
  r.engines = engines
  r.boilerFuel = boilerFuel
  return changed
}

function stepJob(this: void, job: SolveJob, facts: ProtoFacts, budget: number): boolean {
  let used = 0
  while (used < budget && job.phase !== "done" && job.phase !== "failed") {
    if (job.phase === "order") {
      const t = topoOrder(job.problem, facts)
      if (t.cycle !== undefined) {
        job.phase = "failed"
        job.reason = `recipe cycle through ${t.cycle} (the ratio solver handles DAGs only)`
        break
      }
      job.order = t.order
      job.phase = "expand"
      used += t.order.length
    } else if (job.phase === "expand") {
      if (job.idx >= job.order.length) {
        job.phase = "energy"
        continue
      }
      expandItem(job, facts, job.order[job.idx++])
      used++
    } else {
      job.iterations++
      used += 1 + job.result.lines.length
      if (!energyIteration(job, facts) || job.iterations >= MAX_ITERATIONS) {
        const r = job.result
        // Raw totals include fuel.
        if (job.problem.fuel !== undefined) {
          const fuel = r.burnerFuel + r.boilerFuel
          if (fuel > EPS) r.raw[job.problem.fuel] = (job.demand[job.problem.fuel] ?? 0) + fuel
        }
        for (const t of job.problem.targets) flow(r, t.item).consumed += t.perSecond
        job.phase = "done"
      }
    }
  }
  job.work += used
  return job.phase === "done" || job.phase === "failed"
}

/** The v1 recursive ratio solver. */
export const RatioSolver: Solver = { id: "ratio", start: startJob, step: stepJob }

/** Solves synchronously (tests, small problems). */
export function solveNow(problem: SolveProblem, facts: ProtoFacts, solver: Solver = RatioSolver): SolveJob {
  const job = solver.start(problem, facts)
  while (!solver.step(job, facts, 1000)) {
    // budgeted steps
  }
  return job
}

/** The recipe line making `item`, if any. */
export function lineFor(r: SolveResult, item: string): RecipeLine | undefined {
  for (const l of r.lines) if (l.item === item) return l
  return undefined
}

export function miningFor(r: SolveResult, item: string): MiningLine | undefined {
  for (const m of r.mining) if (m.item === item) return m
  return undefined
}
