// T1 tests for the M5c planner batch: B7 belt bundling, B9 soft claims, D36 undergrounds and B2 splitters (the
// "research logistics first when it saves N tiles" comparisons).

import { smelterColumn } from "../src/modules/generators"
import { IDENTITY, Transform, transformModule } from "../src/modules/geometry"
import { EAST, ModuleDef, NORTH, Port, SOUTH } from "../src/modules/types"
import { beltTiers } from "../src/planner/capacity"
import { asciiTerrain, keyX, keyY, rectContains, TerrainView, tkey } from "../src/planner/grid"
import { checkLayout, commitModule, findModule, growthArea, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { placeNow, tryExpand } from "../src/planner/placement"
import { CompareResult, ConnectionRequest, logisticsFirst, newRouteLength, newRoutingJob, PlanJob, PlanRequest, runJob } from "../src/planner/plan"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

const TIERS = beltTiers(F)
const YELLOW = TIERS[0]

function policy(router: Partial<LayoutPolicy["router"]> = {}, placement: Partial<LayoutPolicy["placement"]> = {}, rest: Partial<LayoutPolicy> = {}): LayoutPolicy {
  const p = selectPolicy("early-compact", {})
  return { ...p, ...rest, router: { ...p.router, ...router }, placement: { ...p.placement, ...placement } }
}

function box(id: string, w: number, h: number, ports: Port[]): ModuleDef {
  return { id, source: "generated", footprint: { w, h }, entities: [], ports, recipes: [], machines: [], rates: { inputs: [], outputs: [] }, requiresTech: [], rotatable: true, mirrorable: true }
}
function source(id: string, dir: number, item = "iron-plate"): ModuleDef {
  return box(id, 1, 1, [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item }])
}
function sink(id: string, dir: number, item = "iron-plate"): ModuleDef {
  return box(id, 1, 1, [{ id: "in", kind: "belt-in", pos: { x: 0.5, y: 0.5 }, dir: dir as 0, item }])
}
function place(state: LayoutState, def: ModuleDef, x: number, y: number, t: Transform = IDENTITY, corridor = 0): PlacedModule {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  const m: PlacedModule = { id: def.id, canonical: def, def: d, transform: t, origin: { x, y }, rect: { x, y, w: d.footprint.w, h: d.footprint.h } }
  commitModule(state, m, F, corridor)
  return m
}
function conn(id: string, from: string | undefined, to: string): ConnectionRequest {
  return { id, from: from !== undefined ? { module: from, port: "out" } : undefined, to: { module: to, port: "in" } }
}
function request(modules: ModuleDef[], connections: ConnectionRequest[], w: number, h: number): PlanRequest {
  return { modules: modules.map((def) => ({ id: def.id, def })), connections, center: { x: math.floor(w / 2), y: math.floor(h / 2) }, region: { x: 0, y: 0, w, h } }
}
function field(w: number, h: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < h; y++) rows.push(string.rep(".", w))
  return rows
}
function maxUg(this: void, name: string): number {
  return name === "underground-belt" ? 5 : 7
}
function noProblems(state: LayoutState, terrain: TerrainView, what: string): void {
  const c = checkLayout(state, terrain, maxUg)
  if (c.problems.length > 0) error(`${what}: ${c.problems.join("; ")}`, 2)
}

/** Tiles of route `id` next to (4-neighbour) a tile of another route. */
function bundled(state: LayoutState, id: string): number {
  let n = 0
  for (const k of state.routes[id].tiles) {
    const x = keyX(k)
    const y = keyY(k)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = state.routeOcc[tkey(x + dx, y + dy)]
      if (o !== undefined && o !== id) {
        n++
        break
      }
    }
  }
  return n
}

// --- B7: belt bundling ----------------------------------------------------------------------------------------

/** Two flows from the west edge to the south-east: many equally short paths each. */
function bundleCase(pol: LayoutPolicy): LayoutState {
  const terrain = asciiTerrain(field(60, 50))
  const state = newLayout()
  const a1 = source("a1", EAST)
  const a2 = source("a2", EAST)
  const b1 = sink("b1", SOUTH)
  const b2 = sink("b2", SOUTH)
  place(state, a1, 2, 4)
  place(state, a2, 2, 2)
  place(state, b1, 40, 40)
  place(state, b2, 42, 40)
  const job = runJob(newRoutingJob(request([a1, a2, b1, b2], [conn("r1", "a1", "b1"), conn("r2", "a2", "b2")], 60, 50), YELLOW, state, ["r1", "r2"]), terrain, F, pol)
  eq(job.phase, "done", "routed")
  noProblems(state, terrain, "bundle case")
  return state
}

