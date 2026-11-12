// B202 (`m7-b199` seed 44444, min 283-316): what a relocation's dropped graph nodes leave behind. Pure (T1).

import type { RouteId } from "../shared/ids"
import { LayoutState, tapTree } from "./layout"
import * as LG from "./logical"

/**
 * Removes every belt edge of the dropped nodes (`drop`; an alias goes with all its edges, not only the lost one),
 * then the routes still laid for a removed edge (`droppedRoles` plus those, by connection role; `gone`: routes already
 * abandoned) with what taps them, and every edge running over those routes. Seed 44444's alias n26 of a mine lost one
 * edge over a tap on a retired mine's belt; its healthy edge into a smelter went with the node but its route stayed,
 * `fixed` on the smelter's port, while the design planned the connection again: "no path, sealed" on every attempt.
 * Returns the routes to abandon and the consumers that lost an edge.
 */
export function dropOrphans(g: LG.LogicalGraph, layout: LayoutState, drop: string[], droppedRoles: string[], gone: Record<string, boolean>): { routes: RouteId[]; consumers: string[] } {
  const roles = [...droppedRoles]
  const consumers: string[] = []
  for (const d of drop) {
    for (const eid of [...g.edgeOrder]) {
      const e = g.edges[eid]
      if (e === undefined || e.kind !== "belt" || (e.from !== d && e.to !== d)) continue
      LG.removeEdge(g, eid)
      roles.push(e.role)
      if (e.to !== undefined && e.to !== d && consumers.indexOf(e.to) < 0) consumers.push(e.to)
    }
  }
  const orphans: RouteId[] = []
  for (const role of roles) for (const rid of layout.routeOrder) if (layout.routes[rid]?.conn === role && !gone[rid]) orphans.push(rid)
  if (orphans.length === 0) return { routes: [], consumers }
  const tree = tapTree(layout, orphans)
  const inTree: Record<string, boolean> = {}
  for (const rid of tree) inTree[rid] = true
  for (const eid of [...g.edgeOrder]) {
    const e = g.edges[eid]
    if (e.kind !== "belt" || !(e.physical ?? []).some((rid) => inTree[rid])) continue
    LG.removeEdge(g, eid)
    if (e.to !== undefined && consumers.indexOf(e.to) < 0) consumers.push(e.to)
  }
  return { routes: tree, consumers }
}
