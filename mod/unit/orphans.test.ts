import { newLayout, Route } from "../src/planner/layout"
import { addEdge, addNode, LogicalGraph, LogicalNode, newGraph } from "../src/planner/logical"
import { dropOrphans } from "../src/planner/orphans"
import { ConnectionId, moduleId, RouteId } from "../src/shared/ids"
import { eq, run, test } from "./harness"

// T1: B202 (`m7-b199` seed 44444, min 283-316). planner/orphans.ts `dropOrphans`.

function node(g: LogicalGraph, id: string): void {
  addNode(g, { id: moduleId(id), role: id, kind: "production", item: "x", lifecycle: "built", status: "unknown", createdTick: 0 } as unknown as LogicalNode)
}

function belt(g: LogicalGraph, id: string, from: string, to: string, route: string): void {
  addEdge(g, { id, role: id, kind: "belt", item: "iron-ore", from: moduleId(from), to: moduleId(to), plannedRate: 1, physical: [route as RouteId] })
}

test("B202: a dropped alias takes all its edges, their surviving routes and what taps them", () => {
  const g = newGraph()
  for (const id of ["n16", "n26", "labs", "n27", "n40", "n50"]) node(g, id)
  // The alias n26 lost its labs edge (over a tap on the retired mine's belt): the relocation removed it already.
  // Its other edge into the smelter n27 is healthy, and n40's route taps that one; n50's edge is unrelated.
  belt(g, "n26>n27.in-ore", "n26", "n27", "route:a")
  belt(g, "n16>n40.in-ore", "n16", "n40", "route:b")
  belt(g, "n16>n50.in-ore", "n16", "n50", "route:c")
  const layout = newLayout()
  const route = (id: string, conn: string, tapOf?: string): void => {
    layout.routes[id as RouteId] = { id, conn: conn as ConnectionId, tapOf: tapOf as RouteId | undefined } as unknown as Route
    layout.routeOrder.push(id as RouteId)
  }
  route("route:t", "n26>labs.in-ore")
  route("route:a", "n26>n27.in-ore")
  route("route:b", "n16>n40.in-ore", "route:a")
  route("route:c", "n16>n50.in-ore")
  const out = dropOrphans(g, layout, ["n26"], ["n26>labs.in-ore"], { "route:t": true })
  eq(out.routes.join(","), "route:a,route:b", "the alias's surviving route and its tap go; the abandoned one is not taken twice")
  eq(g.edgeOrder.join(","), "n16>n50.in-ore", "only the unrelated edge stays")
  const consumers = [...out.consumers]
  consumers.sort()
  eq(consumers.join(","), "n27,n40", "the consumers that lost an edge")
})

run("orphans")
