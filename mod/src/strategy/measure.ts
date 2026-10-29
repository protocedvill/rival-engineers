import { LuaEntity, LuaSurface } from "factorio:runtime"
import { prototypeFacts } from "../modules/prototype-facts"
import { Rate } from "../modules/types"
import { findModule, findPort, LayoutState, portTile } from "../planner/layout"
import { LogicalEdge, LogicalGraph, LogicalNode, rateIn, StateShares } from "../planner/logical"
import { findEntities } from "../work"

// Measurement (SPEC §5.8, D26): measured rates and machine states per Factory Graph node, measured flow per belt edge.
// Per-faction flow statistics are too coarse, so everything is sampled per module:
//
// - **Nodes**, every `measure-interval-ticks`: each machine of a built node (crafting machines, mining drills, labs,
//   boilers, steam engines; never chests, so D42 buffer chests are never demand) is put in one state class by its
//   `status` (working, starved, blocked, unpowered, unfuelled, idle); crafting machines add their `products_finished`
//   deltas (times the recipe's products and ingredients: counted rates); a starved machine's input inventory says
//   which ingredient is missing. Drills and labs have no counter: their rates are estimated from the working share
//   and full-speed rates. Steam engines add the power they generated. Cumulative counters are snapshotted into a
//   ring; a node's `measured` is the difference across the ring (a sliding window of `measure-window-samples`).
// - **Edges**, one probe at a time per faction for `measure-probe-ticks`: the belt tile at the consumer's port is
//   sampled often enough to see every item cross it (items on belts keep a `unique_id`), so arrivals per second is
//   the flow the consumer actually gets. The probe also records how often the tiles at both ports were full (items
//   piling up). Edges are probed round-robin, and the reconciler's requests go first.
//
// Everything lives in `storage` (entity references included) and runs at fixed ticks: deterministic (§5.6).

export type StateClass = keyof StateShares

export interface Counters {
  tick: number
  samples: number
  working: number
  starved: number
  blocked: number
  unpowered: number
  unfuelled: number
  idle: number
  /** Items made / used by counted crafts. */
  made: Record<string, number>
  used: Record<string, number>
  /** Starved machine-samples per missing item (split when several are missing). */
  missing: Record<string, number>
  /** Steam engines: generated W summed over samples. */
  energy: number
  /** Inserters: samples, and samples without power / fuel. */
  insSamples: number
  insUnpowered: number
  insUnfuelled: number
}

type MachineKind = "crafter" | "drill" | "lab" | "boiler" | "generator"

interface Machine {
  entity: LuaEntity
  kind: MachineKind
  recipe?: string
  finished: number
}

export interface NodeMeter {
  machines: Machine[]
  /** The module's inserters (power and fuel only). */
  inserters: LuaEntity[]
  /** The node's builtTick when the machines were found (a grown node is searched again). */
  builtTick: number
  /** B48: machines the module's layout plans; while fewer are found, they are searched again every sample. */
  planned?: number
  /** Lab packs (the module's belt-in items). */
  packs: string[]
  cum: Counters
  ring: Counters[]
}

export interface EdgeProbe {
  edge: string
  to: LuaEntity
  from?: LuaEntity
  every: number
  next: number
  first?: number
  last: number
  end: number
  initial: Record<number, boolean>
  seen: Record<number, boolean>
  arrivals: number
  samples: number
  fullFrom: number
  fullTo: number
  /** Nominal items/s of the consumer's port belt (both lanes). */
  capacity: number
}

export interface MeterState {
  nodes: Record<string, NodeMeter>
  lastSample: number
  probe?: EdgeProbe
  /** Edges the reconciler wants measured first. */
  queue: string[]
  /** Round-robin position over belt edges. */
  cursor: number
  /** Probes finished so far (telemetry). */
  probes: number
}

export function newMeter(): MeterState {
  return { nodes: {}, lastSample: -math.huge, queue: [], cursor: 0, probes: 0 }
}

const MACHINE_TYPES = ["assembling-machine", "furnace", "mining-drill", "lab", "boiler", "generator"]
const BELT_TYPES = ["transport-belt", "underground-belt", "splitter"]
/** Items per belt tile on both lanes when full (4 per lane). */
const TILE_ITEMS = 8
/** A port tile holding at least this many items counts as full (one gap allowed). */
const FULL_TILE_ITEMS = 7
/** Probe samples are this fraction of the time an item takes to cross the tile apart, so none is missed. */
const PROBE_SAMPLE_FRACTION = 0.75

