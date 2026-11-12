// Terrain model at runtime (SPEC §5.3, §5.6): a per-faction tile occupancy view of a region, filled chunk by chunk under a
// per-tick budget (no full-map scans per tick) and kept current by marking chunks dirty when entities are built, mined
// or destroyed on them. Lives in `storage` (sparse per-chunk tables). `terrainView` exposes it as the pure TerrainView
// the planner uses.

import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"
import { boxTiles, CLIFF, FOREIGN, keyX, keyY, OWN, Rect, ROCK, TerrainView, tkey, TREE, UNKNOWN, Vec, WATER } from "./grid"
import { findEntities } from "../work"

export interface ChunkScan {
  /** Tile index (ly × 32 + lx) → obstacle class; absent = free. */
  block: Record<number, number>
  /** Tile index → resource index (TerrainState.resources), absent = none. */
  ore: Record<number, number>
  tick: number
}

export interface TerrainState {
  id: string
  surface: string
  /** The faction's force: its entities are OWN, every other force's are FOREIGN. */
  force: string
  chunks: Record<number, ChunkScan>
  /** Chunk keys waiting for a (re)scan, in order. */
  queue: number[]
  queued: Record<number, boolean>
  resources: string[]
  resourceIndex: Record<string, number>
  /** Chunks scanned so far (telemetry). */
  scans: number
}

declare global {
  interface RivalEngineersStorage {
    terrains?: Record<string, TerrainState>
  }
}

const IGNORED: Record<string, boolean> = {
  character: true,
  "character-corpse": true,
  corpse: true,
  "item-entity": true,
  fish: true,
  "particle-source": true,
  projectile: true,
  sticker: true,
  explosion: true,
  "highlight-box": true,
  "speech-bubble": true,
  "deconstructible-tile-proxy": true,
  "tile-ghost": true,
  "item-request-proxy": true,
  "smoke-with-trigger": true,
  "fire": true,
  "stream": true,
  "beam": true,
  "arrow": true,
  "flying-text": true,
}

function terrains(): Record<string, TerrainState> {
  storage.terrains ??= {}
  return storage.terrains
}

export function getTerrain(id: string): TerrainState | undefined {
  return terrains()[id]
}

export function newTerrain(id: string, surface: string, force: string): TerrainState {
  const t: TerrainState = { id, surface, force, chunks: {}, queue: [], queued: {}, resources: [], resourceIndex: {}, scans: 0 }
  terrains()[id] = t
  return t
}

export function deleteTerrain(id: string): void {
  delete terrains()[id]
}

function enqueue(t: TerrainState, cx: number, cy: number): void {
  const k = tkey(cx, cy)
  if (t.queued[k]) return
  t.queued[k] = true
  t.queue.push(k)
}

/**
 * Queues every chunk overlapping `area` (world tiles) that is not scanned yet. D62: with `known`, only the chunks it
 * allows (the rest stay UNKNOWN to the planner).
 */
/**
 * M7d.5: scan the ground a remote site and its connection to the plan's centre need. A pumpjack field chosen from the
 * surface can sit in charted-but-unscanned chunks; the planner then sees UNKNOWN there and refuses a pole line that
 * exists on the map. Queue a corridor, not the whole bounding box, so the scan cost stays proportional to the route.
 */
export function requestCorridor(t: TerrainState | undefined, from: Vec, to: Vec, halfWidth = 48): void {
  if (t === undefined) return
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = math.max(1, math.ceil(math.max(math.abs(dx), math.abs(dy)) / 32))
  for (let i = 0; i <= steps; i++) {
    const x = from.x + (dx * i) / steps
    const y = from.y + (dy * i) / steps
    requestArea(t, { x: math.floor(x - halfWidth), y: math.floor(y - halfWidth), w: 2 * halfWidth, h: 2 * halfWidth })
  }
}

