// Belt router (SPEC §5.3): A* over (tile, heading) states on the real terrain, with belts, turns, undergrounds
// (up to the tier's maximum) and splitter taps, arriving at an input port from the required side. Resumable and
// budgeted (§5.6): `stepSearch` runs a bounded number of expansions per call. Rip-up mode lets a search pass through
// other routes' tiles at a cost and reports them as victims (`plan.ts` rips them up and reroutes them).
// Pure: no Factorio globals.
//
// State (T, h): items arrive at tile T heading h (from T − h). Moves from (T, h):
//   - belt at T pointing d ∈ {h, left, right} → (T + d, d)    (a belt fed from its side with nothing behind is a curve)
//   - underground entrance at T pointing h, exit at E = T + k·h (2 ≤ k ≤ max) → (E + h, h)
// Start: (outside tile of the belt-out port, port dir), or a splitter tap next to a route of the same producer.
// Goal: (input port tile, port dir), or from the side for `Port.side` (with an unfed blocker belt behind the port
// tile, so the arrival is a side-load and not a curve).
// No foreign belt can point into a route tile: every belt's successor belongs to its own route, module edge belts
// and inserters reserve the tiles they touch (`interactionTiles`), and port outside tiles are reserved.

import { BeltTier } from "./capacity"
import { ccw, cw, DX, DY, FREE, keyX, keyY, OWN, ROCK, TerrainView, tkey, TREE, UNKNOWN } from "./grid"
import { LayoutState, lineKey, PortRef, Route, RouteStep, spanConflicts } from "./layout"
import { LayoutPolicy } from "./policy"

export interface RouteRequest {
  id: string
  conn: string
  item: string
  from?: PortRef
  to: PortRef
  /** First route tile and heading (a belt-out port's outside tile and direction). Absent: taps only. */
  start?: { x: number; y: number; dir: number }
  /** The input port's own tile and direction (index); `side` for side-loading. */
  goal: { x: number; y: number; dir: number; side?: "left" | "right" }
  /** Routes of the same producer port this one may tap with a splitter (splitter-tap topology). */
  taps?: string[]
  tier: BeltTier
  /** Reserved tags this route may use (its own ports' outside tiles). */
  own: Record<string, boolean>
  /** Tiles to avoid (extra cost), e.g. after a self-intersecting attempt. */
  avoid?: Record<number, boolean>
  /** B28: this edge's search window scale (×the policy margin); a retry after "no path" widens the detour room. */
  windowMargin?: number
}

interface TapStart {
  route: string
  x: number
  y: number
  x2: number
  y2: number
  dir: number
}

export interface Search {
  req: RouteRequest
  rip: boolean
  x0: number
  y0: number
  w: number
  h: number
  g: Record<number, number>
  par: Record<number, number>
  /** Move into the state: 0 belt, k ≥ 2 underground of length k, -1 start, -2 splitter tap start. */
  mv: Record<number, number>
  closed: Record<number, boolean>
  hs: number[]
  hf: number[]
  taps: Record<number, TapStart>
  goalS: number
  hMin: number
  expansions: number
  status: "running" | "found" | "failed"
  found?: number
  reason?: string
}

// ---------------------------------------------------------------------------------------------------------
// Binary heap on parallel arrays (state, f). Ties: lower f first, then insertion order is not guaranteed but the
// whole procedure is deterministic.

function heapPush(s: Search, state: number, f: number): void {
  const hs = s.hs
  const hf = s.hf
  let i = hs.length
  hs.push(state)
  hf.push(f)
  while (i > 0) {
    const p = math.floor((i - 1) / 2)
    if (hf[p] <= f) break
    hs[i] = hs[p]
    hf[i] = hf[p]
    i = p
  }
  hs[i] = state
  hf[i] = f
}

