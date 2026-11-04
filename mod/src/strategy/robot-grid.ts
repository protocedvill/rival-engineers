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
