import { assemblerRow, labArray, miningOutpost, smelterColumn, steamBlock } from "../src/modules/generators"
import { IDENTITY, Transform, transformModule } from "../src/modules/geometry"
import { connectionId, moduleId, routeId, poleId, poleLineId, layoutClaimTag } from "../src/shared/ids"
import { EAST, ModuleDef, NORTH, Port, SOUTH } from "../src/modules/types"
import { availableTiers, beltTiers, checkEdge, decideOverflow, tierByBelt } from "../src/planner/capacity"
import { checkClaimOwners, claimPoleTile } from "../src/planner/claims"
import { routeEntities } from "../src/planner/build-list"
import { buildGraph } from "../src/planner/graph"
import { asciiTerrain, FREE, keyX, keyY, TerrainView, tkey, WATER } from "../src/planner/grid"
import { bumpLayout, checkLayout, checkLayoutIndexes, commitModule, commitRoute, findModule, layoutRevision, LayoutState, newLayout, PlacedModule, Route, unmarkModule } from "../src/planner/layout"
import { LANE_HOP, laneWayOut, placeNow } from "../src/planner/placement"
import { preparePlanDelta } from "../src/planner/plan-delta"
import { cloneLayout, ConnectionRequest, newPlanJob, newRoutingJob, planNow, PlanRequest, replacementAvoid, runJob } from "../src/planner/plan"
import { EARLY_COMPACT, LayoutPolicy, packingScorer, placementTerms, policyIds, registerPolicy, selectPolicy } from "../src/planner/policy"
import { newTraceSink, planTrace } from "../src/planner/trace"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

const TIERS = beltTiers(F)
const YELLOW = TIERS[0]
const FAST = TIERS[1]

function policy(changes: Partial<LayoutPolicy> = {}): LayoutPolicy {
  return { ...selectPolicy("early-compact", {}), ...changes }
}

/** A synthetic module: an empty w × h box with the given ports. */
function box(id: string, w: number, h: number, ports: Port[]): ModuleDef {
  return {
    id,
    source: "generated",
    footprint: { w, h },
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

/** A 1×1 source (out port facing `dir`) or sink (in port flowing `dir`). */
function source(id: string, dir: number, item = "iron-plate"): ModuleDef {
  return box(id, 1, 1, [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item }])
}
function sink(id: string, dir: number, item = "iron-plate", side?: "left" | "right"): ModuleDef {
  return box(id, 1, 1, [{ id: "in", kind: "belt-in", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item, side }])
}

/** A 1×1 module holding one entity, so a prepared build list has something to place. */
function machine(id: string, name = "burner-mining-drill"): ModuleDef {
  return { ...box(id, 1, 1, []), entities: [{ name, x: 0.5, y: 0.5 }] }
}

function place(state: LayoutState, def: ModuleDef, x: number, y: number, t: Transform = IDENTITY): PlacedModule {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  const m: PlacedModule = { id: moduleId(def.id), canonical: def, def: d, transform: t, origin: { x, y }, rect: { x, y, w: d.footprint.w, h: d.footprint.h } }
  commitModule(state, m, F, 0)
  return m
}

function conn(id: string, from: string | undefined, to: string, toPort = "in"): ConnectionRequest {
  return { id: connectionId(id), from: from !== undefined ? { module: from, port: "out" } : undefined, to: { module: to, port: toPort } }
}

function request(modules: ModuleDef[], connections: ConnectionRequest[], w = 60, h = 60): PlanRequest {
  return { modules: modules.map((def) => ({ id: def.id, def })), connections, center: { x: math.floor(w / 2), y: math.floor(h / 2) }, region: { x: 0, y: 0, w, h } }
}

function maxUg(this: void, name: string): number {
  return tierByBelt(TIERS, name.replace("underground-belt", "transport-belt"))?.maxUnderground ?? 5
}

function noProblems(state: LayoutState, terrain: TerrainView, what: string): void {
  const claims = checkClaimOwners(state)
  if (claims.length > 0) error(`${what} claims: ${claims.join("; ")}`, 2)
  const indexes = checkLayoutIndexes(state)
  if (indexes.problems.length > 0) error(`${what} indexes: ${indexes.problems.join("; ")}`, 2)
  const c = checkLayout(state, terrain, maxUg)
  if (c.problems.length > 0) error(`${what}: ${c.problems.join("; ")}`, 2)
}

test("layout revisions survive clones and structural index drift is reported", () => {
  const state = newLayout()
  eq(layoutRevision(state), 0)
  place(state, source("source", EAST), 2, 2)
  eq(layoutRevision(state), 1)
  const copy = cloneLayout(state)
  eq(layoutRevision(copy), 1)
  eq(checkLayoutIndexes(copy).problems.length, 0)

  const tile = tkey(2, 2)
  copy.occ[tile] = layoutClaimTag("m:some-other-module")
  const problems = checkLayoutIndexes(copy).problems
  ok(problems.some((p) => p.indexOf("module source tile 2,2 indexed as m:some-other-module") >= 0), problems.join("; "))
})

test("plan delta is prepared once from a current base and rejects a stale interleaving", () => {
  const base = newLayout()
  place(base, source("base", EAST), 2, 2)
  const job = newPlanJob(request([], []), YELLOW, base)
  place(job.layout, source("added", EAST), 4, 2)

  const ready = preparePlanDelta({
    sourceRevision: job.sourceRevision,
    layout: job.layout,
    baseModules: job.baseModules,
    baseRoutes: job.baseRoutes,
  }, base)
  eq(ready.status, "ready")
  if (ready.status === "ready") {
    eq(ready.delta.baseRevision, 1)
    eq(ready.delta.candidateRevision, 2)
    eq(ready.delta.add.modules.join(","), "added")
    eq(ready.delta.remove.modules.length, 0)
  }

  const removal = newPlanJob(request([], []), YELLOW, base)
  const removed = findModule(removal.layout, "base")!
  unmarkModule(removal.layout, removed, F)
  removal.layout.modules = []
  const removedDelta = preparePlanDelta({
    sourceRevision: removal.sourceRevision,
    layout: removal.layout,
    baseModules: removal.baseModules,
    baseRoutes: removal.baseRoutes,
  }, base)
  eq(removedDelta.status, "ready")
  if (removedDelta.status === "ready") eq(removedDelta.delta.remove.modules.join(","), "base")

  // Model the interleaving: plan A copied revision 1, then another logical change B committed before A adopted.
  bumpLayout(base)
  const stale = preparePlanDelta({
    sourceRevision: job.sourceRevision,
    layout: job.layout,
    baseModules: job.baseModules,
    baseRoutes: job.baseRoutes,
  }, base)
  eq(stale.status, "rejected")
  if (stale.status === "rejected") eq(stale.code, "stale-base-revision")
})

test("plan delta refuses a candidate whose derived indexes drifted", () => {
  const base = newLayout()
  place(base, source("base", EAST), 2, 2)
  const job = newPlanJob(request([], []), YELLOW, base)
  job.layout.occ[tkey(2, 2)] = layoutClaimTag("m:wrong")
  const result = preparePlanDelta({
    sourceRevision: job.sourceRevision,
    layout: job.layout,
    baseModules: job.baseModules,
    baseRoutes: job.baseRoutes,
  }, base)
  eq(result.status, "rejected")
  if (result.status === "rejected") {
    eq(result.code, "invalid-layout-indexes")
    ok(result.detail.indexOf("module base tile 2,2 indexed as m:wrong") >= 0, result.detail)
  }

  const orphaned = newPlanJob(request([], []), YELLOW, base)
  orphaned.layout.occ[tkey(8, 8)] = layoutClaimTag("m:missing")
  const orphanResult = preparePlanDelta({
    sourceRevision: orphaned.sourceRevision,
    layout: orphaned.layout,
    baseModules: orphaned.baseModules,
    baseRoutes: orphaned.baseRoutes,
  }, base)
  eq(orphanResult.status, "rejected")
  if (orphanResult.status === "rejected") eq(orphanResult.code, "invalid-layout-claims")
})

test("plan delta derives logical and claim evidence once, in deterministic order", () => {
  const base = newLayout()
  place(base, source("base", EAST), 2, 2)
  const job = newPlanJob(request([], []), YELLOW, base)
  place(job.layout, source("added", EAST), 4, 2)
  const mine = place(job.layout, source("mine", EAST), 10, 2)
  // A whole-patch mine's claim is part of the ground the adapter must reserve (B23 / D52). Its unbuilt plan has an
  // empty `occupied`, so its own footprint contributes nothing until it completes; the claim covers the ground.
  mine.minePlan = { full: mine.canonical, claim: [tkey(6, 2), tkey(7, 2)], occupied: [], complete: false }
  // A tap's base route is listed before the tap itself, in routeOrder.
  const route = (id: string, conn: string, tapOf?: string): Route => ({
    id: routeId(id),
    conn: connectionId(conn),
    item: "iron-plate",
    to: { module: "added", port: "in" },
    steps: [],
    tiles: [],
    spans: [],
    belt: "transport-belt",
    underground: "underground-belt",
    splitter: "splitter",
    length: 0,
    undergrounds: 0,
    cost: 0,
    ripped: 0,
    tapOf: tapOf !== undefined ? routeId(tapOf) : undefined,
  })
  commitRoute(job.layout, route("r1", "a"))
  commitRoute(job.layout, route("r2", "b", "r1"))
  claimPoleTile(job.layout, tkey(8, 2), "poles:g1:0")
  job.layout.poles = [{ id: poleId("p1"), name: "small-electric-pole", x: 8, y: 2, line: poleLineId("poles:g1:0") }]
  job.layout.poleLines = [{ id: poleLineId("poles:g1:0"), to: moduleId("added"), from: "?", poles: [poleId("p1")] }]

  const input = {
    sourceRevision: job.sourceRevision,
    layout: job.layout,
    baseModules: job.baseModules,
    baseRoutes: job.baseRoutes,
    addedPoles: [poleId("p1")],
  }
  const result = preparePlanDelta(input, base)
  eq(result.status, "ready")
  if (result.status !== "ready") return
  eq(result.delta.add.modules.join(","), "added,mine")
  eq((result.delta.logical.routesByConn["a"] ?? []).join(","), "r1")
  eq((result.delta.logical.routesByConn["b"] ?? []).join(","), "r1,r2", "a tap's base route comes first")
  eq(result.delta.logical.poleLines.map((l) => `${l.id}->${l.to}`).join(","), "poles:g1:0->added")
  eq(result.delta.claims.mineClaims.length, 1)
  eq(result.delta.claims.mineClaims[0].module, "mine")
  eq(result.delta.claims.mineClaims[0].tiles.join(","), `${tkey(6, 2)},${tkey(7, 2)}`)
  const taken = result.delta.claims.takenTiles
  ok(taken.indexOf(tkey(4, 2)) >= 0, "the new module's footprint")
  ok(taken.indexOf(tkey(8, 2)) >= 0, "the new pole's tile")
  ok(taken.indexOf(tkey(6, 2)) >= 0 && taken.indexOf(tkey(7, 2)) >= 0, "the mine's claim")
  ok(taken.indexOf(tkey(2, 2)) < 0, "not the base module's ground")
  const seen: Record<number, boolean> = {}
  let dupes = 0
  for (const k of taken) {
    if (seen[k]) dupes++
    seen[k] = true
  }
  eq(dupes, 0, "deduped")

  const again = preparePlanDelta(input, base)
  eq(again.status, "ready")
  if (again.status === "ready") eq(again.delta.claims.takenTiles.join(","), taken.join(","), "deterministic")
})

test("plan delta prepares the entities a completed base mine adds (B23)", () => {
  const base = newLayout()
  const n6 = place(base, machine("n6"), 2, 2)
  // The mine was planned earlier; this plan completes it. `occupied` is the mine's built footprint (moduleTiles).
  n6.minePlan = { full: n6.canonical, claim: [tkey(2, 2)], occupied: [tkey(2, 2)], complete: true }
  const job = newPlanJob(request([], []), YELLOW, base)
  const input = {
    sourceRevision: job.sourceRevision,
    layout: job.layout,
    baseModules: job.baseModules,
    baseRoutes: job.baseRoutes,
    // req2 names a module that is not in the base: it must not produce a completion.
    expanded: { req1: { module: "n6", units: 1 }, req2: { module: "nope", units: 1 } },
  }
  const result = preparePlanDelta(input, base)
  eq(result.status, "ready")
  if (result.status !== "ready") return
  eq(result.delta.mineCompletions.length, 1, "only the built mine")
  eq(result.delta.mineCompletions[0].module, "n6")
  eq(result.delta.mineCompletions[0].entities.length, 1)
  eq(result.delta.mineCompletions[0].entities[0].name, "burner-mining-drill")
  near(result.delta.mineCompletions[0].entities[0].x, 2.5)
  near(result.delta.mineCompletions[0].entities[0].y, 2.5)

  const candidate = findModule(job.layout, "n6")!
  candidate.minePlan!.complete = false
  const incomplete = preparePlanDelta(input, base)
  eq(incomplete.status, "ready")
  if (incomplete.status === "ready") eq(incomplete.delta.mineCompletions.length, 0, "an incomplete mine adds nothing")
})

// --- Router primitives --------------------------------------------------------------------------------------

// B28: a route's window is the endpoints ± `router.margin` (24); an obstacle filling that whole band walls the
// pair off even when a detour exists just past it (m6a2-accept2 seed 3333: every feed into the mall failed at
// every region radius, because placement retries widen the region, never these windows). The route ladder now
// widens the window (×3, then ×9) before giving up.
test("router: a wall filling the margin band is detoured with a widened window", () => {
  const rows = field(80, 200)
  for (let x = 18; x <= 24; x++) setCol(rows, x, 80, 120, "~")
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 2, 100)
  place(state, b, 60, 100)
  const job = runJob(newRoutingJob(request([a, b], [conn("c", "a", "b")], 80, 200), YELLOW, state), terrain, F, policy())
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  // The path must have left the ±24 band: its tiles pass the water's rows (80..120) somewhere.
  let detoured = false
  for (const [, r] of pairs(job.layout.routes)) {
    for (const t of r.tiles) {
      const y = keyY(t)
      if (y < 80 || y > 120) detoured = true
    }
  }
  ok(detoured, "the route detoured around the band")
})