test("B7: routes next to another route's belts bundle (bundleFactor), at about the same length", () => {
  const off = bundleCase(policy({ bundleFactor: 1 }))
  const on = bundleCase(policy({ bundleFactor: EARLY_BUNDLE }))
  const offB = bundled(off, "route:r2")
  const onB = bundled(on, "route:r2")
  const offLen = off.routes["route:r1"].length + off.routes["route:r2"].length
  const onLen = on.routes["route:r1"].length + on.routes["route:r2"].length
  print(string.format("    [b7] second route's tiles next to the first: off %d of %d, on %d of %d; total length off %d, on %d", offB, off.routes["route:r2"].length, onB, on.routes["route:r2"].length, offLen, onLen))
  ok(onB > offB, `more bundled tiles with the bonus (${onB} vs ${offB})`)
  ok(onB >= on.routes["route:r2"].length / 2, "at least half of the second route runs along the first")
  ok(onLen <= offLen + 4, `bundling costs at most a few tiles (${onLen} vs ${offLen})`)
  eq(EARLY_BUNDLE, 0.9, "early-compact bundleFactor")
})

const EARLY_BUNDLE = selectPolicy("early-compact", {}).router.bundleFactor

test("B7: the bonus never opens a port's reserved outside or approach tiles (P5, P15)", () => {
  // A sink whose input lane (outside + approach tile) lies right along the first route: the second route bundles
  // but must not take the reserved tiles.
  const terrain = asciiTerrain(field(50, 30))
  const state = newLayout()
  const a1 = source("a1", EAST)
  const a2 = source("a2", EAST)
  const b1 = sink("b1", EAST)
  const b2 = sink("b2", EAST)
  const c = sink("c", NORTH)
  place(state, a1, 2, 10)
  place(state, a2, 2, 12)
  place(state, b1, 40, 10)
  place(state, b2, 40, 12)
  // c's in-port faces north: its outside tile (20, 12) and approach tile (20, 13) are reserved, between the routes.
  place(state, c, 20, 11)
  const job = runJob(newRoutingJob(request([a1, a2, b1, b2, c], [conn("r1", "a1", "b1"), conn("r2", "a2", "b2")], 50, 30), YELLOW, state, ["r1", "r2"]), terrain, F, policy({ bundleFactor: 0.5 }))
  eq(job.phase, "done", "routed")
  noProblems(state, terrain, "reserved")
  for (const id of ["route:r1", "route:r2"]) for (const k of state.routes[id].tiles) ok(state.reserved[k] === undefined || state.reserved[k] === `p:b1.in` || state.reserved[k] === `p:b2.in` || state.reserved[k] === `p:a1.out` || state.reserved[k] === `p:a2.out`, `${id} keeps off c's reserved tiles (${keyX(k)},${keyY(k)})`)
})

// --- B9: soft claims ------------------------------------------------------------------------------------------

test("B9: an expandable module's soft claim is exactly where tryExpand grows it, for every transform", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const units = def.expand!.maxUnits
  ok(units >= 2, `room to grow (${units} units)`)
  for (const t of [{ rot: 0, mirror: false }, { rot: 1, mirror: false }, { rot: 2, mirror: true }, { rot: 3, mirror: false }]) {
    const terrain = asciiTerrain(field(120, 120))
    const state = newLayout()
    const m = place(state, { ...def, id: "s" }, 50, 50, t, 2)
    const area = growthArea(m)!
    ok(area !== undefined, "has a growth area")
    let soft = 0
    for (const [, owner] of pairs(state.soft ?? {})) if (owner === "s") soft++
    eq(soft, area.w * area.h, `soft tiles = growth area (rot ${t.rot})`)
    const before = { ...m.rect }
    const r = tryExpand(state, terrain, F, policy(), "s", units)
    ok(r.ok, `grows by ${units} (${r.reason})`)
    const grown = findModule(state, "s")!.rect
    for (let x = grown.x; x < grown.x + grown.w; x++) {
      for (let y = grown.y; y < grown.y + grown.h; y++) {
        if (rectContains(before, x, y)) continue
        ok(rectContains(area, x, y), `grown tile ${x},${y} was in the soft claim (rot ${t.rot})`)
      }
    }
    eq(grown.w * grown.h - before.w * before.h, area.w * area.h, "grown by exactly the claim")
    eq(growthArea(findModule(state, "s")!), undefined, "at its cap: no claim left")
    let left = 0
    for (const [, owner] of pairs(state.soft ?? {})) if (owner === "s") left++
    eq(left, 0, "claim released when grown to the cap")
  }
})

