// Rate engine: a module's input and output rates at full speed, computed from its entities and prototype facts
// (SPEC §5.4: rates are computed, never hand-entered). Pure: no Factorio globals.
//
// Model (deliberately simple and documented, so the validation lab can judge it):
// 1. Each machine's ideal rate: crafting speed / recipe energy (crafts/s); a drill's mining speed / mining time;
//    a lab's research speed / unit time (units/s).
// 2. Inserter limits: an inserter moves `hand × 60 × rotationSpeed × efficiency` items/s (one item per full turn;
//    efficiency is lower when picking from a belt). A machine's crafts/s is capped by the sum of its input
//    inserters over the items it needs per craft (fuel included), and by its output inserters over the items it
//    makes per craft. Labs passing packs on to other labs need capacity for the whole chain behind them.
// 3. Internal balance (`balance`): "final" machines make what leaves the module (their product has an output port
//    and they don't feed another machine directly, or they fill an output chest; labs and drills); the others make
//    intermediates. Final machines run at a common fraction t of their capacity; intermediate makers of an item
//    share its demand in proportion to their capacity. t is the largest value (≤ 1) no intermediate group exceeds
//    its capacity at. (A small LP solved exactly because the recipe graph inside a module is acyclic and linear.)
// 4. What is left over: consumption of items with an input port → inputs; production of items with an output port
//    → outputs. Burner fuel fed from a fuel port is an input; other burners go to `upkeep` (crew-fuelled).
// 5. Steam power: min(boilers, engines, pumps) in watts → output "electricity". Electric demand of the module's
//    consumers (max, without drain) → input "electricity".

import { EntityFacts, ProtoFacts } from "./facts"
import { entityRect, tileKey } from "./geometry"
import { Dir, MachineCount, ModuleEntity, ModuleRates, Port, Rate } from "./types"

/** Inserter efficiency (fraction of one item per full rotation), calibrated by the validation lab (M4 report). */
export const INSERTER_EFFICIENCY_FROM_BELT = 0.9
export const INSERTER_EFFICIENCY_FROM_MACHINE = 1

export interface RateOptions {
  /** Inserter hand size (non-bulk inserters; 1 without research). */
  hand?: number
  /** Labs: seconds per research unit and the packs it takes (one of each per unit). */
  researchUnitTime?: number
  researchPacks?: string[]
  /** Resource mined by drills that don't say (`ModuleEntity.mines`). */
  resource?: string
}

export interface RateReport {
  rates: ModuleRates
  machines: MachineCount[]
  /** Per entity index: achieved crafts (or units, items) per second. */
  activity: Record<number, number>
  /** Per entity index: ideal crafts per second (machine speed only). */
  ideal: Record<number, number>
  upkeepFuel: MachineCount[]
  warnings: string[]
}

export function rotateVec(v: { x: number; y: number }, dir: Dir | undefined): { x: number; y: number } {
  const d = dir ?? 0
  if (d === 4) return { x: -v.y, y: v.x }
  if (d === 8) return { x: -v.x, y: -v.y }
  if (d === 12) return { x: v.y, y: -v.x }
  return { x: v.x, y: v.y }
}

const BELT_TYPES: Record<string, boolean> = { "transport-belt": true, "underground-belt": true, splitter: true }
const CRAFTER_TYPES: Record<string, boolean> = { "assembling-machine": true, furnace: true }

type NodeKind = "crafter" | "drill" | "lab"

interface Node {
  index: number
  kind: NodeKind
  ideal: number
  ins: Record<string, number>
  outs: Record<string, number>
  /** Fuel items per craft (burners fed by inserters). */
  fuelPerCraft: number
  rate: number
  inCap: number
  outCap: number
  hasOutInserter: boolean
  /** Labs fed by this lab through inserters. */
  feeds: number[]
  /** Output inserters drop into another machine (direct insertion) / into a chest. */
  toMachine: boolean
  toChest: boolean
  /** M7b: ingredients and products that are fluids (piped: no inserter carries them). */
  fluids: Record<string, boolean>
}

/** The amounts of `map` that are not fluids. */
function solidSum(map: Record<string, number>, fluids: Record<string, boolean>): number {
  let s = 0
  for (const [k, v] of pairs(map)) if (!fluids[k as string]) s += v
  return s
}

