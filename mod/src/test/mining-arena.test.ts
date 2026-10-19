import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"
import { cancel, createController, destroyController, enqueue, getAction } from "../character/controller"
import { distance } from "../character/steering"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import { addJob } from "../jobs/board"
import { addClearJob, addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { at, createLab, Lab } from "./lab"

// B1 mining arena (T2): a character mines every tree and rock prototype from every direction, off the tile grid, in
// dense clusters, over ore, next to buildings and belts, and in a real generated forest. Each target counts as mined
// only when the action succeeded *and* the target is gone (or, for a counted gather, the count arrived). The tests log
// "[arena]" lines (success rate, time per target, failures by reason) and hold a bar.

/** Ticks a single target may take (walk + mine) before it counts as a failure. */
const TARGET_TIMEOUT = 1800
/** Cells running at once (the pathfinder serves a few requests per tick; a crowd would measure its queue). */
const CONCURRENT = 12

interface Target {
  entity: LuaEntity
  /** For counted gathers (a gather job's wood or ore): the action's `count`. */
  count?: number
  item?: string
  label: string
}

interface Cell {
  character: LuaEntity
  controller: number
  targets: Target[]
  current?: { action: number; target: Target; started: number; baseline: number }
}

interface Outcome {
  label: string
  ok: boolean
  ticks: number
  reason?: string
}

export interface ArenaSummary {
  group: string
  ok: number
  total: number
  meanTicks: number
  p90Ticks: number
  maxTicks: number
  failures: Record<string, number>
}

function treeNames(): string[] {
  const names: string[] = []
  for (const [name, proto] of pairs(prototypes.get_entity_filtered([{ filter: "type", type: "tree" }]))) {
    if (proto.mineable_properties.minable && proto.autoplace_specification !== undefined) names.push(name as string)
  }
  names.sort()
  return names
}

function rockNames(): string[] {
  const names: string[] = []
  for (const [name, proto] of pairs(prototypes.get_entity_filtered([{ filter: "type", type: "simple-entity" }]))) {
    if (proto.mineable_properties.minable && proto.count_as_rock_for_filtered_deconstruction && proto.autoplace_specification !== undefined) {
      names.push(name as string)
    }
  }
  names.sort()
  return names
}

function firstProduct(entity: LuaEntity): { item: string; amount: number } | undefined {
  const p = entity.prototype.mineable_properties.products?.[0]
  if (!p || p.type !== "item") return undefined
  return { item: p.name, amount: p.amount ?? p.amount_min ?? 1 }
}

function count(character: LuaEntity, item: string | undefined): number {
  return item === undefined ? 0 : character.get_main_inventory()!.get_item_count(item)
}

/** The nearest remaining valid target to the character (list order breaks ties). */
function nextTarget(cell: Cell): Target | undefined {
  let best: Target | undefined
  let bestIndex = -1
  let bestD = 0
  for (let i = cell.targets.length - 1; i >= 0; i--) if (!cell.targets[i].entity.valid) cell.targets.splice(i, 1)
  for (let i = 0; i < cell.targets.length; i++) {
    const t = cell.targets[i]
    const d = distance(cell.character.position, t.entity.position)
    if (best === undefined || d < bestD - 1e-9) {
      best = t
      bestIndex = i
      bestD = d
    }
  }
  if (bestIndex >= 0) cell.targets.splice(bestIndex, 1)
  return best
}

function finishTarget(cell: Cell, outcomes: Outcome[], tick: number): void {
  const cur = cell.current!
  const action = getAction(cur.action)!
  const t = cur.target
  const ticks = tick - cur.started
  let ok: boolean
  let reason: string | undefined
  if (t.count !== undefined) {
    ok = action.status === "succeeded" && count(cell.character, t.item) - cur.baseline >= t.count
    if (!ok) reason = action.status === "succeeded" ? "short-count" : `${action.reason ?? action.status}`
  } else {
    ok = action.status === "succeeded" && !t.entity.valid
    if (!ok) reason = action.status === "succeeded" ? "stopped-early" : `${action.reason ?? action.status}`
  }
  if (!ok) {
    let why = ""
    const ch = cell.character
    if (t.entity.valid && ch.valid) {
      ch.update_selected_entity(t.entity.position)
      const sel = ch.selected
      why = string.format(
        " | char %.2f,%.2f target %s %.2f,%.2f d=%.2f reach=%s selected=%s",
        ch.position.x,
        ch.position.y,
        t.entity.name,
        t.entity.position.x,
        t.entity.position.y,
        distance(ch.position, t.entity.position),
        tostring(ch.can_reach_entity(t.entity)),
        sel ? string.format("%s %.2f,%.2f reach=%s", sel.name, sel.position.x, sel.position.y, tostring(ch.can_reach_entity(sel))) : "none",
      )
    }
    log(`[arena] FAIL ${t.label}: ${action.status} ${action.reason ?? ""} ${action.detail ?? ""} after ${ticks} ticks${why}`)
  }
  outcomes.push({ label: t.label, ok, ticks, reason })
  cell.current = undefined
}

function summarize(group: string, outcomes: Outcome[], collateral: number): ArenaSummary {
  const ticks: number[] = []
  const failures: Record<string, number> = {}
  let ok = 0
  let sum = 0
  for (const o of outcomes) {
    if (o.ok) {
      ok++
      ticks.push(o.ticks)
      sum += o.ticks
    } else failures[o.reason ?? "?"] = (failures[o.reason ?? "?"] ?? 0) + 1
  }
  table.sort(ticks)
  const s: ArenaSummary = {
    group,
    ok,
    total: outcomes.length,
    meanTicks: ticks.length > 0 ? sum / ticks.length : 0,
    p90Ticks: ticks.length > 0 ? ticks[math.min(ticks.length - 1, math.floor(ticks.length * 0.9))] : 0,
    maxTicks: ticks.length > 0 ? ticks[ticks.length - 1] : 0,
    failures,
  }
  const parts: string[] = []
  for (const r in failures) parts.push(`${r}=${failures[r]}`)
  table.sort(parts)
  log(
    string.format(
      "[arena] %s: %d/%d mined (%.1f%%), mean %.0f ticks, p90 %d, max %d, mined as obstacles %d, failures: %s",
      group,
      ok,
      outcomes.length,
      outcomes.length > 0 ? (100 * ok) / outcomes.length : 100,
      s.meanTicks,
      s.p90Ticks,
      s.maxTicks,
      collateral,
      parts.length > 0 ? parts.join(" ") : "none",
    ),
  )
  storage.testScratch ??= {}
  const all = (storage.testScratch.arena ?? {}) as Record<string, ArenaSummary>
  all[group] = s
  storage.testScratch.arena = all
  return s
}

/**
 * Runs every cell (CONCURRENT at a time): each character mines its targets nearest first. Calls `check` with the
 * summary when every target is done. Async test helper.
 */
function runArena(group: string, cells: Cell[], check: (this: void, s: ArenaSummary) => void): void {
  let total = 0
  for (const c of cells) total += c.targets.length
  async(TARGET_TIMEOUT * total + 600)
  const outcomes: Outcome[] = []
  let collateral = 0
  const waiting = [...cells]
  const active: Cell[] = []
  on_tick(() => {
    const tick = game.tick
    while (active.length < CONCURRENT && waiting.length > 0) active.push(waiting.shift()!)
    for (let i = active.length - 1; i >= 0; i--) {
      const cell = active[i]
      if (cell.current) {
        const action = getAction(cell.current.action)!
        if (action.status === "queued" || action.status === "running") {
          if (tick - cell.current.started > TARGET_TIMEOUT) cancel(cell.current.action)
          else continue
        }
        finishTarget(cell, outcomes, tick)
      }
      const before = cell.targets.length
      const t = nextTarget(cell)
      // Targets that vanished before their turn were mined as another target's obstacle.
      collateral += before - cell.targets.length - (t ? 1 : 0)
      if (!t) {
        active.splice(i, 1)
        destroyController(cell.controller)
        if (cell.character.valid) cell.character.destroy()
        continue
      }
      const spec = t.count !== undefined ? { kind: "mine" as const, target: t.entity, count: t.count } : { kind: "mine" as const, target: t.entity }
      cell.current = { action: enqueue(cell.controller, spec), target: t, started: tick, baseline: count(cell.character, t.item) }
    }
    if (active.length === 0 && waiting.length === 0) {
      check(summarize(group, outcomes, collateral))
      done()
    }
  })
}

function newCell(surface: LuaSurface, start: MapPosition, targets: Target[]): Cell {
  const pos = surface.find_non_colliding_position("character", start, 8, 0.25) ?? start
  const character = surface.create_entity({ name: "character", position: pos, force: "player" })!
  return { character, controller: createController(character), targets }
}

/** Off-grid offsets inside a tile, cycled per target. */
const JITTER: MapPosition[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.13, y: 0.71 },
  { x: 0.97, y: 0.02 },
  { x: 0.31, y: 0.27 },
  { x: 0.66, y: 0.94 },
]

