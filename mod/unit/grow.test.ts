import { miningOutpost, smelterColumn } from "../src/modules/generators"
import { transformModule } from "../src/modules/geometry"
import { connectionId, moduleId, routeId } from "../src/shared/ids"
import { beltTiers } from "../src/planner/capacity"
import { checkClaimOwners } from "../src/planner/claims"
import { entityDiff, EntitySpec, factoryReserveTiles, partEntities, routeEntities } from "../src/planner/build-list"
import { FREE, keyX, keyY, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { limitUnderground, planGrowth } from "../src/planner/grow"
import { checkLayout, checkLayoutIndexes, commitModule, findModule, LayoutState, newLayout, PlacedModule, portFeedsRoute, ripRoute, routesLand, sealedGoalPorts, tapTree } from "../src/planner/layout"
import { tryExpand } from "../src/planner/placement"
import { planReroute } from "../src/planner/reroute"
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
  const conns: ConnectionRequest[] = [{ id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }]
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
    { id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
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
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
    { id: connectionId("ore-c"), from: { module: "mine", port: "out" }, to: { module: "c", port: "in-ore" } },
    { id: connectionId("ore-d"), from: { module: "mine", port: "out" }, to: { module: "d", port: "in-ore" } },
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
    { id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
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
  ripRoute(g.layout, routeId("route:ore-a"))
  const now: Record<number, boolean> = {}
  for (const k of factoryReserveTiles(g.layout)) now[k] = true
  const near = (k: number): boolean => {
    const x = keyX(k)
    const y = keyY(k)
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

test("growth tier: undergrounds are capped to 1 until logistics is researched", () => {
  const capped = limitUnderground(TIER, 1)
  eq(capped.maxUnderground, 1)
  eq(capped.belt, TIER.belt)
  eq(limitUnderground(TIER, undefined), TIER)
})


test("B75: growing a consumer fed by a provider-group merge keeps the merge: the second feed side-loads again (vps-b72 4410923)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", ore, 30, 75)
  place(l, "mine2", ore, 75, 75)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } },
    { id: connectionId("ore~2"), from: { module: "mine2", port: "out" }, to: { module: "smelt", port: "in-ore" }, merge: true },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const merged = (layout: LayoutState): number => {
    let n = 0
    for (const rid of layout.routeOrder) {
      const r = layout.routes[rid]
      if (r.merge !== undefined || r.mergeSplitter !== undefined) n++
    }
    return n
  }
  eq(merged(job.layout), 1, "the second feed merges into the first")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "smelt", 1)
  ok(g.ok, `grown: ${g.reason}`)
  eq([...g.rerouted].sort().join(","), "ore,ore~2", "both feeds rerouted")
  eq(merged(g.layout), 1, "the second feed merges again")
  const problems = checkLayout(g.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
})