function heapPop(s: Search): number {
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

// ---------------------------------------------------------------------------------------------------------

function encode(s: Search, x: number, y: number, d: number): number {
  return ((y - s.y0) * s.w + (x - s.x0)) * 4 + d
}

function inWindow(s: Search, x: number, y: number): boolean {
  return x >= s.x0 && y >= s.y0 && x < s.x0 + s.w && y < s.y0 + s.h
}

/**
 * Cost of a belt (or underground end) on a tile, or -1 if it can't go there. In rip mode, other routes' tiles cost
 * `rip` extra instead of blocking.
 */
export function tileCost(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip: boolean, x: number, y: number): number {
  const k = tkey(x, y)
  if (state.occ[k] !== undefined) return -1
  const r = state.reserved[k]
  if (r !== undefined && !req.own[r]) return -1
  // D52 (3): a mining outpost's room to grow takes only its own routes.
  const mo = state.mine?.[k]
  if (mo !== undefined && mo !== req.to.module && mo !== req.from?.module) return -1
  const w = policy.router
  let extra = 0
  const occupant = state.routeOcc[k]
  if (occupant !== undefined) {
    if (!rip || state.routes[occupant]?.fixed) return -1
    extra += w.rip
  }
  const b = terrain.block(x, y)
  if (b === TREE) {
    if (policy.obstacles.trees !== "clear") return -1
    extra += w.clearTree
  } else if (b === ROCK) {
    if (policy.obstacles.rocks !== "clear") return -1
    extra += w.clearRock
  } else if (b !== FREE) {
    // B23: an input port's outside tile is reserved for the route that feeds it, and in the field that tile holds
    // the module's unfed receive belt (an own-terrain entity): the feeder route replaces the belt in place.
    if (b !== OWN || r === undefined || !req.own[r]) return -1
  }
  if (terrain.ore(x, y) !== undefined) extra += w.oreTile
  if (req.avoid?.[k]) extra += w.rip
  // B9: another module's room to grow (a route there would block its expansion). A module's own routes don't pay: its
  // ports sit at the growing end and move with it, so its routes are rerouted when it grows anyway.
  const soft = w.softClaim ?? 0
  if (soft > 0) {
    const owner = state.soft?.[k]
    if (owner !== undefined && owner !== req.to.module && owner !== req.from?.module) extra += soft
  }
  let f = state.corridor[k] ? w.corridorFactor : 1
  // B7: next to another route's belt, routes bundle.
  const bf = w.bundleFactor ?? 1
  if (bf < 1 && nextToRoute(state, x, y, req.id)) f *= bf
  return f + extra
}

/** Whether a 4-neighbour of the tile holds a belt of another route (existing or planned). */
function nextToRoute(state: LayoutState, x: number, y: number, self: string): boolean {
  for (let d = 0; d < 4; d++) {
    const o = state.routeOcc[tkey(x + DX[d], y + DY[d])]
    if (o !== undefined && o !== self) return true
  }
  return false
}

/** The cheapest a route tile can cost (the A* heuristic per tile must not exceed it). */
export function minTileCost(policy: LayoutPolicy): number {
  const w = policy.router
  return w.corridorFactor * math.min(1, w.bundleFactor ?? 1)
}

/** Whether an underground may pass under a tile (anything but module footprints, unless allowed, and unknown land). */
function underPassable(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, x: number, y: number): boolean {
  const o = state.occ[tkey(x, y)]
  if (o !== undefined && !policy.router.underModules && string.sub(o, 1, 2) === "m:") return false
  return terrain.block(x, y) !== UNKNOWN
}

function sideHeading(dir: number, side: "left" | "right" | undefined): number {
  if (side === undefined) return dir
  return side === "left" ? cw(dir) : ccw(dir)
}

/** The tile behind an input port that a side-loaded arrival needs as an unfed blocker belt. */
export function blockerTile(goal: RouteRequest["goal"]): { x: number; y: number } {
  return { x: goal.x - DX[goal.dir], y: goal.y - DY[goal.dir] }
}

/** Splitter tap candidates on a route: a straight belt with a free tile beside it (on either side). */
function tapCandidates(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip: boolean, routeId: string): { tap: TapStart; cost: number }[] {
  const out: { tap: TapStart; cost: number }[] = []
  const route = state.routes[routeId]
  if (route === undefined) return out
  let heading = -1
  if (route.tapOf === undefined && route.startDir !== undefined) heading = route.startDir
  // Tiles already used by a splitter on this route.
  const splitAt: Record<number, boolean> = {}
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    if (r.tapOf === routeId && r.steps[0]?.kind === "splitter") splitAt[tkey(r.steps[0].x, r.steps[0].y)] = true
  }
  let prevDir = -1
  for (let i = 0; i < route.steps.length; i++) {
    const st = route.steps[i]
    const incoming = i === 0 ? (route.tapOf === undefined ? heading : -1) : prevDir
    prevDir = st.dir
    if (st.kind !== "belt" || st.dir !== incoming || splitAt[tkey(st.x, st.y)]) continue
    // The next step must take the belt's output straight (any belt or entrance at T + d does).
    const next = route.steps[i + 1]
    if (next === undefined || next.x !== st.x + DX[st.dir] || next.y !== st.y + DY[st.dir]) continue
    for (const side of [cw(st.dir), ccw(st.dir)]) {
      const nx = st.x + DX[side]
      const ny = st.y + DY[side]
      const c = tileCost(state, terrain, policy, req, rip, nx, ny)
      if (c < 0) continue
      out.push({ tap: { route: routeId, x: st.x, y: st.y, x2: nx, y2: ny, dir: st.dir }, cost: policy.router.splitter + c })
    }
  }
  return out
}

