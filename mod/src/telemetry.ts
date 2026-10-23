import { LuaEntity, LuaEntityPrototype, LuaProfiler, LuaSurface, MapPosition } from "factorio:runtime"
import { getConfig } from "./config"
import { brainReport } from "./strategy/bootstrap"
import { exportFactoryGraph, factoryReport } from "./strategy/factory-report"
// Read `partProfilers` through the module: a named import of an exported `let` is a load-time copy in TSTL (always nil here).
import * as profiling from "./profiling"
import { PROFILE_PARTS, setAiProfiler, setPartProfilers } from "./profiling"
import { workReport } from "./work"
import { factionDiagnostics } from "./diagnostics"
import { INFINITE_RESEARCH } from "./strategy/research-queue"

// Telemetry (SPEC §5.6, §7 T3): JSON written through helpers.write_file (server-side only, no gameplay
// effect) for the soak harness, plus entity frame dumps for tools/render. Off unless the intervals are set.

interface DumpedEntity {
  name: string
  type: string
  x: number
  y: number
  direction: number
  force: string
  /** Collision box size (tiles). */
  w: number
  h: number
  /** Footprint in whole tiles, rotation applied. */
  tw: number
  th: number
  /** Ghosts: the planned entity's name and type (footprint fields describe the planned entity). */
  ghost_name?: string
  ghost_type?: string
  /** Non-empty inventories by name (`fuel`, `furnace_source`, `furnace_result`, `chest`...): item → count. */
  inventories?: Record<string, Record<string, number>>
  /** `defines.entity_status` name (machines, drills, inserters, labs...). */
  status?: string
  /** Electric network the entity is on (poles and electric machines): which poles and machines are joined. */
  network?: number
}

let statusNames: Record<number, string> | undefined

/** What an entity holds, its status and electric network, for dumps (review reports, soak frames). */
function entityState(e: LuaEntity, d: DumpedEntity): void {
  const max = e.get_max_inventory_index()
  for (let i = 1; i <= max; i++) {
    const inv = e.get_inventory(i as defines.inventory)
    if (inv === undefined || inv.is_empty()) continue
    const items: Record<string, number> = {}
    for (const c of inv.get_contents()) items[c.name] = (items[c.name] ?? 0) + c.count
    d.inventories ??= {}
    d.inventories[inv.name ?? tostring(i)] = items
  }
  if (e.status !== undefined) {
    if (statusNames === undefined) {
      statusNames = {}
      for (const [k, v] of pairs(defines.entity_status)) statusNames[v as unknown as number] = k as string
    }
    d.status = statusNames[e.status as unknown as number]
  }
  if (e.electric_network_id !== undefined) d.network = e.electric_network_id
}

/**
 * Writes all entities in a square area to script-output/<file> as JSON, for tools/render. With `water`,
 * also lists the water tiles ([x, y] of their top-left corners). With `forPlayer`, only that player's machine writes it
 * (helpers.write_file's for_player: the review report bundle, B34).
 */
export function dumpEntities(file: string, center: MapPosition, radius: number, surface?: LuaSurface, water?: boolean, forPlayer?: number): number {
  const s = surface ?? game.surfaces[1]
  const area = {
    left_top: { x: center.x - radius, y: center.y - radius },
    right_bottom: { x: center.x + radius, y: center.y + radius },
  }
  const entities = s.find_entities_filtered({ area })
  const out: DumpedEntity[] = []
  for (const e of entities) {
    const ghost = e.type === "entity-ghost"
    const proto = ghost ? (e.ghost_prototype as LuaEntityPrototype) : e.prototype
    const box = proto.collision_box
    // Rotated non-square entities swap their footprint.
    const sideways = e.direction === defines.direction.east || e.direction === defines.direction.west
    const d: DumpedEntity = {
      name: e.name,
      type: e.type,
      x: e.position.x,
      y: e.position.y,
      direction: e.direction,
      force: e.force.name,
      w: box.right_bottom.x - box.left_top.x,
      h: box.right_bottom.y - box.left_top.y,
      tw: sideways ? proto.tile_height : proto.tile_width,
      th: sideways ? proto.tile_width : proto.tile_height,
      ghost_name: ghost ? proto.name : undefined,
      ghost_type: ghost ? proto.type : undefined,
    }
    if (!ghost && e.type !== "resource" && e.type !== "tree" && e.type !== "simple-entity") entityState(e, d)
    out.push(d)
  }
  let tiles: [number, number][] | undefined
  if (water) {
    tiles = []
    for (const t of s.find_tiles_filtered({ area, collision_mask: "water_tile" })) tiles.push([t.position.x, t.position.y])
  }
  helpers.write_file(file, helpers.table_to_json({ tick: game.tick, center, radius, entities: out, water: tiles }), false, forPlayer)
  return out.length
}

function researchState(forceName: string) {
  const force = game.forces[forceName]
  if (force === undefined) return undefined
  let researched = 0
  for (const [name, t] of pairs(force.technologies)) if (name !== INFINITE_RESEARCH && t.researched) researched++
  return { current: force.current_research?.name, progress: force.research_progress, researched }
}

