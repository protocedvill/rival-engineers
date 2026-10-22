// T1 model sequences: the boundaries of M6b (plan delta, layout revision, typed claims, goal lifecycle) exercised in
// the order a real faction meets them. Each step asserts the evidence the next boundary consumes, so a change that
// keeps one unit test green but breaks the hand-off fails here.

import { IDENTITY } from "../src/modules/geometry"
import { EAST, ModuleDef, Port } from "../src/modules/types"
import { beltTiers } from "../src/planner/capacity"
import { checkClaimOwners } from "../src/planner/claims"
import { FREE, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { checkLayoutIndexes, commitModule, layoutRevision, newLayout, PlacedModule, ripRoute, unmarkModule } from "../src/planner/layout"
import { preparePlanDelta } from "../src/planner/plan-delta"
import { cloneLayout, ConnectionRequest, newPlanJob, newRoutingJob, PlanRequest, runJob } from "../src/planner/plan"
import { selectPolicy } from "../src/planner/policy"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

const YELLOW = beltTiers(F)[0]
const POLICY = selectPolicy("early-compact", {})

function box(id: string, w: number, h: number, ports: Port[]): ModuleDef {
  return { id, source: "generated", footprint: { w, h }, entities: [], ports, recipes: [], machines: [], rates: { inputs: [], outputs: [] }, requiresTech: [], rotatable: true, mirrorable: true }
}

function source(id: string, dir: number, item = "iron-plate"): ModuleDef {
  return box(id, 1, 1, [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item }])
}

function sink(id: string, dir: number, item = "iron-plate"): ModuleDef {
  return box(id, 1, 1, [{ id: "in", kind: "belt-in", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item }])
}

function place(layout: ReturnType<typeof newLayout>, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: def.id, canonical: def, def, transform: IDENTITY, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h } }
  commitModule(layout, m, F, 0)
  return m
}

function request(modules: ModuleDef[], connections: ConnectionRequest[], w = 60, h = 60): PlanRequest {
  return { modules: modules.map((def) => ({ id: def.id, def })), connections, center: { x: math.floor(w / 2), y: math.floor(h / 2) }, region: { x: 0, y: 0, w, h } }
}

function free(w: number, h: number): TerrainView {
  return { block: (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? UNKNOWN : FREE), ore: () => undefined }
}

/** A routing-only job over an existing layout, with the base maps the real coordinator supplies. */
function routingJob(req: PlanRequest, base: ReturnType<typeof newLayout>): ReturnType<typeof newRoutingJob> {
  const job = newRoutingJob(req, YELLOW, cloneLayout(base))
  job.sourceRevision = layoutRevision(base)
  const modules: Record<string, boolean> = {}
  for (const m of base.modules) modules[m.id] = true
  job.baseModules = modules
  const routes: Record<string, boolean> = {}
  for (const id of base.routeOrder) routes[id] = true
  job.baseRoutes = routes
  return job
}

function clean(layout: ReturnType<typeof newLayout>, what: string): void {
  eq(checkLayoutIndexes(layout).problems.length, 0, `${what}: indexes`)
  eq(checkClaimOwners(layout).length, 0, `${what}: claims`)
}

test("sequence: plan A is rejected after B interleaves, and the replan adopts consistent evidence", () => {
  const base = newLayout()
  place(base, source("producer", EAST), 2, 2)
  eq(layoutRevision(base), 1)
  const jobA = newPlanJob(request([], []), YELLOW, base)
  place(jobA.layout, source("consumer", EAST), 5, 2)

  const a = preparePlanDelta({ sourceRevision: jobA.sourceRevision, layout: jobA.layout, baseModules: jobA.baseModules, baseRoutes: jobA.baseRoutes }, base)
  eq(a.status, "ready")
  if (a.status === "ready") {
    eq(a.delta.baseRevision, 1)
    eq(a.delta.candidateRevision, 2)
    eq(a.delta.add.modules.join(","), "consumer")
    eq(a.delta.remove.modules.length, 0)
    ok(a.delta.claims.takenTiles.length > 0, "the candidate takes ground")
    clean(a.delta.layout, "plan A candidate")
  }

  // B commits to the base while A is still in flight.
  place(base, source("interleaved", EAST), 8, 2)
  eq(layoutRevision(base), 2)
  eq(base.modules.length, 2)
  clean(base, "after B")

  const stale = preparePlanDelta({ sourceRevision: jobA.sourceRevision, layout: jobA.layout, baseModules: jobA.baseModules, baseRoutes: jobA.baseRoutes }, base)
  eq(stale.status, "rejected")
  if (stale.status === "rejected") eq(stale.code, "stale-base-revision")
  // Rejection is read-only: A's candidate never touched the base or its claims.
  eq(base.modules.length, 2)
  eq(layoutRevision(base), 2)
  clean(base, "after the stale rejection")

  // The coordinator replans from B's revision; the new delta carries only the consumer, not B.
  const jobA2 = newPlanJob(request([], []), YELLOW, base)
  eq(jobA2.sourceRevision, 2)
  place(jobA2.layout, source("consumer", EAST), 11, 2)
  const a2 = preparePlanDelta({ sourceRevision: jobA2.sourceRevision, layout: jobA2.layout, baseModules: jobA2.baseModules, baseRoutes: jobA2.baseRoutes }, base)
  eq(a2.status, "ready")
  if (a2.status === "ready") {
    eq(a2.delta.baseRevision, 2)
    eq(a2.delta.add.modules.join(","), "consumer")
    eq(a2.delta.remove.modules.length, 0)
    clean(a2.delta.layout, "replan A2")
  }
})

