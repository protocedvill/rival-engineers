import { mergeGoals } from "../src/planner/merge"
import type { LayoutState, Route, RouteStep } from "../src/planner/layout"
import { routeFeedsPort, routesLand } from "../src/planner/layout"
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

test("B92: a merge never takes a tile a whole-patch mine claims (sweep 922c77c 1264816: a splitter on a future pole's tile)", () => {
  const l = layoutOf([trunk(6)])
  // Claim the tiles beside the trunk on its west side (x 9), as a mine's future poles and drills would.
  l.mine = {}
  for (let y = 8; y < 20; y++) l.mine[tkey(9, y)] = "mine" as never
  const goals = mergeGoals(l, TO, undefined)
  for (const g of goals) {
    const side = g.x2 !== undefined ? { x: g.x2, y: g.y2! } : g.side === "left" ? { x: g.x - DX[(g.dir + 1) % 4], y: g.y - DY[(g.dir + 1) % 4] } : { x: g.x - DX[(g.dir + 3) % 4], y: g.y - DY[(g.dir + 3) % 4] }
    eq(side.x !== 9, true, `goal at ${g.x},${g.y} uses ${side.x},${side.y}, a claimed tile`)
  }
  eq(goals.length > 0, true, "the east side is still offered")
})

test("B94: merge candidates span the whole trunk, not only its nearest stretch (sweep 3e1c4d7 1376111)", () => {
  // The 12 nearest of 174 lay on the trunk's tail in a sealed pocket by the consumer; its head was open.
  const goals = mergeGoals(layoutOf([trunk(80)]), TO, undefined)
  const splitters = goals.filter((g) => g.x2 !== undefined)
  eq(splitters.length <= 12, true, `capped (${splitters.length})`)
  let far = 0
  for (const g of splitters) if (g.y >= 10 + 40) far++
  eq(far > 0, true, `some candidates on the trunk's far half (${far})`)
})

test("M7 (seed 11 g78): a tap sealed in by the base is joined on its trunk, above its splitter", () => {
  // Trunk south from 10,10 to 10,29 (to another consumer); a tap's splitter at 10,20 (second tile 11,20), then east along
  // y = 21 to `consumer.in-coal`, both sides of the tap walled in.
  const t = trunk(20, "in-other")
  const steps: RouteStep[] = [{ kind: "splitter", x: 10, y: 20, dir: 2, x2: 11, y2: 20 } as RouteStep, belt(11, 21, 1), belt(12, 21, 1), belt(13, 21, 1)]
  const tap: Route = { ...trunk(1), id: routeId("r:tap"), conn: connectionId("coal>c=>consumer.in-coal"), steps, tiles: steps.map((x) => tkey(x.x, x.y)), tapOf: t.id, startDir: undefined, length: 4 }
  const s = layoutOf([t, tap])
  for (let x = 11; x <= 13; x++) {
    s.occ[tkey(x, 20)] = "module:wall" as never
    s.occ[tkey(x, 22)] = "module:wall" as never
  }
  const goals = mergeGoals(s, TO, undefined)
  eq(goals.length > 0, true)
  for (const g of goals) {
    eq(g.x, 10)
    eq(g.y < 20, true)
  }
  // A merge there lands on the port through the tap, and the layout check accepts its target.
  const stub: Route = { ...trunk(1), id: routeId("r:stub"), conn: connectionId("coal>new=>consumer.in-coal"), steps: [belt(9, 15, 1)], tiles: [tkey(9, 15)], merge: { x: 10, y: 15, dir: 2, side: "left" } }
  s.routes[stub.id] = stub
  s.routeOrder.push(stub.id)
  for (const r of [t, tap]) for (const k of r.tiles) s.routeOcc[k] = r.id
  const m = { id: "consumer", rect: { x: 14, y: 20, w: 2, h: 2 }, origin: { x: 14, y: 20 }, def: { ports: [{ id: "in-coal", kind: "belt-in", pos: { x: 0.5, y: 1.5 }, dir: 4, item: "coal" }] } }
  s.modules.push(m as never)
  eq(routeFeedsPort(s, t.id, { module: moduleId("consumer"), port: "in-coal" }), true)
  eq(routesLand(s, [stub.id], { module: moduleId("consumer"), port: "in-coal" }), true)
  // Below the splitter the trunk no longer carries the tap's items: nothing is offered there.
  eq(goals.some((g) => g.y >= 20), false)
})