export function requestArea(t: TerrainState, area: Rect, known?: (this: void, cx: number, cy: number) => boolean): void {
  const cx1 = math.floor(area.x / 32)
  const cy1 = math.floor(area.y / 32)
  const cx2 = math.floor((area.x + area.w - 1) / 32)
  const cy2 = math.floor((area.y + area.h - 1) / 32)
  for (let cy = cy1; cy <= cy2; cy++) {
    for (let cx = cx1; cx <= cx2; cx++) if (t.chunks[tkey(cx, cy)] === undefined && (known === undefined || known(cx, cy))) enqueue(t, cx, cy)
  }
}

export function terrainReady(t: TerrainState): boolean {
  return t.queue.length === 0
}

function resourceId(t: TerrainState, name: string): number {
  let i = t.resourceIndex[name]
  if (i === undefined) {
    t.resources.push(name)
    i = t.resources.length
    t.resourceIndex[name] = i
  }
  return i
}

/** M7c.9: whether an entity of `type` is a structure the planner never plans over (OWN or FOREIGN in the scan). */
export function isStructureType(type: string): boolean {
  return !IGNORED[type] && type !== "tree" && type !== "simple-entity" && type !== "cliff" && type !== "resource"
}

function classify(t: TerrainState, e: LuaEntity): number | undefined {
  const type = e.type
  if (IGNORED[type]) return undefined
  if (type === "tree") return TREE
  if (type === "simple-entity") return ROCK
  if (type === "cliff") return CLIFF
  // Ghosts of other forces are their planned structures: never plan over them (M5a.2).
  if (type === "entity-ghost") return e.force.name === t.force ? OWN : FOREIGN
  return e.force.name === t.force ? OWN : FOREIGN
}

/** Scans one chunk (it must be generated). */
export function scanChunk(t: TerrainState, surface: LuaSurface, cx: number, cy: number): void {
  const x0 = cx * 32
  const y0 = cy * 32
  const area = { left_top: { x: x0, y: y0 }, right_bottom: { x: x0 + 32, y: y0 + 32 } }
  const scan: ChunkScan = { block: {}, ore: {}, tick: game.tick }
  const set = (x: number, y: number, b: number): void => {
    const lx = x - x0
    const ly = y - y0
    if (lx < 0 || ly < 0 || lx >= 32 || ly >= 32) return
    const i = ly * 32 + lx
    const old = scan.block[i]
    if (old === undefined || old < b) scan.block[i] = b
  }
  for (const tile of surface.find_tiles_filtered({ area, collision_mask: "water_tile" })) set(tile.position.x, tile.position.y, WATER)
  for (const tile of surface.find_tiles_filtered({ area, name: "out-of-map" })) set(tile.position.x, tile.position.y, UNKNOWN)
  for (const e of findEntities(surface, { area })) {
    if (!e.valid) continue
    if (e.type === "resource") {
      const x = math.floor(e.position.x)
      const y = math.floor(e.position.y)
      if (x >= x0 && y >= y0 && x < x0 + 32 && y < y0 + 32) scan.ore[(y - y0) * 32 + (x - x0)] = resourceId(t, e.name)
      continue
    }
    const b = classify(t, e)
    if (b === undefined) continue
    const box = e.bounding_box
    // M7 (seed 11 g113): a diagonal cliff's box is turned (`orientation`): its tiles are the turned rectangle's.
    for (const p of boxTiles(box.left_top, box.right_bottom, box.orientation)) set(p.x, p.y, b)
  }
  t.chunks[tkey(cx, cy)] = scan
  t.scans++
}

/**
 * Scans up to `maxChunks` queued chunks. Chunks not generated yet are requested and retried later. Returns the
 * number scanned.
 */
export function stepTerrain(t: TerrainState, maxChunks: number): number {
  const surface = game.surfaces[t.surface]
  if (surface === undefined) return 0
  let scanned = 0
  let tries = t.queue.length
  while (scanned < maxChunks && t.queue.length > 0 && tries-- > 0) {
    const k = t.queue.shift()!
    const cx = keyX(k)
    const cy = keyY(k)
    if (!surface.is_chunk_generated({ x: cx, y: cy })) {
      surface.request_to_generate_chunks({ x: cx * 32 + 16, y: cy * 32 + 16 }, 0)
      t.queue.push(k)
      continue
    }
    delete t.queued[k]
    scanChunk(t, surface, cx, cy)
    scanned++
  }
  return scanned
}

