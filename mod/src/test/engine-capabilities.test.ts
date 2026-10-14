import { forgetPathRequest, getPathRequest, requestCharacterPath } from "../character/pathing"
import { at, createLab, everyTickFor, itemCount, spawnEngineer } from "./lab"

// M0 spike: can a character entity with NO attached player perform every player action the crew
// needs, using player-equivalent APIs (SPEC §5.1)? These tests pin those engine assumptions so a
// Factorio update that breaks them fails CI instead of silently breaking the AI.

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
      lab.surface.create_entity({ name: "stone-wall", position: at(lab, 0, y), force: "neutral" })
    }
    const id = requestCharacterPath(character, at(lab, 10, 0))
    async(600)
    on_tick(() => {
      const req = getPathRequest(id)!
      if (req.status === "pending") return
      assert(req.status === "found", `path status ${req.status}`)
      assert(req.path!.length > 2, "path has waypoints")
      forgetPathRequest(id)
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
})