test("B9: placement keeps off another module's growth area (a cost, not a block)", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const terrain = asciiTerrain(field(120, 120))
  const state = newLayout()
  const m = place(state, { ...def, id: "s" }, 50, 30, IDENTITY, 2)
  const area = growthArea(m)!
  // A small module whose cluster centre is in the middle of the growth area.
  const other = box("o", 4, 4, [])
  const center = { x: area.x + math.floor(area.w / 2), y: area.y + math.floor(area.h / 2) }
  const req = { id: "o", def: other, targets: {}, center, region: { x: 0, y: 0, w: 120, h: 120 } }
  const overlaps = (r: { x: number; y: number; w: number; h: number }): boolean => r.x < area.x + area.w && area.x < r.x + r.w && r.y < area.y + area.h && area.y < r.y + r.h
  const without = placeNow(req, state, terrain, policy({}, { softClaim: 0 }))
  eq(without.phase, "done", "placed without the weight")
  ok(overlaps(without.result!.rect), "without the weight it sits in the growth area")
  // The mechanism at weight 0.5 (early-compact's default since D50).
  const withW = placeNow(req, state, terrain, policy({}, { softClaim: 0.5 }))
  eq(withW.phase, "done", "placed with the weight")
  ok(!overlaps(withW.result!.rect), `with the weight it keeps off (${withW.result!.rect.x},${withW.result!.rect.y})`)
  // A wall of cliffs everywhere but the growth area: the claim does not block.
  const rows = field(120, 120)
  for (let y = 0; y < 120; y++) {
    let r = ""
    for (let x = 0; x < 120; x++) r += rectContains(area, x, y) || rectContains(m.rect, x, y) ? "." : "C"
    rows[y] = r
  }
  const forced = placeNow({ ...req, region: { x: 0, y: 0, w: 120, h: 120 } }, state, asciiTerrain(rows), policy({}, { softClaim: 0.5 }))
  eq(forced.phase, "done", "still placeable inside the claim when nothing else is free")
})

test("D50: a module's own partners are exempt from its soft claim at placement (its ports sit at the growing end)", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const terrain = asciiTerrain(field(120, 120))
  const state = newLayout()
  const m = place(state, { ...def, id: "s" }, 50, 30, IDENTITY, 2)
  const area = growthArea(m)!
  const other = box("o", 4, 4, [])
  const center = { x: area.x + math.floor(area.w / 2), y: area.y + math.floor(area.h / 2) }
  const overlaps = (r: { x: number; y: number; w: number; h: number }): boolean => r.x < area.x + area.w && area.x < r.x + r.w && r.y < area.y + area.h && area.y < r.y + r.h
  const req = { id: "o", def: other, targets: {}, center, region: { x: 0, y: 0, w: 120, h: 120 } }
  const stranger = placeNow(req, state, terrain, policy({}, { softClaim: 0.5 }))
  ok(!overlaps(stranger.result!.rect), "an unrelated module keeps off")
  const partner = placeNow({ ...req, softExempt: { s: true } }, state, terrain, policy({}, { softClaim: 0.5 }))
  eq(partner.phase, "done", "placed")
  ok(overlaps(partner.result!.rect), "the smelter's partner may sit at its growing end")
})

// --- B26: growth bands stay clear -------------------------------------------------------------------------------

/** The old (pre-B26) placement: no near-band weight, no own-band check. */
const OLD_B26 = { growthBand: 0, growthBlocked: 0 }

function overlapsRect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