/** Marks the chunks under a position/box dirty in every terrain of that surface (rescanned under budget). */
export function markDirty(surface: string, left: MapPosition, right: MapPosition): void {
  for (const [, t] of pairs(terrains())) {
    if (t.surface !== surface) continue
    for (let cy = math.floor(left.y / 32); cy <= math.floor(right.y / 32); cy++) {
      for (let cx = math.floor(left.x / 32); cx <= math.floor(right.x / 32); cx++) {
        if (t.chunks[tkey(cx, cy)] !== undefined) enqueue(t, cx, cy)
      }
    }
  }
}

export function onEntityChanged(entity: LuaEntity | undefined): void {
  if (entity === undefined || !entity.valid || storage.terrains === undefined) return
  const box = entity.bounding_box
  markDirty(entity.surface.name, box.left_top, box.right_bottom)
}

/**
 * Destroys `entity` and marks its ground for a rescan: `destroy()` raises no event the terrain model listens to
 * (M6a.2, seed 222: picked-up drills and dropped ghosts left their tiles OWN for good).
 */
export function destroyEntity(entity: LuaEntity): void {
  const surface = entity.surface.name
  const box = entity.bounding_box
  entity.destroy()
  markDirty(surface, box.left_top, box.right_bottom)
}

/**
 * Drains every terrain's dirty queue under a per-terrain budget. The planner entries drain their own region on demand,
 * but removals between entries (a pick-up, a dropped ghost) would otherwise wait for the next entry, and a synchronous
 * planGrowth in between could read stale ground (M6a.2, seed 222).
 */
export function stepAllTerrains(maxChunks: number): void {
  for (const [, t] of pairs(terrains())) stepTerrain(t, maxChunks)
}

/** The pure view the planner reads. Unscanned tiles are UNKNOWN. */
export function terrainView(t: TerrainState): TerrainView {
  const chunks = t.chunks
  const resources = t.resources
  return {
    block: (x, y) => {
      const cx = math.floor(x / 32)
      const cy = math.floor(y / 32)
      const c = chunks[tkey(cx, cy)]
      if (c === undefined) return UNKNOWN
      return c.block[(y - cy * 32) * 32 + (x - cx * 32)] ?? 0
    },
    ore: (x, y) => {
      const cx = math.floor(x / 32)
      const cy = math.floor(y / 32)
      const c = chunks[tkey(cx, cy)]
      if (c === undefined) return undefined
      const i = c.ore[(y - cy * 32) * 32 + (x - cx * 32)]
      return i !== undefined ? resources[i - 1] : undefined
    },
    oreTiles: (resource, rect) => {
      const out: number[] = []
      const id = t.resourceIndex[resource]
      if (id === undefined) return out
      for (let cx = math.floor(rect.x / 32); cx <= math.floor((rect.x + rect.w - 1) / 32); cx++) {
        for (let cy = math.floor(rect.y / 32); cy <= math.floor((rect.y + rect.h - 1) / 32); cy++) {
          const c = chunks[tkey(cx, cy)]
          if (c === undefined) continue
          for (const [i, r] of pairs(c.ore)) {
            if (r !== id) continue
            const x = cx * 32 + ((i as number) % 32)
            const y = cy * 32 + math.floor((i as number) / 32)
            if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) out.push(tkey(x, y))
          }
        }
      }
      // pairs order is not deterministic across loads: sort.
      out.sort((a, b) => a - b)
      return out
    },
    stamp: (rect) => {
      let n = 0
      let last = 0
      for (let cx = math.floor(rect.x / 32); cx <= math.floor((rect.x + rect.w - 1) / 32); cx++) {
        for (let cy = math.floor(rect.y / 32); cy <= math.floor((rect.y + rect.h - 1) / 32); cy++) {
          const c = chunks[tkey(cx, cy)]
          if (c === undefined) continue
          n++
          last = math.max(last, c.tick)
        }
      }
      return `${n}@${last}`
    },
  }
}
