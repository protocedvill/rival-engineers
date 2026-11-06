import { ModuleDef, EAST, NORTH, Port, SOUTH } from "../src/modules/types"
import { routeEntities } from "../src/planner/build-list"
import { asciiTerrain, DX, DY, tkey } from "../src/planner/grid"
import { checkLayout, commitModule, findModule, LayoutState, newLayout, PlacedModule, portTag } from "../src/planner/layout"
import { laneLeadsOut, layoutLaneGround, portLaneEnd, sealedInputs } from "../src/planner/placement"
import { ConnectionRequest, moduleFluidRun, newPlanJob, newRoutingJob, PlanRequest, runJob } from "../src/planner/plan"
import { selectPolicy } from "../src/planner/policy"
import { planReroute } from "../src/planner/reroute"
import { unpoweredModules } from "../src/planner/power"
import { fluidChain, oilComplex, pumpjackField } from "../src/modules/generators"
import { beltTiers } from "../src/planner/capacity"
import { IDENTITY } from "../src/modules/geometry"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: M7b fluid routes through the plan job: a `pipe-out` → `pipe-in` connection is routed with pipes, committed as a
// fluid route that passes the layout check, and becomes pipe, pipe-to-ground and pump entities.

const YELLOW = beltTiers(F)[0]
const FLUID = { name: "crude-oil", pipe: "pipe", underground: "pipe-to-ground", pump: "pump", maxUnderground: 10, extent: 320 }

function box(id: string, w: number, h: number, ports: Port[]): ModuleDef {
  return { id, source: "generated", footprint: { w, h }, entities: [], ports, recipes: [], machines: [], rates: { inputs: [], outputs: [] }, requiresTech: [], rotatable: true, mirrorable: true }
}

function place(state: LayoutState, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: moduleId(def.id), canonical: def, def, transform: IDENTITY, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h } }
  commitModule(state, m, F, 0)
  return m
}

function request(modules: ModuleDef[], connections: ConnectionRequest[], w: number, h: number): PlanRequest {
  return { modules: modules.map((def) => ({ id: def.id, def })), connections, center: { x: math.floor(w / 2), y: math.floor(h / 2) }, region: { x: 0, y: 0, w, h } }
}

function field(w: number, h: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < h; y++) rows.push(string.rep(".", w))
  return rows
}

const policy = selectPolicy("early-compact", {})

