import { LuaSurface, MapPosition } from "factorio:runtime"
import { tkey as TILEKEY } from "../planner/grid"
import { findEntities } from "../work"

// World knowledge (SPEC §5.5, M3): crew don't chart. A faction learns about resources by generating the
// chunks around its base, as a player walking around would, and scanning the generated entities. Patches are
// clusters of one resource; the brain picks them by distance and size.

export interface Patch {
  id: number
  /** Resource entity name ("iron-ore"). */
  name: string
  /** The item hand-mining or a drill gets from it. */
  product: string
  tiles: number
  amount: number
  /** Mean position of the patch's tiles. */
  center: MapPosition
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Tiles of one resource closer than this (Chebyshev, in tiles) belong to the same patch. */
const JOIN = 2

/** Asks the engine to generate every chunk within `radius` tiles of `center` (asynchronous). */
export function exploreAround(surface: LuaSurface, center: MapPosition, radius: number): void {
  surface.request_to_generate_chunks(center, math.ceil(radius / 32))
}

/** Generates the chunks now (blocking). Use sparingly: spawn search and tests. */
export function exploreNow(surface: LuaSurface, center: MapPosition, radius: number): void {
  exploreAround(surface, center, radius)
  surface.force_generate_chunk_requests()
}

/** Item a resource yields (first item product), if any. Fluids (crude oil) have none. */
export function resourceProduct(name: string): string | undefined {
  const products = prototypes.entity[name]?.mineable_properties.products
  if (!products) return undefined
  for (const p of products) if (p.type === "item") return p.name
  return undefined
}

function key(x: number, y: number): number {
  return TILEKEY(x, y)
}

/**
 * Scans the generated area within `radius` of `center` and clusters resources into patches, largest first
 * within each resource. Only resources with an item product (hand- or drill-minable solids) are kept.
 */
export function scanPatches(surface: LuaSurface, center: MapPosition, radius: number, names?: string[]): Patch[] {
  const area = {
    left_top: { x: center.x - radius, y: center.y - radius },
    right_bottom: { x: center.x + radius, y: center.y + radius },
  }
  const entities = findEntities(surface, { area, type: "resource", name: names })
  const byName: Record<string, { x: number; y: number; amount: number }[]> = {}
  const nameOrder: string[] = []
  for (const e of entities) {
    const n = e.name
    if (byName[n] === undefined) {
      if (resourceProduct(n) === undefined) continue
      byName[n] = []
      nameOrder.push(n)
    }
    byName[n].push({ x: math.floor(e.position.x), y: math.floor(e.position.y), amount: e.amount })
  }
  nameOrder.sort()
  const patches: Patch[] = []
  for (const name of nameOrder) {
    const tiles = byName[name]
    const index: Record<number, number> = {}
    for (let i = 0; i < tiles.length; i++) index[key(tiles[i].x, tiles[i].y)] = i
    const seen: Record<number, boolean> = {}
    const found: Patch[] = []
    for (let i = 0; i < tiles.length; i++) {
      if (seen[i]) continue
      seen[i] = true
      const stack = [i]
      let count = 0
      let amount = 0
      let sx = 0
      let sy = 0
      let x1 = tiles[i].x
      let y1 = tiles[i].y
      let x2 = x1
      let y2 = y1
      while (stack.length > 0) {
        const t = tiles[stack.pop()!]
        count++
        amount += t.amount
        sx += t.x + 0.5
        sy += t.y + 0.5
        x1 = math.min(x1, t.x)
        y1 = math.min(y1, t.y)
        x2 = math.max(x2, t.x + 1)
        y2 = math.max(y2, t.y + 1)
        for (let dx = -JOIN; dx <= JOIN; dx++) {
          for (let dy = -JOIN; dy <= JOIN; dy++) {
            const j = index[key(t.x + dx, t.y + dy)]
            if (j !== undefined && !seen[j]) {
              seen[j] = true
              stack.push(j)
            }
          }
        }
      }
      found.push({ id: 0, name, product: resourceProduct(name)!, tiles: count, amount, center: { x: sx / count, y: sy / count }, x1, y1, x2, y2 })
    }
    found.sort((a, b) => (a.tiles !== b.tiles ? b.tiles - a.tiles : a.center.x !== b.center.x ? a.center.x - b.center.x : a.center.y - b.center.y))
    for (const p of found) patches.push(p)
  }
  for (let i = 0; i < patches.length; i++) patches[i].id = i + 1
  return patches
}

function dist(a: MapPosition, b: MapPosition): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Distance from `p` to the patch's bounding box (0 inside). */
export function distanceToPatch(patch: Patch, p: MapPosition): number {
  const dx = math.max(patch.x1 - p.x, 0, p.x - patch.x2)
  const dy = math.max(patch.y1 - p.y, 0, p.y - patch.y2)
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * The best patch of `name` for a base at `from`: the nearest one with at least `minTiles` tiles, where a
 * bigger patch may be up to `sizeBonus` tiles farther per doubling of size. Undefined if none.
 */
export function bestPatch(patches: Patch[], name: string, from: MapPosition, minTiles: number, avoid?: Record<number, boolean>): Patch | undefined {
  let best: Patch | undefined
  let bestScore = 0
  for (const p of patches) {
    if (p.name !== name || p.tiles < minTiles || (avoid && avoid[p.id])) continue
    const score = distanceToPatch(p, from) - 8 * (math.log(p.tiles) / math.log(2))
    if (best === undefined || score < bestScore) {
      best = p
      bestScore = score
    }
  }
  return best
}

export { dist as positionDistance }
