import { assemblerRow, labArray, miningOutpost, smelterColumn, steamBlock } from "../src/modules/generators"
import { IDENTITY, Transform, transformModule } from "../src/modules/geometry"
import { EAST, ModuleDef, NORTH, Port, SOUTH } from "../src/modules/types"
import { availableTiers, beltTiers, checkEdge, decideOverflow, tierByBelt } from "../src/planner/capacity"
import { routeEntities } from "../src/planner/build-list"
import { buildGraph } from "../src/planner/graph"
import { asciiTerrain, FREE, keyX, keyY, TerrainView, tkey, WATER } from "../src/planner/grid"
import { checkLayout, commitModule, findModule, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { placeNow } from "../src/planner/placement"
import { ConnectionRequest, newRoutingJob, planNow, PlanRequest, runJob } from "../src/planner/plan"
import { EARLY_COMPACT, LayoutPolicy, policyIds, registerPolicy, selectPolicy } from "../src/planner/policy"
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

function place(state: LayoutState, def: ModuleDef, x: number, y: number, t: Transform = IDENTITY): PlacedModule {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  const m: PlacedModule = { id: def.id, canonical: def, def: d, transform: t, origin: { x, y }, rect: { x, y, w: d.footprint.w, h: d.footprint.h } }
  commitModule(state, m, F, 0)
  return m
}

function conn(id: string, from: string | undefined, to: string, toPort = "in"): ConnectionRequest {
  return { id, from: from !== undefined ? { module: from, port: "out" } : undefined, to: { module: to, port: toPort } }
}

function request(modules: ModuleDef[], connections: ConnectionRequest[], w = 60, h = 60): PlanRequest {
  return { modules: modules.map((def) => ({ id: def.id, def })), connections, center: { x: math.floor(w / 2), y: math.floor(h / 2) }, region: { x: 0, y: 0, w, h } }
}

function maxUg(this: void, name: string): number {
  return tierByBelt(TIERS, name.replace("underground-belt", "transport-belt"))?.maxUnderground ?? 5
}

function noProblems(state: LayoutState, terrain: TerrainView, what: string): void {
  const c = checkLayout(state, terrain, maxUg)
  if (c.problems.length > 0) error(`${what}: ${c.problems.join("; ")}`, 2)
}

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
  const walled = planNow(req, YELLOW, asciiTerrain(rows), F, pol)
  eq(walled.layout.modules.length, 2, "blocked growth → a new module")
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
  const c = (id: string, from: [string, string] | undefined, to: [string, string]): ConnectionRequest => ({ id, from: from ? { module: from[0], port: from[1] } : undefined, to: { module: to[0], port: to[1] } })
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
  const c = (id: string, from: [string, string] | undefined, to: [string, string]): ConnectionRequest => ({ id, from: from ? { module: from[0], port: from[1] } : undefined, to: { module: to[0], port: to[1] } })
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

run("planner")