test("B76: a sealed goal port already fed by a route is no relocation candidate; an unfed one is (vps-b75-r4410923 n15)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 30, 75)
  const conns: ConnectionRequest[] = [{ id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const sealed = (port: string) => ({ kind: "route", subject: `x=>smelt.${port}`, sealed: { side: "goal" as const, port: { module: "smelt", port } } })
  // in-ore is fed by the routed ore belt: its lane is walled in by that belt, not by a pocket.
  eq(sealedGoalPorts(job.layout, [sealed("in-ore")]).length, 0, "a fed port is not relocated")
  const open = sealedGoalPorts(job.layout, [sealed("in-ore"), sealed("in-fuel")])
  eq(open.map((c) => `${c.port.module}.${c.port.port}`).join(","), "smelt.in-fuel", "the unfed port still is")
  eq(sealedGoalPorts(job.layout, [{ ...sealed("in-fuel"), sealed: { side: "goal" as const, port: { module: "smelt", port: "in-fuel" }, edge: true } }]).length, 0, "a flood cut by the window edge is no proof")
  eq(sealedGoalPorts(job.layout, [{ kind: "route", subject: "s", sealed: { side: "start" as const, port: { module: "smelt", port: "in-fuel" } } }]).length, 0, "start side ignored")
})

test("B79: a plain connection into a port a built route already feeds joins that route (vps-b78-r2034469)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", ore, 30, 75)
  place(l, "mine2", ore, 75, 75)
  const first = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }], center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(first.phase, "done", "the first feed routed")
  for (const rid of first.layout.routeOrder) first.layout.routes[rid].fixed = true
  // The design gave the whole consumer to the second provider (no merge flag), but the built belt still feeds the port.
  const second = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore~2"), from: { module: "mine2", port: "out" }, to: { module: "smelt", port: "in-ore" } }], center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, first.layout), view, F, POLICY)
  let why = ""
  for (const [k, v] of pairs(second.failures)) why += `${k}: ${v}; `
  eq(second.phase, "done", `the second feed routed: ${why}`)
  let merged = 0
  for (const rid of second.layout.routeOrder) {
    const r = second.layout.routes[rid]
    if (r.conn === "ore~2" && (r.merge !== undefined || r.mergeSplitter !== undefined)) merged++
  }
  eq(merged, 1, "it joins the built belt")
  const problems = checkLayout(second.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
})

test("B83: routes land at a port directly or through the trunk they merge into; a stub onto a ripped trunk does not (vps-b81-r5480563)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", ore, 30, 75)
  place(l, "mine2", ore, 75, 75)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } },
    { id: connectionId("ore~2"), from: { module: "mine2", port: "out" }, to: { module: "smelt", port: "in-ore" }, merge: true },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const port = { module: "smelt", port: "in-ore" }
  const rid = (conn: string): string => job.layout.routeOrder.find((r) => job.layout.routes[r].conn === conn)!
  const trunk = rid("ore")
  const stub = rid("ore~2")
  ok(routesLand(job.layout, [trunk], port), "the trunk lands on the port")
  ok(routesLand(job.layout, [stub], port), "the merge lands through the trunk")
  ok(!routesLand(job.layout, [trunk], { module: "smelt", port: "in-fuel" }), "not on another port")
  ripRoute(job.layout, trunk as never)
  ok(!routesLand(job.layout, [stub], port), "a stub onto a ripped trunk lands nowhere")
})

test("B84: a source port that already starts a route is known from the layout (vps eecca19 2229258: n6.out)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 30, 75)
  place(l, "mine2", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 75, 75)
  const job = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }], center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  ok(portFeedsRoute(job.layout, { module: "mine", port: "out" }), "mine.out feeds the ore route")
  ok(!portFeedsRoute(job.layout, { module: "mine2", port: "out" }), "mine2.out feeds nothing")
})

test("B86: a ripped trunk routed again lands on its port; the side-load stub left on it is no feed (sweep eecca19 2229258)", () => {
  const view = oreField(120, 120, 60)
  const l = newLayout()
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", ore, 30, 75)
  place(l, "mine2", ore, 75, 75)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } },
    { id: connectionId("ore~2"), from: { module: "mine2", port: "out" }, to: { module: "smelt", port: "in-ore" }, merge: true },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const rid = (layout: LayoutState, conn: string): string => layout.routeOrder.find((r) => layout.routes[r].conn === conn)!
  // A growth rips the trunk (as the root of its group) and routes it again; the stub stays.
  ripRoute(job.layout, rid(job.layout, "ore") as never)
  for (const r of job.layout.routeOrder) job.layout.routes[r].fixed = true
  const again = runJob(newRoutingJob({ modules: [], connections: [conns[0]], center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, job.layout), view, F, POLICY)
  let why = ""
  for (const [k, v] of pairs(again.failures)) why += `${k}: ${v}; `
  eq(again.phase, "done", `trunk routed again: ${why}`)
  const trunk = again.layout.routes[rid(again.layout, "ore") as never]
  eq(trunk.merge === undefined && trunk.mergeSplitter === undefined, true, "the trunk is a plain route, not a merge onto the stub")
  ok(routesLand(again.layout, [rid(again.layout, "ore")], { module: "smelt", port: "in-ore" }), "and it lands on the port")
})

