import { clearConfigOverrides, setConfigOverride } from "../config"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { moduleId } from "../shared/ids"
import { Job } from "../jobs/board"
import { FactionState, JobPayload } from "../jobs/types"
import { LuaEntity } from "factorio:runtime"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { commitModule, PlacedModule } from "../planner/layout"
import { addNode, rateIn } from "../planner/logical"
import { stampParts } from "../planner/runtime"
import { startBootstrap } from "../strategy/bootstrap"
import { FactoryState, getFactory, startFactory } from "../strategy/factory"
import { TempCell, tempCells } from "../strategy/factory-report"
import { Lab, at, createLab } from "./lab"

// D38 (M5d): a temporary chest-fed gear cell supplies the bootstrap economy. The brain needs gears: it collects them
// from the cell's output chest, feeds the cell's input chest with surplus plates from the depot, waits for up to
// `bootstrap-factory-wait-seconds` of the cell's output and hand-crafts only the rest.

const SPEED = 50

/** A built chest-fed gear cell 10 tiles east of the lab origin (the D38 test's cell), factory state and all. */
function buildGearCell(lab: Lab, faction: FactionState, recipe = "iron-gear-wheel", dy = 0, id = "cell"): FactoryState {
  const f = getFactory(faction.name) ?? startFactory(faction)
  const def = generatedModule("chest-cell", { recipe, machine: "assembling-machine-1", chest: "iron-chest" })
  const origin = { x: math.floor(lab.origin.x) + 10, y: math.floor(lab.origin.y) - 2 + dy }
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(f.layout, m, prototypeFacts, 1)
  const r = stampParts(lab.surface, faction.force, f.layout, { modules: [moduleId(id)], routes: [], poles: [] }, false)
  assert(r.failed.length === 0, `stamped: ${r.failed.join("; ")}`)
  const eei = lab.surface.create_entity({ name: "electric-energy-interface", position: { x: origin.x + 1, y: origin.y - 2 }, force: faction.force })!
  eei.power_production = 1e6
  eei.electric_buffer_size = 1e6
  lab.surface.create_entity({ name: "small-electric-pole", position: { x: origin.x + 0.5, y: origin.y - 0.5 }, force: faction.force })
  const item = prototypes.recipe[recipe].main_product?.name ?? recipe
  addNode(f.graph, {
    id: moduleId(id),
    role: `temp:${item}#1`,
    kind: "sink",
    module: def.id,
    generator: "chest-cell",
    recipe,
    item,
    capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs },
    planned: { inputs: [], outputs: [{ item, perSecond: rateIn(def.rates.outputs, item) }] },
    powerW: 0,
    lifecycle: "built",
    status: "unknown",
    createdTick: game.tick,
    builtTick: game.tick,
  })
  return f
}

