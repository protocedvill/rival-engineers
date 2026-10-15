import { LuaEntity, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import {
  cancel,
  createController,
  destroyController,
  enqueue,
  getAction,
  isIdle,
  setControllerProfiler,
} from "../character/controller"
import { distance } from "../character/steering"
import { ActionRecord } from "../character/types"
import { at, createLab, itemCount, Lab, spawnEngineer } from "./lab"

// M1 acceptance (SPEC §8): the Character Controller drives a player-less character through every
// action at real player speed. Debug parity toggles stay off: every test asserts that.

/** Waits (async) until the action finishes, then runs `check` on its record. */
function awaitAction(actionId: number, timeout: number, check: (action: ActionRecord) => void): void {
  async(timeout)
  on_tick(() => {
    const action = getAction(actionId)!
    if (action.status === "queued" || action.status === "running") return
    check(action)
    done()
  })
}

function describeAction(a: ActionRecord): string {
  return `${a.spec.kind} #${a.id}: ${a.status} ${a.reason ?? ""} ${a.detail ?? ""} (repaths ${a.stats.repaths}, items ${a.stats.items})`
}

function wall(lab: Lab, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) lab.surface.create_entity({ name: "stone-wall", position: at(lab, x + 0.5, y + 0.5), force: "neutral" })
}

function hwall(lab: Lab, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) lab.surface.create_entity({ name: "stone-wall", position: at(lab, x + 0.5, y + 0.5), force: "neutral" })
}

function orePatch(lab: Lab, x0: number, y0: number, w: number, h: number, amount: number): void {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) lab.surface.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount })
  }
}

function dumpFrame(lab: Lab, name: string): void {
  remote.call("rival-engineers", "dump_entities", `rival-engineers/${name}.json`, lab.origin, lab.radius)
}

