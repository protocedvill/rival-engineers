// Pipe router (M7b, see the M7 report "plan for fluids"): one fluid from a `pipe-out` port to a `pipe-in` port.
// A* over (tile, heading) states, like the belt router, with three moves from (T, h) (the fluid arrives at T from T − h):
//   - a plain pipe at T, continuing to (T + d, d) for any d but back;
//   - a pipe-to-ground pair: entrance at T (its above-ground side faces back to T − h), exit at E = T + k·h
//     (2 ≤ k ≤ maxUnderground) facing on, continuing to (E + h, h);
//   - a pump at T, T + h (it starts a new fluid segment), continuing to (T + 2h, h).
// Two fluids must never touch. Underground ends and pumps connect only along their axis, so only a plain pipe can join
// a neighbour by accident: it may not stand next to a tile where another fluid box connects (`fluidNear`), except the
// route's own previous and next tiles. A 2.0 fluid segment longer than the pipeline extent carries nothing (CLAUDE.md,
// M7b.1): the path between pumps (or from the source) never exceeds `extent` tiles.
//
// M7 performance: the search is resumable (`newPipeSearch` / `stepPipeSearch`, plain data, so a plan job holding it can
// sit in `storage`) and runs under the planner's per-tick budget like the belt router; a single remote crude line used
// to search for seconds in one tick. Tile costs and underground checks are cached for the search's life. A coarse pass
// first runs over `cell`-tile cells split into their 4-connected traversable components (a tile a route can use at
// all: a placeable tile, or one an underground may pass under). Its graph has a path exactly when the tile graph has
// one, so a coarse search that runs out proves "no path" cheaply, and on a long line the tile search keeps to a
// corridor around the coarse path instead of flooding the open ground in front of a walled-in goal.
//
// Pure: no Factorio globals; terrain, claims and other fluids come in as callbacks (T1: mod/unit/pipe-router.test.ts).

import { DX, DY, keyX, keyY, opposite, tkey } from "./grid"

/** M7 B120: weighted A* keeps remote oil routes bounded when many near-equivalent pipe layouts exist. */
const PIPE_HEURISTIC_WEIGHT = 4

/** What the search reads from the layout and terrain. Passed to every step, never stored (the search stays plain data). */
export interface PipeCallbacks {
  /** Cost of putting an entity on a tile (≥ the cheapest tile), or < 0 when it cannot go there. */
  cost: (this: void, x: number, y: number) => number
  /** Whether a pipe-to-ground span may pass under a tile running along `axis` (0 = N/S, 1 = E/W). */
  under: (this: void, x: number, y: number, axis: number) => boolean
  /** Whether another fluid box (another route's pipe, another port) connects into this tile. */
  fluidNear: (this: void, x: number, y: number) => boolean
}

export interface PipeParams {
  /** First tile outside the `pipe-out` port, and the direction away from the machine. */
  start: { x: number; y: number; dir: number }
  /**
   * B120: start tiles instead of `start` (a tap: tiles beside a line of the same fluid, heading away from it; the first
   * pipe placed there joins the line).
   */
  starts?: { x: number; y: number; dir: number }[]
  /** Tile outside the `pipe-in` port, and the direction from it into the machine. */
  goal: { x: number; y: number; dir: number }
  /** Farthest a pipe-to-ground exit may be from its entrance (`max_underground_distance`). */
  maxUnderground: number
  /** Most tiles of path in one fluid segment (`default_pipeline_extent`); a pump starts a new one. */
  extent: number
  /** The cheapest a tile can cost (keeps the heuristic honest). */
  minCost: number
  /** Extra cost of a pipe-to-ground pair, and of a pump (they are dearer items than a pipe). */
  ugCost: number
  pumpCost: number
  /** Work (expansions, plus the coarse pass's cell work) before giving up. */
  budget: number
  /** Coarse cell size in tiles (the router's `coarseCell`); 0 or absent: no coarse pass. */
  cell?: number
  /** Ends at least this far apart (Manhattan) keep to the coarse corridor (the router's `longRoute`); 0: never. */
  longRoute?: number
  /** Corridor half-width around the coarse path, in cells (the router's `corridorCells`; the ends get one more). */
  corridorCells?: number
}

