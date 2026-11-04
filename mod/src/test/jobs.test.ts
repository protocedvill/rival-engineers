import { LuaEntity, LuaProfiler, MapPosition } from "factorio:runtime"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import { Board, CLAIM_LOG_KEPT } from "../jobs/board"
import { addJob } from "../jobs/board"
import { addClearJob, addPlaceJob, addStockpile, createFaction, destroyFaction, planGhosts } from "../jobs/faction"
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

/** Runs `check` every tick; the test passes when it returns true, and fails (with the board's state) after `timeout` ticks. */
function awaitEscape(faction: FactionState, timeout: number, check: () => boolean, report: () => void): void {
  async(timeout)
  const dead = game.tick + timeout
  on_tick(() => {
    const m = storage.crew[faction.crew[0]]
    if (check()) {
      report()
      done()
      return false
    }
    if (game.tick >= dead) {
      assert(false, `escape did not happen in ${timeout} ticks: ${describeBoard(faction)} unboxed ${m.stats.unboxed ?? 0}`)
      return false
    }
    return undefined
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
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    const config = getConfig()
    assert(!config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1, "debug parity toggles must be off")
  })

  test("B54: a factory build's pole place jobs come before every other job (power first)", () => {
    // Seeds 3333 and 6666666 (m6-prof, 2026-10-21): a goal re-laid a built module's pole line and placed the new poles
    // at build priority among its other work: the module had no power for 25-30 game-minutes.
    const lab = createLab(24)
    const faction = createFaction(newFactionName("power-first"), { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    faction.paused = true
    const ghost = (name: string, x: number): LuaEntity =>
      lab.surface.create_entity({ name: "entity-ghost", inner_name: name, position: at(lab, x, 4), force: faction.force })!
    const pole = addPlaceJob(faction, ghost("small-electric-pole", 0.5), { priority: 90 })!
    const belt = addPlaceJob(faction, ghost("transport-belt", 3.5), { priority: 90 })!
    const loose = addPlaceJob(faction, ghost("small-electric-pole", 6.5), {})!
    assert(faction.board.jobs[pole].priority === getConfig().factoryPowerBuildPriority, `a build's pole: ${faction.board.jobs[pole].priority}`)
    assert(faction.board.jobs[belt].priority === 90, `a build's belt keeps the build priority: ${faction.board.jobs[belt].priority}`)
    assert(faction.board.jobs[loose].priority === 0, `a pole outside a factory build (no priority) is unchanged: ${faction.board.jobs[loose].priority}`)
    setConfigOverride("factoryPowerBuildPriority", 40)
    const low = addPlaceJob(faction, ghost("small-electric-pole", 9.5), { priority: 90 })!
    assert(faction.board.jobs[low].priority === 90, `never below the build's own priority: ${faction.board.jobs[low].priority}`)
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

  test("a batch tours a long belt line: several standing spots per haul (user request 2026-11-03)", () => {
    // One member, 90 belt ghosts in a line from a stockpile at its start: with tours a batch walks on to the next spots,
    // so the line takes fewer batches than one spot per batch (24 jobs from one spot reach at most ~17 tiles of a line).
    // Config overrides are global, so the two runs go one after the other.
    const lab = createLab(64)
    const start = (spots: number, y: number): number => {
      setConfigOverride("batchMaxSpots", spots)
      const faction = createFaction(newFactionName(`tour${spots}`), { position: at(lab, -50, y + 4), crew: 1 })
      for (let x = -45; x < 45; x++) assert(lab.surface.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: at(lab, x + 0.5, y + 0.5), direction: defines.direction.east, force: faction.force }), `ghost at ${x}`)
      stockpile(lab, faction, -50.5, y + 2.5, { "transport-belt": 90 })
      assert(planGhosts(faction, {}) === 90, "90 place jobs")
      return faction.crew[0]
    }
    const finished = (id: number): boolean => storage.crew[id].claims.length === 0 && storage.crew[id].stats.jobsDone >= 90
    const one = start(1, -20)
    let four: number | undefined
    async(30000)
    on_tick(() => {
      if (four === undefined) {
        if (finished(one)) four = start(4, 10)
        return
      }
      if (!finished(four)) return
      const b1 = storage.crew[one].stats.batches
      const b4 = storage.crew[four].stats.batches
      log(`[tour] batches: 1 spot ${b1}, 4 spots ${b4}`)
      clearConfigOverrides()
      assert(b4 < b1, `tours take fewer batches (${b4} against ${b1})`)
      done()
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

  test("B66: a ghost on top of its own live twin is done, not retried forever", () => {
    // Seed 5387208 (grow-ab): a completed mine's pole ghosts landed on poles the same build had just placed. Factorio
    // accepts such a ghost, but it can never be revived: the place job failed cannot-place on every round.
    const lab = createLab(24)
    const faction = createFaction(newFactionName("twin"), { position: at(lab, 0, 6), crew: 1 })
    const pos = at(lab, 2.5, 0.5)
    const live = lab.surface.create_entity({ name: "small-electric-pole", position: pos, force: faction.force })!
    const twin = lab.surface.create_entity({ name: "entity-ghost", inner_name: "small-electric-pole", position: pos, force: faction.force })
    assert(twin !== undefined && twin.valid, "the engine accepts a ghost on its live twin (B41/B66 engine fact)")
    stockpile(lab, faction, 0.5, 8.5, { "small-electric-pole": 1 })
    const id = addPlaceJob(faction, twin!, {})!
    awaitBoard(faction, 3600, () => {
      const job = faction.board.jobs[id]
      assert(job.status === "done", describeBoard(faction))
      assert(!twin!.valid, "the impossible ghost is gone")
      assert(live.valid, "the live pole stays")
    })
  })

  /** A powered roboport with 10 robots and a storage chest of 20 belts for `faction`, and six belt ghosts with place jobs. */
  function robotScene(lab: Lab, faction: FactionState): number[] {
    const f = faction.force
    const eei = lab.surface.create_entity({ name: "electric-energy-interface", position: at(lab, -6, 0), force: f })!
    eei.electric_buffer_size = 1e9
    eei.power_production = 1e7
    lab.surface.create_entity({ name: "medium-electric-pole", position: at(lab, -4, 2), force: f })
    const port = lab.surface.create_entity({ name: "roboport", position: at(lab, 0, 0), force: f })!
    port.get_inventory(defines.inventory.roboport_robot)!.insert({ name: "construction-robot", count: 10 })
    const chest = lab.surface.create_entity({ name: "storage-chest", position: at(lab, 3.5, 3.5), force: f })!
    chest.insert({ name: "transport-belt", count: 20 })
    const ids: number[] = []
    for (let x = -3; x < 3; x++) {
      const g = lab.surface.create_entity({ name: "entity-ghost", inner_name: "transport-belt", position: at(lab, x + 0.5, 10.5), force: f })!
      ids.push(addPlaceJob(faction, g, {})!)
    }
    return ids
  }

  test("M7d.5: a place job whose ghost a construction robot builds is done (robot-built), not failed", () => {
    // The crew has no belts (they are in the network's storage chest, not a stockpile): only the robots can build.
    setConfigOverride("factoryRobotFirstSeconds", 0)
    const lab = createLab(32)
    const faction = createFaction(newFactionName("robots"), { position: at(lab, -10, 8), crew: 1 })
    const ids = robotScene(lab, faction)
    awaitBoard(faction, 3600, () => {
      clearConfigOverrides()
      for (const id of ids) {
        const job = faction.board.jobs[id]
        const p = job.payload as Extract<JobPayload, { kind: "place" }>
        assert(job.status === "done" && job.reason === "robot-built", `job ${id}: ${job.status} (${job.reason}); ${describeBoard(faction)}`)
        assert(p.built !== undefined && p.built.valid && p.built.name === "transport-belt", `job ${id}: the built belt is recorded`)
      }
      assert(itemCount(storage.crew[faction.crew[0]].character, "transport-belt") === 0, "the crew placed none")
    })
  })

  test("M7d.5: robots take down a clear job's tree in range; the job is done (robot-removed)", () => {
    const lab = createLab(32)
    const faction = createFaction(newFactionName("robots-clear"), { position: at(lab, -10, 8), crew: 1 })
    robotScene(lab, faction)
    const tree = lab.surface.create_entity({ name: "tree-01", position: at(lab, 8, -8) })!
    const id = addClearJob(faction, tree)!
    awaitBoard(faction, 3600, () => {
      const job = faction.board.jobs[id]
      assert(job.status === "done" && job.reason === "robot-removed", `clear job: ${job.status} (${job.reason}); ${describeBoard(faction)}`)
      assert(!tree.valid, "the tree is gone")
    })
  })

  test("M7d.5: the crew leaves place jobs the robots can do now to them (factory-robot-first-seconds)", () => {
    // The crew has belts of its own next to it, yet the robots build every ghost.
    const lab = createLab(32)
    const faction = createFaction(newFactionName("robots-first"), { position: at(lab, -10, 8), crew: 1 })
    const own = stockpile(lab, faction, -8.5, 10.5, { "transport-belt": 6 })
    const ids = robotScene(lab, faction)
    awaitBoard(faction, 3600, () => {
      for (const id of ids) {
        const job = faction.board.jobs[id]
        assert(job.status === "done" && job.reason === "robot-built", `job ${id}: ${job.status} (${job.reason}); ${describeBoard(faction)}`)
      }
      assert(own.get_item_count("transport-belt") === 6, `the crew's belts stay (${own.get_item_count("transport-belt")})`)
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
        // B117: the member keeps the chests between placements in both runs (1521 vs 1402 ticks), which narrowed the gap.
        assert(background < standing - 100, `background crafting saves time: ${background} vs ${standing} ticks`)
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

  test("M6: a member boxed in by its own build picks up a pipe, gets out, does its job and the pipe is re-placed", () => {
    const lab = createLab(24)
    const faction = createFaction("m6-boxed", { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    // A closed ring of pipes around the member (pipes collide with characters).
    let ring = 0
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (math.abs(x) !== 2 && math.abs(y) !== 2) continue
        lab.surface.create_entity({ name: "pipe", position: at(lab, x, y), force: faction.force })
        ring++
      }
    }
    const chest = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 10.5, 0.5), force: faction.force })!
    chest.insert({ name: "wooden-chest", count: 1 })
    addStockpile(faction, chest)
    const ghost = lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, 10.5, 6.5), force: faction.force })!
    void ghost
    planGhosts(faction)
    async(60 * 60 * 5)
    on_tick(() => {
      const built = lab.surface.count_entities_filtered({ name: "wooden-chest", force: faction.force }) === 1
      const pipes = lab.surface.count_entities_filtered({ name: "pipe", force: faction.force, area: [at(lab, -3, -3), at(lab, 3, 3)] })
      if (!built || pipes !== ring) return
      const m = storage.crew[faction.crew[0]]
      assert((m.stats.unboxed ?? 0) >= 1, "it picked something up to get out")
      log(`[m6] boxed-in member got out (${m.stats.unboxed} pick-ups), built the chest and re-placed the ring at tick ${game.tick}`)
      done()
      return false
    })
  })

  test("B42: a boxed-in member that picks up an entity scheduled for removal does its clear job and does not re-place it", () => {
    const lab = createLab(24)
    const faction = createFaction("b42-cleared", { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    // A closed ring of iron chests with one pipe in it: the escape picks up the pipe first (pipes rank before
    // containers), and the pipe is what the planner wants gone (an obsolete route piece in report 125521).
    let pipe: LuaEntity | undefined
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (math.abs(x) !== 2 && math.abs(y) !== 2) continue
        const name = x === 2 && y === 0 ? "pipe" : "iron-chest"
        const e = lab.surface.create_entity({ name, position: at(lab, x, y), force: faction.force })!
        if (name === "pipe") pipe = e
      }
    }
    const pipePos = pipe!.position
    // Below the place jobs' priority: the member tries the three chest ghosts outside first, fails to walk to each
    // and is boxed in before it would do the clear job from inside (the pipe is in reach).
    const clearId = addClearJob(faction, pipe!, -1)
    const chest = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 10.5, 0.5), force: faction.force })!
    chest.insert({ name: "wooden-chest", count: 3 })
    addStockpile(faction, chest)
    for (const [x, y] of [[10.5, 8.5], [-9.5, 8.5], [0.5, -9.5]]) {
      lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, x, y), force: faction.force })
    }
    planGhosts(faction)
    awaitEscape(
      faction,
      60 * 60 * 5,
      () => lab.surface.count_entities_filtered({ name: "wooden-chest", force: faction.force }) === 3,
      () => {
        const m = storage.crew[faction.crew[0]]
        const job = faction.board.jobs[clearId]
        assert((m.stats.unboxed ?? 0) >= 1, `it picked nothing up to get out: pipe ${lab.surface.count_entities_filtered({ name: "pipe", position: pipePos })}, ${describeBoard(faction)}`)
        assert(job.status === "done" && job.doneBy === m.id, `clear job ${job.status} by ${tostring(job.doneBy)}: ${describeBoard(faction)}`)
        const back = lab.surface.count_entities_filtered({ name: "pipe", position: pipePos })
        const ghost = lab.surface.count_entities_filtered({ ghost_name: "pipe", position: pipePos })
        assert(back === 0 && ghost === 0, `the cleared pipe came back: ${back} entity, ${ghost} ghost`)
        log(`[b42] boxed-in member did clear job ${clearId} on its way out, no ghost, built the chests at tick ${game.tick}`)
      },
    )
  })

  test("B22: a member boxed in behind trees mines its way out", () => {
    const lab = createLab(32)
    const faction = createFaction("b22-trees", { position: at(lab, 4.5, 4.5), crew: 1, starterItems: {} })
    const names: string[] = []
    for (const [name, proto] of pairs(prototypes.get_entity_filtered([{ filter: "type", type: "tree" }]))) {
      if (proto.mineable_properties.minable && proto.autoplace_specification !== undefined) names.push(name as string)
    }
    names.sort()
    // Two staggered rings of trees around the member: together they seal it off, while the nearest trees sit
    // inside the short hand-mining reach so the member can mine without walking (which is what fails).
    let planted = 0
    for (const [r, n, turn] of [[1.7, 12, 0], [2.5, 16, 0.5 / 2.5]] as [number, number, number][]) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * math.pi + turn
        const tree = lab.surface.create_entity({
          name: names[(k + (r === 1.7 ? 0 : 1)) % math.min(3, names.length)],
          position: { x: lab.origin.x + 4.5 + r * math.cos(a), y: lab.origin.y + 4.5 + r * math.sin(a) },
        })
        if (tree) planted++
      }
    }
    assert(planted >= 20, `trees planted ${planted}`)
    stockpile(lab, faction, 14.5, 4.5, { "wooden-chest": 1 })
    const ghost = lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, 14.5, -3.5), force: faction.force })!
    void ghost
    planGhosts(faction)
    awaitEscape(
      faction,
      60 * 60 * 5,
      () =>
        lab.surface.count_entities_filtered({ name: "wooden-chest", force: faction.force }) === 1 &&
        lab.surface.count_entities_filtered({ type: "tree", area: [at(lab, 0, 0), at(lab, 9, 9)] }) < planted,
      () => {
        const m = storage.crew[faction.crew[0]]
        const standing = lab.surface.count_entities_filtered({ type: "tree", area: [at(lab, 0, 0), at(lab, 9, 9)] })
        assert((m.stats.unboxed ?? 0) >= 1, "it did not mine anything to get out")
        log(`[b22] the member mined ${planted - standing} tree(s) to get out and built the chest at tick ${game.tick}`)
      },
    )
  })

  test("M7c.8: a member walled in with nothing to clear leaves no haul or deposit job open", () => {
    // Seed 11 (fresh-11): 717 "stuck and nothing in reach to clear" unboxes each lost a haul's failed take with its
    // claim held; the leftover claims went back to the board as 2077 open self-jobs nobody may claim, and idle members
    // scanned them every tick (crew 1 -> 21 ms/tick).
    const lab = createLab(40)
    const centre = { x: 0.5, y: 0.5 }
    // Another force's walls: nothing the member may pick up or mine (a script-set water ring did not hold a character
    // on the lab surface: it walked across).
    for (let d = -4; d <= 4; d++) {
      for (const [x, y] of [[d, -4], [d, 4], [-4, d], [4, d]]) lab.surface.create_entity({ name: "stone-wall", position: at(lab, x + 0.5, y + 0.5), force: "player" })
    }
    const faction = createFaction("m7c8-selfjobs", { position: at(lab, centre.x, centre.y), crew: 1, starterItems: {} })
    stockpile(lab, faction, 12.5, 0.5, { "wooden-chest": 3 })
    for (const y of [-6.5, -8.5, -10.5]) lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, 12.5, y), force: faction.force })
    planGhosts(faction)
    const m = storage.crew[faction.crew[0]]
    const openSelf = (): string | undefined => {
      for (const id of faction.board.active) {
        const j = faction.board.jobs[id]
        if ((j.payload.kind === "haul" || j.payload.kind === "deposit") && j.status === "open") return `#${id} ${j.payload.kind} ${j.reason ?? ""}`
      }
      return undefined
    }
    async(3700)
    let left = 3600
    on_tick(() => {
      const open = openSelf()
      assert(open === undefined, `an open self-job: ${open}`)
      if (left-- > 0) return undefined
      assert(m.unboxRetryAt !== undefined, `the member was never found boxed in with nothing to clear: ${describeBoard(faction)}`)
      assert(faction.board.counters.added > 3, `it planned hauls: ${describeBoard(faction)}`)
      done()
      return false
    })
  })

  test("B22: a member enveloped by its own machines picks one up, gets out and the machine is re-placed", () => {
    const lab = createLab(40)
    // Eight 3×3 assemblers at a pitch-3 ring around the spawn leave an enclosed 3×3 pocket at its centre: the
    // member fits there, but the boxes touch in a continuous wall the pathfinder cannot lead out of.
    const centre = { x: 0.5, y: 0.5 }
    const faction = createFaction("b22-machines", { position: at(lab, centre.x, centre.y), crew: 1, starterItems: {} })
    let ring = 0
    for (const [dx, dy] of [[-3, -3], [0, -3], [3, -3], [-3, 0], [3, 0], [-3, 3], [0, 3], [3, 3]]) {
      const machine = lab.surface.create_entity({ name: "assembling-machine-1", position: at(lab, centre.x + dx, centre.y + dy), force: faction.force })
      if (machine) ring++
    }
    assert(ring === 8, `assembler ring placed ${ring}`)
    const stockpileChest = stockpile(lab, faction, 10.5, 0.5, { "wooden-chest": 1 })
    stockpileChest.insert({ name: "assembling-machine-1", count: 1 })
    const ghost = lab.surface.create_entity({ name: "entity-ghost", inner_name: "wooden-chest", position: at(lab, 10.5, -6.5), force: faction.force })!
    void ghost
    planGhosts(faction)
    awaitEscape(
      faction,
      60 * 60 * 5,
      () =>
        lab.surface.count_entities_filtered({ name: "wooden-chest", force: faction.force }) === 1 &&
        lab.surface.count_entities_filtered({ name: "assembling-machine-1", force: faction.force }) === ring,
      () => {
        const m = storage.crew[faction.crew[0]]
        assert((m.stats.unboxed ?? 0) >= 1, "it picked nothing up to get out")
        log(`[b22] enveloped member got out (${m.stats.unboxed} pick-ups), built the chest and re-placed the machines at tick ${game.tick}`)
      },
    )
  })
})
