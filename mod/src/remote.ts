import { MapPosition } from "factorio:runtime"

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
  })
}
