import { LuaEntity, LuaProfiler, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import { Board, CLAIM_LOG_KEPT } from "../jobs/board"
import { addJob } from "../jobs/board"
import { addStockpile, createFaction, destroyFaction, planGhosts } from "../jobs/faction"
import { FactionState, JobPayload } from "../jobs/types"
import { setAiProfiler } from "../profiling"
import { at, createLab, itemCount, Lab } from "./lab"

// M2 acceptance (SPEC §8): crews build ghost layouts through the Job Board. Debug parity toggles stay off.

const S = defines.direction.south
const E = defines.direction.east

interface Layout {
  /** Items needed to build every ghost, plus fuel. */
  bill: Record<string, number>
  ghosts: number
  /** Where each planned entity goes. */
  planned: { name: string; position: MapPosition }[]
}

const FUEL = { item: "coal", count: 5 }

/**
 * A small iron smelting block, 40 entities: 4 electric drills on ore → a belt → 5 burner inserters →
 * 5 stone furnaces → 5 inserters → 5 chests, with 4 small poles. Ghosts are on `force`.
 */
function smeltingLayout(lab: Lab, force: string, ox: number, oy: number): Layout {
  const layout: Layout = { bill: {}, ghosts: 0, planned: [] }
  const ghost = (name: string, x: number, y: number, direction = defines.direction.north) => {
    const position = at(lab, ox + x, oy + y)
    const g = lab.surface.create_entity({ name: "entity-ghost", inner_name: name, position, direction, force })
    assert(g, `ghost ${name} at ${x},${y}`)
    layout.bill[name] = (layout.bill[name] ?? 0) + 1
    layout.ghosts++
    layout.planned.push({ name, position: g!.position })
  }
  for (let x = -6; x < 6; x++) {
    for (let y = -12; y < -9; y++) lab.surface.create_entity({ name: "iron-ore", position: at(lab, ox + x + 0.5, oy + y + 0.5), amount: 2000 })
  }
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ghost("electric-mining-drill", x, -10.5, S)
  for (let x = -5.5; x <= 5.5; x++) ghost("transport-belt", x, -8.5, E)
  for (const c of [-4, -2, 0, 2, 4]) {
    ghost("burner-inserter", c - 0.5, -7.5, S)
    ghost("stone-furnace", c, -6)
    ghost("inserter", c - 0.5, -4.5, S)
    ghost("wooden-chest", c - 0.5, -3.5)
  }
  ghost("small-electric-pole", -6.5, -8.5 + 1, defines.direction.north)
  ghost("small-electric-pole", 6.5, -8.5 + 1, defines.direction.north)
  ghost("small-electric-pole", -1.5, -4.5)
  ghost("small-electric-pole", 2.5, -4.5)
  // Burner inserters and furnaces get fuel jobs.
  layout.bill[FUEL.item] = 10 * FUEL.count
  return layout
}

/** An iron chest on the faction's force holding `bill` × `factor` (rounded up). */
function stockpile(lab: Lab, faction: FactionState, x: number, y: number, bill: Record<string, number>, extra = 0): LuaEntity {
  const chest = lab.surface.create_entity({ name: "iron-chest", position: at(lab, x, y), force: faction.force })!
  for (const item in bill) chest.insert({ name: item, count: bill[item] + extra })
  addStockpile(faction, chest)
  return chest
}

/** Replays the claim log: no job is ever claimed while held, and each job completes once. */
function auditClaims(board: Board<JobPayload>): string | undefined {
  if (board.claimLog.length >= CLAIM_LOG_KEPT) return "claim log truncated"
  const holder: Record<number, number | undefined> = {}
  const done: Record<number, boolean> = {}
  for (const e of board.claimLog) {
    const held = holder[e.job]
    if (e.event === "claim") {
      if (held !== undefined) return `job ${e.job} claimed by ${e.member} while held by ${held}`
      holder[e.job] = e.member
    } else if (e.event === "fail" && held === undefined) {
      // Failed as a dependent of a failed job: it was never held.
    } else {
      if (held !== e.member) return `job ${e.job}: ${e.event} by ${e.member} but held by ${tostring(held)}`
      holder[e.job] = undefined
      if (e.event === "done") {
        if (done[e.job]) return `job ${e.job} done twice`
        done[e.job] = true
      }
    }
  }
  return undefined
}

function builtCount(lab: Lab, force: string): number {
  return lab.surface.count_entities_filtered({
    area: [at(lab, -lab.radius, -lab.radius), at(lab, lab.radius, lab.radius)],
    force,
    type: ["mining-drill", "transport-belt", "inserter", "furnace", "container", "electric-pole"],
  })
}

function ghostCount(lab: Lab, force: string): number {
  return lab.surface.count_entities_filtered({ area: [at(lab, -lab.radius, -lab.radius), at(lab, lab.radius, lab.radius)], force, type: "entity-ghost" })
}

function assertPlannedBuilt(lab: Lab, layout: Layout, force: string): void {
  for (const p of layout.planned) {
    const found = lab.surface.find_entities_filtered({ position: p.position, name: p.name, force, limit: 1 })
    assert(found.length === 1, `${p.name} built at ${p.position.x},${p.position.y}`)
  }
}

/** Runs `check` (async) once the faction's board has no open or claimed jobs left. */
function awaitBoard(faction: FactionState, timeout: number, check: () => void): void {
  async(timeout)
  on_tick(() => {
    if (faction.board.active.length > 0) return
    check()
    done()
  })
}

function describeBoard(faction: FactionState): string {
  const c = faction.board.counters
  const parts = [`added ${c.added} claims ${c.claims} done ${c.completions} released ${c.releases} failed ${c.failures} double ${c.doubleClaims}`]
  for (let id = 1; id < faction.board.nextId; id++) {
    const j = faction.board.jobs[id]
    if (j.status === "done") continue
    parts.push(`#${j.id} ${j.kind} ${j.status} by ${tostring(j.claimedBy)} attempts ${j.attempts} ${j.reason ?? ""}`)
  }
  return parts.join("; ")
}

function dumpFrame(lab: Lab, name: string): void {
  remote.call("rival-engineers", "dump_entities", `rival-engineers/${name}.json`, lab.origin, lab.radius)
}

let factionSeq = 0
function newFactionName(tag: string): string {
  return `m2-${tag}-${++factionSeq}`
}

describe("job board", () => {
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    const config = getConfig()
    assert(!config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1, "debug parity toggles must be off")
  })

  test("two crew jointly build a 40-entity ghost layout from a stockpile", () => {
    const lab = createLab(32)
    const name = newFactionName("build")
    const faction = createFaction(name, { position: at(lab, 0, 12), crew: 2 })
    const layout = smeltingLayout(lab, faction.force, 0, 0)
    assert(layout.ghosts === 40, `layout has ${layout.ghosts} ghosts`)
    const chest = stockpile(lab, faction, 0.5, 8.5, layout.bill)
    // Spread the two crew members apart.
    storage.crew[faction.crew[0]].character.teleport(at(lab, -14, 12))
    storage.crew[faction.crew[1]].character.teleport(at(lab, 14, 12))
    const planned = planGhosts(faction, { fuel: FUEL })
    assert(planned === 40, `planned ${planned}`)
    const start = game.tick
    const profiler: LuaProfiler = helpers.create_profiler(true)
    setAiProfiler(profiler)
    let frame = 0
    dumpFrame(lab, `m2-build/frame-${string.format("%03d", frame++)}`)
    on_tick((tick) => {
      if ((tick - start) % 15 === 0) dumpFrame(lab, `m2-build/frame-${string.format("%03d", frame++)}`)
    })
    awaitBoard(faction, 6000, () => {
      setAiProfiler(undefined)
      dumpFrame(lab, `m2-build/frame-${string.format("%03d", frame++)}`)
      const ticks = game.tick - start
      const board = faction.board
      assert(board.counters.failures === 0, describeBoard(faction))
      assertPlannedBuilt(lab, layout, faction.force)
      assert(builtCount(lab, faction.force) === 40 + 1, `built ${builtCount(lab, faction.force) - 1} (+ stockpile)`)
      assert(ghostCount(lab, faction.force) === 0, "no ghosts left")
      assert(board.counters.doubleClaims === 0, `double claims ${board.counters.doubleClaims}`)
      const audit = auditClaims(board)
      assert(audit === undefined, audit)
      assert(chest.get_inventory(defines.inventory.chest)!.is_empty(), "the stockpile was used up exactly")
      for (const furnace of lab.surface.find_entities_filtered({ name: ["stone-furnace", "burner-inserter"], force: faction.force })) {
        assert(furnace.get_fuel_inventory()!.get_item_count("coal") === FUEL.count, `${furnace.name} fuelled`)
      }
      const lines = [`[m2] 2 crew built 40 entities + 10 fuel jobs in ${ticks} ticks; claims ${board.counters.claims}, releases ${board.counters.releases}`]
      for (const id of faction.crew) {
        const m = storage.crew[id]
        const s = m.stats
        const idle = s.idleTicks / s.ticks
        lines.push(
          `[m2] crew ${id}: jobs ${s.jobsDone}, batches ${s.batches}, hauls ${s.hauls}, idle ${s.idleTicks}/${s.ticks} ticks = ${string.format("%.1f", idle * 100)}%`,
        )
        assert(idle < 0.1, `crew ${id} idle ${idle}`)
        assert(s.jobsDone >= 10, `crew ${id} did its share (${s.jobsDone})`)
      }
      log(lines.join("\n"))
      log(["", "[m2] AI time (crew + controllers), whole build: ", profiler])
      profiler.divide(ticks)
      log(["", "[m2] AI time per tick: ", profiler])
    })
  })

  test("a blocked ghost fails with a reason after bounded retries and blocks nothing else", () => {
    const lab = createLab(32)
    const faction = createFaction(newFactionName("blocked"), { position: at(lab, 0, 12), crew: 2 })
    // Make one burner inserter unplaceable: a neutral wall where it goes (its fuel job depends on it).
    // The wall goes first: script-creating an entity on a ghost would remove the ghost.
    const blockedAt = at(lab, -0.5, -7.5)
    const wall = lab.surface.create_entity({ name: "stone-wall", position: blockedAt, force: "neutral" })
    assert(wall, "obstacle placed")
    const layout = smeltingLayout(lab, faction.force, 0, 0)
    stockpile(lab, faction, 0.5, 8.5, layout.bill)
    planGhosts(faction, { fuel: FUEL })
    const ghost = lab.surface.find_entities_filtered({ position: blockedAt, type: "entity-ghost", limit: 1 })[0]
    assert(ghost && ghost.valid, "the ghost exists under the wall")
    awaitBoard(faction, 6000, () => {
      const board = faction.board
      const failed = []
      for (let id = 1; id < board.nextId; id++) {
        const job = board.jobs[id]
        if (job.status === "failed") failed.push(job)
      }
      assert(failed.length === 2, describeBoard(faction) + ` failed ${failed.length}`)
      const place = failed[0].kind === "place" ? failed[0] : failed[1]
      const fuel = failed[0].kind === "fuel" ? failed[0] : failed[1]
      assert(place.kind === "place" && string.find(place.reason ?? "", "cannot%-place")[0] !== undefined, `reason: ${place.reason}`)
      assert(place.attempts === getConfig().jobMaxAttempts, `attempts ${place.attempts}`)
      assert(fuel.reason === `dep-failed:${place.id}`, `fuel reason ${fuel.reason}`)
      assert(builtCount(lab, faction.force) === 39 + 1, `built ${builtCount(lab, faction.force) - 1}`)
      assert(board.counters.doubleClaims === 0)
      log(`[m2] blocked ghost: failed after ${place.attempts} attempts (${place.reason}); the other 39 built`)
    })
  })

  test("a crew member's death releases its claims and the other finishes the build", () => {
    const lab = createLab(32)
    const faction = createFaction(newFactionName("death"), { position: at(lab, 0, 12), crew: 2 })
    const layout = smeltingLayout(lab, faction.force, 0, 0)
    // Surplus: the dead member's inventory is lost with it.
    stockpile(lab, faction, 0.5, 8.5, layout.bill, 15)
    planGhosts(faction, { fuel: FUEL })
    const victim = storage.crew[faction.crew[0]]
    const survivor = storage.crew[faction.crew[1]]
    let killedAt: number | undefined
    let held: number[] = []
    on_tick((tick) => {
      if (killedAt !== undefined) {
        if (tick === killedAt + 1) {
          const board = faction.board
          for (const id of held) {
            const job = board.jobs[id]
            assert(job.claimedBy !== victim.id, `job ${id} still held by the dead member`)
            assert(job.kind === "haul" ? job.status === "failed" : job.status !== "claimed" || job.claimedBy === survivor.id, `job ${id} released`)
          }
          assert(victim.dead && victim.claims.length === 0, "member marked dead")
        }
        return
      }
      // Kill it mid-batch: holding claims, with some placements already done.
      if (victim.claims.length >= 2 && victim.stats.jobsDone >= 3) {
        held = [...victim.claims]
        killedAt = tick
        victim.character.die()
      }
    })
    awaitBoard(faction, 8000, () => {
      assert(killedAt !== undefined, "the member was killed mid-build")
      assert(faction.board.counters.failures === 0, describeBoard(faction))
      assertPlannedBuilt(lab, layout, faction.force)
      assert(faction.board.counters.doubleClaims === 0)
      const audit = auditClaims(faction.board)
      assert(audit === undefined, audit)
      log(`[m2] death: killed holding ${held.length} claims; survivor finished (${survivor.stats.jobsDone} jobs)`)
    })
  })

  test("two factions build concurrently without taking each other's jobs or materials", () => {
    const labA = createLab(32)
    const labB = createLab(32)
    const a = createFaction(newFactionName("a"), { position: at(labA, 0, 12), crew: 2 })
    const b = createFaction(newFactionName("b"), { position: at(labB, 0, 12), crew: 2 })
    const layoutA = smeltingLayout(labA, a.force, 0, 0)
    const layoutB = smeltingLayout(labB, b.force, 0, 0)
    const chestA = stockpile(labA, a, 0.5, 8.5, layoutA.bill)
    const chestB = stockpile(labB, b, 0.5, 8.5, layoutB.bill)
    planGhosts(a, { fuel: FUEL })
    planGhosts(b, { fuel: FUEL })
    assert(a.board.active.length === 50 && b.board.active.length === 50, "each faction planned only its own ghosts")
    async(8000)
    on_tick(() => {
      if (a.board.active.length > 0 || b.board.active.length > 0) return
      for (const [faction, lab, layout, chest] of [
        [a, labA, layoutA, chestA],
        [b, labB, layoutB, chestB],
      ] as const) {
        assert(faction.board.counters.failures === 0, describeBoard(faction))
        assertPlannedBuilt(lab, layout, faction.force)
        assert(chest.get_inventory(defines.inventory.chest)!.is_empty(), `${faction.name}: its own stockpile used up exactly`)
        for (const e of faction.board.claimLog) assert(faction.crew.indexOf(e.member) >= 0 || e.member === 0, `${faction.name}: claim by outsider ${e.member}`)
        const audit = auditClaims(faction.board)
        assert(audit === undefined, audit)
      }
      // Each crew member only ever stood in its own faction's lab.
      for (const [faction, lab] of [
        [a, labA],
        [b, labB],
      ] as const) {
        for (const id of faction.crew) {
          const p = storage.crew[id].character.position
          assert(math.abs(p.x - lab.origin.x) <= lab.radius, `${faction.name} crew stayed home`)
        }
      }
      done()
    })
  })

  test("D38: a crew member crafts in the background while it builds (queues the craft, walks and places, collects it)", () => {
    // The same scenario twice: crafting standing at the depot (crew-background-crafts 0), then in the background.
    // A craft job (40 gears, 20 s) and 16 chests to place 24 tiles away, one crew member.
    const run = (background: number, then: (ticks: number, faction: FactionState) => void): void => {
      setConfigOverride("crewBackgroundCrafts", background)
      const lab = createLab(32)
      const faction = createFaction(newFactionName(`bgcraft${background}`), { position: at(lab, 0, 0), crew: 1 })
      faction.depositBetweenJobs = true
      const pile = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 0.5, 2.5), force: faction.force })!
      pile.insert({ name: "iron-plate", count: 80 })
      pile.insert({ name: "wooden-chest", count: 16 })
      addStockpile(faction, pile)
      for (let i = 0; i < 16; i++) lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, 24.5 + 2 * (i % 2), -4 + math.floor(i / 2) + 0.5), force: faction.force })
      const tick = game.tick
      addJob(faction.board, { kind: "craft", pos: pile.position, materials: [{ item: "iron-plate", count: 80 }], payload: { kind: "craft", recipe: "iron-gear-wheel", count: 40, item: "iron-gear-wheel", deliverTo: pile } }, tick)
      planGhosts(faction, {})
      on_tick(() => {
        if (faction.board.active.length > 0) return
        if (storage.crew[faction.crew[0]].actions.length > 0) return
        then(game.tick - tick, faction)
        return false
      })
    }
    async(12000)
    run(0, (standing, f0) => {
      assert(f0.board.counters.completions === f0.board.counters.added, describeBoard(f0))
      run(1, (background, f1) => {
        assert(f1.board.counters.completions === f1.board.counters.added, describeBoard(f1))
        const m = storage.crew[f1.crew[0]]
        assert((m.stats.backgroundCrafts ?? 0) >= 1, "the craft ran in the background")
        assert(f1.stockpiles[0].get_item_count("iron-gear-wheel") === 40, "40 gears delivered to the depot")
        log(`[d38] craft + build: standing ${standing} ticks, in the background ${background} ticks`)
        assert(background < standing - 200, `background crafting saves time: ${background} vs ${standing} ticks`)
        done()
      })
    })
  })

  test("every job kind runs: gather, craft, clear, fuel", () => {
    const lab = createLab(24)
    const faction = createFaction(newFactionName("kinds"), { position: at(lab, 0, 0), crew: 1 })
    const ore = lab.surface.create_entity({ name: "iron-ore", position: at(lab, 6.5, 0.5), amount: 50 })!
    const sink = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 4.5, 2.5), force: faction.force })!
    const tree = lab.surface.create_entity({ name: "tree-01", position: at(lab, -6.5, 3.5) })!
    const furnace = lab.surface.create_entity({ name: "stone-furnace", position: at(lab, -4, -4), force: faction.force })!
    const pile = lab.surface.create_entity({ name: "wooden-chest", position: at(lab, 0.5, 4.5), force: faction.force })!
    pile.insert({ name: "iron-plate", count: 4 })
    pile.insert({ name: "coal", count: 3 })
    addStockpile(faction, pile)
    const tick = game.tick
    const board = faction.board
    addJob(board, { kind: "gather", pos: ore.position, payload: { kind: "gather", item: "iron-ore", count: 2, target: ore, deliverTo: sink } }, tick)
    addJob(board, { kind: "craft", pos: { x: 0, y: 0 }, materials: [{ item: "iron-plate", count: 4 }], payload: { kind: "craft", recipe: "iron-gear-wheel", count: 2 } }, tick)
    addJob(board, { kind: "clear", pos: tree.position, payload: { kind: "clear", target: tree } }, tick)
    addJob(board, { kind: "fuel", pos: furnace.position, materials: [{ item: "coal", count: 3 }], payload: { kind: "fuel", item: "coal", count: 3, target: furnace } }, tick)
    const character = storage.crew[faction.crew[0]].character
    awaitBoard(faction, 3000, () => {
      assert(board.counters.completions === board.counters.added, describeBoard(faction))
      assert(sink.get_item_count("iron-ore") === 2, "gathered ore delivered")
      assert(itemCount(character, "iron-gear-wheel") === 2, "crafted from stockpiled plates")
      assert(!tree.valid && itemCount(character, "wood") > 0, "tree cleared")
      assert(furnace.get_fuel_inventory()!.get_item_count("coal") === 3, "furnace fuelled")
    })
  })

  test("a build resumes after a save/reload mid-build", () => {
    const lab = createLab(32)
    const faction = createFaction(newFactionName("reload"), { position: at(lab, 0, 12), crew: 2 })
    const layout = smeltingLayout(lab, faction.force, 0, 0)
    stockpile(lab, faction, 0.5, 8.5, layout.bill)
    planGhosts(faction, { fuel: FUEL })
    storage.testScratch = { faction: faction.name, labOrigin: lab.origin, labRadius: lab.radius, planned: layout.planned }
    // Reload mid-build: once some jobs are done and most are not.
    async(2000)
    on_tick(() => {
      const c = faction.board.counters
      if (c.completions < 10) return
      assert(faction.board.active.length > 20, `mid-build: ${describeBoard(faction)}`)
      storage.testScratch!.doneBeforeReload = c.completions
      done()
      return false
    })
  }).after_reload_script(() => {
    const scratch = storage.testScratch!
    const faction = storage.factions[scratch.faction as string]
    const lab: Lab = { surface: game.surfaces[1], origin: scratch.labOrigin as MapPosition, radius: scratch.labRadius as number }
    assert(faction.board.active.length > 0, "still building after the reload")
    awaitBoard(faction, 6000, () => {
      assert(faction.board.counters.failures === 0, describeBoard(faction))
      assert(faction.board.counters.completions > (scratch.doneBeforeReload as number))
      assertPlannedBuilt(lab, { bill: {}, ghosts: 40, planned: scratch.planned as Layout["planned"] }, faction.force)
      const audit = auditClaims(faction.board)
      assert(audit === undefined, audit)
      storage.testScratch = undefined
    })
  })
})