test("sequence: an adopted routed plan is abandoned and replanned on the freed ground", () => {
  const view = free(60, 60)
  const base = newLayout()
  place(base, source("producer", EAST), 10, 10)
  place(base, sink("consumer", EAST), 20, 10)
  const conns: ConnectionRequest[] = [{ id: "line", from: { module: "producer", port: "out" }, to: { module: "consumer", port: "in" } }]
  const job = runJob(routingJob(request([], conns), base), view, F, POLICY)
  eq(job.phase, "done", "the route was planned")

  const planned = preparePlanDelta({ sourceRevision: job.sourceRevision, layout: job.layout, baseModules: job.baseModules, baseRoutes: job.baseRoutes }, base)
  eq(planned.status, "ready", planned.status === "rejected" ? `${planned.code}: ${planned.detail}` : "plan")
  if (planned.status !== "ready") return
  ok(planned.delta.add.routes.length > 0, "the plan adds a route")
  eq(planned.delta.logical.routesByConn["line"]?.length, planned.delta.add.routes.length, "logical evidence names the route")
  clean(planned.delta.layout, "planned route")

  // Adopt: the candidate revision becomes the live layout, with its claims.
  const adopted = cloneLayout(planned.delta.layout)
  eq(layoutRevision(adopted), planned.delta.candidateRevision)
  clean(adopted, "adopted route")

  // Abandon the adopted routes (the pure part of abandonParts): the ground returns to the base state.
  for (const rid of planned.delta.add.routes) {
    ripRoute(adopted, rid)
    eq(adopted.routes[rid], undefined, `route ${rid} is gone`)
  }
  for (const [key, rid] of pairs(adopted.routeOcc)) {
    for (const gone of planned.delta.add.routes) ok(rid !== gone, `route claim ${key as number} released`)
  }
  clean(adopted, "after abandoning the routes")

  // Replan on the freed ground: the delta is based on the current revision and re-adds a route.
  const job2 = runJob(routingJob(request([], conns), adopted), view, F, POLICY)
  eq(job2.phase, "done", "the replan routed")
  const replanned = preparePlanDelta({ sourceRevision: job2.sourceRevision, layout: job2.layout, baseModules: job2.baseModules, baseRoutes: job2.baseRoutes }, adopted)
  eq(replanned.status, "ready")
  if (replanned.status === "ready") {
    eq(replanned.delta.baseRevision, layoutRevision(adopted))
    ok(replanned.delta.add.routes.length > 0, "the replan adds its route again")
    clean(replanned.delta.layout, "replanned route")
  }
})

test("sequence: abandoning a module releases every claim before a replan takes the ground", () => {
  const base = newLayout()
  const temp = place(base, sink("temp", EAST), 3, 3)
  eq(checkLayoutIndexes(base).problems.length, 0)
  eq(checkClaimOwners(base).length, 0)
  ok(base.occ[tkey(3, 3)] !== undefined, "the module holds its footprint")

  unmarkModule(base, temp, F)
  base.modules = base.modules.filter((m) => m.id !== "temp")
  eq(base.modules.length, 0)
  eq(base.occ[tkey(3, 3)], undefined, "the footprint is released")
  clean(base, "after the abandon")

  const job = newPlanJob(request([], []), YELLOW, base)
  place(job.layout, sink("temp", EAST), 3, 3)
  const delta = preparePlanDelta({ sourceRevision: job.sourceRevision, layout: job.layout, baseModules: job.baseModules, baseRoutes: job.baseRoutes }, base)
  eq(delta.status, "ready")
  if (delta.status === "ready") {
    eq(delta.delta.add.modules.join(","), "temp")
    eq(delta.delta.remove.modules.length, 0)
    clean(delta.delta.layout, "replan on the freed ground")
  }
})

run("model-sequences")
