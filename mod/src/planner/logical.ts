// Factory Graph, logical layer (SPEC §5.8): what flows. Nodes are production units (module instances, mining
// outposts, power, labs, sinks such as crew-supplied chests); edges are item flows (one item per edge, D23) and power
// flows, each with a **planned rate** and a slot for the **measured rate** (D26, filled by measurement in M5b). Every
// node maps to a module instance of the physical layer (the faction's LayoutState, same id), every belt edge to the
// routes that carry it and every power edge to its pole line. The graph is plain data, persisted per faction in
// `storage` (strategy/factory.ts) and exported with the physical layer for tools/render (D29). Pure: no Factorio globals.

import { Rate } from "../modules/types"

export type NodeKind = "module" | "outpost" | "power" | "labs" | "sink" | "source"

/** Build lifecycle, set by the strategy layer. */
export type NodeLifecycle = "planned" | "building" | "built"

/**
 * Reconciler classification (D26), filled by M5b: ok, starved (input shortfall, traced upstream), backed-up (output
 * blocked), unpowered, unfuelled. "unknown" until measured. "expected" (D49): short only of what the crew supplies by
 * design (hand-fed labs before their pack is automated): not a problem, no root cause, no remedy.
 */
export type NodeStatus = "unknown" | "ok" | "expected" | "starved" | "backed-up" | "unpowered" | "unfuelled"

/** Shares of machine-samples in each state over a measurement window (0..1, summing to 1). */
export interface StateShares {
  working: number
  /** Missing ingredients (or ore under a drill, water for a boiler). */
  starved: number
  /** Output full (a belt or machine downstream doesn't take it). */
  blocked: number
  /** No or low power. */
  unpowered: number
  /** A burner without fuel. */
  unfuelled: number
  /** Nothing to do that measurement can blame (no research in progress, no recipe, disabled, ...). */
  idle: number
}

export interface Measured {
  tick: number
  /** Sampling window (ticks) the rates are averaged over. */
  window: number
  inputs: Rate[]
  outputs: Rate[]
  /** Machines sampled (crafting machines, drills, labs, boilers and engines of the module; never chests, D42). */
  machines?: number
  states?: StateShares
  /** Share of machine-samples starved of each item ("depleted": a drill with no ore left). */
  missing?: Record<string, number>
  /** Rates estimated from the working share and full-speed rates (drills, labs) rather than counted. */
  estimated?: boolean
  /**
   * Inserters inside the module: share of their samples without power / without fuel. Furnaces behind unpowered
   * inserters only look starved; this tells the real cause.
   */
  inserters?: { unpowered: number; unfuelled: number }
  /** Power nodes: generated power / the node's full output (0..1). */
  load?: number
}

/** The reconciler's root cause for a node that is not ok (D26). */
export interface RootCause {
  /** node: a graph node (the node itself or an upstream one); edge: a belt or power flow; external: outside the graph. */
  kind: "node" | "edge" | "external" | "building" | "measuring" | "demand"
  id?: string
  /** What is wrong there ("unpowered", "undersized", "broken", "at-capacity", ...). */
  what: string
  why: string
}

export interface LogicalNode {
  id: string
  /** Stable role in the design ("labs", "automation-science-pack>labs", ...): how plans and diffs find it again. */
  role: string
  kind: NodeKind
  /** Module definition id and generator (the physical instance has the node's id). */
  module?: string
  generator?: string
  recipe?: string
  /** The node's main product (an item, "electricity" or "research-unit"). */
  item?: string
  /** Full-speed rates of the module (its capacity). */
  capacity: { inputs: Rate[]; outputs: Rate[] }
  /** Rates the plan asks of it (≤ capacity). */
  planned: { inputs: Rate[]; outputs: Rate[] }
  /** Electric demand at full speed (W); generators: supply (W). */
  powerW: number
  lifecycle: NodeLifecycle
  /** M5b: reconciler status and its reason (the upstream root cause for starved nodes). */
  status: NodeStatus
  statusReason?: string
  /** M5b: measured rates. */
  measured?: Measured
  /** M5b: when the status last changed, and the root cause of a status that is not ok. */
  statusTick?: number
  cause?: RootCause
  /** The build goal that created or last grew it. */
  goal?: string
  createdTick: number
  builtTick?: number
}

export type EdgeKind = "belt" | "power" | "crew"

