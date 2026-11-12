import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"
import { FORCE_PREFIX } from "../jobs/faction"

// Test lab: a cleared, flat, generated area far from spawn, one per test, so tests don't interact.

let nextLabX = 0

export interface Lab {
  surface: LuaSurface
  origin: MapPosition
  radius: number
}

/** Forces in the game (Factorio allows 64) at which a new lab frees stale faction forces. */
const STALE_FORCE_LIMIT = 56

/**
 * Factorio allows 64 forces, and a destroyed test faction keeps its force: a T2 shard that created ~60 factions failed
 * every later `createFaction` with "Too many forces" (M7c.8). Near the limit, a new lab merges the forces of factions
 * that no longer exist into neutral; the engine frees them at the end of the tick. Only near it: a merged force stays
 * until then, and a test that recreates its faction under the same name in that tick (the reconciler tests' `rec-1`)
 * reuses it and loses it at the tick's end.
 */
function freeStaleForces(): void {
  let count = 0
  for (const [_name] of pairs(game.forces)) count++
  if (count < STALE_FORCE_LIMIT) return
  const live: Record<string, boolean> = {}
  for (const [, f] of pairs(storage.factions ?? {})) live[f.force] = true
  for (const [name, force] of pairs(game.forces)) {
    const n = name as string
    if (string.sub(n, 1, FORCE_PREFIX.length) === FORCE_PREFIX && !live[n]) game.merge_forces(force, "neutral")
  }
}

export function createLab(radius = 32): Lab {
  freeStaleForces()
  const surface = game.surfaces[1]
  // Labs march along y = 2000 with a gap between them, whatever their sizes.
  const origin = { x: nextLabX + radius, y: 2000 }
  nextLabX += 2 * radius + 64
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