function field(w: number, h: number, ch = "."): string[] {
  const rows: string[] = []
  for (let y = 0; y < h; y++) rows.push(string.rep(ch, w))
  return rows
}

function setCol(rows: string[], x: number, y1: number, y2: number, ch: string): void {
  for (let y = y1; y <= y2; y++) rows[y] = rows[y].substring(0, x) + ch + rows[y].substring(x + 1)
}

function routeOne(state: LayoutState, terrain: TerrainView, pol: LayoutPolicy, c: ConnectionRequest, modules: ModuleDef[], tier = YELLOW) {
  const job = runJob(newRoutingJob(request(modules, [c]), tier, state), terrain, F, pol)
  return job
}

// --- Router primitives --------------------------------------------------------------------------------------

test("router: straight route from an out port to an in port", () => {
  const terrain = asciiTerrain(field(30, 10))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 2, 5)
  place(state, b, 20, 5)
  const job = routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b])
  eq(job.phase, "done", "phase")
  const r = state.routes["route:c"]
  eq(r.length, 17, "belt tiles 3..19")
  eq(r.undergrounds, 0, "undergrounds")
  noProblems(state, terrain, "straight")
})

/** A long field with staggered walls (gaps alternate top and bottom) between x 2 and x 200. */
function longMaze(): string[] {
  const rows = field(220, 80)
  for (let wx = 30; wx < 190; wx += 30) {
    const gapTop = (wx / 30) % 2 === 0
    for (let y = 0; y < 80; y++) if (gapTop ? y > 12 : y < 66) rows[y] = rows[y].substring(0, wx) + "#" + rows[y].substring(wx + 1)
  }
  return rows
}

test("router: two-level routing finds a long route with far fewer expansions, about as short", () => {
  const terrain = asciiTerrain(longMaze())
  const run1 = (longRoute: number) => {
    const state = newLayout()
    const a = source("a", EAST)
    const b = sink("b", EAST)
    place(state, a, 2, 40)
    place(state, b, 205, 40)
    const p = policy()
    const job = routeOne(state, terrain, { ...p, router: { ...p.router, longRoute } }, conn("c", "a", "b"), [a, b])
    return { job, route: state.routes["route:c"] }
  }
  const two = run1(64)
  const one = run1(0)
  eq(two.job.phase, "done", `two-level (${two.job.failures})`)
  eq(one.job.phase, "done", "one-level")
  ok(two.job.stats.expansions * 2 < one.job.stats.expansions, `expansions ${two.job.stats.expansions} vs ${one.job.stats.expansions}`)
  ok(two.route.cost <= one.route.cost * 1.1, `cost ${two.route.cost} vs ${one.route.cost}`)
})

test("router: two-level routing falls back to the whole window when its corridor has no way through", () => {
  // An unknown-ground wall (no underground passes it) at x 100 with its one gap at y 62, outside the straight corridor.
  const rows = field(220, 80)
  for (let y = 0; y < 80; y++) if (y !== 62) rows[y] = rows[y].substring(0, 100) + "?" + rows[y].substring(101)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 2, 40)
  place(state, b, 205, 40)
  const job = routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b])
  eq(job.phase, "done", `routed (${job.failures})`)
  let through = false
  for (const k of state.routes["route:c"].tiles) if (keyX(k) === 100 && keyY(k) === 62) through = true
  ok(through, "through the gap")
})