test("fluid route: a pipe-out → pipe-in connection is piped and passes the layout check", () => {
  const terrain = asciiTerrain(field(80, 30))
  const state = newLayout()
  const well = box("well", 3, 3, [{ id: "out", kind: "pipe-out", pos: { x: 2.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  const refinery = box("ref", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, well, 2, 10)
  place(state, refinery, 60, 9)
  const c: ConnectionRequest = { id: connectionId("crude"), from: { module: "well", port: "out" }, to: { module: "ref", port: "in" }, fluid: FLUID }
  const job = runJob(newRoutingJob(request([well, refinery], [c], 80, 30), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  const check = checkLayout(job.layout, terrain, () => 10)
  eq(check.problems.length, 0, check.problems.join("; "))
  const r = job.layout.routes["route:crude"]
  ok(r !== undefined && r.fluid !== undefined, "a fluid route")
  const names: Record<string, number> = {}
  for (const e of routeEntities(job.layout)) names[e.name] = (names[e.name] ?? 0) + 1
  ok((names["pipe-to-ground"] ?? 0) >= 4, `pipe-to-ground pairs carry the 55-tile line (${names["pipe-to-ground"] ?? 0})`)
  eq(names["transport-belt"], undefined, "no belts")
})

test("fluid route: a live-verified free source exit and neighbour can clear stale OWN terrain marks", () => {
  const rows = field(80, 30)
  rows[11] = rows[11].substring(0, 5) + "##" + rows[11].substring(7)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const well = box("well-stale", 3, 3, [{ id: "out", kind: "pipe-out", pos: { x: 2.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  const refinery = box("ref-stale", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, well, 2, 10)
  place(state, refinery, 60, 9)
  const c: ConnectionRequest = { id: connectionId("stale"), from: { module: "well-stale", port: "out" }, to: { module: "ref-stale", port: "in" }, fluid: { ...FLUID, verifiedFree: { [tkey(5, 11)]: true, [tkey(6, 11)]: true } } }
  const job = runJob(newRoutingJob(request([well, refinery], [c], 80, 30), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  ok(job.layout.routes["route:stale"]?.fluid !== undefined, "the verified exit is routed")
})

test("fluid route: never runs a plain pipe next to another module's pipe port", () => {
  const terrain = asciiTerrain(field(60, 30))
  const state = newLayout()
  const src = box("src", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "water" }])
  const dst = box("dst", 1, 1, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 0.5 }, dir: NORTH as 0, item: "water" }])
  // Another module's crude port faces the line's way: a plain pipe beside its tile would join the two fluids.
  const other = box("other", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: NORTH as 0, item: "crude-oil" }])
  place(state, src, 2, 10)
  place(state, dst, 30, 20)
  place(state, other, 15, 11)
  const c: ConnectionRequest = { id: connectionId("water"), from: { module: "src", port: "out" }, to: { module: "dst", port: "in" }, fluid: { ...FLUID, name: "water" } }
  const job = runJob(newRoutingJob(request([src, dst, other], [c], 60, 30), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  for (const s of job.layout.routes["route:water"].steps) {
    if (s.kind !== "pipe") continue
    for (let d = 0; d < 4; d++) ok(s.x + DX[d] !== 15 || s.y + DY[d] !== 11, `pipe at ${s.x},${s.y} touches the crude port`)
  }
  eq(checkLayout(job.layout, terrain, () => 10).problems.length, 0)
  ok(job.layout.routeOcc[tkey(15, 11)] === undefined, "the other port's tile stays its own")
})

test("B157 phase 3: a pipe lane is judged with pipe rules, not a belt's", () => {
  // The dst crude port's lane end is (8,12), walled by 1x1 modules north and south (a module blocks an underground too).
  // A 1x1 water module's pipe-out outside tile at (7,12) and its moat cover (8,11..13): every way out would mix fluids.
  const rows = field(30, 30)
  const dst = box("dst", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  const other = box("other", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "water" }])
  const wallN = box("wall-n", 1, 1, [])
  const wallS = box("wall-s", 1, 1, [])
  const state = newLayout()
  place(state, dst, 10, 10)
  place(state, other, 6, 12)
  place(state, wallN, 8, 11)
  place(state, wallS, 8, 13)
  ok(sealedInputs(state, asciiTerrain(rows), "dst", {}, 8).indexOf("in") >= 0, "another fluid's port moat seals the lane")
  const clean = newLayout()
  place(clean, dst, 10, 10)
  place(clean, wallN, 8, 11)
  place(clean, wallS, 8, 13)
  eq(sealedInputs(clean, asciiTerrain(rows), "dst", {}, 8).length, 0, "without the water port the lane leads west, out")

  // A 7-tile band west of the lane end: a pipe-to-ground span of 10 crosses it, a belt's 5 does not.
  const band = field(30, 30)
  for (let x = 2; x <= 7; x++) band[12] = band[12].substring(0, x) + "#" + band[12].substring(x + 1)
  const bandState = newLayout()
  place(bandState, dst, 10, 10)
  place(bandState, wallN, 8, 11)
  place(bandState, wallS, 8, 13)
  const terrain = asciiTerrain(band)
  eq(sealedInputs(bandState, terrain, "dst", {}, 8).length, 0, "the pipe hop crosses a 7-tile band")
  const m = findModule(bandState, "dst")!
  const belt = layoutLaneGround(bandState, terrain, portTag("dst", "in"))
  eq(laneLeadsOut(portLaneEnd(m, m.def.ports[0]), belt.free, 8, belt.hop), false, "the belt hop does not")
})

test("B147 (seed 11 g154): never runs a plain pipe next to a module's own pipe on its edge", () => {
  // An oil complex's water manifold runs along its top edge. A crude line along the outside of that edge joined it: the
  // crude flowed down the complex's new water line, and its last pipe could never be placed (Factorio refuses to mix).
  const terrain = asciiTerrain(field(60, 30))
  const state = newLayout()
  const src = box("src-edge", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: SOUTH as 0, item: "crude-oil" }])
  const dst = box("dst-edge", 1, 1, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "crude-oil" }])
  const complex = box("complex-edge", 20, 4, [])
  for (let x = 0; x < 20; x++) complex.entities.push({ name: "pipe", x: x + 0.5, y: 0.5 })
  // The line comes down from the north and turns east into the target's port tile (34,11), which touches the manifold.
  // Runs are underground pairs, but a turn is a plain pipe: it must not turn on the row beside the manifold.
  place(state, src, 25, 2)
  place(state, dst, 35, 11)
  place(state, complex, 20, 12)
  const c: ConnectionRequest = { id: connectionId("crude-edge"), from: { module: "src-edge", port: "out" }, to: { module: "dst-edge", port: "in" }, fluid: FLUID }
  const job = runJob(newRoutingJob(request([src, dst, complex], [c], 60, 30), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  for (const st of job.layout.routes["route:crude-edge"].steps) {
    if (st.kind !== "pipe") continue
    for (let d = 0; d < 4; d++) {
      const x = st.x + DX[d]
      const y = st.y + DY[d]
      ok(y !== 12 || x < 20 || x > 39, `pipe at ${st.x},${st.y} touches the manifold at ${x},${y}`)
    }
  }
})

test("B149 (seed 11 g198): a second provider's line joins the line already feeding the port", () => {
  // The plastic row's petroleum port was fed by the second oil complex; the design added the third as a parallel provider
  // into the same port. Its line could only aim at the port's outside tile, which the first line holds: "no pipe path".
  const terrain = asciiTerrain(field(80, 40))
  const state = newLayout()
  const a = box("src-a", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "crude-oil" }])
  const b = box("src-b", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "crude-oil" }])
  const dst = box("dst-join", 3, 3, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, a, 2, 10)
  place(state, b, 2, 30)
  place(state, dst, 60, 15)
  const c1: ConnectionRequest = { id: connectionId("crude-a"), from: { module: "src-a", port: "out" }, to: { module: "dst-join", port: "in" }, fluid: FLUID }
  const first = runJob(newRoutingJob(request([a, b, dst], [c1], 80, 40), YELLOW, state), terrain, F, policy)
  eq(first.phase, "done", `first: ${Object.values(first.failures ?? {}).join("; ")}`)
  const c2: ConnectionRequest = { id: connectionId("crude-b"), from: { module: "src-b", port: "out" }, to: { module: "dst-join", port: "in" }, fluid: FLUID }
  const job = runJob(newRoutingJob(request([a, b, dst], [c2], 80, 40), YELLOW, first.layout), terrain, F, policy)
  eq(job.phase, "done", `second: ${Object.values(job.failures ?? {}).join("; ")}`)
  const r = job.layout.routes["route:crude-b"]
  eq(r.joins, "route:crude-a", "it joins the first line")
  eq(checkLayout(job.layout, terrain, () => 10).problems.join("; "), "")
})