export function newSearch(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip: boolean): Search {
  // Window: the endpoints (and tapped routes) plus a margin.
  let x1 = req.goal.x
  let y1 = req.goal.y
  let x2 = req.goal.x
  let y2 = req.goal.y
  const grow = (x: number, y: number): void => {
    x1 = math.min(x1, x)
    y1 = math.min(y1, y)
    x2 = math.max(x2, x)
    y2 = math.max(y2, y)
  }
  if (req.start) grow(req.start.x, req.start.y)
  for (const id of req.taps ?? []) for (const k of state.routes[id]?.tiles ?? []) grow(keyX(k), keyY(k))
  const m = policy.router.margin * (req.windowMargin ?? 1)
  const w = policy.router
  const maxK = req.tier.maxUnderground
  const s: Search = {
    req,
    rip,
    x0: x1 - m,
    y0: y1 - m,
    w: x2 - x1 + 2 * m + 1,
    h: y2 - y1 + 2 * m + 1,
    g: {},
    par: {},
    mv: {},
    closed: {},
    hs: [],
    hf: [],
    taps: {},
    goalS: 0,
    hMin: math.min(minTileCost(policy), (w.underground + 2 * minTileCost(policy)) / (maxK + 1)),
    expansions: 0,
    status: "running",
  }
  s.goalS = encode(s, req.goal.x, req.goal.y, sideHeading(req.goal.dir, req.goal.side))
  const push = (x: number, y: number, d: number, g: number, mv: number): number | undefined => {
    if (!inWindow(s, x, y)) return undefined
    const st = encode(s, x, y, d)
    if (s.g[st] !== undefined && s.g[st] <= g) return undefined
    s.g[st] = g
    s.mv[st] = mv
    heapPush(s, st, g + s.hMin * (math.abs(x - req.goal.x) + math.abs(y - req.goal.y)))
    return st
  }
  if (req.start) push(req.start.x, req.start.y, req.start.dir, 0, -1)
  for (const id of req.taps ?? []) {
    for (const c of tapCandidates(state, terrain, policy, req, rip, id)) {
      const t = c.tap
      const st = push(t.x2 + DX[t.dir], t.y2 + DY[t.dir], t.dir, c.cost, -2)
      if (st !== undefined) s.taps[st] = t
    }
  }
  if (s.hs.length === 0) {
    s.status = "failed"
    s.reason = "no start"
  }
  return s
}

