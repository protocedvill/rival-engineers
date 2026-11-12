// M7d.5: where a faction's next roboport goes. Pure (no Factorio globals): T1 tests it directly.
//
// The network grows on a square grid from its hub (cell 0,0, the first roboport, with the storage chests). Cell (i, j)
// sits at hub + (i, j) × spacing. Each new roboport takes a free cell next to one the network already has (so its
// logistic area touches the network), the one whose construction area reaches the most base the network does not cover
// yet; a tie goes to the cell nearest the hub, then the lowest i, then the lowest j (deterministic).

export interface GridRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GridCell {
  i: number
  j: number
}

const ROLE_PREFIX = "roboport:"

export function cellKey(c: GridCell): string {
  return `${c.i},${c.j}`
}

/** A roboport node's role: `roboport:i,j`. */
export function cellRole(c: GridCell): string {
  return `${ROLE_PREFIX}${c.i},${c.j}`
}

/** The cell of a roboport node's role, or undefined for any other role. */
export function parseCellRole(role: string): GridCell | undefined {
  if (string.sub(role, 1, ROLE_PREFIX.length) !== ROLE_PREFIX) return undefined
  const m = string.match(string.sub(role, ROLE_PREFIX.length + 1), "^(%-?%d+),(%-?%d+)$")
  if (m[0] === undefined || m[1] === undefined) return undefined
  return { i: tonumber(m[0])!, j: tonumber(m[1])! }
}

/** The grid point of cell `c`. */
export function cellPoint(origin: { x: number; y: number }, spacing: number, c: GridCell): { x: number; y: number } {
  return { x: origin.x + c.i * spacing, y: origin.y + c.j * spacing }
}

export interface NextCellInput {
  /** The base: rectangles of the faction's modules. */
  modules: GridRect[]
  /** Cells the network has (built, or planned by an active goal). */
  cells: GridCell[]
  /** Cells whose goal failed: never tried again. */
  failed: Record<string, boolean>
  /** The hub roboport's position (cell 0,0's point). */
  origin: { x: number; y: number }
  spacing: number
  /** Half-width of a roboport's construction area. */
  constructionRadius: number
  /** The most roboports the network places. */
  max: number
  /**
   * B192: the roboport module's footprint and the half-size of its plan window around the cell point. A cell whose
   * window has no spot clear of the base's modules (and their 1-tile margin) is skipped. Absent: every cell counts.
   */
  room?: { w: number; h: number; window: number }
}

/**
 * B192 (`m7-b186` seed 222, min 327): whether a w×h footprint (either rotation) fits in the window around `q` clear of
 * every module rectangle and its 1-tile margin. Two cells in a row fell on an iron smelter column; each spent a plan
 * (four before the robots goal failed at once) to learn it. Terrain (water, trees) is the plan's to judge.
 */
export function cellHasRoom(q: { x: number; y: number }, room: { w: number; h: number; window: number }, modules: GridRect[]): boolean {
  const x0 = math.floor(q.x - room.window)
  const y0 = math.floor(q.y - room.window)
  const x1 = math.floor(q.x + room.window)
  const y1 = math.floor(q.y + room.window)
  const near: GridRect[] = []
  for (const m of modules) {
    if (m.x - 1 < x1 && m.x + m.w + 1 > x0 && m.y - 1 < y1 && m.y + m.h + 1 > y0) near.push(m)
  }
  for (const [w, h] of [[room.w, room.h], [room.h, room.w]]) {
    for (let y = y0; y + h <= y1; y++) {
      for (let x = x0; x + w <= x1; x++) {
        let clear = true
        for (const m of near) {
          if (x < m.x + m.w + 1 && x + w > m.x - 1 && y < m.y + m.h + 1 && y + h > m.y - 1) {
            clear = false
            break
          }
        }
        if (clear) return true
      }
    }
  }
  return false
}

/** The next cell to place a roboport in, or undefined when the base is covered (or the network is full). */
export function nextCell(p: NextCellInput): GridCell | undefined {
  if (p.cells.length >= p.max) return undefined
  if (p.cells.length === 0) return p.failed[cellKey({ i: 0, j: 0 })] ? undefined : { i: 0, j: 0 }
  const taken: Record<string, boolean> = {}
  for (const c of p.cells) taken[cellKey(c)] = true
  const r = p.constructionRadius
  const inside = (c: GridCell, x: number, y: number): boolean => {
    const q = cellPoint(p.origin, p.spacing, c)
    return math.abs(x - q.x) <= r && math.abs(y - q.y) <= r
  }
  // A module counts as covered when its centre is inside some cell's construction area.
  const open: GridRect[] = []
  for (const m of p.modules) {
    const x = m.x + m.w / 2
    const y = m.y + m.h / 2
    if (!p.cells.some((c) => inside(c, x, y))) open.push(m)
  }
  if (open.length === 0) return undefined
  let best: GridCell | undefined
  let bestValue = 0
  let bestDist = 0
  const seen: Record<string, boolean> = {}
  for (const c of p.cells) {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { i: c.i + di, j: c.j + dj }
      const k = cellKey(n)
      if (taken[k] || p.failed[k] || seen[k]) continue
      seen[k] = true
      let value = 0
      for (const m of open) if (inside(n, m.x + m.w / 2, m.y + m.h / 2)) value += m.w * m.h
      if (value <= 0) continue
      if (p.room !== undefined && !cellHasRoom(cellPoint(p.origin, p.spacing, n), p.room, p.modules)) continue
      const dist = math.abs(n.i) + math.abs(n.j)
      const better =
        best === undefined ||
        value > bestValue ||
        (value === bestValue && (dist < bestDist || (dist === bestDist && (n.i < best.i || (n.i === best.i && n.j < best.j)))))
      if (better) {
        best = n
        bestValue = value
        bestDist = dist
      }
    }
  }
  return best
}