export interface PipeRequest extends PipeParams, PipeCallbacks {
  /** Filled when routing fails, for planner diagnostics. */
  failure?: { expansions?: number; reason?: string }
}

export interface PipeStep {
  kind: "pipe" | "ug-in" | "ug-out" | "pump"
  x: number
  y: number
  /** Heading index 0..3 (N, E, S, W): the flow direction for pumps and underground ends. */
  dir: number
}

export interface PipeResult {
  steps: PipeStep[]
  cost: number
  /** All the search's work (tile expansions and coarse cell work). */
  expansions: number
}

/** Move into a node: a plain pipe on the parent's tile, an underground pair from it, a pump on it, or a start. */
const MV_START = 0
const MV_PIPE = 1
const MV_UG = 2
const MV_PUMP = 3

/** The coarse pass: A* over (cell, component) nodes. */
interface PipeCoarse {
  /** Per cell key: each of its tiles' component (row-major, -1 untraversable), filled when the cell is first reached. */
  comps: Record<number, number[]>
  g: Record<number, number>
  par: Record<number, number>
  closed: Record<number, boolean>
  hs: number[]
  hf: number[]
  goal: number
  starts: number[]
}

export interface PipeSearch {
  p: PipeParams
  status: "running" | "found" | "failed"
  reason?: string
  result?: PipeResult
  /** Work so far (counts against `p.budget`). */
  work: number
  /** Tile nodes, parallel arrays: position, heading, cost, tiles since the last pump, parent (-1: none), move. */
  nx: number[]
  ny: number[]
  nd: number[]
  ng: number[]
  nrun: number[]
  npar: number[]
  nmv: number[]
  /** Heap of node indices by f. */
  hs: number[]
  hf: number[]
  /** Best cost per (tile, heading) state. */
  best: Record<number, number>
  /** Caches for the search's life (the layout does not change while it runs). */
  tc: Record<number, number>
  uc: Record<number, boolean>
  coarse?: PipeCoarse
  /** Cell keys the tile search keeps to (a long line after the coarse pass). */
  corridor?: Record<number, boolean>
  /** Corridor distances in cells per coarse node (`corridorDistances`), and the analysed cells they refer to. */
  cd?: Record<number, number>
  comps?: Record<number, number[]>
  /** The corridor distances' BFS queue and its next index, while it runs. */
  cdq?: number[]
  cdi?: number
  /** The corridor search ran out and the tile search was run again without it. */
  widened?: boolean
  /** The first step has set up the coarse pass or the tile search. */
  started?: boolean
}

function heapPush(s: { hs: number[]; hf: number[] }, v: number, f: number): void {
  const hs = s.hs
  const hf = s.hf
  let i = hs.length
  hs.push(v)
  hf.push(f)
  while (i > 0) {
    const p = math.floor((i - 1) / 2)
    if (hf[p] <= f) break
    hs[i] = hs[p]
    hf[i] = hf[p]
    i = p
  }
  hs[i] = v
  hf[i] = f
}

function heapPop(s: { hs: number[]; hf: number[] }): number {
  const hs = s.hs
  const hf = s.hf
  const top = hs[0]
  const lastS = hs[hs.length - 1]
  const lastF = hf[hf.length - 1]
  hs.pop()
  hf.pop()
  const n = hs.length
  if (n > 0) {
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= n) break
      let c = l
      if (l + 1 < n && hf[l + 1] < hf[l]) c = l + 1
      if (hf[c] >= lastF) break
      hs[i] = hs[c]
      hf[i] = hf[c]
      i = c
    }
    hs[i] = lastS
    hf[i] = lastF
  }
  return top
}

