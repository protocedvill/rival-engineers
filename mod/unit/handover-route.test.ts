import { adoptRoute } from "../src/planner/layout"
import { portFedByOther } from "../src/planner/plan"
import type { LayoutState, Route } from "../src/planner/layout"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { eq, run, test } from "./harness"

// T1: provider handover route adoption (goalpost 1). `relocate` keeps a retiring provider's belt when its replacement
// side-loads into it, and re-homes it to the replacement connection instead of ripping it with the module.

function route(): Route {
  return {
    id: routeId("route:1"),
    conn: connectionId("coal>power#4=>power.in-fuel"),
    item: "coal",
    from: { module: moduleId("n27"), port: "out" },
    to: { module: moduleId("n1"), port: "in-fuel" },
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

function layout(r: Route): LayoutState {
  const routes: Record<string, Route> = {}
  routes[r.id] = r
  return { modules: [], routeOrder: [r.id], routes, occ: {}, routeOcc: {}, reserved: {}, revision: 0 } as never as LayoutState
}

test("adopt route: the replacement connection takes the belt over where it lies", () => {
  const r = route()
  const s = layout(r)
  const from = { module: moduleId("n99"), port: "out" }
  eq(adoptRoute(s, r.id, connectionId("coal>power#5=>power.in-fuel"), from) !== undefined, true)
  eq(r.conn, connectionId("coal>power#5=>power.in-fuel"))
  eq(r.from?.module, moduleId("n99"))
  eq(r.from?.port, "out")
  // The laid belt is untouched: same consumer, same tiles, same steps.
  eq(r.to.module, moduleId("n1"))
  eq(r.to.port, "in-fuel")
  eq(r.tiles.length, 1)
  eq(r.steps.length, 1)
  eq(s.routeOrder.length, 1)
})

test("adopt route: a missing route is a no-op, not a crash", () => {
  const s = layout(route())
  eq(adoptRoute(s, routeId("route:missing"), connectionId("x"), undefined), undefined)
})

test("B93: a kept route gets an id of its own and stays a feed the same-role replacement joins (sweep 3e1c4d7 1376111)", () => {
  // D55: the replacement mine has the worked-out mine's role, so the same connection name. Kept as route:<conn>, the belt
  // bore the id the replacement's own route takes, and it did not count as a feed: every plan routed into the port it
  // holds ("no path").
  const r = route()
  r.id = routeId("route:iron-ore>plate=>plate.in-ore")
  r.conn = connectionId("iron-ore>plate=>plate.in-ore")
  r.to = { module: moduleId("smelt"), port: "in-ore" }
  r.tiles = [10, 11]
  const s = layout(r)
  s.routeOcc[10] = r.id
  s.routeOcc[11] = r.id
  const nid = adoptRoute(s, r.id, connectionId("iron-ore>plate=>plate.in-ore"), { module: moduleId("n79"), port: "out" })!
  eq(nid !== routeId("route:iron-ore>plate=>plate.in-ore"), true, "a new id")
  eq(s.routes[nid] === r && s.routes["route:iron-ore>plate=>plate.in-ore"] === undefined, true, "moved")
  eq(s.routeOrder[0], nid, "in route order")
  eq(s.routeOcc[10] === nid && s.routeOcc[11] === nid, true, "its tiles follow")
  eq(portFedByOther(s, { module: moduleId("smelt"), port: "in-ore" }, "iron-ore>plate=>plate.in-ore"), true, "a feed for the same-named connection")
})

run("handover-route")