// --------------------------------------------------------------------------------------------------------------
// Status classes

let classes: Record<number, StateClass> | undefined

const CLASS_OF: Record<string, StateClass> = {
  working: "working",
  normal: "working",
  low_input_fluid: "working",
  no_ingredients: "starved",
  item_ingredient_shortage: "starved",
  fluid_ingredient_shortage: "starved",
  missing_science_packs: "starved",
  no_input_fluid: "starved",
  missing_required_fluid: "starved",
  waiting_for_source_items: "starved",
  waiting_for_more_items: "starved",
  no_minable_resources: "starved",
  full_output: "blocked",
  not_enough_space_in_output: "blocked",
  full_burnt_result_output: "blocked",
  waiting_for_space_in_destination: "blocked",
  no_power: "unpowered",
  low_power: "unpowered",
  not_plugged_in_electric_network: "unpowered",
  recharging_after_power_outage: "unpowered",
  no_fuel: "unfuelled",
}

/** The state class of an entity status (anything not listed is idle: no recipe, no research, disabled, ...). */
export function statusClass(status: number | undefined): StateClass {
  if (status === undefined) return "idle"
  if (classes === undefined) {
    classes = {}
    for (const [name, value] of pairs(defines.entity_status)) {
      const c = CLASS_OF[name as string]
      if (c !== undefined) classes[value as unknown as number] = c
    }
  }
  return classes[status] ?? "idle"
}

function statusName(status: number): string {
  for (const [name, value] of pairs(defines.entity_status)) if ((value as unknown as number) === status) return name as string
  return "?"
}

// --------------------------------------------------------------------------------------------------------------
// Nodes

function newCounters(tick: number): Counters {
  return { tick, samples: 0, working: 0, starved: 0, blocked: 0, unpowered: 0, unfuelled: 0, idle: 0, made: {}, used: {}, missing: {}, energy: 0, insSamples: 0, insUnpowered: 0, insUnfuelled: 0 }
}

function copyCounters(c: Counters): Counters {
  return { ...c, made: { ...c.made }, used: { ...c.used }, missing: { ...c.missing } }
}

function kindOf(type: string): MachineKind | undefined {
  if (type === "assembling-machine" || type === "furnace") return "crafter"
  if (type === "mining-drill") return "drill"
  if (type === "lab") return "lab"
  if (type === "boiler") return "boiler"
  if (type === "generator") return "generator"
  return undefined
}

/** B48: how many machines (measured entity types) the module's layout entities hold. */
function plannedMachines(layout: LayoutState, n: LogicalNode): number {
  const m = findModule(layout, n.id)
  if (m === undefined) return 0
  let count = 0
  for (const e of m.def.entities) {
    const type = prototypes.entity[e.name]?.type
    if (type !== undefined && kindOf(type) !== undefined) count++
  }
  return count
}

function findMachines(surface: LuaSurface, force: string, layout: LayoutState, n: LogicalNode): { machines: Machine[]; packs: string[]; inserters: LuaEntity[] } {
  const m = findModule(layout, n.id)
  if (m === undefined) return { machines: [], packs: [], inserters: [] }
  const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
  const machines: Machine[] = []
  for (const e of findEntities(surface, { area, force, type: MACHINE_TYPES })) {
    const kind = kindOf(e.type)
    if (kind === undefined) continue
    let recipe: string | undefined
    if (kind === "crafter") recipe = e.type === "assembling-machine" ? e.get_recipe()[0]?.name : n.recipe
    machines.push({ entity: e, kind, recipe, finished: kind === "crafter" ? e.products_finished : 0 })
  }
  const packs: string[] = []
  for (const p of m.def.ports) if (p.kind === "belt-in" && p.item !== undefined) packs.push(p.item)
  const inserters = findEntities(surface, { area, force, type: "inserter" })
  return { machines, packs, inserters }
}

function add(t: Record<string, number>, k: string, v: number): void {
  t[k] = (t[k] ?? 0) + v
}

/** Which ingredients a starved crafting machine lacks (each gets an equal share of the sample). */
function crafterMissing(c: Counters, e: LuaEntity, recipe: string | undefined): void {
  const r = recipe !== undefined ? prototypeFacts.recipe(recipe) : undefined
  const inv = e.get_inventory(defines.inventory.crafter_input)
  if (r === undefined || inv === undefined) return
  const lacking: string[] = []
  for (const ing of r.ingredients) if (inv.get_item_count(ing.name) < ing.amount) lacking.push(ing.name)
  for (const item of lacking) add(c.missing, item, 1 / lacking.length)
}