function addTo(map: Record<string, number>, key: string, v: number): void {
  map[key] = (map[key] ?? 0) + v
}

function sumValues(map: Record<string, number>): number {
  let s = 0
  for (const [, v] of pairs(map)) s += v
  return s
}

export function inserterCapacity(f: EntityFacts, hand: number, fromBelt: boolean): number {
  const eff = fromBelt ? INSERTER_EFFICIENCY_FROM_BELT : INSERTER_EFFICIENCY_FROM_MACHINE
  return hand * 60 * (f.rotationSpeed ?? 0) * eff
}

function sortedRates(map: Record<string, number>, kindOf: (item: string) => Rate["kind"]): Rate[] {
  const out: Rate[] = []
  for (const [item, v] of pairs(map)) if (v > 1e-9) out.push({ item, perSecond: v, kind: kindOf(item) })
  out.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
  return out
}

/** What the passes of `computeRates` share. */
interface RateCtx {
  entities: ModuleEntity[]
  facts: ProtoFacts
  opts: RateOptions
  warnings: string[]
  /** Items entering by an input port, leaving by an output port, and leaving on a belt or pipe. */
  inPortItems: Record<string, boolean>
  outPortItems: Record<string, boolean>
  /** Output items leaving on belts: their makers are final unless they feed another machine directly. */
  beltOutItems: Record<string, boolean>
  fuelItem?: string
  nodes: Record<number, Node>
  fluidItems: Record<string, boolean>
  machineCounts: Record<string, number>
  upkeep: Record<string, number>
  /** The steam plant's parts (one prototype each: the last seen counts) and the module's electric demand. */
  boilers: number
  boilerPower: number
  engines: number
  enginePower: number
  engineSteamPerJ: number
  pumps: number
  pumpPerTick: number
  electricDemand: number
  /** Inserter throughput into boilers (fuel). */
  boilerFeedCap: number
}

function newRateCtx(entities: ModuleEntity[], ports: Port[], facts: ProtoFacts, opts: RateOptions): RateCtx {
  const ctx: RateCtx = {
    entities, facts, opts, warnings: [], inPortItems: {}, outPortItems: {}, beltOutItems: {}, nodes: {}, fluidItems: {}, machineCounts: {}, upkeep: {},
    boilers: 0, boilerPower: 0, engines: 0, enginePower: 0, engineSteamPerJ: 0, pumps: 0, pumpPerTick: 0, electricDemand: 0, boilerFeedCap: 0,
  }
  for (const p of ports) {
    if (p.item === undefined) continue
    if (p.kind === "belt-in" || p.kind === "pipe-in" || p.kind === "chest-in") ctx.inPortItems[p.item] = true
    if (p.kind === "belt-out" || p.kind === "pipe-out" || p.kind === "chest-out") ctx.outPortItems[p.item] = true
    if (p.kind === "belt-out" || p.kind === "pipe-out") ctx.beltOutItems[p.item] = true
  }
  for (const [item] of pairs(ctx.inPortItems)) if (facts.fuelValue(item) > 0) ctx.fuelItem = item
  return ctx
}

/** Counts a steam plant part (boiler, engine, offshore pump); false if `f` is none. */
function addPlantPart(ctx: RateCtx, name: string, f: EntityFacts): boolean {
  if (f.type === "boiler") {
    ctx.boilers++
    ctx.boilerPower = f.energyPerTick ?? 0
  } else if (f.type === "generator") {
    ctx.engines++
    ctx.enginePower = f.maxPowerPerTick ?? 0
    ctx.engineSteamPerJ = (f.fluidPerTick ?? 0) / Math.max(1, ctx.enginePower)
  } else if (f.type === "offshore-pump") {
    ctx.pumps++
    ctx.pumpPerTick = f.pumpingPerTick ?? 0
  } else return false
  addTo(ctx.machineCounts, name, 1)
  return true
}

