import { miningOutpost, smelterColumn } from "../src/modules/generators"
import { beltTiers } from "../src/planner/capacity"
import { factoryReserveTiles, partEntities } from "../src/planner/build-list"
import { FREE, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { planGrowth } from "../src/planner/grow"
import { checkLayout, commitModule, findModule, LayoutState, newLayout, PlacedModule, ripRoute } from "../src/planner/layout"
import { ConnectionRequest, newRoutingJob, runJob } from "../src/planner/plan"
import { selectPolicy } from "../src/planner/policy"
import { ModuleDef } from "../src/modules/types"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: growing a built module in place (expand-first): new units, moved entities, rerouted ports, entity diff.

const POLICY = selectPolicy("early-compact", {})
const TIER = beltTiers(F)[0]

function free(w: number, h: number): TerrainView {
  return { block: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? UNKNOWN : FREE), ore: () => undefined }
}

function place(l: LayoutState, id: string, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id, canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(l, m, F, 2)
  return m
}

test("a built 4-furnace smelter grows to 8: 4 furnaces added, the moved end rebuilt, its routes rerouted and valid", () => {
  const view = free(90, 90)
  const l = newLayout()
  const smelter = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelter, 40, 20)
  place(l, "mine", ore, 44, 60)
  const conns: ConnectionRequest[] = [{ id: "ore", from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 45, y: 45 }, region: { x: 0, y: 0, w: 90, h: 90 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "smelt", 1)
  ok(g.ok, `grown: ${g.reason}`)
  const m = findModule(g.layout, "smelt")!
  eq(m.canonical.params?.furnaces, 4, "params of the base def kept")
  let furnaces = 0
  for (const e of m.def.entities) if (e.name === "stone-furnace") furnaces++
  eq(furnaces, 8, "8 furnaces")
  let added = 0
  for (const e of g.add) if (e.name === "stone-furnace") added++
  eq(added, 4, "4 furnaces to build")
  for (const e of g.remove) ok(e.name !== "stone-furnace", "no furnace picked up")
  ok(g.remove.length > 0, "the moved end is picked up")
  eq(g.rerouted.join(","), "ore", "the ore route rerouted")
  const problems = checkLayout(g.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
})

test("growing a producer with a splitter tap rips and reroutes the tap too (seed 11: tap belts left under the new drills)", () => {
  const view = free(120, 120)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "mine", ore, 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  const conns: ConnectionRequest[] = [
    { id: "ore-a", from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: "ore-b", from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  let tapped = 0
  for (const rid of job.layout.routeOrder) if (job.layout.routes[rid].tapOf !== undefined) tapped++
  eq(tapped, 1, "one splitter tap")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "mine", 1)
  ok(g.ok, `grown: ${g.reason}`)
  eq([...g.rerouted].sort().join(","), "ore-a,ore-b", "the route and its tap rerouted")
  let conns2 = 0
  for (const rid of g.layout.routeOrder) if (g.layout.routes[rid].conn === "ore-b" || g.layout.routes[rid].conn === "ore-a") conns2++
  eq(conns2, 2, "both connections still in the layout")
  // Every piece of the old tap is picked up or part of the new layout: none is left standing, untracked.
  const k = (e: { name: string; x: number; y: number; dir: number }) => string.format("%s@%g,%g:%g", e.name, e.x, e.y, e.dir)
  const accounted: Record<string, boolean> = {}
  for (const e of g.remove) accounted[k(e)] = true
  for (const e of partEntities(g.layout, { modules: [], routes: [...g.layout.routeOrder], poles: [] })) accounted[k(e)] = true
  const tapIds = job.layout.routeOrder.filter((rid) => job.layout.routes[rid].tapOf !== undefined)
  for (const e of partEntities(job.layout, { modules: [], routes: tapIds, poles: [] })) ok(accounted[k(e)] === true, `old tap piece ${k(e)} picked up or kept`)
  const problems = checkLayout(g.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
})

test("the factory's reserved tiles follow its layout: tiles a growth or reroute gives up are released (M6a.2, seed 11)", () => {
  const view = free(120, 120)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  const conns: ConnectionRequest[] = [
    { id: "ore-a", from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: "ore-b", from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "mine", 1)
  ok(g.ok, `grown: ${g.reason}`)
  const after: Record<number, boolean> = {}
  for (const k of factoryReserveTiles(g.layout)) after[k] = true
  // Every module footprint and route tile of the grown layout is reserved, with a one-tile margin around modules.
  for (const m of g.layout.modules) ok(after[tkey(m.rect.x - 1, m.rect.y - 1)] === true && after[tkey(m.rect.x + m.rect.w, m.rect.y + m.rect.h)] === true, `${m.id} margin reserved`)
  for (const rid of g.layout.routeOrder) for (const k of g.layout.routes[rid].tiles) ok(after[k] === true, "route tile reserved")
  // A route the layout gives up (ripped, with its tap) is no longer reserved outside the module margins.
  const old = [...g.layout.routes["route:ore-a"].tiles]
  for (const rid of g.layout.routeOrder) if (g.layout.routes[rid].tapOf === "route:ore-a") for (const k of g.layout.routes[rid].tiles) old.push(k)
  ripRoute(g.layout, "route:ore-a")
  const now: Record<number, boolean> = {}
  for (const k of factoryReserveTiles(g.layout)) now[k] = true
  const near = (k: number): boolean => {
    const x = math.floor(k / 2097152) - 1048576
    const y = (k % 2097152) - 1048576
    for (const m of g.layout.modules) if (x >= m.rect.x - 1 && x <= m.rect.x + m.rect.w && y >= m.rect.y - 1 && y <= m.rect.y + m.rect.h) return true
    return false
  }
  let released = 0
  for (const k of old) if (!near(k)) {
    ok(now[k] === undefined, "a given-up route tile is released")
    released++
  }
  ok(released > 10, `route tiles released (${released})`)
})

run("grow")