export interface LogicalEdge {
  id: string
  /** Stable role ("<producer role>><consumer role>.<port>"). */
  role: string
  kind: EdgeKind
  /** An item, or "electricity" for power edges. */
  item: string
  /** Producer node and port (absent: supplied from outside the graph, e.g. by the crew). */
  from?: string
  fromPort?: string
  to: string
  toPort?: string
  /** Items/s (W for power) by plan, and at the next stage target (D27 headroom). */
  plannedRate: number
  headroomRate?: number
  /** M5b: measured items/s (W) and when. */
  measuredRate?: number
  measuredTick?: number
  /**
   * M5b: share of probe samples where the belt tile at the producer's port (`from`) and at the consumer's port (`to`)
   * was full: items piling up there.
   */
  measuredFull?: { from: number; to: number }
  /** M5b: the usable capacity (items/s) of the edge's belt, for comparing the measured rate. */
  capacityRate?: number
  /** Physical layer: route ids (belt edges) or pole line ids (power edges). */
  physical: string[]
  /** Belt tier the edge is built with (D24 upgrade-tier picks a faster one). */
  belt?: string
  /** D24 remedy applied when sizing it, if any. */
  overflow?: string
}

export interface LogicalGraph {
  nodes: Record<string, LogicalNode>
  nodeOrder: string[]
  edges: Record<string, LogicalEdge>
  edgeOrder: string[]
  nextId: number
}

export function newGraph(): LogicalGraph {
  return { nodes: {}, nodeOrder: [], edges: {}, edgeOrder: [], nextId: 1 }
}

/** A fresh node id ("n1", "n2", ...): also the module instance id in the physical layout. */
export function nextNodeId(g: LogicalGraph): string {
  return `n${g.nextId++}`
}

export function addNode(g: LogicalGraph, n: LogicalNode): LogicalNode {
  if (g.nodes[n.id] === undefined) g.nodeOrder.push(n.id)
  g.nodes[n.id] = n
  return n
}

export function addEdge(g: LogicalGraph, e: LogicalEdge): LogicalEdge {
  if (g.edges[e.id] === undefined) g.edgeOrder.push(e.id)
  g.edges[e.id] = e
  return e
}

export function removeNode(g: LogicalGraph, id: string): void {
  delete g.nodes[id]
  g.nodeOrder = g.nodeOrder.filter((x) => x !== id)
  for (const eid of [...g.edgeOrder]) {
    const e = g.edges[eid]
    if (e.from === id || e.to === id) removeEdge(g, eid)
  }
}

export function removeEdge(g: LogicalGraph, id: string): void {
  delete g.edges[id]
  g.edgeOrder = g.edgeOrder.filter((x) => x !== id)
}

export function nodeByRole(g: LogicalGraph, role: string): LogicalNode | undefined {
  for (const id of g.nodeOrder) if (g.nodes[id].role === role) return g.nodes[id]
  return undefined
}

export function edgeByRole(g: LogicalGraph, role: string): LogicalEdge | undefined {
  for (const id of g.edgeOrder) if (g.edges[id].role === role) return g.edges[id]
  return undefined
}

export function nodesOf(g: LogicalGraph, kind?: NodeKind): LogicalNode[] {
  const out: LogicalNode[] = []
  for (const id of g.nodeOrder) if (kind === undefined || g.nodes[id].kind === kind) out.push(g.nodes[id])
  return out
}

export function edgesInto(g: LogicalGraph, node: string): LogicalEdge[] {
  const out: LogicalEdge[] = []
  for (const id of g.edgeOrder) if (g.edges[id].to === node) out.push(g.edges[id])
  return out
}

export function edgesFrom(g: LogicalGraph, node: string): LogicalEdge[] {
  const out: LogicalEdge[] = []
  for (const id of g.edgeOrder) if (g.edges[id].from === node) out.push(g.edges[id])
  return out
}

/** Sum of a rate list for one item. */
export function rateIn(list: Rate[], item: string): number {
  let v = 0
  for (const r of list) if (r.item === item) v += r.perSecond
  return v
}

/** Total power supply (generators) and planned demand (consumers) of the graph's nodes, in W, by lifecycle filter. */
export function powerBalance(g: LogicalGraph, built?: boolean): { supplyW: number; demandW: number } {
  let supplyW = 0
  let demandW = 0
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    if (built === true && n.lifecycle !== "built") continue
    // B52: a grown plant's capacity (saves from before the fix kept the first unit's powerW).
    if (n.kind === "power") supplyW += math.max(n.powerW, rateIn(n.capacity.outputs, "electricity"))
    else demandW += n.powerW
  }
  return { supplyW, demandW }
}

/**
 * Upstream walk (M5b's reconciler traces a starved node to its root cause): every node feeding `node`, nearest first.
 */
export function upstream(g: LogicalGraph, node: string): string[] {
  const out: string[] = []
  const seen: Record<string, boolean> = { [node]: true }
  const queue = [node]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of edgesInto(g, cur)) {
      if (e.from === undefined || seen[e.from]) continue
      seen[e.from] = true
      out.push(e.from)
      queue.push(e.from)
    }
  }
  return out
}