function clearTarget(entity: LuaEntity, label: string): Target {
  return { entity, label }
}

/** As a gather job for wood: mine until the tree's yield arrived. */
function gatherTarget(entity: LuaEntity, label: string): Target {
  const p = firstProduct(entity)
  return p ? { entity, label, count: p.amount, item: p.item } : { entity, label }
}

/** Cell grid inside one lab: cell `i` is centred at `cellCentre(lab, i, size)`. */
function cellCentre(lab: Lab, i: number, size: number): MapPosition {
  const perRow = math.floor((2 * lab.radius) / size)
  const col = i % perRow
  const row = math.floor(i / perRow)
  return at(lab, -lab.radius + size * col + size / 2, -lab.radius + size * row + size / 2)
}

function add(p: MapPosition, dx: number, dy: number): MapPosition {
  return { x: p.x + dx, y: p.y + dy }
}

function realSurface(name: string, seed: number): LuaSurface {
  const existing: LuaSurface | undefined = game.surfaces[name]
  if (existing !== undefined) return existing
  return game.create_surface(name, { seed, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
}

describe("mining arena (B1)", () => {
  before_each(() => {
    clearConfigOverrides()
    const config = getConfig()
    assert(!config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1, "debug parity toggles must be off")
  })

  test("every tree and rock prototype from 8 directions, off the grid", () => {
    const names = [...treeNames(), ...rockNames()]
    assert(names.length >= 10, `found ${names.length} tree/rock prototypes`)
    const size = 22
    const cellsNeeded = names.length * 8
    const lab = createLab(math.ceil(math.sqrt(cellsNeeded)) * size / 2 + size)
    const cells: Cell[] = []
    let i = 0
    for (const name of names) {
      for (let k = 0; k < 8; k++) {
        const c = cellCentre(lab, i, size)
        const j = JITTER[(i + k) % JITTER.length]
        const pos = { x: math.floor(c.x) + j.x, y: math.floor(c.y) + j.y }
        const entity = lab.surface.create_entity({ name, position: pos })!
        const a = (k / 8) * 2 * math.pi
        const label = `${name} dir${k}`
        // Trees alternate between a clear job (mine until gone) and a wood gather (mine until the yield arrived).
        const target = entity.type === "tree" && k % 2 === 1 ? gatherTarget(entity, label) : clearTarget(entity, label)
        cells.push(newCell(lab.surface, add(pos, 8 * math.cos(a), 8 * math.sin(a)), [target]))
        i++
      }
    }
    runArena("prototypes x directions", cells, (s) => assert(s.ok === s.total, `${s.total - s.ok} of ${s.total} not mined`))
  })

  test("dense clusters of mixed trees and rocks", () => {
    const trees = treeNames()
    const rocks = rockNames()
    const lab = createLab(64)
    const rng = game.create_random_generator(4242)
    const cells: Cell[] = []
    for (let c = 0; c < 4; c++) {
      const centre = cellCentre(lab, c, 64)
      const targets: Target[] = []
      // 30 trees in an 8×8 area at random positions (they may overlap, as in generated forests) and 3 rocks.
      for (let n = 0; n < 30; n++) {
        const name = trees[(c * 7 + n) % trees.length]
        const pos = add(centre, rng() * 8 - 4, rng() * 8 - 4)
        const e = lab.surface.create_entity({ name, position: pos })!
        targets.push(n % 3 === 0 ? gatherTarget(e, `cluster${c} ${name}`) : clearTarget(e, `cluster${c} ${name}`))
      }
      for (let n = 0; n < 3; n++) {
        const name = rocks[(c + n) % rocks.length]
        const e = lab.surface.create_entity({ name, position: add(centre, rng() * 10 - 5, rng() * 10 - 5) })!
        targets.push(clearTarget(e, `cluster${c} ${name}`))
      }
      cells.push(newCell(lab.surface, add(centre, -10, -10 + c * 4), targets))
    }
    runArena("dense clusters", cells, (s) => assert(s.ok === s.total, `${s.total - s.ok} of ${s.total} not mined`))
  })

  test("trees over ore: hand-mine the ore under them, then clear them", () => {
    const trees = treeNames()
    const lab = createLab(48)
    const rng = game.create_random_generator(777)
    const cells: Cell[] = []
    for (let c = 0; c < 4; c++) {
      const centre = cellCentre(lab, c, 48)
      const ox = math.floor(centre.x) - 4
      const oy = math.floor(centre.y) - 4
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) lab.surface.create_entity({ name: "iron-ore", position: { x: ox + x + 0.5, y: oy + y + 0.5 }, amount: 500 })
      const ores: Target[] = []
      const clears: Target[] = []
      for (let n = 0; n < 10; n++) {
        const name = trees[(c * 5 + n) % trees.length]
        const pos = { x: ox + 0.5 + rng() * 7, y: oy + 0.5 + rng() * 7 }
        const tree = lab.surface.create_entity({ name, position: pos })!
        if (n % 2 === 0) {
          const ore: LuaEntity | undefined = lab.surface.find_entities_filtered({ type: "resource", position: { x: math.floor(pos.x) + 0.5, y: math.floor(pos.y) + 0.5 } })[0]
          if (ore !== undefined) ores.push({ entity: ore, count: 3, item: "iron-ore", label: `ore under ${name}` })
        }
        clears.push(clearTarget(tree, `${name} on ore`))
      }
      cells.push(newCell(lab.surface, add(centre, -12, c * 3 - 6), [...ores]))
      cells.push(newCell(lab.surface, add(centre, 12, c * 3 - 6), clears))
    }
    runArena("trees over ore", cells, (s) => assert(s.ok === s.total, `${s.total - s.ok} of ${s.total} not mined`))
  })

  test("trees and rocks next to buildings and belts", () => {
    const trees = treeNames()
    const rocks = rockNames()
    const lab = createLab(48)
    const rng = game.create_random_generator(99)
    const cells: Cell[] = []
    for (let c = 0; c < 4; c++) {
      const centre = cellCentre(lab, c, 48)
      const ox = math.floor(centre.x)
      const oy = math.floor(centre.y)
      const build = (name: string, x: number, y: number, direction?: defines.direction): void => {
        lab.surface.create_entity({ name, position: { x: ox + x, y: oy + y }, direction, force: "player" })
      }
      // A burner-drill pair, a furnace row with a one-tile gap between furnaces, a belt line and chests.
      build("burner-mining-drill", -5, -5)
      build("burner-mining-drill", -3, -5, defines.direction.south)
      for (let k = 0; k < 4; k++) build("stone-furnace", -5 + k * 3, 0)
      for (let x = -6; x < 6; x++) build("transport-belt", x + 0.5, 3.5, defines.direction.east)
      build("wooden-chest", 2.5, -4.5)
      build("wooden-chest", 4.5, -4.5)
      const targets: Target[] = []
      const spots: MapPosition[] = [
        { x: -2.5 + rng() * 0.6, y: 0.2 + rng() * 0.6 }, // in the gap between two furnaces
        { x: 0.5 + rng() * 0.6, y: -0.3 + rng() * 0.6 }, // the next gap
        { x: -6.8, y: -5 + rng() }, // west of the drill pair
        { x: -4, y: -3 + rng() * 0.3 }, // just south of the drills
        { x: rng() * 4 - 2, y: 2.4 }, // between the furnaces and the belt
        { x: rng() * 4 - 2, y: 4.6 }, // south of the belt
        { x: 3.5, y: -4.5 + rng() * 0.4 }, // between the chests
        { x: 7.2, y: 0.1 }, // east end of the furnace row
      ]
      for (let n = 0; n < spots.length; n++) {
        const name = n === 7 ? rocks[c % rocks.length] : trees[(c * 3 + n) % trees.length]
        const e = lab.surface.create_entity({ name, position: { x: ox + spots[n].x, y: oy + spots[n].y } })!
        targets.push(n % 2 === 1 && e.type === "tree" ? gatherTarget(e, `${name} by buildings #${n}`) : clearTarget(e, `${name} by buildings #${n}`))
      }
      // Come from the side away from most of the buildings.
      cells.push(newCell(lab.surface, add(centre, c % 2 === 0 ? 0 : -14, c % 2 === 0 ? 14 : 0), targets))
    }
    runArena("next to buildings", cells, (s) => assert(s.ok === s.total, `${s.total - s.ok} of ${s.total} not mined`))
  })

  test("a real generated forest (two seeds)", () => {
    const cells: Cell[] = []
    for (const seed of [123, 98765]) {
      const surface = realSurface(`arena-forest-${seed}`, seed)
      surface.request_to_generate_chunks({ x: 0, y: 0 }, 6)
      surface.force_generate_chunk_requests()
      // The densest 24×24 window within 160 tiles of the origin.
      let best: MapPosition = { x: 0, y: 0 }
      let bestN = -1
      for (let x = -160; x < 160; x += 24) {
        for (let y = -160; y < 160; y += 24) {
          const n = surface.count_entities_filtered({ area: [[x, y], [x + 24, y + 24]], type: "tree" })
          if (n > bestN) {
            bestN = n
            best = { x: x + 12, y: y + 12 }
          }
        }
      }
      const found = surface.find_entities_filtered({ position: best, radius: 9, type: ["tree", "simple-entity"] })
      const targets: Target[] = []
      for (let n = 0; n < found.length && targets.length < 40; n++) {
        const e = found[n]
        if (!e.minable) continue
        targets.push(n % 3 === 0 && e.type === "tree" ? gatherTarget(e, `forest${seed} ${e.name}`) : clearTarget(e, `forest${seed} ${e.name}`))
      }
      log(`[arena] forest seed ${seed}: ${bestN} trees in the densest window at ${best.x},${best.y}; ${targets.length} targets`)
      cells.push(newCell(surface, add(best, 0, 12), targets))
    }
    runArena("real forest", cells, (s) => assert(s.ok === s.total, `${s.total - s.ok} of ${s.total} not mined`))
  })
})

interface CrewRun {
  faction: FactionState
  jobs: number[]
  done: number
  failed: number
  releases: number
  ticks: number
  deposits: number
  trips: number
}

/** A crew of one clears (and cuts wood from) the densest forest window of a seed, through the Job Board. */
function startCrewRun(tag: string, seed: number): CrewRun {
  const surface = realSurface(`arena-crew-${tag}-${seed}`, seed)
  surface.request_to_generate_chunks({ x: 0, y: 0 }, 6)
  surface.force_generate_chunk_requests()
  let best: MapPosition = { x: 0, y: 0 }
  let bestN = -1
  for (let x = -160; x < 160; x += 24) {
    for (let y = -160; y < 160; y += 24) {
      const n = surface.count_entities_filtered({ area: [[x, y], [x + 24, y + 24]], type: "tree" })
      if (n > bestN) {
        bestN = n
        best = { x: x + 12, y: y + 12 }
      }
    }
  }
  const faction = createFaction(`arena-${tag}-${seed}`, { surface: surface.name, position: add(best, 0, 22), crew: 1 })
  faction.depositBetweenJobs = true
  const depotAt = surface.find_non_colliding_position("wooden-chest", add(best, 2, 22), 8, 1)!
  const depot = surface.create_entity({ name: "wooden-chest", position: depotAt, force: faction.force })!
  addStockpile(faction, depot)
  const found = surface.find_entities_filtered({ position: best, radius: 10, type: ["tree", "simple-entity"] })
  const jobs: number[] = []
  for (let n = 0; n < found.length && jobs.length < 40; n++) {
    const e = found[n]
    if (!e.minable) continue
    const p = firstProduct(e)
    if (n % 3 === 0 && e.type === "tree" && p) {
      const job = addJob(faction.board, { kind: "gather", pos: e.position, payload: { kind: "gather", item: p.item, count: p.amount, target: e, deliverTo: depot } }, game.tick)
      jobs.push(job.id)
    } else jobs.push(addClearJob(faction, e))
  }
  return { faction, jobs, done: 0, failed: 0, releases: 0, ticks: 0, deposits: 0, trips: 0 }
}

/** True once every job of the run is done or failed (fills in the counts). */
function crewRunFinished(run: CrewRun, started: number): boolean {
  let open = 0
  run.done = 0
  run.failed = 0
  for (const id of run.jobs) {
    const job = run.faction.board.jobs[id]
    if (job.status === "done") run.done++
    else if (job.status === "failed") run.failed++
    else open++
  }
  const member = storage.crew[run.faction.crew[0]]
  run.releases = member.stats.jobsReleased
  run.deposits = member.stats.deposits ?? 0
  run.trips = member.stats.trips ?? 0
  run.ticks = game.tick - started
  // Finished when no job is open and the crew member emptied its pockets.
  return open === 0 && member.actions.length === 0
}

function logCrewRun(label: string, run: CrewRun): void {
  log(
    string.format(
      "[arena] crew %s: %d/%d jobs done, %d failed, %d releases, %d depot deposits, %d trips, %.1f game-s",
      label,
      run.done,
      run.jobs.length,
      run.failed,
      run.releases,
      run.deposits,
      run.trips,
      run.ticks / 60,
    ),
  )
}

describe("mining arena: crew (B1, B3)", () => {
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("a crew member clears a real forest: every job done, one depot trip per batch", () => {
    async(60 * 60 * 30)
    const seed = 123
    // The same forest twice (two surfaces with one seed): a depot round trip per job, then trips.
    let phase: "single" | "trips" = "single"
    setConfigOverride("tripMaxJobs", 1)
    let run = startCrewRun("single", seed)
    let started = game.tick
    let single: CrewRun | undefined
    on_tick(() => {
      if ((game.tick - started) % 60 !== 0 || !crewRunFinished(run, started)) return
      logCrewRun(phase === "single" ? "one job per trip" : "trip batching", run)
      if (phase === "single") {
        single = run
        destroyFaction(run.faction.name)
        clearConfigOverrides()
        phase = "trips"
        run = startCrewRun("trips", seed)
        started = game.tick
        return
      }
      const s = single!
      assert(s.done === s.jobs.length, `one job per trip: ${s.jobs.length - s.done} of ${s.jobs.length} jobs not done`)
      assert(run.done === run.jobs.length, `trips: ${run.jobs.length - run.done} of ${run.jobs.length} jobs not done`)
      const bound = math.ceil(run.jobs.length / getConfig().tripMaxJobs) + 1
      assert(run.deposits <= bound, `trips: ${run.deposits} depot deposits for ${run.jobs.length} jobs (bound ${bound})`)
      assert(run.ticks < s.ticks, `trips took ${run.ticks} ticks, one job per trip ${s.ticks}`)
      done()
    })
  })
})
