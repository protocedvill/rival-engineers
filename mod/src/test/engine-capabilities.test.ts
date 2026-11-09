import { LuaEntity, LuaForce, LuaSurface, MapPosition } from "factorio:runtime"
import { PathfinderWaypoint } from "factorio:runtime"
import { forgetPathRequest, getPathRequest, requestCharacterPath } from "../character/pathing"
import { tkey } from "../planner/grid"
import { chunkKnown } from "../strategy/arms"
import { onSectorScanned } from "../strategy/explore"
import { encodeWells } from "../modules/generators"
import { generatedModule } from "../modules/library"
import { rateOf } from "../modules/rates"
import { stampModule } from "../modules/stamp"
import { at, createLab, everyTickFor, itemCount, spawnEngineer } from "./lab"

// M0 spike: can a character entity with NO attached player perform every player action the crew
// needs, using player-equivalent APIs (SPEC §5.1)? These tests pin those engine assumptions so a
// Factorio update that breaks them fails CI instead of silently breaking the AI.

function maxDetour(y0: number, path: PathfinderWaypoint[]): number {
  let max = 0
  for (const wp of path) max = math.max(max, math.abs(wp.position.y - y0))
  return max
}

describe("player-less character", () => {
  test("walks when walking_state is set", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    const startX = character.position.x
    everyTickFor(59, () => {
      character.walking_state = { walking: true, direction: defines.direction.east }
    })
    after_ticks(60, () => {
      // Vanilla running speed is 0.15 tiles/tick, so ~9 tiles in 60 ticks.
      const moved = character.position.x - startX
      assert(moved > 7 && moved < 10, `moved ${moved} tiles`)
    })
  })

  test("walking_state persists without being re-set each tick", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    const startX = character.position.x
    character.walking_state = { walking: true, direction: defines.direction.east }
    after_ticks(60, () => {
      const moved = character.position.x - startX
      // Record the behaviour either way; the controller re-sets every tick regardless.
      log(`[spike] walking_state set once: moved ${moved} tiles in 60 ticks`)
    })
  })

  test("pathfinder routes a character around an obstacle", () => {
    const lab = createLab()
    const character = spawnEngineer(lab, -10, 0)
    for (let y = -8; y <= 8; y++) {
      lab.surface.create_entity({ name: "stone-wall", position: at(lab, 0.5, y + 0.5), force: "neutral" })
    }
    const id = requestCharacterPath(character, at(lab, 10, 0))
    async(600)
    on_tick(() => {
      const req = getPathRequest(id)!
      if (req.status === "pending") return
      assert(req.status === "found", `path status ${req.status}`)
      assert(maxDetour(lab.origin.y, req.path!) > 8, "path goes around the wall, not through it")
      forgetPathRequest(id)
      done()
    })
  })

  test("pathfinder only routes around obstacles when requested as the neutral force", () => {
    // The unit pathfinder treats entities the requesting force could attack as destroyable and paths
    // through them. Requested as the character's own force, it walks straight through a neutral wall
    // (and trees, and other forces' buildings). As the neutral force, everything blocks. If this test
    // fails, an engine update changed that behaviour: revisit requestCharacterPath.
    const lab = createLab()
    const character = spawnEngineer(lab, -10, 0)
    for (let y = -20; y <= 20; y++) {
      lab.surface.create_entity({ name: "stone-wall", position: at(lab, 0.5, y + 0.5), force: "neutral" })
    }
    const request = (force: string) => {
      const id = lab.surface.request_path({
        bounding_box: character.prototype.collision_box,
        collision_mask: character.prototype.collision_mask,
        start: character.position,
        goal: at(lab, 10, 0),
        force,
        radius: 1,
        entity_to_ignore: character,
        pathfind_flags: { cache: false },
      })
      storage.pathRequests[id] = { status: "pending" } // collected by the mod's handler
      return id
    }
    const asPlayer = request("player")
    const asNeutral = request("neutral")
    async(600)
    on_tick(() => {
      const p = getPathRequest(asPlayer)!
      const n = getPathRequest(asNeutral)!
      if (p.status === "pending" || n.status === "pending") return
      const through = maxDetour(lab.origin.y, p.path!)
      const around = maxDetour(lab.origin.y, n.path!)
      log(`[spike] wall detour as player force: ${through}, as neutral force: ${around}`)
      assert(through < 1, "player-force path goes through the neutral wall")
      assert(around > 20, "neutral-force path goes around")
      forgetPathRequest(asPlayer)
      forgetPathRequest(asNeutral)
      done()
    })
  })

  test("mines a resource at real speed via mining_state", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    const orePos = at(lab, 1.5, 0.5)
    lab.surface.create_entity({ name: "iron-ore", position: orePos, amount: 100 })
    everyTickFor(299, () => {
      character.update_selected_entity(orePos)
      character.mining_state = { mining: true, position: orePos }
    })
    after_ticks(300, () => {
      // Hand mining: iron ore mining_time 1 / character mining_speed 0.5 = 2 s = 120 ticks each.
      const mined = itemCount(character, "iron-ore")
      log(`[spike] mined ${mined} iron ore in 300 ticks`)
      assert(mined >= 2 && mined <= 3, `mined ${mined}`)
    })
  })

  test("hand-crafts with real crafting time via begin_crafting", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    character.insert({ name: "iron-plate", count: 4 })
    const started = character.begin_crafting({ recipe: "iron-gear-wheel", count: 2 })
    assert(started === 2, `queued ${started}`)
    after_ticks(20, () => {
      // Gear takes 0.5 s = 30 ticks: none finished yet.
      assert(itemCount(character, "iron-gear-wheel") === 0, "no instant crafting")
    })
    after_ticks(70, () => {
      assert(itemCount(character, "iron-gear-wheel") === 2, "both gears crafted")
    })
  })

  test("can_place_entity respects reach; placing consumes the item", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    character.insert({ name: "stone-furnace", count: 1 })
    const near = at(lab, 3, 0)
    const far = at(lab, 30, 0)
    assert(character.can_place_entity({ name: "stone-furnace", position: near }), "near placement allowed")
    const farAllowed = character.can_place_entity({ name: "stone-furnace", position: far })
    log(`[spike] can_place_entity at 30 tiles: ${farAllowed} (build_distance=${character.build_distance})`)
    assert(!farAllowed, "far placement must be out of reach")

    const removed = character.remove_item({ name: "stone-furnace", count: 1 })
    assert(removed === 1)
    const furnace = lab.surface.create_entity({
      name: "stone-furnace",
      position: near,
      force: character.force,
      raise_built: true,
    })
    assert(furnace?.valid, "furnace placed")
    assert(itemCount(character, "stone-furnace") === 0)
  })

  test("reach-checked insert into an entity", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    const furnace = lab.surface.create_entity({ name: "stone-furnace", position: at(lab, 3, 0), force: "player" })!
    const farChest = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 30, 0), force: "player" })!
    assert(character.can_reach_entity(furnace), "furnace in reach")
    assert(!character.can_reach_entity(farChest), "far chest out of reach")
    character.insert({ name: "coal", count: 5 })
    const moved = furnace.insert({ name: "coal", count: character.remove_item({ name: "coal", count: 5 }) })
    assert(moved === 5)
    assert(furnace.get_fuel_inventory()!.get_item_count("coal") === 5)
  })

  test("picks up a placed entity via mining_state", () => {
    const lab = createLab()
    const character = spawnEngineer(lab)
    const pos = at(lab, 2.5, 0.5)
    lab.surface.create_entity({ name: "wooden-chest", position: pos, force: "player" })
    everyTickFor(89, () => {
      character.update_selected_entity(pos)
      character.mining_state = { mining: true, position: pos }
    })
    after_ticks(90, () => {
      const pickedUp = itemCount(character, "wooden-chest")
      log(`[spike] mining_state pick-up of wooden chest: ${pickedUp}`)
      assert(pickedUp === 1, "chest returned to inventory")
    })
  })

  test("hand-crafting by a player-less character does not fire craft-item research triggers (M5a finding)", () => {
    const lab = createLab()
    const force = game.forces["m5-trigger"] ?? game.create_force("m5-trigger")
    force.reset()
    for (const t of ["steam-power", "electronics"]) force.technologies[t].researched = true
    const character = lab.surface.create_entity({ name: "character", position: at(lab, 0, 0), force })!
    character.insert({ name: "electronic-circuit", count: 10 })
    character.insert({ name: "iron-gear-wheel", count: 10 })
    character.insert({ name: "transport-belt", count: 4 })
    assert(character.begin_crafting({ recipe: "lab", count: 1 }) === 1, "lab queued")
    after_ticks(200, () => {
      assert(itemCount(character, "lab") === 1, "lab crafted")
      const researched = force.technologies["automation-science-pack"].researched
      log(`[spike] craft-item trigger (lab) after a player-less hand-craft: researched = ${researched}`)
      assert(!researched, "the engine fired the trigger: the crew's emulation (strategy/factory.ts) is no longer needed")
    })
  })
  // M7d (P48: "engine tests first: robots and personal roboports must work for a force with no players (radars do not,
  // D62)"). Each test sets the same scene up for a script-created force and for the player force, and logs both.
  test("M7d (P48): a roboport network builds ghosts and removes trees for a force with no players", () => {
    const lab = createLab(48)
    const npf = game.forces["m7d-net"] ?? game.create_force("m7d-net")
    const scene = (f: LuaForce, ox: number): { ghosts: LuaEntity[]; tree: LuaEntity } => {
      const p = (dx: number, dy: number): MapPosition => at(lab, ox + dx, dy)
      const eei = lab.surface.create_entity({ name: "electric-energy-interface", position: p(-6, 0), force: f })!
      eei.electric_buffer_size = 1e9
      eei.power_production = 1e7
      lab.surface.create_entity({ name: "medium-electric-pole", position: p(-4, 2), force: f })
      const port = lab.surface.create_entity({ name: "roboport", position: p(0, 0), force: f })!
      port.get_inventory(defines.inventory.roboport_robot)!.insert({ name: "construction-robot", count: 10 })
      const chest = lab.surface.create_entity({ name: "storage-chest", position: p(3.5, 3.5), force: f })!
      chest.insert({ name: "transport-belt", count: 20 })
      chest.insert({ name: "iron-chest", count: 2 })
      const ghosts: LuaEntity[] = []
      for (let x = -5; x < 5; x++) ghosts.push(lab.surface.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: p(x + 0.5, 10.5), force: f })!)
      ghosts.push(lab.surface.create_entity({ name: "entity-ghost", inner_name: "iron-chest", position: p(6.5, 12.5), force: f })!)
      const tree = lab.surface.create_entity({ name: "tree-01", position: p(-8, 14) })!
      tree.order_deconstruction(f)
      return { ghosts, tree }
    }
    const np = scene(npf, -22)
    const pl = scene(game.forces.player, 22)
    const count = (sc: { ghosts: LuaEntity[] }): number => sc.ghosts.filter((g) => !g.valid).length
    async(3600 * 2)
    const start = game.tick
    on_tick(() => {
      const t = game.tick - start
      if (t % 600 === 0) log(`[m7d-net] ${t / 60}s: player-less built ${count(np)}/11 tree ${np.tree.valid ? "standing" : "gone"}; player built ${count(pl)}/11 tree ${pl.tree.valid ? "standing" : "gone"}`)
      const finished = count(np) === 11 && !np.tree.valid
      if (!finished && t < 3600 * 2 - 10) return
      assert(count(pl) === 11 && !pl.tree.valid, `the scene works for the player force (${count(pl)}/11, tree ${pl.tree.valid})`)
      assert(finished, `player-less force: robots built ${count(np)}/11 ghosts, tree ${np.tree.valid ? "standing" : "gone"}`)
      done()
      return false
    })
  })

  test("M7d (P48): a player-less character's personal roboport builds ghosts from its inventory", () => {
    const lab = createLab(48)
    const npf = game.forces["m7d-personal"] ?? game.create_force("m7d-personal")
    const scene = (f: LuaForce, ox: number): { ghosts: LuaEntity[]; ch: LuaEntity; tree: LuaEntity } => {
      const p = (dx: number, dy: number): MapPosition => at(lab, ox + dx, dy)
      const ch = lab.surface.create_entity({ name: "character", position: p(0, 0), force: f })!
      const armor = ch.get_inventory(defines.inventory.character_armor)!
      armor.insert({ name: "modular-armor" })
      const grid = armor[0].grid!
      grid.put({ name: "personal-roboport-equipment" })
      grid.put({ name: "battery-equipment" })
      ch.get_main_inventory()!.insert({ name: "construction-robot", count: 10 })
      ch.get_main_inventory()!.insert({ name: "transport-belt", count: 20 })
      const ghosts: LuaEntity[] = []
      for (let x = -4; x < 4; x++) ghosts.push(lab.surface.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: p(x + 0.5, 6.5), force: f })!)
      const tree = lab.surface.create_entity({ name: "tree-01", position: p(-6, -6) })!
      tree.order_deconstruction(f)
      return { ghosts, ch, tree }
    }
    const np = scene(npf, -22)
    const pl = scene(game.forces.player, 22)
    const charge = (ch: LuaEntity): void => {
      const grid = ch.get_inventory(defines.inventory.character_armor)![0].grid!
      for (const e of grid.equipment) e.energy = e.max_energy
    }
    const count = (sc: { ghosts: LuaEntity[] }): number => sc.ghosts.filter((g) => !g.valid).length
    async(3600 * 2)
    const start = game.tick
    on_tick(() => {
      const t = game.tick - start
      charge(np.ch)
      charge(pl.ch)
      if (t % 600 === 0) log(`[m7d-personal] ${t / 60}s: player-less built ${count(np)}/8 tree ${np.tree.valid ? "standing" : "gone"} robots in inventory ${np.ch.get_main_inventory()!.get_item_count("construction-robot")}; player built ${count(pl)}/8 tree ${pl.tree.valid ? "standing" : "gone"}`)
      const finished = count(np) === 8 && !np.tree.valid
      if (!finished && t < 3600 * 2 - 10) return
      assert(count(pl) === 8 && !pl.tree.valid, `the scene works for the player force (${count(pl)}/8, tree ${pl.tree.valid})`)
      assert(finished, `player-less character: personal robots built ${count(np)}/8 ghosts, tree ${np.tree.valid ? "standing" : "gone"}`)
      done()
      return false
    })
  })

  test("D62 finding: a player-less force's radar still sector-scans (events fire) but charts and generates nothing, even through force.chart", () => {
    async(3600 * 4)
    const surface = game.create_surface("d62-diag", { seed: 4242, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
    const npf = game.forces["d62-diag"] ?? game.create_force("d62-diag")
    const pf = game.forces.player
    const scans: Record<string, number> = {}
    const scanDist: Record<string, number[]> = {}
    const charted: Record<string, number> = {}
    // Restored afterwards: the mod handles on_sector_scanned itself (P43 (a)).
    const modScan = script.get_event_handler(defines.events.on_sector_scanned)
    const modCharted = script.get_event_handler(defines.events.on_chunk_charted)
    script.on_event(defines.events.on_sector_scanned, (e) => {
      const f = e.radar.force.name
      scans[f] = (scans[f] ?? 0) + 1
      const r = e.radar.position
      const d = math.max(math.abs(e.chunk_position.x - math.floor(r.x / 32)), math.abs(e.chunk_position.y - math.floor(r.y / 32)))
      ;(scanDist[f] ??= []).push(d)
    })
    script.on_event(defines.events.on_chunk_charted, (e) => {
      if (e.surface_index !== surface.index) return
      charted[e.force.name] = (charted[e.force.name] ?? 0) + 1
    })
    const setUp = (pos: MapPosition, f: LuaForce): LuaEntity => {
      surface.request_to_generate_chunks(pos, 0)
      surface.force_generate_chunk_requests()
      for (const e of surface.find_entities_filtered({ area: [[pos.x - 6, pos.y - 6], [pos.x + 6, pos.y + 6]] })) if (e.type !== "resource") e.destroy()
      const radar = surface.create_entity({ name: "radar", position: pos, force: f })!
      const eei = surface.create_entity({ name: "electric-energy-interface", position: { x: pos.x + 4, y: pos.y }, force: f })!
      eei.electric_buffer_size = 1e8
      eei.power_production = 1e6
      surface.create_entity({ name: "small-electric-pole", position: { x: pos.x + 2, y: pos.y - 1 }, force: f })
      return radar
    }
    const a = { x: 1600.5, y: 1600.5 }
    const b = { x: 1920.5, y: 1600.5 }
    setUp(a, npf)
    setUp(b, pf)
    const count = (f: LuaForce, pos: MapPosition, what: string): number => {
      let n = 0
      const cx = math.floor(pos.x / 32)
      const cy = math.floor(pos.y / 32)
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const c = { x: cx + dx, y: cy + dy }
          if (what === "charted" && f.is_chunk_charted(surface, c)) n++
          if (what === "requested" && f.is_chunk_requested_for_charting(surface, c)) n++
          if (what === "generated" && surface.is_chunk_generated(c)) n++
          if (what === "visible" && f.is_chunk_visible(surface, c)) n++
        }
      }
      return n
    }
    const report = (label: string): void => {
      for (const [f, pos] of [[npf, a], [pf, b]] as [LuaForce, MapPosition][]) {
        log(`[d62] ${label} ${f.name}: charted ${count(f, pos, "charted")} requested ${count(f, pos, "requested")} visible ${count(f, pos, "visible")} generated ${count(f, pos, "generated")}/49; sector scans ${scans[f.name] ?? 0} at rings ${(scanDist[f.name] ?? []).join(",")}; chunk_charted events ${charted[f.name] ?? 0}`)
      }
    }
    after_ticks(600, () => report("10s"))
    after_ticks(3600 * 3, () => {
      report("3min")
      // 10 MJ per sector at 300 kW: one scan about every 33 s, for either force.
      assert((scans[npf.name] ?? 0) >= 4, `player-less radar sector-scans: ${scans[npf.name] ?? 0} events`)
      assert(count(npf, a, "charted") === 0 && count(npf, a, "requested") > 0, "player-less: scanned chunks are requested for charting, never charted")
      assert(count(npf, a, "generated") === 1, "player-less: the radar generates nothing")
      assert(count(pf, b, "charted") === 49 && count(pf, b, "generated") === 49, "player force: nearby square charted and generated")
      // A script chart of the player-less force's nearby square.
      npf.chart(surface, [[a.x - 112, a.y - 112], [a.x + 112, a.y + 112]])
    })
    after_ticks(3600 * 3 + 300, () => {
      report("after force.chart")
      assert(count(npf, a, "charted") === 0 && count(npf, a, "requested") === 49, "player-less: force.chart only requests")
      script.on_event(defines.events.on_sector_scanned, modScan as never)
      script.on_event(defines.events.on_chunk_charted, modCharted as never)
      game.delete_surface(surface)
      done()
    })
  })

  test("P43 (a): a faction radar's sector scan makes the chunk known ground for that faction's plans", () => {
    const lab = createLab()
    const force = game.forces["p43-scan"] ?? game.create_force("p43-scan")
    const radar = lab.surface.create_entity({ name: "radar", position: at(lab, 0.5, 0.5), force })!
    assert(script.get_event_handler(defines.events.on_sector_scanned) !== undefined, "the mod handles on_sector_scanned")
    // A stand-in faction, only for this synchronous call (tick handlers never see it).
    const name = "p43-test"
    const factions = storage.factions as Record<string, unknown>
    const factories = (storage.factories ??= {}) as Record<string, unknown>
    factions[name] = { force: force.name }
    factories[name] = {}
    storage.factionOrder.push(name)
    const chunk = { x: 7, y: -3 }
    onSectorScanned({ radar, chunk_position: chunk, area: { left_top: { x: 224, y: -96 }, right_bottom: { x: 256, y: -64 } }, name: defines.events.on_sector_scanned, tick: game.tick } as never)
    const got = (factories[name] as { radarChunks?: Record<number, boolean> }).radarChunks
    storage.factionOrder.pop()
    delete factions[name]
    delete factories[name]
    radar.destroy()
    assert(got?.[tkey(chunk.x, chunk.y)] === true, "scanned chunk recorded")
    const known = { home: { x: 0, y: 0, w: 64, h: 64 }, explored: [], scanned: got }
    assert(chunkKnown(chunk.x, chunk.y, known, () => false), "known to the planner")
    assert(!chunkKnown(chunk.x + 1, chunk.y, known, () => false), "its neighbour is not")
  })

  test("D62 finding: a powered radar charts for the player force but not for a force with no players", () => {
    const surface = game.create_surface("d62-radar", { seed: 4242, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
    const force = game.forces["d62-radar"] ?? game.create_force("d62-radar")
    const setUp = (pos: MapPosition, f: LuaForce): LuaEntity => {
      surface.request_to_generate_chunks(pos, 0)
      surface.force_generate_chunk_requests()
      for (const e of surface.find_entities_filtered({ area: [[pos.x - 6, pos.y - 6], [pos.x + 6, pos.y + 6]] })) if (e.type !== "resource") e.destroy()
      const radar = surface.create_entity({ name: "radar", position: pos, force: f })!
      const eei = surface.create_entity({ name: "electric-energy-interface", position: { x: pos.x + 4, y: pos.y }, force: f })!
      // A script-created interface makes nothing until told to.
      eei.electric_buffer_size = 1e8
      eei.power_production = 1e6
      surface.create_entity({ name: "small-electric-pole", position: { x: pos.x + 2, y: pos.y - 1 }, force: f })
      return radar
    }
    // Far from the surface's starting area: nothing generated there yet.
    const a = { x: 1600.5, y: 1600.5 }
    const b = { x: 1920.5, y: 1600.5 }
    const ra = setUp(a, force)
    setUp(b, game.forces.player)
    const charted = (f: LuaForce, pos: MapPosition): number => {
      let n = 0
      const cx = math.floor(pos.x / 32)
      const cy = math.floor(pos.y / 32)
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (f.is_chunk_charted(surface, { x: cx + dx, y: cy + dy })) n++
      return n
    }
    after_ticks(60, () => assert(ra.energy > 0, `radar powered (energy ${ra.energy})`))
    after_ticks(3600, () => {
      const p = charted(game.forces.player, b)
      const q = charted(force, a)
      log(`[d62] nearby square after 60 s: player force ${p}/49 charted, player-less force ${q}/49 (players: ${force.players.length})`)
      assert(p === 49, `the player force's radar charts its nearby square: ${p}/49`)
      // D62 depends on this: if it changes, faction radars chart by themselves and the emulation is not needed.
      assert(q === 0, `a player-less force's radar charted ${q}/49: the engine charts for it now`)
      game.delete_surface(surface)
    })
  })
})