/** A 160×80 field with a ring of unknown ground (no underground passes it) around (120, 40), with an optional gap. */
function ringed(gap: boolean): string[] {
  const rows = field(160, 80)
  for (let y = 33; y <= 47; y++) {
    for (let x = 113; x <= 127; x++) {
      const edge = x === 113 || x === 127 || y === 33 || y === 47
      if (!edge || (gap && x === 113 && y === 40)) continue
      rows[y] = rows[y].substring(0, x) + "?" + rows[y].substring(x + 1)
    }
  }
  return rows
}

// Seal check (user, 2026-10-20): a boxed-in port proves "no path" from its side's few tiles instead of the search
// exhausting the window and every retry (seed11-green-boxed replay: 1.76M routing work, 20 searches → 19k, 8).
test("router: the seal check proves a boxed-in port unreachable cheaply, and changes nothing when a way exists", () => {
  const run1 = (gap: boolean, sealCheck: number) => {
    const state = newLayout()
    const a = source("a", EAST)
    const b = sink("b", EAST)
    place(state, a, 2, 40)
    place(state, b, 120, 40)
    const p = policy()
    const job = routeOne(state, asciiTerrain(ringed(gap)), { ...p, router: { ...p.router, sealCheck } }, conn("c", "a", "b"), [a, b])
    return { job, route: state.routes["route:c"] }
  }
  const sealed = run1(false, 2000)
  const plain = run1(false, 0)
  eq(sealed.job.phase, "failed", "boxed in: fails with the check")
  eq(plain.job.phase, "failed", "boxed in: fails without it")
  ok(sealed.job.stats.routeWork * 20 < plain.job.stats.routeWork, `routing work ${sealed.job.stats.routeWork} vs ${plain.job.stats.routeWork}`)
  ok(sealed.job.stats.searches < plain.job.stats.searches, `searches ${sealed.job.stats.searches} vs ${plain.job.stats.searches} (no window widening)`)
  const open = run1(true, 2000)
  const openPlain = run1(true, 0)
  eq(open.job.phase, "done", "with a gap: routed")
  eq(openPlain.job.phase, "done", "with a gap: routed without the check")
  eq(open.route.cost, openPlain.route.cost, "same route cost")
})

test("router: turns to reach a port that faces another way, arriving with the port's direction", () => {
  const terrain = asciiTerrain(field(30, 30))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", SOUTH)
  place(state, a, 2, 2)
  place(state, b, 20, 20)
  const job = routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b])
  eq(job.phase, "done", "phase")
  const r = state.routes["route:c"]
  eq(r.steps[r.steps.length - 1].dir, 2, "last belt points south")
  noProblems(state, terrain, "turns")
})

test("router: underground across a 3-wide river; fails across 5 with yellow (max 4 between), works with fast", () => {
  const rows = field(30, 12)
  for (const x of [12, 13, 14]) setCol(rows, x, 0, 11, "~")
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 2, 5)
  place(state, b, 25, 5)
  eq(routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b]).phase, "done", "3-wide")
  eq(state.routes["route:c"].undergrounds, 1, "one underground")
  noProblems(state, terrain, "river 3")

  const rows6 = field(30, 12)
  for (const x of [11, 12, 13, 14, 15, 16]) setCol(rows6, x, 0, 11, "~")
  const t6 = asciiTerrain(rows6)
  const s6 = newLayout()
  place(s6, a, 2, 5)
  place(s6, b, 25, 5)
  eq(routeOne(s6, t6, policy(), conn("c", "a", "b"), [a, b]).phase, "failed", "6-wide river, yellow")
  const s6f = newLayout()
  place(s6f, a, 2, 5)
  place(s6f, b, 25, 5)
  eq(routeOne(s6f, t6, policy(), conn("c", "a", "b"), [a, b], FAST).phase, "done", "6-wide river, fast (max 6 between)")
  const ug = s6f.routes["route:c"].steps.filter((s) => s.kind === "ug-in")[0]
  const out = s6f.routes["route:c"].steps.filter((s) => s.kind === "ug-out")[0]
  ok(out.x - ug.x <= 7 && out.x - ug.x >= 7, "fast underground spans 7")
  noProblems(s6f, t6, "river 6 fast")
})

test("router: never enters a module footprint, goes around (or under, when allowed)", () => {
  const terrain = asciiTerrain(field(40, 30))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const wall = box("wall", 3, 20, [])
  place(state, a, 2, 15)
  place(state, b, 30, 15)
  place(state, wall, 15, 5)
  eq(routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b, wall]).phase, "done", "routed")
  eq(state.routes["route:c"].undergrounds, 0, "no underground under the module by default")
  noProblems(state, terrain, "around")
  const s2 = newLayout()
  place(s2, a, 2, 15)
  place(s2, b, 30, 15)
  place(s2, wall, 15, 5)
  const pol = policy()
  pol.router = { ...pol.router, underModules: true }
  routeOne(s2, terrain, pol, conn("c", "a", "b"), [a, b, wall])
  eq(s2.routes["route:c"].undergrounds, 1, "under the 3-wide module when allowed")
})

test("router: B60 merge side-loads a second provider into an existing route without a blocker", () => {
  const terrain = asciiTerrain(field(40, 30))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const c = source("c", EAST)
  place(state, a, 2, 5)
  place(state, b, 20, 5)
  eq(routeOne(state, terrain, policy(), conn("primary", "a", "b"), [a, b]).phase, "done", "primary route")
  place(state, c, 2, 15)
  const primary = state.routes["route:primary"]
  const primaryTiles = [...primary.tiles]
  const merge = conn("merge", "c", "b")
  merge.merge = true
  // The side-load mechanism itself: the pre-P44 order (side-loads first, no lane check).
  const sideFirst = policy()
  sideFirst.router = { ...sideFirst.router }
  sideFirst.router.sideLoadLaneShare = undefined
  const job = routeOne(state, terrain, sideFirst, merge, [c])
  let why = ""
  for (const [k, v] of pairs(job.failures)) why += `${k as string}: ${v as string}; `
  eq(job.phase, "done", `merge route (${why})`)
  const r = state.routes["route:merge"]
  ok(r.merge !== undefined, "the route records its merge target")
  eq(r.blocker, undefined, "a merge has no blocker belt")
  eq(state.routes["route:primary"].tiles.join(","), primaryTiles.join(","), "the existing route is preserved")
  eq(state.routeOcc[tkey(r.merge!.x, r.merge!.y)], "route:primary", "the merge ends on the existing route")
  noProblems(state, terrain, "merge")
})

test("router: P44 a second provider joins an existing route with a splitter by default (user: avoid side-loading)", () => {
  const terrain = asciiTerrain(field(40, 30))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const c = source("c", EAST)
  place(state, a, 2, 5)
  place(state, b, 20, 5)
  eq(routeOne(state, terrain, policy(), conn("primary", "a", "b"), [a, b]).phase, "done", "primary route")
  place(state, c, 2, 15)
  const merge = conn("merge", "c", "b")
  merge.merge = true
  const job = routeOne(state, terrain, policy(), merge, [c])
  let why = ""
  for (const [k, v] of pairs(job.failures)) why += `${k as string}: ${v as string}; `
  eq(job.phase, "done", `merge route (${why})`)
  const r = state.routes["route:merge"]
  ok(r.mergeSplitter !== undefined && r.merge === undefined, "a splitter merge, not a side-load")
  noProblems(state, terrain, "splitter merge")
})

test("router: B89 a merge whose trunk is gone routes into the free port itself (vps-b88b-r1264816-m60)", () => {
  const terrain = asciiTerrain(field(40, 30))
  const state = newLayout()
  const b = sink("b", EAST)
  const c = source("c", EAST)
  place(state, b, 20, 5)
  place(state, c, 2, 15)
  // A reroute keeps the connection's merge flag, but the trunk it joined is no longer there.
  const merge = conn("merge", "c", "b")
  merge.merge = true
  const job = routeOne(state, terrain, policy(), merge, [c])
  let why = ""
  for (const [k, v] of pairs(job.failures)) why += `${k as string}: ${v as string}; `
  eq(job.phase, "done", `routed (${why})`)
  const r = state.routes["route:merge"]
  ok(r.merge === undefined && r.mergeSplitter === undefined, "a plain route into the port")
  noProblems(state, terrain, "plain")
})