function crafterNode(ctx: RateCtx, i: number, e: ModuleEntity, f: EntityFacts): Node | undefined {
  if (e.recipe === undefined) {
    ctx.warnings.push(`${e.name}@${e.x},${e.y} has no recipe`)
    return undefined
  }
  const r = ctx.facts.recipe(e.recipe)
  if (!r) {
    ctx.warnings.push(`unknown recipe ${e.recipe}`)
    return undefined
  }
  const node: Node = newNode(i, "crafter", (f.craftingSpeed ?? 1) / r.energy)
  for (const ing of r.ingredients) {
    addTo(node.ins, ing.name, ing.amount)
    if (ing.fluid === true) node.fluids[ing.name] = ctx.fluidItems[ing.name] = true
  }
  for (const p of r.products) {
    addTo(node.outs, p.name, p.amount)
    if (p.fluid === true) node.fluids[p.name] = ctx.fluidItems[p.name] = true
  }
  if (f.burner) {
    const perSecond = ((f.energyPerTick ?? 0) * 60) / Math.max(1, ctx.facts.fuelValue(ctx.fuelItem ?? "coal"))
    node.fuelPerCraft = perSecond / node.ideal
    if (ctx.fuelItem === undefined) addTo(ctx.upkeep, e.name, 1)
  }
  return node
}

function drillNode(ctx: RateCtx, i: number, e: ModuleEntity, f: EntityFacts): Node | undefined {
  const resource = e.mines ?? ctx.opts.resource
  const time = resource !== undefined ? ctx.facts.resourceMiningTime(resource) : undefined
  const product = resource !== undefined ? ctx.facts.resourceProduct(resource) : undefined
  if (time === undefined || product === undefined) {
    ctx.warnings.push(`drill ${e.name}@${e.x},${e.y}: unknown resource ${tostring(resource)}`)
    return undefined
  }
  const node = newNode(i, "drill", e.perSecond ?? (f.miningSpeed ?? 0) / time)
  node.outs[product] = 1
  if (e.perSecond !== undefined) node.fluids[product] = ctx.fluidItems[product] = true
  if (f.burner) addTo(ctx.upkeep, e.name, 1)
  return node
}

function labNode(ctx: RateCtx, i: number, f: EntityFacts): Node {
  const node = newNode(i, "lab", (f.researchSpeed ?? 1) / (ctx.opts.researchUnitTime ?? 30))
  for (const pack of ctx.opts.researchPacks ?? []) node.ins[pack] = 1
  node.outs["research-unit"] = 1
  return node
}

/** Step 1: a node per machine (crafter, drill, lab), the steam plant's parts and the electric demand. */
function addNodes(ctx: RateCtx): void {
  for (let i = 0; i < ctx.entities.length; i++) {
    const e = ctx.entities[i]
    const f = ctx.facts.entity(e.name)
    if (!f) {
      ctx.warnings.push(`unknown entity ${e.name}`)
      continue
    }
    if (f.electric && f.energyPerTick) ctx.electricDemand += f.energyPerTick * 60
    if (CRAFTER_TYPES[f.type] || f.type === "mining-drill" || f.type === "lab") addTo(ctx.machineCounts, e.name, 1)
    if (addPlantPart(ctx, e.name, f)) continue
    let node: Node | undefined
    if (CRAFTER_TYPES[f.type]) node = crafterNode(ctx, i, e, f)
    else if (f.type === "mining-drill") node = drillNode(ctx, i, e, f)
    else if (f.type === "lab") node = labNode(ctx, i, f)
    if (node !== undefined) ctx.nodes[i] = node
  }
}