test("B88: a connection planned again while its tapped route stands never taps that route or its taps (vps-b85-r1264816)", () => {
  // B83 dropped the coal-to-power edge but kept its trunk (the smelters' fuel tapped it); planned again, the new route
  // (splitter taps, B84) tapped the old trunk's tap, then replaced the trunk in place, which ripped that tap: an orphan
  // tap, and telemetry crashed on it.
  const view = oreField(120, 120, 45)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "mine", ore, 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  // Where the connection's consumer is now (the trunk no longer lands at it: why B83 dropped the edge).
  place(l, "c", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 95, 55)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  const trunk = job.layout.routeOrder.find((r) => job.layout.routes[r].tapOf === undefined)!
  // What the factory drops with the edge now (B83/B88): the trunk and its tap.
  eq(tapTree(job.layout, [trunk as never]).length, 2, "the trunk's tree holds its tap")
  for (const r of job.layout.routeOrder) job.layout.routes[r].fixed = true
  const conn = job.layout.routes[trunk].conn
  // The planner alone must still not corrupt the layout, whether the plan routes or fails (the old trunk holds the port).
  const replanned: ConnectionRequest = { id: connectionId(conn), from: { module: "mine", port: "out" }, to: { module: "c", port: "in-ore" } }
  const again = runJob(newRoutingJob({ modules: [], connections: [replanned], center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, job.layout), view, F, tapPolicy)
  const orphans = checkLayoutIndexes(again.layout).problems.filter((p) => string.find(p, "taps missing", 1, true)[0] !== undefined)
  eq(orphans.length, 0, orphans.join("; "))
  for (const r of again.layout.routeOrder) ok(again.layout.routes[r].tapOf !== r, `${r} does not tap itself`)
})

test("B88: rerouting a trunk in place routes its taps again with it; nothing is left tapping a missing route", () => {
  // The B83 repair now reroutes an edge's routes in place (planReroute over their whole tap tree) instead of dropping
  // the edge and waiting for the design (vps-b88-r1264816-m60: the power plant stayed crew-fuelled for 400 game-min).
  const view = oreField(120, 120, 45)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "mine", ore, 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  for (const r of job.layout.routeOrder) job.layout.routes[r].fixed = true
  const trunk = job.layout.routeOrder.find((r) => job.layout.routes[r].tapOf === undefined)!
  const tree = tapTree(job.layout, [trunk as never])
  const plan = planReroute(job.layout, view, F, tapPolicy, TIER, tree, { x: 0, y: 0, w: 120, h: 120 })
  ok(plan.ok, `rerouted: ${plan.reason}`)
  const conns2 = plan.layout.routeOrder.map((r) => plan.layout.routes[r].conn).sort().join(",")
  eq(conns2, "ore-a,ore-b", "both connections routed again")
  const orphans = checkLayoutIndexes(plan.layout).problems.filter((p) => string.find(p, "taps missing", 1, true)[0] !== undefined)
  eq(orphans.length, 0, orphans.join("; "))
  ok(routesLand(plan.layout, plan.layout.routeOrder.filter((r) => plan.layout.routes[r].conn === "ore-a"), { module: "a", port: "in-ore" }), "the trunk lands on its port")
})

/** World entity keys a layout's routes build. */
function routeKeys(specs: EntitySpec[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const e of specs) out[string.format("%s@%g,%g:%g:%s", e.name, e.x, e.y, e.dir, e.ioType ?? "")] = true
  return out
}

test("M7c.8: a tap rerouted onto a trunk that stays picks up the trunk's belt under its new splitter and restores the old spot", () => {
  // fixes-360 seed 11: the coal line's reroutes g101/g103 "cannot place splitter@574,-25.5": the trunk's built belt
  // stood there, and only the next repair picked it up as stale; the power plant had no coal meanwhile.
  const view = oreField(120, 120, 45)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  place(l, "b", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 70, 20)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } },
    { id: connectionId("ore-b"), from: { module: "mine", port: "out" }, to: { module: "b", port: "in-ore" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  for (const r of job.layout.routeOrder) job.layout.routes[r].fixed = true
  const tap = job.layout.routeOrder.find((r) => job.layout.routes[r].tapOf !== undefined)!
  const sp = job.layout.routes[tap].steps[0]
  eq(sp.kind, "splitter", "the tap starts at a splitter")
  // Keep the reroute off the old splitter's spot (both sides of its trunk tile): it must tap the trunk elsewhere.
  const blocked: Record<number, boolean> = { [tkey(sp.x2!, sp.y2!)]: true, [tkey(2 * sp.x - sp.x2!, 2 * sp.y - sp.y2!)]: true }
  const view2: TerrainView = { block: (x, y) => (blocked[tkey(x, y)] ? UNKNOWN : view.block(x, y)), ore: view.ore }
  const plan = planReroute(job.layout, view2, F, tapPolicy, TIER, [tap as never], { x: 0, y: 0, w: 120, h: 120 })
  ok(plan.ok, `rerouted: ${plan.reason}`)
  const now = plan.layout.routes[plan.routes.find((r) => plan.layout.routes[r].tapOf !== undefined)!]
  ok(now !== undefined && now.steps[0].kind === "splitter" && (now.steps[0].x !== sp.x || now.steps[0].y !== sp.y), "the new tap's splitter stands elsewhere on the trunk")
  // The world after the plan: what stood, minus what it picks up, plus what it builds, is what the new layout builds.
  const world = routeKeys(routeEntities(job.layout))
  for (const k of Object.keys(routeKeys(plan.remove))) delete world[k]
  for (const k of Object.keys(routeKeys(plan.add))) world[k] = true
  const want = routeKeys(routeEntities(plan.layout))
  const extra = Object.keys(world).filter((k) => !want[k])
  const lacking = Object.keys(want).filter((k) => !world[k])
  eq(extra.length, 0, `left standing: ${extra.slice(0, 3).join("; ")}`)
  eq(lacking.length, 0, `never built: ${lacking.slice(0, 3).join("; ")}`)
})

test("M7 (seed 11 g113): a stuck route reroutes around the tiles its ghosts could not be placed on", () => {
  const view = oreField(120, 120, 45)
  const l = newLayout()
  const tapPolicy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const }
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 50, 70)
  place(l, "a", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 30, 20)
  const conns: ConnectionRequest[] = [{ id: connectionId("ore-a"), from: { module: "mine", port: "out" }, to: { module: "a", port: "in-ore" } }]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, tapPolicy)
  eq(job.phase, "done", "routed")
  const rid = job.layout.routeOrder[0]
  const r = job.layout.routes[rid]
  const mid = r.steps[math.floor(r.steps.length / 2)]
  const avoid: Record<number, boolean> = { [tkey(mid.x, mid.y)]: true }
  const plan = planReroute(job.layout, view, F, tapPolicy, TIER, [rid], { x: 0, y: 0, w: 120, h: 120 }, avoid)
  ok(plan.ok, `rerouted: ${plan.reason}`)
  for (const id of plan.routes) for (const k of plan.layout.routes[id].tiles) ok(!avoid[k], `${id} keeps off ${mid.x},${mid.y}`)
})