describe("character controller", () => {
  before_each(() => {
    for (const id of [...storage.controllerOrder]) destroyController(id)
    clearConfigOverrides()
    const config = getConfig()
    assert(
      !config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1,
      "debug parity toggles must be off in acceptance tests",
    )
  })

  test("walks 200 tiles through a wall maze and arrives", () => {
    const lab = createLab(112)
    // A walled box 216 x 81 with five staggered inner walls: the route snakes up and down.
    hwall(lab, -41, -108, 108)
    hwall(lab, 41, -108, 108)
    wall(lab, -109, -41, 41)
    wall(lab, 109, -41, 41)
    wall(lab, -66, -40, 30)
    wall(lab, -33, -30, 40)
    wall(lab, 0, -40, 30)
    wall(lab, 33, -30, 40)
    wall(lab, 66, -40, 30)
    const character = spawnEngineer(lab, -100, 0)
    const goal = at(lab, 100, 0)
    const id = enqueue(createController(character), { kind: "walk", goal })
    const profiler = helpers.create_profiler(true)
    setControllerProfiler(profiler)
    let frame = 0
    on_tick((tick) => {
      if (tick % 60 === 0) dumpFrame(lab, `m1-maze/frame-${string.format("%03d", frame++)}`)
    })
    awaitAction(id, 20000, (a) => {
      setControllerProfiler(undefined)
      dumpFrame(lab, `m1-maze/frame-${string.format("%03d", frame++)}`)
      assert(a.status === "succeeded", describeAction(a))
      assert(distance(character.position, goal) <= 1, "at the goal")
      const ticks = a.finishedTick! - a.startedTick!
      log([
        "",
        `[m1] maze walk: straight-line 200 tiles, path ${math.floor(a.stats.pathTiles)} tiles, ${ticks} ticks `,
        `(walking ${a.stats.walkTicks}), repaths ${a.stats.repaths}; controller time: total `,
        profiler,
      ])
      profiler.divide(ticks)
      log(["", "[m1] maze walk: controller time per tick ", profiler])
      // Real running speed is 0.15 tiles/tick, so the walk can't beat the path length / 0.15.
      assert(a.stats.walkTicks >= a.stats.pathTiles / 0.16, "no faster than a player")
    })
  })

  test("stuck recovery: re-paths around a wall dropped onto its route", () => {
    const lab = createLab(48)
    const character = spawnEngineer(lab, -30, 0)
    const goal = at(lab, 30, 0)
    const id = enqueue(createController(character), { kind: "walk", goal })
    let dropped = false
    on_tick(() => {
      const a = getAction(id)!
      if (!dropped && a.walk?.phase === "follow" && character.position.x > lab.origin.x - 25) {
        // Box in the route: a 13-tile wall straight across the path, 25 tiles ahead.
        wall(lab, 0, -6, 6)
        dropped = true
      }
    })
    awaitAction(id, 3000, (a) => {
      assert(dropped, "obstacle was dropped mid-walk")
      assert(a.status === "succeeded", describeAction(a))
      assert(a.stats.repaths >= 1, `re-pathed ${a.stats.repaths} times`)
      log(`[m1] stuck recovery: ${a.finishedTick! - a.startedTick!} ticks, repaths ${a.stats.repaths}`)
    })
  })

  test("steps out of a gap between machines that the pathfinder can't start from", () => {
    // Seen in a soak: a crew member stood in the 0.6-tile gap between the collision boxes of two burner drills
    // of a coal pair (one tile apart) when they were built. The pathfinder finds no path from there, though the
    // character fits and can walk out. Like a player, the walker steps to a free spot and asks again.
    const lab = createLab(24)
    const character = spawnEngineer(lab, 0.375, 0.94)
    lab.surface.create_entity({ name: "burner-mining-drill", position: at(lab, 1, 0), direction: defines.direction.south, force: "player" })
    lab.surface.create_entity({ name: "burner-mining-drill", position: at(lab, 1, 2), direction: defines.direction.north, force: "player" })
    const id = enqueue(createController(character), { kind: "walk", goal: at(lab, -15, 0.5) })
    awaitAction(id, 1200, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      log(`[m3] escaped the drill gap and arrived in ${a.finishedTick! - a.startedTick!} ticks`)
    })
  })

  test("fails with no-path when the goal is walled in", () => {
    const lab = createLab(32)
    const character = spawnEngineer(lab, -15, 0)
    hwall(lab, -4, 6, 14)
    hwall(lab, 4, 6, 14)
    wall(lab, 6, -3, 3)
    wall(lab, 14, -3, 3)
    const id = enqueue(createController(character), { kind: "walk", goal: at(lab, 10.5, 0.5) })
    awaitAction(id, 3000, (a) => {
      assert(a.status === "failed" && a.reason === "no-path", describeAction(a))
    })
  })

  test("mines 50 iron ore", () => {
    const lab = createLab(16)
    orePatch(lab, 6, -1, 3, 3, 1000)
    const character = spawnEngineer(lab)
    const id = enqueue(createController(character), { kind: "mine", position: at(lab, 7.5, 0.5), count: 50 })
    awaitAction(id, 7000, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(itemCount(character, "iron-ore") === 50, `have ${itemCount(character, "iron-ore")}`)
      const ticks = a.finishedTick! - a.startedTick!
      log(`[m1] mined 50 iron ore in ${ticks} ticks (${a.stats.walkTicks} walking)`)
      // Hand mining is 2 s (120 ticks) per ore.
      assert(ticks >= 50 * 118, "real mining speed")
    })
  })

  test("mining stops when the resource is depleted", () => {
    const lab = createLab(16)
    lab.surface.create_entity({ name: "iron-ore", position: at(lab, 2.5, 0.5), amount: 3 })
    const character = spawnEngineer(lab)
    const id = enqueue(createController(character), { kind: "mine", position: at(lab, 2.5, 0.5), count: 10 })
    awaitAction(id, 1000, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(a.stats.items === 3 && itemCount(character, "iron-ore") === 3, describeAction(a))
    })
  })

  test("mines a tree 8 tiles away: trees use the short mining reach, not reach_distance", () => {
    const lab = createLab(16)
    const tree = lab.surface.create_entity({ name: "tree-01", position: at(lab, -8.5, 0.5) })!
    const character = spawnEngineer(lab)
    character.teleport(at(lab, -3.5, 0.5))
    assert(!character.can_reach_entity(tree), "a tree 5 tiles away is out of reach (reach_distance is 10)")
    character.teleport(at(lab, 0, 0))
    const id = enqueue(createController(character), { kind: "mine", target: tree })
    awaitAction(id, 600, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(!tree.valid && itemCount(character, "wood") > 0, "tree mined into wood")
    })
  })

  test("won't hand-mine ore under a built belt (mining there would pick the belt up)", () => {
    // Seed 77: a mine job planned before the ore route was built ran after it, picked up two of its belts, and the
    // smelters it fed starved for good.
    const lab = createLab(16)
    orePatch(lab, 2, 0, 1, 1, 50)
    const ore = lab.surface.find_entities_filtered({ type: "resource", position: at(lab, 2.5, 0.5) })[0]
    const belt = lab.surface.create_entity({ name: "transport-belt", position: at(lab, 2.5, 0.5), force: "player" })!
    const character = spawnEngineer(lab)
    const id = enqueue(createController(character), { kind: "mine", target: ore, count: 3 })
    awaitAction(id, 600, (a) => {
      assert(a.status === "failed" && a.reason === "not-minable", describeAction(a))
      assert(belt.valid, "the belt is still there")
      assert(itemCount(character, "transport-belt") === 0, "no belt picked up")
    })
  })

  test("hand-mines ore under a tree (the tree is mined first, as by a player)", () => {
    // The refusal above is for built entities only: a tree whose box covers an ore tile (seed 555555's coal) must not
    // make the tile unminable.
    const lab = createLab(16)
    orePatch(lab, 2, 0, 1, 1, 50)
    const ore = lab.surface.find_entities_filtered({ type: "resource", position: at(lab, 2.5, 0.5) })[0]
    lab.surface.create_entity({ name: "tree-01", position: at(lab, 2.7, 0.8) })
    const character = spawnEngineer(lab)
    const id = enqueue(createController(character), { kind: "mine", target: ore, count: 3 })
    awaitAction(id, 1200, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(itemCount(character, "iron-ore") >= 3, "ore mined")
    })
  })

  test("mines a big rock boxed in by another rock and buildings (seed 3333 neighbourhood)", () => {
    // The M5a seed-3333 stall: a big rock off the tile grid, a second rock north of it and burner sites east. Walking
    // to within the short reach of its centre failed ("no path": every end node next to the rock collides with it),
    // so its clear job failed and the outpost ghosts on it were never placed. The walk now aims at its box.
    const lab = createLab(16)
    const rock = lab.surface.create_entity({ name: "big-rock", position: at(lab, 0.375, 0.5) })!
    lab.surface.create_entity({ name: "big-rock", position: at(lab, 1.75, -1.9375) })
    lab.surface.create_entity({ name: "burner-mining-drill", position: at(lab, 4, -3), force: "player" })
    lab.surface.create_entity({ name: "burner-mining-drill", position: at(lab, 4, 0), direction: defines.direction.south, force: "player" })
    lab.surface.create_entity({ name: "stone-furnace", position: at(lab, 4, 2), force: "player" })
    lab.surface.create_entity({ name: "electric-mining-drill", position: at(lab, -1.5, 5.5), force: "player" })
    lab.surface.create_entity({ name: "entity-ghost", inner_name: "electric-mining-drill", position: at(lab, -1.5, 2.5), force: "player" })
    lab.surface.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: at(lab, 0.5, 1.5), force: "player" })
    const character = spawnEngineer(lab, -8, -6)
    const id = enqueue(createController(character), { kind: "mine", target: rock })
    awaitAction(id, 1200, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(!rock.valid, "rock mined")
    })
  })

  test("crafts 10 gears at real speed", () => {
    const lab = createLab(8)
    const character = spawnEngineer(lab)
    character.insert({ name: "iron-plate", count: 20 })
    const id = enqueue(createController(character), { kind: "craft", recipe: "iron-gear-wheel", count: 10 })
    awaitAction(id, 600, (a) => {
      assert(a.status === "succeeded", describeAction(a))
      assert(itemCount(character, "iron-gear-wheel") === 10)
      assert(itemCount(character, "iron-plate") === 0)
      const ticks = a.finishedTick! - a.startedTick!
      log(`[m1] crafted 10 gears in ${ticks} ticks`)
      assert(ticks >= 295, "0.5 s per gear")
    })
  })

  test("craft fails cleanly without ingredients", () => {
    const lab = createLab(8)
    const character = spawnEngineer(lab)
    character.insert({ name: "iron-plate", count: 5 })
    const ctrl = createController(character)
    const id = enqueue(ctrl, { kind: "craft", recipe: "iron-gear-wheel", count: 10 })
    awaitAction(id, 60, (a) => {
      assert(a.status === "failed" && a.reason === "missing-ingredients", describeAction(a))
      assert(itemCount(character, "iron-plate") === 5, "nothing consumed")
      assert(character.crafting_queue_size === 0, "nothing queued")
      assert(isIdle(ctrl))
    })
  })

  describe("burner drill", () => {
    let lab: Lab
    let character: LuaEntity
    let ctrl: number
    let drill: LuaEntity
    test("is placed on ore and fuelled with coal, then mines", () => {
      lab = createLab(32)
      orePatch(lab, 18, -2, 4, 4, 500)
      character = spawnEngineer(lab, -10, 0)
      character.insert({ name: "burner-mining-drill", count: 1 })
      character.insert({ name: "wooden-chest", count: 1 })
      character.insert({ name: "coal", count: 10 })
      ctrl = createController(character)
      const id = enqueue(ctrl, { kind: "place", item: "burner-mining-drill", position: at(lab, 20, 0), direction: defines.direction.east })
      awaitAction(id, 600, (a) => {
        assert(a.status === "succeeded", describeAction(a))
        drill = a.placed!
        assert(drill.valid && drill.name === "burner-mining-drill")
        assert(itemCount(character, "burner-mining-drill") === 0, "item consumed")
        assert(distance(character.position, drill.position) <= character.build_distance, "placed from within reach")
      })
    })
      .step(() => {
        // Catch the output in a chest, then fuel the drill.
        const drop = drill.drop_position
        enqueue(ctrl, { kind: "place", item: "wooden-chest", position: { x: math.floor(drop.x) + 0.5, y: math.floor(drop.y) + 0.5 } })
        const id = enqueue(ctrl, { kind: "insert", entity: drill, item: "coal", count: 5 })
        awaitAction(id, 600, (a) => {
          assert(a.status === "succeeded", describeAction(a))
          assert(drill.get_fuel_inventory()!.get_item_count("coal") === 5, "fuelled")
          assert(itemCount(character, "coal") === 5)
        })
      })
      .step(() => {
        after_ticks(600, () => {
          // Burner drill: 0.25 ore/s, so ~2 ore in 10 s.
          const chest = lab.surface.find_entities_filtered({ name: "wooden-chest", area: [at(lab, 18, -4), at(lab, 26, 4)] })[0]
          assert(chest, "chest placed at the drill's output")
          const ore = chest.get_item_count("iron-ore")
          log(`[m1] burner drill mined ${ore} ore in 600 ticks`)
          assert(ore >= 1, `drill output ${ore}`)
        })
      })
  })

  test("insert, take and pick up a chest", () => {
    const lab = createLab(24)
    const character = spawnEngineer(lab)
    character.insert({ name: "coal", count: 10 })
    const chest = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 18.5, 0.5), force: "player" })!
    const ctrl = createController(character)
    const ins = enqueue(ctrl, { kind: "insert", entity: chest, item: "coal", count: 10 })
    const take = enqueue(ctrl, { kind: "take", entity: chest, item: "coal", count: 4 })
    const tooMuch = enqueue(ctrl, { kind: "take", entity: chest, item: "coal", count: 50 })
    const pick = enqueue(ctrl, { kind: "pickUp", entity: chest })
    awaitAction(pick, 1200, (a) => {
      assert(getAction(ins)!.status === "succeeded", describeAction(getAction(ins)!))
      assert(getAction(take)!.status === "succeeded", describeAction(getAction(take)!))
      const t = getAction(tooMuch)!
      assert(t.status === "failed" && t.reason === "not-enough", describeAction(t))
      assert(a.status === "succeeded", describeAction(a))
      assert(!chest.valid, "chest mined")
      assert(itemCount(character, "wooden-chest") === 1, "chest returned")
      assert(itemCount(character, "coal") === 10, "contents returned with the chest")
    })
  })

  test("take with allowPartial grabs what is there; strict take still fails", () => {
    const lab = createLab(16)
    const character = spawnEngineer(lab)
    const chest = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 6.5, 0.5), force: "player" })!
    chest.insert({ name: "coal", count: 3 })
    const ctrl = createController(character)
    const strict = enqueue(ctrl, { kind: "take", entity: chest, item: "coal", count: 10 })
    const partial = enqueue(ctrl, { kind: "take", entity: chest, item: "coal", count: 10, allowPartial: true })
    const empty = enqueue(ctrl, { kind: "take", entity: chest, item: "coal", count: 10, allowPartial: true })
    awaitAction(empty, 600, (a) => {
      const s = getAction(strict)!
      assert(s.status === "failed" && s.reason === "not-enough", describeAction(s))
      const p = getAction(partial)!
      assert(p.status === "succeeded" && p.stats.items === 3, describeAction(p))
      assert(itemCount(character, "coal") === 3 && chest.get_item_count("coal") === 0)
      assert(a.status === "failed" && a.reason === "not-enough", `nothing left: ${describeAction(a)}`)
    })
  })

  test("cancelling a craft cancels its queued crafts and returns the ingredients", () => {
    const lab = createLab(8)
    const character = spawnEngineer(lab)
    character.insert({ name: "iron-plate", count: 20 })
    const id = enqueue(createController(character), { kind: "craft", recipe: "iron-gear-wheel", count: 10 })
    after_ticks(70, () => {
      assert(getAction(id)!.status === "running" && character.crafting_queue_size > 0, "crafting")
      assert(cancel(id))
      assert(character.crafting_queue_size === 0, "crafting queue emptied")
      const gears = itemCount(character, "iron-gear-wheel")
      assert(gears >= 1 && gears < 10, `crafted ${gears} before the cancel`)
      assert(itemCount(character, "iron-plate") === 20 - 2 * gears, `plates returned: ${itemCount(character, "iron-plate")}`)
    })
  })

  test("fills a ghost under player rules: the build check passes over it, and the ghost becomes the entity", () => {
    const lab = createLab(16)
    const character = spawnEngineer(lab)
    character.insert({ name: "inserter", count: 2 })
    const make = (x: number) =>
      lab.surface.create_entity({ name: "entity-ghost", inner_name: "inserter", position: at(lab, x, 0.5), direction: defines.direction.east, force: "player" })!
    const ghost = make(4.5)
    // An obstacle first: script-creating an entity on a ghost would remove the ghost.
    lab.surface.create_entity({ name: "stone-wall", position: at(lab, 6.5, 0.5), force: "neutral" })
    const blockedGhost = make(6.5)
    assert(character.can_place_entity({ name: "inserter", position: ghost.position, direction: defines.direction.east }), "a ghost does not block the player's build check")
    const ctrl = createController(character)
    const ok = enqueue(ctrl, { kind: "place", item: "inserter", position: ghost.position, direction: defines.direction.east, ghost })
    const blocked = enqueue(ctrl, { kind: "place", item: "inserter", position: blockedGhost.position, direction: defines.direction.east, ghost: blockedGhost })
    awaitAction(blocked, 300, (b) => {
      const a = getAction(ok)!
      assert(a.status === "succeeded", describeAction(a))
      assert(!ghost.valid && a.placed!.valid && a.placed!.name === "inserter" && a.placed!.direction === defines.direction.east, "ghost revived as the entity")
      assert(b.status === "failed" && b.reason === "cannot-place", describeAction(b))
      assert(blockedGhost.valid, "a failed fill leaves the ghost")
      assert(itemCount(character, "inserter") === 1, "only the placed item was used")
    })
  })

  test("cancel stops a walk and the queue moves on", () => {
    const lab = createLab(32)
    const character = spawnEngineer(lab, -20, 0)
    character.insert({ name: "iron-plate", count: 2 })
    const ctrl = createController(character)
    const walk = enqueue(ctrl, { kind: "walk", goal: at(lab, 20, 0) })
    const craft = enqueue(ctrl, { kind: "craft", recipe: "iron-gear-wheel", count: 1 })
    let x = 0
    after_ticks(60, () => {
      assert(getAction(walk)!.status === "running")
      assert(cancel(walk))
      assert(getAction(walk)!.status === "cancelled")
      x = character.position.x
    })
    after_ticks(70, () => {
      assert(math.abs(character.position.x - x) < 0.01, "stopped walking")
    })
    after_ticks(120, () => {
      assert(getAction(craft)!.status === "succeeded", describeAction(getAction(craft)!))
    })
  })

  test("character death fails the running and queued actions", () => {
    const lab = createLab(32)
    const character = spawnEngineer(lab, -20, 0)
    const ctrl = createController(character)
    const walk = enqueue(ctrl, { kind: "walk", goal: at(lab, 20, 0) })
    const craft = enqueue(ctrl, { kind: "craft", recipe: "iron-gear-wheel", count: 1 })
    after_ticks(30, () => character.die())
    after_ticks(32, () => {
      const a = getAction(walk)!
      assert(a.status === "failed" && a.reason === "character-invalid", describeAction(a))
      assert(getAction(craft)!.reason === "character-invalid")
      const late = enqueue(ctrl, { kind: "walk", goal: at(lab, 0, 0) })
      assert(getAction(late)!.reason === "character-invalid", "dead controller rejects new work")
    })
  })

  test("an in-progress walk resumes after a script reload", () => {
    const lab = createLab(64)
    wall(lab, 0, -20, 20)
    const character = spawnEngineer(lab, -50, 0)
    const goal = at(lab, 50, 0)
    const id = enqueue(createController(character), { kind: "walk", goal })
    storage.testScratch = { reloadAction: id, goal, character }
    after_ticks(150, () => {
      const a = getAction(id)!
      assert(a.status === "running" && a.walk?.phase === "follow", describeAction(a))
      storage.testScratch!.xBeforeReload = character.position.x
    })
  }).after_reload_script(() => {
    const scratch = storage.testScratch!
    const id = scratch.reloadAction as number
    const character = scratch.character as LuaEntity
    const goal = scratch.goal as MapPosition
    const a = getAction(id)!
    assert(a.status === "running" && a.walk?.phase === "follow", `resumed mid-walk: ${describeAction(a)}`)
    assert(character.position.x > (scratch.xBeforeReload as number) - 1, "kept its position")
    awaitAction(id, 2000, (fin) => {
      assert(fin.status === "succeeded", describeAction(fin))
      assert(distance(character.position, goal) <= 1, "at the goal")
      assert(fin.stats.repaths === 0, "followed the stored path without re-pathing")
      storage.testScratch = undefined
    })
  })

  describe("debug parity toggles (off by default, never in acceptance runs)", () => {
    test("instant-craft finishes at once", () => {
      setConfigOverride("debugInstantCraft", true)
      const character = spawnEngineer(createLab(8))
      character.insert({ name: "iron-plate", count: 20 })
      const id = enqueue(createController(character), { kind: "craft", recipe: "iron-gear-wheel", count: 10 })
      awaitAction(id, 5, (a) => {
        assert(a.status === "succeeded", describeAction(a))
        assert(itemCount(character, "iron-gear-wheel") === 10)
      })
    })

    test("reach multiplier lets the character place from farther away without walking", () => {
      setConfigOverride("debugReachMultiplier", 3)
      const lab = createLab(32)
      const character = spawnEngineer(lab)
      character.insert({ name: "wooden-chest", count: 1 })
      const id = enqueue(createController(character), { kind: "place", item: "wooden-chest", position: at(lab, 20.5, 0.5) })
      awaitAction(id, 600, (a) => {
        assert(a.status === "succeeded", describeAction(a))
        assert(a.stats.walkTicks === 0, `walked ${a.stats.walkTicks} ticks`)
        assert(character.build_distance >= 30, `build distance ${character.build_distance}`)
      })
    })

    test("teleport-when-stuck hops instead of re-pathing", () => {
      setConfigOverride("debugTeleportWhenStuck", true)
      const lab = createLab(48)
      const character = spawnEngineer(lab, -30, 0)
      const id = enqueue(createController(character), { kind: "walk", goal: at(lab, 30, 0) })
      let dropped = false
      on_tick(() => {
        if (!dropped && getAction(id)!.walk?.phase === "follow" && character.position.x > lab.origin.x - 25) {
          wall(lab, 0, -6, 6)
          dropped = true
        }
      })
      awaitAction(id, 3000, (a) => {
        assert(a.status === "succeeded", describeAction(a))
        assert(a.stats.teleports >= 1 && a.stats.repaths === 0, `teleports ${a.stats.teleports}, repaths ${a.stats.repaths}`)
      })
    })
  })
})
