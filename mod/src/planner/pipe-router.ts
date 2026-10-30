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
// Pure: no Factorio globals; terrain, claims and other fluids come in as callbacks (T1: mod/unit/pipe-router.test.ts).

import { DX, DY, opposite, tkey } from "./grid"

export interface PipeRequest {
  /** First tile outside the `pipe-out` port, and the direction away from the machine. */
  start: { x: number; y: number; dir: number }
  /** Tile outside the `pipe-in` port, and the direction from it into the machine. */
  goal: { x: number; y: number; dir: number }
  /** Farthest a pipe-to-ground exit may be from its entrance (`max_underground_distance`). */
  maxUnderground: number
  /** Most tiles of path in one fluid segment (`default_pipeline_extent`); a pump starts a new one. */
  extent: number
  /** Cost of putting an entity on a tile (≥ the cheapest tile), or < 0 when it cannot go there. */
  cost: (this: void, x: number, y: number) => number
  /** Whether a pipe-to-ground span may pass under a tile running along `axis` (0 = N/S, 1 = E/W). */
  under: (this: void, x: number, y: number, axis: number) => boolean
  /** Whether another fluid box (another route's pipe, another port) connects into this tile. */
  fluidNear: (this: void, x: number, y: number) => boolean
  /** The cheapest a tile can cost (keeps the heuristic honest). */
  minCost: number
  /** Extra cost of a pipe-to-ground pair, and of a pump (they are dearer items than a pipe). */
  ugCost: number
  pumpCost: number
  /** Expansions before giving up. */
  budget: number
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
  expansions: number
}

interface Node {
  x: number
  y: number
  d: number
  g: number
  /** Path tiles since the source or the last pump. */
  run: number
  parent?: Node
  /** The steps the move into this node placed. */
  placed: PipeStep[]
}

/** A plain pipe at (x, y) touches no other fluid except through `keep` (its own previous and next tiles). */
function pipeClear(req: PipeRequest, x: number, y: number, keep: number[]): boolean {
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d]
    const ny = y + DY[d]
    if (keep.indexOf(tkey(nx, ny)) >= 0) continue
    if (req.fluidNear(nx, ny)) return false
  }
  return true
}

function push(heap: { n: Node; f: number }[], n: Node, f: number): void {
  heap.push({ n, f })
  let i = heap.length - 1
  while (i > 0) {
    const p = math.floor((i - 1) / 2)
    if (heap[p].f <= heap[i].f) break
    const t = heap[p]
    heap[p] = heap[i]
    heap[i] = t
    i = p
  }
}

function pop(heap: { n: Node; f: number }[]): Node | undefined {
  if (heap.length === 0) return undefined
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && heap[l].f < heap[m].f) m = l
      if (r < heap.length && heap[r].f < heap[m].f) m = r
      if (m === i) break
      const t = heap[m]
      heap[m] = heap[i]
      heap[i] = t
      i = m
    }
  }
  return top.n
}

/** Routes one pipe line; `undefined` when no path was found within the budget. */
export function routePipe(req: PipeRequest): PipeResult | undefined {
  const goal = req.goal
  // Undergrounds cover up to `maxUnderground` tiles for two entities: a tile can cost this little on the way.
  const perTile = (2 * req.minCost) / (req.maxUnderground + 1)
  const h = (x: number, y: number): number => (math.abs(x - goal.x) + math.abs(y - goal.y)) * perTile
  const best: Record<number, number> = {}
  const heap: { n: Node; f: number }[] = []
  const first: Node = { x: req.start.x, y: req.start.y, d: req.start.dir, g: 0, run: 0, placed: [] }
  push(heap, first, h(first.x, first.y))
  let expansions = 0
  const visit = (n: Node): void => {
    const key = tkey(n.x, n.y) * 4 + n.d
    if (best[key] !== undefined && best[key] <= n.g) return
    best[key] = n.g
    push(heap, n, n.g + h(n.x, n.y))
  }
  for (;;) {
    const n = pop(heap)
    if (n === undefined || expansions >= req.budget) return undefined
    const key = tkey(n.x, n.y) * 4 + n.d
    if (best[key] !== undefined && best[key] < n.g) continue
    expansions++
    const back = tkey(n.x - DX[n.d], n.y - DY[n.d])
    const c = req.cost(n.x, n.y)
    if (c < 0) continue
    // Arrived: a plain pipe on the goal tile joins the port.
    if (n.x === goal.x && n.y === goal.y && n.run + 1 <= req.extent && pipeClear(req, n.x, n.y, [back, tkey(n.x + DX[goal.dir], n.y + DY[goal.dir])])) {
      return finish({ ...n, g: n.g + c, placed: [{ kind: "pipe", x: n.x, y: n.y, dir: n.d }], parent: n }, expansions)
    }
    // A plain pipe here, turning any way but back.
    for (let d = 0; d < 4; d++) {
      if (d === opposite(n.d) || n.run + 1 > req.extent) continue
      const nx = n.x + DX[d]
      const ny = n.y + DY[d]
      if (req.fluidNear(nx, ny) || !pipeClear(req, n.x, n.y, [back, tkey(nx, ny)])) continue
      visit({ x: nx, y: ny, d, g: n.g + c, run: n.run + 1, parent: n, placed: [{ kind: "pipe", x: n.x, y: n.y, dir: d }] })
    }
    // A pipe-to-ground pair along the heading.
    const axis = n.d % 2
    for (let k = 2; k <= req.maxUnderground; k++) {
      const ex = n.x + DX[n.d] * k
      const ey = n.y + DY[n.d] * k
      if (!req.under(ex - DX[n.d], ey - DY[n.d], axis)) break
      if (n.run + k + 1 > req.extent) break
      const ce = req.cost(ex, ey)
      if (ce < 0) continue
      const placed: PipeStep[] = [
        { kind: "ug-in", x: n.x, y: n.y, dir: n.d },
        { kind: "ug-out", x: ex, y: ey, dir: n.d },
      ]
      const g = n.g + c + ce + req.ugCost
      // The exit on the goal tile, facing into the port, arrives too.
      if (ex === goal.x && ey === goal.y && n.d === goal.dir) {
        return finish({ x: ex, y: ey, d: n.d, g, run: n.run + k + 1, parent: n, placed }, expansions)
      }
      visit({ x: ex + DX[n.d], y: ey + DY[n.d], d: n.d, g, run: n.run + k + 1, parent: n, placed })
    }
    // A pump along the heading: a new segment starts behind it.
    const px = n.x + DX[n.d]
    const py = n.y + DY[n.d]
    const cp = req.cost(px, py)
    if (cp >= 0 && n.run > 0) {
      visit({ x: px + DX[n.d], y: py + DY[n.d], d: n.d, g: n.g + c + cp + req.pumpCost, run: 0, parent: n, placed: [{ kind: "pump", x: n.x, y: n.y, dir: n.d }] })
    }
  }
}

function finish(last: Node, expansions: number): PipeResult {
  const parts: PipeStep[][] = []
  let cur: Node | undefined = last
  while (cur !== undefined) {
    parts.push(cur.placed)
    cur = cur.parent
  }
  const steps: PipeStep[] = []
  for (let i = parts.length - 1; i >= 0; i--) for (const s of parts[i]) steps.push(s)
  return { steps, cost: last.g, expansions }
}
