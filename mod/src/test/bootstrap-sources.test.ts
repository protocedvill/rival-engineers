import { LuaEntity, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { moduleId } from "../shared/ids"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { addJob } from "../jobs/board"
import { supplyStock } from "../jobs/supply"
import { startBootstrap } from "../strategy/bootstrap"
import { Site, SitePart } from "../strategy/types"
import { FactionState } from "../jobs/types"
import { at, createLab, Lab } from "./lab"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { stampModule } from "../modules/stamp"
import { commitModule, PlacedModule } from "../planner/layout"
import { addNode } from "../planner/logical"
import { stampParts } from "../planner/runtime"
import { FactoryState, startFactory } from "../strategy/factory"
import { moduleFurnaces } from "../strategy/factory-report"
import { ModuleDef } from "../modules/types"

// B17 (SPEC §5.5 collect-first): material sourcing must take from bootstrap furnaces (and buffers) before it
// hand-mines or hand-smelts.
//
// B31 (user, in-session 2026-10-19): walking off work to shuffle part stacks to the depot wastes the walk; only a
// running burner about to run out of fuel pulls the nearest busy member off its work (and only that one).
//
// B32 (user, in-session 2026-10-19, the intent of B17): no stack shuffling to the depot at all. When a member needs
// an item for a job, its haul takes it straight from the supply points (furnace outputs, chests, buffers, the mall)
// and the depot; hand-sourcing happens only when no supply point in range holds it.

let testSeq = 0
let setupTick = 0

/**
 * Waits until `cond` is true (then runs `then` and ends the test), or fails after `timeout` ticks. The test body
 * is synchronous, so everything that must hold after the wait runs inside the tick loop, not after this call.
 * The sequence guard keeps an earlier test's stale callback out of this test's window (they share one tick loop).
 */
function waitFor(timeout: number, cond: () => boolean, what: () => string, then: () => void): void {
  const mySeq = testSeq
  let waited = 0
  let firstTick = -1
  let lastTick = -1
  let pausedTicks = 0
  async(timeout)
  on_tick(() => {
    if (mySeq !== testSeq) return
    waited++
    if (firstTick < 0) firstTick = game.tick
    lastTick = game.tick
    if (game.tick_paused) pausedTicks++
    if (cond()) {
      then()
      done()
    } else if (waited >= timeout) {
      assert(false, `timeout waiting for ${what()} (invoked ${waited}x, firstTick ${firstTick}, lastTick ${lastTick}, paused ${pausedTicks}x, delta ${lastTick - firstTick})`)
    }
  })
}

/** How often crew members of `faction` dropped an in-flight batch for higher-priority work so far. */
function preemptedTotal(faction: { crew: number[] }): number {
  let preempted = 0
  for (const id of faction.crew) {
    const m = storage.crew[id]
    if (!m?.dead) preempted += m.stats.preemptions ?? 0
  }
  return preempted
}

describe("B17 material sources", () => {
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    testSeq++
  })

  test("B32: a craft needing iron plates is fed straight from a furnace holding plates", () => {
    const lab = createLab(32)
    const faction = createFaction("b32-a", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    // The depot chest: empty. The furnace (a bootstrap smelt site) holds 100 plates.
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const furnace = platedFurnace(lab, faction, at(lab, 10, 0))
    brain.sites = [smeltSite(brain, furnace)]
    brain.goals = []
    brain.rescanAt = undefined
    brain.nextThink = game.tick
    // An active craft job needing 60 plates (20 gears into the depot).
    addJob(faction.board, {
      kind: "craft",
      pos: depot.position,
      materials: [{ item: "iron-plate", count: 60 }],
      payload: { kind: "craft", recipe: "iron-gear-wheel", count: 20, item: "iron-gear-wheel", deliverTo: depot },
    }, game.tick)
    const watch = watchSourcing(faction, depot)
    waitFor(1800, () => {
      watch.sample()
      return depot.get_item_count("iron-gear-wheel") >= 20
    }, () => `the gears at the depot (${watch.describe()})`, () => {
      const msg = watch.describe()
      assert(watch.maxDepotPlates === 0, `the plates never went through the depot (${msg})`)
      assert(watch.shuffles === 0, `no job moved plates to the depot (${msg})`)
      assert(watch.handSourcing === 0, `nothing was hand-mined (${msg})`)
      assert(furnace.get_item_count("iron-plate") === 40, `the craft's 60 plates came out of the furnace (${furnace.get_item_count("iron-plate")} left)`)
    })
  })

  test("B32: two crafts take from different furnaces, never counting the same stack", () => {
    const lab = createLab(32)
    const faction = createFaction("b32-b", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    // Two furnaces of 60 plates on the same side: the nearer one can't feed both 50-plate crafts.
    const near = platedFurnace(lab, faction, at(lab, 6, 0), 60)
    const far = platedFurnace(lab, faction, at(lab, 12, 0), 60)
    brain.sites = [smeltSite(brain, near), smeltSite(brain, far)]
    brain.goals = []
    brain.rescanAt = undefined
    brain.nextThink = game.tick
    for (let i = 0; i < 2; i++) {
      addJob(faction.board, {
        kind: "craft",
        pos: depot.position,
        materials: [{ item: "iron-plate", count: 50 }],
        payload: { kind: "craft", recipe: "iron-gear-wheel", count: 25, item: "iron-gear-wheel", deliverTo: depot },
      }, game.tick)
    }
    const watch = watchSourcing(faction, depot)
    waitFor(2400, () => {
      watch.sample()
      return depot.get_item_count("iron-gear-wheel") >= 50
    }, () => `both crafts' gears (${watch.describe()})`, () => {
      let released = 0
      for (const id of faction.crew) released += storage.crew[id].stats.jobsReleased
      const msg = `${watch.describe()}, released ${released}, near ${near.get_item_count("iron-plate")}, far ${far.get_item_count("iron-plate")}`
      assert(released === 0, `no craft came up short (${msg})`)
      assert(near.get_item_count("iron-plate") + far.get_item_count("iron-plate") === 20, `100 plates came out of the furnaces (${msg})`)
      assert(watch.maxDepotPlates === 0 && watch.shuffles === 0 && watch.handSourcing === 0, `taken directly (${msg})`)
    })
  })

  test("B32: with the furnaces empty, the brain falls back to hand-mining", () => {
    const lab = createLab(32)
    orePatch(lab, at(lab, -10, 8))
    const faction = createFaction("b32-c", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const furnace = platedFurnace(lab, faction, at(lab, 10, 0), 0)
    brain.sites = [smeltSite(brain, furnace)]
    brain.goals = []
    brain.rescanAt = undefined
    brain.nextThink = game.tick
    addCraft(faction, depot)
    const watch = watchSourcing(faction, depot)
    waitFor(600, () => {
      watch.sample()
      return watch.handSourcing > 0
    }, () => `a hand-mining job (${watch.describe()})`, () => {})
  })

  test("B38: ore in the depot is fed into furnaces without over-booking it or hand-mining more ore for the feeds", () => {
    const lab = createLab(32)
    orePatch(lab, at(lab, -20, 8))
    // The depot 40 tiles from the furnaces: a feed takes several thinks to deliver, as in the user's report (B38: each
    // think booked the whole depot ore again for another furnace, and the over-booking sent the crew hand-mining).
    const faction = createFaction("b38", { position: at(lab, -26, 0), crew: 2, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, -26, 0))
    const depot = chest(lab, at(lab, -26, 2), faction.force)
    addStockpile(faction, depot)
    depot.insert({ name: "iron-ore", count: 12 })
    // Four empty bootstrap furnaces and a fifth whose output is full: no ore goes into that one.
    const furnaces: LuaEntity[] = []
    for (let i = 0; i < 4; i++) furnaces.push(platedFurnace(lab, faction, at(lab, 14 + 3 * i, 0), 0))
    const full = platedFurnace(lab, faction, at(lab, 14, 4), 100)
    full.get_inventory(defines.inventory.furnace_source)!.clear()
    full.insert({ name: "coal", count: 5 })
    full.get_inventory(defines.inventory.furnace_source)!.insert({ name: "iron-ore", count: 1 })
    brain.sites = [...furnaces.map((f) => smeltSite(brain, f)), smeltSite(brain, full)]
    brain.goals = []
    brain.rescanAt = undefined
    brain.nextThink = game.tick
    const watch = watchSourcing(faction, depot)
    let maxBooked = 0
    let ticks = 0
    let intoFull = 0
    waitFor(1800, () => {
      watch.sample()
      let booked = 0
      for (const id of faction.board.active) {
        const p = faction.board.jobs[id].payload
        if (p.kind === "fuel" && p.item === "iron-ore") {
          booked += p.count
          if (p.target === full) intoFull++
        }
      }
      maxBooked = math.max(maxBooked, booked)
      return ++ticks >= 1500
    }, () => "1500 ticks", () => {
      let fed = 0
      for (const f of furnaces) fed += f.get_item_count("iron-ore") + f.get_item_count("iron-plate")
      const msg = `${watch.describe()}, most ore booked ${maxBooked}, fed ${fed}, feeds into the full furnace ${intoFull}`
      log(`[b38] ${msg}; shortfalls ${serpent.line(brain.shortfalls ?? {})}`)
      assert(watch.handSourcing === 0, `no ore was hand-mined for the feeds (${msg})`)
      assert(maxBooked <= 12, `the feeds never booked more ore than the depot held (${msg})`)
      assert(fed === 12, `the depot's 12 ore went into the empty furnaces (${msg})`)
      assert(intoFull === 0, `no feed into the furnace with a full output (${msg})`)
    })
  })

  test("B32: a furnace outside supply-radius is not taken from", () => {
    setConfigOverride("supplyRadius", 5)
    const lab = createLab(32)
    orePatch(lab, at(lab, -10, 8))
    const faction = createFaction("b32-d", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const furnace = platedFurnace(lab, faction, at(lab, 10, 0))
    brain.sites = [smeltSite(brain, furnace)]
    brain.goals = []
    brain.rescanAt = undefined
    brain.nextThink = game.tick
    addCraft(faction, depot)
    const watch = watchSourcing(faction, depot)
    waitFor(600, () => {
      watch.sample()
      return watch.handSourcing > 0
    }, () => `a hand-mining job (${watch.describe()})`, () => {
      assert(furnace.get_item_count("iron-plate") === 100, `the far furnace keeps its plates (${furnace.get_item_count("iron-plate")})`)
    })
  })

  // B36: a module's buffer chest stamped by the planner runtime (ghosts the crew builds) was never registered, so the
  // crew never took from it and hand-mined instead.
  test("B36: a craft takes its plates from a smelter module's buffer chest built from the planner's ghosts", () => {
    const lab = createLab(32)
    orePatch(lab, at(lab, -10, 8))
    const faction = createFaction("b36-a", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    // The factory's own think stays off: the test builds the module itself.
    setConfigOverride("factoryEnabled", false)
    const f = startFactory(faction)
    const { def, m } = smelterModule(f, at(lab, 6, -12))
    const r = stampParts(lab.surface, faction.force, f.layout, { modules: [m.id], routes: [], poles: [] }, true)
    assert(r.failed.length === 0, `ghosts stamped: ${r.failed.join("; ")}`)
    for (const g of r.entities) if (g.valid) g.revive({ raise_revive: true })
    const buffer = bufferOf(lab, def, m, faction.force)
    assert(buffer.get_inventory(defines.inventory.chest)!.get_bar() === 3, `the buffer is limited to 2 slots (bar ${buffer.get_inventory(defines.inventory.chest)!.get_bar()})`)
    buffer.insert({ name: "iron-plate", count: 100 })
    brain.nextThink = game.tick
    addCraft(faction, depot)
    const watch = watchSourcing(faction, depot)
    waitFor(1800, () => {
      watch.sample()
      return depot.get_item_count("iron-gear-wheel") >= 20 || watch.handSourcing > 0
    }, () => `the gears at the depot (${watch.describe()})`, () => {
      const msg = `${watch.describe()}, buffer ${buffer.get_item_count("iron-plate")}, takes ${describeTakes(faction)}`
      assert(watch.handSourcing === 0, `nothing was hand-mined (${msg})`)
      assert(buffer.get_item_count("iron-plate") === 40, `the craft's 60 plates came out of the buffer (${msg})`)
      assert(takesOf(faction, "buffer") === 60, `60 takes counted from a buffer (${msg})`)
    })
  })

  test("B36: a built module's unregistered buffer chest (an older save) is registered and taken from", () => {
    const lab = createLab(32)
    orePatch(lab, at(lab, -10, 8))
    const faction = createFaction("b36-b", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    // The factory's own think stays off: the test builds the module itself.
    setConfigOverride("factoryEnabled", false)
    const f = startFactory(faction)
    const { def, m } = smelterModule(f, at(lab, 6, -12))
    // Stamped for real without registering the buffer (what the runtime's ghosts amounted to before B36).
    stampModule(lab.surface, faction.force, def, m.origin, { bufferSlots: 32 })
    const buffer = bufferOf(lab, def, m, faction.force)
    buffer.insert({ name: "iron-plate", count: 100 })
    brain.nextThink = game.tick
    addCraft(faction, depot)
    const watch = watchSourcing(faction, depot)
    waitFor(1800, () => {
      watch.sample()
      return depot.get_item_count("iron-gear-wheel") >= 20 || watch.handSourcing > 0
    }, () => `the gears at the depot (${watch.describe()})`, () => {
      const msg = `${watch.describe()}, buffer ${buffer.get_item_count("iron-plate")}, takes ${describeTakes(faction)}`
      assert(watch.handSourcing === 0, `nothing was hand-mined (${msg})`)
      assert(buffer.get_item_count("iron-plate") === 40, `the craft's plates came out of the buffer (${msg})`)
      assert(buffer.get_inventory(defines.inventory.chest)!.get_bar() === 3, "the repaired buffer got its slot limit")
    })
  })

  test("B36: supply-module-furnaces (proposed, off by default) takes from a smelter module's furnaces", () => {
    setConfigOverride("supplyModuleFurnaces", true)
    const lab = createLab(32)
    orePatch(lab, at(lab, -10, 8))
    const faction = createFaction("b36-c", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    // The factory's own think stays off: the test builds the module itself.
    setConfigOverride("factoryEnabled", false)
    const f = startFactory(faction)
    const { def, m } = smelterModule(f, at(lab, 6, -12))
    const made = stampModule(lab.surface, faction.force, def, m.origin)
    let furnace: LuaEntity | undefined
    for (const e of made) if (e !== undefined && e.type === "furnace") furnace ??= e
    furnace!.get_inventory(defines.inventory.furnace_result)!.insert({ name: "iron-plate", count: 100 })
    brain.nextThink = game.tick
    addCraft(faction, depot)
    const watch = watchSourcing(faction, depot)
    waitFor(1800, () => {
      watch.sample()
      return depot.get_item_count("iron-gear-wheel") >= 20 || watch.handSourcing > 0
    }, () => `the gears at the depot (${watch.describe()})`, () => {
      const msg = `${watch.describe()}, furnace ${furnace!.get_item_count("iron-plate")}, takes ${describeTakes(faction)}`
      assert(watch.handSourcing === 0, `nothing was hand-mined (${msg})`)
      assert(takesOf(faction, "module-furnace") === 60, `taken from the module's furnace (${msg})`)
    })
  })

  test("B142: stamping the same module ghosts twice reuses them", () => {
    // Seed 1212121 g109: a retried stamp created a second ghost on every tile, returned nil, and reported 1149 already
    // created ghosts as failures, so a good plan was abandoned.
    const lab = createLab(24)
    const faction = createFaction(`b142-${++testSeq}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const def = generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4 })
    const origin = { x: math.floor(lab.origin.x), y: math.floor(lab.origin.y) }
    const a = stampModule(lab.surface, faction.force, def, origin, { ghost: true })
    const b = stampModule(lab.surface, faction.force, def, origin, { ghost: true })
    assert(a.length === def.entities.length, `${a.length} ghosts`)
    let same = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== undefined && b[i] === a[i]) same++
    assert(same === def.entities.length, `reused ${same}/${def.entities.length} ghosts`)
  })

  test("B134: a module still being built is a supply point for its furnace output", () => {
    // Seed 11, minute 330: the blue line's steel smelter stood and ran, but its module was still "building", so its
    // plates were not a supply point. The same plan's pumpjack craft waited 44 game-min for 5 steel plates.
    const lab = createLab(32)
    const faction = createFaction(`b134-${++testSeq}`, { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    setConfigOverride("factoryEnabled", false)
    const f = startFactory(faction)
    const { def, m } = smelterModule(f, at(lab, 6, -12))
    stampModule(lab.surface, faction.force, def, m.origin)
    const node = f.graph.nodes[moduleId("smelter")]!
    node.lifecycle = "building"
    node.builtTick = undefined
    assert(moduleFurnaces(faction.name, true).length > 0, "a building module's furnaces are supply points even with the setting off")
  })

  test("M7c.8: a product the crew can't hand-craft (engine units) is taken from a module's assembler output, below the minimum take", () => {
    // Seed 11 minute 657-743: g108's four crude-line pumps waited 85 game-min for engine units while the faction's engine
    // assemblers stood full (244 made), and each output slot held fewer than the minimum take.
    const lab = createLab(32)
    const faction = createFaction("m7c8-engines", { position: at(lab, 0, 0), crew: 2, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    depot.insert({ name: "steel-plate", count: 2 })
    depot.insert({ name: "pipe", count: 2 })
    addStockpile(faction, depot)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    setConfigOverride("factoryEnabled", false)
    game.forces[faction.force].recipes["pump"].enabled = true
    const f = startFactory(faction)
    const def = generatedModule("assembler-row", { recipe: "engine-unit", count: 2, machine: "assembling-machine-2" })
    const o = { x: math.floor(at(lab, 6, -12).x), y: math.floor(at(lab, 6, -12).y) }
    const m: PlacedModule = { id: moduleId("engines"), canonical: def, def, transform: { rot: 0, mirror: false }, origin: o, rect: { x: o.x, y: o.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
    commitModule(f.layout, m, prototypeFacts, 1)
    addNode(f.graph, { id: moduleId("engines"), role: "engine-unit#1", kind: "module", module: def.id, generator: "assembler-row", recipe: "engine-unit", item: "engine-unit", capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: game.tick, builtTick: game.tick })
    let machine: LuaEntity | undefined
    for (const e of stampModule(lab.surface, faction.force, def, m.origin)) if (e !== undefined && e.type === "assembling-machine") machine ??= e
    assert(machine !== undefined, "the engine assembler stands")
    machine!.get_inventory(defines.inventory.crafter_output)!.insert({ name: "engine-unit", count: 3 })
    brain.nextThink = game.tick
    addJob(faction.board, {
      kind: "craft",
      pos: depot.position,
      materials: [{ item: "engine-unit", count: 2 }, { item: "steel-plate", count: 2 }, { item: "pipe", count: 2 }],
      payload: { kind: "craft", recipe: "pump", count: 2, item: "pump", deliverTo: depot },
    }, game.tick)
    waitFor(3600, () => depot.get_item_count("pump") >= 2, () => `two pumps at the depot (takes ${describeTakes(faction)})`, () => {
      assert(takesOf(faction, "module-out") === 2, `the engines came out of the assembler (takes ${describeTakes(faction)})`)
      assert(machine!.get_item_count("engine-unit") === 1, "one engine is left")
    })
  })

  test("M7d.5: a stock row's chest supplies one roboport before its node is built (stock-out, below the minimum take)", () => {
    // Soak m7d5-robots5 (seed 11, minute 1080): the robot row's roboport ghost waited 86 game-min while the roboport
    // stock row's chest (same goal, so its node was not built) held 2, below the minimum take.
    const lab = createLab(32)
    const faction = createFaction("m7d5-stock", { position: at(lab, 0, 0), crew: 2, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const target = chest(lab, at(lab, -4, 0), faction.force)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    setConfigOverride("factoryEnabled", false)
    const f = startFactory(faction)
    const def = generatedModule("assembler-row", { recipe: "roboport", count: 2, machine: "assembling-machine-2", buffer: "iron-chest" })
    const o = { x: math.floor(at(lab, 6, -12).x), y: math.floor(at(lab, 6, -12).y) }
    const m: PlacedModule = { id: moduleId("roboports"), canonical: def, def, transform: { rot: 0, mirror: false }, origin: o, rect: { x: o.x, y: o.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
    commitModule(f.layout, m, prototypeFacts, 1)
    addNode(f.graph, { id: moduleId("roboports"), role: "stock:roboport", kind: "sink", module: def.id, generator: "assembler-row", recipe: "roboport", item: "roboport", capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "building", status: "unknown", createdTick: game.tick })
    stampModule(lab.surface, faction.force, def, m.origin)
    const out = bufferOf(lab, def, m, faction.force)
    out.get_inventory(defines.inventory.chest)!.set_bar() // the stamp limits a buffer's slots before it has a product
    const put = out.insert({ name: "roboport", count: 2 })
    assert(put === 2, `two roboports in the stock row's ${out.name} at ${out.position.x},${out.position.y} (inserted ${put}, bar ${out.get_inventory(defines.inventory.chest)?.get_bar()})`)
    brain.nextThink = game.tick
    addJob(faction.board, { kind: "fuel", pos: target.position, materials: [{ item: "roboport", count: 1 }], payload: { kind: "fuel", item: "roboport", count: 1, target, partial: true } }, game.tick)
    waitFor(3600, () => target.get_item_count("roboport") >= 1, () => `a roboport at the target (takes ${describeTakes(faction)}; supplies ${serpent.line(supplyStock(faction, 5))})`, () => {
      assert(takesOf(faction, "stock-out") >= 1, `taken from the stock row's chest (takes ${describeTakes(faction)})`)
    })
  })

  test("a busy crew takes the furnace's plates for a new craft at its next plan, without preempting", () => {
    const lab = createLab(48)
    const faction = createFaction("b17-b", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    setupTick = game.tick
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const furnace = platedFurnace(lab, faction, at(lab, 12, 10))
    brain.sites = [smeltSite(brain, furnace)]
    brain.goals = []
    brain.rescanAt = undefined
    // Keep the whole crew busy on low-priority hand-mining (wood into the depot), one tree per member's trip, then
    // add a craft needing the furnace's plates: nobody walks off its work for it, and the first member to plan
    // again takes the plates straight from the furnace for the craft.
    const mills = treeRow(lab, faction, 12, 3, at(lab, 22, 4))
    setConfigOverride("tripMaxJobs", 1)
    for (const tree of mills) {
      addJob(faction.board, {
        kind: "clear",
        pos: tree.position,
        payload: { kind: "gather", target: tree, count: 2, item: "wood", deliverTo: depot },
      }, game.tick)
    }
    let stage = 0
    const watch = watchSourcing(faction, depot)
    waitFor(2400, () => {
      watch.sample()
      if (stage === 0) {
        let busy = 0
        for (const id of faction.crew) {
          const m = storage.crew[id]
          if (!m?.dead && m.claims.length > 0 && m.actions.length > 0) busy++
        }
        if (busy >= 3) {
          stage = 1
          addCraft(faction, depot)
          brain.nextThink = game.tick + 1
        }
        return false
      }
      return depot.get_item_count("iron-gear-wheel") >= 20
    }, () => `the crew busy on hand-mining, then the gears (stage ${stage}, tick ${game.tick}, setup ${setupTick}, ${watch.describe()}, ${preemptedTotal(faction)} preemptions)`, () => {
      const preempted = preemptedTotal(faction)
      const msg = `preemptions ${preempted}, ${watch.describe()}, tick ${game.tick} (setup ${setupTick})`
      assert(preempted === 0, `a craft's sourcing must not preempt a batch (${msg})`)
      assert(watch.maxDepotPlates === 0 && watch.shuffles === 0, `the plates went straight from the furnace to the craft (${msg})`)
      assert(furnace.get_item_count("iron-plate") === 40, `the craft's plates came out of the furnace (${furnace.get_item_count("iron-plate")} left)`)
    })
  })

  test("an urgent refuel pulls only the nearest busy member off its work, and it takes the job", () => {
    const lab = createLab(48)
    const faction = createFaction("b31-fuel", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    depot.insert({ name: "coal", count: 50 })
    addStockpile(faction, depot)
    // A running furnace with one piece of wood left (2 MJ at 90 kW: ~22 s, under the 30 s default).
    const furnace = lab.surface.create_entity({ name: "stone-furnace", position: at(lab, 12, 10), force: faction.force })!
    furnace.get_inventory(defines.inventory.furnace_source)!.insert({ name: "iron-ore", count: 50 })
    furnace.get_fuel_inventory()!.insert({ name: "wood", count: 1 })
    setConfigOverride("tripMaxJobs", 1)
    const mills = treeRow(lab, faction, 12, 3, at(lab, 22, 4))
    for (const tree of mills) {
      addJob(faction.board, { kind: "clear", pos: tree.position, payload: { kind: "gather", target: tree, count: 2, item: "wood", deliverTo: depot } }, game.tick)
    }
    let stage = 0
    let taken = 0
    waitFor(1800, () => {
      if (stage === 0) {
        let busy = 0
        for (const id of faction.crew) {
          const m = storage.crew[id]
          if (!m?.dead && m.claims.length > 0 && m.actions.length > 0) busy++
        }
        if (busy >= 3) {
          stage = 1
          addJob(faction.board, {
            kind: "fuel",
            pos: furnace.position,
            materials: [{ item: "coal", count: 5 }],
            priority: 100,
            payload: { kind: "fuel", item: "coal", count: 5, target: furnace, partial: true },
          }, game.tick)
        }
        return false
      }
      taken = 0
      for (const id of faction.crew) taken += storage.crew[id].stats.preemptTaken ?? 0
      return furnace.get_fuel_inventory()!.get_item_count("coal") > 0
    }, () => `the refuel (tick ${game.tick}, stage ${stage}, ${preemptedTotal(faction)} preemptions)`, () => {
      const preempted = preemptedTotal(faction)
      const msg = `preemptions ${preempted}, taken ${taken}, tick ${game.tick}`
      assert(preempted === 1, `exactly one member preempts for the refuel (${msg})`)
      assert(taken === 1, `the preempting member takes the refuel (${msg})`)
    })
  })
})

/** A 4-furnace iron smelter column with a buffer head (D42), committed to the factory's layout as a built node. */
function smelterModule(f: FactoryState, origin: MapPosition): { def: ModuleDef; m: PlacedModule } {
  const def = generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4, buffer: "iron-chest" })
  const o = { x: math.floor(origin.x), y: math.floor(origin.y) }
  const m: PlacedModule = { id: moduleId("smelter"), canonical: def, def, transform: { rot: 0, mirror: false }, origin: o, rect: { x: o.x, y: o.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(f.layout, m, prototypeFacts, 1)
  addNode(f.graph, {
    id: moduleId("smelter"),
    role: "iron-plate#1",
    kind: "module",
    module: def.id,
    generator: "smelter-column",
    recipe: "iron-plate",
    item: "iron-plate",
    capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs },
    planned: { inputs: [], outputs: [] },
    powerW: 0,
    lifecycle: "built",
    status: "unknown",
    createdTick: game.tick,
    builtTick: game.tick,
  })
  return { def, m }
}

/** The module's built buffer chest. */
function bufferOf(lab: Lab, def: ModuleDef, m: PlacedModule, force: string): LuaEntity {
  for (const e of def.entities) {
    if (!e.buffer) continue
    const found = lab.surface.find_entities_filtered({ type: "container", force, position: { x: m.origin.x + e.x, y: m.origin.y + e.y }, limit: 1 })[0]
    assert(found !== undefined, "the buffer chest is built")
    return found
  }
  error("no buffer in the module")
}

function takesOf(faction: FactionState, kind: string): number {
  let n = 0
  for (const id of faction.crew) n += storage.crew[id].stats.takes?.[kind] ?? 0
  return n
}

function describeTakes(faction: FactionState): string {
  const all: Record<string, number> = {}
  for (const id of faction.crew) for (const [k, v] of pairs(storage.crew[id].stats.takes ?? {})) all[k as string] = (all[k as string] ?? 0) + v
  const parts: string[] = []
  for (const [k, v] of pairs(all)) parts.push(`${k} ${v}`)
  return parts.join(", ")
}

/** An iron chest usable as the faction's depot. */
function chest(lab: Lab, position: MapPosition, force: string): LuaEntity {
  const c = lab.surface.create_entity({ name: "iron-chest", position, force })
  assert(c !== undefined && c.valid, "chest placed")
  return c!
}

/**
 * A furnace holding `plates` plates (default a full stack) and, unless empty, 50 ore (no fuel, so it never smelts more;
 * checkDepletion only counts drills).
 */
function platedFurnace(lab: Lab, faction: { force: string }, position: MapPosition, plates = 100): LuaEntity {
  const furnace = lab.surface.create_entity({ name: "stone-furnace", position, force: faction.force })
  assert(furnace !== undefined && furnace.valid, "furnace placed")
  if (plates > 0) {
    furnace!.get_inventory(defines.inventory.furnace_source)!.insert({ name: "iron-ore", count: 50 })
    furnace!.get_inventory(defines.inventory.furnace_result)!.insert({ name: "iron-plate", count: plates })
  }
  return furnace!
}

/** A craft job needing 60 plates (20 gears into the depot). */
function addCraft(faction: FactionState, depot: LuaEntity): void {
  addJob(faction.board, {
    kind: "craft",
    pos: depot.position,
    materials: [{ item: "iron-plate", count: 60 }],
    payload: { kind: "craft", recipe: "iron-gear-wheel", count: 20, item: "iron-gear-wheel", deliverTo: depot },
  }, game.tick)
}

/** A 3x3 iron ore patch (created before startBootstrap, whose scan must see it). */
function orePatch(lab: Lab, origin: MapPosition): void {
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) lab.surface.create_entity({ name: "iron-ore", position: { x: origin.x + x, y: origin.y + y }, amount: 500 })
}

/**
 * B32 sourcing watch: the most plates the depot ever held, jobs that move items to the depot (transfers) and
 * hand-sourcing jobs (gathers of ore or plates) seen on the board.
 */
function watchSourcing(faction: FactionState, depot: LuaEntity) {
  const seen: Record<number, boolean> = {}
  const w = {
    maxDepotPlates: 0,
    shuffles: 0,
    handSourcing: 0,
    sample(): void {
      w.maxDepotPlates = math.max(w.maxDepotPlates, depot.valid ? depot.get_item_count("iron-plate") : 0)
      for (const [id, job] of pairs(faction.board.jobs)) {
        if (seen[id]) continue
        const p = job.payload
        if (p.kind === "transfer") {
          seen[id] = true
          w.shuffles++
        } else if (p.kind === "gather" && (p.item === "iron-ore" || p.item === "iron-plate")) {
          seen[id] = true
          w.handSourcing++
        }
      }
    },
    describe(): string {
      return `depot plates max ${w.maxDepotPlates}, transfers ${w.shuffles}, hand-sourcing ${w.handSourcing}`
    },
  }
  return w
}

/** A built furnace SitePart for a custom site (updateSites only touches planned sites, so it stays built). */
function smeltSite(brain: { nextSiteId: number }, furnace: LuaEntity): Site {
  const part: SitePart = { entity: "stone-furnace", item: "stone-furnace", position: furnace.position, direction: furnace.direction, built: furnace, burner: false }
  return { id: brain.nextSiteId++, kind: "smelt", resource: "iron-ore", parts: [part], tiles: [], status: "built", createdTick: game.tick }
}

/** A row of trees; returns their entities (mineable wood the crew can batch into gather trips). */
function treeRow(lab: Lab, faction: { force: string }, count: number, spacing: number, origin: MapPosition): LuaEntity[] {
  const trees: LuaEntity[] = []
  for (let i = 0; i < count; i++) {
    const tree = lab.surface.create_entity({ name: "tree-02", position: { x: origin.x + i * spacing, y: origin.y }, force: faction.force })
    assert(tree !== undefined && tree.valid, "tree placed")
    trees.push(tree!)
  }
  return trees
}
