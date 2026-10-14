// Factory Graph (SPEC §5.8), the layers M4 builds: the physical layer (module instances with their ports; belt routes
// with belts, undergrounds and splitters as edges with capacity) and its mapping to logical flows. Each edge gets the
// capacity check (planned rate vs usable capacity at the D25 utilization cap) and the D24 overflow decision. Measured
// rates, node status and the solver come with M5. The whole graph is plain data, exported to JSON for tools/render
// (D29). Pure: no Factorio globals.

import { rateOf } from "../modules/rates"
import { availableTiers, BeltTier, checkEdge, CapacityCheck, decideOverflow, OverflowDecision, tierByBelt } from "./capacity"
import { Rect, Vec } from "./grid"
import { findModule, findPort, LayoutState, portTile, PortRef, RouteStep } from "./layout"
import { LayoutPolicy } from "./policy"

export interface PhysPort {
  id: string
  kind: string
  item?: string
  /** World tile of the port, and its direction (Factorio 16-way value). */
  x: number
  y: number
  dir: number
  /** Items/s the port delivers (outputs) or takes (inputs) at full speed: inserter-limited by the rate engine. */
  rate?: number
}

export interface PhysNode {
  id: string
  module: string
  generator?: string
  recipe?: string
  origin: Vec
  rot: number
  mirror: boolean
  rect: Rect
  ports: PhysPort[]
  inputs: { item: string; perSecond: number }[]
  outputs: { item: string; perSecond: number }[]
}

export interface PhysEdge {
  id: string
  conn: string
  item: string
  /** Absent: fed from outside the layout. */
  from?: PortRef
  to: PortRef
  belt: string
  lanes: number
  path: RouteStep[]
  blocker?: RouteStep
  tapOf?: string
  external?: boolean
  length: number
  undergrounds: number
  splitters: number
  /** Items/s this edge carries by plan (its consumer's demand plus every tap branching off it). */
  plannedRate: number
  /** M5 fills it from measurement (D26). */
  measuredRate?: number
  capacity: CapacityCheck
  decision: OverflowDecision
}

export interface LogicalEdge {
  id: string
  item: string
  from?: string
  to: string
  plannedRate: number
  measuredRate?: number
  /** Physical edges that carry this flow. */
  physical: string[]
}

export interface FactoryGraph {
  version: 1
  faction?: string
  tick?: number
  utilization: number
  logical: { nodes: { id: string; recipe?: string }[]; edges: LogicalEdge[] }
  physical: { nodes: PhysNode[]; edges: PhysEdge[] }
}

export interface GraphOptions {
  tiers: BeltTier[]
  researched: Record<string, boolean>
  /** Planned rate per connection id (default: min of the producer's and consumer's port rates). */
  rates?: Record<string, number>
}

function portRate(state: LayoutState, ref: PortRef, output: boolean): number | undefined {
  const m = findModule(state, ref.module)
  const p = m ? findPort(m, ref.port) : undefined
  if (!m || !p || p.item === undefined) return undefined
  const list = output ? m.def.rates.outputs : m.def.rates.inputs
  // Several ports of a module may carry the same item: split its rate evenly.
  let n = 0
  for (const q of m.def.ports) if (q.item === p.item && q.kind === p.kind) n++
  return rateOf(list, p.item) / math.max(1, n)
}

export function buildGraph(state: LayoutState, policy: LayoutPolicy, opts: GraphOptions): FactoryGraph {
  const nodes: PhysNode[] = []
  for (const m of state.modules) {
    const ports: PhysPort[] = []
    for (const p of m.def.ports) {
      const t = portTile(m, p)
      const rate = p.item !== undefined ? portRate(state, { module: m.id, port: p.id }, p.kind === "belt-out" || p.kind === "chest-out") : undefined
      ports.push({ id: p.id, kind: p.kind, item: p.item, x: t.x, y: t.y, dir: p.dir, rate })
    }
    nodes.push({
      id: m.id,
      module: m.def.id,
      generator: m.def.generator,
      recipe: m.def.recipe,
      origin: m.origin,
      rot: m.transform.rot,
      mirror: m.transform.mirror,
      rect: m.rect,
      ports,
      inputs: m.def.rates.inputs.map((r) => ({ item: r.item, perSecond: r.perSecond })),
      outputs: m.def.rates.outputs.map((r) => ({ item: r.item, perSecond: r.perSecond })),
    })
  }
  // Own demand per route, then trunks carry their taps too.
  const own: Record<string, number> = {}
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    const consumer = portRate(state, r.to, false) ?? 0
    const producer = r.from !== undefined ? portRate(state, r.from, true) : undefined
    own[id] = opts.rates?.[r.conn] ?? (producer !== undefined ? math.min(producer, consumer) : consumer)
  }
  const carried = (id: string): number => {
    let v = own[id] ?? 0
    for (const other of state.routeOrder) if (state.routes[other].tapOf === id) v += carried(other)
    return v
  }
  const rootOf = (id: string): string => {
    const t = state.routes[id].tapOf
    return t === undefined ? id : rootOf(t)
  }
  const available = availableTiers(opts.tiers, opts.researched)
  const edges: PhysEdge[] = []
  const logical: LogicalEdge[] = []
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    const tier = tierByBelt(opts.tiers, r.belt) ?? opts.tiers[0]
    const planned = carried(id)
    const root = state.routes[rootOf(id)]
    const producerMax = root.from !== undefined ? portRate(state, root.from, true) : undefined
    let consumerMax = 0
    let anyConsumer = false
    const addConsumers = (rid: string): void => {
      const c = portRate(state, state.routes[rid].to, false)
      if (c !== undefined) {
        consumerMax += c
        anyConsumer = true
      }
      for (const other of state.routeOrder) if (state.routes[other].tapOf === rid) addConsumers(other)
    }
    addConsumers(id)
    const limits = { tier, lanes: 2, utilization: policy.utilization, producerMax, consumerMax: anyConsumer ? consumerMax : undefined }
    let splitters = 0
    for (const s of r.steps) if (s.kind === "splitter") splitters++
    edges.push({
      id,
      conn: r.conn,
      item: r.item,
      from: r.from,
      to: r.to,
      belt: r.belt,
      lanes: 2,
      path: r.steps,
      blocker: r.blocker,
      tapOf: r.tapOf,
      external: r.external,
      length: r.length,
      undergrounds: r.undergrounds,
      splitters,
      plannedRate: planned,
      capacity: checkEdge(planned, limits),
      decision: decideOverflow({ demand: planned, edge: limits, available, order: policy.overflow.order, maxParallel: policy.overflow.maxParallel }),
    })
    logical.push({ id: `flow:${r.conn}`, item: r.item, from: root.from?.module, to: r.to.module, plannedRate: own[id], physical: r.tapOf !== undefined ? [rootOf(id), id] : [id] })
  }
  return {
    version: 1,
    utilization: policy.utilization,
    logical: { nodes: state.modules.map((m) => ({ id: m.id, recipe: m.def.recipe })), edges: logical },
    physical: { nodes, edges },
  }
}
