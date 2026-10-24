import { planAdoption } from "../src/planner/adoption"
import type { LayoutState, Route } from "../src/planner/layout"
import { addEdge, addNode, LogicalGraph, newGraph } from "../src/planner/logical"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { eq, run, test } from "./harness"

// T1: provider handover adoption (goalpost 1). `relocate` keeps a retiring provider's belt to a consumer only when a
// replacement side-loads into it, and re-homes it to the replacement connection. This pins the decision; the engine side
// (abandonParts keeping the tiles) is covered by the T2 `P36 (a)` test.

function mounted(g: LogicalGraph, id: string, role: string, built = true): void {
  addNode(g, { id: moduleId(id), role, kind: "module", item: "coal", capacity: { inputs: [], outputs: [{ item: "coal", perSecond: 1 }] }, planned: { inputs: [], outputs: [{ item: "coal", perSecond: 1 }] }, powerW: 0, lifecycle: built ? "built" : "planned", status: "ok", createdTick: 0, builtTick: built ? 0 : undefined })
}

function belt(g: LogicalGraph, id: string, role: string, from: string, to: string, port: string, physical: string[]): void {
  addEdge(g, { id, role, kind: "belt", item: "coal", from: moduleId(from), fromPort: "out", to: moduleId(to), toPort: port, plannedRate: 1, physical })
}

function layoutOf(routes: Route[]): LayoutState {
  const byId: Record<string, Route> = {}
  const order: string[] = []
  for (const r of routes) {
    byId[r.id] = r
    order.push(r.id)
  }
  return { modules: [], routeOrder: order, routes: byId, occ: {}, routeOcc: {}, reserved: {}, revision: 0 } as never as LayoutState
}

function route(id: string, conn: string, toModule: string, toPort: string): Route {
  return {
    id: routeId(id),
    conn: connectionId(conn),
    item: "coal",
    from: { module: moduleId("old"), port: "out" },
    to: { module: moduleId(toModule), port: toPort },
    steps: [{ kind: "belt", x: 4, y: 4, dir: 0 }],
    tiles: [1],
    spans: [],
    belt: "transport-belt",
    underground: "underground-belt",
    splitter: "splitter",
    length: 1,
    undergrounds: 0,
    cost: 1,
    ripped: 0,
  }
}

/** old → power.in-fuel (the retiring provider), and a separate consumer old fed nobody else. */
function world(): { g: LogicalGraph; s: LayoutState } {
  const g = newGraph()
  mounted(g, "old", "coal>power")
  mounted(g, "pw", "power")
  mounted(g, "mall", "mall")
  belt(g, "e:old", "coal>power=>power.in-fuel", "old", "pw", "in-fuel", [routeId("r:old")])
  return { g, s: layoutOf([route("r:old", "coal>power=>power.in-fuel", "pw", "in-fuel")]) }
}

test("adoption: no replacement yet keeps the route with no heir", () => {
  const { g, s } = world()
  eq(planAdoption(g, s, "old").length, 0)
})

test("adoption: a built replacement feeding the same port adopts the belt", () => {
  const { g, s } = world()
  mounted(g, "new", "coal>power#3")
  belt(g, "e:new", "coal>power#3=>power.in-fuel", "new", "pw", "in-fuel", [routeId("r:new")])
  const a = planAdoption(g, s, "old")
  eq(a.length, 1)
  eq(a[0].rid, routeId("r:old"))
  eq(a[0].heir, "e:new")
  eq(a[0].conn, "coal>power#3=>power.in-fuel")
  eq(a[0].from.module, moduleId("new"))
  eq(a[0].from.port, "out")
})

test("adoption: a replacement feeding another consumer port does not count", () => {
  const { g, s } = world()
  mounted(g, "new", "coal>power#3")
  belt(g, "e:new", "coal>power#3=>mall.in-coal", "new", "mall", "in-coal", [routeId("r:new")])
  eq(planAdoption(g, s, "old").length, 0)
})

test("adoption: a built replacement is preferred over one still being built", () => {
  const { g } = world()
  mounted(g, "plan", "coal>power#2", false)
  mounted(g, "new", "coal>power#3")
  belt(g, "e:plan", "coal>power#2=>power.in-fuel", "plan", "pw", "in-fuel", [routeId("r:plan")])
  belt(g, "e:new", "coal>power#3=>power.in-fuel", "new", "pw", "in-fuel", [routeId("r:new")])
  const a = planAdoption(g, { ...layoutOf([]), routes: {} } as never as LayoutState, "old")
  // The old edge's route is gone from the layout, so nothing is adoptable; the heir is still the built one.
  eq(a.length, 0)
  const g2 = newGraph()
  mounted(g2, "old", "coal>power")
  mounted(g2, "pw", "power")
  mounted(g2, "plan", "coal>power#2", false)
  mounted(g2, "new", "coal>power#3")
  belt(g2, "e:old", "coal>power=>power.in-fuel", "old", "pw", "in-fuel", [routeId("r:old")])
  belt(g2, "e:plan", "coal>power#2=>power.in-fuel", "plan", "pw", "in-fuel", [routeId("r:plan")])
  belt(g2, "e:new", "coal>power#3=>power.in-fuel", "new", "pw", "in-fuel", [routeId("r:new")])
  const b = planAdoption(g2, layoutOf([route("r:old", "coal>power=>power.in-fuel", "pw", "in-fuel")]), "old")
  eq(b.length, 1)
  eq(b[0].heir, "e:new")
})

test("adoption: another connection's route is not adopted, only the retiring connection's own", () => {
  const { g } = world()
  mounted(g, "new", "coal>power#3")
  belt(g, "e:new", "coal>power#3=>power.in-fuel", "new", "pw", "in-fuel", [routeId("r:new")])
  // The edge lists two physical routes, but only `r:old` belongs to `coal>power=>power.in-fuel`.
  const e = g.edges["e:old"]
  e.physical = [routeId("r:old"), routeId("r:tap")]
  const s = layoutOf([route("r:old", "coal>power=>power.in-fuel", "pw", "in-fuel"), route("r:tap", "someone-else", "pw", "in-fuel")])
  const a = planAdoption(g, s, "old")
  eq(a.length, 1)
  eq(a[0].rid, routeId("r:old"))
})

run("adoption")