/** B91: every join (side-load or splitter merge) points at a tile its trunk still runs straight through. */
function joinsHold(layout: LayoutState): string[] {
  const out: string[] = []
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    const join = r.mergeSplitter ?? r.merge
    if (join === undefined) continue
    const owner = layout.routeOcc[tkey(join.x, join.y)]
    const trunk = owner !== undefined ? layout.routes[owner] : undefined
    if (trunk === undefined || owner === rid) {
      out.push(`${rid}: no trunk at ${join.x},${join.y}`)
      continue
    }
    const i = trunk.steps.findIndex((st) => st.x === join.x && st.y === join.y)
    const st = trunk.steps[i]
    if (st === undefined || st.kind !== "belt" || st.dir !== join.dir) out.push(`${rid}: trunk ${owner} at ${join.x},${join.y} heads ${st?.dir} (${st?.kind}), the join expects ${join.dir}`)
    else if (r.mergeSplitter !== undefined) {
      const next = trunk.steps[i + 1]
      const prev = trunk.steps[i - 1]
      if (next === undefined || next.dir !== st.dir || prev === undefined || prev.dir !== st.dir) out.push(`${rid}: trunk ${owner} turns at its splitter ${join.x},${join.y}`)
    }
  }
  return out
}

test("B91: growing a trunk's producer reroutes the splitter merge joined to the trunk too (sweep 922c77c 2034469)", () => {
  // A growth rerouted a trunk into a curve under a built merge splitter, which then cut the trunk: 2/s of ore made, none
  // arriving, "nothing missing" for 200 game-min. The joins onto a moved route move with it.
  const view = oreField(120, 120, 60)
  const l = newLayout()
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 50, 15)
  place(l, "mine", ore, 30, 75)
  place(l, "mine2", ore, 75, 75)
  const conns: ConnectionRequest[] = [
    { id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } },
    { id: connectionId("ore~2"), from: { module: "mine2", port: "out" }, to: { module: "smelt", port: "in-ore" }, merge: true },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 60, y: 60 }, region: { x: 0, y: 0, w: 120, h: 120 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const splitMerge = job.layout.routeOrder.some((rid) => job.layout.routes[rid].mergeSplitter !== undefined)
  ok(splitMerge, "the second feed joins with a splitter (P44)")
  eq(joinsHold(job.layout).length, 0, joinsHold(job.layout).join("; "))
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "mine", 1)
  ok(g.ok, `grown: ${g.reason}`)
  eq([...g.rerouted].sort().join(","), "ore,ore~2", "the trunk and its join rerouted")
  const bad = joinsHold(g.layout)
  eq(bad.length, 0, bad.join("; "))
})

