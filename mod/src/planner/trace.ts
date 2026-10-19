// Plan decision trace (T1 plan-replay dumps, README "Debugging a failing soak seed"): why each module went where it
// did (the best candidates with every weighted score term, rejected candidates with what blocked them) and why routes
// failed (what walls the explored region). Off unless a tool sets `planTrace.sink`, which the mod never does: the
// planner then pays one nil check per placement candidate and per failure. Pure: no Factorio globals.

import { BLOCK_NAMES, DX, DY, FREE, keyX, keyY, Rect, TerrainView, tkey, Vec } from "./grid"
import { LayoutState } from "./layout"
import { CandidateFeatures, LayoutPolicy } from "./policy"
import { Search, tileCost } from "./router"

/** One scored placement candidate. */
export interface CandidateTrace {
  transform: string
  origin: Vec
  rect: Rect
  score: number
  /** Weighted score terms (policy.placementTerms): they sum to `score`. Lower is better. */
  terms: Record<string, number>
  features: CandidateFeatures
}

/** A rejected placement candidate and the first thing that rules it out. */
export interface RejectTrace {
  transform: string
  origin: Vec
  /** Manhattan distance from the footprint centre to the placement centre (the `center` term's feature). */
  centerDist: number
  blocker: string
}

export interface PlacementTrace {
  module: string
  def: string
  phase: "done" | "failed"
  reason?: string
  center: Vec
  target?: Vec
  /** Search radius the search ended at. */
  radius?: number
  candidates: number
  feasible: number
  chosen?: CandidateTrace
  /** The best feasible candidates (chosen first), lowest score first. */
  top: CandidateTrace[]
  /** Rejection reason → count and the examples nearest the centre. */
  rejected: Record<string, { count: number; examples: RejectTrace[] }>
}

export interface RouteFailureTrace {
  conn: string
  /** "plan", or "compare" for a D36 / B2 comparison branch. */
  branch: string
  reason: string
  rip?: boolean
  start?: string
  goal?: string
  window?: Rect
  expansions?: number
  /** Tiles the search reached. */
  explored?: number
  /** What blocks the tiles next to the explored region, most tiles first (with one example tile each). */
  walls?: { blocker: string; tiles: number; example: string }[]
  /** Start / goal tile and their 4 neighbours, described. */
  around?: string[]
}

export interface PlanTraceSink {
  placements: PlacementTrace[]
  routeFailures: RouteFailureTrace[]
  /** Expansions, shared-mine completions, re-placements, module failures, in order. */
  events: string[]
  maxTop: number
  maxExamples: number
}

/** Placement search accumulator (lives on the search while tracing). */
export interface PlacementAcc {
  feasible: number
  top: { ti: number; ox: number; oy: number; score: number }[]
  seen: Record<string, boolean>
  rejected: Record<string, { count: number; examples: { ti: number; ox: number; oy: number; dist: number }[] }>
}

export const planTrace: { sink?: PlanTraceSink } = {}

export function newTraceSink(maxTop = 8, maxExamples = 3): PlanTraceSink {
  return { placements: [], routeFailures: [], events: [], maxTop, maxExamples }
}

export function newPlacementAcc(): PlacementAcc {
  return { feasible: 0, top: [], seen: {}, rejected: {} }
}

export function traceEvent(text: string): void {
  planTrace.sink?.events.push(text)
}

export function noteReject(acc: PlacementAcc, why: string, ti: number, ox: number, oy: number, dist: number): void {
  const max = planTrace.sink?.maxExamples ?? 3
  let r = acc.rejected[why]
  if (r === undefined) {
    r = { count: 0, examples: [] }
    acc.rejected[why] = r
  }
  r.count++
  const ex = r.examples
  if (ex.length >= max && ex[ex.length - 1].dist <= dist) return
  ex.push({ ti, ox, oy, dist })
  ex.sort((a, b) => a.dist - b.dist)
  if (ex.length > max) ex.pop()
}

export function noteFeasible(acc: PlacementAcc, ti: number, ox: number, oy: number, score: number): void {
  const key = `${ti}:${ox},${oy}`
  if (acc.seen[key]) return
  acc.seen[key] = true
  acc.feasible++
  const max = planTrace.sink?.maxTop ?? 8
  const top = acc.top
  if (top.length >= max && top[top.length - 1].score <= score) return
  top.push({ ti, ox, oy, score })
  top.sort((a, b) => a.score - b.score)
  if (top.length > max) top.pop()
}

