import { LuaSurface, MapPosition } from "factorio:runtime"
import { Config } from "../config"
import { distanceToPatch, exploreNow, Patch, positionDistance, scanPatches } from "./resources"

// Faction spawn placement (SPEC §5.7) and starter items (D5).

export interface SpawnChoice {
  position: MapPosition
  /** Patches found within the resource radius when the spot was checked. */
  patches: Patch[]
  /** How many candidate spots were checked. */
  checked: number
  /** Why the spot is a compromise, if it is one. */
  note?: string
  /** Tiles the starting-lake repair turned into water (starting area only). */
  lakeRepaired?: number
}

/**
 * The resources a spawn must have nearby: the resources the bootstrap builds drills on
 * (`bootstrap-sites`), e.g. iron, copper, coal and stone.
 */
export function requiredResources(config: Config): string[] {
  const out: string[] = []
  for (const [name] of string.gmatch(config.bootstrapSites, "([^=,%s]+)=")) out.push(name)
  return out
}

/** Smallest patch (tiles) that counts as a starting resource. */
export const MIN_START_PATCH_TILES = 24

function scoreSpot(patches: Patch[], at: MapPosition, required: string[], radius: number): number | undefined {
  // Sum over required resources of the distance to the nearest big-enough patch; undefined if one is missing.
  let total = 0
  for (const name of required) {
    let best: number | undefined
    for (const p of patches) {
      if (p.name !== name || p.tiles < MIN_START_PATCH_TILES) continue
      const d = distanceToPatch(p, at)
      if (d <= radius && (best === undefined || d < best)) best = d
    }
    if (best === undefined) return undefined
    total += best
  }
  return total
}

/** Positions the spot must keep `minDistance` from: the player spawn, player characters and other factions. */
export function spawnKeepAways(surface: LuaSurface): MapPosition[] {
  const away: MapPosition[] = [game.forces.player.get_spawn_position(surface)]
  for (const [, player] of game.players) {
    if (player.character && player.character.valid && player.surface === surface) away.push(player.character.position)
  }
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    if (f.brain && f.surface === surface.name) away.push(f.brain.base)
  }
  return away
}

/** A free land spot for a character within 16 tiles of `p`, or undefined (water, cliffs...). */
function landAt(surface: LuaSurface, p: MapPosition): MapPosition | undefined {
  return surface.find_non_colliding_position("character", p, 16, 1) ?? undefined
}

/**
 * auto-distance: candidate regions on rings around the player spawn, starting at `spawn-min-distance` and
 * stepping out by 128 tiles, 8 directions per ring (rotated per ring and per faction so factions spread).
 * Each region (twice the resource radius) is generated and scanned once; then spots on a 16-tile grid inside
 * it are scored by the summed distance to the nearest big-enough patch of each required resource. The best
 * spot that keeps its distance from every keep-away point and has every required resource within
 * `spawn-resource-radius` wins. If no region qualifies, the land spot missing the fewest resources is used and
 * the compromise is noted.
 */