test("router: side constraint: arrives from the required side over an unfed blocker belt", () => {
  const terrain = asciiTerrain(field(30, 20))
  for (const side of ["left", "right"] as const) {
    const state = newLayout()
    const a = source("a", EAST)
    const b = sink("b", NORTH, "iron-plate", side)
    place(state, a, 2, 10)
    place(state, b, 20, 10)
    eq(routeOne(state, terrain, policy(), conn("c", "a", "b"), [a, b]).phase, "done", `${side}: routed`)
    const r = state.routes["route:c"]
    const last = r.steps[r.steps.length - 1]
    // Port flows north: its left is west, so a left side-load comes from the west tile heading east.
    eq(last.dir, side === "left" ? 1 : 3, `${side}: arrival heading`)
    eq(last.x, side === "left" ? 19 : 21, `${side}: arrival tile`)
    ok(r.blocker !== undefined && r.blocker.x === 20 && r.blocker.y === 11 && r.blocker.dir === 0, `${side}: blocker south of the port`)
    noProblems(state, terrain, side)
  }
})

test("router: trees are passable at a clearing cost; avoided when the policy says so", () => {
  const rows = field(30, 30)
  setCol(rows, 14, 0, 29, "T")
  const terrain = asciiTerrain(rows)
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const s1 = newLayout()
  place(s1, a, 2, 15)
  place(s1, b, 25, 15)
  eq(routeOne(s1, terrain, policy(), conn("c", "a", "b"), [a, b]).phase, "done", "through trees")
  ok(s1.routeOcc[tkey(14, 15)] !== undefined, "clears the tree in line")
  const s2 = newLayout()
  place(s2, a, 2, 15)
  place(s2, b, 25, 15)
  const pol = policy({ obstacles: { trees: "avoid", rocks: "avoid", maxClearCost: 0 } })
  eq(routeOne(s2, terrain, pol, conn("c", "a", "b"), [a, b]).phase, "done", "under the tree line")
  eq(s2.routes["route:c"].undergrounds, 1, "an underground passes under the trees")
})

test("router: rip-up and reroute when an earlier route takes the only way through", () => {
  // A wall at x = 10 with gaps at y = 2 and y = 10; a pocket (walls x = 8 and x = 12 below y = 8, open at y = 10)
  // closed at the top (y = 7) holds C's endpoints, which can only meet through (9..11, 10). A was routed straight through there first.
  const rows = field(21, 20)
  setCol(rows, 10, 0, 19, "?")
  for (const y of [2, 10]) rows[y] = rows[y].substring(0, 10) + "." + rows[y].substring(11)
  setCol(rows, 8, 8, 19, "?")
  setCol(rows, 12, 8, 19, "?")
  for (const x of [8, 12]) rows[10] = rows[10].substring(0, x) + "." + rows[10].substring(x + 1)
  rows[7] = rows[7].substring(0, 8) + "?????" + rows[7].substring(13)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const as = source("as", EAST)
  const ak = sink("ak", EAST)
  const cs = source("cs", NORTH)
  const ck = sink("ck", SOUTH)
  place(state, as, 6, 10)
  place(state, ak, 14, 10)
  place(state, cs, 9, 16)
  place(state, ck, 11, 16)
  const conns = [conn("A", "as", "ak"), conn("C", "cs", "ck")]
  const req = request([as, ak, cs, ck], conns, 21, 20)
  const pol = policy()
  // Route A alone first: straight through the pocket.
  runJob(newRoutingJob(req, YELLOW, state, ["A"]), terrain, F, pol)
  eq(state.routes["route:A"].length, 7, "A straight")
  const job = runJob(newRoutingJob(req, YELLOW, state, ["C"]), terrain, F, pol)
  eq(job.phase, "done", `phase (${serpentLine(job.failures)})`)
  ok(job.stats.ripups >= 1, "ripped A")
  ok(state.routes["route:A"] !== undefined && state.routes["route:C"] !== undefined, "both routed")
  // A comes back around the wall or dives under C's belts with an underground: either is a valid crossing.
  eq(job.ripCount.A, 1, "A ripped once")
  ok(state.routeOcc[tkey(10, 10)] === "route:C", "C holds the pocket's gap")
  noProblems(state, terrain, "rip-up")
})

function serpentLine(t: Record<string, string>): string {
  const parts: string[] = []
  for (const [k, v] of pairs(t)) parts.push(`${k}=${v}`)
  return parts.join(", ")
}

test("router: splitter tap feeds a second consumer from an existing route (splitter-tap topology)", () => {
  const terrain = asciiTerrain(field(40, 30))
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const c = sink("c", SOUTH)
  place(state, a, 2, 10)
  place(state, b, 30, 10)
  place(state, c, 20, 22)
  const conns = [conn("ab", "a", "b"), conn("ac", "a", "c")]
  const req = request([a, b, c], conns, 40, 30)
  const p2p = runJob(newRoutingJob(req, YELLOW, newLayoutWith(state)), terrain, F, policy())
  eq(p2p.phase, "failed", "point-to-point refuses a second consumer on one port")
  const job = runJob(newRoutingJob(req, YELLOW, state, ["ab", "ac"]), terrain, F, policy({ topology: "splitter-tap" }))
  eq(job.phase, "done", "tap routed")
  const tap = state.routes["route:ac"]
  eq(tap.tapOf, "route:ab", "tap of the first route")
  eq(tap.steps[0].kind, "splitter", "starts with a splitter")
  noProblems(state, terrain, "tap")
  const g = buildGraph(state, policy({ topology: "splitter-tap" }), { tiers: TIERS, researched: {} })
  eq(g.physical.edges.length, 2, "two physical edges")
  eq(g.logical.edges[1].physical.length, 2, "the tapped flow maps to trunk + branch")
})

test("plan: a module whose port is walled in is re-placed elsewhere, then routed", () => {
  const rows = field(40, 30)
  // A closed pocket of unknown land around (33, 8).
  for (let y = 5; y <= 11; y++) for (let x = 30; x <= 36; x++) if (x === 30 || x === 36 || y === 5 || y === 11) rows[y] = rows[y].substring(0, x) + "?" + rows[y].substring(x + 1)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 5, 20)
  place(state, b, 33, 8)
  const job = newRoutingJob(request([a, b], [conn("c", "a", "b")], 40, 30), YELLOW, state)
  job.replaced = {} // planned by this job: allowed to move
  runJob(job, terrain, F, policy())
  eq(job.phase, "done", `phase (${serpentLine(job.failures)})`)
  eq(job.stats.replacements, 1, "one re-placement")
  const moved = findModule(state, "b")!
  ok(moved.rect.x !== 33 || moved.rect.y !== 8, "b moved out of the pocket")
  noProblems(state, terrain, "re-placed")
})

test("build list: a splitter tap replaces the tapped belt; undergrounds carry their type", () => {
  const rows = field(40, 30)
  setCol(rows, 12, 0, 29, "~")
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  const c = sink("c", SOUTH)
  place(state, a, 2, 10)
  place(state, b, 30, 10)
  place(state, c, 20, 22)
  runJob(newRoutingJob(request([a, b, c], [conn("ab", "a", "b"), conn("ac", "a", "c")], 40, 30), YELLOW, state, ["ab", "ac"]), terrain, F, policy({ topology: "splitter-tap" }))
  const tap = state.routes["route:ac"].steps[0]
  const specs = routeEntities(state)
  let splitters = 0
  let beltOnTap = 0
  let ugIn = 0
  let ugOut = 0
  for (const e of specs) {
    if (e.name === "splitter") splitters++
    if (e.name === "transport-belt" && math.floor(e.x) === tap.x && math.floor(e.y) === tap.y) beltOnTap++
    if (e.ioType === "input") ugIn++
    if (e.ioType === "output") ugOut++
  }
  eq(splitters, 1, "one splitter")
  eq(beltOnTap, 0, "no belt under the splitter")
  ok(ugIn >= 1 && ugIn === ugOut, "underground pairs over the river")
})

function newLayoutWith(src: LayoutState): LayoutState {
  const s = newLayout()
  for (const m of src.modules) commitModule(s, m, F, 0)
  return s
}

// --- Placement ----------------------------------------------------------------------------------------------

test("placement: compact next to the partner, at least the minimum corridor away, port facing it", () => {
  const terrain = asciiTerrain(field(60, 60))
  const state = newLayout()
  const pol = policy()
  const a = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const ma = place(state, a, 20, 20)
  const b = assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })
  const out = ma.def.ports.filter((p) => p.id === "out")[0]
  const target = { x: 20 + math.floor(out.pos.x), y: 20 + math.floor(out.pos.y) - 1 }
  const s = placeNow({ id: "b", def: b, targets: { "in-iron-plate": target }, center: { x: 25, y: 25 }, region: { x: 0, y: 0, w: 60, h: 60 } }, state, terrain, pol)
  eq(s.phase, "done", "placed")
  const m = s.result!
  const r = m.rect
  const gapX = math.max(r.x - (ma.rect.x + ma.rect.w), ma.rect.x - (r.x + r.w))
  const gapY = math.max(r.y - (ma.rect.y + ma.rect.h), ma.rect.y - (r.y + r.h))
  ok(math.max(gapX, gapY) >= pol.corridor.min, `gap ≥ min (gaps ${gapX}, ${gapY})`)
  ok(math.max(gapX, gapY) <= pol.corridor.preferred + 2, `compact (gaps ${gapX}, ${gapY})`)
  const port = m.def.ports.filter((p) => p.id === "in-iron-plate")[0]
  const px = r.x + math.floor(port.pos.x)
  const py = r.y + math.floor(port.pos.y)
  ok(math.abs(px - target.x) + math.abs(py - target.y) <= 20, `input port near the smelter's output (${px},${py} vs ${target.x},${target.y})`)
})