test("B100: a belt that carries another item after a rebuild is picked up and placed again (its old items go with it)", () => {
  // Soak m6-random20-628fa29 seed 2229258: a smelter column's growth reused its old fuel belt (same tiles, same
  // direction) for its iron output route; the coal on it flowed into the green and red science modules and jammed both
  // for 270 game-min (nothing there takes coal).
  const belt = (x: number, carries: string, owner: string) => ({ name: "transport-belt", x: x + 0.5, y: 0.5, dir: 4, owner, carries })
  const before = [belt(0, "coal", "route:fuel"), belt(1, "coal", "route:fuel"), belt(2, "module:smelt", "smelt")]
  const after = [belt(0, "iron-plate", "route:out"), belt(1, "coal", "route:fuel#kept"), belt(2, "iron-plate", "route:out")]
  const d = entityDiff(before, after)
  eq(d.remove.map((e) => e.x).join(","), "0.5,2.5", "the belts whose item changes are picked up")
  eq(d.add.map((e) => e.x).join(","), "0.5,2.5", "and placed again")
  // The build lists say what each belt carries: its route's item, or its module.
  const view = free(90, 90)
  const l = newLayout()
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 40, 20)
  place(l, "mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), 44, 60)
  const job = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }], center: { x: 45, y: 45 }, region: { x: 0, y: 0, w: 90, h: 90 } }, TIER, l), view, F, POLICY)
  const es = partEntities(job.layout, { modules: ["smelt"], routes: [...job.layout.routeOrder], poles: [] })
  ok(es.some((e) => e.owner === "smelt" && e.carries === "module:smelt"), "module entities carry their module")
  ok(es.some((e) => e.owner !== "smelt" && e.carries === "iron-ore"), "route entities carry the route's item")
})

run("grow")
