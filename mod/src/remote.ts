import { LuaEntity, LuaEntityPrototype, MapPosition } from "factorio:runtime"
import { cancel, createController, enqueue, getAction, isIdle } from "./character/controller"
import { ActionSpec } from "./character/types"
import { clearConfigOverrides, Config, ConfigKey, getConfig, setConfigOverride } from "./config"
import { addCrew, addStockpile, createFaction, CreateFactionOptions, destroyFaction, getFaction, planGhosts, PlanGhostsOptions, spawnCrew } from "./jobs/faction"

// Remote interface used by the test harness and tools (SPEC §5.7). Harness code drives the mod only
// through this and settings.

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

/** Writes all entities in a square area to script-output/<file> as JSON, for tools/render. */
function dumpEntities(file: string, center: MapPosition, radius: number): number {
  const surface = game.surfaces[1]
  const entities = surface.find_entities_filtered({
    area: [
      [center.x - radius, center.y - radius],
      [center.x + radius, center.y + radius],
    ],
  })
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
  helpers.write_file(file, helpers.table_to_json({ tick: game.tick, center, radius, entities: out }), false)
  return out.length
}

function mustFaction(name: string) {
  const faction = getFaction(name)
  assert(faction, `no faction ${name}`)
  return faction!
}

function factionStats(name: string) {
  const faction = mustFaction(name)
  const board = faction.board
  const byStatus: Record<string, number> = { open: 0, claimed: 0, done: 0, failed: 0 }
  for (let id = 1; id < board.nextId; id++) {
    const job = board.jobs[id]
    if (job !== undefined) byStatus[job.status]++
  }
  const crew = []
  for (const id of faction.crew) {
    const m = storage.crew[id]
    crew.push({ id, dead: m.dead, claims: m.claims.length, stats: m.stats })
  }
  return { force: faction.force, counters: board.counters, jobs: byStatus, crew }
}

export function registerRemoteInterface(): void {
  remote.add_interface("rival-engineers", {
    version: () => script.active_mods["rival-engineers"],
    dump_entities: dumpEntities,

    // Character Controller (M1). M2's Job Board calls the same functions directly.
    create_controller: (character: LuaEntity) => createController(character),
    enqueue: (controllerId: number, spec: ActionSpec) => enqueue(controllerId, spec),
    cancel: (actionId: number) => cancel(actionId),
    is_idle: (controllerId: number) => isIdle(controllerId),
    /** Status, failure reason and stats of an action (kept for the controller's last 64 actions). */
    action: (actionId: number) => {
      const a = getAction(actionId)
      return a && { id: a.id, kind: a.spec.kind, status: a.status, reason: a.reason, detail: a.detail, stats: a.stats, placed: a.placed }
    },

    // Factions and the Job Board (M2).
    /** Creates a faction (its own LuaForce, neutral to everyone) and returns its force name. */
    create_faction: (name: string, options?: CreateFactionOptions) => createFaction(name, options).force,
    destroy_faction: (name: string) => destroyFaction(name),
    spawn_crew: (faction: string, position: MapPosition) => spawnCrew(mustFaction(faction), position).id,
    add_crew: (faction: string, character: LuaEntity) => addCrew(mustFaction(faction), character).id,
    add_stockpile: (faction: string, chest: LuaEntity) => addStockpile(mustFaction(faction), chest),
    /** Turns the faction's ghosts into place (and optional fuel) jobs; returns the number of place jobs. */
    plan_ghosts: (faction: string, options?: PlanGhostsOptions) => planGhosts(mustFaction(faction), options),
    set_faction_paused: (faction: string, paused: boolean) => {
      mustFaction(faction).paused = paused
    },
    /** Board counters, job counts by status and per-crew stats. */
    faction_stats: (faction: string) => factionStats(faction),

    // Config (SPEC §5.7): tests and the harness override settings here.
    get_config: () => getConfig(),
    set_config_override: <K extends ConfigKey>(key: K, value: Config[K] | undefined) => setConfigOverride(key, value),
    clear_config_overrides: () => clearConfigOverrides(),
  })
}
