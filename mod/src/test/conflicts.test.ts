import { LuaEntity } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { moduleId, connectionId, routeId } from "../shared/ids"
import { createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { allParts, partEntities } from "../planner/build-list"
import { beltTiers } from "../planner/capacity"
import { abandonParts, applyDiff, checkBuild, staleUnderRoutes } from "../planner/conflicts"
import { FOREIGN, keyX, keyY, tkey, Vec } from "../planner/grid"
import { commitModule, findModule, LayoutState, newLayout, PlacedModule } from "../planner/layout"
import { newRoutingJob, runJob } from "../planner/plan"
import { selectPolicy } from "../planner/policy"
import { planReroute } from "../planner/reroute"
import { claimView, stampParts } from "../planner/runtime"
import { newTerrain, requestArea, stepTerrain, terrainView } from "../planner/terrain"
import { startBootstrap } from "../strategy/bootstrap"
import { claimOreField } from "../world/claims"
import { at, createLab, Lab } from "./lab"
import { followRoute } from "./route-lab"
import { getPlannerEntry, removePlan, startBuild, startPlan, tappedBelts } from "../planner/runtime"
import { addPlaceJob, addStockpile } from "../jobs/faction"

// M5a.2: factions sharing ground. A faction never plans on another faction's claim (its reserved tiles) or ghosts; a
// route blocked by something the faction doesn't own is rerouted (old pieces picked up); a module whose ground was
// taken is given up (its built entities deconstructed, its parts dropped from the layout).

const FOREIGN_FORCE = "player"

let seq = 0
function faction(lab: Lab, tag: string, dx: number, dy: number, paused = true): FactionState {
  const f = createFaction(`conf-${tag}-${++seq}`, { position: at(lab, dx, dy), crew: 1, starterItems: {} })
  startBootstrap(f, at(lab, dx, dy))
  f.paused = paused
  return f
}

function scan(lab: Lab, id: string, force: string) {
  const t = newTerrain(id, lab.surface.name, force)
  const r = lab.radius
  requestArea(t, { x: math.floor(lab.origin.x) - r, y: math.floor(lab.origin.y) - r, w: 2 * r, h: 2 * r })
  while (stepTerrain(t, 100) > 0) {
    // synchronous scan for the test
  }
  return t
}

function place(layout: LayoutState, id: string, gen: Parameters<typeof generatedModule>[0], params: Record<string, unknown>, origin: Vec): PlacedModule {
  const def = generatedModule(gen, params)
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(layout, m, prototypeFacts, 2)
  return m
}

function revive(ghosts: LuaEntity[]): number {
  let n = 0
  for (const g of ghosts) {
    if (!g.valid) continue
    const [, e] = g.revive({ raise_revive: true })
    if (e !== undefined) n++
  }
  return n
}

/** A mining outpost and a smelter column 60 tiles apart, joined by an ore route; modules built, the route as ghosts. */
function smeltingLab(lab: Lab, force: string): { layout: LayoutState; ghosts: LuaEntity[] } {
  const s = lab.surface
  const ox = math.floor(lab.origin.x)
  const oy = math.floor(lab.origin.y)
  for (let x = -20; x < 0; x++) for (let y = 30; y < 50; y++) s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount: 100000 })
  const t = scan(lab, `conf-${++seq}`, force)
  const layout = newLayout()
  place(layout, "smelt", "smelter-column", { recipe: "iron-plate", furnaces: 4 }, { x: ox - 5, y: oy - 30 })
  place(layout, "mine", "mining-outpost", { resource: "iron-ore", rows: 4, sides: 2 }, { x: ox - 15, y: oy + 30 })
  const job = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: moduleId("mine"), port: "out" }, to: { module: moduleId("smelt"), port: "in-ore" } }], center: { x: ox, y: oy }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, beltTiers(prototypeFacts)[0], layout), terrainView(t), prototypeFacts, selectPolicy("early-compact", {}))
  assert(job.phase === "done", "ore routed")
  const mods = stampParts(s, force, job.layout, { modules: [moduleId("smelt"), moduleId("mine")], routes: [], poles: [] }, false)
  assert(mods.failed.length === 0, mods.failed.join("; "))
  const route = stampParts(s, force, job.layout, { modules: [], routes: [routeId("route:ore")], poles: [] }, true)
  assert(route.failed.length === 0, route.failed.join("; "))
  return { layout: job.layout, ghosts: route.entities }
}