test("placement: M7 an expandable module's window holds the growth band it scores, not its whole cap", () => {
  // m7-seed11-blue-wide: a blue-pack assembler row may grow ~300 tiles; its window was 711×224 at the smallest radius.
  const terrain = asciiTerrain(field(400, 400))
  const row = assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })
  const def = { ...row, expand: { ...row.expand!, maxUnits: 60 } }
  const s = placeNow({ id: "g", def, targets: {}, center: { x: 200, y: 200 }, region: { x: 0, y: 0, w: 400, h: 400 } }, newLayout(), terrain, policy())
  eq(s.phase, "done", "placed")
  const R = policy().searchRadii[0]
  ok(s.ww < 2 * R + 120, `window ${s.ww}×${s.wh} near the radius (${2 * R + 1} tiles of origins)`)
})

test("placement trace: same decision with the trace on; score terms sum to the score; rejections name their blocker", () => {
  const rows = field(50, 50)
  for (let y = 15; y < 35; y++) rows[y] = string.rep(".", 15) + string.rep("i", 20) + string.rep(".", 15)
  const terrain = asciiTerrain(rows)
  const def = assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })
  const req = { id: "g", def, targets: {}, center: { x: 25, y: 25 }, region: { x: 0, y: 0, w: 50, h: 50 } }
  const off = placeNow(req, newLayout(), terrain, policy())
  planTrace.sink = newTraceSink()
  const on = placeNow(req, newLayout(), terrain, policy())
  const sink = planTrace.sink
  planTrace.sink = undefined
  eq(on.candidates, off.candidates, "candidates scored")
  eq(on.result!.rect.x, off.result!.rect.x, "x")
  eq(on.result!.rect.y, off.result!.rect.y, "y")
  eq(on.trace, undefined, "the accumulator leaves the search when it ends")
  eq(sink.placements.length, 1, "one placement traced")
  const p = sink.placements[0]
  const c = p.chosen!
  eq(c.origin.x, on.result!.rect.x, "chosen x")
  let total = 0
  for (const [, v] of pairs(placementTerms(c.features, policy()))) total += v as number
  near(total, c.score, 1e-6, "terms sum to the score")
  near(packingScorer("compact-cluster")(c.features, policy()), c.score, 1e-6, "the scorer agrees")
  ok(p.top.length > 1 && p.top[0].score <= p.top[1].score, "runners-up sorted by score")
  const ore = p.rejected["ore"]
  ok(ore !== undefined && ore.count > 0, "ore rejections counted")
  ok(string.find(ore.examples[0].blocker, "ore iron-ore", 1, true)[0] !== undefined, `the blocker names the ore (${ore.examples[0].blocker})`)
})

test("placement: keeps off water, cliffs, structures and ore; corridor min is configurable", () => {
  const rows = field(50, 50)
  for (let y = 15; y < 35; y++) rows[y] = string.rep(".", 15) + string.rep("i", 20) + string.rep(".", 15)
  setCol(rows, 10, 0, 49, "C")
  rows[5] = string.rep("~", 50)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const def = assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })
  const s = placeNow({ id: "g", def, targets: {}, center: { x: 25, y: 25 }, region: { x: 0, y: 0, w: 50, h: 50 } }, state, terrain, policy())
  eq(s.phase, "done", "placed")
  const r = s.result!.rect
  for (let x = r.x; x < r.x + r.w; x++) {
    for (let y = r.y; y < r.y + r.h; y++) {
      eq(terrain.block(x, y), FREE, `free at ${x},${y}`)
      eq(terrain.ore(x, y), undefined, `no ore at ${x},${y}`)
    }
  }
  const p = selectPolicy("auto", {}, { corridorMin: 3, corridorPreferred: 4 })
  eq(p.corridor.min, 3, "override min")
  eq(p.corridor.preferred, 4, "override preferred")
})

test("placement: steam block lands on a shore (anchor water tiles are water)", () => {
  const rows = field(70, 50)
  for (let y = 0; y < 50; y++) rows[y] = string.rep("~", 12) + rows[y].substring(12)
  const terrain = asciiTerrain(rows)
  const def = steamBlock(F, { boilers: 1 })
  const s = placeNow({ id: "steam", def, targets: {}, center: { x: 40, y: 25 }, region: { x: 0, y: 0, w: 70, h: 50 } }, newLayout(), terrain, policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  const m = s.result!
  for (const w of m.def.anchor!.water!) {
    for (let x = w.x; x < w.x + w.w; x++) for (let y = w.y; y < w.y + w.h; y++) eq(terrain.block(m.origin.x + x, m.origin.y + y), WATER, "anchor water")
  }
  for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++) for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++) eq(terrain.block(x, y), FREE, "footprint on land")
})