/** Runs up to `budget` expansions. Returns the number used. */
export function stepSearch(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const req = s.req
  const w = policy.router
  const maxK = req.tier.maxUnderground
  const gx = req.goal.x
  const gy = req.goal.y
  let used = 0
  // The blocker tile behind a side-loaded port stays free.
  const blocked: Record<number, boolean> = {}
  if (req.goal.side !== undefined) {
    const b = blockerTile(req.goal)
    blocked[tkey(b.x, b.y)] = true
  }
  const cost = (x: number, y: number): number => {
    if (blocked[tkey(x, y)]) return -1
    return tileCost(state, terrain, policy, req, s.rip, x, y)
  }
  const push = (parent: number, x: number, y: number, d: number, g: number, mv: number): void => {
    if (!inWindow(s, x, y)) return
    const st = encode(s, x, y, d)
    if (s.closed[st]) return
    const old = s.g[st]
    if (old !== undefined && old <= g) return
    s.g[st] = g
    s.par[st] = parent
    s.mv[st] = mv
    heapPush(s, st, g + s.hMin * (math.abs(x - gx) + math.abs(y - gy)))
  }
  while (s.status === "running" && used < budget) {
    if (s.hs.length === 0) {
      s.status = "failed"
      s.reason = "no path"
      break
    }
    const cur = heapPop(s)
    if (s.closed[cur]) continue
    s.closed[cur] = true
    used++
    s.expansions++
    if (cur === s.goalS) {
      s.status = "found"
      s.found = cur
      break
    }
    const d = cur % 4
    const t = math.floor(cur / 4)
    const x = s.x0 + (t % s.w)
    const y = s.y0 + math.floor(t / s.w)
    // The goal tile is the port's own tile (inside its module): nothing is placed there and nothing continues.
    if (x === gx && y === gy) continue
    const c = cost(x, y)
    if (c < 0) continue
    const g = s.g[cur]
    for (const nd of [d, cw(d), ccw(d)]) push(cur, x + DX[nd], y + DY[nd], nd, g + c + (nd === d ? 0 : w.turn), 0)
    // Undergrounds: entered straight, exit k tiles ahead.
    const line = lineKey(x, y, d)
    for (let k = 2; k <= maxK; k++) {
      const mx = x + DX[d] * (k - 1)
      const my = y + DY[d] * (k - 1)
      if (!underPassable(state, terrain, policy, mx, my)) break
      const ex = x + DX[d] * k
      const ey = y + DY[d] * k
      if (!inWindow(s, ex, ey)) break
      const ce = cost(ex, ey)
      if (ce < 0) continue
      const a = d % 2 === 1 ? math.min(x, ex) : math.min(y, ey)
      const b = d % 2 === 1 ? math.max(x, ex) : math.max(y, ey)
      const conflicts = spanConflicts(state, line, a, b)
      let extra = 0
      if (conflicts.length > 0) {
        if (!s.rip) continue
        let fixed = false
        for (const r of conflicts) if (state.routes[r]?.fixed) fixed = true
        if (fixed) continue
        extra = w.rip
      }
      push(cur, ex + DX[d], ey + DY[d], d, g + w.underground + c + ce + extra, k)
    }
  }
  return used
}

export interface RouteResult {
  route?: Route
  /** Routes this one passes through (rip mode). */
  victims: string[]
  /** A tile used twice (the search does not remember its own path): retry avoiding it. */
  selfCross?: number
}