/** Step 2: each inserter's capacity into the machine it drops into and out of the one it picks from. */
function linkInserters(ctx: RateCtx, hand: number): void {
  const { entities, facts, nodes } = ctx
  const occ: Record<string, number> = {}
  for (let i = 0; i < entities.length; i++) {
    const r = entityRect(entities[i], facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) occ[tileKey(x, y)] = i
  }
  const at = (p: { x: number; y: number }): number | undefined => occ[tileKey(Math.floor(p.x), Math.floor(p.y))]
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    const f = facts.entity(e.name)
    if (!f || f.type !== "inserter") continue
    const pv = rotateVec(f.pickupVector ?? { x: 0, y: -1 }, e.dir)
    const dv = rotateVec(f.dropVectorIns ?? { x: 0, y: 1.2 }, e.dir)
    const from = at({ x: e.x + pv.x, y: e.y + pv.y })
    const to = at({ x: e.x + dv.x, y: e.y + dv.y })
    const fromName = from !== undefined ? entities[from].name : undefined
    const fromFacts = fromName !== undefined ? facts.entity(fromName) : undefined
    const fromBelt = fromFacts !== undefined && BELT_TYPES[fromFacts.type] === true
    const cap = inserterCapacity(f, hand, fromBelt)
    const target = to !== undefined ? facts.entity(entities[to].name) : undefined
    // A burner inserter refuels from the fuel it carries: self-sufficient when it feeds a burner from a fuel belt.
    if (f.burner && (ctx.fuelItem === undefined || !fromBelt || target === undefined || target.burner !== true)) addTo(ctx.upkeep, e.name, 1)
    if (to !== undefined && nodes[to] !== undefined) nodes[to].inCap += cap
    if (target?.type === "boiler") ctx.boilerFeedCap += cap
    if (from === undefined || nodes[from] === undefined) continue
    const n = nodes[from]
    n.outCap += cap
    n.hasOutInserter = true
    if (to === undefined) continue
    if (n.kind === "lab" && nodes[to]?.kind === "lab") n.feeds.push(to)
    if (nodes[to] !== undefined) n.toMachine = true
    if (target?.type === "container") n.toChest = true
  }
}

/** Step 3a: a crafter runs no faster than its inserters carry its solid ingredients (and fuel) and products. */
function capCrafter(ctx: RateCtx, i: number, n: Node): number {
  const e = ctx.entities[i]
  let r = n.ideal
  // M7b: fluids come and go by pipe; inserters carry only the items.
  const perIn = solidSum(n.ins, n.fluids) + n.fuelPerCraft
  if (perIn > 0) r = Math.min(r, n.inCap / perIn)
  const perOut = solidSum(n.outs, n.fluids)
  // Only fluids out: no output inserter.
  if (perOut !== 0 && !n.hasOutInserter) {
    ctx.warnings.push(`${e.name}@${e.x},${e.y} has no output inserter`)
    r = 0
  } else if (perOut > 0) r = Math.min(r, n.outCap / perOut)
  if (n.inCap === 0 && perIn > 0) ctx.warnings.push(`${e.name}@${e.x},${e.y} has no input inserter`)
  return r
}

/** Step 3b: a lab's input inserters also carry the packs for the labs it feeds; scale the chain when they can't. */
function capLabs(nodes: Record<number, Node>, order: number[]): void {
  const labDemand = (i: number, depth: number): number => {
    const n = nodes[i]
    let d = n.rate * sumValues(n.ins)
    if (depth < 64) for (const j of n.feeds) d += labDemand(j, depth + 1)
    return d
  }
  for (const i of order) {
    const n = nodes[i]
    if (n.kind !== "lab") continue
    const need = labDemand(i, 0)
    if (need <= n.inCap + 1e-9 || need <= 0) continue
    const s = n.inCap / need
    const scale = (j: number, depth: number): void => {
      nodes[j].rate *= s
      if (depth < 64) for (const k of nodes[j].feeds) scale(k, depth + 1)
    }
    scale(i, 0)
  }
}

/** Step 5: the module's net item inputs and outputs (fuel included) from the balanced machine rates. */
function netRates(ctx: RateCtx, order: number[]): { inputs: Record<string, number>; outputs: Record<string, number>; activity: Record<number, number>; ideal: Record<number, number> } {
  const inputs: Record<string, number> = {}
  const outputs: Record<string, number> = {}
  const prod: Record<string, number> = {}
  const cons: Record<string, number> = {}
  const activity: Record<number, number> = {}
  const ideal: Record<number, number> = {}
  let fuel = 0
  for (const i of order) {
    const n = ctx.nodes[i]
    activity[i] = n.rate
    ideal[i] = n.ideal
    for (const [item, a] of pairs(n.outs)) addTo(prod, item, a * n.rate)
    for (const [item, a] of pairs(n.ins)) addTo(cons, item, a * n.rate)
    fuel += n.fuelPerCraft * n.rate
  }
  for (const [item, c] of pairs(cons)) {
    const p = prod[item] ?? 0
    if (c <= p + 1e-9) continue
    if (!ctx.inPortItems[item]) ctx.warnings.push(`${item} is needed but has no input port`)
    inputs[item] = c - p
  }
  for (const [item, p] of pairs(prod)) {
    const c = cons[item] ?? 0
    if (p > c + 1e-9 && (ctx.outPortItems[item] || item === "research-unit")) outputs[item] = p - c
  }
  if (ctx.fuelItem !== undefined && fuel > 0) addTo(inputs, ctx.fuelItem, fuel)
  return { inputs, outputs, activity, ideal }
}

