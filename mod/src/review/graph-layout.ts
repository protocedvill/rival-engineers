import { LogicalEdge, LogicalGraph, LogicalNode, NodeStatus, rateIn } from "../planner/logical"
import { EdgeVerdict, edgeVerdict, ReconcileParams } from "../strategy/reconcile"

// The data behind the factory-graph window (B16): plain tables built from a LogicalGraph, laid out by dataflow
// depth (sources left, consumers right) — the window's geometry is logic, not the base's real positions, so belt
// paths become plain edges in a table and a graph with no measurement yet is still laid out. Pure (no Factorio
// globals): the T1 test builds a graph by hand and checks the layout and edge notes; graph-window.ts renders it.

export interface GraphNodeRow {
  id: string
  role: string
  kind: LogicalNode["kind"]
  item?: string
  lifecycle: LogicalNode["lifecycle"]
  status: NodeStatus
  statusReason?: string
  /** Dataflow depth: 0 = nothing flows in (source, crew-fed), increasing to the right. Cycle leftovers share one level. */
  level: number
  machines?: number
  /** Measured vs planned output of `item` (items/s); power nodes carry `load` (their output rate is undefined). */
  measuredOut?: number
  plannedOut: number
  /** Generators: share of capacity used. */
  load?: number
  /** Root cause of a status that is not ok, as "where: what" plus the reconciler's why. */
  cause?: string
}

export interface GraphEdgeRow {
  id: string
  kind: LogicalEdge["kind"]
  item: string
  /** Producer / consumer node ids (from: absent when the edge is fed from outside the graph, e.g. by the crew). */
  from?: string
  to: string
  planned: number
  measured?: number
  /** The reconciler's belt-probe verdict: stale | full | intake | broken | sparse. */
  verdict?: EdgeVerdict
}

export interface GraphLayoutView {
  /** Node rows grouped by dataflow depth: levels[0] is the leftmost column. */
  levels: GraphNodeRow[][]
  /** The node rows in graph order (the rows flattened without regrouping). */
  nodes: GraphNodeRow[]
  edges: GraphEdgeRow[]
  /** Nodes per status, summarised for the window's header. */
  statusCounts: Record<NodeStatus, number>
}

/** Belt and crew edges carry the dataflow; power edges are drawn in the table but do not shape the layout. */
function flowEdge(e: LogicalEdge): boolean {
  return e.kind !== "power"
}

/** Belt and crew edges into a node, by producer id (absent when fed from outside the graph). */
function flowInputs(g: LogicalGraph, id: string): string[] {
  const out: string[] = []
  for (const eid of g.edgeOrder) {
    const e = g.edges[eid]
    if (e.to === id && e.from !== undefined && flowEdge(e)) out.push(e.from)
  }
  return out
}

function describeCause(n: LogicalNode): string | undefined {
  const c = n.cause
  if (c === undefined) return undefined
  const where = `${c.kind}${c.id !== undefined ? ` ${c.id}` : ""}`
  return `${where}: ${c.what} (${c.why})`
}

/**
 * Lays the graph out by dataflow depth and collects the rows. Deterministic: levels come from repeated relaxation
 * over graph order, cycle leftovers (unresolvable inputs) all land one level past the deepest resolved node.
 */
export function graphLayout(g: LogicalGraph, tick: number, p: ReconcileParams): GraphLayoutView {
  // Depth: 0 for a node with no flow inputs; else 1 + the deepest input's level, relaxed until nothing changes.
  const level: Record<string, number | undefined> = {}
  let unresolved = g.nodeOrder.length
  for (let pass = 0; pass < g.nodeOrder.length && unresolved > 0; pass++) {
    let changed = false
    unresolved = 0
    for (const id of g.nodeOrder) {
      if (level[id] !== undefined) continue
      const inputs = flowInputs(g, id)
      if (inputs.length === 0) {
        level[id] = 0
        changed = true
        continue
      }
      let max: number | undefined
      for (const src of inputs) {
        const l = level[src]
        if (l === undefined) {
          max = undefined
          break
        }
        if (max === undefined || l > max) max = l
      }
      if (max !== undefined) {
        level[id] = max + 1
        changed = true
      } else unresolved++
    }
    if (!changed) break // cycle leftovers: resolved below, one level past the rest
  }
  let deep = 0
  for (const id of g.nodeOrder) {
    const l = level[id]
    if (l !== undefined && l > deep) deep = l
  }
  // Cycle leftovers (unresolvable inputs) all share one level past the deepest resolved node.
  let anyLeft = false
  for (const id of g.nodeOrder) {
    if (level[id] === undefined) {
      level[id] = deep + 1
      anyLeft = true
    }
  }
  if (anyLeft) deep += 1

  const nodes: GraphNodeRow[] = []
  const statusCounts: Record<NodeStatus, number> = { unknown: 0, ok: 0, expected: 0, starved: 0, "backed-up": 0, unpowered: 0, unfuelled: 0 }
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    const item = n.item
    statusCounts[n.status]++
    nodes.push({
      id,
      role: n.role,
      kind: n.kind,
      item,
      lifecycle: n.lifecycle,
      status: n.status,
      statusReason: n.statusReason,
      level: level[id]!,
      machines: n.measured?.machines,
      measuredOut: item !== undefined && n.measured !== undefined ? rateIn(n.measured.outputs, item) : undefined,
      plannedOut: item !== undefined ? rateIn(n.planned.outputs, item) : 0,
      load: n.kind === "power" ? n.measured?.load : undefined,
      cause: describeCause(n),
    })
  }
  const count = deep + 1
  const levels: GraphNodeRow[][] = []
  for (let i = 0; i < count; i++) levels.push(nodes.filter((n) => n.level === i))

  const edges: GraphEdgeRow[] = []
  for (const eid of g.edgeOrder) {
    const e = g.edges[eid]
    edges.push({
      id: eid,
      kind: e.kind,
      item: e.item,
      from: e.from,
      to: e.to,
      planned: e.plannedRate,
      measured: e.measuredRate,
      verdict: e.kind === "power" ? undefined : edgeVerdict(e, tick, p),
    })
  }
  return { levels, nodes, edges, statusCounts }
}