export function findSpawnAutoDistance(surface: LuaSurface, config: Config, salt: number): SpawnChoice {
  const origin = game.forces.player.get_spawn_position(surface)
  const away = spawnKeepAways(surface)
  const required = requiredResources(config)
  const radius = config.spawnResourceRadius
  const region = radius * 2
  const minD = config.spawnMinDistance
  let fallback: SpawnChoice | undefined
  let fallbackMissing = math.huge
  let checked = 0
  const farEnough = (p: MapPosition): boolean => {
    for (const a of away) if (positionDistance(a, p) < minD) return false
    return true
  }
  for (let ring = 0; ring < 5; ring++) {
    const r = minD + region / 2 + ring * 128
    for (let k = 0; k < 8; k++) {
      const angle = ((k + salt * 3 + ring * 0.5) / 8) * 2 * math.pi
      const center = { x: math.floor(origin.x + r * math.cos(angle)), y: math.floor(origin.y + r * math.sin(angle)) }
      checked++
      exploreNow(surface, center, region)
      const patches = scanPatches(surface, center, region)
      let best: MapPosition | undefined
      let bestScore = math.huge
      for (let gx = -region + radius / 2; gx <= region - radius / 2; gx += 16) {
        for (let gy = -region + radius / 2; gy <= region - radius / 2; gy += 16) {
          const p = { x: center.x + gx, y: center.y + gy }
          if (!farEnough(p)) continue
          const score = scoreSpot(patches, p, required, radius)
          if (score !== undefined && score < bestScore) {
            best = p
            bestScore = score
          }
        }
      }
      if (best) {
        const land = landAt(surface, best)
        if (land && farEnough(land)) return { position: land, patches: scanPatches(surface, land, radius), checked }
      }
      // Relaxed: every required resource somewhere in the region (within twice the radius of the best spot).
      let relaxed: MapPosition | undefined
      let relaxedScore = math.huge
      for (let gx = -region / 2; gx <= region / 2; gx += 16) {
        for (let gy = -region / 2; gy <= region / 2; gy += 16) {
          const p = { x: center.x + gx, y: center.y + gy }
          if (!farEnough(p)) continue
          const score = scoreSpot(patches, p, required, region)
          if (score !== undefined && score < relaxedScore) {
            relaxed = p
            relaxedScore = score
          }
        }
      }
      const land = landAt(surface, relaxed ?? center)
      if (!land || !farEnough(land)) continue
      let missing = 0
      for (const name of required) {
        let has = false
        for (const p of patches) if (p.name === name && p.tiles >= MIN_START_PATCH_TILES) has = true
        if (!has) missing++
      }
      if (relaxed === undefined) missing = math.max(missing, 1)
      if (missing < fallbackMissing) {
        fallbackMissing = missing
        fallback = {
          position: land,
          patches,
          checked,
          note: missing === 0 ? `resources within ${region} tiles, not ${radius}` : `${missing} required resource(s) missing within ${region} tiles`,
        }
      }
    }
    // A ring with a relaxed spot is good enough: farther rings cost more generation for little gain.
    if (fallback && fallbackMissing === 0) break
  }
  if (fallback) {
    fallback.checked = checked
    return fallback
  }
  return { position: origin, patches: [], checked, note: "no land spot found; using the player spawn" }
}

/** Whether any chunk within `radius` tiles of `p` has been generated. */
function anyGenerated(surface: LuaSurface, p: MapPosition, radius: number): boolean {
  const c0x = math.floor((p.x - radius) / 32)
  const c1x = math.floor((p.x + radius) / 32)
  const c0y = math.floor((p.y - radius) / 32)
  const c1y = math.floor((p.y + radius) / 32)
  for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) if (surface.is_chunk_generated({ x: cx, y: cy })) return true
  return false
}

/**
 * auto-distance with a starting area: the first spot on rings around the player spawn (from
 * `spawn-min-distance`, 64 tiles apart, 8 directions) that keeps its distance from every keep-away point and
 * whose surroundings are not generated yet becomes a map-gen starting point, then is generated. Map
 * generation puts starting-area resources around it, as for a player. Returns undefined if no spot qualifies
 * (the caller falls back to searching generated land).
 */
export function findSpawnStartingArea(surface: LuaSurface, config: Config, salt: number): SpawnChoice | undefined {
  const origin = game.forces.player.get_spawn_position(surface)
  const away = spawnKeepAways(surface)
  const required = requiredResources(config)
  const radius = config.spawnResourceRadius
  const minD = config.spawnMinDistance
  let checked = 0
  for (let ring = 0; ring < 12; ring++) {
    const r = minD + ring * 64
    for (let k = 0; k < 8; k++) {
      const angle = ((k + salt * 3 + ring * 0.5) / 8) * 2 * math.pi
      const candidate = { x: math.floor(origin.x + r * math.cos(angle)), y: math.floor(origin.y + r * math.sin(angle)) }
      let ok = true
      for (const a of away) if (positionDistance(a, candidate) < minD) ok = false
      if (!ok || anyGenerated(surface, candidate, radius)) continue
      checked++
      const mgs = surface.map_gen_settings as unknown as { starting_points?: MapPosition[] }
      const points = [...(mgs.starting_points ?? [])]
      points.push(candidate)
      mgs.starting_points = points
      surface.map_gen_settings = mgs as never
      const waterR = config.spawnWaterRadius
      exploreNow(surface, candidate, math.max(radius, waterR))
      const repaired = config.spawnLakeRepair && waterR > 0 ? repairStartingLake(surface, candidate, waterR, config.spawnLakeRepairMinTiles) : 0
      const land = landAt(surface, candidate)
      if (!land) continue
      const patches = scanPatches(surface, land, radius)
      if (scoreSpot(patches, land, required, radius) === undefined) continue
      if (waterR > 0 && !hasWater(surface, land, waterR)) continue
      return { position: land, patches, checked, lakeRepaired: repaired }
    }
  }
  return undefined
}

/** Whether any water tile lies within `radius` of `p`. */
export function hasWater(surface: LuaSurface, p: MapPosition, radius: number): boolean {
  return surface.count_tiles_filtered({ position: p, radius, collision_mask: "water_tile", limit: 1 }) > 0
}

