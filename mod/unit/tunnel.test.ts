// Tunnel crossings (planner/tunnel.ts): a route crossing another route's straight run turns three of its tiles into an
// underground pair instead of ripping it up.

import { beltTiers, tierByBelt } from "../src/planner/capacity"
import { checkClaimOwners } from "../src/planner/claims"
import { asciiTerrain, tkey, TerrainView } from "../src/planner/grid"
import { checkLayout, checkLayoutIndexes, commitModule, commitRoute, LayoutState, newLayout, PlacedModule, Route } from "../src/planner/layout"
import { preparePlanDelta } from "../src/planner/plan-delta"
import { ConnectionRequest, newPlanJob, newRoutingJob, PlanRequest, runJob } from "../src/planner/plan"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { tunnelRoute, tunnelSite } from "../src/planner/tunnel"
import { IDENTITY } from "../src/modules/geometry"
import { ModuleDef, Port, SOUTH, WEST } from "../src/modules/types"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

const YELLOW = beltTiers(F)[0]
const EAST = 1

function policy(changes: Partial<LayoutPolicy["router"]> = {}): LayoutPolicy {
  const p = selectPolicy("early-compact", {})
  return { ...p, router: { ...p.router, ...changes } }
}

function box(id: string, ports: Port[]): ModuleDef {
  return {
    id,
    source: "generated",
    footprint: { w: 1, h: 1 },
    entities: [],
    ports,
    recipes: [],
    machines: [],
    rates: { inputs: [], outputs: [] },
    requiresTech: [],
    rotatable: true,
    mirrorable: true,
  }
}
const source = (id: string, dir: number): ModuleDef => box(id, [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item: "iron-plate" }])
const sink = (id: string, dir: number): ModuleDef => box(id, [{ id: "in", kind: "belt-in", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item: "iron-plate" }])

function place(state: LayoutState, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: moduleId(def.id), canonical: def, def, transform: IDENTITY, origin: { x, y }, rect: { x, y, w: 1, h: 1 } }
  commitModule(state, m, F, 0)
  return m
}

function conn(id: string, from: string, to: string): ConnectionRequest {
  return { id: connectionId(id), from: { module: from, port: "out" }, to: { module: to, port: "in" } }
}

function request(connections: ConnectionRequest[]): PlanRequest {
  return { modules: [], connections, center: { x: 10, y: 10 }, region: { x: 0, y: 0, w: 20, h: 20 } }
}

function maxUg(this: void, name: string): number {
  return tierByBelt(beltTiers(F), name.replace("underground-belt", "transport-belt"))?.maxUnderground ?? 5
}

function noProblems(state: LayoutState, terrain: TerrainView, what: string): void {
  const claims = checkClaimOwners(state)
  if (claims.length > 0) error(`${what} claims: ${claims.join("; ")}`, 2)
  const indexes = checkLayoutIndexes(state)
  if (indexes.problems.length > 0) error(`${what} indexes: ${indexes.problems.join("; ")}`, 2)
  const c = checkLayout(state, terrain, maxUg)
  if (c.problems.length > 0) error(`${what}: ${c.problems.join("; ")}`, 2)
}

/**
 * Route v runs down x = 15 (source at y 0, sink at y 19). The new route comes down a dead-end corridor at x = 14,
 * must turn east over v at (15, 10) and turn south again down x = 16: it turns on both sides of the crossing, so its
 * own underground pair cannot do it (an underground end is never a curve), and every straight underground lands in a
 * wall. Only a tunnel (or ripping v, which then has nowhere to go) connects it.
 */
function arena(): string[] {
  const rows: string[] = []
  for (let y = 0; y < 20; y++) {
    let row = ""
    for (let x = 0; x < 20; x++) {
      const wall = x <= 13 || x >= 17 || (x === 14 && y >= 11) || (x === 16 && y <= 9)
      row += wall ? "X" : "."
    }
    rows.push(row)
  }
  return rows
}

