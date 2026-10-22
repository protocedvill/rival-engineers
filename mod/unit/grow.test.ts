import { miningOutpost, smelterColumn } from "../src/modules/generators"
import { transformModule } from "../src/modules/geometry"
import { moduleId } from "../src/shared/ids"
import { beltTiers } from "../src/planner/capacity"
import { checkClaimOwners } from "../src/planner/claims"
import { factoryReserveTiles, partEntities } from "../src/planner/build-list"
import { FREE, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { planGrowth } from "../src/planner/grow"
import { checkLayout, commitModule, findModule, LayoutState, newLayout, PlacedModule, ripRoute } from "../src/planner/layout"
import { tryExpand } from "../src/planner/placement"
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

/** Free terrain with iron ore from row `fromY` down (the mines' patch; the smelters stand north of it). */
function oreField(w: number, h: number, fromY: number): TerrainView {
  return { block: free(w, h).block, ore: (x, y) => (y >= fromY && x >= 0 && x < w && y < h ? "iron-ore" : undefined) }
}

function place(l: LayoutState, id: string, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(l, m, F, 2)
  return m
}

function claimProblems(layout: LayoutState): string[] {
  return checkClaimOwners(layout)
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
  const claims = claimProblems(g.layout)
  eq(claims.length, 0, claims.join("; "))
})

test("growing a producer with a splitter tap rips and reroutes the tap too (seed 11: tap belts left under the new drills)", () => {
  const view = oreField(120, 120, 45)
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
  const claims = claimProblems(g.layout)
  eq(claims.length, 0, claims.join("; "))
})

test("growing a module fed by a tap of its tap group rips the whole group (M6a.2, seed 222: route at 41,367)", () => {
  const view = free(120, 120)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "mine", ore, 50, 70)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "c", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  place(l, "d", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 10, 20)
  const conns: ConnectionRequest[] = [
    { id: "ore-b", from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
    { id: "ore-c", from: { module: "mine", port: "out" }, to: { module: "c", port: "in-ore" } },
    { id: "ore-d", from: { module: "mine", port: "out" }, to: { module: "d", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  // The chain is rooted at the first-routed route: the route feeding d is a tap, and its root feeds b instead.
  let dRoute = ""
  for (const rid of job.layout.routeOrder) if (job.layout.routes[rid].to.module === "d") dRoute = rid
  ok(dRoute !== "", "a route feeds d")
  const dr = job.layout.routes[dRoute]
  ok(dr.tapOf !== undefined, "the route feeding d is a tap of the group")
  ok(dr.tapOf !== undefined && job.layout.routes[dr.tapOf].to.module === "b", "the root feeds b (not d)")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "d", 1)
  ok(g.ok, `grown: ${g.reason}`)
  eq([...g.rerouted].sort().join(","), "ore-b,ore-c,ore-d", "the whole tap group rerouted")
  const problems = checkLayout(g.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
  const claims = claimProblems(g.layout)
  eq(claims.length, 0, claims.join("; "))
})

test("a mining outpost doesn't grow onto worked-out ground: every new drill needs its ore in reach (M6a.2, seed 222)", () => {
  const mk = (oreRows: number): TerrainView => ({
    block: (x, y) => (x < 0 || y < 0 || x >= 90 || y >= 90 ? UNKNOWN : FREE),
    ore: (x, y) => (y >= 55 && y < 55 + oreRows && x >= 30 && x < 70 ? "iron-ore" : undefined),
  })
  const l = newLayout()
  const mine = place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 44, 60)
  const rich = planGrowth(l, mk(40), F, POLICY, TIER, "mine", 1)
  ok(rich.ok, `grows on ore: ${rich.reason}`)
  // Ore only under the built drills (the rest worked out): the growth is refused, whichever end it takes.
  const r2 = planGrowth(l, { block: mk(0).block, ore: (x, y) => (x >= mine.rect.x - 2 && x < mine.rect.x + mine.rect.w + 2 && y >= mine.rect.y - 2 && y < mine.rect.y + mine.rect.h + 2 ? "iron-ore" : undefined) }, F, POLICY, TIER, "mine", 1)
  ok(!r2.ok && string.find(r2.reason ?? "", "no iron-ore under a drill", 1, true)[0] !== undefined, `refused: ${r2.reason}`)
})

test("a mining outpost may grow beside another mine, but not beside a non-mining module (M6a.2, seed 222)", () => {
  // Ore starts at the built mine: tail growth has ore, while the opposite/head fallback does not.
  const view = oreField(120, 120, 70)
  const mine = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const l = newLayout()
  place(l, "a", mine, 50, 70)
  const rotated = transformModule(mine, { rot: 2, mirror: false })
  const b: PlacedModule = { id: moduleId("b"), canonical: mine, def: rotated, transform: { rot: 2, mirror: false }, origin: { x: 50, y: 83 }, rect: { x: 50, y: 83, w: rotated.footprint.w, h: rotated.footprint.h }, fixed: true }
  commitModule(l, b, F, 2)
  const besideMine = planGrowth(l, view, F, POLICY, TIER, "a", 1)
  ok(besideMine.ok, `mine adjacency allowed: ${besideMine.reason}`)

  const blocked = newLayout()
  place(blocked, "a", mine, 50, 70)
  place(blocked, "c", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 44, 83)
  const besideSmelter = tryExpand(blocked, view, F, POLICY, "a", 1, "tail")
  ok(!besideSmelter.ok && string.find(besideSmelter.reason ?? "", "too close to m:c", 1, true)[0] !== undefined, `non-mine adjacency refused: ${besideSmelter.reason}`)
})

test("the factory's reserved tiles follow its layout: tiles a growth or reroute gives up are released (M6a.2, seed 11)", () => {
  const view = oreField(120, 120, 45)
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
