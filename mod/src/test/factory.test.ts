import { LuaEntity, LuaSurface } from "factorio:runtime"
import { clearConfigOverrides } from "../config"
import { moduleId, connectionId, poleId, poleLineId, layoutClaimTag, routeId } from "../shared/ids"
import { addPlaceJob, createFaction, destroyFaction } from "../jobs/faction"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { allParts, partEntities } from "../planner/build-list"
import { beltTiers } from "../planner/capacity"
import { tkey, Vec } from "../planner/grid"
import { planGrowth } from "../planner/grow"
import { commitModule, findModule, newLayout, PlacedModule } from "../planner/layout"
import { dropPlannedPoles, FactoryGoal, getFactory, rework, startFactory } from "../strategy/factory"
import { dropEvictedPoleGhosts } from "../strategy/ghost-adopt"
import { restoreLifted } from "../strategy/lifted"
import { placePendingGhosts } from "../jobs/crew"
import { getConfig } from "../config"
import { adoptPlannedPoles } from "../strategy/ghost-adopt"
import { startBootstrap } from "../strategy/bootstrap"
import { goalId } from "../shared/ids"
import { recentDiagnosticBuckets } from "../diagnostic-events"
import { newRoutingJob, runJob } from "../planner/plan"
import { commitPlacement, placeNow } from "../planner/placement"
import { polesNow, unpoweredModules } from "../planner/power"
import { selectPolicy } from "../planner/policy"
import { claimView, layoutEntityKeys, PlannerEntry, stampParts, startBuild, stepBuild, strayUnder } from "../planner/runtime"
import { claim, complete, getJob } from "../jobs/board"
import { clearJobFor } from "../jobs/faction"
import { newTerrain, requestArea, stepTerrain, terrainView } from "../planner/terrain"
import { dumpEntities } from "../telemetry"
import { at, createLab, Lab } from "./lab"
import { labForce } from "./module-lab"
import { powerModules } from "./route-lab"

// M5a T2 (SPEC §8 M5): a steam block on a shore and a pole network planned between modules power a lab array built
// from ghosts the way the crew builds them (ghost revive); a built smelter column grows in place (expand-first): the
// planner picks up its moved end, builds the new furnaces, reroutes its ore belt, and it then smelts faster.

const SPEED = 100
let speed = 1

function scan(lab: Lab, id: string, force: string) {
  const t = newTerrain(id, lab.surface.name, force)
  const r = lab.radius
  requestArea(t, { x: math.floor(lab.origin.x) - r, y: math.floor(lab.origin.y) - r, w: 2 * r, h: 2 * r })
  while (stepTerrain(t, 100) > 0) {
    // synchronous scan for the test
  }
  return t
}

/** Revives every ghost in a list, as the crew's place action does (ghost.revive, raise_revive). */
function reviveAll(ghosts: LuaEntity[]): LuaEntity[] {
  const out: LuaEntity[] = []
  for (const g of ghosts) {
    if (!g.valid) continue
    const [, e] = g.revive({ raise_revive: true })
    if (e !== undefined) out.push(e)
  }
  return out
}

function place(layout: ReturnType<typeof newLayout>, id: string, gen: Parameters<typeof generatedModule>[0], params: Record<string, unknown>, origin: Vec): PlacedModule {
  const def = generatedModule(gen, params)
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(layout, m, prototypeFacts, 2)
  return m
}

function render(surface: LuaSurface, name: string, center: Vec, radius: number): void {
  dumpEntities(`m5/${name}.json`, center, radius, surface, true)
}

