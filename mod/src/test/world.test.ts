import { LuaSurface, MapPosition } from "factorio:runtime"
import { spawnFaction } from "../autospawn"
import { clearConfigOverrides, getConfig } from "../config"
import { destroyFaction } from "../jobs/faction"
import { exploreNow, positionDistance } from "../world/resources"
import { hasWater, repairStartingLake } from "../world/spawn"

// M5a.2: every faction spawned with a starting area (D32) has water near its spawn, like a player's starting lake.

function newSurface(name: string, seed: number, startingPoints?: MapPosition[]): LuaSurface {
  const existing: LuaSurface | undefined = game.surfaces[name]
  if (existing !== undefined) game.delete_surface(existing)
  const settings: Record<string, unknown> = { seed, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } }
  if (startingPoints) settings.starting_points = startingPoints
  return game.create_surface(name, settings as never)
}

function addStartingPoint(surface: LuaSurface, p: MapPosition): void {
  const mgs = surface.map_gen_settings as unknown as { starting_points?: MapPosition[] }
  mgs.starting_points = [...(mgs.starting_points ?? []), p]
  surface.map_gen_settings = mgs as never
}

describe("starting water", () => {
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("a starting lake whose tiles were generated before its starting point is repainted from the noise", () => {
    const config = getConfig()
    const r = config.spawnWaterRadius
    const p = { x: 336, y: 139 }
    // Correctly generated (point registered first): the repair changes nothing.
    const good = newSurface("water-good", 3709422084, [{ x: 0, y: 0 }, p])
    exploreNow(good, p, r)
    assert(hasWater(good, p, r), "a correctly generated starting area has its lake")
    assert(repairStartingLake(good, p, r, config.spawnLakeRepairMinTiles) === 0, "no repair on a correct starting area")
    // Stale (tiles generated first, as for chunks the engine queued around the origin at game start).
    const stale = newSurface("water-stale", 3709422084)
    exploreNow(stale, p, r)
    const before = stale.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    addStartingPoint(stale, p)
    const repaired = repairStartingLake(stale, p, r, config.spawnLakeRepairMinTiles)
    const after = stale.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    const want = good.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    log(`[water] stale: ${before} water tiles before, ${repaired} repainted, ${after} after; correct generation has ${want}`)
    assert(repaired >= config.spawnLakeRepairMinTiles, `repaired ${repaired} tiles`)
    assert(after >= want * 0.95, `${after} water tiles after the repair, correct generation has ${want}`)
    // Nothing stands in the new water.
    const inWater = stale.find_entities_filtered({ position: p, radius: r, type: ["tree", "simple-entity", "resource"] })
    let wet = 0
    for (const e of inWater) if (stale.get_tile(e.position.x, e.position.y).collides_with("water_tile")) wet++
    assert(wet === 0, `${wet} trees, rocks or ore entities stand in water`)
  })

  test("factions spawned on a new map, next to chunks queued at game start, have water near their spawn", () => {
    const surface = newSurface("water-spawn", 3709422084)
    // Like a new game: the engine queues chunks around the origin and generates them in the background.
    surface.request_to_generate_chunks({ x: 0, y: 0 }, 11)
    after_ticks(3, () => {
      const config = getConfig()
      const a = spawnFaction("water-a", { surface: surface.name })
      const b = spawnFaction("water-b", { surface: surface.name })
      for (const f of [a, b]) {
        const base = f.brain!.base
        assert(hasWater(surface, base, config.spawnWaterRadius), `${f.name} at ${base.x},${base.y} has water within ${config.spawnWaterRadius} tiles (${f.brain!.spawnNote ?? ""})`)
        log(`[water] ${f.name} at ${base.x},${base.y}: ${f.brain!.spawnNote ?? "no note"}`)
      }
      assert(positionDistance(a.brain!.base, b.brain!.base) >= config.spawnMinDistance, "factions apart")
    })
  })
})