test("B26 (a): a module is not placed in the near part of an expandable module's growth band while an alternative exists", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const terrain = asciiTerrain(field(120, 120))
  const state = newLayout()
  const m = place(state, { ...def, id: "s" }, 50, 30, IDENTITY, 2)
  const area = growthArea(m)!
  const units = policy().placement.growthBandUnits!
  ok(units >= 1, "a near band")
  const unit = def.expand!.unit.footprint.h
  // IDENTITY: the column grows south; its near band is the first `units` units below it.
  const near = { x: area.x, y: area.y, w: area.w, h: units * unit }
  // An unrelated module (not a partner: partners stay exempt, P28) pulled into the first growth unit by its cluster
  // centre and by its input's source just there: at 0.5 per tile the soft claim alone loses to that pull.
  const mid = { x: area.x + math.floor(area.w / 2), y: area.y + 2 }
  const def4: ModuleDef = box("o", 4, 4, [{ id: "in", kind: "belt-in", pos: { x: 1.5, y: 0.5 }, dir: SOUTH as 0, item: "iron-plate" }])
  const req = { id: "o", def: def4, targets: { in: mid }, center: mid, region: { x: 0, y: 0, w: 120, h: 120 } }
  const old = placeNow(req, state, terrain, policy({}, OLD_B26))
  eq(old.phase, "done", "placed (old)")
  ok(overlapsRect(old.result!.rect, near), `old placement: it sits in the near band and blocks the growth (${old.result!.rect.x},${old.result!.rect.y})`)
  const now = placeNow(req, state, terrain, policy())
  eq(now.phase, "done", "placed")
  ok(!overlapsRect(now.result!.rect, near), `it keeps off the near band (${now.result!.rect.x},${now.result!.rect.y})`)
  // Nothing else fits (cliffs everywhere but the column and its near band): placed there anyway, and the later growth
  // failure names the blocker.
  const rows = field(120, 120)
  for (let y = 0; y < 120; y++) {
    let r = ""
    for (let x = 0; x < 120; x++) r += rectContains(near, x, y) || rectContains(m.rect, x, y) ? "." : "C"
    rows[y] = r
  }
  const walled = asciiTerrain(rows)
  const forced = placeNow(req, state, walled, policy())
  eq(forced.phase, "done", "still placeable in the near band when nothing else is free")
  const after = newLayout()
  place(after, { ...def, id: "s" }, 50, 30, IDENTITY, 2)
  place(after, def4, forced.result!.rect.x, forced.result!.rect.y, IDENTITY, 2)
  const r = tryExpand(after, walled, F, policy(), "s", units)
  ok(!r.ok && string.sub(r.reason ?? "", 1, 11) === "occupied at", `growth fails naming the blocker (${r.reason})`)
})

test("B26 (b): a 4-furnace smelter beside ore and a neighbour's growth band takes the site whose own near band is clear", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  // The near band (B26 checks the units growth needs first, `growthBandUnits`).
  const units = policy().placement.growthBandUnits!
  // Iron ore south of the cluster centre; a neighbouring column north of it, growing south toward the centre.
  const rows = field(140, 140)
  for (let y = 74; y < 120; y++) rows[y] = string.rep(".", 30) + string.rep("i", 80) + string.rep(".", 30)
  const terrain = asciiTerrain(rows)
  const build = (pol: LayoutPolicy): { state: LayoutState; m: PlacedModule } => {
    const state = newLayout()
    place(state, { ...def, id: "n" }, 64, 20, IDENTITY, 2)
    const req = { id: "s", def: { ...def, id: "s" }, targets: {}, center: { x: 70, y: 66 }, region: { x: 0, y: 0, w: 140, h: 140 } }
    const p = placeNow(req, state, terrain, pol)
    eq(p.phase, "done", "placed")
    commitModule(state, p.result!, F, 2)
    return { state, m: p.result! }
  }
  const grows = (state: LayoutState, id: string): string | undefined => {
    const r = tryExpand(state, terrain, F, policy(), id, units)
    return r.ok ? undefined : r.reason
  }
  const old = build(policy({}, OLD_B26))
  const oldWhy = grows(old.state, "s")
  print(string.format("    [b26] old placement at %d,%d rot %d: near growth %s", old.m.origin.x, old.m.origin.y, old.m.transform.rot, oldWhy ?? "ok"))
  ok(oldWhy !== undefined, "old placement: the smelter's own band is blocked (ore or the neighbour's claim)")
  const now = build(policy())
  const why = grows(now.state, "s")
  print(string.format("    [b26] new placement at %d,%d rot %d", now.m.origin.x, now.m.origin.y, now.m.transform.rot))
  eq(why, undefined, `the smelter can grow by its ${units} near units`)
  const nState = newLayout()
  place(nState, { ...def, id: "n" }, 64, 20, IDENTITY, 2)
  commitModule(nState, now.m, F, 2)
  const nWhy = tryExpand(nState, terrain, F, policy(), "n", units)
  ok(nWhy.ok, `and the neighbour still can (${nWhy.reason})`)
})