let profiler: LuaProfiler | undefined
let profiledFrom = 0

/** Each faction's brain, board, depot, research and crew state (the soak telemetry; also the B34 report bundle). */
export function factionTelemetry() {
  const out: Record<string, unknown> = {}
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    const crew = []
    for (const id of f.crew) {
      const m = storage.crew[id]
      const pocket: Record<string, number> = {}
      if (!m.dead && m.character.valid) for (const e of m.character.get_main_inventory()!.get_contents()) pocket[e.name] = e.count
      const ctrl = storage.controllers[m.controller]
      const lastId = ctrl?.finished[ctrl.finished.length - 1]
      const last = lastId !== undefined ? storage.actions[lastId] : undefined
      const lastAction = last && { kind: last.spec.kind, status: last.status, reason: last.reason, detail: last.detail, tick: last.finishedTick }
      crew.push({ id, dead: m.dead, stats: m.stats, pocket, lastAction, position: m.character.valid ? m.character.position : undefined })
    }
    const board = f.board
    const jobs: Record<string, number> = {}
    for (const id of board.active) {
      const j = board.jobs[id]
      const k = `${j.payload.kind}:${j.status}`
      jobs[k] = (jobs[k] ?? 0) + 1
    }
    const depot: Record<string, number> = {}
    for (const chest of f.stockpiles) if (chest.valid) for (const e of chest.get_inventory(defines.inventory.chest)!.get_contents()) depot[e.name] = (depot[e.name] ?? 0) + e.count
    // A sample of what the board waits on (stall diagnosis).
    const open: unknown[] = []
    for (const id of board.active) {
      const j = board.jobs[id]
      if (j.status !== "open" || open.length >= 12 || (j.payload.kind === "place" && open.length >= 6)) continue
      const p = j.payload as { item?: string; recipe?: string }
      open.push({ id, kind: j.payload.kind, item: p.item ?? p.recipe, materials: j.materials, attempts: j.attempts, retryAt: j.retryAt, reason: j.reason, pos: j.pos })
    }
    out[name] = { openJobs: open, depot, force: f.force, brain: brainReport(f), factory: factoryReport(name), diagnostics: factionDiagnostics(name), research: researchState(f.force), counters: board.counters, activeJobs: jobs, crew }
  }
  return out
}

export function writeTelemetry(): void {
  const tick = game.tick
  helpers.write_file(
    "rival-engineers/telemetry.json",
    helpers.table_to_json({ tick, factions: factionTelemetry(), work: workReport() }),
    false,
  )
  // AI time (crew + controllers + brains) since the last write. Profiler values can only be logged.
  if (profiler) {
    profiler.stop()
    log(["", `[re-telemetry] tick=${tick} ticks=${tick - profiledFrom} ai=`, profiler])
  }
  // The same interval by on_tick subsystem (soak.py: the profile table).
  const parts = profiling.partProfilers
  if (parts !== undefined) for (let i = 0; i < PROFILE_PARTS.length; i++) log(["", `[re-profile] tick=${tick} ticks=${tick - profiledFrom} part=${PROFILE_PARTS[i]} `, parts[i]])
  profiler = helpers.create_profiler(true)
  profiledFrom = tick
  setAiProfiler(profiler)
  const fresh: LuaProfiler[] = []
  for (let i = 0; i < PROFILE_PARTS.length; i++) fresh.push(helpers.create_profiler(true))
  setPartProfilers(fresh)
}

function dumpFrames(): void {
  const config = getConfig()
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    const brain = f.brain
    if (!brain) continue
    const center = brain.hub ?? brain.base
    const frame = `frame-${string.format("%09d", game.tick)}`
    dumpEntities(`rival-engineers/frames/${name}/${frame}.json`, center, config.frameDumpRadius, game.surfaces[f.surface], true)
    // The Factory Graph at the same tick, in its own folder (tools/render --graph-dir overlays it per frame).
    exportFactoryGraph(name, `rival-engineers/graphs/${name}/${frame}.graph.json`)
  }
}

export function onTelemetryTick(): void {
  const config = getConfig()
  const tick = game.tick
  if (config.telemetryIntervalTicks > 0 && tick % config.telemetryIntervalTicks === 0) {
    writeTelemetry()
    if (!storage.allDoneWritten && storage.factionOrder.length > 0) {
      // The soak harness stops once every faction has reached `soak-done-milestone` (M3: the first-electricity materials).
      let all = true
      for (const name of storage.factionOrder) {
        const brain = storage.factions[name].brain
        if (!brain || brain.milestones[config.soakDoneMilestone] === undefined) all = false
      }
      if (all) {
        storage.allDoneWritten = true
        helpers.write_file("rival-engineers/done.json", helpers.table_to_json({ tick }), false)
      }
    }
  }
  if (config.frameDumpIntervalTicks > 0 && tick % config.frameDumpIntervalTicks === 0) dumpFrames()
}