test("placement: mining outpost lands on its patch with its drills over ore", () => {
  const rows = field(60, 60)
  for (let y = 40; y < 56; y++) rows[y] = string.rep(".", 35) + string.rep("i", 14) + string.rep(".", 11)
  for (let y = 5; y < 15; y++) rows[y] = string.rep(".", 5) + string.rep("c", 10) + rows[y].substring(15)
  const terrain = asciiTerrain(rows)
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const s = placeNow({ id: "mine", def, targets: {}, center: { x: 20, y: 20 }, region: { x: 0, y: 0, w: 60, h: 60 } }, newLayout(), terrain, policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  ok(s.best!.coverage >= 0.9, `coverage ${s.best!.coverage}`)
  const m = s.result!
  for (const a of m.def.anchor!.miningAreas!) {
    let n = 0
    for (let x = a.x; x < a.x + a.w; x++) for (let y = a.y; y < a.y + a.h; y++) if (terrain.ore(m.origin.x + x, m.origin.y + y) === "iron-ore") n++
    ok(n >= 0.6 * a.w * a.h, "drill area on iron")
  }
})

/** A thin iron strip (2 rows: no drill area gets enough ore) near the centre and a full patch at x 320..339. */
function deadAndFarRows(): string[] {
  const rows = field(360, 40)
  for (let y = 19; y < 21; y++) rows[y] = string.rep(".", 12) + string.rep("i", 40) + rows[y].substring(52)
  for (let y = 10; y < 30; y++) rows[y] = rows[y].substring(0, 320) + string.rep("i", 20) + rows[y].substring(340)
  return rows
}

test("placement B50 / D57: a mine whose nearest patch has no room goes on to the next patch (seed 3333)", () => {
  const terrain = asciiTerrain(deadAndFarRows())
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const s = placeNow({ id: "mine", def, targets: {}, center: { x: 5, y: 20 }, region: { x: 0, y: 0, w: 360, h: 40 } }, newLayout(), terrain, policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  ok(s.result!.origin.x >= 310, `on the far patch (x ${s.result!.origin.x})`)
  eq(s.patches?.length, 2, "two patches with enough free ore")
  eq(s.patchesTried, 2, "the strip first, then the far patch")
})

test("placement D57 (b): a patch with too little free ore for the drill areas is never searched", () => {
  const rows = field(80, 40)
  for (let y = 18; y < 21; y++) rows[y] = string.rep(".", 12) + "iii" + rows[y].substring(15)
  for (let y = 10; y < 30; y++) rows[y] = rows[y].substring(0, 50) + string.rep("i", 20) + rows[y].substring(70)
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const s = placeNow({ id: "mine", def, targets: {}, center: { x: 5, y: 20 }, region: { x: 0, y: 0, w: 80, h: 40 } }, newLayout(), asciiTerrain(rows), policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  eq(s.patches?.length, 1, "the 3×3 remnant is no patch")
  eq(s.patchesTried, 1, "one window search")
})

test("placement D57 (c): a patch remembered as full under the same terrain stamp is skipped", () => {
  const base = asciiTerrain(deadAndFarRows())
  const terrain = { block: base.block, ore: base.ore, stamp: () => "s1" }
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const req = { id: "mine", def, targets: {}, center: { x: 5, y: 20 }, region: { x: 0, y: 0, w: 360, h: 40 } }
  const first = placeNow(req, newLayout(), terrain, policy())
  eq(first.phase, "done", `placed (${first.reason})`)
  let dead = 0
  for (const [k] of pairs(first.deadFound ?? {})) if (string.find(k as string, "iron-ore:12,", 1, true)[0] !== undefined) dead++
  eq(dead, 1, "the strip is remembered")
  const again = placeNow({ ...req, dead: first.deadFound }, newLayout(), terrain, policy())
  eq(again.phase, "done", `placed again (${again.reason})`)
  eq(again.result!.origin.x, first.result!.origin.x, "same place")
  ok(again.candidates < first.candidates, `fewer candidates (${again.candidates} < ${first.candidates})`)
  const changed = placeNow({ ...req, dead: first.deadFound }, newLayout(), { ...terrain, stamp: () => "s2" }, policy())
  eq(changed.candidates, first.candidates, "searched again once the terrain changed")
})

test("placement D57: a fresh field counts `newField` tiles farther than a field the faction already mines", () => {
  // Fresh patch A at x 160..179 (60 tiles from the centre); patch B at x 200..239 holds an existing mine (100 tiles).
  const rows = field(260, 40)
  for (let y = 10; y < 30; y++) rows[y] = rows[y].substring(0, 160) + string.rep("i", 20) + rows[y].substring(180, 200) + string.rep("i", 40) + rows[y].substring(240)
  const terrain = asciiTerrain(rows)
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const req = { id: "mine", def, targets: {}, center: { x: 100, y: 20 }, region: { x: 0, y: 0, w: 260, h: 40 } }
  const layout = (): LayoutState => {
    const st = newLayout()
    const old = place(st, { ...def, id: "old" }, 228, 11)
    old.fixed = true
    return st
  }
  const s = placeNow(req, layout(), terrain, policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  ok(s.result!.origin.x >= 195, `on the field already mined (x ${s.result!.origin.x})`)
  const p0 = policy()
  const s0 = placeNow(req, layout(), terrain, { ...p0, placement: { ...p0.placement, newField: 0 } })
  ok(s0.result!.origin.x < 185, `newField 0: the nearer fresh field (x ${s0.result!.origin.x})`)
})

test("placement: mining outpost on a mixed patch keeps every drill area free of the second ore (B6)", () => {
  // Iron with copper specks every 6 tiles, except a pure corner: only the corner may take the outpost.
  const rows = field(80, 80)
  for (let y = 20; y < 70; y++) {
    let r = string.rep(".", 10)
    for (let x = 10; x < 70; x++) r += x % 6 === 0 && y % 6 === 0 && !(x >= 48 && y >= 48) ? "c" : "i"
    rows[y] = r + string.rep(".", 10)
  }
  const terrain = asciiTerrain(rows)
  const def = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })
  const s = placeNow({ id: "mine", def, targets: {}, center: { x: 20, y: 20 }, region: { x: 0, y: 0, w: 80, h: 80 } }, newLayout(), terrain, policy())
  eq(s.phase, "done", `placed (${s.reason})`)
  const m = s.result!
  for (const a of m.def.anchor!.miningAreas!) {
    for (let x = a.x; x < a.x + a.w; x++) {
      for (let y = a.y; y < a.y + a.h; y++) {
        const ore = terrain.ore(m.origin.x + x, m.origin.y + y)
        ok(ore === undefined || ore === "iron-ore", `drill area reaches ${ore} at ${m.origin.x + x},${m.origin.y + y}`)
      }
    }
  }
  // All mixed: no spot.
  const mixed = field(80, 80)
  for (let y = 20; y < 70; y++) {
    let r = string.rep(".", 10)
    for (let x = 10; x < 70; x++) r += x % 6 === 0 && y % 6 === 0 ? "c" : "i"
    mixed[y] = r + string.rep(".", 10)
  }
  const none = placeNow({ id: "mine", def, targets: {}, center: { x: 20, y: 20 }, region: { x: 0, y: 0, w: 80, h: 80 } }, newLayout(), asciiTerrain(mixed), policy())
  eq(none.phase, "failed", "no pure spot on an all-mixed patch")
  ok((none.rejections?.["foreign-ore"]?.count ?? 0) > 0, "failure certificate identifies mixed ore")
  ok(none.rejections?.["foreign-ore"]?.sample !== undefined, "failure certificate retains a representative tile")
})

test("policy: expand-first grows an existing module when there is room, places a new one when blocked", () => {
  const terrain = asciiTerrain(field(80, 80))
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const pol = policy()
  const req: PlanRequest = {
    modules: [
      { id: "s1", def },
      { id: "s2", def, expandUnits: 1 },
    ],
    connections: [],
    center: { x: 40, y: 40 },
    region: { x: 0, y: 0, w: 80, h: 80 },
  }
  const job = planNow(req, YELLOW, terrain, F, pol)
  eq(job.phase, "done", "planned")
  eq(job.layout.modules.length, 1, "one module, grown")
  eq(job.expanded.s2?.module, "s1", "s2 satisfied by growing s1")
  eq(findModule(job.layout, "s1")!.canonical.machines[0].count, 8, "8 furnaces after growth")
  const newFirst = planNow(req, YELLOW, terrain, F, policy({ expansion: "new-module-first" }))
  eq(newFirst.layout.modules.length, 2, "new-module-first places a copy")
  // A wall of cliffs hugging s1 on all sides: it cannot grow, so expand-first places a copy.
  const s1 = planNow({ ...req, modules: [req.modules[0]] }, YELLOW, terrain, F, pol).layout.modules[0]
  const rows = field(80, 80)
  const r = s1.rect
  for (let y = r.y - 1; y <= r.y + r.h; y++) for (const x of [r.x - 1, r.x + r.w]) rows[y] = rows[y].substring(0, x) + "C" + rows[y].substring(x + 1)
  for (const y of [r.y - 1, r.y + r.h]) rows[y] = rows[y].substring(0, r.x) + string.rep("C", r.w) + rows[y].substring(r.x + r.w)
  // Leave the ports' outside tiles open.
  for (const p of s1.def.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = { x: s1.origin.x + math.floor(p.pos.x), y: s1.origin.y + math.floor(p.pos.y) + (p.kind === "belt-in" ? 1 : -1) }
    rows[o.y] = rows[o.y].substring(0, o.x) + "." + rows[o.y].substring(o.x + 1)
  }
  // Without B26's own-band check s1 takes the walled-in spot again (it is still the best one by distance).
  const walled = planNow(req, YELLOW, asciiTerrain(rows), F, { ...pol, placement: { ...pol.placement, growthBlocked: 0 } })
  eq(walled.layout.modules.length, 2, "blocked growth → a new module")
  // B26: weighted enough, s1 avoids the spot where it could not grow, and grows. (At the default 3 per blocked near
  // unit the walled spot still wins: moving costs more than the 6 the two blocked near units add.)
  const b26 = planNow(req, YELLOW, asciiTerrain(rows), F, { ...pol, placement: { ...pol.placement, growthBlocked: 20 } })
  eq(b26.layout.modules.length, 1, "B26: s1 is placed where it can grow, and grows")
})

test("policy: selection by config and by applies(); new policies register without touching the planner", () => {
  eq(selectPolicy("auto", {}).id, "early-compact", "auto")
  eq(selectPolicy("", {}).id, "early-compact", "empty")
  const [okUnknown] = pcall(() => selectPolicy("nope", {}))
  ok(!okUnknown, "unknown id errors")
  registerPolicy({ ...EARLY_COMPACT, id: "test-late", applies: (ctx) => ((ctx.modules ?? 0) >= 40 ? 2 : 0) })
  eq(selectPolicy("auto", { modules: 50 }).id, "test-late", "late stage picks the late policy")
  eq(selectPolicy("auto", { modules: 3 }).id, "early-compact", "early stage keeps early-compact")
  ok(policyIds().indexOf("test-late") >= 0, "registered")
  eq(selectPolicy("auto", {}, { topology: "splitter-tap", utilization: 0.9 }).topology, "splitter-tap", "topology override")
})

// --- Capacity and overflow (§5.8, D24, D25) ------------------------------------------------------------------

test("capacity: tiers from prototypes: 15/30/45 per belt, 7.5/15/22.5 per lane; max underground 5/7/9", () => {
  eq(TIERS.length, 3, "tiers")
  near(TIERS[0].laneCapacity, 7.5, 1e-9, "yellow lane")
  near(TIERS[1].laneCapacity, 15, 1e-9, "red lane")
  near(TIERS[2].laneCapacity, 22.5, 1e-9, "blue lane")
  eq(TIERS[0].maxUnderground, 5, "yellow ug")
  eq(TIERS[2].maxUnderground, 9, "blue ug")
  eq(TIERS[1].tech, "logistics-2", "red needs logistics-2")
})

test("capacity: planned vs usable at the 99% cap; one lane is half; endpoints can bind", () => {
  const e = { tier: YELLOW, lanes: 2, utilization: 0.99 }
  const a = checkEdge(14.85, e)
  ok(a.ok, "14.85 fits")
  near(a.usable, 14.85, 1e-9, "usable")
  near(a.utilization, 0.99, 1e-9, "utilization")
  const b = checkEdge(15, e)
  ok(!b.ok && b.limitedBy === "belt", "15/s on yellow overflows at 99%")
  ok(!checkEdge(7.5, { ...e, lanes: 1 }).ok, "one lane: 7.5 > 7.425")
  ok(checkEdge(15, { ...e, utilization: 1 }).ok, "15 fits at 100%")
  eq(checkEdge(5, { ...e, producerMax: 3.75 }).limitedBy, "producer", "producer-limited")
  eq(checkEdge(5, { ...e, consumerMax: 4 }).limitedBy, "consumer", "consumer-limited")
})

test("overflow: upgrade if researched, else parallel routes, else a new producer cluster", () => {
  const order = EARLY_COMPACT.overflow.order
  const edge = { tier: YELLOW, lanes: 2, utilization: 0.99 }
  eq(decideOverflow({ demand: 10, edge, available: TIERS, order, maxParallel: 2 }).action, "none", "fits")
  const up = decideOverflow({ demand: 20, edge, available: availableTiers(TIERS, { "logistics-2": true }), order, maxParallel: 2 })
  eq(up.action, "upgrade-tier", "upgrade when red is researched")
  eq((up as { belt: string }).belt, "fast-transport-belt", "to red")
  const blue = decideOverflow({ demand: 40, edge, available: TIERS, order, maxParallel: 2 })
  eq((blue as { belt: string }).belt, "express-transport-belt", "smallest sufficient tier")
  const par = decideOverflow({ demand: 20, edge, available: availableTiers(TIERS, {}), order, maxParallel: 2 })
  eq(par.action, "parallel-route", "no research → parallel")
  eq((par as { routes: number }).routes, 2, "two routes")
  eq(decideOverflow({ demand: 40, edge, available: availableTiers(TIERS, {}), order, maxParallel: 2 }).action, "new-producer-cluster", "too much for 2 yellow")
  eq(decideOverflow({ demand: 5, edge: { ...edge, producerMax: 3.75 }, available: TIERS, order, maxParallel: 2 }).action, "new-producer-cluster", "producer-limited")
  eq(decideOverflow({ demand: 20, edge, available: TIERS, order: ["parallel-route", "upgrade-tier"], maxParallel: 2 }).action, "parallel-route", "policy order decides")
})

// --- The M4 set on a synthetic map ---------------------------------------------------------------------------

/** Outpost → smelter → gear row → red row → labs; coal and copper fed from outside. */
export function m4Set(): { modules: ModuleDef[]; connections: ConnectionRequest[] } {
  const outpost = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 }), id: "outpost" }
  const smelter = { ...smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), id: "smelter" }
  const gears = { ...assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }), id: "gears" }
  const red = { ...assemblerRow(F, { recipe: "automation-science-pack", count: 2 }), id: "red" }
  const labs = { ...labArray(F, { labs: 2, packs: ["automation-science-pack"] }), id: "labs" }
  const c = (id: string, from: [string, string] | undefined, to: [string, string]): ConnectionRequest => ({ id: connectionId(id), from: from ? { module: from[0], port: from[1] } : undefined, to: { module: to[0], port: to[1] } })
  return {
    modules: [outpost, smelter, gears, red, labs],
    connections: [
      c("ore", ["outpost", "out"], ["smelter", "in-ore"]),
      c("plates", ["smelter", "out"], ["gears", "in-iron-plate"]),
      c("gears", ["gears", "out"], ["red", "in-iron-gear-wheel"]),
      c("red", ["red", "out"], ["labs", "in-automation-science-pack"]),
      c("coal", undefined, ["smelter", "in-fuel"]),
      c("copper", undefined, ["red", "in-copper-plate"]),
    ],
  }
}

