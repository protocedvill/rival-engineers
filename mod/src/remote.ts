import { LuaEntity, MapPosition } from "factorio:runtime"
import { cancel, createController, enqueue, getAction, isIdle } from "./character/controller"
import { ActionSpec } from "./character/types"
import { clearConfigOverrides, Config, ConfigKey, getConfig, setConfigOverride } from "./config"

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
    const proto = e.prototype
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
    })
  }
  helpers.write_file(file, helpers.table_to_json({ tick: game.tick, center, radius, entities: out }), false)
  return out.length
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

    // Config (SPEC §5.7): tests and the harness override settings here.
    get_config: () => getConfig(),
    set_config_override: <K extends ConfigKey>(key: K, value: Config[K] | undefined) => setConfigOverride(key, value),
    clear_config_overrides: () => clearConfigOverrides(),
  })
}
