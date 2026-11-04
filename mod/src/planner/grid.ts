// The terrain model as the planner sees it (SPEC §5.3): a per-tile obstacle class plus the ore under the tile.
// Pure: the runtime implementation (`terrain.ts`) fills it incrementally from the surface; T1 tests build one from
// ASCII art (`asciiTerrain`).

/** Obstacle classes, in increasing strength (a tile holding several takes the strongest). */
export const FREE = 0
/** Trees and rocks: clearable at a cost (LayoutPolicy.obstacles). */
export const TREE = 1
export const ROCK = 2
/** The faction's own entities (and its ghosts: planned structures). */
export const OWN = 3
/** Other forces' entities (and neutral buildings). */
export const FOREIGN = 4
export const WATER = 5
export const CLIFF = 6
/** Not generated, not scanned yet, or out of the map. */
export const UNKNOWN = 7

export const BLOCK_NAMES = ["free", "tree", "rock", "own", "foreign", "water", "cliff", "unknown"]

export interface TerrainView {
  /** Obstacle class of a tile (integer tile coordinates: the tile whose top-left corner is (x, y)). */
  block(x: number, y: number): number
  /** The resource under a tile, if any. */
  ore(x: number, y: number): string | undefined
  /** D57: tile keys of `resource` inside `rect`, from the scan's ore tables (absent: `ore` is read tile by tile). */
  oreTiles?(resource: string, rect: Rect): number[]
  /** D57: changes whenever a chunk under `rect` is scanned again (absent: no dead-patch memory). */
  stamp?(rect: Rect): string
}

export interface Vec {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Tile keys: one number per tile, exact in doubles (|x|, |y| < 2^20).
const OFF = 1048576
const SPAN = 2097152

export function tkey(x: number, y: number): number {
  return (x + OFF) * SPAN + (y + OFF)
}

export function keyX(k: number): number {
  return math.floor(k / SPAN) - OFF
}

export function keyY(k: number): number {
  return (k % SPAN) - OFF
}

// Directions as indices 0..3 = N, E, S, W (Factorio direction = 4 × index).
export const DX = [0, 1, 0, -1]
export const DY = [-1, 0, 1, 0]

export function cw(d: number): number {
  return (d + 1) % 4
}

export function ccw(d: number): number {
  return (d + 3) % 4
}

export function opposite(d: number): number {
  return (d + 2) % 4
}

/** Factorio 16-way direction value (0, 4, 8, 12) → index. */
export function dirIndex(dir: number): number {
  return math.floor(dir / 4) % 4
}

export function dirValue(index: number): 0 | 4 | 8 | 12 {
  return (index * 4) as 0 | 4 | 8 | 12
}

/**
 * A terrain view from ASCII rows (T1 tests, docs). Row 0 is y = oy. Characters:
 * `.` free, `T` tree, `R` rock, `#` own entity, `X` foreign entity, `~` water, `C` cliff, `?` unknown,
 * `i` iron ore, `c` copper ore, `k` coal, `s` stone (ore on free ground). Outside the rows: unknown.
 */
export function asciiTerrain(rows: string[], ox = 0, oy = 0): TerrainView {
  const ores: Record<string, string> = { i: "iron-ore", c: "copper-ore", k: "coal", s: "stone" }
  const blocks: Record<string, number> = { ".": FREE, T: TREE, R: ROCK, "#": OWN, X: FOREIGN, "~": WATER, C: CLIFF, "?": UNKNOWN }
  const ch = (x: number, y: number): string | undefined => {
    const row = rows[y - oy]
    if (row === undefined || x - ox < 0 || x - ox >= row.length) return undefined
    return row.substring(x - ox, x - ox + 1)
  }
  return {
    block: (x, y) => {
      const c = ch(x, y)
      if (c === undefined) return UNKNOWN
      return blocks[c] ?? FREE
    },
    ore: (x, y) => {
      const c = ch(x, y)
      return c === undefined ? undefined : ores[c]
    },
  }
}

/** A mutable terrain for tests: a base view plus per-tile overrides. */
export function overlayTerrain(base: TerrainView, blocks: Record<number, number>): TerrainView {
  return {
    block: (x, y) => blocks[tkey(x, y)] ?? base.block(x, y),
    ore: (x, y) => base.ore(x, y),
  }
}

/** Grows a rectangle by `n` tiles on every side. */
export function inflate(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n }
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h
}

export function manhattan(a: Vec, b: Vec): number {
  return math.abs(a.x - b.x) + math.abs(a.y - b.y)
}

/**
 * M7 (seed 11 g113): the tiles a collision box covers. A box with an `orientation` (a diagonal cliff: 0.125 turns) is
 * that rectangle turned clockwise about its centre; the tiles are those it overlaps by more than `eps` (separating
 * axes), not its unturned corners: an underground entrance was planned on a tile a turned cliff reached ~0.4 into,
 * and its ghost could never be placed.
 */
export function boxTiles(lt: { x: number; y: number }, rb: { x: number; y: number }, orientation?: number, eps = 0.01): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const o = orientation ?? 0
  if (o === 0 || o === 0.5) {
    const x1 = math.floor(lt.x + eps)
    const y1 = math.floor(lt.y + eps)
    const x2 = math.max(math.ceil(rb.x - eps), x1 + 1)
    const y2 = math.max(math.ceil(rb.y - eps), y1 + 1)
    for (let x = x1; x < x2; x++) for (let y = y1; y < y2; y++) out.push({ x, y })
    return out
  }
  const cx = (lt.x + rb.x) / 2
  const cy = (lt.y + rb.y) / 2
  const hx = (rb.x - lt.x) / 2
  const hy = (rb.y - lt.y) / 2
  const th = o * 2 * math.pi
  // Clockwise on the map (y grows south): the box's own x axis is u, its y axis v.
  const ux = math.cos(th)
  const uy = math.sin(th)
  const vx = -uy
  const vy = ux
  const ex = math.abs(hx * ux) + math.abs(hy * vx)
  const ey = math.abs(hx * uy) + math.abs(hy * vy)
  const cu = cx * ux + cy * uy
  const cv = cx * vx + cy * vy
  for (let x = math.floor(cx - ex + eps); x < math.ceil(cx + ex - eps); x++) {
    for (let y = math.floor(cy - ey + eps); y < math.ceil(cy + ey - eps); y++) {
      // The tile square against the box's own axes (its x and y axes hold by the envelope above).
      let minU = math.huge
      let maxU = -math.huge
      let minV = math.huge
      let maxV = -math.huge
      for (const [px, py] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
        const pu = px * ux + py * uy
        const pv = px * vx + py * vy
        minU = math.min(minU, pu)
        maxU = math.max(maxU, pu)
        minV = math.min(minV, pv)
        maxV = math.max(maxV, pv)
      }
      if (maxU > cu - hx + eps && minU < cu + hx - eps && maxV > cv - hy + eps && minV < cv + hy - eps) out.push({ x, y })
    }
  }
  return out
}