function startsOf(p: PipeParams): { x: number; y: number; dir: number }[] {
  return p.starts ?? [p.start]
}

/** Heuristic cost per tile: undergrounds cover up to `maxUnderground` tiles for two entities and their pair cost. */
function perTile(p: PipeParams): number {
  return math.min(p.minCost, (2 * p.minCost + p.ugCost) / (p.maxUnderground + 1))
}

function cachedCost(s: PipeSearch, cb: PipeCallbacks, x: number, y: number): number {
  const k = tkey(x, y)
  const c = s.tc[k]
  if (c !== undefined) return c
  const v = cb.cost(x, y)
  s.tc[k] = v
  return v
}

function cachedUnder(s: PipeSearch, cb: PipeCallbacks, x: number, y: number, axis: number): boolean {
  const k = tkey(x, y) * 2 + axis
  const u = s.uc[k]
  if (u !== undefined) return u
  const v = cb.under(x, y, axis)
  s.uc[k] = v
  return v
}

/** A tile any route move can use: placeable, or passable under along either axis. */
function traversable(s: PipeSearch, cb: PipeCallbacks, x: number, y: number): boolean {
  return cachedCost(s, cb, x, y) >= 0 || cachedUnder(s, cb, x, y, 0) || cachedUnder(s, cb, x, y, 1)
}

/** A plain pipe at (x, y) touches no other fluid except through its own previous and next tiles. */
function pipeClear(cb: PipeCallbacks, x: number, y: number, back: number, next: number): boolean {
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d]
    const ny = y + DY[d]
    const k = tkey(nx, ny)
    if (k === back || k === next) continue
    if (cb.fluidNear(nx, ny)) return false
  }
  return true
}

// ---------------------------------------------------------------------------------------------------------
// Cells: cell (cx, cy) holds the tiles goal + (cx·C .. cx·C + C − 1, cy·C .. cy·C + C − 1).

function cellSize(s: PipeSearch): number {
  return s.p.cell ?? 0
}

function cellKeyOf(s: PipeSearch, x: number, y: number): number {
  const C = cellSize(s)
  return tkey(math.floor((x - s.p.goal.x) / C), math.floor((y - s.p.goal.y) / C))
}

/** The components of a cell's traversable tiles (4-connected inside the cell). Returns the work it cost. */
function analyzeCell(s: PipeSearch, cb: PipeCallbacks, co: PipeCoarse, cx: number, cy: number): number {
  return analyzeCellInto(s, cb, co.comps, cx, cy)
}

function analyzeCellInto(s: PipeSearch, cb: PipeCallbacks, comps: Record<number, number[]>, cx: number, cy: number): number {
  const ck = tkey(cx, cy)
  if (comps[ck] !== undefined) return 0
  const C = cellSize(s)
  const x0 = s.p.goal.x + cx * C
  const y0 = s.p.goal.y + cy * C
  const comp: number[] = []
  for (let i = 0; i < C * C; i++) comp[i] = traversable(s, cb, x0 + (i % C), y0 + math.floor(i / C)) ? -2 : -1
  let n = 0
  for (let i = 0; i < C * C; i++) {
    if (comp[i] !== -2) continue
    comp[i] = n
    const stack = [i]
    while (stack.length > 0) {
      const t = stack.pop()!
      const tx = t % C
      const ty = math.floor(t / C)
      if (tx > 0 && comp[t - 1] === -2) {
        comp[t - 1] = n
        stack.push(t - 1)
      }
      if (tx < C - 1 && comp[t + 1] === -2) {
        comp[t + 1] = n
        stack.push(t + 1)
      }
      if (ty > 0 && comp[t - C] === -2) {
        comp[t - C] = n
        stack.push(t - C)
      }
      if (ty < C - 1 && comp[t + C] === -2) {
        comp[t + C] = n
        stack.push(t + C)
      }
    }
    n++
  }
  comps[ck] = comp
  // As the belt router's cell work: a cell's tiles cost an eighth of an expansion each.
  return (C * C) / 8
}