// M7b (D73: crude is piped home from an oil field outside the starting area). How much a long 2.0 pipeline of
// pipe-to-ground pairs delivers, so the planner knows when a pump is needed. An offshore pump pushes water in at one end
// (flow does not depend on the fluid) and a storage tank at the other end, emptied every tick, counts what arrives.
describe("fluids", () => {
  function pipeline(surface: LuaSurface, y: number, length: number, pumpEvery = 0): { tank: LuaEntity; source: LuaEntity } {
    const tiles = []
    for (let x = -8; x <= length + 6; x++) for (let dy = -2; dy <= 2; dy++) tiles.push({ name: x < -1 ? "water" : "lab-dark-1", position: { x, y: y + dy } })
    surface.set_tiles(tiles)
    // An offshore pump pushes water like pumpjacks push crude (an infinity pipe sets its whole segment instead).
    const source = surface.create_entity({ name: "offshore-pump", position: { x: -1.5, y: y + 0.5 }, direction: defines.direction.west, force: "player" })!
    surface.create_entity({ name: "pipe", position: { x: -0.5, y: y + 0.5 }, force: "player" })
    surface.create_entity({ name: "pipe", position: { x: 0.5, y: y + 0.5 }, force: "player" })
    // Pairs: an entrance facing back toward the source, an exit 10 tiles on facing onward, then the next entrance.
    let x = 1
    let sincePump = 0
    while (x + 10 <= length) {
      if (pumpEvery > 0 && sincePump >= pumpEvery) {
        surface.create_entity({ name: "pump", position: { x: x + 1, y: y + 0.5 }, direction: defines.direction.east, force: "player" })
        const eei = surface.create_entity({ name: "electric-energy-interface", position: { x: x + 0.5, y: y - 2.5 }, force: "player" })!
        eei.electric_buffer_size = 1e7
        eei.power_production = 1e6
        surface.create_entity({ name: "small-electric-pole", position: { x: x + 1.5, y: y - 0.5 }, force: "player" })
        x += 2
        sincePump = 0
      }
      surface.create_entity({ name: "pipe-to-ground", position: { x: x + 0.5, y: y + 0.5 }, direction: defines.direction.west, force: "player" })
      surface.create_entity({ name: "pipe-to-ground", position: { x: x + 10.5, y: y + 0.5 }, direction: defines.direction.east, force: "player" })
      sincePump += 11
      x += 11
    }
    const tank = surface.create_entity({ name: "storage-tank", position: { x: x + 1, y: y + 1 }, force: "player" })!
    return { tank, source }
  }

  function crude(tank: LuaEntity): number {
    return tank.get_fluid_contents()["water"] ?? 0
  }

  test("M7b: a generated pumpjack field on real wells delivers its declared crude at its pipe-out port", () => {
    async(3600 * 2)
    const surface = game.create_surface("m7b-field", { seed: 2, width: 200, height: 200, autoplace_controls: {} } as never)
    surface.request_to_generate_chunks({ x: 0, y: 0 }, 2)
    surface.force_generate_chunk_requests()
    const tiles = []
    for (let x = -40; x < 40; x++) for (let y = -40; y < 40; y++) tiles.push({ name: "lab-dark-1", position: { x, y } })
    surface.set_tiles(tiles)
    // Wells at 100% (the prototype's normal amount): 10 crude/s each.
    const normal = prototypes.entity["crude-oil"].normal_resource_amount
    const wells = [
      { x: -10, y: -10 },
      { x: -4, y: -9 },
      { x: -8, y: -3 },
    ]
    for (const w of wells) surface.create_entity({ name: "crude-oil", position: { x: w.x + 0.5, y: w.y + 0.5 }, amount: normal })
    const def = generatedModule("pumpjack-field", { wells: encodeWells(wells.map((w) => ({ ...w, perSecond: 10 }))) })
    const ox = -10 - 3
    const oy = -10 - 3
    const placed = stampModule(surface, "player", def, { x: ox, y: oy })
    let missing = 0
    for (let i = 0; i < def.entities.length; i++) if (placed[i] === undefined) missing++
    assert(missing === 0, `${missing} entities could not be placed`)
    const port = def.ports.find((p) => p.kind === "pipe-out")!
    // A pump on the port's outside tiles starts a separate segment; the pipe after it is drained and counted every tick.
    const px = ox + math.floor(port.pos.x)
    const py = oy + math.floor(port.pos.y)
    surface.create_entity({ name: "pump", position: { x: px + 2, y: py + 0.5 }, direction: defines.direction.east, force: "player" })
    const tank = surface.create_entity({ name: "pipe", position: { x: px + 3.5, y: py + 0.5 }, force: "player" })!
    surface.create_entity({ name: "small-electric-pole", position: { x: px + 1.5, y: py - 0.5 }, force: "player" })
    const eei2 = surface.create_entity({ name: "electric-energy-interface", position: { x: px + 1, y: py - 2 }, force: "player" })!
    eei2.electric_buffer_size = 1e7
    eei2.power_production = 1e6
    const powerPort = def.ports.find((p) => p.kind === "power")!
    const eei = surface.create_entity({ name: "electric-energy-interface", position: { x: ox + powerPort.pos.x, y: oy - 3 }, force: "player" })!
    eei.electric_buffer_size = 1e8
    eei.power_production = 1e7
    surface.create_entity({ name: "small-electric-pole", position: { x: ox + powerPort.pos.x, y: oy - 1.5 }, force: "player" })
    const start = game.tick
    let got = 0
    on_tick(() => {
      const t = game.tick - start
      if (t > 600) got += tank.get_fluid_contents()["crude-oil"] ?? 0
      tank.clear_fluid_inside()
      if (t < 1800) return true
      const rate = got / 20
      const declared = rateOf(def.rates.outputs, "crude-oil")
      log(`[m7b] pumpjack field: ${string.format("%.2f", rate)} crude/s measured, ${declared} declared`)
      assert(rate >= 0.9 * declared, `pumpjack field delivers ${rate}/s of ${declared}/s`)
      game.delete_surface(surface)
      done()
      return false
    })
  })

  test("M7b finding: fluid flow through a long pipe-to-ground pipeline (pumps, tank at the end)", () => {
    async(3600 * 2)
    const surface = game.create_surface("m7b-pipes", { seed: 1, width: 4000, height: 400, autoplace_controls: {} } as never)
    surface.request_to_generate_chunks({ x: 0, y: 0 }, 1)
    surface.force_generate_chunk_requests()
    const lengths = [22, 110, 308, 330, 1100, 2200]
    const runs: { length: number; pump: boolean; tank: LuaEntity }[] = []
    let row = 0
    for (const length of lengths) {
      for (const pump of [false, true]) {
        if (pump && length < 300) continue
        for (let cx = 0; cx * 32 < length + 40; cx++) surface.request_to_generate_chunks({ x: cx * 32, y: row * 8 }, 0)
        surface.force_generate_chunk_requests()
        runs.push({ length, pump, tank: pipeline(surface, row * 8, length, pump ? 220 : 0).tank })
        row++
      }
    }
    const start = game.tick
    // The tank is emptied every tick and what arrived is counted (a full tank would read as no flow).
    const got: number[] = runs.map(() => 0)
    on_tick(() => {
      const t = game.tick - start
      for (let i = 0; i < runs.length; i++) {
        if (t > 600) got[i] += crude(runs[i].tank)
        runs[i].tank.clear_fluid_inside()
      }
      if (t < 900) return true
      const lines: string[] = []
      const rates: number[] = []
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]
        rates.push(got[i] / 5)
        lines.push(`${r.length} tiles${r.pump ? " (pump every 220)" : ""}: ${string.format("%.1f", got[i] / 5)}/s`)
      }
      log(`[m7b] fluid through pipe-to-ground pipelines (offshore pump source): ${lines.join("; ")}`)
      // 2.0 fluid segments longer than the pipeline extent (utility constant `default_pipeline_extent`, 320) carry
      // nothing; a pump starts a new segment. So a long crude line needs a pump at least every extent. The blue chain
      // needs about 42 crude/s (3 refineries on basic oil processing).
      const extent = (prototypes.utility_constants as unknown as { default_pipeline_extent?: number }).default_pipeline_extent
      log(`[m7b] default_pipeline_extent ${extent}`)
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]
        if (r.pump || r.length <= (extent ?? 320)) assert(rates[i] > 42, `a pipeline within the extent (or pumped) carries the blue chain's crude (${lines[i]})`)
        else assert(rates[i] === 0, `a segment longer than the extent carries nothing (${lines[i]}): the engine changed`)
      }
      game.delete_surface(surface)
      done()
      return false
    })
  })
})

describe("ghosts", () => {
  // B173 (m7-benchLayers15 g216): unlike a pole (B41/B66), a belt ghost is refused on its live twin, and on a belt facing
  // another way. A route piece that already stands as planned must be reused, not ghosted (`stampParts`).
  test("B173 finding: a belt ghost is refused on a live belt, its twin included; a pole ghost is accepted", () => {
    const lab = createLab(16)
    const s = lab.surface
    const ghostOn = (x: number, live: string, liveDir: defines.direction, ghostDir: defines.direction): boolean => {
      const pos = at(lab, x + 0.5, 0.5)
      s.create_entity({ name: live, position: pos, direction: liveDir, force: "player" })
      return s.create_entity({ name: "entity-ghost", inner_name: live, position: pos, direction: ghostDir, force: "player" }) !== undefined
    }
    assert(!ghostOn(0, "transport-belt", defines.direction.west, defines.direction.west), "a belt ghost on its live twin is refused")
    assert(!ghostOn(2, "transport-belt", defines.direction.north, defines.direction.west), "a belt ghost on a belt facing another way is refused")
    assert(ghostOn(4, "small-electric-pole", defines.direction.north, defines.direction.north), "a pole ghost on its live pole is accepted")
  })
})
