import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"

// Test lab: a cleared, flat, generated area far from spawn, one per test, so tests don't interact.

let nextLab = 0

export interface Lab {
  surface: LuaSurface
  origin: MapPosition
  radius: number
}

export function createLab(radius = 32): Lab {
  const surface = game.surfaces[1]
  // Labs march along y = 2000 in steps of 4 * radius.
  const origin = { x: 4 * radius * nextLab++, y: 2000 }
  surface.request_to_generate_chunks(origin, Math.ceil(radius / 32) + 1)
  surface.force_generate_chunk_requests()
  const area = {
    left_top: { x: origin.x - radius, y: origin.y - radius },
    right_bottom: { x: origin.x + radius, y: origin.y + radius },
  }
  for (const e of surface.find_entities(area)) if (e.valid) e.destroy()
  const tiles = []
  for (let x = area.left_top.x; x < area.right_bottom.x; x++) {
    for (let y = area.left_top.y; y < area.right_bottom.y; y++) {
      tiles.push({ name: "grass-1", position: { x, y } })
    }
  }
  surface.set_tiles(tiles)
  return { surface, origin, radius }
}

export function at(lab: Lab, dx: number, dy: number): MapPosition {
  return { x: lab.origin.x + dx, y: lab.origin.y + dy }
}

export function spawnEngineer(lab: Lab, dx = 0, dy = 0): LuaEntity {
  const character = lab.surface.create_entity({ name: "character", position: at(lab, dx, dy), force: "player" })
  assert(character, "character spawned")
  return character!
}

export function itemCount(character: LuaEntity, item: string): number {
  return character.get_main_inventory()!.get_item_count(item)
}

/** Runs `fn` every tick for `ticks` ticks (on_tick handlers otherwise keep a test alive forever). */
export function everyTickFor(ticks: number, fn: () => void): void {
  let remaining = ticks
  on_tick(() => {
    if (remaining-- <= 0) return false
    fn()
  })
}
