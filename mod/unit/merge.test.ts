import { mergeGoals } from "../src/planner/merge"
import type { LayoutState, Route, RouteStep } from "../src/planner/layout"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { DX, DY, tkey } from "../src/planner/grid"
import { eq, run, test } from "./harness"

// T1: provider-group merge candidates (B60). A second producer joins an existing route to the same consumer either by
// side-loading into its belt or, where that is impossible, by a splitter that replaces the trunk tile.

function belt(x: number, y: number, dir: number): RouteStep {
  return { kind: "belt", x, y, dir }
}

/** A trunk running south (dir 2: DX/DY are 0,-1 / 1,0 / 0,1 / -1,0 for N/E/S/W) to `consumer.port`. */
function trunk(len: number, toPort = "in-coal"): Route {
  const steps: RouteStep[] = []
  for (let i = 0; i < len; i++) steps.push(belt(10, 10 + i, 2))
  return {
    id: routeId("r:trunk"),
    conn: connectionId("coal>power=>power.in-coal"),
    item: "coal",
    from: { module: moduleId("old"), port: "out" },
    to: { module: moduleId("consumer"), port: toPort },
    steps,
    tiles: steps.map((s) => tkey(s.x, s.y)),
    spans: [],
    startDir: 2,
    belt: "transport-belt",
    underground: "underground-belt",
    splitter: "splitter",
    length: steps.length,
    undergrounds: 0,
    cost: 1,
    ripped: 0,
  }
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

const TO = { module: "consumer", port: "in-coal" }

test("merge: a free side of the trunk offers both a side-load and a splitter merge", () => {
  const s = layoutOf([trunk(3)])
  const goals = mergeGoals(s, TO, undefined)
  const sides = goals.filter((g) => g.x2 === undefined)
  const splitters = goals.filter((g) => g.x2 !== undefined)
  // Every interior trunk tile has two free sides.
  eq(sides.length > 0, true)
  eq(splitters.length > 0, true)
  // Side-loads come first, so existing layouts keep their proven path.
  eq(goals[0].x2, undefined)
  // A splitter keeps the trunk tile and takes the tile beside it.
  eq(splitters[0].x === 10, true)
  eq(splitters[0].dir, 2)
  eq(splitters[0].x2 !== splitters[0].x || splitters[0].y2 !== splitters[0].y, true)
})

test("merge: an occupied side offers nothing", () => {
  const s = layoutOf([trunk(3)])
  // Block every tile beside the trunk.
  for (let y = 10; y < 13; y++) {
    s.occ[tkey(9, y)] = "module:m" as never
    s.occ[tkey(11, y)] = "module:m" as never
  }
  eq(mergeGoals(s, TO, undefined).length, 0)
})

test("merge: a splitter is not offered when its far output lane holds a belt (items would leak)", () => {
  const s = layoutOf([trunk(3)])
  const first = mergeGoals(s, TO, undefined).filter((g) => g.x2 !== undefined)[0]
  eq(first !== undefined, true)
  // Block the lane past that splitter's second tile: merged items would run into it instead of the trunk.
  s.routeOcc[tkey(first.x2! + DX[first.dir], first.y2! + DY[first.dir])] = routeId("someone")
  const after = mergeGoals(s, TO, undefined)
  eq(after.some((g) => g.x2 === first.x2 && g.y2 === first.y2), false)
  // The side-load form on the same trunk tiles is unaffected.
  eq(after.some((g) => g.x2 === undefined), true)
})

test("merge: a route to another consumer is not a merge target", () => {
  const s = layoutOf([trunk(3, "in-ore")])
  eq(mergeGoals(s, TO, undefined).length, 0)
})

test("merge: the trunk must run straight through for a splitter, but a curve still side-loads", () => {
  // A trunk that turns: the first belt cannot host a splitter (it must leave straight), the rest can.
  const curved: Route = trunk(2)
  curved.steps = [belt(10, 10, 2), { kind: "belt", x: 11, y: 11, dir: 1 }]
  const s = layoutOf([curved])
  const goals = mergeGoals(s, TO, undefined)
  // The turning tile is not entered straight, so it offers no splitter (a side-load is still fine).
  eq(goals.some((g) => g.x === 11 && g.y === 11 && g.x2 !== undefined), false)
  eq(goals.length > 0, true)
})

/** A consumer module taking `rate` coal/s on `in-coal` (what P44's side-load check reads). */
function withConsumer(l: LayoutState, rate: number): LayoutState {
  const m = { id: moduleId("consumer"), def: { ports: [{ id: "in-coal", kind: "belt-in", item: "coal" }], rates: { inputs: [{ item: "coal", perSecond: rate }], outputs: [] } }, rect: { x: 0, y: 30, w: 4, h: 4 } }
  l.modules = [m as never]
  return l
}

test("P44: with a lane given, splitter merges come first; a side-load only when the consumer's demand fits one lane with margin", () => {
  const lane = { capacity: 7.5, share: 0.8 }
  // Old order without `lane`: side-loads first.
  const old = mergeGoals(withConsumer(layoutOf([trunk(6)]), 3), TO, undefined)
  eq(old[0].x2 === undefined, true, "no lane: a side-load first")
  // 3/s fits 0.8 of a lane: splitters first, side-loads after.
  const low = mergeGoals(withConsumer(layoutOf([trunk(6)]), 3), TO, undefined, lane)
  eq(low[0].x2 !== undefined, true, "a splitter merge first")
  let firstSide = -1
  let lastSplit = -1
  for (let i = 0; i < low.length; i++) {
    if (low[i].x2 === undefined && firstSide < 0) firstSide = i
    if (low[i].x2 !== undefined) lastSplit = i
  }
  eq(firstSide > lastSplit, true, "every side-load after every splitter merge")
  // 7/s takes nearly a whole lane: splitter merges only.
  const high = mergeGoals(withConsumer(layoutOf([trunk(6)]), 7), TO, undefined, lane)
  eq(high.length > 0 && high.every((g) => g.x2 !== undefined), true, "no side-load above the share")
  // Unknown demand (no consumer module): splitter merges only.
  const unknown = mergeGoals(layoutOf([trunk(6)]), TO, undefined, lane)
  eq(unknown.every((g) => g.x2 !== undefined), true, "unknown demand: no side-load")
})

run("merge")
