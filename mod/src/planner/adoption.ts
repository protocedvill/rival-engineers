// Provider handover (goalpost 1): which of a retiring provider's routes a replacement adopts. `strategy/fuel.ts`
// `relocate` calls this before it abandons anything, then keeps those routes and re-homes them.
//
// Pure: no Factorio globals (T1: mod/unit/adoption.test.ts).

import type { RouteId } from "../shared/ids"
import type { LayoutState, PortRef } from "./layout"
import type { LogicalEdge, LogicalGraph } from "./logical"

/** One route the retiring provider keeps, re-homed to the replacement connection that now feeds it. */
export interface RouteAdoption {
  rid: RouteId
  /** The replacement edge that now feeds the same consumer port. */
  heir: string
  /** The heir's connection role, which takes the route over. */
  conn: string
  /** The heir's output port: the route logically starts there once the old producer is gone. */
  from: PortRef
}

function built(g: LogicalGraph, edge: LogicalEdge): boolean {
  return edge.from !== undefined && g.nodes[edge.from]?.lifecycle === "built"
}

/**
 * The routes to keep when `node` retires, and the edge that takes each over.
 *
 * A retiring provider's belt to a consumer can only be kept if a replacement side-loads into it: the replacement
 * cannot route into a port that is already fed. The heir is the edge feeding the same consumer port from another node,
 * preferring a built one, so the consumer never loses its belt while the old module is deconstructed.
 */
export function planAdoption(g: LogicalGraph, layout: LayoutState, node: string): RouteAdoption[] {
  const out: RouteAdoption[] = []
  for (const eid of g.edgeOrder) {
    const e = g.edges[eid]
    if (e.kind !== "belt" || e.from !== node || e.toPort === undefined) continue
    let heir: LogicalEdge | undefined
    for (const oid of g.edgeOrder) {
      const o = g.edges[oid]
      if (o === e || o.kind !== "belt" || o.from === undefined || o.from === node) continue
      if (o.to !== e.to || o.toPort !== e.toPort) continue
      if (g.nodes[o.from] === undefined) continue
      if (heir === undefined || (built(g, o) && !built(g, heir))) heir = o
    }
    if (heir === undefined || heir.from === undefined) continue
    const from: PortRef = { module: heir.from, port: heir.fromPort ?? "" }
    for (const rid of e.physical ?? []) {
      const route = layout.routes[rid]
      // Only this connection's own route to that consumer: a tap or a merge route belongs to someone else.
      if (route === undefined || route.conn !== e.role || route.to.module !== e.to || route.to.port !== e.toPort) continue
      out.push({ rid: rid as RouteId, heir: heir.id, conn: heir.role, from })
    }
  }
  return out
}