/** The coarse node of a tile (cell and component), or undefined when the tile is not traversable. */
function coarseNode(s: PipeSearch, co: { comps: Record<number, number[]> }, x: number, y: number): number | undefined {
  const C = cellSize(s)
  const cx = math.floor((x - s.p.goal.x) / C)
  const cy = math.floor((y - s.p.goal.y) / C)
  const cell = co.comps[tkey(cx, cy)]
  if (cell === undefined) return undefined
  const comp = cell[(y - s.p.goal.y - cy * C) * C + (x - s.p.goal.x - cx * C)]
  return comp < 0 ? undefined : tkey(cx, cy) * C * C + comp
}

function coarseH(s: PipeSearch, co: PipeCoarse, node: number): number {
  const C = cellSize(s)
  const ck = math.floor(node / (C * C))
  const gk = math.floor(co.goal / (C * C))
  const dx = math.abs(keyX(ck) - keyX(gk))
  const dy = math.abs(keyY(ck) - keyY(gk))
  return PIPE_HEURISTIC_WEIGHT * perTile(s.p) * C * (dx + dy)
}

/** Starts the coarse pass when there is a cell size (`s.coarse`); returns the work. Fails the search when no end is traversable. */
function newCoarse(s: PipeSearch, cb: PipeCallbacks): number {
  const C = cellSize(s)
  if (C <= 1) return 0
  const co: PipeCoarse = { comps: {}, g: {}, par: {}, closed: {}, hs: [], hf: [], goal: -1, starts: [] }
  const g = s.p.goal
  let work = analyzeCell(s, cb, co, 0, 0)
  const goal = coarseNode(s, co, g.x, g.y)
  if (goal !== undefined) {
    co.goal = goal
    for (const st of startsOf(s.p)) {
      const cx = math.floor((st.x - g.x) / C)
      const cy = math.floor((st.y - g.y) / C)
      work += analyzeCell(s, cb, co, cx, cy)
      const node = coarseNode(s, co, st.x, st.y)
      if (node === undefined || co.g[node] !== undefined) continue
      co.starts.push(node)
      co.g[node] = 0
      heapPush(co, node, coarseH(s, co, node))
    }
  }
  // An untraversable goal or no traversable start: the coarse search is empty and fails at once.
  s.coarse = co
  return work
}

/**
 * The coarse nodes joined to `node` (4-adjacent traversable tiles across a cell side), analysing the neighbour cells
 * (only those in `within`, when given) as needed; `work` is that analysis.
 */
function coarseNeighbours(s: PipeSearch, cb: PipeCallbacks, comps: Record<number, number[]>, node: number, within?: Record<number, boolean>): { nodes: number[]; work: number } {
  const C = cellSize(s)
  const ck = math.floor(node / (C * C))
  const comp = node % (C * C)
  const cx = keyX(ck)
  const cy = keyY(ck)
  const tiles = comps[ck]
  const nodes: number[] = []
  let work = 0
  for (let d = 0; d < 4; d++) {
    const ncx = cx + DX[d]
    const ncy = cy + DY[d]
    const nk = tkey(ncx, ncy)
    if (within !== undefined && within[nk] !== true) continue
    work += analyzeCellInto(s, cb, comps, ncx, ncy)
    const ntiles = comps[nk]
    const seen: Record<number, boolean> = {}
    for (let i = 0; i < C; i++) {
      // Edge tile i of this cell on side d, and the tile across it in the neighbour.
      const lx = d === 1 ? C - 1 : d === 3 ? 0 : i
      const ly = d === 2 ? C - 1 : d === 0 ? 0 : i
      if (tiles[ly * C + lx] !== comp) continue
      const nlx = d === 1 ? 0 : d === 3 ? C - 1 : i
      const nly = d === 2 ? 0 : d === 0 ? C - 1 : i
      const nc = ntiles[nly * C + nlx]
      if (nc < 0 || seen[nc]) continue
      seen[nc] = true
      nodes.push(nk * C * C + nc)
    }
  }
  return { nodes, work }
}