test("B9: routes detour around a growth area when the detour is short", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const terrain = asciiTerrain(field(80, 80))
  const build = (soft: number): LayoutState => {
    const state = newLayout()
    const m = place(state, { ...def, id: "s" }, 30, 10, IDENTITY, 2)
    const area = growthArea(m)!
    // A flow straight across the growth area, west to east.
    const y = area.y + area.h - 2
    const a = source("a", EAST)
    const b = sink("b", EAST)
    place(state, a, area.x - 6, y)
    place(state, b, area.x + area.w + 6, y)
    const job = runJob(newRoutingJob(request([a, b], [conn("c", "a", "b")], 80, 80), YELLOW, state), terrain, F, policy({ softClaim: soft }))
    eq(job.phase, "done", "routed")
    return state
  }
  const inside = (state: LayoutState): number => {
    let n = 0
    for (const k of state.routes["route:c"].tiles) if (state.soft?.[k] !== undefined) n++
    return n
  }
  const off = build(0)
  const on = build(2)
  print(string.format("    [b9] route tiles in the growth area: weight 0 → %d, weight 2 → %d", inside(off), inside(on)))
  ok(inside(off) > 0, "without the weight the route crosses the growth area")
  ok(inside(on) < inside(off), "with the weight it crosses fewer claimed tiles")
})

// --- D36 undergrounds / B2 splitters: the comparison --------------------------------------------------------

const NO_UG = { ...YELLOW, maxUnderground: 1 }

function result(job: PlanJob, kind: CompareResult["kind"]): CompareResult {
  for (const r of job.compare?.results ?? []) if (r.kind === kind) return r
  error(`no ${kind} result`)
}

/** A 3-wide river from the top down to `gapY`, a source west of it and a sink east of it (routes must go round). */
function riverCase(gapY: number): PlanJob {
  const rows = field(60, 80)
  // The router's window reaches `margin` tiles past the endpoints: wide enough for the detour.
  for (let y = 0; y < gapY; y++) rows[y] = rows[y].substring(0, 28) + "~~~" + rows[y].substring(31)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 10, 5)
  place(state, b, 50, 5)
  const req = request([a, b], [conn("c", "a", "b")], 60, 80)
  req.compare = { undergrounds: { tiers: TIERS }, workFactor: 2, minWork: 5000 }
  const job = runJob(newRoutingJob(req, NO_UG, state), terrain, F, policy({ margin: 40 }))
  eq(job.phase, "done", "planned without undergrounds")
  noProblems(job.layout, terrain, "river case")
  eq(job.layout.routes["route:c"].undergrounds, 0, "the plan itself has no undergrounds")
  return job
}

test("D36: a river 30 tiles long: the underground route is ≥ 50 tiles shorter", () => {
  const job = riverCase(40)
  const r = result(job, "undergrounds")
  print(string.format("    [d36] long river: without %d, with undergrounds %s (saving %s), alternative work %g", r.base, tostring(r.alt), tostring(r.saving), r.work))
  eq(r.status, "done", "alternative routed")
  ok(r.saving! >= 50, `saving ${r.saving} ≥ 50`)
  eq(r.base, newRouteLength(job.layout, job.baseRoutes), "base = the plan's route length")
  ok(job.layout.routes["route:c"] !== undefined, "the plan's own route is kept")
})

test("D36: a short river: the underground route saves less than 50 tiles", () => {
  const r = result(riverCase(12), "undergrounds")
  print(string.format("    [d36] short river: without %d, with undergrounds %s (saving %s) %s", r.base, tostring(r.alt), tostring(r.saving), tostring(r.reason)))
  eq(r.status, "done", "alternative routed")
  ok(r.saving! > 0 && r.saving! < 50, `0 < saving ${r.saving} < 50`)
})

test("D36: the alternative's work is bounded (capped alternatives are no evidence)", () => {
  const rows = field(60, 80)
  for (let y = 0; y < 40; y++) rows[y] = rows[y].substring(0, 28) + "~~~" + rows[y].substring(31)
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  const a = source("a", EAST)
  const b = sink("b", EAST)
  place(state, a, 10, 5)
  place(state, b, 50, 5)
  const req = request([a, b], [conn("c", "a", "b")], 60, 80)
  req.compare = { undergrounds: { tiers: TIERS }, workFactor: 0, minWork: 5 }
  const job = runJob(newRoutingJob(req, NO_UG, state), terrain, F, policy({ margin: 40 }), 50)
  const r = result(job, "undergrounds")
  eq(r.status, "capped", "capped")
  ok(r.work <= 5 + 50, `work ${r.work} within the cap plus one step`)
  eq(job.phase, "done", "the plan itself still finishes")
})