test("policy D35: near-ore smelting puts the smelter next to its ore outpost; compact-core next to its consumer", () => {
  // Iron 60+ tiles east of the cluster centre; the gear row (the smelter's consumer) clusters at the centre.
  const rows = field(150, 70)
  for (let y = 20; y < 50; y++) rows[y] = rows[y].substring(0, 110) + string.rep("i", 30) + rows[y].substring(140)
  const terrain = asciiTerrain(rows)
  const outpost = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 }), id: "outpost" }
  const smelter = { ...smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), id: "smelter" }
  const gears = { ...assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }), id: "gears" }
  const c = (id: string, from: [string, string] | undefined, to: [string, string]): ConnectionRequest => ({ id: connectionId(id), from: from ? { module: from[0], port: from[1] } : undefined, to: { module: to[0], port: to[1] } })
  const req = (): PlanRequest => ({
    modules: [gears, smelter, outpost].map((def) => ({ id: def.id, def })),
    connections: [c("ore", ["outpost", "out"], ["smelter", "in-ore"]), c("plates", ["smelter", "out"], ["gears", "in-iron-plate"]), c("coal", undefined, ["smelter", "in-fuel"])],
    center: { x: 40, y: 35 },
    region: { x: 0, y: 0, w: 150, h: 70 },
  })
  const dist = (job: ReturnType<typeof planNow>, a: string, b: string): number => {
    const ma = findModule(job.layout, a)!.rect
    const mb = findModule(job.layout, b)!.rect
    return math.abs(ma.x + ma.w / 2 - (mb.x + mb.w / 2)) + math.abs(ma.y + ma.h / 2 - (mb.y + mb.h / 2))
  }
  const compact = planNow(req(), YELLOW, terrain, F, policy({ smelting: "compact-core" }), 400)
  eq(compact.phase, "done", `compact planned (${serpentLine(compact.failures)})`)
  const near = planNow(req(), YELLOW, terrain, F, policy({ smelting: "near-ore" }), 400)
  eq(near.phase, "done", `near-ore planned (${serpentLine(near.failures)})`)
  noProblems(near.layout, terrain, "near-ore")
  const cs = dist(compact, "smelter", "outpost")
  const ns = dist(near, "smelter", "outpost")
  const cg = dist(compact, "smelter", "gears")
  const ng = dist(near, "smelter", "gears")
  print(string.format("    [d35] smelter-outpost / smelter-gears: compact %g / %g, near-ore %g / %g", cs, cg, ns, ng))
  ok(ns < cs, `near-ore smelter closer to the ore (${ns} vs ${cs})`)
  ok(cg < ng, `compact smelter closer to its consumer (${cg} vs ${ng})`)
  eq(selectPolicy("early-compact", {}).smelting, "compact-core", "default unchanged")
  eq(selectPolicy("early-compact", {}, { smelting: "near-ore" }).smelting, "near-ore", "config override")
})

test("plan: the 5-module set on terrain with a lake, cliffs, trees, ore and structures: valid, graph built", () => {
  const rows = field(120, 100)
  for (let y = 0; y < 100; y++) {
    let r = rows[y]
    if (y >= 10 && y < 40) r = r.substring(0, 5) + string.rep("~", 20) + r.substring(25) // lake
    if (y >= 60 && y < 80) r = r.substring(0, 80) + string.rep("i", 16) + r.substring(96) // iron
    if (y % 7 === 0) r = r.substring(0, 40) + string.rep("T", 10) + r.substring(50) // tree rows
    if (y >= 20 && y < 70) r = r.substring(0, 60) + "C" + r.substring(61) // cliff line
    if (y >= 45 && y < 48) r = r.substring(0, 45) + "###" + r.substring(48) // own structures
    if (y >= 50 && y < 52) r = r.substring(0, 30) + "XX" + r.substring(32) // another force
    rows[y] = r
  }
  const terrain = asciiTerrain(rows)
  const set = m4Set()
  const req: PlanRequest = { modules: set.modules.map((def) => ({ id: def.id, def })), connections: set.connections, center: { x: 50, y: 50 }, region: { x: 0, y: 0, w: 120, h: 100 } }
  const t0 = os.clock()
  const job = planNow(req, YELLOW, terrain, F, policy(), 400)
  const ms = (os.clock() - t0) * 1000
  eq(job.phase, "done", `planned (${serpentLine(job.failures)})`)
  noProblems(job.layout, terrain, "m4 set")
  let tiles = 0
  let ugs = 0
  for (const id of job.layout.routeOrder) {
    tiles += job.layout.routes[id].length
    ugs += job.layout.routes[id].undergrounds
  }
  const g = buildGraph(job.layout, policy(), { tiers: TIERS, researched: {} })
  eq(g.physical.nodes.length, 5, "nodes")
  eq(g.physical.edges.length, 6, "edges (4 routes + 2 external stubs)")
  for (const e of g.physical.edges) ok(e.capacity.ok, `${e.id} within capacity`)
  print(
    string.format(
      "    [router-cost] 5-module set: %d steps of ≤400 units, work %.0f (placement %.0f, routing %.0f), %d A* expansions in %d searches, %d rip-ups, %d belt tiles, %d undergrounds, %.1f ms total (%.3f ms/step, plain Lua)",
      job.stats.steps,
      job.stats.work,
      job.stats.placeWork,
      job.stats.routeWork,
      job.stats.expansions,
      job.stats.searches,
      job.stats.ripups,
      tiles,
      ugs,
      ms,
      ms / job.stats.steps,
    ),
  )
})