/** Step 6: a steam plant's electricity (and its coal), an offshore pump's water, and the module's electric demand. */
function plantRates(ctx: RateCtx, inputs: Record<string, number>, outputs: Record<string, number>): void {
  if (ctx.boilers > 0 || ctx.engines > 0) {
    let power = Math.min(ctx.boilers * ctx.boilerPower, ctx.engines * ctx.enginePower) // J/tick
    if (ctx.engineSteamPerJ > 0) power = Math.min(power, (ctx.pumps * ctx.pumpPerTick) / ctx.engineSteamPerJ)
    if (power > 0) {
      outputs["electricity"] = power * 60
      const coal = (power * 60) / Math.max(1, ctx.facts.fuelValue(ctx.fuelItem ?? "coal"))
      if (ctx.fuelItem !== undefined) {
        addTo(inputs, ctx.fuelItem, coal)
        if (ctx.boilerFeedCap < coal - 1e-9) ctx.warnings.push(`boiler fuel inserters move ${ctx.boilerFeedCap}/s, need ${coal}/s`)
      }
    }
    if (ctx.fuelItem === undefined && ctx.boilers > 0) ctx.upkeep["boiler"] = ctx.boilers
  }
  // M7b: offshore pumps that feed a water port (not boilers) put their water out.
  if (ctx.pumps > 0 && ctx.boilers === 0 && ctx.outPortItems["water"]) {
    outputs["water"] = ctx.pumps * ctx.pumpPerTick * 60
    ctx.fluidItems["water"] = true
  }
  if (ctx.electricDemand > 0) inputs["electricity"] = ctx.electricDemand
}

function sortedCounts(map: Record<string, number>): MachineCount[] {
  const out: MachineCount[] = []
  for (const [name, count] of pairs(map)) out.push({ name, count })
  out.sort((a, b) => (a.name < b.name ? -1 : 1))
  return out
}

export function computeRates(entities: ModuleEntity[], ports: Port[], facts: ProtoFacts, opts: RateOptions = {}): RateReport {
  const ctx = newRateCtx(entities, ports, facts, opts)
  addNodes(ctx)
  linkInserters(ctx, opts.hand ?? 1)
  const order: number[] = []
  for (const [i] of pairs(ctx.nodes)) order.push(i)
  order.sort((a, b) => a - b)
  for (const i of order) {
    const n = ctx.nodes[i]
    n.rate = n.kind === "crafter" ? capCrafter(ctx, i, n) : n.ideal
  }
  capLabs(ctx.nodes, order)
  // Step 4: internal balance (see the header, step 3).
  balance(ctx.nodes, order, ctx.inPortItems, ctx.beltOutItems, ctx.warnings)
  const net = netRates(ctx, order)
  plantRates(ctx, net.inputs, net.outputs)
  const kindOf = (item: string): Rate["kind"] => (item === "electricity" ? "power" : item === "research-unit" ? "research" : ctx.fluidItems[item] ? "fluid" : "item")
  return { rates: { inputs: sortedRates(net.inputs, kindOf), outputs: sortedRates(net.outputs, kindOf) }, machines: sortedCounts(ctx.machineCounts), activity: net.activity, ideal: net.ideal, upkeepFuel: sortedCounts(ctx.upkeep), warnings: ctx.warnings }
}
function mainOut(n: Node): string | undefined {
  for (const [item] of pairs(n.outs)) return item
  return undefined
}

/**
 * Sets every node's rate (see the header, step 3). Nodes come in with their capacity (inserter-capped) as `rate`.
 * Items with an input port are raw: never constrained here.
 */