function sampleMachine(c: Counters, mc: Machine, packs: string[]): boolean {
  const e = mc.entity
  if (!e.valid) return false
  const status = e.status as unknown as number | undefined
  const cls = statusClass(status)
  c[cls]++
  c.samples++
  if (mc.kind === "crafter") {
    const pf = e.products_finished
    const d = pf - mc.finished
    mc.finished = pf
    // A furnace's recipe is whatever it smelts now (the node's recipe when idle).
    const recipe = e.type === "furnace" ? (e.get_recipe()[0]?.name ?? mc.recipe) : mc.recipe
    if (d > 0 && recipe !== undefined) {
      const r = prototypeFacts.recipe(recipe)
      if (r !== undefined) {
        for (const p of r.products) add(c.made, p.name, d * p.amount)
        for (const i of r.ingredients) add(c.used, i.name, d * i.amount)
      }
    }
    if (cls === "starved") crafterMissing(c, e, recipe)
  } else if (mc.kind === "lab") {
    if (cls === "starved") {
      const inv = e.get_inventory(defines.inventory.lab_input)
      const lacking = packs.filter((p) => (inv?.get_item_count(p) ?? 0) === 0)
      for (const item of lacking) add(c.missing, item, 1 / lacking.length)
    }
  } else if (mc.kind === "drill") {
    if (status === (defines.entity_status.no_minable_resources as unknown as number)) add(c.missing, "depleted", 1)
  } else if (mc.kind === "boiler") {
    if (status === (defines.entity_status.no_input_fluid as unknown as number)) add(c.missing, "water", 1)
  } else if (mc.kind === "generator") {
    c.energy += e.energy_generated_last_tick * 60
  }
  return true
}

function scaled(rates: Rate[], factor: number, only?: Rate[]): Rate[] {
  const out: Rate[] = []
  for (const r of rates) {
    if (r.item === "electricity") continue
    if (only !== undefined && only.length > 0 && rateIn(only, r.item) <= 0) continue
    out.push({ item: r.item, perSecond: r.perSecond * factor })
  }
  return out
}

/** The node's `measured` from the window [ring[0], cum]. */
function evaluate(n: LogicalNode, meter: NodeMeter): void {
  const old = meter.ring[0]
  const cur = meter.cum
  const window = cur.tick - old.tick
  const samples = cur.samples - old.samples
  if (window <= 0 || samples <= 0) return
  const states: StateShares = {
    working: (cur.working - old.working) / samples,
    starved: (cur.starved - old.starved) / samples,
    blocked: (cur.blocked - old.blocked) / samples,
    unpowered: (cur.unpowered - old.unpowered) / samples,
    unfuelled: (cur.unfuelled - old.unfuelled) / samples,
    idle: (cur.idle - old.idle) / samples,
  }
  const missing: Record<string, number> = {}
  for (const [k, v] of pairs(cur.missing)) {
    const d = (v as number) - (old.missing[k as string] ?? 0)
    if (d > 0) missing[k as string] = d / samples
  }
  const perSec = (a: Record<string, number>, b: Record<string, number>, item: string): number => (((a[item] ?? 0) - (b[item] ?? 0)) * 60) / window
  let crafters = false
  for (const mc of meter.machines) if (mc.kind === "crafter") crafters = true
  let outputs: Rate[] = []
  let inputs: Rate[] = []
  let estimated = false
  let load: number | undefined
  if (n.kind === "power") {
    const gens = meter.machines.filter((m) => m.kind === "generator").length
    // Energy was summed per generator sample; samples per generator = samples / machines.
    const perSample = meter.machines.length > 0 ? samples / meter.machines.length : 0
    const w = perSample > 0 ? (cur.energy - old.energy) / perSample : 0
    outputs = [{ item: "electricity", perSecond: w }]
    // B52: against what is built (the capacity follows growth; powerW was the first unit's).
    const cap = rateIn(n.capacity.outputs, "electricity")
    const built = cap > 0 ? cap : n.powerW
    load = built > 0 && gens > 0 ? w / built : 0
  } else if (crafters) {
    const items: string[] = []
    for (const r of [...n.capacity.outputs, ...n.planned.outputs]) if (items.indexOf(r.item) < 0) items.push(r.item)
    for (const item of items) outputs.push({ item, perSecond: perSec(cur.made, old.made, item) })
    for (const r of n.planned.inputs.length > 0 ? n.planned.inputs : n.capacity.inputs) {
      if (r.item === "electricity" || inputs.some((x) => x.item === r.item)) continue
      inputs.push({ item: r.item, perSecond: perSec(cur.used, old.used, r.item) })
    }
  } else {
    // Drills and labs: the working share of full speed.
    estimated = true
    outputs = scaled(n.capacity.outputs, states.working)
    inputs = scaled(n.capacity.inputs, states.working, n.planned.inputs)
  }
  const ins = cur.insSamples - old.insSamples
  const inserters = ins > 0 ? { unpowered: (cur.insUnpowered - old.insUnpowered) / ins, unfuelled: (cur.insUnfuelled - old.insUnfuelled) / ins } : undefined
  n.measured = { tick: cur.tick, window, inputs, outputs, machines: meter.machines.length, states, missing, estimated, load, inserters }
}

