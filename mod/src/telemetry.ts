import { LuaEntityPrototype, LuaProfiler, LuaSurface, MapPosition } from "factorio:runtime"
import { getConfig } from "./config"
import { brainReport } from "./strategy/bootstrap"
import { setAiProfiler } from "./profiling"

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
}

/**
 * Writes all entities in a square area to script-output/<file> as JSON, for tools/render. With `water`,
 * also lists the water tiles ([x, y] of their top-left corners).
 */
export function dumpEntities(file: string, center: MapPosition, radius: number, surface?: LuaSurface, water?: boolean): number {
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
    out.push({
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
    })
  }
  let tiles: [number, number][] | undefined
  if (water) {
    tiles = []
    for (const t of s.find_tiles_filtered({ area, collision_mask: "water_tile" })) tiles.push([t.position.x, t.position.y])
  }
  helpers.write_file(file, helpers.table_to_json({ tick: game.tick, center, radius, entities: out, water: tiles }), false)
  return out.length
}

let profiler: LuaProfiler | undefined
let profiledFrom = 0

function factionTelemetry() {
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
    out[name] = { depot, force: f.force, brain: brainReport(f), counters: board.counters, activeJobs: jobs, crew }
  }
  return out
}

export function writeTelemetry(): void {
  const tick = game.tick
  helpers.write_file(
    "rival-engineers/telemetry.json",
    helpers.table_to_json({ tick, factions: factionTelemetry() }),
    false,
  )
  // AI time (crew + controllers + brains) since the last write. Profiler values can only be logged.
  if (profiler) {
    profiler.stop()
    log(["", `[re-telemetry] tick=${tick} ticks=${tick - profiledFrom} ai=`, profiler])
  }
  profiler = helpers.create_profiler(true)
  profiledFrom = tick
  setAiProfiler(profiler)
}

function dumpFrames(): void {
  const config = getConfig()
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    const brain = f.brain
    if (!brain) continue
    const center = brain.hub ?? brain.base
    dumpEntities(`rival-engineers/frames/${name}/frame-${string.format("%09d", game.tick)}.json`, center, config.frameDumpRadius, game.surfaces[f.surface], true)
  }
}

export function onTelemetryTick(): void {
  const config = getConfig()
  const tick = game.tick
  if (config.telemetryIntervalTicks > 0 && tick % config.telemetryIntervalTicks === 0) {
    writeTelemetry()
    if (!storage.allDoneWritten && storage.factionOrder.length > 0) {
      // The soak harness stops once every faction has gathered the first-electricity materials (M3).
      let all = true
      for (const name of storage.factionOrder) {
        const brain = storage.factions[name].brain
        if (!brain || brain.milestones["first-electricity-materials"] === undefined) all = false
      }
      if (all) {
        storage.allDoneWritten = true
        helpers.write_file("rival-engineers/done.json", helpers.table_to_json({ tick }), false)
      }
    }
  }
  if (config.frameDumpIntervalTicks > 0 && tick % config.frameDumpIntervalTicks === 0) dumpFrames()
}