/** Turns a found search into a Route (not committed). */
export function searchResult(s: Search, state: LayoutState, policy: LayoutPolicy): RouteResult {
  const req = s.req
  const victims: Record<string, boolean> = {}
  if (s.found === undefined) return { victims: [] }
  const decode = (st: number): { x: number; y: number; d: number } => {
    const t = math.floor(st / 4)
    return { x: s.x0 + (t % s.w), y: s.y0 + math.floor(t / s.w), d: st % 4 }
  }
  const rev: RouteStep[] = []
  let st = s.found
  let tap: TapStart | undefined
  for (;;) {
    const mv = s.mv[st]
    if (mv === -1) break
    if (mv === -2) {
      tap = s.taps[st]
      break
    }
    const p = s.par[st]
    const a = decode(p)
    const b = decode(st)
    if (mv === 0) rev.push({ kind: "belt", x: a.x, y: a.y, dir: b.d })
    else {
      rev.push({ kind: "ug-out", x: a.x + DX[a.d] * mv, y: a.y + DY[a.d] * mv, dir: a.d })
      rev.push({ kind: "ug-in", x: a.x, y: a.y, dir: a.d })
    }
    st = p
  }
  const steps: RouteStep[] = []
  if (tap) steps.push({ kind: "splitter", x: tap.x, y: tap.y, x2: tap.x2, y2: tap.y2, dir: tap.dir })
  for (let i = rev.length - 1; i >= 0; i--) steps.push(rev[i])
  const tiles: number[] = []
  const seen: Record<number, boolean> = {}
  let selfCross: number | undefined
  const use = (x: number, y: number): void => {
    const k = tkey(x, y)
    if (seen[k]) selfCross = k
    seen[k] = true
    tiles.push(k)
    const v = state.routeOcc[k]
    if (v !== undefined) victims[v] = true
  }
  const spans: Route["spans"] = []
  let length = 0
  let ugs = 0
  for (let i = 0; i < steps.length; i++) {
    const p = steps[i]
    if (p.kind === "splitter") {
      use(p.x2!, p.y2!)
      continue
    }
    use(p.x, p.y)
    length++
    if (p.kind === "ug-in") {
      ugs++
      const out = steps[i + 1]
      const line = lineKey(p.x, p.y, p.dir)
      const a = p.dir % 2 === 1 ? math.min(p.x, out.x) : math.min(p.y, out.y)
      const b = p.dir % 2 === 1 ? math.max(p.x, out.x) : math.max(p.y, out.y)
      for (const v of spanConflicts(state, line, a, b)) victims[v] = true
      for (const o of spans) if (o.line === line && o.span.a <= b && a <= o.span.b) selfCross = tkey(p.x, p.y)
      spans.push({ line, span: { a, b, route: req.id } })
    }
  }
  let blocker: RouteStep | undefined
  if (req.goal.side !== undefined) {
    const b = blockerTile(req.goal)
    blocker = { kind: "belt", x: b.x, y: b.y, dir: req.goal.dir }
    use(b.x, b.y)
  }
  if (selfCross !== undefined) return { victims: [], selfCross }
  const out: string[] = []
  for (const [v] of pairs(victims)) if (v !== req.id) out.push(v)
  out.sort()
  return {
    victims: out,
    route: {
      id: req.id,
      conn: req.conn,
      item: req.item,
      from: req.from,
      to: req.to,
      steps,
      startDir: req.start?.dir,
      tiles,
      spans,
      tapOf: tap?.route,
      belt: req.tier.belt,
      underground: req.tier.underground,
      splitter: req.tier.splitter,
      length,
      undergrounds: ugs,
      cost: s.g[s.found],
      blocker,
      ripped: 0,
    },
  }
}

/** Routes synchronously (tests, tools): one search, no rip-up. */
export function routeNow(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip = false): RouteResult & { expansions: number } {
  const s = newSearch(state, terrain, policy, req, rip)
  while (s.status === "running") stepSearch(s, state, terrain, policy, 100000)
  if (s.status !== "found") return { victims: [], expansions: s.expansions }
  return { ...searchResult(s, state, policy), expansions: s.expansions }
}