/** Two consumers of coal in the west, their coal producers far east (each with an ore feeder): point-to-point. */
function coalCase(east: number): PlanJob {
  const terrain = asciiTerrain(field(east + 12, 40))
  const state = newLayout()
  const s1 = sink("s1", EAST, "coal")
  const s2 = sink("s2", EAST, "coal")
  const k1 = box("k1", 1, 1, [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST_DIR, item: "coal" }])
  const k2 = box("k2", 2, 1, [
    { id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST_DIR, item: "coal" },
    { id: "in", kind: "belt-in", pos: { x: 1.5, y: 0.5 }, dir: WEST_DIR, item: "stone" },
  ])
  const o2 = source("o2", WEST_DIR, "stone")
  place(state, s1, 8, 10)
  place(state, s2, 8, 20)
  place(state, k1, east, 12)
  place(state, k2, east, 18)
  place(state, o2, east + 6, 18)
  const req = request([s1, s2, k1, k2, o2], [conn("c1", "k1", "s1"), conn("c2", "k2", "s2"), conn("ore", "o2", "k2")], east + 12, 40)
  req.compare = { splitters: { items: ["coal"] }, workFactor: 2, minWork: 5000 }
  const job = runJob(newRoutingJob(req, NO_UG, state), terrain, F, policy())
  eq(job.phase, "done", "planned point-to-point")
  return job
}

const WEST_DIR = 12 as 0

test("B2: two far coal producers: one producer with a splitter tap is ≥ 50 tiles shorter; its supply chain is dropped", () => {
  const job = coalCase(70)
  const r = result(job, "splitters")
  print(string.format("    [b2] far: point-to-point %d, splitter taps %s (saving %s); dropped %s", r.base, tostring(r.alt), tostring(r.saving), (r.dropped ?? []).join(",")))
  eq(r.status, "done", `alternative routed (${r.reason})`)
  ok(r.saving! >= 50, `saving ${r.saving} ≥ 50`)
  eq((r.merged?.coal ?? []).join(","), "s1,s2", "one coal producer would feed s1 and s2")
  eq((r.dropped ?? []).join(","), "k2,o2", "k2 and its ore feeder dropped (k1 is nearer to both)")
})

test("B2: near coal producers: splitter taps save less than 50 tiles", () => {
  const r = result(coalCase(20), "splitters")
  print(string.format("    [b2] near: point-to-point %d, splitter taps %s (saving %s)", r.base, tostring(r.alt), tostring(r.saving)))
  eq(r.status, "done", "alternative routed")
  ok(r.saving! < 50, `saving ${r.saving} < 50`)
})

test("D36 / B2: the decision: research first only at or above the threshold; capped or failed alternatives don't count", () => {
  const ug = (status: CompareResult["status"], saving?: number): CompareResult => ({ kind: "undergrounds", status, base: 100, alt: saving !== undefined ? 100 - saving : undefined, saving, work: 10 })
  const sp: CompareResult = { kind: "splitters", status: "done", base: 120, alt: 60, saving: 60, work: 10, merged: { coal: ["n1", "n2"] } }
  eq(logisticsFirst([ug("done", 50)], 50, 50).undergrounds, true, "50 ≥ 50")
  eq(logisticsFirst([ug("done", 49)], 50, 50).undergrounds, false, "49 < 50")
  eq(logisticsFirst([ug("capped")], 50, 50).undergrounds, false, "capped: no evidence")
  eq(logisticsFirst([ug("failed")], 50, 50).undergrounds, false, "failed: no evidence")
  eq(logisticsFirst([ug("done", 80)], 0, 50).undergrounds, false, "threshold 0 = rule off")
  const d = logisticsFirst([ug("done", 10), sp], 50, 50)
  eq(d.undergrounds, false, "undergrounds not worth it")
  eq(d.splitters, true, "splitters are")
  eq((d.taps.coal ?? []).join(","), "n1,n2", "taps recorded")
  eq(logisticsFirst([sp], 50, 61).splitters, false, "own threshold for splitters")
  eq(d.why.length, 2, "one line per alternative")
})

run("planner-batch")