/** Both connections, so a rip-up of v can try to reroute it. */
function both(): PlanRequest {
  return request([conn("v", "v-src", "v-dst"), conn("c", "a", "b")])
}

function withV(terrain: TerrainView): LayoutState {
  const state = newLayout()
  place(state, source("v-src", SOUTH), 15, 0)
  place(state, sink("v-dst", SOUTH), 15, 19)
  place(state, source("a", SOUTH), 14, 0)
  place(state, sink("b", SOUTH), 16, 19)
  const job = runJob(newRoutingJob(request([conn("v", "v-src", "v-dst")]), YELLOW, state), terrain, F, policy())
  eq(job.phase, "done", "v routed")
  eq(state.routes["route:v"].length, 18, "v runs straight down x = 15")
  return state
}

test("tunnel: a crossing that must turn on both sides tunnels the crossed run instead of ripping it", () => {
  const terrain = asciiTerrain(arena())
  const state = withV(terrain)
  const job = runJob(newRoutingJob(request([conn("c", "a", "b")]), YELLOW, state), terrain, F, policy())
  eq(job.phase, "done", `phase (${Object.values(job.failures).join("; ")})`)
  eq(job.stats.tunnels, 1, "one tunnel")
  const v = state.routes["route:v"]
  eq(v.undergrounds, 1, "v gained one underground pair")
  eq(v.length, 17, "v lost the freed tile")
  eq(v.tunnels?.length, 1)
  eq(`${v.tunnels![0].x},${v.tunnels![0].y}`, "15,10")
  ok(v.tiles.indexOf(tkey(15, 10)) < 0, "v no longer holds the crossed tile")
  eq(state.routeOcc[tkey(15, 10)], "route:c", "the new route holds it")
  const kinds = v.steps.filter((s) => s.y >= 8 && s.y <= 12).map((s) => `${s.kind}@${s.y}`).join(",")
  eq(kinds, "belt@8,ug-in@9,ug-out@11,belt@12")
  noProblems(state, terrain, "tunnelled")
})

test("tunnel: off (cost 0), or with the crossed route busy, the crossing over a fixed route fails", () => {
  // A plan on a faction's base never rips its built routes (Route.fixed): there a tunnel is the only way across.
  // (A free v would be ripped and rerouted under c with its own underground: the same result, rebuilt whole.)
  const terrain = asciiTerrain(arena())
  const off = withV(terrain)
  off.routes["route:v"].fixed = true
  const a = runJob(newRoutingJob(both(), YELLOW, off, ["c"]), terrain, F, policy({ tunnel: 0 }))
  eq(a.phase, "failed", "ripping v leaves v nowhere to go")
  ok(off.routes["route:v"]?.tunnels === undefined, "no tunnel")

  const busy = withV(terrain)
  busy.routes["route:v"].fixed = true
  const req = { ...both(), busyRoutes: ["route:v"] }
  eq(runJob(newRoutingJob(req, YELLOW, busy, ["c"]), terrain, F, policy()).phase, "failed", "busy")
  ok(busy.routes["route:v"]?.tunnels === undefined, "a busy route is never tunnelled")
})

test("tunnel: no tunnel without undergrounds (before their technology)", () => {
  const terrain = asciiTerrain(arena())
  const state = withV(terrain)
  eq(runJob(newRoutingJob(both(), { ...YELLOW, maxUnderground: 0 }, state, ["c"]), terrain, F, policy()).phase, "failed")
  ok(state.routes["route:v"]?.tunnels === undefined, "v untouched")
})