/** Everything the layout and terrain say about a tile ("free" if nothing). */
export function describeTile(state: LayoutState, terrain: TerrainView, x: number, y: number): string {
  const k = tkey(x, y)
  const parts: string[] = []
  const o = state.occ[k]
  if (o !== undefined) parts.push(`occupied ${o}`)
  const r = state.reserved[k]
  if (r !== undefined) parts.push(`reserved ${r}`)
  const ro = state.routeOcc[k]
  if (ro !== undefined) parts.push(`route ${ro}${state.routes[ro]?.fixed ? " (fixed)" : ""}`)
  const mo = state.mine?.[k]
  if (mo !== undefined) parts.push(`mine claim ${mo}`)
  const b = terrain.block(x, y)
  if (b !== FREE) parts.push(`terrain ${BLOCK_NAMES[b] ?? b}`)
  const ore = terrain.ore(x, y)
  if (ore !== undefined) parts.push(`ore ${ore}`)
  const so = state.soft?.[k]
  if (so !== undefined) parts.push(`soft claim ${so}`)
  return parts.length > 0 ? parts.join("; ") : "free"
}

/** Why the router can't put a belt on a tile, as a grouping key (the first rule of `tileCost` that refuses it). */
function routeBlocker(state: LayoutState, terrain: TerrainView, search: Search, x: number, y: number): string {
  const k = tkey(x, y)
  const req = search.req
  const o = state.occ[k]
  if (o !== undefined) return `occupied ${o}`
  const r = state.reserved[k]
  if (r !== undefined && !req.own[r]) return `reserved ${r}`
  const mo = state.mine?.[k]
  if (mo !== undefined && mo !== req.to.module && mo !== req.from?.module) return `mine claim ${mo}`
  const ro = state.routeOcc[k]
  if (ro !== undefined) return `route ${ro}${state.routes[ro]?.fixed ? " (fixed)" : search.rip ? "" : " (no rip pass)"}`
  const b = terrain.block(x, y)
  return `terrain ${BLOCK_NAMES[b] ?? b}`
}

/** Records a connection that failed (for good, or before a re-placement), with what walls in its last search (if any). */
export function traceRouteFailure(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, conn: string, reason: string, branch: string, search?: Search): RouteFailureTrace | undefined {
  const sink = planTrace.sink
  if (sink === undefined) return undefined
  const t: RouteFailureTrace = { conn, branch, reason }
  sink.routeFailures.push(t)
  if (search === undefined) return t
  const req = search.req
  t.rip = search.rip
  t.window = { x: search.x0, y: search.y0, w: search.w, h: search.h }
  t.expansions = search.expansions
  if (req.start !== undefined) t.start = `${req.start.x},${req.start.y} dir ${req.start.dir}`
  t.goal = `${req.goal.x},${req.goal.y} dir ${req.goal.dir}${req.goal.side !== undefined ? ` side ${req.goal.side}` : ""}`
  const explored: Record<number, boolean> = {}
  let n = 0
  for (const [st] of pairs(search.closed)) {
    const idx = math.floor((st as number) / 4)
    const x = search.x0 + (idx % search.w)
    const y = search.y0 + math.floor(idx / search.w)
    const k = tkey(x, y)
    if (!explored[k]) {
      explored[k] = true
      n++
    }
  }
  t.explored = n
  const walls: Record<string, { tiles: number; example: string }> = {}
  const order: string[] = []
  const counted: Record<number, boolean> = {}
  for (const [k] of pairs(explored)) {
    const kk = k as number
    const x = keyX(kk)
    const y = keyY(kk)
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]
      const ny = y + DY[d]
      const nk = tkey(nx, ny)
      if (explored[nk] || counted[nk]) continue
      let key: string | undefined
      if (nx < search.x0 || ny < search.y0 || nx >= search.x0 + search.w || ny >= search.y0 + search.h) key = "search window edge"
      else if (tileCost(state, terrain, policy, req, search.rip, nx, ny) < 0) key = routeBlocker(state, terrain, search, nx, ny)
      if (key === undefined) continue
      counted[nk] = true
      if (walls[key] === undefined) {
        walls[key] = { tiles: 0, example: `${nx},${ny}` }
        order.push(key)
      }
      walls[key].tiles++
    }
  }
  t.walls = order.map((blocker) => ({ blocker, tiles: walls[blocker].tiles, example: walls[blocker].example }))
  t.walls.sort((a, b) => (a.tiles !== b.tiles ? b.tiles - a.tiles : a.blocker < b.blocker ? -1 : a.blocker > b.blocker ? 1 : 0))
  if (t.walls.length > 12) t.walls = t.walls.slice(0, 12)
  const around: string[] = []
  const describeAround = (what: string, x: number, y: number): void => {
    around.push(`${what} ${x},${y}: ${describeTile(state, terrain, x, y)}`)
    for (let d = 0; d < 4; d++) around.push(`  ${["N", "E", "S", "W"][d]} ${x + DX[d]},${y + DY[d]}: ${describeTile(state, terrain, x + DX[d], y + DY[d])}`)
  }
  if (req.start !== undefined) describeAround("start", req.start.x, req.start.y)
  describeAround("goal", req.goal.x, req.goal.y)
  t.around = around
  return t
}