/**
 * One measurement sample of every built node of a graph (see the file comment). `windowSamples` snapshots make the
 * sliding window.
 */
export function sampleNodes(meter: MeterState, graph: LogicalGraph, layout: LayoutState, surface: LuaSurface, force: string, tick: number, windowSamples: number): void {
  for (const id of graph.nodeOrder) {
    const n = graph.nodes[id]
    if (n.lifecycle !== "built") {
      delete meter.nodes[id]
      continue
    }
    const built = n.builtTick ?? n.createdTick
    let nm = meter.nodes[id]
    if (nm === undefined || nm.builtTick !== built) {
      const found = findMachines(surface, force, layout, n)
      nm = { machines: found.machines, inserters: found.inserters, packs: found.packs, builtTick: built, planned: plannedMachines(layout, n), cum: newCounters(tick), ring: [] }
      meter.nodes[id] = nm
    } else if (nm.machines.length < (nm.planned = plannedMachines(layout, n))) {
      // B48: machines built into a built module later (a shared mine's completion keeps its builtTick) are measured
      // once they stand; the counters go on (seed 3333: 5 of n28's 17 drills were measured, it read as depleted).
      const found = findMachines(surface, force, layout, n)
      if (found.machines.length > nm.machines.length) {
        nm.machines = found.machines
        nm.inserters = found.inserters
      }
    }
    let lost = false
    for (const mc of nm.machines) if (!sampleMachine(nm.cum, mc, nm.packs)) lost = true
    for (const e of nm.inserters) {
      if (!e.valid) {
        lost = true
        continue
      }
      const cls = statusClass(e.status as unknown as number | undefined)
      nm.cum.insSamples++
      if (cls === "unpowered") nm.cum.insUnpowered++
      else if (cls === "unfuelled") nm.cum.insUnfuelled++
    }
    if (lost) {
      // A machine is gone (mined, destroyed): look again next sample, keep the counters.
      const found = findMachines(surface, force, layout, n)
      nm.machines = found.machines
      nm.inserters = found.inserters
    }
    nm.cum.tick = tick
    nm.ring.push(copyCounters(nm.cum))
    while (nm.ring.length > windowSamples + 1) nm.ring.shift()
    if (nm.ring.length >= 2) evaluate(n, nm)
  }
  for (const [id] of pairs(meter.nodes)) if (graph.nodes[id as string] === undefined) delete meter.nodes[id as string]
}

// --------------------------------------------------------------------------------------------------------------
// Edges

function beltAt(surface: LuaSurface, x: number, y: number): LuaEntity | undefined {
  return findEntities(surface, { position: { x: x + 0.5, y: y + 0.5 }, type: BELT_TYPES, limit: 1 })[0]
}

function portBelt(surface: LuaSurface, layout: LayoutState, module: string | undefined, port: string | undefined): LuaEntity | undefined {
  if (module === undefined || port === undefined) return undefined
  const m = findModule(layout, module)
  const p = m !== undefined ? findPort(m, port) : undefined
  if (m === undefined || p === undefined) return undefined
  const t = portTile(m, p)
  return beltAt(surface, t.x, t.y)
}

function probeable(graph: LogicalGraph, e: LogicalEdge | undefined): boolean {
  if (e === undefined || e.kind !== "belt" || e.from === undefined || e.toPort === undefined) return false
  return graph.nodes[e.from]?.lifecycle === "built" && graph.nodes[e.to]?.lifecycle === "built"
}