test("tunnel: sites refuse the run's ends, parallel crossings, the route itself and tiles next to a tunnel", () => {
  const terrain = asciiTerrain(arena())
  const state = withV(terrain)
  // v's steps are y 1..18. The ports' lanes reserve two tiles at each end (y 1, 2 and 17, 18), and the freed step
  // needs two plain run tiles around it.
  const accepted: number[] = []
  for (let y = 1; y <= 18; y++) if (tunnelSite(state, 15, y, EAST, "route:x") !== undefined) accepted.push(y)
  eq(accepted.join(","), "4,5,6,7,8,9,10,11,12,13,14,15")
  eq(tunnelSite(state, 15, 10, SOUTH, "route:x"), undefined, "a parallel crossing")
  eq(tunnelSite(state, 15, 10, EAST, "route:v"), undefined, "the crossing route itself")
  eq(tunnelSite(state, 15, 10, EAST, "route:x", { "route:v": true }), undefined, "busy")
  eq(tunnelSite(state, 14, 10, EAST, "route:x"), undefined, "no route there")

  // A route side-loading onto (15, 6) rules out sites within two tiles of it: an underground end there would change
  // what the side-load does.
  const joined = withV(terrain)
  const v = joined.routes["route:v"]
  const feeder = { ...v, id: "route:f" as typeof v.id, steps: [], tiles: [], spans: [], merge: { x: 15, y: 6, dir: SOUTH, side: "left" as const } }
  joined.routes[feeder.id] = feeder
  joined.routeOrder.push(feeder.id)
  const joinedOk: number[] = []
  for (let y = 1; y <= 18; y++) if (tunnelSite(joined, 15, y, EAST, "route:x") !== undefined) joinedOk.push(y)
  eq(joinedOk.join(","), "9,10,11,12,13,14,15")

  eq(tunnelRoute(state, 15, 10, EAST, "route:x"), "route:v")
  noProblems(state, terrain, "after one tunnel")
  // The new pair's ends and the tiles feeding them are no longer a plain straight run of four.
  for (const y of [8, 9, 11, 12]) eq(tunnelSite(state, 15, y, EAST, "route:x"), undefined, `next to the tunnel (y ${y})`)
  ok(tunnelSite(state, 15, 7, EAST, "route:x") !== undefined, "before the entrance: the new exit outputs into it")
  ok(tunnelSite(state, 15, 13, EAST, "route:x") !== undefined, "after the exit: fed straight by the ug-out")
  eq(tunnelRoute(state, 15, 13, EAST, "route:x"), "route:v")
  eq(state.routes["route:v"].undergrounds, 2)
  noProblems(state, terrain, "after two tunnels")
})

test("tunnel: a plan's delta rebuilds only the crossed run of a base route", () => {
  const terrain = asciiTerrain(arena())
  const base = withV(terrain)
  const job = runJob(newPlanJob(request([conn("c", "a", "b")]), YELLOW, base), terrain, F, policy())
  eq(job.phase, "done", `phase (${Object.values(job.failures).join("; ")})`)
  ok(base.routes["route:v"].tunnels === undefined, "the base layout is not changed by planning")
  const ready = preparePlanDelta({ sourceRevision: job.sourceRevision, layout: job.layout, baseModules: job.baseModules, baseRoutes: job.baseRoutes }, base)
  eq(ready.status, "ready")
  if (ready.status !== "ready") return
  eq(ready.delta.reworked.length, 1)
  const r = ready.delta.reworked[0]
  eq(r.route, "route:v")
  const fmt = (es: { name: string; x: number; y: number }[]) => es.map((e) => `${e.name}@${e.y}`).sort().join(",")
  eq(fmt(r.remove), "transport-belt@10.5,transport-belt@11.5,transport-belt@9.5")
  eq(fmt(r.add), "underground-belt@11.5,underground-belt@9.5")
  eq(ready.delta.add.routes.join(","), "route:c", "v is not re-added whole")
})

/**
 * B172 (m7-benchLayers14, g227): trunk v down x = 15; a tap of v must reach w-dst on the west, and the only way west is
 * the gap at (14, 12). The tap splits east of v, runs down x = 16 and tunnels under v at (15, 12). Split at (15, 11),
 * the tunnel's entrance would be the splitter's own tile: the splitter replaced the entrance and cut v (its consumer
 * got nothing, and every repair found "nothing missing").
 */
function tapArena(): string[] {
  const rows: string[] = []
  for (let y = 0; y < 20; y++) {
    let row = ""
    for (let x = 0; x < 20; x++) row += x >= 17 || (x === 14 && y !== 12) || (x <= 13 && y !== 12) ? "X" : "."
    rows.push(row)
  }
  return rows
}