describe("D38 temporary factories", () => {
  let speed = 1
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
    const f = buildGearCell(lab, faction)
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

  /** A quiet-economy temp cell: no goals, no sites, nothing anywhere asking for the cell's product. */
  function quietPlateDepot(lab: Lab, faction: FactionState): { brain: ReturnType<typeof startBootstrap>; depot: LuaEntity; cell: TempCell } {
    const brain = startBootstrap(faction, at(lab, 0, 8))
    const depot = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 0.5, 4.5), force: faction.force })!
    depot.insert({ name: "iron-plate", count: 200 })
    addStockpile(faction, depot)
    // Replan stays off so the brain cannot invent an order for the test window.
    setConfigOverride("stallTicks", 1e9)
    brain.goals = []
    brain.sites = []
    brain.rescanAt = undefined
    buildGearCell(lab, faction)
    const cells = tempCells(faction.name, "iron-gear-wheel")
    assert(cells.length === 1 && cells[0].machine !== undefined, "the cell is found with its machine")
    return { brain, depot, cell: cells[0] }
  }

  const cellKey = (cell: TempCell, item: string): string => `tempfeed:${cell.input.unit_number}:${item}`

  test("the brain stocks a cell's input chest with no order asking for its product (B18)", () => {
    const lab = createLab(32)
    const faction = createFaction("d38-topup", { position: at(lab, 0, 8), crew: 1, starterItems: {} })
    const { brain, cell } = quietPlateDepot(lab, faction)
    const target = math.min(math.max(1, math.floor(cell.rate * 60)) * 2, 200)
    // Proactive stocking: force the brain's think now that the cell exists.
    brain.nextThink = game.tick + 1
    let refill: Job<JobPayload> | undefined
    async(60 * 60 * 6)
    on_tick(() => {
      if (refill === undefined) {
        const id = brain.jobKeys[cellKey(cell, "iron-plate")]
        const job = id === undefined ? undefined : faction.board.jobs[id]
        if (job !== undefined && job.status !== "done") {
          refill = job
          log(`[b18] refill job: #${job.id} ${job.kind}/p${job.priority} at tick ${game.tick}`)
          assert(job.kind === "fuel", `the refill is a fuel job (${job.kind})`)
          assert(job.priority === 40, `the refill runs at the default priority (p${job.priority} of 40)`)
          if (job.payload.kind === "fuel") {
            assert(job.payload.item === "iron-plate" && job.payload.target === cell.input, "the refill targets the cell's input chest")
            assert(job.payload.count > 0, `the refill counts plates (${job.payload.count})`)
          }
        }
      }
      const plates = cell.input.get_item_count("iron-plate")
      if (plates < target || refill === undefined) return
      // Nobody ever asked for the cell's product, yet the cell got stocked: the crew keep every cell ready to
      // have its output chest serve a later request (or the factory's) without waiting for one.
      finalChecks(brain, faction, target, plates)
      done()
    })

    function finalChecks(brain: ReturnType<typeof startBootstrap>, faction: FactionState, target: number, plates: number): void {
      log(`[b18] cell stocked: ${plates} plates in the input chest (target ${target}), ${cell.output.get_item_count("iron-gear-wheel")} gears made for no order`)
      for (const g of brain.goals) {
        const items = (g as { items?: Record<string, number> }).items ?? {}
        for (const item in items) assert(item !== "iron-gear-wheel", `no order asks for the cell's product (goal has ${item})`)
      }
      for (const id of faction.board.active) {
        const j = faction.board.jobs[id]
        if (j === undefined) continue
        const payloadItem = (j.payload as { item?: string }).item
        assert(payloadItem !== "iron-gear-wheel", `no job asks for the cell's product (${j.kind})`)
      }
      assert(plates >= target, `the input chest was topped up (${plates} of ${target})`)
      assert(refill !== undefined, "a refill job was created")
    }
  })

  // B36 (manager probe soak, seed 11): the red-science cell was never fed its gears though the gear cell's output chest
  // held 141: the belt cell, first in node order, took every gear for its top-up while 218 belts sat in its output chest.
  // A cell whose output chest holds its buffer is not topped up; the gears then reach the red-science cell.
  test("B36: a stocked belt cell leaves the gears to the red-science cell", () => {
    const lab = createLab(32)
    const faction = createFaction("b36-cells", { position: at(lab, 0, 8), crew: 2, starterItems: {} })
    const { brain } = quietPlateDepot(lab, faction)
    const depot = faction.stockpiles[0]
    depot.insert({ name: "copper-plate", count: 100 })
    game.forces[faction.force].recipes["automation-science-pack"].enabled = true
    game.forces[faction.force].recipes["transport-belt"].enabled = true
    buildGearCell(lab, faction, "transport-belt", 4, "belt")
    buildGearCell(lab, faction, "automation-science-pack", 8, "red")
    const red = tempCells(faction.name, "automation-science-pack")[0]
    const gear = tempCells(faction.name, "iron-gear-wheel")[0]
    assert(red !== undefined && red.machine !== undefined, "the red-science cell is found")
    brain.nextThink = game.tick + 1
    let maxGearOut = 0
    async(60 * 60 * 6)
    on_tick(() => {
      maxGearOut = math.max(maxGearOut, gear.output.get_item_count("iron-gear-wheel"))
      if (red.machine!.products_finished < 3) return
      const belt = tempCells(faction.name, "transport-belt")[0]
      log(`[b36] red cell made ${red.machine!.products_finished} packs by tick ${game.tick}; gear cell output held up to ${maxGearOut}; belt cell output ${belt.output.get_item_count("transport-belt")}`)
      done()
      return false
    })
  })

  test("the refill priority setting steers the refresh jobs", () => {
    setConfigOverride("bootstrapTempCellFeedPriority", 65)
    const lab = createLab(32)
    const faction = createFaction("d38-topup65", { position: at(lab, 0, 8), crew: 1, starterItems: {} })
    const { brain, cell } = quietPlateDepot(lab, faction)
    brain.nextThink = game.tick + 1
    async(600)
    on_tick(() => {
      const id = brain.jobKeys[cellKey(cell, "iron-plate")]
      const job = id === undefined ? undefined : faction.board.jobs[id]
      if (job === undefined || job.status === "done") return
      assert(job.kind === "fuel" && job.priority === 65, `the refill runs at the configured priority (p${job.priority})`)
      done()
    })
  })

  test("the refill priority 0 keeps the cells demand-fed only", () => {
    setConfigOverride("bootstrapTempCellFeedPriority", 0)
    const lab = createLab(32)
    const faction = createFaction("d38-topup0", { position: at(lab, 0, 8), crew: 1, starterItems: {} })
    const { brain, cell } = quietPlateDepot(lab, faction)
    brain.nextThink = game.tick + 1
    let waited = 0
    async(1200)
    on_tick(() => {
      waited++
      if (waited < 60) return
      const id = brain.jobKeys[cellKey(cell, "iron-plate")]
      assert(id === undefined, "no proactive refill was queued")
      assert(cell.input.get_item_count("iron-plate") === 0, `the input chest stays empty (${cell.input.get_item_count("iron-plate")})`)
      log("[b18] priority 0: no refill (done)")
      done()
    })
  })
})
