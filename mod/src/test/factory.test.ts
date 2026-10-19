import { LuaEntity, LuaSurface } from "factorio:runtime"
import { clearConfigOverrides } from "../config"
import { destroyFaction } from "../jobs/faction"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { allParts } from "../planner/build-list"
import { beltTiers } from "../planner/capacity"
import { Vec } from "../planner/grid"
import { planGrowth } from "../planner/grow"
import { commitModule, findModule, newLayout, PlacedModule } from "../planner/layout"
import { newRoutingJob, runJob } from "../planner/plan"
import { commitPlacement, placeNow } from "../planner/placement"
import { polesNow, unpoweredModules } from "../planner/power"
import { selectPolicy } from "../planner/policy"
import { claimView, stampParts } from "../planner/runtime"
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
  const m: PlacedModule = { id, canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
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
    const sp = placeNow({ id: "steam", def: steamDef, targets: {}, center: { x: ox - 50, y: oy }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, layout, view, policy)
    assert(sp.phase === "done", `steam placement: ${sp.reason}`)
    commitPlacement(layout, sp.result!, prototypeFacts, policy)
    const steam = findModule(layout, "steam")!
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
    const job = runJob(newRoutingJob({ modules: [], connections: [{ id: "ore", from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }], center: { x: ox, y: oy }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, tier, layout), view, prototypeFacts, policy)
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
        const m = findModule(job.layout, "smelt")!
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
      const g = planGrowth(job.layout, terrainView(t), prototypeFacts, policy, tier, "smelt", 1)
      assert(g.ok, `growth planned: ${g.reason}`)
      // Test equipment in the way of the growth goes (the drills keep theirs).
      const gr = findModule(g.layout, "smelt")!.rect
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
      const gm = findModule(g.layout, "smelt")!
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
    const sp = placeNow({ id: "steam", def: generatedModule("steam-block", { boilers: 1 }), targets: {}, center: { x: ox - 50, y: oy + 10 }, region: { x: ox - 64, y: oy - 64, w: 128, h: 128 } }, layout, terrainView(t0), policy)
    assert(sp.phase === "done", `steam placement: ${sp.reason}`)
    commitPlacement(layout, sp.result!, prototypeFacts, policy)
    const steam = findModule(layout, "steam")!
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
    const raw = planGrowth(layout, terrainView(t), prototypeFacts, policy, tier, "smelt", 2)
    log(`[b37] growth on the raw scan: ${raw.ok ? "ok" : raw.reason}`)
    assert(!raw.ok, "the raw scan blocks the growth at a built pole")
    // The faction's planner view (claimView) reads its own pole-line poles as clearable ground.
    storage.factories ??= {}
    storage.factories["b37-test"] = { layout } as never
    const g = planGrowth(layout, claimView("b37-test", s.name, terrainView(t), false), prototypeFacts, policy, tier, "smelt", 2, "small-electric-pole", "poles:g:")
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
      { id: "kept", name: "small-electric-pole", x, y, line: "poles:b41:0" },
      { id: "new", name: "small-electric-pole", x: x + 6, y, line: "poles:b41:0" },
    ]
    layout.poleLines = [{ id: "poles:b41:0", from: "power", to: "consumer", poles: ["kept", "new"] }]
    const built = lab.surface.create_entity({ name: "small-electric-pole", position: { x: x + 0.5, y: y + 0.5 }, force })
    assert(built !== undefined, "the old line's pole was built")

    const r = stampParts(lab.surface, force.name, layout, { modules: [], routes: [], poles: ["kept", "new"] }, true)
    assert(r.failed.length === 0, `ghost failures: ${r.failed.join("; ")}`)
    assert(r.entities.length === 1, `only the new pole gets a ghost (${r.entities.length})`)
    assert(r.entities[0].type === "entity-ghost" && r.entities[0].ghost_name === "small-electric-pole", "the new pole is ghosted")
    assert(r.entities[0].position.x === x + 6.5 && r.entities[0].position.y === y + 0.5, "the ghost is at the new tile")
    assert(built!.valid, "the re-used pole stays built")
    const overlaid = lab.surface.find_entities_filtered({ ghost_name: "small-electric-pole", position: built!.position, force })
    assert(overlaid.length === 0, "no impossible ghost is stamped over the live pole")
  })
})