test("B172: a tap that tunnels under its own trunk keeps its splitter off the tunnel's run", () => {
  const terrain = asciiTerrain(tapArena())
  const state = newLayout()
  place(state, source("v-src", SOUTH), 15, 0)
  place(state, sink("v-dst", SOUTH), 15, 19)
  place(state, sink("w-dst", WEST), 10, 12)
  const p: LayoutPolicy = { ...policy(), topology: "splitter-tap" }
  eq(runJob(newRoutingJob(request([conn("v", "v-src", "v-dst")]), YELLOW, state), terrain, F, p).phase, "done", "v routed")
  const job = runJob(newRoutingJob(request([conn("w", "v-src", "w-dst")]), YELLOW, state), terrain, F, p)
  eq(job.phase, "done", `phase (${Object.values(job.failures).join("; ")})`)
  const w = state.routes["route:w"]
  eq(w.tapOf, "route:v", "w taps v")
  eq(job.stats.tunnels, 1, "w tunnels under v")
  const sp = w.steps[0]
  const under = state.routes["route:v"].steps.find((s) => s.x === sp.x && s.y === sp.y)
  eq(`${under?.kind}`, "belt", `the splitter at ${sp.x},${sp.y} stands on a belt of v`)
  noProblems(state, terrain, "tap tunnel")
})

/**
 * B174 (m7-fresh4 seed 222): trunk v down x = 15; u (a second producer for v-dst) joins v with a merge splitter at
 * (15, 12), its belt beside it at (16, 11..12). A tap of v must reach w-dst on the west through the only gap, (14, 12)
 * then row 13: splitting there would put a second splitter on u's trunk tile.
 */
function joinArena(): string[] {
  const rows: string[] = []
  for (let y = 0; y < 20; y++) {
    let row = ""
    for (let x = 0; x < 20; x++) row += x >= 17 || (x === 14 && y !== 12 && y !== 13) || (x <= 13 && y !== 13) ? "X" : "."
    rows.push(row)
  }
  return rows
}

test("B174: a tap never splits on a trunk tile another route's merge splitter replaced", () => {
  const terrain = asciiTerrain(joinArena())
  const state = newLayout()
  place(state, source("v-src", SOUTH), 15, 0)
  place(state, sink("v-dst", SOUTH), 15, 19)
  place(state, source("u-src", SOUTH), 16, 10)
  place(state, sink("w-dst", WEST), 10, 13)
  const p: LayoutPolicy = { ...policy(), topology: "splitter-tap" }
  eq(runJob(newRoutingJob(request([conn("v", "v-src", "v-dst")]), YELLOW, state), terrain, F, p).phase, "done", "v routed")
  const ms = { x: 15, y: 12, dir: 2, x2: 16, y2: 12 }
  const u: Route = {
    id: routeId("route:u"), conn: connectionId("u"), item: "iron-plate", from: { module: moduleId("u-src"), port: "out" }, to: { module: moduleId("v-dst"), port: "in" },
    steps: [{ kind: "belt", x: 16, y: 11, dir: 2 }, { kind: "splitter", ...ms }], tiles: [tkey(16, 11), tkey(16, 12)], spans: [],
    belt: "transport-belt", underground: "underground-belt", splitter: "splitter", length: 1, undergrounds: 0, cost: 1, ripped: 0, mergeSplitter: ms, fixed: true,
  }
  commitRoute(state, u)
  noProblems(state, terrain, "u merges into v")
  const job = runJob(newRoutingJob(request([conn("w", "v-src", "w-dst")]), YELLOW, state), terrain, F, p)
  const w = state.routes["route:w"]
  ok(w === undefined || w.steps[0].x !== 15 || w.steps[0].y !== 12, `w splits at ${w?.steps[0].x},${w?.steps[0].y} (${job.phase})`)
  if (job.phase === "done") noProblems(state, terrain, "w taps v")
})

run("tunnel")