/** B104: belt edges a probe can measure now (the round the probes go through). */
export function probeableCount(graph: LogicalGraph): number {
  let n = 0
  for (const id of graph.edgeOrder) if (probeable(graph, graph.edges[id])) n++
  return n
}

/** Starts the next edge probe (requested edges first, then round-robin over belt edges between built nodes). */
export function startProbe(meter: MeterState, graph: LogicalGraph, layout: LayoutState, surface: LuaSurface, tick: number, length: number): void {
  let edge: LogicalEdge | undefined
  while (meter.queue.length > 0 && edge === undefined) {
    const e = graph.edges[meter.queue.shift()!]
    if (probeable(graph, e)) edge = e
  }
  for (let i = 0; i < graph.edgeOrder.length && edge === undefined; i++) {
    meter.cursor = (meter.cursor + 1) % graph.edgeOrder.length
    const e = graph.edges[graph.edgeOrder[meter.cursor]]
    if (probeable(graph, e)) edge = e
  }
  if (edge === undefined) return
  const to = portBelt(surface, layout, edge.to, edge.toPort)
  if (to === undefined) {
    // No belt at the consumer's port: nothing arrives.
    edge.measuredRate = 0
    edge.measuredTick = tick
    edge.measuredFull = { from: 0, to: 0 }
    return
  }
  const speed = to.prototype.belt_speed ?? 0.03125
  meter.probe = {
    edge: edge.id,
    to,
    from: portBelt(surface, layout, edge.from, edge.fromPort),
    every: math.max(1, math.floor(PROBE_SAMPLE_FRACTION / speed)),
    next: tick,
    last: tick,
    end: tick + length,
    initial: {},
    seen: {},
    arrivals: 0,
    samples: 0,
    fullFrom: 0,
    fullTo: 0,
    capacity: speed * 60 * TILE_ITEMS,
  }
}

function tileCount(e: LuaEntity): number {
  return e.get_transport_line(1).get_item_count() + e.get_transport_line(2).get_item_count()
}

/** Samples the running probe when due; finishes it into the edge's measured values. */
export function probeTick(meter: MeterState, graph: LogicalGraph, tick: number): void {
  const p = meter.probe
  if (p === undefined || tick < p.next) return
  const edge = graph.edges[p.edge]
  if (edge === undefined || !p.to.valid) {
    meter.probe = undefined
    return
  }
  p.next = tick + p.every
  for (const i of [1, 2]) {
    for (const item of p.to.get_transport_line(i).get_detailed_contents()) {
      const id = item.unique_id
      if (p.first === undefined) p.initial[id] = true
      else if (!p.initial[id] && !p.seen[id]) {
        p.seen[id] = true
        p.arrivals++
      }
    }
  }
  if (p.first === undefined) p.first = tick
  p.last = tick
  p.samples++
  if (tileCount(p.to) >= FULL_TILE_ITEMS) p.fullTo++
  if (p.from !== undefined && p.from.valid && tileCount(p.from) >= FULL_TILE_ITEMS) p.fullFrom++
  if (tick < p.end) return
  const span = p.last - p.first
  edge.measuredRate = span > 0 ? (p.arrivals * 60) / span : 0
  edge.measuredTick = tick
  edge.measuredFull = { from: p.fullFrom / p.samples, to: p.fullTo / p.samples }
  edge.capacityRate = p.capacity
  meter.probe = undefined
  meter.probes++
}

/** Requests probes for edges (front of the queue, no duplicates). */
export function requestProbes(meter: MeterState, edges: string[]): void {
  for (const id of edges) if (meter.queue.indexOf(id) < 0 && meter.probe?.edge !== id) meter.queue.push(id)
}

/** Debug: a node's machines and their statuses (probes, tests). */
export function describeMachines(meter: MeterState, node: string): string {
  const nm = meter.nodes[node]
  if (nm === undefined) return "not measured"
  const counts: Record<string, number> = {}
  for (const mc of nm.machines) {
    if (!mc.entity.valid) continue
    const k = `${mc.entity.name}:${statusName(mc.entity.status as unknown as number)}`
    counts[k] = (counts[k] ?? 0) + 1
  }
  const parts: string[] = []
  for (const [k, v] of pairs(counts)) parts.push(`${k as string}×${v}`)
  parts.sort()
  return parts.join(" ")
}