test("grid: tile keys round-trip negative and large coordinates", () => {
  for (const [x, y] of [
    [0, 0],
    [-5, 7],
    [100000, -100000],
    [-1, -1],
  ]) {
    const k = tkey(x, y)
    eq(keyX(k), x, "x")
    eq(keyY(k), y, "y")
  }
})

// B57: the lane test (placement.ts `laneWayOut`): farthest-first, undergrounds as the router has them. Grid: '.' ground,
// '=' a belt (not ground, an underground may go under it), '#' a module (neither); off the grid is open ground.
function laneGrid(rows: string[]): { free: (this: void, x: number, y: number) => boolean; under: (this: void, x: number, y: number) => boolean; calls: { n: number } } {
  const calls = { n: 0 }
  const at = (x: number, y: number): string => {
    const r = rows[y]
    if (r === undefined || x < 0 || x >= r.length) return "."
    return string.sub(r, x + 1, x + 1)
  }
  return {
    free: (x, y) => {
      calls.n++
      return at(x, y) === "."
    },
    under: (x, y) => at(x, y) !== "#",
    calls,
  }
}

test("B57: a lane in a pocket walled by modules is sealed; one walled by a belt leads out under it", () => {
  const boxed = laneGrid(["#######", "#.....#", "#.....#", "#.....#", "#######"])
  ok(laneWayOut({ x: 3, y: 2 }, boxed.free, 32, { under: boxed.under, max: LANE_HOP }) === undefined, "a module-walled pocket is sealed")
  ok(laneWayOut({ x: 3, y: 2 }, boxed.free, 2, { under: boxed.under, max: LANE_HOP }) !== undefined, "it does reach 2 steps (the old test's blind spot)")
  const belted = laneGrid(["=======", "=.....=", "=.....=", "=.....=", "======="])
  ok(laneWayOut({ x: 3, y: 2 }, belted.free, 32) === undefined, "without undergrounds a belt ring seals it")
  const path = laneWayOut({ x: 3, y: 2 }, belted.free, 32, { under: belted.under, max: LANE_HOP })
  ok(path !== undefined, "with undergrounds it leads out under the belt")
})

test("B57: an underground is entered straight and its exit feeds the tile straight on", () => {
  // The only gap is under the belt at x 3; the tile behind the entrance (3,2) and past the exit (3,6) decide.
  const ok1 = laneGrid(["#######", "#.....#", "#.....#", "###=###", "###.###", "###.###", "#######"])
  ok(laneWayOut({ x: 3, y: 1 }, ok1.free, 32, { under: ok1.under, max: LANE_HOP }) === undefined, "an exit into a dead end leads nowhere")
  const open = laneGrid(["#######", "#.....#", "#.....#", "###=###", "###...#", "###.###", "###.###"])
  ok(laneWayOut({ x: 3, y: 1 }, open.free, 32, { under: open.under, max: LANE_HOP }) !== undefined, "an exit with ground straight on leads out")
  const side = laneGrid(["#######", "#.#####", "#.....#", "###=###", "###.###", "###.###", "###.###"])
  // (3,2) is entered from the west only: an underground south from it would need (3,1) behind it.
  ok(laneWayOut({ x: 1, y: 1 }, side.free, 32, { under: side.under, max: LANE_HOP }) === undefined, "no underground entered from the side")
})

test("B57: a hop may not overlap another underground on its line", () => {
  const g = laneGrid(["#######", "#.....#", "#.....#", "###=###", "###.###", "###.###", "###.###"])
  const state = newLayout()
  state.spans["v3"] = [{ a: 2, b: 6, route: "r" }]
  ok(laneWayOut({ x: 3, y: 1 }, g.free, 32, { under: g.under, max: LANE_HOP }) !== undefined, "without the span it leads out")
  ok(laneWayOut({ x: 3, y: 1 }, g.free, 32, { under: g.under, max: LANE_HOP, state }) === undefined, "a route's span on x 3 blocks it")
})

test("B57: on open ground the lane test walks about `need` tiles, not the whole diamond", () => {
  const g = laneGrid([])
  const path = laneWayOut({ x: 0, y: 0 }, g.free, 32, { under: g.under, max: LANE_HOP })
  ok(path !== undefined && path.length <= 34, `a short way out (${path?.length})`)
  ok(g.calls.n < 400, `${g.calls.n} tiles looked at`)
})


test("B58: replacing a route rips its splitter taps", () => {
  const layout = newLayout()
  const route = (id: string, conn: string, tapOf?: string): Route => ({
    id: routeId(id),
    conn: connectionId(conn),
    item: "coal",
    to: { module: "n37", port: "in-fuel" },
    steps: [],
    tiles: [],
    spans: [],
    belt: "transport-belt",
    underground: "underground-belt",
    splitter: "splitter",
    length: 0,
    undergrounds: 0,
    cost: 0,
    ripped: 0,
    tapOf: tapOf !== undefined ? routeId(tapOf) : undefined,
  })
  const root = route("root", "coal-root")
  root.steps = [{ kind: "belt", x: 5, y: 5, dir: 1 }]
  root.tiles = [tkey(5, 5)]
  commitRoute(layout, root)
  const tap = route("tap", "coal-tap", "root")
  tap.steps = [{ kind: "splitter", x: 5, y: 5, x2: 5, y2: 6, dir: 1 }]
  tap.tiles = [tkey(5, 5), tkey(5, 6)]
  commitRoute(layout, tap)
  const replacement = route("root", "coal-root")
  replacement.steps = [{ kind: "ug-in", x: 5, y: 5, dir: 1 }, { kind: "ug-out", x: 7, y: 5, dir: 1 }]
  replacement.tiles = [tkey(5, 5), tkey(7, 5)]
  replacement.spans = [{ line: "h5", span: { a: 5, b: 7, route: "root" } }]
  commitRoute(layout, replacement)
  ok(layout.routes["tap"] === undefined, "the stale tap is ripped with the replaced route")
})

// B28 part 2: a sealed replacement must leave the old footprint's route margin. Without the padding the search
// re-places the module a few tiles away (8,29 in this scenario), still inside the band the failed route had to cross.
test("B28: a sealed replacement leaves the route margin around the old footprint", () => {
  const rows = field(60, 60)
  // A one-tile UNKNOWN wall: surface routes cannot enter and undergrounds cannot pass it.
  for (let x = 24; x <= 36; x++) {
    rows[24] = rows[24].substring(0, x) + "?" + rows[24].substring(x + 1)
    rows[36] = rows[36].substring(0, x) + "?" + rows[36].substring(x + 1)
  }
  for (let y = 25; y < 36; y++) {
    rows[y] = rows[y].substring(0, 24) + "?" + rows[y].substring(25)
    rows[y] = rows[y].substring(0, 36) + "?" + rows[y].substring(37)
  }
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 5, 30)
  place(state, b, 30, 30)
  const job = newRoutingJob(request([a, b], [conn("c", "a", "b")], 60, 60), YELLOW, state)
  job.replaced = {} // planned by this job: allowed to move
  runJob(job, terrain, F, policy())
  eq(job.phase, "done", `phase (${serpentLine(job.failures)})`)
  eq(job.stats.replacements, 1, "one re-placement")
  const moved = findModule(state, "b")!
  const away = replacementAvoid({ x: 30, y: 30, w: 1, h: 1 }, policy().router.margin)
  ok(
    moved.rect.x < away.x || moved.rect.x >= away.x + away.w || moved.rect.y < away.y || moved.rect.y >= away.y + away.h,
    `b left the padded old pocket (${moved.rect.x},${moved.rect.y})`,
  )
  noProblems(state, terrain, "sealed re-placement")
})

test("B28: a re-placed module leaves its old footprint plus the route margin", () => {
  const old = { x: 10, y: 20, w: 5, h: 4 }
  const away = replacementAvoid(old, 24)
  eq(away.x, -14, "left")
  eq(away.y, -4, "top")
  eq(away.w, 53, "width")
  eq(away.h, 52, "height")
  // A candidate just outside the old rectangle is still excluded: that is the same pocket that failed.
  ok(away.x <= old.x + old.w && old.x + old.w <= away.x + away.w, "the old right edge is inside")
  ok(away.y <= old.y + old.h && old.y + old.h <= away.y + away.h, "the old bottom edge is inside")
})

run("planner")