/**
 * The tile vanilla Nauvis map generation puts at `elevation`, if it is water: `water` where elevation < 0,
 * `deepwater` where its probability wins (base/prototypes/tile/tiles.lua: water_base(0, 100), water_base(-2, 200)).
 */
function waterTileFor(elevation: number): string | undefined {
  if (elevation >= 0) return undefined
  const water = 100 * math.min(-elevation, 1)
  const deep = elevation <= -2 ? 200 * math.min(-2 - elevation, 1) : -1
  return deep > water ? "deepwater" : "water"
}

/**
 * Starting-lake repair (M5a.2). When a new game starts, the engine queues a wide area around the origin for
 * generation (about 10 chunks out) and computes tiles for it on worker threads; those chunks do not count as
 * generated yet. A faction starting point registered on top of them gets its starting-area resources (placed at a
 * later chunk stage) but not its starting lake: the tiles were computed before the point existed. The surface's
 * elevation noise already includes the point, so this repaints water (and deep water) on the generated land tiles
 * within `radius` of `center` where that noise is below zero, but only when at least `minTiles` of them disagree:
 * a correctly generated area differs from the noise in a handful of shore tiles, which stay as they are.
 * Returns the number of tiles repainted. Deterministic: the noise and the tiles are game state.
 */
export function repairStartingLake(surface: LuaSurface, center: MapPosition, radius: number, minTiles: number): number {
  if (prototypes.tile["water"] === undefined || prototypes.tile["deepwater"] === undefined) return 0
  const cx = math.floor(center.x)
  const cy = math.floor(center.y)
  const positions: MapPosition[] = []
  for (let x = cx - radius; x < cx + radius; x++) {
    for (let y = cy - radius; y < cy + radius; y++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue
      if (!surface.is_chunk_generated({ x: math.floor(x / 32), y: math.floor(y / 32) })) continue
      positions.push({ x, y })
    }
  }
  if (positions.length === 0) return 0
  const elevation = surface.calculate_tile_properties(["elevation"], positions)["elevation"]
  if (elevation === undefined) return 0
  const tiles: { name: string; position: MapPosition }[] = []
  for (let i = 0; i < positions.length; i++) {
    const name = waterTileFor(elevation[i])
    if (name === undefined) continue
    if (surface.get_tile(positions[i].x, positions[i].y).collides_with("water_tile")) continue
    tiles.push({ name, position: positions[i] })
  }
  if (tiles.length < minTiles) return 0
  // Like map generation: no entity or decorative stands in water (trees, rocks and ore there are removed).
  surface.set_tiles(tiles, true, true, true, false)
  log(`[rival-engineers] starting lake at ${cx},${cy} was missing (tiles generated before its starting point): repainted ${tiles.length} water tiles from the elevation noise`)
  return tiles.length
}

/** fixed-offsets: the `index`th offset (1-based, wrapping) from the player spawn, on the nearest land. */
export function findSpawnFixed(surface: LuaSurface, config: Config, index: number): SpawnChoice {
  const origin = game.forces.player.get_spawn_position(surface)
  const offsets: MapPosition[] = []
  for (const [xs, ys] of string.gmatch(config.spawnFixedOffsets, "(-?%d+)%s*,%s*(-?%d+)")) {
    offsets.push({ x: tonumber(xs)!, y: tonumber(ys)! })
  }
  const offset = offsets.length > 0 ? offsets[(index - 1) % offsets.length] : { x: config.spawnMinDistance, y: 0 }
  const target = { x: origin.x + offset.x, y: origin.y + offset.y }
  exploreNow(surface, target, config.spawnResourceRadius)
  const land = landAt(surface, target) ?? target
  return { position: land, patches: scanPatches(surface, land, config.spawnResourceRadius), checked: 1 }
}

/**
 * The items each crew member starts with: the same as a freeplay player (D5). Read from the freeplay
 * scenario's remote interface when it is running; otherwise the freeplay defaults from
 * `base/script/freeplay/freeplay.lua` (2.0.77). Freeplay's crash site moves the 8 iron plates into wreckage
 * the player mines back; the crew gets them directly.
 */
export function starterItems(): Record<string, number> {
  if (remote.interfaces["freeplay"]?.["get_created_items"]) {
    const items = remote.call("freeplay", "get_created_items") as Record<string, number> | undefined
    if (items) return items
  }
  return {
    "iron-plate": 8,
    wood: 1,
    pistol: 1,
    "firearm-magazine": 10,
    "burner-mining-drill": 1,
    "stone-furnace": 1,
  }
}
