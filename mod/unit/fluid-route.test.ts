import { ModuleDef, EAST, NORTH, Port } from "../src/modules/types"
import { routeEntities } from "../src/planner/build-list"
import { asciiTerrain, DX, DY, tkey } from "../src/planner/grid"
import { checkLayout, commitModule, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { ConnectionRequest, newPlanJob, newRoutingJob, PlanRequest, runJob } from "../src/planner/plan"
import { selectPolicy } from "../src/planner/policy"
import { fluidChain, pumpjackField } from "../src/modules/generators"
import { beltTiers } from "../src/planner/capacity"
import { IDENTITY } from "../src/modules/geometry"
import { connectionId, moduleId } from "../src/shared/ids"
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

run("fluid-route")