/**
 * The tile search's guide on a long line: each coarse node's distance in cells to the goal inside the corridor (reverse
 * BFS over the coarse graph, `s.cdq` its queue from `s.cdi`), within `budget`. Seeds the tile search when done.
 */
function stepDistances(s: PipeSearch, cb: PipeCallbacks, budget: number): number {
  const cd = s.cd!
  const queue = s.cdq!
  let used = 0
  while (used < budget && s.cdi! < queue.length) {
    const cur = queue[s.cdi!]
    s.cdi = s.cdi! + 1
    const nb = coarseNeighbours(s, cb, s.comps!, cur, s.corridor)
    used += nb.work + 1
    for (const n of nb.nodes) {
      if (cd[n] !== undefined) continue
      cd[n] = cd[cur] + 1
      queue.push(n)
    }
  }
  if (s.cdi! >= queue.length) {
    s.cdq = undefined
    s.cdi = undefined
    seedTiles(s)
  }
  return used
}

/** Marks the corridor around the coarse path ending at `last`. */
function setCorridor(s: PipeSearch, co: PipeCoarse, last: number): void {
  const C = cellSize(s)
  const r = s.p.corridorCells ?? 1
  const corridor: Record<number, boolean> = {}
  const mark = (node: number, rad: number): void => {
    const ck = math.floor(node / (C * C))
    const cx = keyX(ck)
    const cy = keyY(ck)
    for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) corridor[tkey(cx + dx, cy + dy)] = true
  }
  for (let n: number | undefined = last; n !== undefined; n = co.par[n]) mark(n, r)
  mark(co.goal, r + 1)
  for (const n of co.starts) mark(n, r + 1)
  s.corridor = corridor
}

/** Whether the ends are far enough apart for the tile search to keep to the corridor. */
function isLong(p: PipeParams): boolean {
  const long = p.longRoute ?? 0
  if (long <= 0) return false
  let near = math.huge
  for (const st of startsOf(p)) near = math.min(near, math.abs(st.x - p.goal.x) + math.abs(st.y - p.goal.y))
  return near >= long
}

/** Runs the coarse pass within `budget`; on its end, either fails the search (no path) or seeds the tile search. */
function stepCoarse(s: PipeSearch, cb: PipeCallbacks, budget: number): number {
  const co = s.coarse!
  const C = cellSize(s)
  let used = 0
  while (used < budget) {
    if (co.hs.length === 0) {
      // The traversable tiles do not connect the ends: no move sequence can either.
      s.coarse = undefined
      s.status = "failed"
      s.reason = "search exhausted"
      return used
    }
    const cur = heapPop(co)
    if (co.closed[cur]) continue
    co.closed[cur] = true
    used++
    if (cur === co.goal) {
      s.coarse = undefined
      if (!isLong(s.p)) {
        seedTiles(s)
        return used
      }
      setCorridor(s, co, cur)
      s.comps = co.comps
      s.cd = { [co.goal]: 0 }
      s.cdq = [co.goal]
      s.cdi = 0
      return used
    }
    const nb = coarseNeighbours(s, cb, co.comps, cur)
    used += nb.work
    for (const n of nb.nodes) {
      if (co.closed[n]) continue
      const g = co.g[cur] + C * perTile(s.p)
      if (co.g[n] !== undefined && co.g[n] <= g) continue
      co.g[n] = g
      co.par[n] = cur
      heapPush(co, n, g + coarseH(s, co, n))
    }
  }
  return used
}

// ---------------------------------------------------------------------------------------------------------
// The tile search.

/** Tiles to the goal: Manhattan, or on a long line at least the corridor distance (walls included) of the tile's cell. */
function tilesToGoal(s: PipeSearch, x: number, y: number, cells: number | undefined): number {
  const m = math.abs(x - s.p.goal.x) + math.abs(y - s.p.goal.y)
  return cells === undefined ? m : math.max(m, cellSize(s) * (cells - 1))
}