test("B132: a tap whose first splitter is not on its parent route does not make the parent land", () => {
  // Seed 11, minute 180: a re-rooted tap's steps were reversed (first splitter on another route, last splitter on the
  // parent), so it physically led nowhere, but tapsReach followed it to n22 and the repair found "nothing missing".
  const t = trunk(20, "in-other")
  const badSteps: RouteStep[] = [{ kind: "splitter", x: 9, y: 20, dir: 0, x2: 9, y2: 21 } as RouteStep, belt(13, 21, 1)]
  const bad: Route = { ...trunk(1), id: routeId("r:bad"), conn: connectionId("coal>bad=>consumer.in-coal"), steps: badSteps, tiles: badSteps.map((s) => tkey(s.x, s.y)), tapOf: t.id, length: 2 }
  const s = layoutOf([t, bad])
  const m = { id: "consumer", rect: { x: 14, y: 20, w: 2, h: 2 }, origin: { x: 14, y: 20 }, def: { ports: [{ id: "in-coal", kind: "belt-in", pos: { x: 0.5, y: 1.5 }, dir: 4, item: "coal" }] } }
  s.modules.push(m as never)
  eq(routesLand(s, [t.id], TO), false, "a bogus tap does not make its parent land")
  const goodSteps: RouteStep[] = [{ kind: "splitter", x: 10, y: 20, dir: 2, x2: 11, y2: 20 } as RouteStep, belt(11, 21, 1), belt(12, 21, 1), belt(13, 21, 1)]
  const good: Route = { ...trunk(1), id: routeId("r:good"), conn: connectionId("coal>good=>consumer.in-coal"), steps: goodSteps, tiles: goodSteps.map((s) => tkey(s.x, s.y)), tapOf: t.id, length: 4 }
  s.routes[good.id] = good
  s.routeOrder.push(good.id)
  eq(routesLand(s, [t.id], TO), true, "a tap whose splitter is on the trunk lands")
})

test("B122 (seed 11 g78, in game): a belt that merges into the trunk is a merge point too", () => {
  // Trunk south from 10,10 to 10,29 to `consumer.in-coal`, walled in on both sides; a first replacement's belt runs
  // east along y = 12 from x = 2 and side-loads into it at 10,12.
  const t = trunk(20)
  const fsteps: RouteStep[] = []
  for (let x = 2; x <= 9; x++) fsteps.push(belt(x, 12, 1))
  const feeder: Route = { ...trunk(1), id: routeId("r:first"), conn: connectionId("coal>new=>consumer.in-coal"), from: { module: moduleId("mine1"), port: "out" }, steps: fsteps, tiles: fsteps.map((x) => tkey(x.x, x.y)), startDir: 1, length: fsteps.length, merge: { x: 10, y: 12, dir: 2, side: "right" } }
  const s = layoutOf([t, feeder])
  for (const r of [t, feeder]) for (const k of r.tiles) s.routeOcc[k] = r.id
  for (let y = 10; y <= 29; y++) {
    if (y !== 12) s.occ[tkey(9, y)] = "m:wall" as never
    s.occ[tkey(11, y)] = "m:wall" as never
  }
  const goals = mergeGoals(s, TO, undefined)
  eq(goals.length > 0, true)
  // Every goal is on the first replacement's belt, outside the walls.
  for (const g of goals) {
    eq(g.y, 12)
    eq(g.x < 10, true)
  }
  // A second route merging there feeds the port through the first and the trunk.
  eq(routeFeedsPort(s, feeder.id, { module: moduleId("consumer"), port: "in-coal" }), true)
})

test("B174 (m7-fresh4 seed 222, g94-g110): a trunk tile another route already joins is no merge goal", () => {
  // Trunk south down x = 10; one route merges with a splitter at 10,15 (its belt beside it at 11,15), another
  // side-loads at 10,20 from the east. Neither tile may take a second join: two splitters on 10,15 overlapped and the
  // build was rejected before stamping, for 17 goals in a row.
  const t = trunk(20)
  const ms: Route = { ...trunk(1), id: routeId("r:ms"), conn: connectionId("coal>ms=>consumer.in-coal"), steps: [belt(11, 14, 2), { kind: "splitter", x: 10, y: 15, dir: 2, x2: 11, y2: 15 } as RouteStep], tiles: [tkey(11, 14), tkey(11, 15)], mergeSplitter: { x: 10, y: 15, dir: 2, x2: 11, y2: 15 } }
  const sl: Route = { ...trunk(1), id: routeId("r:sl"), conn: connectionId("coal>sl=>consumer.in-coal"), steps: [belt(11, 20, 3)], tiles: [tkey(11, 20)], merge: { x: 10, y: 20, dir: 2, side: "left" } }
  const s = layoutOf([t, ms, sl])
  for (const r of [t, ms, sl]) for (const k of r.tiles) s.routeOcc[k] = r.id
  // Walled in on both sides except beside the two joined tiles.
  for (let y = 10; y <= 29; y++) {
    if (y !== 15 && y !== 20) s.occ[tkey(9, y)] = "m:wall" as never
    if (s.routeOcc[tkey(11, y)] === undefined) s.occ[tkey(11, y)] = "m:wall" as never
  }
  const goals = mergeGoals(s, TO, undefined)
  for (const g of goals) eq(g.x === 10 && (g.y === 15 || g.y === 20), false, `goal at ${g.x},${g.y}`)
})

run("merge")
