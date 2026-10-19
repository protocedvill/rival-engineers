import { LuaEntity, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { addJob } from "../jobs/board"
import { startBootstrap } from "../strategy/bootstrap"
import { Site, SitePart } from "../strategy/types"
import { FactionState } from "../jobs/types"
import { at, createLab, Lab } from "./lab"

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