function visit(s: PipeSearch, x: number, y: number, d: number, g: number, run: number, par: number, mv: number): void {
  if (s.corridor !== undefined && s.corridor[cellKeyOf(s, x, y)] !== true) return
  let cells: number | undefined
  if (s.cd !== undefined) {
    // Inside the corridor, a tile whose component does not lead to the goal there is a dead end.
    const node = coarseNode(s, s as { comps: Record<number, number[]> }, x, y)
    cells = node !== undefined ? s.cd[node] : undefined
    if (cells === undefined) return
  }
  const key = tkey(x, y) * 4 + d
  const b = s.best[key]
  if (b !== undefined && b <= g) return
  s.best[key] = g
  const i = s.nx.length
  s.nx.push(x)
  s.ny.push(y)
  s.nd.push(d)
  s.ng.push(g)
  s.nrun.push(run)
  s.npar.push(par)
  s.nmv.push(mv)
  heapPush(s, i, g + tilesToGoal(s, x, y, cells) * perTile(s.p) * PIPE_HEURISTIC_WEIGHT)
}

function seedTiles(s: PipeSearch): void {
  s.nx = []
  s.ny = []
  s.nd = []
  s.ng = []
  s.nrun = []
  s.npar = []
  s.nmv = []
  s.hs = []
  s.hf = []
  s.best = {}
  for (const st of startsOf(s.p)) visit(s, st.x, st.y, st.dir, 0, 0, -1, MV_START)
}

/** The steps from the start to node `i` (each move placed something on or from its parent's tile). */
function stepsTo(s: PipeSearch, i: number): PipeStep[] {
  const rev: PipeStep[][] = []
  for (let n = i; n >= 0 && s.nmv[n] !== MV_START; n = s.npar[n]) {
    const p = s.npar[n]
    const px = s.nx[p]
    const py = s.ny[p]
    const mv = s.nmv[n]
    if (mv === MV_PIPE) rev.push([{ kind: "pipe", x: px, y: py, dir: s.nd[n] }])
    else if (mv === MV_PUMP) rev.push([{ kind: "pump", x: px, y: py, dir: s.nd[p] }])
    else {
      const d = s.nd[n]
      rev.push([
        { kind: "ug-in", x: px, y: py, dir: d },
        { kind: "ug-out", x: s.nx[n] - DX[d], y: s.ny[n] - DY[d], dir: d },
      ])
    }
  }
  const steps: PipeStep[] = []
  for (let k = rev.length - 1; k >= 0; k--) for (const st of rev[k]) steps.push(st)
  return steps
}

function found(s: PipeSearch, i: number, last: PipeStep[], cost: number): void {
  const steps = stepsTo(s, i)
  for (const st of last) steps.push(st)
  s.status = "found"
  s.result = { steps, cost, expansions: s.work }
}