test("B147 (seed 11 g154): a stuck pipe route is rerouted with pipes around the stuck tile", () => {
  // The build's reroute rebuilt each connection without its fluid, so a pipe line was routed as a belt ("no belt-in
  // port") and the goal gave up its whole site over one pipe. Older routes have no stored limits: the facts give them.
  const terrain = asciiTerrain(field(80, 30))
  const state = newLayout()
  const well = box("well-rr", 3, 3, [{ id: "out", kind: "pipe-out", pos: { x: 2.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  const refinery = box("ref-rr", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, well, 2, 10)
  place(state, refinery, 60, 9)
  const c: ConnectionRequest = { id: connectionId("crude-rr"), from: { module: "well-rr", port: "out" }, to: { module: "ref-rr", port: "in" }, fluid: FLUID }
  const job = runJob(newRoutingJob(request([well, refinery], [c], 80, 30), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  const rid = routeId("route:crude-rr")
  const old = job.layout.routes[rid]
  eq(old.fluid?.extent, 320, "the route keeps its extent")
  old.fluid!.extent = undefined
  old.fluid!.maxUnderground = undefined
  // The stuck tile: a pipe-to-ground end in the middle of the line.
  const mid = old.steps[math.floor(old.steps.length / 2)]
  const avoid = { [tkey(mid.x, mid.y)]: true }
  const plan = planReroute(job.layout, terrain, F, policy, YELLOW, [rid], { x: 0, y: 0, w: 80, h: 30 }, avoid)
  ok(plan.ok, `reroute: ${plan.reason}`)
  const r = plan.layout.routes[plan.routes[0]]
  ok(r !== undefined && r.fluid?.name === "crude-oil", "a fluid route again")
  for (const st of r.steps) {
    ok(st.kind === "pipe" || st.kind === "pipe-ug-in" || st.kind === "pipe-ug-out" || st.kind === "pump", `a pipe step (${st.kind})`)
    ok(st.x !== mid.x || st.y !== mid.y, `avoids the stuck tile ${mid.x},${mid.y}`)
  }
  eq(checkLayout(plan.layout, terrain, () => 10).problems.length, 0)
  ok(plan.add.length > 0 && plan.add.every((e) => e.name !== "transport-belt"), "builds pipes, no belts")
})

test("B156: a pipe port the flood proves sealed re-places its consumer, like a belt seal", () => {
  // The refinery's in-water port outside tile (59,11) is a cliff: no pipe can stand there. The pipe search cannot route
  // and reports budget/exhaustion; the goal-side flood proves the pocket, and the consumer is placed again away from it.
  const rows: string[] = []
  for (let y = 0; y < 30; y++) rows.push(string.rep(".", 80))
  rows[11] = string.sub(rows[11], 1, 59) + "C" + string.sub(rows[11], 61)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const well = box("well", 3, 3, [{ id: "out", kind: "pipe-out", pos: { x: 2.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  const refinery = box("ref", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, well, 2, 10)
  place(state, refinery, 60, 9)
  const c: ConnectionRequest = { id: connectionId("crude"), from: { module: "well", port: "out" }, to: { module: "ref", port: "in" }, fluid: FLUID }
  const job = newRoutingJob(request([well, refinery], [c], 80, 30), YELLOW, state)
  // A routing job's modules are an existing base and never move. Here the refinery stands for a module this plan just
  // placed: unmark it as base so the B106 re-placement path applies (a real plan's own module has no `replaced` entry).
  job.replaced["ref"] = 0
  runJob(job, terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  ok((job.stats.replacements ?? 0) >= 1, `the sealed consumer moved (${job.stats.replacements ?? 0} replacements)`)
  ok(job.layout.routes["route:crude"]?.fluid !== undefined, "the re-placed consumer is piped")
  ok(
    (job.evidence ?? []).some((ev) => ev.kind === "route" && ev.mode === "pipe" && ev.sealed?.side === "goal"),
    "the failed pipe route carries its seal evidence",
  )
})

test("fluid route: a pumpjack field placed on its wells (fixed) pipes crude to a plastic block the planner places", () => {
  const terrain = asciiTerrain(field(140, 80))
  const wells = [
    { x: 10, y: 10, perSecond: 10 },
    { x: 16, y: 11, perSecond: 10 },
    { x: 12, y: 16, perSecond: 10 },
  ]
  const oil = pumpjackField(F, { wells })
  const plastic = fluidChain(F, { recipe: "plastic-bar", chemPlants: 2, refineries: 2 })
  // The field's footprint starts M tiles before the first well's pumpjack (wells' min x/y − 1 − M).
  const at = { x: 10 - 1 - 2, y: 10 - 1 - 2 }
  const req: PlanRequest = {
    modules: [
      { id: "oil", def: oil, at },
      { id: "plastic", def: plastic },
    ],
    connections: [{ id: connectionId("crude"), from: { module: "oil", port: "out-crude-oil" }, to: { module: "plastic", port: "in-crude-oil" }, fluid: FLUID }],
    center: { x: 60, y: 30 },
    region: { x: 0, y: 0, w: 140, h: 80 },
  }
  const job = runJob(newPlanJob(req, YELLOW), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  const m = job.layout.modules.find((x) => x.id === "oil")!
  ok(m.origin.x === at.x && m.origin.y === at.y, `the field sits on its wells (${m.origin.x},${m.origin.y})`)
  eq(checkLayout(job.layout, terrain, () => 10).problems.length, 0)
  ok(job.layout.routes["route:crude"]?.fluid !== undefined, "crude is piped")
})

test("fluid route: B119 a field with cliffs in its box routes around them, leaves out a walled-off well, and is placed", () => {
  const rows = field(140, 80)
  // A ring of cliff around the middle well (x 17..23, y 7..13): its pumpjack cannot be piped out.
  const cliffs: string[] = []
  for (let x = 17; x <= 23; x++) for (let y = 7; y <= 13; y++) if (x === 17 || x === 23 || y === 7 || y === 13) cliffs.push(`${x},${y}`)
  for (const k of cliffs) {
    const [xs, ys] = string.match(k, "^(%d+),(%d+)$")
    const x = tonumber(xs)!
    const y = tonumber(ys)!
    rows[y] = string.sub(rows[y], 1, x) + "C" + string.sub(rows[y], x + 2)
  }
  const terrain = asciiTerrain(rows)
  const wells = [
    { x: 10, y: 10, perSecond: 10 },
    { x: 20, y: 10, perSecond: 10 },
    { x: 30, y: 11, perSecond: 10 },
  ]
  const oil = pumpjackField(F, { wells, obstacles: cliffs.join(";") })
  let jacks = 0
  for (const e of oil.entities) if (e.name === "pumpjack") jacks++
  eq(jacks, 2, "the walled-off well is left out")
  const plastic = fluidChain(F, { recipe: "plastic-bar", chemPlants: 2, refineries: 2 })
  const at = { x: 10 - 1 - 2, y: 10 - 1 - 2 }
  const req: PlanRequest = {
    modules: [
      { id: "oil", def: oil, at },
      { id: "plastic", def: plastic },
    ],
    connections: [{ id: connectionId("crude"), from: { module: "oil", port: "out-crude-oil" }, to: { module: "plastic", port: "in-crude-oil" }, fluid: FLUID }],
    center: { x: 60, y: 30 },
    region: { x: 0, y: 0, w: 140, h: 80 },
  }
  const job = runJob(newPlanJob(req, YELLOW), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  const m = job.layout.modules.find((x) => x.id === "oil")!
  for (const e of m.def.entities) {
    const x = math.floor(m.origin.x + e.x)
    const y = math.floor(m.origin.y + e.y)
    ok(cliffs.indexOf(`${x},${y}`) < 0, `${e.name} at ${x},${y} stands on a cliff`)
  }
  ok(job.layout.routes["route:crude"]?.fluid !== undefined, "crude is piped")
})

test("fluid route: B120 two chains fed from one field's port: the second taps the first line", () => {
  const terrain = asciiTerrain(field(140, 80))
  const wells = [
    { x: 10, y: 10, perSecond: 10 },
    { x: 16, y: 11, perSecond: 10 },
  ]
  const oil = pumpjackField(F, { wells })
  const plastic = fluidChain(F, { recipe: "plastic-bar", chemPlants: 2, refineries: 2 })
  const sulfur = fluidChain(F, { recipe: "sulfur", chemPlants: 1, refineries: 1 })
  const at = { x: 10 - 1 - 2, y: 10 - 1 - 2 }
  const req: PlanRequest = {
    modules: [
      { id: "oil", def: oil, at },
      { id: "plastic", def: plastic },
      { id: "sulfur", def: sulfur },
    ],
    connections: [
      { id: connectionId("crude-plastic"), from: { module: "oil", port: "out-crude-oil" }, to: { module: "plastic", port: "in-crude-oil" }, fluid: FLUID },
      { id: connectionId("crude-sulfur"), from: { module: "oil", port: "out-crude-oil" }, to: { module: "sulfur", port: "in-crude-oil" }, fluid: FLUID },
    ],
    center: { x: 60, y: 30 },
    region: { x: 0, y: 0, w: 140, h: 80 },
  }
  const job = runJob(newPlanJob(req, YELLOW), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  const a = job.layout.routes["route:crude-plastic"]
  const b = job.layout.routes["route:crude-sulfur"]
  ok(a !== undefined && b !== undefined, "both chains are piped")
  ok(a.tapOf !== undefined || b.tapOf !== undefined, "one line taps the other")
  eq(checkLayout(job.layout, terrain, () => 10).problems.join("; "), "")
})

test("fluid route: pumps on a long line get a pole each, joined to the power network by the pole step", () => {
  const terrain = asciiTerrain(field(260, 30))
  const state = newLayout()
  // A generator (steam engine + pole) near the start; the line needs a pump every 100 tiles.
  const gen = { ...box("gen", 5, 3, []), entities: [{ name: "steam-engine", x: 2.5, y: 1.5, dir: EAST as 0 }, { name: "small-electric-pole", x: 0.5, y: 0.5 }] }
  const src = box("src", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "crude-oil" }])
  const dst = box("dst", 1, 1, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, gen, 2, 2)
  place(state, src, 2, 10)
  place(state, dst, 230, 10)
  const c: ConnectionRequest = { id: connectionId("crude"), from: { module: "src", port: "out" }, to: { module: "dst", port: "in" }, fluid: { ...FLUID, extent: 100 } }
  const req = { ...request([gen, src, dst], [c], 260, 30), poles: "small-electric-pole" }
  const job = runJob(newRoutingJob(req, YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  let pumps = 0
  for (const st of job.layout.routes["route:crude"].steps) if (st.kind === "pump") pumps++
  ok(pumps >= 2, `pumps on a 228-tile line with extent 100 (${pumps})`)
  const line = (job.layout.poleLines ?? []).find((l) => l.from === "pump")
  ok(line !== undefined && line.poles.length === pumps, "a pole beside each pump")
  eq(unpoweredModules(job.layout, F).join(","), "", "every pump pole joined the network")
  eq(checkLayout(job.layout, terrain, () => 10).problems.length, 0)
})

test("B146 (seed 11 g154): a port's run inside its module counts its own fluid's pipes only", () => {
  // The oil complex's water reaches its plants along the bottom row, the west column and the top manifold (19 + 25 + 19
  // tiles, plus risers); its gas, oil and lube manifolds and their pipe-to-ground risers are other segments. Counting
  // every pipe read 221 and left the water line 91 tiles of the extent.
  const def = oilComplex(F, { refineries: 1, lubePlants: 1 })
  const m = { def } as PlacedModule
  const port = (id: string): Port => def.ports.find((q) => q.id === id)!
  const water = moduleFluidRun(m, port("in-water"))
  ok(water >= 63 && water <= 80, `water run ${water}`)
  const all = def.entities.filter((e) => e.name === "pipe").length
  for (const id of ["in-crude-oil", "out-petroleum-gas", "out-lubricant"]) {
    const r = moduleFluidRun(m, port(id))
    ok(r < all / 2, `${id} run ${r} of ${all} pipes`)
  }
})

test("fluid route: a 1000-tile line places pumps across the pipeline extent", () => {
  // M7d.5 g198: a third oil complex drew crude from a field ~1000 tiles away. The plan failed "no pipe path"; before
  // blaming the field or its terrain, pin that the router itself can carry a line past `default_pipeline_extent`.
  const W = 1100
  const H = 40
  const terrain = asciiTerrain(field(W, H))
  const state = newLayout()
  const well = box("far-well", 3, 3, [{ id: "out", kind: "pipe-out", pos: { x: 2.5, y: 1.5 }, dir: EAST as 0, item: "crude-oil" }])
  const refinery = box("far-ref", 5, 5, [{ id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" }])
  place(state, well, 5, 18)
  place(state, refinery, W - 10, 17)
  const c: ConnectionRequest = { id: connectionId("far-crude"), from: { module: "far-well", port: "out" }, to: { module: "far-ref", port: "in" }, fluid: FLUID }
  const job = runJob(newRoutingJob(request([well, refinery], [c], W, H), YELLOW, state), terrain, F, policy)
  eq(job.phase, "done", `phase: ${Object.values(job.failures ?? {}).join("; ")}`)
  let pumps = 0
  for (const st of job.layout.routes["route:far-crude"].steps) if (st.kind === "pump") pumps++
  ok(pumps >= 3, `pumps on a ~1000-tile line (${pumps})`)
  eq(checkLayout(job.layout, terrain, () => 10).problems.length, 0)
})

run("fluid-route")