describe("M5a power and growth", () => {
  before_all(() => {
    speed = game.speed
    game.speed = SPEED
  })
  after_all(() => {
    game.speed = speed
    // Leftover factions keep planning (and slow every later test in the shard).
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("M6b: a persisted adoption record survives a save and is cleared once its goal committed", () => {
    const lab = createLab(32)
    const faction = createFaction("m6-adopt-reload", { position: at(lab, 0, 0), crew: 1 })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    brain.nextThink = math.huge
    brain.milestones["first-electricity-materials"] = game.tick
    const f = startFactory(faction)
    f.goals.push({ id: goalId("g1"), kind: "labs", status: "building", nodes: [], edges: [], techs: [], attempts: 1, radius: 128, createdTick: game.tick, placed: 0, rounds: 0 })
    storage.testScratch = { faction: faction.name }
    // A crash after the commit point leaves this record behind; it must be detected, not double-applied.
    async(60)
    on_tick(() => {
      f.adoption = { goal: goalId("g1"), plan: "p-interrupted", phase: "build", tick: game.tick }
      storage.testScratch!.record = f.adoption
      // Paused until the reload: a factory think between here and the save would clear the record first (the test
      // failed or passed with the tick it started on).
      faction.paused = true
      done()
      return false
    })
  }).after_reload_script(() => {
    const scratch = storage.testScratch!
    const faction = storage.factions[scratch.faction as string]
    const f = getFactory(faction.name)!
    assert(f.adoption !== undefined, "the interrupted adoption record survives the save")
    faction.paused = false
    let waited = 0
    on_tick(() => {
      waited++
      if (waited < 120) return
      assert(f.adoption === undefined, "the next think clears the record once the goal is not planning")
      const events = recentDiagnosticBuckets(faction).planner ?? []
      assert(events.some((e) => e.decision === "adoption-intent-cleared"), "the clear is recorded as a diagnostic")
      storage.testScratch = undefined
      return false
    })
  })

  test("power-up: steam block on a shore + planned pole line power a lab array 40 tiles away, built from ghosts", () => {
    const lab = createLab(64)
    const force = labForce()
    const s = lab.surface
    // A lake along the west edge.
    const water = []
    for (let x = -64; x < -50; x++) for (let y = -64; y < 64; y++) water.push({ name: "water", position: at(lab, x, y) })
    s.set_tiles(water)
    const t = scan(lab, "m5-power", force.name)
    const view = terrainView(t)
    const policy = selectPolicy("early-compact", {})
    const layout = newLayout()
    const steamDef = generatedModule("steam-block", { boilers: 1 })
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const sp = placeNow({ id: moduleId("steam"), def: steamDef, targets: {}, center: { x: ox - 50, y: oy }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, layout, view, policy)
    assert(sp.phase === "done", `steam placement: ${sp.reason}`)
    commitPlacement(layout, sp.result!, prototypeFacts, policy)
    const steam = findModule(layout, moduleId("steam"))!
    place(layout, "labs", "lab-array", { labs: 2, packs: ["automation-science-pack"] }, { x: steam.rect.x + steam.rect.w + 40, y: oy })
    const poles = polesNow(layout, view, prototypeFacts, policy)
    const lines = layout.poles?.length ?? 0
    log(`[m5] power-up: steam at ${steam.origin.x - ox},${steam.origin.y - oy}, ${lines} poles in ${layout.poleLines?.length ?? 0} line(s), failures ${serpent.line(poles.failures)}`)
    assert(lines >= 4, `a pole line (${lines} poles)`)
    assert(unpoweredModules(layout, prototypeFacts).length === 0, "planned network joins the labs")
    const r = stampParts(s, force.name, layout, allParts(layout), true)
    assert(r.failed.length === 0, `ghosts: ${r.failed.join("; ")}`)
    const built = reviveAll(r.entities)
    assert(built.length === r.entities.length, `revived ${built.length}/${r.entities.length}`)
    // Fuel: the boiler and its burner inserter get a first load (the crew's fuel job after placing burners).
    for (const e of built) if (e.prototype.burner_prototype !== undefined) e.insert({ name: "coal", count: 20 })
    const labs = s.find_entities_filtered({ type: "lab", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })
    for (const l of labs) l.insert({ name: "automation-science-pack", count: 20 })
    force.reset()
    for (const [, recipe] of pairs(force.recipes)) recipe.enabled = true
    force.technologies["automation-science-pack"].researched = true
    force.add_research("automation")
    const engine = s.find_entities_filtered({ type: "generator", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })[0]
    let ticks = 0
    async(60 * 60 * 5)
    on_tick(() => {
      ticks++
      if (ticks < 1800) return
      const net = engine.electric_network_id
      const problems: string[] = []
      for (const l of labs) {
        if (l.electric_network_id !== net) problems.push(`lab at ${l.position.x - ox},${l.position.y - oy} on network ${l.electric_network_id}, engine on ${net}`)
        if (l.energy <= 0) problems.push("lab has no energy")
      }
      const progress = force.research_progress
      log(`[m5] power-up: after ${ticks} ticks automation progress ${progress}, labs on the engine's network: ${problems.length === 0}`)
      render(s, "power-up", { x: (steam.rect.x + steam.rect.x + steam.rect.w + 60) / 2, y: oy }, 48)
      assert(problems.length === 0, problems.join("; "))
      assert(progress > 0 || force.technologies["automation"].researched, "research progresses on steam power")
      done()
      return false
    })
  })

  test("planner-driven expansion: a built 4-furnace smelter grows to 8 in place, its ore belt rerouted, and smelts faster", () => {
    const lab = createLab(64)
    const force = labForce()
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    for (let x = -20; x < 0; x++) for (let y = 30; y < 50; y++) s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount: 100000 })
    const t = scan(lab, "m5-grow", force.name)
    const view = terrainView(t)
    const policy = selectPolicy("early-compact", {})
    const tier = beltTiers(prototypeFacts)[0]
    const layout = newLayout()
    place(layout, "smelt", "smelter-column", { recipe: "iron-plate", furnaces: 4 }, { x: ox - 5, y: oy - 30 })
    place(layout, "mine", "mining-outpost", { resource: "iron-ore", rows: 4, sides: 2 }, { x: ox - 15, y: oy + 30 })
    const job = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: moduleId("mine"), port: "out" }, to: { module: moduleId("smelt"), port: "in-ore" } }], center: { x: ox, y: oy }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, tier, layout), view, prototypeFacts, policy)
    assert(job.phase === "done", "ore routed")
    const r = stampParts(s, force.name, job.layout, allParts(job.layout), false)
    assert(r.failed.length === 0, r.failed.join("; "))
    // Test equipment: power from interfaces next to each power pole (removed before the growth, which may need the tiles).
    const before0: Record<number, boolean> = {}
    for (const e of s.find_entities_filtered({ force, area: [at(lab, -64, -64), at(lab, 64, 64)] })) if (e.unit_number !== undefined) before0[e.unit_number] = true
    const powered = powerModules(s, force, job.layout)
    assert(powered.length === 0, powered.join("; "))
    const equipment: LuaEntity[] = []
    for (const e of s.find_entities_filtered({ force, area: [at(lab, -64, -64), at(lab, 64, 64)] })) if (e.unit_number !== undefined && !before0[e.unit_number]) equipment.push(e)
    const furnaces = (): LuaEntity[] => s.find_entities_filtered({ type: "furnace", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })
    const fuel = (): void => {
      for (const f of furnaces()) if (f.get_fuel_inventory()!.get_item_count("coal") < 5) f.insert({ name: "coal", count: 20 })
    }
    const plates = (): number => {
      let n = 0
      for (const f of furnaces()) n += f.products_finished
      return n
    }
    const measure = (ticks: number, then: (this: void, rate: number) => void): void => {
      let n = 0
      let start = 0
      on_tick(() => {
        fuel()
        // Sink: the column's output belt tile is emptied every tick.
        const m = findModule(job.layout, moduleId("smelt"))!
        for (const b of s.find_entities_filtered({ type: "transport-belt", area: [{ x: m.rect.x, y: m.rect.y - 1 }, { x: m.rect.x + m.rect.w, y: m.rect.y + 1 }] })) for (const i of [1, 2]) b.get_transport_line(i).clear()
        n++
        if (n === 3600) start = plates()
        if (n < 3600 + ticks) return
        then(((plates() - start) / ticks) * 60)
        return false
      })
    }
    async(60 * 60 * 30)
    measure(3600 * 3, (before) => {
      log(`[m5] grow: 4 furnaces smelt ${string.format("%.3f", before)} plates/s`)
      render(s, "grow-before", { x: ox, y: oy }, 56)
      const g = planGrowth(job.layout, terrainView(t), prototypeFacts, policy, tier, moduleId("smelt"), 1)
      assert(g.ok, `growth planned: ${g.reason}`)
      // Test equipment in the way of the growth goes (the drills keep theirs).
      const gr = findModule(g.layout, moduleId("smelt"))!.rect
      for (const e of equipment) {
        if (!e.valid) continue
        const p = e.position
        if (p.x > gr.x - 3 && p.x < gr.x + gr.w + 3 && p.y > gr.y - 3 && p.y < gr.y + gr.h + 3) e.destroy()
      }
      // Build the diff the way the crew's clear and place jobs do: pick up what moves, then revive ghosts.
      let removed = 0
      for (const e of g.remove) {
        const found = s.find_entities_filtered({ name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]
        if (found !== undefined && found.destroy()) removed++
      }
      const ghosts: LuaEntity[] = []
      for (const e of g.add) {
        const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: { x: e.x, y: e.y }, direction: e.dir, force }
        if (e.ioType !== undefined) params.type = e.ioType
        const gh = s.create_entity(params as never)
        assert(gh !== undefined, `ghost ${e.name} at ${e.x - ox},${e.y - oy}`)
        ghosts.push(gh!)
      }
      const revived = reviveAll(ghosts)
      log(`[m5] grow: picked up ${removed}/${g.remove.length}, built ${revived.length}/${g.add.length}, rerouted ${g.rerouted.join(",")}`)
      const notBuilt: string[] = []
      for (const gh of ghosts) if (gh.valid) {
        const blockers = s.find_entities_filtered({ area: gh.bounding_box })
        notBuilt.push(`${gh.ghost_name}@${gh.position.x - ox},${gh.position.y - oy} blocked by ${blockers.map((b) => `${b.name}@${b.position.x - ox},${b.position.y - oy}`).join(" ")}`)
      }
      assert(revived.length === g.add.length, `every new entity built: ${notBuilt.join("; ")}`)
      // The grown module's poles join the old ones; repower the test interfaces' neighbourhood.
      // Test power again: a pole just outside the grown module (within wire reach of its poles) with an interface.
      const gm = findModule(g.layout, moduleId("smelt"))!
      const pp = gm.def.ports.filter((p) => p.kind === "power")[0]
      const outside = s.find_non_colliding_position("small-electric-pole", { x: gm.origin.x - 2.5, y: gm.origin.y + pp.pos.y }, 3, 1, true)!
      s.create_entity({ name: "small-electric-pole", position: outside, force })
      const spot = s.find_non_colliding_position("electric-energy-interface", { x: outside.x - 2, y: outside.y }, 3, 0.5)!
      const eei = s.create_entity({ name: "electric-energy-interface", position: spot, force })!
      eei.power_production = 1e7
      eei.electric_buffer_size = 1e8
      eei.energy = 1e8
      job.layout = g.layout
      measure(3600 * 3, (after) => {
        const names: Record<number, string> = {}
        for (const [k, v] of pairs(defines.entity_status)) names[v as unknown as number] = k as string
        const stat: Record<string, number> = {}
        for (const e of s.find_entities_filtered({ force, type: ["inserter", "mining-drill", "furnace"], area: [at(lab, -64, -64), at(lab, 64, 64)] })) {
          const k = `${e.type}:${names[e.status as unknown as number]}`
          stat[k] = (stat[k] ?? 0) + 1
        }
        log(`[m5] grow: status after ${serpent.line(stat)}`)
        log(`[m5] grow: 8 furnaces smelt ${string.format("%.3f", after)} plates/s (before ${string.format("%.3f", before)})`)
        render(s, "grow-after", { x: ox, y: oy }, 56)
        assert(furnaces().length === 8, `${furnaces().length} furnaces`)
        assert(after > before * 1.5, `rate ${after} vs ${before}`)
        done()
      })
    })
  })

  test("B37: a built smelter grows over a built pole line: the line is picked up and re-laid, the labs stay powered", () => {
    const lab = createLab(64)
    const force = labForce()
    const s = lab.surface
    const water = []
    for (let x = -64; x < -50; x++) for (let y = -64; y < 64; y++) water.push({ name: "water", position: at(lab, x, y) })
    s.set_tiles(water)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const policy = selectPolicy("early-compact", {})
    const tier = beltTiers(prototypeFacts)[0]
    const layout = newLayout()
    const t0 = scan(lab, "b37-before", force.name)
    const sp = placeNow({ id: moduleId("steam"), def: generatedModule("steam-block", { boilers: 1 }), targets: {}, center: { x: ox - 50, y: oy + 10 }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, layout, terrainView(t0), policy)
    assert(sp.phase === "done", `steam placement: ${sp.reason}`)
    commitPlacement(layout, sp.result!, prototypeFacts, policy)
    const steam = findModule(layout, moduleId("steam"))!
    place(layout, "labs", "lab-array", { labs: 2, packs: ["automation-science-pack"] }, { x: steam.rect.x + steam.rect.w + 60, y: steam.rect.y })
    polesNow(layout, terrainView(t0), prototypeFacts, policy, "poles:a:")
    const line = layout.poleLines![0].id
    // The smelter north of the line's middle pole, its first two growth units (south) over it.
    const mid = layout.poles!.filter((p) => p.line === line)[math.floor(layout.poles!.length / 2)]
    place(layout, "smelt", "smelter-column", { recipe: "iron-plate", furnaces: 4 }, { x: mid.x - 5, y: mid.y - 13 })
    polesNow(layout, terrainView(t0), prototypeFacts, policy, "poles:b:")
    assert(unpoweredModules(layout, prototypeFacts).length === 0, "everything joined")
    const r = stampParts(s, force.name, layout, allParts(layout), true)
    assert(r.failed.length === 0, `ghosts: ${r.failed.join("; ")}`)
    const built = reviveAll(r.entities)
    assert(built.length === r.entities.length, `revived ${built.length}/${r.entities.length}`)
    // The built poles read as own entities in a fresh scan: growth over them used to fail here ("blocked at").
    const t = scan(lab, "b37", force.name)
    const raw = planGrowth(layout, terrainView(t), prototypeFacts, policy, tier, moduleId("smelt"), 2)
    log(`[b37] growth on the raw scan: ${raw.ok ? "ok" : raw.reason}`)
    assert(!raw.ok, "the raw scan blocks the growth at a built pole")
    // The faction's planner view (claimView) reads its own pole-line poles as clearable ground.
    storage.factories ??= {}
    storage.factories["b37-test"] = { layout } as never
    const g = planGrowth(layout, claimView("b37-test", s.name, terrainView(t), false), prototypeFacts, policy, tier, moduleId("smelt"), 2, "small-electric-pole", "poles:g:")
    delete storage.factories["b37-test"]
    assert(g.ok, `growth planned: ${g.reason}`)
    let polesOut = 0
    let polesIn = 0
    for (const e of g.remove) if (e.name === "small-electric-pole") polesOut++
    for (const e of g.add) if (e.name === "small-electric-pole" && string.sub(e.owner, 1, 8) === "poles:g:") polesIn++
    log(`[b37] growth: ${g.remove.length} to pick up (${polesOut} poles), ${g.add.length} to build (${polesIn} new line poles)`)
    assert(polesOut > 0 && polesIn > 0, "the line is picked up and re-laid")
    // Build the diff as the crew does: pick up, then revive ghosts.
    for (const e of g.remove) s.find_entities_filtered({ name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]?.destroy()
    const ghosts: LuaEntity[] = []
    for (const e of g.add) {
      const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: { x: e.x, y: e.y }, direction: e.dir, force }
      if (e.ioType !== undefined) params.type = e.ioType
      const gh = s.create_entity(params as never)
      assert(gh !== undefined, `ghost ${e.name} at ${e.x - ox},${e.y - oy}`)
      ghosts.push(gh!)
    }
    const revived = reviveAll(ghosts)
    assert(revived.length === g.add.length, `every new entity built (${revived.length}/${g.add.length})`)
    const engine = s.find_entities_filtered({ type: "generator", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })[0]
    const net = engine.electric_network_id
    const off: string[] = []
    for (const l of s.find_entities_filtered({ type: "lab", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })) if (l.electric_network_id !== net) off.push(`lab at ${l.position.x - ox},${l.position.y - oy}`)
    for (const i of s.find_entities_filtered({ type: "inserter", force, area: [at(lab, -64, -64), at(lab, 64, 64)] })) if (i.name !== "burner-inserter" && i.electric_network_id !== net) off.push(`inserter at ${i.position.x - ox},${i.position.y - oy}`)
    render(s, "b37-after", { x: ox, y: oy }, 64)
    assert(off.length === 0, `on the engine's network: ${off.join("; ")}`)
  })

  test("B41: a re-laid pole line reuses a live pole instead of ghosting over it", () => {
    const lab = createLab(16)
    const force = labForce()
    const layout = newLayout()
    const x = math.floor(lab.origin.x)
    const y = math.floor(lab.origin.y)
    layout.poles = [
      { id: poleId("kept"), name: "small-electric-pole", x, y, line: poleLineId("poles:b41:0") },
      { id: poleId("new"), name: "small-electric-pole", x: x + 6, y, line: poleLineId("poles:b41:0") },
    ]
    layout.poleLines = [{ id: poleLineId("poles:b41:0"), from: "power", to: moduleId("consumer"), poles: [poleId("kept"), poleId("new")] }]
    const built = lab.surface.create_entity({ name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 }, force })
    assert(built !== undefined, "the old line's pole was built")

    const r = stampParts(lab.surface, force.name, layout, { modules: [], routes: [], poles: [poleId("kept"), poleId("new")] }, true)
    assert(r.failed.length === 0, `ghost failures: ${r.failed.join("; ")}`)
    assert(r.entities.length === 1, `only the new pole gets a ghost (${r.entities.length})`)
    assert(r.entities[0].type === "entity-ghost" && r.entities[0].ghost_name === "small-electric-pole", "the new pole is ghosted")
    assert(r.entities[0].position.x === x + 6.5 && r.entities[0].position.y === y + 0.5, "the ghost is at the new tile")
    assert(built!.valid, "the re-used pole stays built")
    const overlaid = lab.surface.find_entities_filtered({ ghost_name: "small-electric-pole", position: built!.position, force })
    assert(overlaid.length === 0, "no impossible ghost is stamped over the live pole")
  })

  test("D71 (b): a build that evicts a pole line places its new poles before the old ones are picked up", () => {
    const lab = createLab(16)
    const f = createFaction("d71b", { position: at(lab, 0, 0), crew: 0 })
    const s = lab.surface
    const layout = newLayout()
    const x = math.floor(lab.origin.x)
    const y = math.floor(lab.origin.y)
    // The plan's new line: one pole on open ground, one where an old entity is still to be picked up.
    layout.poles = [
      { id: poleId("new"), name: "small-electric-pole", x: x + 3, y, line: poleLineId("poles:d71:0") },
      { id: poleId("late"), name: "small-electric-pole", x: x + 6, y, line: poleLineId("poles:d71:0") },
    ]
    layout.poleLines = [{ id: poleLineId("poles:d71:0"), from: "power", to: moduleId("consumer"), poles: [poleId("new"), poleId("late")] }]
    const old = s.create_entity({ name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 }, force: f.force })!
    const site = s.create_entity({ name: "wooden-chest", position: { x: x + 6.5, y: y + 0.5 }, force: f.force })!
    const parts = { modules: [], routes: [], poles: [poleId("new"), poleId("late")] }
    const entry = { id: "d71b", surface: s.name, force: f.force, faction: f.name, terrain: "", phase: "done", request: {}, belt: "transport-belt", job: { layout }, startTick: 0, scanTicks: 0, planTicks: 0 } as never as PlannerEntry
    const b = startBuild(entry, { parts, clear: [site], breakAfter: [old], priority: 90 })
    assert(b.phase === "poles", `the build starts with the new poles (${b.phase})`)
    assert(clearJobFor(f, old) === undefined, "the evicted pole is not picked up yet")
    assert(clearJobFor(f, site) !== undefined, "other clearing starts at once")
    const ghosts = s.find_entities_filtered({ ghost_name: "small-electric-pole", force: f.force })
    assert(ghosts.length === 1 && ghosts[0].position.x === x + 3.5, `only the pole on open ground is ghosted ahead (${ghosts.length})`)
    stepBuild(entry)
    assert(b.phase === "poles" && clearJobFor(f, old) === undefined, "waits while the new pole is not placed")
    ghosts[0].revive({ raise_revive: true })
    for (const id of b.poleJobs ?? []) {
      claim(f.board, [id], 1, game.tick)
      complete(f.board, id, 1, game.tick)
    }
    stepBuild(entry)
    assert(b.phase === "clear", `then the clearing (${b.phase})`)
    assert(clearJobFor(f, old) !== undefined, "the evicted pole is picked up once its replacement stands")
    // Without an eviction the build is unchanged: clearing first.
    const plain = startBuild({ ...(entry as object), build: undefined } as never as PlannerEntry, { parts, priority: 90 })
    assert(plain.phase === "clear", `no eviction: no poles phase (${plain.phase})`)
    destroyFaction("d71b")
  })

  test("B46: poles another plan evicted leave a building goal's own plan: its ghost stamp no longer creates them", () => {
    const lab = createLab(16)
    const force = labForce()
    const s = lab.surface
    const layout = newLayout()
    const x = math.floor(lab.origin.x)
    const y = math.floor(lab.origin.y)
    layout.poles = [
      { id: poleId("evicted"), name: "small-electric-pole", x, y, line: poleLineId("poles:b46:0") },
      { id: poleId("kept"), name: "small-electric-pole", x: x + 6, y, line: poleLineId("poles:b46:0") },
    ]
    layout.poleLines = [{ id: poleLineId("poles:b46:0"), from: "power", to: moduleId("consumer"), poles: [poleId("evicted"), poleId("kept")] }]
    layout.occ[tkey(x, y)] = layoutClaimTag("x:poles:b46:0")
    layout.occ[tkey(x + 6, y)] = layoutClaimTag("x:poles:b46:0")
    const parts = { modules: [], routes: [], poles: [poleId("evicted"), poleId("kept")] }
    // A later plan's route took the first pole's tile (B37) before this goal stamped its ghosts.
    const dropped = dropPlannedPoles(layout, parts, { [`small-electric-pole@${x},${y}`]: true })
    assert(dropped.length === 1, `one pole dropped (${dropped.length})`)
    assert(parts.poles.length === 1 && parts.poles[0] === "kept", `parts keep the other pole (${parts.poles.join(",")})`)
    assert(layout.occ[tkey(x, y)] === undefined && layout.occ[tkey(x + 6, y)] === "x:poles:b46:0", "its tile is no longer the goal's")
    assert(layout.poleLines?.[0]?.poles.join(",") === "kept", `the line drops the removed pole (${layout.poleLines?.[0]?.poles.join(",")})`)
    const r = stampParts(s, force.name, layout, parts, true)
    assert(r.failed.length === 0, r.failed.join("; "))
    assert(r.entities.length === 1 && r.entities[0].position.x === x + 6.5, `only the kept pole is ghosted (${r.entities.length})`)
    assert(s.find_entities_filtered({ ghost_name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 } }).length === 0, "no ghost where the other plan's belt goes")
    assert(dropPlannedPoles(layout, parts, { [`small-electric-pole@${x},${y}`]: true }).length === 0, "idempotent")
  })

  test("B158: dropping an evicted pole also removes its stamped ghost and place job", () => {
    // B46 removes the pole from the building goal's plan. If the goal had already stamped its ghost, the world kept a
    // ghost no plan owned and no job built: the power graph said "powered", the world was an island.
    const lab = createLab(16)
    const faction = createFaction(`b158-drop-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const s = lab.surface
    const x = math.floor(lab.origin.x)
    const y = math.floor(lab.origin.y)
    const gh = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 }, force: faction.force })!
    const unit = gh.unit_number!
    const job = addPlaceJob(faction, gh, { priority: 90 })!
    assert(job !== undefined && faction.ghostJobs[unit] === job, "the ghost has a place job")
    const placeJobs = [job]
    const n = dropEvictedPoleGhosts(s, faction, [{ id: poleId("evicted"), name: "small-electric-pole", x, y, line: poleLineId("l") }], placeJobs)
    assert(n === 1, `one stamped ghost removed (${n})`)
    assert(!gh.valid, "the ghost is gone")
    assert(faction.ghostJobs[unit] === undefined, "its job mapping is gone")
    assert(placeJobs.length === 0, "the build no longer waits on it")
  })

  test("B158: a lifted ghost comes back only while its plan part still exists", () => {
    const lab = createLab(16)
    const faction = createFaction(`b158-lift-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const s = lab.surface
    const x = math.floor(lab.origin.x) + 0.5
    const y = math.floor(lab.origin.y) + 0.5
    const lift = { name: "small-electric-pole", position: { x, y }, direction: 0 as defines.direction, surface: s.name, clear: 0 }
    const owner = { id: "g158", lifted: [lift] }
    const ghosts: LuaEntity[] = []
    assert(restoreLifted(owner, faction, ghosts, () => ({})) === false, "nothing waits")
    assert(ghosts.length === 0 && owner.lifted === undefined, "the unplanned lift is dropped, not restored")
    const planned: Record<string, boolean> = { [string.format("small-electric-pole@%g,%g", x, y)]: true }
    const owner2 = { id: "g158b", lifted: [lift] }
    assert(restoreLifted(owner2, faction, ghosts, () => planned) === false, "nothing waits after restoring")
    assert(ghosts.length === 1 && ghosts[0].valid && ghosts[0].name === "entity-ghost", "the planned lift is restored")
    destroyFaction(faction.name)
  })

  test("B158: a pending ghost whose kept route is gone is dropped instead of created", () => {
    const lab = createLab(16)
    const faction = createFaction(`b158-pending-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const s = lab.surface
    const x = math.floor(lab.origin.x) + 0.5
    const y = math.floor(lab.origin.y) + 0.5
    faction.pendingGhosts = [{ name: "transport-belt", x, y, dir: 0, after: [], priority: 90, owner: "route:missing" }]
    placePendingGhosts()
    assert(s.find_entities_filtered({ ghost_name: "transport-belt", position: { x, y }, force: faction.force }).length === 0, "no unplanned ghost")
    assert((faction.pendingGhosts ?? []).length === 0, "the entry is gone")
    // A legacy entry (no owner) keeps the old path.
    faction.pendingGhosts = [{ name: "transport-belt", x, y, dir: 0, after: [], priority: 90 }]
    placePendingGhosts()
    assert(s.find_entities_filtered({ ghost_name: "transport-belt", position: { x, y }, force: faction.force }).length === 1, "the legacy entry is restored")
    destroyFaction(faction.name)
  })

  test("B42: an own entity the layout does not plan under a leftover ghost is a stray to pick up; planned ones are not", () => {
    const lab = createLab(16)
    const force = labForce()
    const s = lab.surface
    const layout = newLayout()
    const x = math.floor(lab.origin.x)
    const y = math.floor(lab.origin.y)
    layout.poles = [
      { id: poleId("blocked"), name: "small-electric-pole", x, y, line: poleLineId("poles:b42:0") },
      { id: poleId("built"), name: "small-electric-pole", x: x + 4, y, line: poleLineId("poles:b42:0") },
      { id: poleId("other"), name: "small-electric-pole", x: x + 8, y, line: poleLineId("poles:b42:0") },
    ]
    layout.poleLines = [{ id: poleLineId("poles:b42:0"), from: "power", to: moduleId("consumer"), poles: [poleId("blocked"), poleId("built"), poleId("other")] }]
    // Report 125521: an obsolete underground belt put back on the tile of a planned pole.
    const belt = s.create_entity({ name: "underground-belt", type: "input", position: { x: x + 0.5, y: y + 0.5 }, direction: defines.direction.south, force })!
    const ghost = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 }, force })!
    // B41: the planned pole already built under its own ghost is not a stray.
    s.create_entity({ name: "small-electric-pole", position: { x: x + 4.5, y: y + 0.5 }, force })
    const overBuilt = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: x + 4.5, y: y + 0.5 }, force })!
    // A planned entity under some other ghost is the layout's own: never picked up by this rule.
    s.create_entity({ name: "small-electric-pole", position: { x: x + 8.5, y: y + 0.5 }, force })
    const overPlanned = s.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: { x: x + 8.5, y: y + 0.5 }, force })!
    const planned = layoutEntityKeys(layout)
    const strays = strayUnder(s, force.name, planned, ghost)
    assert(strays.length === 1 && strays[0] === belt, `the belt is the one stray (${strays.length})`)
    assert(strayUnder(s, force.name, planned, overBuilt).length === 0, "a built planned pole under its own ghost is not a stray")
    assert(strayUnder(s, force.name, planned, overPlanned).length === 0, "a planned pole under another ghost is not a stray")
  })

  test("B152: a reroute's partial add retries instead of leaving its successful ghosts jobless", () => {
    // The splitter at 350,-41.5: `applyDiff` is two-phase, so one failed add left every successful add jobless, and
    // `rework` cleared itself and moved on. It must keep the add list and retry.
    const lab = createLab(32)
    const faction = createFaction(`rework-retry-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    brain.nextThink = math.huge
    brain.milestones["first-electricity-materials"] = game.tick
    const f = startFactory(faction)
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const good = { name: "transport-belt", x: ox + 2.5, y: oy + 0.5, dir: 0, owner: "route:r" }
    const bad = { name: "transport-belt", x: ox + 4.5, y: oy + 0.5, dir: 0, owner: "route:r" }
    const stale = s.create_entity({ name: "underground-belt", type: "input", position: { x: bad.x, y: bad.y }, direction: defines.direction.north, force: faction.force })!
    const g: FactoryGoal = {
      id: goalId("g-rework"),
      kind: "production",
      status: "building",
      nodes: [],
      edges: [],
      techs: [],
      attempts: 1,
      radius: 0,
      createdTick: game.tick,
      placed: 0,
      rounds: 0,
      rework: { clearJobs: [], add: [good, bad] },
    }
    const b = { phase: "place", faction: faction.name, clearJobs: [], placeJobs: [], failed: [], ghosts: [] } as never
    const ctx = { faction, f, config: getConfig(), surface: s, tick: game.tick, entities: {} } as never
    assert(rework(ctx, g, b) === false, "the partial add waits")
    assert(g.rework !== undefined, "the add list is kept for a retry")
    assert((b as unknown as { placeJobs: number[] }).placeJobs.length === 0, "no job while a ghost of the list is missing")
    stale.destroy()
    ;(ctx as unknown as { tick: number }).tick += 2000
    ;(b as unknown as { retryAt?: number }).retryAt = undefined
    assert(rework(ctx, g, b) === true, "the retry completes")
    assert(g.rework === undefined && (b as unknown as { phase: string }).phase === "place", "the reroute proceeds")
    assert((b as unknown as { placeJobs: number[] }).placeJobs.length === 2, "both successful ghosts got jobs")
  })

  test("B152: a retried stamp adopts an existing pole ghost instead of skipping its job", () => {
    // This was the upstream path: a partial stamp created pole ghosts but no jobs; the retry found each existing pole
    // ghost and `continue`d, so the ghost never entered the job loop and stayed jobless for good.
    const lab = createLab(32)
    const faction = createFaction(`stamp-adopt-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const layout = newLayout()
    layout.poles = [{ id: poleId("p"), name: "small-electric-pole", x: ox, y: oy, line: poleLineId("l") }]
    const ghost = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: ox + 0.5, y: oy + 0.5 }, force: faction.force })!
    const r = stampParts(s, faction.force, layout, { modules: [], routes: [], poles: [poleId("p")] }, true)
    assert(r.failed.length === 0, r.failed.join("; "))
    assert(r.entities.length === 1 && r.entities[0] === ghost, "the existing pole ghost is part of the stamp")
  })

  test("M7d.5: a planned pole ghost with no job is adopted; an unplanned or already-jobbed one is not", () => {
    // The robot block's connecting pole ghosts had job=none, so the layout's power graph said "powered" while the
    // built networks were islands and no power repair ran.
    const lab = createLab(32)
    const faction = createFaction(`adopt-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const layout = newLayout()
    layout.poles = [
      { id: poleId("planned"), name: "small-electric-pole", x: ox, y: oy, line: poleLineId("l") },
      { id: poleId("planned2"), name: "small-electric-pole", x: ox + 8, y: oy, line: poleLineId("l") },
    ]
    const planned = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: ox + 0.5, y: oy + 0.5 }, force: faction.force })!
    const unplanned = s.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: { x: ox + 4.5, y: oy + 0.5 }, force: faction.force })!
    assert(planned !== undefined && unplanned !== undefined, "ghosts placed")
    assert(adoptPlannedPoles(s, faction, layout, 150) === 1, "one planned orphan adopted")
    const id = faction.ghostJobs[planned.unit_number!]
    assert(id !== undefined, "the planned ghost got a job")
    assert(getJob(faction.board, id!)!.status !== "failed", "the job is open")
    assert(faction.ghostJobs[unplanned.unit_number!] === undefined, "the unplanned ghost was left alone")
    assert(adoptPlannedPoles(s, faction, layout, 150) === 0, "a live job is not duplicated")
  })

  test("B144: a repair goal (growBuild without growth) survives a hard ghost blocker", () => {
    // The m7d5-robotsB run crashed at minute 1044: a repair goal reuses `growBuild` but has no `growth`, and the hard
    // blocker branch dereferenced `g.growth.node`. A repair goal with two pieces on one tile is enough to reach it.
    const lab = createLab(64)
    const faction = createFaction(`b144-repair-${game.tick}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    brain.nextThink = math.huge
    brain.milestones["first-electricity-materials"] = game.tick
    const f = startFactory(faction)
    const s = lab.surface
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    for (let x = -20; x < 0; x++) for (let y = 30; y < 50; y++) s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount: 100000 })
    const layout = newLayout()
    place(layout, "b144-src", "mining-outpost", { resource: "iron-ore", rows: 4, sides: 2 }, { x: ox - 15, y: oy + 30 })
    place(layout, "b144-dst", "smelter-column", { recipe: "iron-plate", furnaces: 4 }, { x: ox - 5, y: oy - 30 })
    const t = scan(lab, `b144-${game.tick}`, faction.force)
    const job = runJob(newRoutingJob({
      modules: [],
      connections: [{ id: connectionId("b144"), from: { module: moduleId("b144-src"), port: "out" }, to: { module: moduleId("b144-dst"), port: "in-ore" } }],
      center: { x: ox, y: oy },
      region: { x: ox - 64, y: oy - 64, w: 128, h: 128 },
    }, beltTiers(prototypeFacts)[0], layout), terrainView(t), prototypeFacts, selectPolicy("early-compact", {}))
    assert(job.phase === "done", `the test route plans: ${job.phase}`)
    f.layout = job.layout
    const parts = { modules: [], routes: [routeId("route:b144")], poles: [] }
    const stamped = stampParts(s, faction.force, job.layout, parts, true)
    assert(stamped.failed.length === 0, stamped.failed.join("; "))
    let belt
    for (const e of partEntities(job.layout, parts)) if (belt === undefined && e.name === "transport-belt") belt = e
    assert(belt !== undefined, "a route belt")
    const clash = { name: "underground-belt", x: belt!.x, y: belt!.y, dir: belt!.dir, ioType: "input" as const, owner: "route:b144" }
    const g: FactoryGoal = {
      id: goalId("g144"),
      kind: "repair",
      status: "building",
      nodes: [],
      edges: [],
      techs: [],
      attempts: 1,
      radius: 64,
      createdTick: game.tick,
      placed: 0,
      rounds: 0,
      growBuild: { phase: "clear", clearJobs: [], add: [belt!, clash], ghosts: [], placeJobs: [] },
    }
    f.goals = [g]
    async(300)
    on_tick(() => {
      if (g.status !== "failed") return
      done()
      return false
    })
  })
})