function balance(nodes: Record<number, Node>, order: number[], inPort: Record<string, boolean>, outPort: Record<string, boolean>, warnings: string[]): void {
  const cap: Record<number, number> = {}
  const isFinal: Record<number, boolean> = {}
  const consumers: Record<string, number[]> = {}
  const inter: Record<string, number[]> = {}
  const hybrid: Record<string, number[]> = {}
  for (const i of order) {
    const n = nodes[i]
    cap[i] = n.rate
    const item = mainOut(n)
    isFinal[i] = n.kind !== "crafter" || n.toChest || (item !== undefined && outPort[item] === true && !n.toMachine)
    for (const [ing] of pairs(n.ins)) (consumers[ing] ??= []).push(i)
  }
  for (const i of order) {
    const item = mainOut(nodes[i])
    if (item === undefined) continue
    if (!isFinal[i]) (inter[item] ??= []).push(i)
    else if (nodes[i].toMachine) (hybrid[item] ??= []).push(i)
  }
  // Items only final machines make, passing some on by direct insertion (a mall's belt assembler feeding the
  // splitter assembler): the machines they feed get at most what those makers produce.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const [item, makers] of pairs(hybrid)) {
      if (inter[item] !== undefined || inPort[item]) continue
      let h = 0
      for (const m of makers) h += cap[m] * (nodes[m].outs[item] ?? 0)
      let d = 0
      for (const c of consumers[item] ?? []) d += cap[c] * (nodes[c].ins[item] ?? 0)
      if (d > h + 1e-12) {
        for (const c of consumers[item] ?? []) cap[c] *= h / d
        changed = true
      }
    }
    if (!changed) break
  }
  // Demand at t = 1 for each internal item, and the utilisation of its intermediate makers.
  const util: Record<string, number> = {}
  const visiting: Record<string, boolean> = {}
  const required = (i: number): number => {
    if (isFinal[i]) return cap[i]
    const item = mainOut(nodes[i])
    return item === undefined ? 0 : cap[i] * utilisation(item)
  }
  const supply = (list: number[] | undefined, item: string): number => {
    let s = 0
    for (const p of list ?? []) s += cap[p] * (nodes[p].outs[item] ?? 0)
    return s
  }
  const demand = (item: string): number => {
    let d = 0
    for (const c of consumers[item] ?? []) d += required(c) * (nodes[c].ins[item] ?? 0)
    return d
  }
  function utilisation(item: string): number {
    const known = util[item]
    if (known !== undefined) return known
    if (visiting[item]) {
      warnings.push(`cycle through ${item}`)
      return 0
    }
    visiting[item] = true
    const residual = demand(item) - supply(hybrid[item], item)
    const capacity = supply(inter[item], item)
    const u = residual <= 0 ? 0 : capacity > 0 ? residual / capacity : 0
    if (capacity === 0 && !outPort[item] && consumers[item] === undefined) warnings.push(`${item} is made but neither used nor output`)
    visiting[item] = false
    util[item] = u
    return u
  }
  let t = 1
  const items: string[] = []
  for (const [item] of pairs(consumers)) items.push(item)
  items.sort()
  for (const item of items) {
    if (inPort[item]) continue
    const d = demand(item)
    const h = supply(hybrid[item], item)
    const c = supply(inter[item], item)
    if (d <= h + 1e-12) continue
    if (c === 0) {
      if (hybrid[item] === undefined) {
        warnings.push(`${item} is needed but has no input port`)
        t = 0
      }
      continue
    }
    t = Math.min(t, c / (d - h))
  }
  for (const i of order) {
    if (isFinal[i]) nodes[i].rate = t * cap[i]
    else {
      const item = mainOut(nodes[i])
      nodes[i].rate = item === undefined ? 0 : t * cap[i] * utilisation(item)
    }
  }
}

function newNode(index: number, kind: NodeKind, ideal: number): Node {
  return { index, kind, ideal, ins: {}, outs: {}, fuelPerCraft: 0, rate: ideal, inCap: 0, outCap: 0, hasOutInserter: false, feeds: [], toMachine: false, toChest: false, fluids: {} }
}

/** The rate of `item` in a rate list (0 if absent). */
export function rateOf(list: Rate[], item: string): number {
  for (const r of list) if (r.item === item) return r.perSecond
  return 0
}
