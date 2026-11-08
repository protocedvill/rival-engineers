import { LuaEntity } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { moduleId, connectionId, routeId } from "../shared/ids"
import type { JobId } from "../shared/ids"
import { createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { allParts, partEntities } from "../planner/build-list"
import { beltTiers } from "../planner/capacity"
import { abandonParts, applyDiff, checkBuild, cloggedBelts, ghostBlockerKind, hardGhostFailure, mergeBranchOutlet, mergeTrunkSide, routeCheck, staleUnderRoutes, tuneMergeSplitters } from "../planner/conflicts"
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
import { failJob, getJob } from "../jobs/board"

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

  test("B56: own stale belt pieces on a route's tiles are found, picked up, and the planned pieces then placed; M7c.8: a jobless ghost is missing", () => {
    // Seed 3333 (m6-prof, 2026-10-21): a reroute planned an underground exit where the old copy's belt still stood. Its
    // ghost was never created, the coal fell into the underground entrance with no exit, and every repair failed on it.
    const lab = createLab(64)
    const a = faction(lab, "stale", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    // M7c.8 (fixes-360 seed 11, minute 370; checked here to spare a test force: a shard has at most 64): a ghost whose
    // place job failed counts as missing and gets a new job. 6 pole ghosts of a mine's pole line had failed jobs; the
    // power repair said "nothing missing" (a ghost counted as present) while the mine's 24 drills had no power.
    const jobs = ghosts.map((g) => addPlaceJob(a, g)!)
    const dead = ghosts[2]
    failJob(a.board, jobs[2], "unreachable", game.tick)
    const parts = { modules: [], routes: [routeId("route:ore")], poles: [] }
    const plain = checkBuild(s, a.force, layout, parts)
    assert(plain.missing.length === 0 && plain.orphans.length === 0, `without a faction a ghost is present (${plain.missing.length})`)
    const orphan = checkBuild(s, a.force, layout, parts, undefined, a)
    assert(orphan.orphans.length === 1 && orphan.missing.length === 1, `orphans ${orphan.orphans.length}, missing ${orphan.missing.length}`)
    assert(orphan.orphans[0].x === dead.position.x && orphan.orphans[0].y === dead.position.y, "the failed job's ghost")
    const again = applyDiff(s, a, [], orphan.missing, {})
    assert(again.placeJobs.length === 1 && again.placeJobs[0] !== jobs[2], `a new job (${serpent.line(again.placeJobs)})`)
    assert(getJob(a.board, again.placeJobs[0])!.status !== "failed", "the new job is open")
    assert(checkBuild(s, a.force, layout, parts, undefined, a).orphans.length === 0, "no orphan left")
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

  test("B144: an orphan ghost on a planned tile is swept, and the local retry stamps the planned piece", () => {
    // Seed 1212121 g111 (min-0660): the plan wanted an underground-belt ghost where an orphan transport-belt ghost
    // (unit 33568) stood; route_debug returned {} because no live layout route owned it. The ghost can never be built
    // and it blocks a different entity's ghost on the same tile.
    const lab = createLab(64)
    const a = faction(lab, "b144orphan", 30, 0)
    const s = lab.surface
    const { layout } = smeltingLab(lab, a.force)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const spec = { name: "transport-belt", x: ox + 25.5, y: oy + 0.5, dir: 0, owner: "route:b144" }
    const orphan = s.create_entity({ name: "entity-ghost", inner_name: "underground-belt", position: { x: spec.x, y: spec.y }, direction: defines.direction.north, force: a.force })!
    assert(orphan !== undefined, "orphan ghost placed")
    assert(ghostBlockerKind(s, a, layout, spec).kind === "orphan", "classified as an orphan")
    const d = applyDiff(s, a, [], [spec], {}, layout)
    assert(d.failed.length === 0, `ghost: ${d.failed.join("; ")}`)
    assert(d.placeJobs.length === 1, `a place job (${d.placeJobs.length})`)
    assert(!orphan.valid, "the orphan is gone")
    const made = s.find_entities_filtered({ ghost_name: "transport-belt", position: { x: spec.x, y: spec.y }, force: a.force })[0]
    assert(made !== undefined && made.direction === defines.direction.north, "the planned belt ghost stands")
  })

  test("B144: an overlap inside the plan's own add list is classified, and no partial place job is created", () => {
    // The other half of the g111 evidence: at 520.5,-161.5 the tile was buildable and no orphan stood there; one piece's
    // ghost had been created before another piece of the same plan wanted the same tile. A retry cannot clear that: the
    // plan itself is wrong for the ground.
    const lab = createLab(64)
    const a = faction(lab, "b144overlap", 30, 0)
    const s = lab.surface
    const { layout } = smeltingLab(lab, a.force)
    const belt = partEntities(layout, { modules: [], routes: [routeId("route:ore")], poles: [] }).filter((e) => e.name === "transport-belt")[5]
    const clash = { name: "underground-belt", x: belt.x, y: belt.y, dir: belt.dir, ioType: "input" as const, owner: "route:b144" }
    const d = applyDiff(s, a, [], [belt, clash], {}, layout)
    assert(d.failed.length === 1 && d.failed[0].indexOf("underground-belt") >= 0, `one failure (${d.failed.join("; ")})`)
    assert(d.placeJobs.length === 0, `no place job for a partial plan (${d.placeJobs.length})`)
    const kind = ghostBlockerKind(s, a, layout, clash)
    assert(kind.kind === "planned", `the planned piece is the blocker (${kind.kind})`)
  })

  test("B144: an own stale belt blocks a ghost and creates no place jobs for the rest of the add list; a clean retry creates them", () => {
    const lab = createLab(64)
    const a = faction(lab, "b144stale", 30, 0)
    const s = lab.surface
    const { layout } = smeltingLab(lab, a.force)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const free = { name: "transport-belt", x: ox + 26.5, y: oy + 0.5, dir: 0, owner: "route:b144" }
    const blocked = { name: "underground-belt", x: ox + 27.5, y: oy + 0.5, dir: 0, ioType: "input" as const, owner: "route:b144" }
    const stale = s.create_entity({ name: "transport-belt", position: { x: blocked.x, y: blocked.y }, direction: defines.direction.north, force: a.force })!
    assert(stale !== undefined, "stale belt placed")
    const d = applyDiff(s, a, [], [free, blocked], {}, layout)
    assert(d.failed.length === 1, `one failure (${d.failed.join("; ")})`)
    assert(d.placeJobs.length === 0, `no job while a ghost of the list is missing (${d.placeJobs.length})`)
    const blockedKind = ghostBlockerKind(s, a, layout, blocked)
    assert(blockedKind.kind === "stale", `stale (${blockedKind.kind}: ${blockedKind.blocker})`)
    // A foreign entity is a hard blocker when it does stand on the tile (the ghost itself may be created over it).
    const foreign = { name: "transport-belt", x: ox + 28.5, y: oy + 0.5, dir: 0, owner: "route:b144" }
    s.create_entity({ name: "wooden-chest", position: { x: foreign.x, y: foreign.y }, force: FOREIGN_FORCE })
    assert(ghostBlockerKind(s, a, layout, foreign).kind === "foreign", "a foreign entity is classified")
    stale.destroy()
    const again = applyDiff(s, a, [], [free, blocked], {}, layout)
    assert(again.failed.length === 0, `retry: ${again.failed.join("; ")}`)
    assert(again.placeJobs.length === 2, `both jobs after the blocker goes (${again.placeJobs.length})`)
  })

  test("B144/B150: applyDiff does not reuse a ghost of the same entity facing another way", () => {
    const lab = createLab(64)
    const a = faction(lab, "b144dir", 30, 0)
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const spec = { name: "transport-belt", x: ox + 28.5, y: oy + 0.5, dir: defines.direction.east, owner: "route:b144" }
    s.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: { x: spec.x, y: spec.y }, direction: defines.direction.north, force: a.force })
    const d = applyDiff(s, a, [], [spec], {})
    assert(d.failed.length === 1, `the wrong-way ghost is not the planned piece (${d.failed.join("; ")})`)
    assert(d.placeJobs.length === 0, "no job for the wrong-way ghost")
  })

  test("B144: removing a piece finds its ghost whatever way it faces", () => {
    const lab = createLab(64)
    const a = faction(lab, "b144rm", 30, 0)
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const spec = { name: "transport-belt", x: ox + 29.5, y: oy + 0.5, dir: defines.direction.east, owner: "route:b144" }
    const ghost = s.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: { x: spec.x, y: spec.y }, direction: defines.direction.north, force: a.force })!
    assert(ghost !== undefined && ghost.valid, "turned ghost placed")
    applyDiff(s, a, [spec], [], {})
    assert(!ghost.valid, "the turned ghost is removed")
  })

  test("B144: a route ghost with no named blocker is retryable; a module ghost is a hard site", () => {
    // g192 (seed 11, minute 1104): 2 route belts whose ghost creation failed with no blocker rejected a 21-module plan
    // and dropped its 45 routes. B142 can reroute route pieces; a module cannot move its own ground.
    const lab = createLab(64)
    const a = faction(lab, "b144class", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    const route = partEntities(layout, { modules: [], routes: [routeId("route:ore")], poles: [] }).filter((e) => e.name === "transport-belt")[5]
    for (const g of ghosts) if (g.position.x === route.x && g.position.y === route.y) g.destroy()
    assert(hardGhostFailure(s, a, layout, [route]) === undefined, "a route piece with no blocker is not a hard site")
    const m = findModule(layout, "smelt")!
    const me = m.def.entities[0]
    const moduleSpec = { name: me.name, x: m.origin.x + me.x, y: m.origin.y + me.y, dir: me.dir ?? 0, owner: m.id }
    assert(hardGhostFailure(s, a, layout, [moduleSpec]) !== undefined, "a module piece with no blocker is a hard site")
  })

  test("B107: another input filling both lanes past a module's input port is found; picked up and placed again, the belts are empty", () => {
    // Sweep 628fa29 seed 1264816: a smelter column grew; its coal arrived before the new ore side-load belt stood, the
    // merge tile curved and filled the ore lane with coal. 10 of 12 furnaces starved for 400 game-min, "nothing missing".
    const lab = createLab(64)
    const a = faction(lab, "clog", 30, 0)
    const s = lab.surface
    const { layout } = smeltingLab(lab, a.force)
    const m = findModule(layout, "smelt")!
    const belts = partEntities(layout, { modules: [m.id], routes: [], poles: [] }).filter((e) => e.name === "transport-belt")
    const beltAt = (x: number, y: number) => s.find_entities_filtered({ name: "transport-belt", position: { x, y }, force: a.force })[0]
    const fill = (x: number, y: number, item: string, lines: number[]) => {
      const b = beltAt(x, y)
      for (const li of lines) for (let k = 0; k < 4; k++) b.get_transport_line(li).insert_at_back({ name: item, count: 1 })
    }
    const ox = m.origin.x
    const oy = m.origin.y
    const H = m.def.footprint.h
    const yt = H - 2
    // The normal state: coal on both lanes of the fuel port, coal and ore on the two lanes of the central belt,
    // plates on both lanes of the output belt.
    fill(ox + 4.5, oy + H - 0.5, "coal", [1, 2])
    fill(ox + 5.5, oy + 3.5, "coal", [1])
    fill(ox + 5.5, oy + 3.5, "iron-ore", [2])
    fill(ox + 3.5, oy + 0.5, "iron-plate", [1, 2])
    assert(cloggedBelts(s, a.force, layout, "smelt", "in-ore").length === 0, "a clean column has no clogged belt")
    // Coal on both lanes of the merge tile and two central belts: the ore has no lane there.
    const clog = [{ x: ox + 5.5, y: oy + yt + 0.5 }, { x: ox + 5.5, y: oy + yt - 0.5 }, { x: ox + 5.5, y: oy + 2.5 }]
    for (const c of clog) fill(c.x, c.y, "coal", [1, 2])
    const found = cloggedBelts(s, a.force, layout, "smelt", "in-ore")
    const at = found.map((c) => `${c.spec.x},${c.spec.y}`).sort()
    const want = clog.map((c) => `${c.x},${c.y}`).sort()
    assert(serpent.line(at) === serpent.line(want), `clogged ${serpent.line(at)}, want ${serpent.line(want)}`)
    assert(found.every((c) => belts.indexOf(c.spec) >= 0 || c.spec.owner === m.id), "the clogged pieces are the module's")
    // Coal is the fuel port's own item: from there nothing is clogged.
    assert(cloggedBelts(s, a.force, layout, "smelt", "in-fuel").length === 0, "the fuel port's own item clogs nothing")
    // The crew picks them up (their items go with them); placed again, they are empty and nothing is clogged.
    for (const c of found) c.entity.destroy()
    const d = applyDiff(s, a, [], found.map((c) => c.spec), {})
    assert(d.failed.length === 0, `ghosts: ${d.failed.join("; ")}`)
    revive(d.ghosts)
    for (const c of clog) assert(beltAt(c.x, c.y).get_transport_line(1).get_item_count() + beltAt(c.x, c.y).get_transport_line(2).get_item_count() === 0, `belt at ${c.x},${c.y} empty`)
    assert(cloggedBelts(s, a.force, layout, "smelt", "in-ore").length === 0, "nothing clogged after the flush")
  })

  test("B124: a foreign item on a module's input belt or on the edge's route is found; the route's own item is not", () => {
    // Soak m7c-cont8 seed 11 (min 720): iron plates on an iron smelter's ore belt, iron ore and plates stranded on coal
    // lanes with no source upstream. Nothing takes them off, 122 furnaces sat blocked and every repair said "nothing missing".
    const lab = createLab(64)
    const a = faction(lab, "foul", 30, 0)
    const s = lab.surface
    const { layout, ghosts } = smeltingLab(lab, a.force)
    revive(ghosts)
    const m = findModule(layout, "smelt")!
    const beltAt = (x: number, y: number) => s.find_entities_filtered({ type: "transport-belt", position: { x, y }, force: a.force })[0]
    const fill = (x: number, y: number, item: string, lines: number[]) => {
      const b = beltAt(x, y)
      for (const li of lines) for (let k = 0; k < 2; k++) b.get_transport_line(li).insert_at_back({ name: item, count: 1 })
    }
    const route = [routeId("route:ore")]
    const steps = partEntities(layout, { modules: [], routes: route, poles: [] }).filter((e) => e.name === "transport-belt")
    assert(steps.length > 6, `${steps.length} route belts`)
    for (const st of [steps[2], steps[4]]) fill(st.x, st.y, "iron-ore", [1, 2])
    fill(m.origin.x + 5.5, m.origin.y + 3.5, "coal", [1])
    fill(m.origin.x + 5.5, m.origin.y + 3.5, "iron-ore", [2])
    assert(cloggedBelts(s, a.force, layout, "smelt", "in-ore", route).length === 0, "the route's own item and the module's inputs are no foreign items")
    // Coal on one lane of an empty route belt (an ore route), iron plates on one lane of the central (input) belt.
    fill(steps[3].x, steps[3].y, "coal", [1])
    fill(m.origin.x + 5.5, m.origin.y + 2.5, "iron-plate", [2])
    const found = cloggedBelts(s, a.force, layout, "smelt", "in-ore", route)
    const at = found.map((c) => `${c.spec.owner}@${c.spec.x},${c.spec.y}`).sort()
    const want = [`route:ore@${steps[3].x},${steps[3].y}`, `smelt@${m.origin.x + 5.5},${m.origin.y + 2.5}`].sort()
    assert(serpent.line(at) === serpent.line(want), `fouled ${serpent.line(at)}, want ${serpent.line(want)}`)
    // Without the edge's routes only the module's belt is looked at.
    assert(cloggedBelts(s, a.force, layout, "smelt", "in-ore").length === 1, "module belt only")
  })

  test("B125: a merge splitter set to its item and trunk side sends nothing out of its branch side", () => {
    // Seed 11 (m7c-cont10): an iron-plate merge splitter's branch-side output faced a coal route; half the plates went
    // onto the coal line and stopped the smelters' fuel.
    const lab = createLab(24)
    const a = faction(lab, "merge-splitter", 30, 0)
    const s = lab.surface
    const x0 = math.floor(lab.origin.x)
    const y0 = math.floor(lab.origin.y)
    // Trunk at x0, branch at x0+1, both flowing north (planner dir 0): the trunk is on the splitter's left.
    const ms = { x: x0, y: y0, dir: 0, x2: x0 + 1, y2: y0 }
    assert(mergeTrunkSide(ms) === "left", "trunk side left")
    assert(mergeTrunkSide({ x: x0 + 1, y: y0, dir: 0, x2: x0, y2: y0 }) === "right", "trunk side right")
    assert(mergeTrunkSide({ x: x0, y: y0, dir: 1, x2: x0, y2: y0 + 1 }) === "left", "east-facing: trunk north is left")
    const layout = newLayout()
    layout.routes["route:m"] = { id: routeId("route:m"), item: "iron-plate", mergeSplitter: ms, steps: [], tiles: [] } as never
    layout.routeOrder.push(routeId("route:m"))
    s.create_entity({ name: "splitter", position: { x: x0 + 1, y: y0 + 0.5 }, direction: 0 as never, force: a.force })
    for (const dx of [0, 1]) for (const dy of [1, 2, -1, -2, -3]) s.create_entity({ name: "transport-belt", position: { x: x0 + dx + 0.5, y: y0 + dy + 0.5 }, direction: 0 as never, force: a.force })
    assert(tuneMergeSplitters(s, a.force, layout) === 1, "one splitter set")
    assert(tuneMergeSplitters(s, a.force, layout) === 0, "already set")
    const feed = s.find_entities_filtered({ type: "transport-belt", position: { x: x0 + 1.5, y: y0 + 2.5 } })[0]
    let t = 0
    async(600)
    on_tick(() => {
      t++
      if (t < 40) for (const li of [1, 2]) feed.get_transport_line(li).insert_at_back({ name: "iron-plate", count: 1 })
      if (t < 300) return
      let trunk = 0
      let branch = 0
      for (const dy of [-1, -2, -3]) {
        trunk += s.find_entities_filtered({ type: "transport-belt", position: { x: x0 + 0.5, y: y0 + dy + 0.5 } })[0].get_item_count()
        branch += s.find_entities_filtered({ type: "transport-belt", position: { x: x0 + 1.5, y: y0 + dy + 0.5 } })[0].get_item_count()
      }
      assert(trunk > 0, `plates on the trunk side (${trunk})`)
      assert(branch === 0, `no plate out of the branch side (${branch})`)
      done()
      return false
    })
  })

  test("B129: a merge splitter whose branch-side outlet is dead gets no filter", () => {
    // Seed 11 (m7c-cont12): the branch-side outlet had no belt. B125's filter sent every non-route item to that dead
    // side, where coal stuck for good. A dead outlet must back up instead, so the splitter sends everything down the
    // trunk; a live outlet still gets the filter (B125).
    const lab = createLab(24)
    const a = faction(lab, "merge-dead", 30, 0)
    const s = lab.surface
    const x0 = math.floor(lab.origin.x)
    const y0 = math.floor(lab.origin.y)
    const ms = { x: x0, y: y0, dir: 0, x2: x0 + 1, y2: y0 }
    assert(mergeBranchOutlet(ms).x === x0 + 1, "branch outlet x")
    assert(mergeBranchOutlet(ms).y === y0 - 1, "branch outlet y")
    const layout = newLayout()
    layout.routes["route:m"] = { id: routeId("route:m"), item: "iron-plate", mergeSplitter: ms, steps: [], tiles: [] } as never
    layout.routeOrder.push(routeId("route:m"))
    const sp = s.create_entity({ name: "splitter", position: { x: x0 + 1, y: y0 + 0.5 }, direction: 0 as never, force: a.force })!
    sp.splitter_filter = { name: "iron-plate" } as never
    sp.splitter_output_priority = "left"
    assert(tuneMergeSplitters(s, a.force, layout) === 1, "the stale filter on a dead outlet is cleared")
    assert(sp.splitter_filter === undefined, "no filter")
    assert((sp.splitter_output_priority as string) === "none", "no output priority")
    assert(tuneMergeSplitters(s, a.force, layout) === 0, "already clear")
    s.create_entity({ name: "transport-belt", position: { x: x0 + 1.5, y: y0 - 0.5 }, direction: 0 as never, force: a.force })
    assert(tuneMergeSplitters(s, a.force, layout) === 1, "a live branch outlet gets the filter")
    const fl: unknown = sp.splitter_filter
    const have = typeof fl === "string" ? fl : (fl as { name?: string } | undefined)?.name
    assert(have === "iron-plate", `filter ${have}`)
    assert((sp.splitter_output_priority as string) === "left", "trunk side priority")
  })

  test("B126: a branch's merge splitter on the edge's trunk holding a foreign item is found", () => {
    // m7c-cont12 seed 11, minute 780: coal stranded in a merge splitter owned by the branch route held the trunk's ore
    // lane; the trunk edge's repairs only looked at the trunk's own pieces and said "nothing missing".
    const lab = createLab(24)
    const a = faction(lab, "merge-clog", 30, 0)
    const s = lab.surface
    const x0 = math.floor(lab.origin.x)
    const y0 = math.floor(lab.origin.y)
    const layout = newLayout()
    const base = { item: "iron-ore", spans: [], belt: "transport-belt", underground: "underground-belt", splitter: "splitter", length: 3, undergrounds: 0, cost: 1, ripped: 0 }
    const trunkSteps = [
      { kind: "belt" as const, x: x0, y: y0 + 1, dir: 0 },
      { kind: "belt" as const, x: x0, y: y0, dir: 0 },
      { kind: "belt" as const, x: x0, y: y0 - 1, dir: 0 },
    ]
    const trunk = { ...base, id: routeId("route:t"), conn: connectionId("t"), to: { module: moduleId("x"), port: "in" }, steps: trunkSteps, tiles: trunkSteps.map((st) => tkey(st.x, st.y)) }
    const ms = { x: x0, y: y0, dir: 0, x2: x0 + 1, y2: y0 }
    const branchSteps = [
      { kind: "belt" as const, x: x0 + 1, y: y0 + 1, dir: 0 },
      { kind: "splitter" as const, ...ms },
    ]
    const branch = { ...base, id: routeId("route:b"), conn: connectionId("b"), to: { module: moduleId("x"), port: "in" }, mergeSplitter: ms, steps: branchSteps, tiles: [tkey(x0 + 1, y0 + 1), tkey(x0 + 1, y0)] }
    for (const r of [trunk, branch]) {
      layout.routes[r.id] = r as never
      layout.routeOrder.push(r.id)
    }
    const sp = s.create_entity({ name: "splitter", position: { x: x0 + 1, y: y0 + 0.5 }, direction: 0 as never, force: a.force })!
    for (const [dx, dy] of [[0, 1], [1, 1], [0, -1]]) s.create_entity({ name: "transport-belt", position: { x: x0 + dx + 0.5, y: y0 + dy + 0.5 }, direction: 0 as never, force: a.force })
    let found = cloggedBelts(s, a.force, layout, "x", "in", [trunk.id])
    assert(found.length === 0, `a clean splitter is no clog (${found.length})`)
    sp.get_transport_line(2).insert_at_back({ name: "coal", count: 1 })
    found = cloggedBelts(s, a.force, layout, "x", "in", [trunk.id])
    assert(found.length === 1 && found[0].entity === sp, `the branch's splitter holding coal is found (${found.length})`)
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

  test("M7c.8: a branch's check takes in a merge splitter onto it, unbuilt over the branch's own old belt", () => {
    // Seed 11 (min 780): an ore branch's every piece stood, but a merge splitter onto it stood unbuilt over its belt, so
    // the branch was cut and every repair of its edge said "nothing missing".
    const lab = createLab(32)
    const a = faction(lab, "merge", 30, 0)
    const s = lab.surface
    const x0 = math.floor(lab.origin.x) + 4
    const y0 = math.floor(lab.origin.y) + 4
    const layout = newLayout()
    const route = (id: string, steps: { kind: "belt" | "splitter"; x: number; y: number; dir: number; x2?: number; y2?: number }[], tiles: number[], extra: Record<string, unknown>) => {
      const r = { id: routeId(id), conn: connectionId(id), item: "iron-ore", to: { module: moduleId("x"), port: "in" }, steps, tiles, spans: [], belt: "transport-belt", underground: "underground-belt", splitter: "splitter", length: steps.length, undergrounds: 0, cost: 1, ripped: 0, ...extra }
      layout.routes[r.id] = r as never
      layout.routeOrder.push(r.id)
      return r
    }
    const aSteps: { kind: "belt"; x: number; y: number; dir: number }[] = []
    const aTiles: number[] = []
    for (let i = 0; i < 6; i++) {
      aSteps.push({ kind: "belt", x: x0 + i, y: y0, dir: 1 })
      aTiles.push(tkey(x0 + i, y0))
    }
    const branch = route("route:branch", aSteps, aTiles, {})
    const ms = { x: x0 + 3, y: y0, dir: 1, x2: x0 + 3, y2: y0 + 1 }
    route("route:merge", [{ kind: "belt", x: x0 + 2, y: y0 + 1, dir: 1 }, { kind: "splitter", ...ms }], [tkey(x0 + 2, y0 + 1), tkey(x0 + 3, y0 + 1)], { mergeSplitter: ms })
    // A tap of the same provider: its splitter sits on the branch and its belt hangs off it. A repo of a shared trunk
    // must rebuild it; the merge's own belt above belongs to another edge.
    const tap = route("route:tap", [{ kind: "splitter", x: x0 + 4, y: y0, dir: 1, x2: x0 + 4, y2: y0 + 1 }, { kind: "belt", x: x0 + 4, y: y0 + 1, dir: 1 }], [tkey(x0 + 4, y0), tkey(x0 + 4, y0 + 1)], { tapOf: routeId("route:branch") })
    // Every belt of the branch stands, the one under the merge splitter too; the splitter is missing.
    for (let i = 0; i < 6; i++) s.create_entity({ name: "transport-belt", position: { x: x0 + i + 0.5, y: y0 + 0.5 }, direction: 4 as never, force: a.force })
    // The merge route's own belt off the branch is missing too: not the branch's to repair.
    const own = checkBuild(s, a.force, layout, { modules: [], routes: [branch.id], poles: [] })
    assert(own.missing.length === 0 && own.stale.length === 0, `the branch alone: nothing missing (${own.missing.length} missing, ${own.stale.length} stale)`)
    const rc = routeCheck(layout, [branch.id])
    assert(rc.routes.length === 3, `the tap and merge routes join the check (${rc.routes.length})`)
    const check = checkBuild(s, a.force, layout, { modules: [], routes: rc.routes, poles: [] }, rc.only)
    assert(check.stale.length === 2 && check.stale.some((x) => x.spec.name === "splitter"), `the merge and tap splitters over the old belt (${check.stale.length} stale: ${check.stale.map((x) => x.spec.name).join(",")})`)
    assert(check.missing.length === 1 && check.missing[0].owner === tap.id, `the tap's belt is repaired with the trunk (${check.missing.length} missing: ${check.missing.map((x) => `${x.owner}@${x.x},${x.y}`).join(",")})`)
    assert(!check.missing.some((x) => x.owner === "route:merge"), "the merge route's own belt off the branch is not checked")
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

  // B102 (sweep 628fa29 seed 1264816): a production goal that gave up its location dropped its tap of a kept trunk; the
  // splitter was picked up and nothing put the trunk's belt back, so cluster 2's ore stopped there for 300 game-min.
  test("B102: abandoning a tap's consumer picks up the splitter and puts the tapped route's belt back", () => {
    tapRoute("b102-tap", false, true)
  })

  // B158: the other direction. A tap is a dependent of the trunk it hangs off, so abandoning the trunk's consumer must
  // take the tap's world pieces too, not only its plan entry.
  test("B158: abandoning a trunk's consumer takes its tap's built pieces with it", () => {
    tapRoute("b158-trunk-tap", false, false, true)
  })
})

/** B19/B69: a new smelter taps the built ore route; `unbuilt`: the tapped belt is still a ghost with a place job. */
function tapRoute(id: string, unbuilt: boolean, abandon = false, abandonTrunk = false): void {
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
  let abandoned: { clearJobs: JobId[] } | undefined
  async(60 * 60 * 30)
  on_tick(() => {
    const e = getPlannerEntry(id)!
    if (abandoned !== undefined) {
      for (const j of abandoned.clearJobs) if (getJob(f.board, j)?.status !== "done" && getJob(f.board, j)?.status !== "failed") return
      if (lab.surface.count_entities_filtered({ type: "entity-ghost", force: f.force }) > 0) return
      const layout = e.job!.layout
      const p = followRoute(lab.surface, layout, layout.routes["route:ore"])
      assert(p === undefined, `the tapped route connects again: ${p}`)
      assert(lab.surface.count_entities_filtered({ name: "splitter", force: f.force }) === 0, "the splitter is picked up")
      delete storage.factories!["b19-base"]
      removePlan(id)
      done()
      return false
    }
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
    if (abandonTrunk) {
      // B158: a tap (or merge/joins dependent) is part of what the trunk's abandonment removes. `ripRoute` took it out of
      // the plan already, so before the fix its built pieces stayed on the ground with no clear job and no plan owner.
      const specs = partEntities(job.layout, { modules: [], routes: [routeId("route:ore2")], poles: [] })
      const built: LuaEntity[] = []
      for (const spec of specs) {
        const b = lab.surface.find_entities_filtered({ name: spec.name, position: { x: spec.x, y: spec.y }, force: f.force, limit: 1 })[0]
        if (b !== undefined) built.push(b)
      }
      assert(built.length > 0, "the tap has built pieces")
      const r = abandonParts(lab.surface, f, job.layout, { modules: [moduleId("smelt")], routes: [], poles: [] }, 90)
      assert(r.routes.indexOf(routeId("route:ore2")) >= 0, `the tap goes with its trunk (${r.routes.join(",")})`)
      const target: Record<number, boolean> = {}
      for (const jid of r.clearJobs) {
        const t = (f.board.jobs[jid].payload as { target?: LuaEntity }).target
        if (t !== undefined && t.unit_number !== undefined) target[t.unit_number] = true
      }
      for (const b of built) assert(b.valid && target[b.unit_number!] === true, `the tap's ${b.name} at ${b.position.x},${b.position.y} is deconstructed with its trunk`)
      delete storage.factories!["b19-base"]
      removePlan(id)
      done()
      return false
    }
    if (abandon) {
      abandoned = abandonParts(lab.surface, f, job.layout, { modules: [moduleId("smelt2")], routes: [], poles: [] }, 90)
      assert(job.layout.routes["route:ore2"] === undefined, "the tap route is dropped with its consumer")
      return
    }
    delete storage.factories!["b19-base"]
    removePlan(id)
    log(`[m6] ${id} tap on a built route built at tick ${game.tick}`)
    done()
    return false
  })
}
