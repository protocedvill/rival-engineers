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
// 3. Internal balance: an item both made and used inside the module is internal. If the makers fall short, users
//    slow down proportionally; if nothing takes the surplus out (no output port), makers slow down.
//    Iterated to a fixed point (modules are acyclic).
// 4. What is left over: consumption of items with an input port → inputs; production of items with an output port
//    → outputs. Burner fuel fed from a fuel port is an input; other burners go to `upkeep` (crew-fuelled).
// 5. Steam power: min(boilers, engines, pumps) in watts → output "electricity". Electric demand of the module's
//    consumers (max, without drain) → input "electricity".

import { EntityFacts, ProtoFacts } from "./facts"
import { entityRect, tileKey } from "./geometry"
import { Dir, MachineCount, ModuleEntity, ModuleRates, Port, Rate } from "./types"

/** Inserter efficiency (fraction of one item per full rotation), calibrated by the validation lab (M4 report). */
export const INSERTER_EFFICIENCY_FROM_BELT = 0.85
export const INSERTER_EFFICIENCY_FROM_MACHINE = 0.95

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

export function computeRates(entities: ModuleEntity[], ports: Port[], facts: ProtoFacts, opts: RateOptions = {}): RateReport {
  const hand = opts.hand ?? 1
  const warnings: string[] = []
  const occ: Record<string, number> = {}
  for (let i = 0; i < entities.length; i++) {
    const r = entityRect(entities[i], facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) occ[tileKey(x, y)] = i
  }
  const at = (p: { x: number; y: number }): number | undefined => occ[tileKey(Math.floor(p.x), Math.floor(p.y))]

  const inPortItems: Record<string, boolean> = {}
  const outPortItems: Record<string, boolean> = {}
  for (const p of ports) {
    if (p.item === undefined) continue
    if (p.kind === "belt-in" || p.kind === "pipe-in") inPortItems[p.item] = true
    if (p.kind === "belt-out" || p.kind === "pipe-out" || p.kind === "chest-out") outPortItems[p.item] = true
  }
  let fuelItem: string | undefined
  for (const [item] of pairs(inPortItems)) if (facts.fuelValue(item) > 0) fuelItem = item

  // --- nodes
  const nodes: Record<number, Node> = {}
  const machineCounts: Record<string, number> = {}
  const upkeep: Record<string, number> = {}
  let boilers = 0
  let boilerPower = 0
  let engines = 0
  let enginePower = 0
  let engineSteamPerJ = 0
  let pumps = 0
  let pumpPerTick = 0
  let electricDemand = 0
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    const f = facts.entity(e.name)
    if (!f) {
      warnings.push(`unknown entity ${e.name}`)
      continue
    }
    if (f.electric && f.energyPerTick) electricDemand += f.energyPerTick * 60
    if (CRAFTER_TYPES[f.type] || f.type === "mining-drill" || f.type === "lab") addTo(machineCounts, e.name, 1)
    if (f.type === "boiler") {
      boilers++
      boilerPower = f.energyPerTick ?? 0
      addTo(machineCounts, e.name, 1)
      continue
    }
    if (f.type === "generator") {
      engines++
      enginePower = f.maxPowerPerTick ?? 0
      engineSteamPerJ = (f.fluidPerTick ?? 0) / Math.max(1, enginePower)
      addTo(machineCounts, e.name, 1)
      continue
    }
    if (f.type === "offshore-pump") {
      pumps++
      pumpPerTick = f.pumpingPerTick ?? 0
      addTo(machineCounts, e.name, 1)
      continue
    }
    if (CRAFTER_TYPES[f.type]) {
      if (e.recipe === undefined) {
        warnings.push(`${e.name}@${e.x},${e.y} has no recipe`)
        continue
      }
      const r = facts.recipe(e.recipe)
      if (!r) {
        warnings.push(`unknown recipe ${e.recipe}`)
        continue
      }
      const node: Node = newNode(i, "crafter", (f.craftingSpeed ?? 1) / r.energy)
      for (const ing of r.ingredients) addTo(node.ins, ing.name, ing.amount)
      for (const p of r.products) addTo(node.outs, p.name, p.amount)
      if (f.burner) {
        const perSecond = ((f.energyPerTick ?? 0) * 60) / Math.max(1, facts.fuelValue(fuelItem ?? "coal"))
        node.fuelPerCraft = perSecond / node.ideal
        if (fuelItem === undefined) addTo(upkeep, e.name, 1)
      }
      nodes[i] = node
    } else if (f.type === "mining-drill") {
      const resource = e.mines ?? opts.resource
      const time = resource !== undefined ? facts.resourceMiningTime(resource) : undefined
      const product = resource !== undefined ? facts.resourceProduct(resource) : undefined
      if (time === undefined || product === undefined) {
        warnings.push(`drill ${e.name}@${e.x},${e.y}: unknown resource ${tostring(resource)}`)
        continue
      }
      const node = newNode(i, "drill", (f.miningSpeed ?? 0) / time)
      node.outs[product] = 1
      if (f.burner) addTo(upkeep, e.name, 1)
      nodes[i] = node
    } else if (f.type === "lab") {
      const unit = opts.researchUnitTime ?? 30
      const node = newNode(i, "lab", (f.researchSpeed ?? 1) / unit)
      for (const pack of opts.researchPacks ?? []) node.ins[pack] = 1
      node.outs["research-unit"] = 1
      nodes[i] = node
    }
  }

  // --- inserter links
  let boilerFeedCap = 0
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
    // A burner inserter refuels from the fuel it carries: self-sufficient when it feeds a burner from a fuel belt.
    if (f.burner) {
      const target = to !== undefined ? facts.entity(entities[to].name) : undefined
      if (fuelItem === undefined || !fromBelt || target === undefined || target.burner !== true) addTo(upkeep, e.name, 1)
    }
    if (to !== undefined && nodes[to] !== undefined) nodes[to].inCap += cap
    if (to !== undefined && facts.entity(entities[to].name)?.type === "boiler") boilerFeedCap += cap
    if (from !== undefined && nodes[from] !== undefined) {
      nodes[from].outCap += cap
      nodes[from].hasOutInserter = true
      if (to !== undefined && nodes[from].kind === "lab" && nodes[to]?.kind === "lab") nodes[from].feeds.push(to)
    }
  }

  // --- per-machine inserter caps
  const order: number[] = []
  for (const [i] of pairs(nodes)) order.push(i)
  order.sort((a, b) => a - b)
  for (const i of order) {
    const n = nodes[i]
    let r = n.ideal
    if (n.kind === "crafter") {
      const perIn = sumValues(n.ins) + n.fuelPerCraft
      if (perIn > 0) r = Math.min(r, n.inCap / perIn)
      const perOut = sumValues(n.outs)
      if (!n.hasOutInserter) {
        warnings.push(`${entities[i].name}@${entities[i].x},${entities[i].y} has no output inserter`)
        r = 0
      } else if (perOut > 0) r = Math.min(r, n.outCap / perOut)
      if (n.inCap === 0) warnings.push(`${entities[i].name}@${entities[i].x},${entities[i].y} has no input inserter`)
    }
    n.rate = r
  }
  // Labs: a lab's input inserters also carry the packs for the labs it feeds.
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
    if (need > n.inCap + 1e-9 && need > 0) {
      const s = n.inCap / need
      const scale = (j: number, depth: number): void => {
        nodes[j].rate *= s
        if (depth < 64) for (const k of nodes[j].feeds) scale(k, depth + 1)
      }
      scale(i, 0)
    }
  }

  // --- internal balance
  for (let iter = 0; iter < 50; iter++) {
    const prod: Record<string, number> = {}
    const cons: Record<string, number> = {}
    const makers: Record<string, number[]> = {}
    const users: Record<string, number[]> = {}
    for (const i of order) {
      const n = nodes[i]
      for (const [item, a] of pairs(n.outs)) {
        addTo(prod, item, a * n.rate)
        ;(makers[item] ??= []).push(i)
      }
      for (const [item, a] of pairs(n.ins)) {
        addTo(cons, item, a * n.rate)
        ;(users[item] ??= []).push(i)
      }
    }
    let changed = false
    for (const [item, list] of pairs(users)) {
      const p = prod[item] ?? 0
      const c = cons[item] ?? 0
      if (inPortItems[item] || makers[item] === undefined) continue
      if (p < c - 1e-9) {
        const s = p / c
        for (const i of list) nodes[i].rate *= s
        changed = true
      }
    }
    for (const [item, list] of pairs(makers)) {
      if (outPortItems[item] || item === "research-unit") continue
      const p = prod[item] ?? 0
      const c = cons[item] ?? 0
      if (p > c + 1e-9) {
        const s = c / p
        if (c === 0) warnings.push(`${item} is made but neither used nor output`)
        for (const i of list) nodes[i].rate *= s
        changed = true
      }
    }
    if (!changed) break
  }

  // --- totals
  const inputs: Record<string, number> = {}
  const outputs: Record<string, number> = {}
  const prod: Record<string, number> = {}
  const cons: Record<string, number> = {}
  let fuel = 0
  const activity: Record<number, number> = {}
  const ideal: Record<number, number> = {}
  for (const i of order) {
    const n = nodes[i]
    activity[i] = n.rate
    ideal[i] = n.ideal
    for (const [item, a] of pairs(n.outs)) addTo(prod, item, a * n.rate)
    for (const [item, a] of pairs(n.ins)) addTo(cons, item, a * n.rate)
    fuel += n.fuelPerCraft * n.rate
  }
  for (const [item, c] of pairs(cons)) {
    const p = prod[item] ?? 0
    if (c > p + 1e-9) {
      if (!inPortItems[item]) warnings.push(`${item} is needed but has no input port`)
      inputs[item] = c - p
    }
  }
  for (const [item, p] of pairs(prod)) {
    const c = cons[item] ?? 0
    if (p > c + 1e-9 && (outPortItems[item] || item === "research-unit")) outputs[item] = p - c
  }
  if (fuelItem !== undefined && fuel > 0) addTo(inputs, fuelItem, fuel)

  // --- steam power
  if (boilers > 0 || engines > 0) {
    let power = boilers * boilerPower // J/tick
    power = Math.min(power, engines * enginePower)
    if (engineSteamPerJ > 0) power = Math.min(power, (pumps * pumpPerTick) / engineSteamPerJ)
    if (power > 0) {
      outputs["electricity"] = power * 60
      const coal = (power * 60) / Math.max(1, facts.fuelValue(fuelItem ?? "coal"))
      if (fuelItem !== undefined) {
        addTo(inputs, fuelItem, coal)
        if (boilerFeedCap < coal - 1e-9) warnings.push(`boiler fuel inserters move ${boilerFeedCap}/s, need ${coal}/s`)
      }
    }
    if (fuelItem === undefined && boilers > 0) upkeep["boiler"] = boilers
  }
  if (electricDemand > 0) inputs["electricity"] = electricDemand

  const machines: MachineCount[] = []
  for (const [name, count] of pairs(machineCounts)) machines.push({ name, count })
  machines.sort((a, b) => (a.name < b.name ? -1 : 1))
  const upkeepFuel: MachineCount[] = []
  for (const [name, count] of pairs(upkeep)) upkeepFuel.push({ name, count })
  upkeepFuel.sort((a, b) => (a.name < b.name ? -1 : 1))
  const kindOf = (item: string): Rate["kind"] => (item === "electricity" ? "power" : item === "research-unit" ? "research" : "item")
  return { rates: { inputs: sortedRates(inputs, kindOf), outputs: sortedRates(outputs, kindOf) }, machines, activity, ideal, upkeepFuel, warnings }
}

function newNode(index: number, kind: NodeKind, ideal: number): Node {
  return { index, kind, ideal, ins: {}, outs: {}, fuelPerCraft: 0, rate: ideal, inCap: 0, outCap: 0, hasOutInserter: false, feeds: [] }
}

/** The rate of `item` in a rate list (0 if absent). */
export function rateOf(list: Rate[], item: string): number {
  for (const r of list) if (r.item === item) return r.perSecond
  return 0
}