describe("faction conflicts", () => {
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("another faction's claimed tiles and ghosts are foreign to a faction's planner", () => {
    const lab = createLab(32)
    const a = faction(lab, "a", -20, 0)
    const b = faction(lab, "b", 20, 0)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    b.brain!.reserved[tkey(ox + 5, oy + 5)] = true
    lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, -5.5, -5.5), force: b.force })
    const t = scan(lab, `conf-claims-${seq}`, a.force)
    const view = claimView(a.name, lab.surface.name, terrainView(t))
    assert(view.block(ox + 5, oy + 5) === FOREIGN, `claimed tile is ${view.block(ox + 5, oy + 5)}`)
    assert(view.block(ox - 6, oy - 6) === FOREIGN, `tile under b's ghost is ${view.block(ox - 6, oy - 6)}`)
    assert(view.block(ox + 6, oy + 6) !== FOREIGN, "an unclaimed tile is not foreign")
    // b's own view: its claim is its own (not foreign).
    const tb = scan(lab, `conf-claims-b-${seq}`, b.force)
    assert(claimView(b.name, lab.surface.name, terrainView(tb)).block(ox + 5, oy + 5) !== FOREIGN, "own claim")
  })

  test("bootstrap sites stay off another faction's claimed tiles", () => {
    const lab = createLab(40)
    for (let x = 6; x < 22; x++) for (let y = -8; y < 0; y++) lab.surface.create_entity({ name: "coal", position: at(lab, x + 0.5, y + 0.5), amount: 20000 })
    setConfigOverride("scanRadius", 40)
    setConfigOverride("bootstrapSites", "coal=2")
    setConfigOverride("firstElectricityItems", "")
    // b claims the near half of the coal patch (as a plan of its own would); a's pair must go on the far half.
    const b = faction(lab, "claim", -30, 30)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    for (let x = 6; x < 14; x++) for (let y = -8; y < 0; y++) b.brain!.reserved[tkey(ox + x, oy + y)] = true
    const a = faction(lab, "pair", 0, 8, false)
    async(3600)
    on_tick(() => {
      let site
      for (const s of a.brain!.sites) if (s.kind === "pair") site = s
      if (site === undefined) return
      // Footprints (a 2×2 drill around its position) never on b's claim; the site's 1-tile margin may touch it.
      for (const p of site.parts) {
        for (let x = math.floor(p.position.x - 1); x < p.position.x + 1; x++) {
          for (let y = math.floor(p.position.y - 1); y < p.position.y + 1; y++) assert(!b.brain!.reserved[tkey(x, y)], `a's ${p.entity} at ${p.position.x - ox},${p.position.y - oy} is on b's claimed tile ${x - ox},${y - oy}`)
        }
      }
      done()
      return false
    })
  })

  test("factions never share an ore field: another faction's field is off limits for bootstrap sites and the planner (D46)", () => {
    const lab = createLab(48)
    // Field A: near the hub, two clumps 2 tiles apart (one field). Field B: 14 tiles farther (a separate field).
    for (let x = 6; x < 12; x++) for (let y = -8; y < 0; y++) lab.surface.create_entity({ name: "coal", position: at(lab, x + 0.5, y + 0.5), amount: 20000 })
    for (let x = 13; x < 16; x++) for (let y = -8; y < 0; y++) lab.surface.create_entity({ name: "coal", position: at(lab, x + 0.5, y + 0.5), amount: 20000 })
    for (let x = 30; x < 38; x++) for (let y = -8; y < 0; y++) lab.surface.create_entity({ name: "coal", position: at(lab, x + 0.5, y + 0.5), amount: 20000 })
    setConfigOverride("scanRadius", 48)
    setConfigOverride("bootstrapSites", "coal=2")
    setConfigOverride("firstElectricityItems", "")
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const b = faction(lab, "field", -30, 30)
    b.brain!.oreFields = {}
    const n = claimOreField(lab.surface, b.brain!.oreFields, "coal", ox + 6, oy - 8)
    assert(n === 6 * 8 + 3 * 8, `the claim covers the whole field A (both clumps): ${n} tiles`)
    assert(!b.brain!.oreFields[tkey(ox + 30, oy - 8)], "field B is not claimed")
    const a = faction(lab, "far", 0, 8, false)
    const t = scan(lab, `conf-field-${seq}`, a.force)
    const view = claimView(a.name, lab.surface.name, terrainView(t))
    assert(view.ore(ox + 7, oy - 4) === "claimed:coal", `a sees b's field as claimed ore: ${view.ore(ox + 7, oy - 4)}`)
    assert(view.ore(ox + 31, oy - 4) === "coal", "field B is coal to a")
    async(3600)
    on_tick(() => {
      let site
      for (const s of a.brain!.sites) if (s.kind === "pair") site = s
      if (site === undefined) return
      for (const p of site.parts) assert(p.position.x - ox >= 29, `a's ${p.entity} at ${p.position.x - ox},${p.position.y - oy} is on b's field`)
      assert(a.brain!.oreFields !== undefined && a.brain!.oreFields[tkey(ox + 30, oy - 8)], "a claimed field B")
      done()
      return false
    })
  })

  test("a route blocked by another force's building is rerouted around it; old pieces it doesn't reuse are picked up", () => {
    const lab = createLab(64)
    const a = faction(lab, "route", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    // The crew built the first half of the route; another force builds on the second half (removing a's ghost there).
    const half = math.floor(ghosts.length / 2)
    revive(ghosts.slice(0, half))
    const target = ghosts[half + 3]
    const bx = target.position.x
    const by = target.position.y
    const blocker = s.create_entity({ name: "wooden-chest", position: { x: bx, y: by }, force: FOREIGN_FORCE })!
    assert(blocker !== undefined, "blocker placed")
    const check = checkBuild(s, a.force, layout, allParts(layout))
    log(`[conflict] route check: ${serpent.line(check.conflicts)}, ${check.missing.length} missing`)
    assert(check.conflicts.length === 1 && check.conflicts[0].kind === "route" && check.conflicts[0].id === "route:ore", `conflict ${serpent.line(check.conflicts)}`)
    const t = scan(lab, `conf-route-${seq}`, a.force)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const plan = planReroute(layout, claimView(a.name, s.name, terrainView(t)), prototypeFacts, selectPolicy("early-compact", {}), beltTiers(prototypeFacts)[0], [routeId("route:ore")], { x: ox - 64, y: oy - 64, w: 128, h: 128 })
    assert(plan.ok, `reroute: ${plan.reason}`)
    const route = plan.layout.routes["route:ore"]
    for (const k of route.tiles) assert(!(keyX(k) === math.floor(bx) && keyY(k) === math.floor(by)), "the new route avoids the blocker")
    const d = applyDiff(s, a, plan.remove, [], {})
    log(`[conflict] reroute: ${plan.remove.length} to remove (${d.clearJobs.length} built: clear jobs), ${plan.add.length} to add; own ghosts left ${s.find_entities_filtered({ type: "entity-ghost", force: a.force }).length}`)
    log(`[conflict] remove ${serpent.line(plan.remove.slice(0, 3))} add ${serpent.line(plan.add.slice(0, 3))}`)
    // The crew's clear jobs pick up the built pieces; the new ghosts are built after them.
    for (const id of d.clearJobs) {
      const target = (a.board.jobs[id].payload as { target?: LuaEntity }).target
      assert(target !== undefined && target.valid && target.force.name === a.force, "clear job targets an own built piece")
      target!.destroy()
    }
    const d2 = applyDiff(s, a, [], plan.add, {})
    assert(d2.failed.length === 0, `new ghosts: ${d2.failed.join("; ")}`)
    // Leftover ghosts of the old route that the new one reuses are still there: build everything.
    revive(s.find_entities_filtered({ type: "entity-ghost", force: a.force }))
    const broken = followRoute(s, plan.layout, route)
    assert(broken === undefined, `rerouted belt connects the outpost to the column: ${broken}`)
    assert(checkBuild(s, a.force, plan.layout, allParts(plan.layout)).conflicts.length === 0, "no conflict left")
    // Nothing of the old route is left over: every own belt is part of the new route.
    const want: Record<string, boolean> = {}
    for (const e of partEntities(plan.layout, { modules: [], routes: [routeId("route:ore")], poles: [] })) want[string.format("%g,%g", e.x, e.y)] = true
    let stray = 0
    for (const e of plan.remove) {
      if (want[string.format("%g,%g", e.x, e.y)]) continue
      if (s.find_entities_filtered({ name: e.name, position: { x: e.x, y: e.y }, force: a.force, limit: 1 })[0] !== undefined) stray++
      if (s.find_entities_filtered({ ghost_name: e.name, position: { x: e.x, y: e.y }, force: a.force, limit: 1 })[0] !== undefined) stray++
    }
    assert(stray === 0, `${stray} old route pieces left`)
  })

  test("B56: own stale belt pieces on a route's tiles are found, picked up, and the planned pieces then placed", () => {
    // Seed 3333 (m6-prof, 2026-10-21): a reroute planned an underground exit where the old copy's belt still stood. Its
    // ghost was never created, the coal fell into the underground entrance with no exit, and every repair failed on it.
    const lab = createLab(64)
    const a = faction(lab, "stale", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    revive(ghosts)
    const specs = partEntities(layout, { modules: [], routes: [routeId("route:ore")], poles: [] }).filter((e) => e.name === "transport-belt")
    assert(specs.length > 10, `${specs.length} belts`)
    // One planned belt replaced by an own underground (another kind), another turned the wrong way (B52's case).
    const kind = specs[5]
    const turn = specs[8]
    s.find_entities_filtered({ name: "transport-belt", position: { x: kind.x, y: kind.y }, force: a.force })[0].destroy()
    const ug = s.create_entity({ name: "underground-belt", position: { x: kind.x, y: kind.y }, direction: kind.dir as never, type: "output", force: a.force })!
    assert(ug !== undefined, "stale underground placed")
    const turned = s.find_entities_filtered({ name: "transport-belt", position: { x: turn.x, y: turn.y }, force: a.force })[0]
    turned.direction = ((turn.dir + 8) % 16) as never
    const check = checkBuild(s, a.force, layout, allParts(layout))
    assert(check.stale.length === 1 && check.stale[0].entities[0] === ug, `stale ${serpent.line(check.stale.map((x) => x.spec))}`)
    assert(check.missing.length === 0, `the piece under the stale underground is not plain missing (${check.missing.length})`)
    assert(check.misdirected.length === 1, `misdirected ${check.misdirected.length}`)
    const under = staleUnderRoutes(s, a.force, layout, [routeId("route:ore")])
    assert(under.length === 2 && under.indexOf(ug) >= 0 && under.indexOf(turned) >= 0, `stale under the route: ${under.length}`)
    // The crew picks them up; then the planned pieces go in and the route connects again.
    for (const e of under) e.destroy()
    const d = applyDiff(s, a, [], [check.stale[0].spec, check.misdirected[0].spec], {})
    assert(d.failed.length === 0, `ghosts: ${d.failed.join("; ")}`)
    revive(d.ghosts)
    const broken = followRoute(s, layout, layout.routes["route:ore"])
    assert(broken === undefined, `route connects again: ${broken}`)
  })

  test("B95: an own underground between a route's underground pair, facing its flow, is an intruder to pick up", () => {
    // Sweep 3e1c4d7 seed 4819313: an old route's underground stood between a new pair's ends on the same line. The
    // entrance paired with it, the ore surfaced short of the port, and every repair said "nothing missing".
    const lab = createLab(32)
    const a = faction(lab, "intruder", 30, 0)
    const s = lab.surface
    const x0 = math.floor(lab.origin.x) + 4
    const y0 = math.floor(lab.origin.y) + 4
    const layout = newLayout()
    const steps = [
      { kind: "ug-in" as const, x: x0, y: y0, dir: 1 },
      { kind: "ug-out" as const, x: x0 + 5, y: y0, dir: 1 },
    ]
    const r = { id: routeId("route:ug"), conn: connectionId("ug"), item: "iron-ore", to: { module: moduleId("x"), port: "in" }, steps, tiles: [tkey(x0, y0), tkey(x0 + 5, y0)], spans: [], belt: "transport-belt", underground: "underground-belt", splitter: "splitter", length: 6, undergrounds: 1, cost: 1, ripped: 0 }
    layout.routes[r.id] = r as never
    layout.routeOrder.push(r.id)
    s.create_entity({ name: "underground-belt", position: { x: x0 + 0.5, y: y0 + 0.5 }, direction: 4 as never, type: "input", force: a.force })
    s.create_entity({ name: "underground-belt", position: { x: x0 + 5.5, y: y0 + 0.5 }, direction: 4 as never, type: "output", force: a.force })
    const across = s.create_entity({ name: "underground-belt", position: { x: x0 + 2.5, y: y0 + 0.5 }, direction: 8 as never, type: "input", force: a.force })!
    let check = checkBuild(s, a.force, layout, { modules: [], routes: [r.id], poles: [] })
    assert(check.intruders.length === 0, `an underground across the line is no intruder (${check.intruders.length})`)
    across.destroy()
    const intruder = s.create_entity({ name: "underground-belt", position: { x: x0 + 3.5, y: y0 + 0.5 }, direction: 4 as never, type: "output", force: a.force })!
    check = checkBuild(s, a.force, layout, { modules: [], routes: [r.id], poles: [] })
    assert(check.missing.length === 0, `the pair stands (${check.missing.length} missing)`)
    assert(check.intruders.length === 1 && check.intruders[0] === intruder, `the underground inside the span (${check.intruders.length})`)
  })

  test("a module whose ground another force took is given up: built entities deconstructed, parts dropped", () => {
    const lab = createLab(64)
    const a = faction(lab, "module", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    revive(ghosts)
    // The smelter column's ground: pretend it was still ghosts, and another force built on one of its tiles.
    const m = findModule(layout, moduleId("smelt"))!
    for (const e of s.find_entities_filtered({ force: a.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })) {
      if (e.type === "furnace") {
        const p = e.position
        e.destroy()
        s.create_entity({ name: "entity-ghost", inner_name: "stone-furnace", position: p, force: a.force })
      }
    }
    const furnaceGhost = s.find_entities_filtered({ ghost_name: "stone-furnace", force: a.force })[0]
    const fp = furnaceGhost.position
    furnaceGhost.destroy()
    s.create_entity({ name: "stone-furnace", position: fp, force: FOREIGN_FORCE })
    const check = checkBuild(s, a.force, layout, allParts(layout))
    log(`[conflict] module check: ${serpent.line(check.conflicts)}`)
    assert(check.conflicts.some((c) => c.kind === "module" && c.id === "smelt"), `conflict ${serpent.line(check.conflicts)}`)
    const builtBefore = s.find_entities_filtered({ force: a.force, area: { left_top: { x: m.rect.x - 1, y: m.rect.y - 1 }, right_bottom: { x: m.rect.x + m.rect.w + 1, y: m.rect.y + m.rect.h + 1 } } }).filter((e) => e.type !== "entity-ghost").length
    const r = abandonParts(s, a, layout, { modules: [moduleId("smelt")], routes: [], poles: [] })
    log(`[conflict] abandoned: ${r.clearJobs.length} clear jobs, routes ${r.routes.join(",")}, ${r.tiles.length} tiles`)
    assert(findModule(layout, moduleId("smelt")) === undefined, "module left the layout")
    assert(layout.routes["route:ore"] === undefined, "its route left the layout")
    assert(s.find_entities_filtered({ type: "entity-ghost", force: a.force }).length === 0, "its ghosts are gone")
    // Every built entity of the module and of the route into it gets a clear job (the crew deconstructs it).
    const routeBuilt = ghosts.length
    assert(r.clearJobs.length >= builtBefore + routeBuilt - 2, `clear jobs ${r.clearJobs.length}, built module entities ${builtBefore}, route pieces ${routeBuilt}`)
    for (const id of r.clearJobs) {
      const target = (a.board.jobs[id].payload as { target?: LuaEntity }).target
      assert(target !== undefined && target.valid && target.force.name === a.force, "clear job targets an own entity")
    }
  })

  test("B19: a new consumer taps a built route: the crew picks up the belt, builds the splitter, both routes connect", () => {
    tapRoute("b19-tap", false)
  })

  // B69 (soak vps-d66 seed 5387208): the tapped route's belt was still another build's ghost when the tap was stamped;
  // the splitter ghost could not go over it and the build finished without its tap.
  test("B69: a tap on a belt another build has not placed yet waits for it, picks it up, then builds the splitter", () => {
    tapRoute("b69-tap", true)
  })
})

/** B19/B69: a new smelter taps the built ore route; `unbuilt`: the tapped belt is still a ghost with a place job. */
function tapRoute(id: string, unbuilt: boolean): void {
  const lab = createLab(64)
  const f = faction(lab, "tap", 10, 0, false)
  f.brain!.goals = []
  const { layout, ghosts } = smeltingLab(lab, f.force)
  revive(ghosts)
  const ox = math.floor(lab.origin.x)
  const oy = math.floor(lab.origin.y)
  // The faction's base: the built mine, smelter and ore route (fixed).
  for (const m of layout.modules) m.fixed = true
  for (const id of layout.routeOrder) layout.routes[id].fixed = true
  storage.factories ??= {}
  // A base layout under its own key (a real factory state would run its own strategy think).
  storage.factories["b19-base"] = { layout } as never
  const chest = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 20.5, 20.5), force: f.force })!
  chest.insert({ name: "splitter", count: 2 })
  chest.insert({ name: "transport-belt", count: 120 })
  chest.insert({ name: "stone-furnace", count: 4 })
  chest.insert({ name: "inserter", count: 20 })
  chest.insert({ name: "small-electric-pole", count: 10 })
  addStockpile(f, chest)
  const def = generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4 })
  if (getPlannerEntry(id) !== undefined) removePlan(id)
  startPlan({ id, surface: lab.surface.name, force: f.force, faction: f.name, baseFaction: "b19-base", topology: "splitter-tap", request: { modules: [{ id: moduleId("smelt2"), def }], connections: [{ id: connectionId("ore2"), from: { module: moduleId("mine"), port: "out" }, to: { module: moduleId("smelt2"), port: "in-ore" } }], center: { x: ox + 10, y: oy - 20 }, region: { x: ox - 60, y: oy - 60, w: 120, h: 120 } } })
  let building = false
  async(60 * 60 * 30)
  on_tick(() => {
    const e = getPlannerEntry(id)!
    if (e.phase === "scan" || e.phase === "plan") return
    const job = e.job!
    if (!building) {
      assert(e.phase === "done", `plan failed: ${serpent.line(job.failures)}`)
      const r = job.layout.routes["route:ore2"]
      assert(r !== undefined && r.tapOf === "route:ore", `the new route taps the built one (${r?.tapOf})`)
      const parts = { modules: [moduleId("smelt2")], routes: [routeId("route:ore2")], poles: [] }
      const belts = tappedBelts(lab.surface, job.layout, parts, f.force)
      assert(belts.length === 1, `one built belt under the splitter (${belts.length})`)
      if (unbuilt) {
        // Another build's belt, not placed yet: a ghost with its place job.
        const b = belts[0]
        const spot = { name: b.name, position: b.position, direction: b.direction }
        b.destroy()
        const g = lab.surface.create_entity({ name: "entity-ghost", inner_name: spot.name, position: spot.position, direction: spot.direction, force: f.force })!
        assert(addPlaceJob(f, g, { priority: 10 }) !== undefined, "a place job for the tapped belt's ghost")
      }
      startBuild(e, { parts, priority: 90 })
      building = true
      return
    }
    if (e.build!.phase !== "done") return
    if (lab.surface.count_entities_filtered({ type: "entity-ghost", force: f.force }) > 0) return
    const problems: string[] = []
    for (const rid of ["route:ore", "route:ore2"]) {
      const p = followRoute(lab.surface, job.layout, job.layout.routes[rid])
      if (p !== undefined) problems.push(`${rid}: ${p}`)
    }
    assert(problems.length === 0, problems.join("; "))
    assert(lab.surface.count_entities_filtered({ name: "splitter", force: f.force }) === 1, "a splitter")
    assert(e.build!.failed.length === 0, `ghosts failed: ${e.build!.failed.join("; ")}`)
    delete storage.factories!["b19-base"]
    removePlan(id)
    log(`[m6] ${id} tap on a built route built at tick ${game.tick}`)
    done()
    return false
  })
}