/** Expands node `i`. */
function expand(s: PipeSearch, cb: PipeCallbacks, i: number): void {
  const p = s.p
  const goal = p.goal
  const x = s.nx[i]
  const y = s.ny[i]
  const d0 = s.nd[i]
  const g0 = s.ng[i]
  const run = s.nrun[i]
  const back = tkey(x - DX[d0], y - DY[d0])
  const c = cachedCost(s, cb, x, y)
  if (c < 0) return
  // Arrived: a plain pipe on the goal tile joins the port.
  if (x === goal.x && y === goal.y && run + 1 <= p.extent && pipeClear(cb, x, y, back, tkey(x + DX[goal.dir], y + DY[goal.dir]))) {
    found(s, i, [{ kind: "pipe", x, y, dir: d0 }], g0 + c)
    return
  }
  // A plain pipe here, turning any way but back.
  if (run + 1 <= p.extent) {
    for (let d = 0; d < 4; d++) {
      if (d === opposite(d0)) continue
      const nx = x + DX[d]
      const ny = y + DY[d]
      if (cb.fluidNear(nx, ny) || !pipeClear(cb, x, y, back, tkey(nx, ny))) continue
      visit(s, nx, ny, d, g0 + c, run + 1, i, MV_PIPE)
    }
  }
  // A pipe-to-ground pair along the heading.
  const axis = d0 % 2
  for (let k = 2; k <= p.maxUnderground; k++) {
    const ex = x + DX[d0] * k
    const ey = y + DY[d0] * k
    if (!cachedUnder(s, cb, ex - DX[d0], ey - DY[d0], axis)) break
    if (run + k + 1 > p.extent) break
    const ce = cachedCost(s, cb, ex, ey)
    if (ce < 0) continue
    const g = g0 + c + ce + p.ugCost
    // The exit on the goal tile, facing into the port, arrives too.
    if (ex === goal.x && ey === goal.y && d0 === goal.dir) {
      found(s, i, [
        { kind: "ug-in", x, y, dir: d0 },
        { kind: "ug-out", x: ex, y: ey, dir: d0 },
      ], g)
      return
    }
    visit(s, ex + DX[d0], ey + DY[d0], d0, g, run + k + 1, i, MV_UG)
  }
  // A pump along the heading: a new segment starts behind it.
  const px = x + DX[d0]
  const py = y + DY[d0]
  if (run > 0) {
    const cp = cachedCost(s, cb, px, py)
    if (cp >= 0) visit(s, px + DX[d0], py + DY[d0], d0, g0 + c + cp + p.pumpCost, 0, i, MV_PUMP)
  }
}

/** A new pipe search; step it with `stepPipeSearch`. */
export function newPipeSearch(p: PipeParams): PipeSearch {
  return { p, status: "running", work: 0, nx: [], ny: [], nd: [], ng: [], nrun: [], npar: [], nmv: [], hs: [], hf: [], best: {}, tc: {}, uc: {} }
}

/** Advances the search by about `budget` work units; returns the work done. */
export function stepPipeSearch(s: PipeSearch, cb: PipeCallbacks, budget: number): number {
  let used = 0
  if (s.status !== "running") return 0
  if (!s.started) {
    s.started = true
    used += newCoarse(s, cb)
    if (s.coarse === undefined) seedTiles(s)
  }
  while (s.status === "running" && used < budget) {
    if (s.work + used >= s.p.budget) {
      s.status = "failed"
      s.reason = "budget exhausted"
      break
    }
    if (s.coarse !== undefined) {
      used += stepCoarse(s, cb, math.min(budget - used, s.p.budget - s.work - used))
      continue
    }
    if (s.cdq !== undefined) {
      used += stepDistances(s, cb, budget - used)
      continue
    }
    if (s.hs.length === 0) {
      if (s.corridor !== undefined) {
        // The corridor search ran out: search without it (the coarse path exists, so there is one).
        s.corridor = undefined
        s.cd = undefined
        s.widened = true
        seedTiles(s)
        continue
      }
      s.status = "failed"
      s.reason = "search exhausted"
      break
    }
    const i = heapPop(s)
    const key = tkey(s.nx[i], s.ny[i]) * 4 + s.nd[i]
    if (s.best[key] < s.ng[i]) continue
    used++
    expand(s, cb, i)
  }
  s.work += used
  if (s.result !== undefined) s.result.expansions = s.work
  return used
}

/** Routes one pipe line to the end (tests, one-shot callers); `undefined` when no path was found within the budget. */
export function routePipe(req: PipeRequest): PipeResult | undefined {
  const s = newPipeSearch(req)
  while (s.status === "running") stepPipeSearch(s, req, req.budget)
  if (s.status === "found") return s.result
  if (req.failure !== undefined) {
    req.failure.expansions = s.work
    req.failure.reason = s.reason
  }
  return undefined
}
