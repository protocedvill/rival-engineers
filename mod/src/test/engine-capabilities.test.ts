import { LuaEntity, LuaForce, MapPosition } from "factorio:runtime"
import { PathfinderWaypoint } from "factorio:runtime"
import { forgetPathRequest, getPathRequest, requestCharacterPath } from "../character/pathing"
import { tkey } from "../planner/grid"
import { chunkKnown } from "../strategy/arms"
import { onSectorScanned } from "../strategy/explore"
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
