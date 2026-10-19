import { clearConfigOverrides, setConfigOverride } from "../config"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { commitModule, PlacedModule } from "../planner/layout"
import { addNode, rateIn } from "../planner/logical"
import { stampParts } from "../planner/runtime"
import { startBootstrap } from "../strategy/bootstrap"
import { getFactory, startFactory, tempCells } from "../strategy/factory"
import { at, createLab } from "./lab"

// D38 (M5d): a temporary chest-fed gear cell supplies the bootstrap economy. The brain needs gears: it collects them
// from the cell's output chest, feeds the cell's input chest with surplus plates from the depot, waits for up to
// `bootstrap-factory-wait-seconds` of the cell's output and hand-crafts only the rest.

const SPEED = 50

describe("D38 temporary factories", () => {
  let speed = 1
  before_all(() => {
    speed = game.speed
    game.speed = SPEED
  })
  after_all(() => {
    game.speed = speed
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    setConfigOverride("scanRadius", 40)
    // The strategy layer's own think stays off: the test builds the cell itself.
    setConfigOverride("factoryEnabled", false)
  })
  after_each(() => clearConfigOverrides())

  test("a gear cell is fed from the depot and makes most of the gears the brain needs", () => {
    const lab = createLab(32)
    const faction = createFaction("d38-cell", { position: at(lab, 0, 8), crew: 1, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 8))
    const depot = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 0.5, 4.5), force: faction.force })!
    depot.insert({ name: "iron-plate", count: 200 })
    addStockpile(faction, depot)
    brain.goals = [{ kind: "items", items: { "iron-gear-wheel": 30 }, label: "d38-gears" }]
    const f = startFactory(faction)
    // A built gear cell 10 tiles east, powered by an energy interface next to its pole.
    const def = generatedModule("chest-cell", { recipe: "iron-gear-wheel", machine: "assembling-machine-1", chest: "iron-chest" })
    const origin = { x: math.floor(lab.origin.x) + 10, y: math.floor(lab.origin.y) - 2 }
    const m: PlacedModule = { id: "cell", canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
    commitModule(f.layout, m, prototypeFacts, 1)
    const r = stampParts(lab.surface, faction.force, f.layout, { modules: ["cell"], routes: [], poles: [] }, false)
    assert(r.failed.length === 0, `stamped: ${r.failed.join("; ")}`)
    const eei = lab.surface.create_entity({ name: "electric-energy-interface", position: { x: origin.x + 1, y: origin.y - 2 }, force: faction.force })!
    eei.power_production = 1e6
    eei.electric_buffer_size = 1e6
    lab.surface.create_entity({ name: "small-electric-pole", position: { x: origin.x + 0.5, y: origin.y - 0.5 }, force: faction.force })
    addNode(f.graph, {
      id: "cell",
      role: "temp:iron-gear-wheel#1",
      kind: "sink",
      module: def.id,
      generator: "chest-cell",
      recipe: "iron-gear-wheel",
      item: "iron-gear-wheel",
      capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs },
      planned: { inputs: [], outputs: [{ item: "iron-gear-wheel", perSecond: rateIn(def.rates.outputs, "iron-gear-wheel") }] },
      powerW: 0,
      lifecycle: "built",
      status: "unknown",
      createdTick: game.tick,
      builtTick: game.tick,
    })
    const cells = tempCells(faction.name, "iron-gear-wheel")
    assert(cells.length === 1, `the cell is found (${cells.length})`)
    const machine = cells[0].machine!
    let fed = 0
    async(60 * 60 * 6)
    on_tick(() => {
      fed = math.max(fed, cells[0].input.get_item_count("iron-plate"))
      if (brain.goals[0].done !== true) return
      const made = machine.products_finished
      log(`[d38] cell: ${made} gears made, input chest held up to ${fed} plates, goal done after ${game.tick - f.progressTick} ticks; background crafts ${storage.crew[faction.crew[0]].stats.backgroundCrafts ?? 0}`)
      assert(getFactory(faction.name) !== undefined, "factory state kept")
      assert(fed > 0, "the crew fed the cell's input chest")
      assert(made >= 15, `the cell made most of the gears (${made} of 30)`)
      done()
      return false
    })
  })
})
