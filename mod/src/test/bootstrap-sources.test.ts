import { LuaEntity, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { addJob } from "../jobs/board"
import { startBootstrap } from "../strategy/bootstrap"
import { Site, SitePart } from "../strategy/types"
import { at, createLab, Lab } from "./lab"

// B17 (SPEC §5.5 collect-first): material sourcing must collect from bootstrap furnaces (and buffers) before it
// hand-mines or hand-smelts. The soak watched a saturated crew hand-mine ore while furnaces held full plate stacks:
// the collect transfer jobs sat open because planNext only fires between batches, and nothing interrupted an
// in-flight low-priority batch. These tests pin the collect: the basic round trip on an idle crew, and
// preempt-over-hand-mining when the crew is already busy mid-batch.

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

  test("the crew collects plates from a bootstrap furnace in range before it hand-mines", () => {
    const lab = createLab(32)
    const faction = createFaction("b17-a", { position: at(lab, 0, 0), crew: 3, starterItems: {} })
    const brain = startBootstrap(faction, at(lab, 0, 0))
    // The depot chest: empty, with room (the soak showed insertable stacks are not the limit).
    const depot = chest(lab, at(lab, 2, 0), faction.force)
    addStockpile(faction, depot)
    const furnace = platedFurnace(lab, faction, at(lab, 10, 0))
    const site = smeltSite(brain, furnace)
    brain.sites = [site]
    brain.goals = []
    brain.rescanAt = undefined
    // Demand: an active craft job's materials are the economy's demand (reconcile adds each active job's materials).
    addJob(faction.board, {
      kind: "craft",
      pos: depot.position,
      materials: [{ item: "iron-plate", count: 60 }],
      payload: { kind: "craft", recipe: "iron-gear-wheel", count: 20, item: "iron-gear-wheel", deliverTo: depot },
    }, game.tick)
    // Plates must reach the depot from the furnace: outside the collect, nothing in this lab supplies plates
    // (no ore patches either, so hand-mining plates is physically impossible — the collect is the only source).
    let plates = 0
    waitFor(1800, () => {
      plates = depot.get_item_count("iron-plate")
      return plates >= 60
    }, () => "plates at the depot", () => {})
  })

  test("a member hand-mining drops its batch to collect the furnace's plates first", () => {
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
    // Keep the whole crew busy on low-priority hand-mining: gather jobs (wood into the depot) claimed the moment
    // the crew plans (priority 0, no materials), spread over a long row so no member's trip batches them all.
    // The craft job (the collect's demand) is staged: it is injected only once every member is provably in
    // flight, so the collect transfer appears into a saturated crew and only a preemption can claim it.
    const mills = treeRow(lab, faction, 12, 3, at(lab, 22, 4))
    // Without this, planTrip chains all 12 nearby trees into two members' trips and a third member stays idle,
    // so the crew can never be saturated on hand-mining. One job per trip: every member claims a tree.
    setConfigOverride("tripMaxJobs", 1)
    for (const tree of mills) {
      addJob(faction.board, {
        kind: "clear",
        pos: tree.position,
        payload: { kind: "gather", target: tree, count: 2, item: "wood", deliverTo: depot },
      }, game.tick)
    }
    // Stage machine: 0 = wait for the crew busy on hand-mining; 1 = collect is live, wait for the plates.
    let stage = 0
    let plates0 = -1
    let plates = 0
    waitFor(2400, () => {
      plates = depot.get_item_count("iron-plate")
      if (stage === 0) {
        let busy = 0
        for (const id of faction.crew) {
          const m = storage.crew[id]
          if (!m?.dead && m.claims.length > 0 && m.actions.length > 0) busy++
        }
        if (busy >= 3) {
          // The crew is in flight: only now introduce the demand and force the brain's think, so the collect
          // transfer is created into a saturated crew (an idle claimer would win it without any preemption).
          stage = 1
          plates0 = plates
          addJob(faction.board, {
            kind: "craft",
            pos: depot.position,
            materials: [{ item: "iron-plate", count: 60 }],
            payload: { kind: "craft", recipe: "iron-gear-wheel", count: 20, item: "iron-gear-wheel", deliverTo: depot },
          }, game.tick)
          brain.nextThink = game.tick + 1
        }
        return false
      }
      return plates >= 60
    }, () => `the crew busy on hand-mining (tick ${game.tick}, setup ${setupTick}, plates ${plates}, ${preemptedTotal(faction)} preemptions)`, () => {
      const preempted = preemptedTotal(faction)
      const standing = mills.filter((t) => t.valid).length
      const msg = `preemptions ${preempted}, ${standing}/${mills.length} trees, plates ${plates0} at inject → ${plates}, tick ${game.tick} (setup ${setupTick})`
      assert(plates0 === 0, `the depot must be empty when the collect goes live (${msg})`)
      assert(preempted > 0, `a member must preempt its in-flight batch for the collect (${msg})`)
      // The preempted member dropped its batch's remaining steps (at most a few trees' worth of work).
      assert(standing >= mills.length - 3, `the preempted member abandons its batch's steps (${msg})`)
    })
  })
})

/** An iron chest usable as the faction's depot. */
function chest(lab: Lab, position: MapPosition, force: string): LuaEntity {
  const c = lab.surface.create_entity({ name: "iron-chest", position, force })
  assert(c !== undefined && c.valid, "chest placed")
  return c!
}

/** A furnace holding a full stack of plates (no feed, so it never smelts more; checkDepletion only counts drills). */
function platedFurnace(lab: Lab, faction: { force: string }, position: MapPosition): LuaEntity {
  const furnace = lab.surface.create_entity({ name: "stone-furnace", position, force: faction.force })
  assert(furnace !== undefined && furnace.valid, "furnace placed")
  furnace!.get_inventory(defines.inventory.furnace_source)!.insert({ name: "iron-ore", count: 50 })
  furnace!.get_inventory(defines.inventory.furnace_result)!.insert({ name: "iron-plate", count: 100 })
  return furnace!
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
