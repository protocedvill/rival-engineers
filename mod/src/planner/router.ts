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

import { connectionId, routeId } from "../shared/ids"
import type { RouteId } from "../shared/ids"
import { BeltTier } from "./capacity"
import { routeClaimConflict } from "./claims"
import { ccw, cw, DX, DY, FREE, keyX, keyY, OWN, ROCK, TerrainView, tkey, TREE, UNKNOWN } from "./grid"
import { isPoleTag, LayoutState, lineKey, PlacedModule, PortRef, Route, RouteStep, spanConflicts } from "./layout"
import type { ModuleDef } from "../modules/types"
import { LayoutPolicy } from "./policy"
import { tunnelSite } from "./tunnel"

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
  /** B60: the goal is a belt on another route: side-load into it, without placing a blocker belt behind it. */
  merge?: boolean
  /** B60: other merge points to try when this one is not reachable (nearest the new producer first). A goal with
   * `x2`/`y2` is a splitter merge, the others are side-loads. */
  mergeGoals?: { x: number; y: number; dir: number; side?: "left" | "right"; x2?: number; y2?: number }[]
  /**
   * Provider-group merge through a splitter: appended as the route's last step. `x`,`y` is the trunk tile it replaces
   * (owned by the other route) and `x2`,`y2` the tile this route occupies beside it.
   */
  mergeSplitter?: { x: number; y: number; dir: number; x2: number; y2: number }
  /** Routes of the same producer port this one may tap with a splitter (splitter-tap topology). */
  taps?: string[]
  tier: BeltTier
  /** Reserved tags this route may use (its own ports' outside tiles). */
  own: Record<string, boolean>
  /** Tiles to avoid (blocked), e.g. after a self-intersecting attempt. */
  avoid?: Record<number, boolean>
  /** B28: this edge's search window scale (×the policy margin); a retry after "no path" widens the detour room. */
  windowMargin?: number
  /**
   * Tunnel crossings (`tunnel.ts`): this route may cross another route's straight run, which becomes an underground pair
   * around the crossing, at `cost` extra. `busy`: routes that may not be rebuilt. Only callers that apply the
   * conversion when they commit the route (`plan.ts`) set it.
   */
  tunnel?: { cost: number; busy?: Record<string, boolean> }
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
  /** Move into the state: 0 belt, k ≥ 2 underground of length k, -1 start, -2 splitter tap start, -3 tunnel cross. */
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
  /** Splitter tap starts (computed once; the tile search seeds them). */
  tapStarts: { tap: TapStart; cost: number }[]
  /** Two-level routing: the cell search still running, then the corridor of cells (`cellOf`) the tile search keeps to. */
  coarse?: Coarse
  corridor?: Record<number, boolean>
  /** Cell size of the coarse search and cells per window row. */
  cell: number
  cellsW: number
  /** The corridor search found no path and the whole window was searched instead. */
  widened?: boolean
  /** Tile costs by window tile, cached for the search's life (the layout does not change while it runs). */
  tc: Record<number, number>
  /** Heuristic weight: 1 (exact A*), `corridorWeight` while inside a corridor. */
  hw?: number
  /** Seal check still running (see `stepSeal`). */
  seal?: Seal
  /** The seal check proved "no path": the end that ran out, its enclosed tiles, and whether the window's edge cut it. */
  sealed?: { side: "start" | "goal"; tiles: number; edge: boolean }
  /** Tiles the seal check visited (work). */
  sealSteps?: number
}

/**
 * Seal check (user, 2026-10-20): a flood from the starts and one backwards from the goal over the search's own states
 * (tile, heading) and moves (a belt straight on or turning, an underground entered straight), passability and
 * underground-span rule, without costs. A side that runs out before the two meet proves "no path", at the cost of the
 * smaller enclosed region instead of the whole window (a boxed-in port otherwise exhausts the window, and every retry
 * exhausts it again). It expands the side with the shorter queue first; when they meet, or after `router.sealCheck`
 * states, the search runs as before. (A tile-only flood leaked: it entered an underground from the side.)
 */
interface Seal {
  fq: number[]
  fi: number
  fseen: Record<number, boolean>
  fedge: boolean
  rq: number[]
  ri: number
  rseen: Record<number, boolean>
  redge: boolean
  /** Tile passability (cost ≥ 0), cached by tile. */
  pass: Record<number, boolean>
  /** A state reached from both ends: a path exists (the search runs). */
  met: boolean
  steps: number
  cap: number
}

/** A* over `cell`×`cell` tile cells of the window (two-level routing). */
interface Coarse {
  g: Record<number, number>
  par: Record<number, number>
  closed: Record<number, boolean>
  hs: number[]
  hf: number[]
  /** Cell cost (entering it), -1 if impassable; evaluated lazily. */
  cost: Record<number, number>
  starts: number[]
  goal: number
}

// ---------------------------------------------------------------------------------------------------------
// Binary heap on parallel arrays (state, f). Ties: lower f first, then insertion order is not guaranteed but the
// whole procedure is deterministic.

function heapPush(s: { hs: number[]; hf: number[] }, state: number, f: number): void {
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

// ---------------------------------------------------------------------------------------------------------

function encode(s: Search, x: number, y: number, d: number): number {
  return ((y - s.y0) * s.w + (x - s.x0)) * 4 + d
}

function inWindow(s: Search, x: number, y: number): boolean {
  return x >= s.x0 && y >= s.y0 && x < s.x0 + s.w && y < s.y0 + s.h && (s.corridor === undefined || s.corridor[cellOf(s, x, y)] === true)
}

function cellOf(s: Search, x: number, y: number): number {
  return math.floor((y - s.y0) / s.cell) * s.cellsW + math.floor((x - s.x0) / s.cell)
}

/**
 * Cost of a belt (or underground end) on a tile, or -1 if it can't go there. In rip mode, other routes' tiles cost
 * `rip` extra instead of blocking.
 */
export function tileCost(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip: boolean, x: number, y: number): number {
  const k = tkey(x, y)
  // B37: a pole line's tile costs `obstacles.poleEvict` (commitRoute evicts the line; the plan's pole step re-poles).
  const o = state.occ[k]
  const pole = isPoleTag(o)
  if (routeClaimConflict(state, k, req.own, req.from?.module, req.to.module, rip) !== undefined) return -1
  // B33: a tile the route used twice is blocked on the retry. As an extra cost (`rip`) the retry found the same
  // self-crossing path whenever every detour cost more (seed 222's copper feed with undergrounds, three retries).
  if (req.avoid?.[k]) return -1
  const r = state.reserved[k]
  const w = policy.router
  let extra = pole ? policy.obstacles.poleEvict ?? 0 : 0
  const occupant = state.routeOcc[k]
  // B58: a splitter tap may not rip up a route it could tap. Its trunk is the branch's only feed; if the search
  // crosses it here, it is ripped, the tap is committed alone and the re-routed trunk can cover the splitter.
  if (occupant !== undefined && rip && req.taps !== undefined && req.taps.indexOf(occupant) >= 0) return -1
  if (occupant !== undefined) extra += w.rip // The claim query admitted only a rippable route.
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
  // B9: another module's room to grow (a route there would block its expansion). A module's own routes don't pay: its
  // ports sit at the growing end and move with it, so its routes are rerouted when it grows anyway.
  const soft = w.softClaim ?? 0
  if (soft > 0) {
    const owner = state.soft?.[k]
    // B52: most next to the module, less for each unit farther out: a route that must cross a growth strip crosses
    // its far end, keeping the module's next units free.
    if (owner !== undefined && owner !== req.to.module && owner !== req.from?.module) extra += soft * (w.softClaimDecay ?? 1) ** (state.softUnit?.[k] ?? 0)
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

/** Modules by id, per layout (rebuilt when an id is missing). Lookup speed only: never changes a result. */
const moduleIndex = new WeakMap<LayoutState, Record<string, PlacedModule>>()
/** Whether a module definition holds undergrounds of a kind (belt or pipe) of its own, cached by definition. */
const defUnderground = new WeakMap<ModuleDef, Record<string, boolean>>()

function moduleById(state: LayoutState, id: string): PlacedModule | undefined {
  let index = moduleIndex.get(state)
  if (index?.[id] === undefined) {
    index = {}
    for (const m of state.modules) index[m.id] = m
    moduleIndex.set(state, index)
  }
  return index[id]
}

/** The entity name part that marks an underground of each kind (vanilla names: `*underground-belt`, `pipe-to-ground`). */
const UNDER_NAME: Record<UnderKind, string> = { belt: "underground-belt", pipe: "pipe-to-ground" }
export type UnderKind = "belt" | "pipe"

/**
 * B121 (seed 11 g78, in game): whether a module's footprint holds undergrounds of `kind`. An underground passing under
 * a module with none of its own can't pair with anything inside, so it may pass like a player's would. A smelter
 * column's dry coal tree had sealed its fuel ports inside the base: with every module a wall to undergrounds, no new
 * coal could get in. Modules with their own (curated belts; chemistry rows' and the oil complex's pipe-to-ground) stay
 * walls: their ends could pair with ours.
 */
export function moduleHasUndergrounds(def: ModuleDef, kind: UnderKind): boolean {
  let byKind = defUnderground.get(def)
  if (byKind === undefined) {
    byKind = {}
    defUnderground.set(def, byKind)
  }
  let v = byKind[kind]
  if (v === undefined) {
    v = false
    const part = UNDER_NAME[kind]
    for (const e of def.entities) if (string.find(e.name, part, 1, true)[0] !== undefined) v = true
    // In-place growth adds copies of the unit's entities inside the footprint.
    for (const e of def.expand?.unit.entities ?? []) if (string.find(e.name, part, 1, true)[0] !== undefined) v = true
    byKind[kind] = v
  }
  return v
}

/** Whether an underground of `kind` may pass under a tile: not under unknown land, nor a module with its own (B121). */
export function underPassable(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, x: number, y: number, kind: UnderKind = "belt"): boolean {
  const o = state.occ[tkey(x, y)]
  if (o !== undefined && !policy.router.underModules && string.sub(o, 1, 2) === "m:") {
    const m = moduleById(state, string.sub(o, 3))
    if (m === undefined || moduleHasUndergrounds(m.def, kind)) return false
  }
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

export function newSearch(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, rip: boolean, retry = false): Search {
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
  const C = math.max(1, w.coarseCell ?? 8)
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
    tapStarts: [],
    cell: C,
    cellsW: math.ceil((x2 - x1 + 2 * m + 1) / C),
    tc: {},
  }
  s.goalS = encode(s, req.goal.x, req.goal.y, sideHeading(req.goal.dir, req.goal.side))
  for (const id of req.taps ?? []) for (const c of tapCandidates(state, terrain, policy, req, rip, id)) s.tapStarts.push(c)
  // A retry after "no path" runs the seal check to the end (`sealRetry`, 0: no cap): proving the pocket closed there
  // skips the wider windows, while a first search only pays the small cap.
  const sealCap = (w.sealCheck ?? 0) <= 0 ? 0 : retry ? (w.sealRetry ?? 0) > 0 ? w.sealRetry! : math.huge : w.sealCheck!
  if (sealCap > 0) s.seal = newSeal(s, state, terrain, policy, sealCap)
  // Two-level routing: a long connection searches cells first (`stepCoarse`), then tiles inside their corridor.
  const starts: { x: number; y: number }[] = []
  if (req.start) starts.push(req.start)
  for (const c of s.tapStarts) starts.push({ x: c.tap.x2, y: c.tap.y2 })
  let near = math.huge
  for (const p of starts) near = math.min(near, math.abs(p.x - req.goal.x) + math.abs(p.y - req.goal.y))
  const long = w.longRoute ?? 0
  if (long > 0 && C > 1 && starts.length > 0 && near >= long) {
    const co: Coarse = { g: {}, par: {}, closed: {}, hs: [], hf: [], cost: {}, starts: [], goal: cellOf(s, req.goal.x, req.goal.y) }
    for (const p of starts) {
      const c = cellOf(s, p.x, p.y)
      if (co.g[c] !== undefined) continue
      co.starts.push(c)
      co.g[c] = 0
      heapPush(co, c, coarseH(s, co, c))
    }
    s.coarse = co
    return s
  }
  seedFine(s)
  return s
}

/** Whether an underground from (x, y) heading d to the exit (ex, ey) may run there (the search's span rule). */
function sealSpanOk(s: Search, state: LayoutState, x: number, y: number, ex: number, ey: number, d: number): boolean {
  const a = d % 2 === 1 ? math.min(x, ex) : math.min(y, ey)
  const b = d % 2 === 1 ? math.max(x, ex) : math.max(y, ey)
  const conflicts = spanConflicts(state, lineKey(x, y, d), a, b)
  if (conflicts.length === 0) return true
  if (!s.rip) return false
  for (const id of conflicts) if (state.routes[id]?.fixed) return false
  return true
}


/** Tile index in the window (corridor ignored), or -1 outside. */
function sealTile(s: Search, x: number, y: number): number {
  if (x < s.x0 || y < s.y0 || x >= s.x0 + s.w || y >= s.y0 + s.h) return -1
  return (y - s.y0) * s.w + (x - s.x0)
}

function newSeal(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, cap: number): Seal | undefined {
  const req = s.req
  const seal: Seal = { fq: [], fi: 0, fseen: {}, fedge: false, rq: [], ri: 0, rseen: {}, redge: false, pass: {}, met: false, steps: 0, cap }
  if (sealTile(s, req.goal.x, req.goal.y) < 0) return undefined
  sealAdd(seal, false, s.goalS)
  const addStart = (x: number, y: number, d: number): void => {
    if (sealTile(s, x, y) >= 0) sealAdd(seal, true, encode(s, x, y, d))
  }
  if (req.start) addStart(req.start.x, req.start.y, req.start.dir)
  for (const c of s.tapStarts) addStart(c.tap.x2 + DX[c.tap.dir], c.tap.y2 + DY[c.tap.dir], c.tap.dir)
  // No start: the search says "no start" itself.
  if (seal.fq.length === 0) return undefined
  return seal
}

/** Adds a state to one side's flood; reaching a state the other side holds proves a path. */
function sealAdd(seal: Seal, forward: boolean, st: number): void {
  const seen = forward ? seal.fseen : seal.rseen
  if (seen[st]) return
  seen[st] = true
  ;(forward ? seal.fq : seal.rq).push(st)
  if ((forward ? seal.rseen : seal.fseen)[st]) seal.met = true
}

function sealPass(s: Search, seal: Seal, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, x: number, y: number): boolean {
  const t = sealTile(s, x, y)
  const cached = seal.pass[t]
  if (cached !== undefined) return cached
  let ok = true
  if (s.req.goal.side !== undefined && s.req.merge !== true) {
    const b = blockerTile(s.req.goal)
    if (b.x === x && b.y === y) ok = false
  }
  if (ok) ok = cachedCost(s, state, terrain, policy, x, y) >= 0
  seal.pass[t] = ok
  return ok
}

/** Expands one state of the flood from the starts: `stepSearch`'s moves. */
function sealForward(s: Search, seal: Seal, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, st: number): number {
  const d = st % 4
  const t = math.floor(st / 4)
  const x = s.x0 + (t % s.w)
  const y = s.y0 + math.floor(t / s.w)
  if (x === s.req.goal.x && y === s.req.goal.y) return 0
  if (!sealPass(s, seal, state, terrain, policy, x, y)) return 0
  for (const nd of [d, cw(d), ccw(d)]) {
    if (sealTile(s, x + DX[nd], y + DY[nd]) < 0) seal.fedge = true
    else sealAdd(seal, true, encode(s, x + DX[nd], y + DY[nd], nd))
  }
  let work = ROUTER_MOVE_WORK * 3
  // Tunnel crossings (`stepSearch`'s cross move): over the crossed tile to the one past it.
  const tun = s.req.tunnel
  if (tun !== undefined) {
    for (const nd of [d, cw(d), ccw(d)]) {
      const tx = x + DX[nd]
      const ty = y + DY[nd]
      if (state.routeOcc[tkey(tx, ty)] === undefined || sealTile(s, tx, ty) < 0) continue
      work += ROUTER_MOVE_WORK
      if (s.req.avoid?.[tkey(tx, ty)] || tunnelSite(state, tx, ty, nd, s.req.id, tun.busy) === undefined) continue
      if (sealTile(s, tx + DX[nd], ty + DY[nd]) < 0) seal.fedge = true
      else sealAdd(seal, true, encode(s, tx + DX[nd], ty + DY[nd], nd))
    }
  }
  for (let k = 2; k <= s.req.tier.maxUnderground; k++) {
    work += ROUTER_MOVE_WORK
    if (!underPassable(state, terrain, policy, x + DX[d] * (k - 1), y + DY[d] * (k - 1))) break
    const ex = x + DX[d] * k
    const ey = y + DY[d] * k
    if (sealTile(s, ex, ey) < 0) {
      seal.fedge = true
      break
    }
    if (!sealPass(s, seal, state, terrain, policy, ex, ey) || !sealSpanOk(s, state, x, y, ex, ey, d)) continue
    if (sealTile(s, ex + DX[d], ey + DY[d]) < 0) seal.fedge = true
    else sealAdd(seal, true, encode(s, ex + DX[d], ey + DY[d], d))
  }
  return work
}

/** Expands one state of the flood from the goal: the states `stepSearch` reaches it from. */
function sealBackward(s: Search, seal: Seal, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, st: number): number {
  const d = st % 4
  const t = math.floor(st / 4)
  // A belt at P pointing d, arrived at heading d or turning into d.
  const px = s.x0 + (t % s.w) - DX[d]
  const py = s.y0 + math.floor(t / s.w) - DY[d]
  if (sealTile(s, px, py) < 0) {
    seal.redge = true
    return 0
  }
  let work = ROUTER_MOVE_WORK * 3
  // A tunnel cross arriving here: its crossed tile is P (another route's run), entered from P0 = P − d.
  const tun = s.req.tunnel
  if (tun !== undefined && state.routeOcc[tkey(px, py)] !== undefined) {
    work += ROUTER_MOVE_WORK
    const qx = px - DX[d]
    const qy = py - DY[d]
    if (sealTile(s, qx, qy) < 0) seal.redge = true
    else if (!s.req.avoid?.[tkey(px, py)] && sealPass(s, seal, state, terrain, policy, qx, qy) && tunnelSite(state, px, py, d, s.req.id, tun.busy) !== undefined) {
      for (const h of [d, cw(d), ccw(d)]) sealAdd(seal, false, encode(s, qx, qy, h))
    }
  }
  if (!sealPass(s, seal, state, terrain, policy, px, py)) return work
  for (const h of [d, cw(d), ccw(d)]) sealAdd(seal, false, encode(s, px, py, h))
  // An underground ending at E = P, entered straight (heading d) at E − k·d.
  for (let k = 2; k <= s.req.tier.maxUnderground; k++) {
    work += ROUTER_MOVE_WORK
    if (!underPassable(state, terrain, policy, px - DX[d] * (k - 1), py - DY[d] * (k - 1))) break
    const ix = px - DX[d] * k
    const iy = py - DY[d] * k
    if (sealTile(s, ix, iy) < 0) {
      seal.redge = true
      break
    }
    if (!sealPass(s, seal, state, terrain, policy, ix, iy) || !sealSpanOk(s, state, ix, iy, px, py, d)) continue
    sealAdd(seal, false, encode(s, ix, iy, d))
  }
  return work
}

/** Runs the seal check for up to `budget` states; returns the work used. */
function stepSeal(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const seal = s.seal!
  let used = 0
  const done = (): void => {
    s.seal = undefined
    s.sealSteps = seal.steps
  }
  while (used < budget) {
    if (seal.met) {
      done()
      return used
    }
    const fLeft = seal.fq.length - seal.fi
    const rLeft = seal.rq.length - seal.ri
    if (fLeft === 0 || rLeft === 0) {
      const forward = fLeft === 0
      const tiles: Record<number, boolean> = {}
      let n = 0
      for (const [st] of pairs(forward ? seal.fseen : seal.rseen)) {
        const t = math.floor(st / 4)
        if (!tiles[t]) n++
        tiles[t] = true
      }
      s.sealed = { side: forward ? "start" : "goal", tiles: n, edge: forward ? seal.fedge : seal.redge }
      s.status = "failed"
      s.reason = "no path"
      done()
      return used
    }
    if (seal.steps >= seal.cap) {
      done()
      return used
    }
    used++
    seal.steps++
    if (fLeft <= rLeft) used += sealForward(s, seal, state, terrain, policy, seal.fq[seal.fi++])
    else used += sealBackward(s, seal, state, terrain, policy, seal.rq[seal.ri++])
  }
  return used
}

/** `tileCost` of a window tile, cached for the search. */
function cachedCost(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, x: number, y: number): number {
  const t = sealTile(s, x, y)
  if (t < 0) return tileCost(state, terrain, policy, s.req, s.rip, x, y)
  const c = s.tc[t]
  if (c !== undefined) return c
  const v = tileCost(state, terrain, policy, s.req, s.rip, x, y)
  s.tc[t] = v
  return v
}

function seedFine(s: Search): void {
  const req = s.req
  const push = (x: number, y: number, d: number, g: number, mv: number): number | undefined => {
    if (!inWindow(s, x, y)) return undefined
    const st = encode(s, x, y, d)
    if (s.g[st] !== undefined && s.g[st] <= g) return undefined
    s.g[st] = g
    s.mv[st] = mv
    heapPush(s, st, g + (s.hw ?? 1) * s.hMin * (math.abs(x - req.goal.x) + math.abs(y - req.goal.y)))
    return st
  }
  if (req.start) push(req.start.x, req.start.y, req.start.dir, 0, -1)
  for (const c of s.tapStarts) {
    const t = c.tap
    const st = push(t.x2 + DX[t.dir], t.y2 + DY[t.dir], t.dir, c.cost, -2)
    if (st !== undefined) s.taps[st] = t
  }
  if (s.hs.length === 0) {
    s.status = "failed"
    s.reason = "no start"
  }
}

function coarseH(s: Search, co: Coarse, c: number): number {
  const dx = math.abs((c % s.cellsW) - (co.goal % s.cellsW))
  const dy = math.abs(math.floor(c / s.cellsW) - math.floor(co.goal / s.cellsW))
  return s.hMin * s.cell * (dx + dy)
}

/**
 * The cost of entering a cell: its passable tiles' mean tile cost over a cell's width, more when few of its tiles are
 * passable; -1 when none is (the start and goal cells always pass).
 */
function cellCost(s: Search, co: Coarse, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, c: number): number {
  const cached = co.cost[c]
  if (cached !== undefined) return cached
  const cx = s.x0 + (c % s.cellsW) * s.cell
  const cy = s.y0 + math.floor(c / s.cellsW) * s.cell
  let n = 0
  let all = 0
  let sum = 0
  for (let y = cy; y < math.min(cy + s.cell, s.y0 + s.h); y++) {
    for (let x = cx; x < math.min(cx + s.cell, s.x0 + s.w); x++) {
      all++
      const t = tileCost(state, terrain, policy, s.req, s.rip, x, y)
      if (t < 0) continue
      n++
      sum += t
    }
  }
  let cost: number
  if (n === 0) cost = c === co.goal || co.starts.indexOf(c) >= 0 ? s.cell * 4 : -1
  // Only mostly blocked cells pay extra: a cell crossed by a belt stays as cheap as its tiles (routes bundle, B7).
  else cost = s.cell * (sum / n) * (1 + 3 * math.max(0, 0.5 - n / all) * 2)
  co.cost[c] = cost
  return cost
}

/** Runs the cell search; on reaching the goal cell, the corridor is set and the tile search seeded. Returns the work. */
function stepCoarse(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const co = s.coarse!
  const cellsH = math.ceil(s.h / s.cell)
  const cellWork = (s.cell * s.cell) / 8
  let used = 0
  while (used < budget) {
    if (co.hs.length === 0) {
      // No cell path: search the whole window tile by tile.
      s.coarse = undefined
      seedFine(s)
      return used
    }
    const cur = heapPop(co)
    if (co.closed[cur]) continue
    co.closed[cur] = true
    used++
    if (cur === co.goal) {
      const r = policy.router.corridorCells ?? 1
      const corridor: Record<number, boolean> = {}
      const mark = (c: number, rad: number): void => {
        const ccx = c % s.cellsW
        const ccy = math.floor(c / s.cellsW)
        for (let dx = -rad; dx <= rad; dx++) {
          for (let dy = -rad; dy <= rad; dy++) {
            const nx = ccx + dx
            const ny = ccy + dy
            if (nx >= 0 && ny >= 0 && nx < s.cellsW && ny < cellsH) corridor[ny * s.cellsW + nx] = true
          }
        }
      }
      for (let c: number | undefined = cur; c !== undefined; c = co.par[c]) mark(c, r)
      mark(co.goal, r + 1)
      for (const c of co.starts) mark(c, r + 1)
      s.corridor = corridor
      s.hw = math.max(1, policy.router.corridorWeight ?? 1)
      s.coarse = undefined
      seedFine(s)
      return used
    }
    const ccx = cur % s.cellsW
    const ccy = math.floor(cur / s.cellsW)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ccx + dx
      const ny = ccy + dy
      if (nx < 0 || ny < 0 || nx >= s.cellsW || ny >= cellsH) continue
      const nc = ny * s.cellsW + nx
      if (co.closed[nc]) continue
      if (co.cost[nc] === undefined) used += cellWork
      const c = cellCost(s, co, state, terrain, policy, nc)
      if (c < 0) continue
      const g = co.g[cur] + c
      if (co.g[nc] !== undefined && co.g[nc] <= g) continue
      co.g[nc] = g
      co.par[nc] = cur
      heapPush(co, nc, g + coarseH(s, co, nc))
    }
  }
  return used
}

/** M7: planner work per move an expansion (or seal step) tries, on top of one unit per expansion (see `stepSearch`). */
const ROUTER_MOVE_WORK = 0.5
/** Move code of a tunnel cross: a belt on the state's tile and on the crossed tile, arriving one tile past it. */
const MV_CROSS = -3

/** Runs up to `budget` expansions. Returns the number used. */
/** M7c.8: how many of a state's ancestors a move checks for its tiles (`markHeld`); `searchResult` checks whole routes. */
const BELT_CROSS_DEPTH = 24

/**
 * M7c.8: the tile indices (`encode` / 4) that hold a piece of the route to state `st` within its last
 * `BELT_CROSS_DEPTH` states (each state's own tile, and the underground exit one behind a state an underground made):
 * a move onto one of them would cross the route. The search state is (tile, heading), so a cheap route that loops back
 * over its own tile can own a state, and every route through that state then crosses itself (the pipe router's seed 11
 * g107 flood; the same plan's advanced-circuit belt failed "route crosses itself" three times over).
 * M7 (seed 11 g51): marked once per expansion and looked up per move (`heldMark[t] === stamp`). Walking the ancestors
 * for each of an expansion's ~10 moves was 55% of a slow plan's time. The marks are scratch (not in `storage`): a stamp
 * is only compared within one expansion.
 */
const heldMark: Record<number, number> = {}
let heldStamp = 0

function markHeld(s: Search, st: number): number {
  heldStamp++
  let cur = st
  for (let depth = 0; depth < BELT_CROSS_DEPTH; depth++) {
    const ct = math.floor(cur / 4)
    heldMark[ct] = heldStamp
    const mv = s.mv[cur]
    if (mv === undefined || (mv < 0 && mv !== MV_CROSS)) break
    // An underground's exit, or a tunnel cross's crossed tile, is one behind the state.
    if (mv > 0 || mv === MV_CROSS) {
      const d = cur % 4
      heldMark[ct - DX[d] - DY[d] * s.w] = heldStamp
    }
    cur = s.par[cur]
  }
  return heldStamp
}

export function stepSearch(s: Search, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const req = s.req
  const w = policy.router
  const maxK = req.tier.maxUnderground
  const gx = req.goal.x
  const gy = req.goal.y
  let used = 0
  if (s.seal !== undefined) {
    used += stepSeal(s, state, terrain, policy, budget)
    if (s.seal !== undefined || s.status !== "running") return used
  }
  if (s.coarse !== undefined) {
    used += stepCoarse(s, state, terrain, policy, budget - used)
    if (s.coarse !== undefined) return used
  }
  // The blocker tile behind a side-loaded port stays free. A merge side-loads into an existing belt: its own target
  // tile must keep that belt, so there is no blocker.
  const blocked: Record<number, boolean> = {}
  if (req.goal.side !== undefined && req.merge !== true) {
    const b = blockerTile(req.goal)
    blocked[tkey(b.x, b.y)] = true
  }
  const cost = (x: number, y: number): number => {
    if (blocked[tkey(x, y)]) return -1
    return cachedCost(s, state, terrain, policy, x, y)
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
    heapPush(s, st, g + (s.hw ?? 1) * s.hMin * (math.abs(x - gx) + math.abs(y - gy)))
  }
  while (s.status === "running" && used < budget) {
    if (s.hs.length === 0) {
      if (s.corridor !== undefined) {
        // Two-level routing: no path inside the corridor; search the whole window instead.
        s.corridor = undefined
        s.hw = 1
        s.widened = true
        s.g = {}
        s.par = {}
        s.mv = {}
        s.closed = {}
        s.taps = {}
        seedFine(s)
        continue
      }
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
    const held = markHeld(s, cur)
    // M7 (seed 11 g51, g78): an expansion's work counts the moves it tries (three turns, then one per underground
    // length), half a unit each. Counted as one unit, an expansion cost ~15-30 µs in T1 (more with longer undergrounds)
    // against the planner budget's ~4 µs a unit, and slow plans took 21-27 ms a tick of a 2 ms budget.
    used += ROUTER_MOVE_WORK * 3
    for (const nd of [d, cw(d), ccw(d)]) {
      const nx = x + DX[nd]
      const ny = y + DY[nd]
      if (inWindow(s, nx, ny) && heldMark[math.floor(encode(s, nx, ny, 0) / 4)] === held) continue
      push(cur, nx, ny, nd, g + c + (nd === d ? 0 : w.turn), 0)
    }
    // Tunnel crossings: over another route's straight run, which becomes an underground pair around the crossed tile.
    const tun = req.tunnel
    if (tun !== undefined) {
      for (const nd of [d, cw(d), ccw(d)]) {
        const tx = x + DX[nd]
        const ty = y + DY[nd]
        if (state.routeOcc[tkey(tx, ty)] === undefined || !inWindow(s, tx, ty) || !inWindow(s, tx + DX[nd], ty + DY[nd])) continue
        used += ROUTER_MOVE_WORK
        if (heldMark[math.floor(encode(s, tx, ty, 0) / 4)] === held || heldMark[math.floor(encode(s, tx + DX[nd], ty + DY[nd], 0) / 4)] === held) continue
        if (req.avoid?.[tkey(tx, ty)] || tunnelSite(state, tx, ty, nd, req.id, tun.busy) === undefined) continue
        push(cur, tx + DX[nd], ty + DY[nd], nd, g + c + (nd === d ? 0 : w.turn) + 1 + tun.cost, MV_CROSS)
      }
    }
    // Undergrounds: entered straight, exit k tiles ahead.
    const line = lineKey(x, y, d)
    for (let k = 2; k <= maxK; k++) {
      used += ROUTER_MOVE_WORK
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
        for (const r of conflicts) {
          if (state.routes[r]?.fixed) fixed = true
          // B58: never run a branch's span through the trunk it taps for the same reason as `tileCost`.
          if (req.taps !== undefined && req.taps.indexOf(r) >= 0) fixed = true
        }
        if (fixed) continue
        extra = w.rip
      }
      if (heldMark[math.floor(encode(s, ex, ey, 0) / 4)] === held) continue
      if (inWindow(s, ex + DX[d], ey + DY[d]) && heldMark[math.floor(encode(s, ex + DX[d], ey + DY[d], 0) / 4)] === held) continue
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
  /** Tunnel crossings the route makes (crossed tile, crossing heading): commit converts each crossed run first. */
  tunnels?: { x: number; y: number; dir: number }[]
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
  const tunnels: { x: number; y: number; dir: number }[] = []
  const tunnelTiles: Record<number, boolean> = {}
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
    else if (mv === MV_CROSS) {
      const tx = a.x + DX[b.d]
      const ty = a.y + DY[b.d]
      rev.push({ kind: "belt", x: tx, y: ty, dir: b.d })
      rev.push({ kind: "belt", x: a.x, y: a.y, dir: b.d })
      tunnels.push({ x: tx, y: ty, dir: b.d })
      tunnelTiles[tkey(tx, ty)] = true
    } else {
      rev.push({ kind: "ug-out", x: a.x + DX[a.d] * mv, y: a.y + DY[a.d] * mv, dir: a.d })
      rev.push({ kind: "ug-in", x: a.x, y: a.y, dir: a.d })
    }
    st = p
  }
  const steps: RouteStep[] = []
  if (tap) steps.push({ kind: "splitter", x: tap.x, y: tap.y, x2: tap.x2, y2: tap.y2, dir: tap.dir })
  for (let i = rev.length - 1; i >= 0; i--) steps.push(rev[i])
  // Provider-group splitter merge: the branch ends beside the trunk, and the splitter replaces both tiles.
  const ms = req.mergeSplitter
  if (ms !== undefined) steps.push({ kind: "splitter", x: ms.x, y: ms.y, x2: ms.x2, y2: ms.y2, dir: ms.dir })
  const tiles: number[] = []
  const seen: Record<number, boolean> = {}
  let selfCross: number | undefined
  const use = (x: number, y: number): void => {
    const k = tkey(x, y)
    if (seen[k]) selfCross = k
    seen[k] = true
    tiles.push(k)
    const v = state.routeOcc[k]
    // A tunnel's crossed tile is freed by converting its route, not by ripping it.
    if (v !== undefined && !tunnelTiles[k]) victims[v] = true
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
  if (req.goal.side !== undefined && req.merge !== true) {
    const b = blockerTile(req.goal)
    blocker = { kind: "belt", x: b.x, y: b.y, dir: req.goal.dir }
    use(b.x, b.y)
  }
  if (selfCross !== undefined) return { victims: [], selfCross }
  const out: RouteId[] = []
  for (const [v] of pairs(victims)) if ((v as string) !== req.id) out.push(routeId(v as string))
  out.sort()
  return {
    victims: out,
    tunnels: tunnels.length > 0 ? tunnels : undefined,
    route: {
      id: routeId(req.id),
      conn: connectionId(req.conn),
      item: req.item,
      from: req.from,
      to: req.to,
      steps,
      startDir: req.start?.dir,
      tiles,
      spans,
      tapOf: tap?.route !== undefined ? routeId(tap.route) : undefined,
      belt: req.tier.belt,
      underground: req.tier.underground,
      splitter: req.tier.splitter,
      length,
      undergrounds: ugs,
      cost: s.g[s.found],
      blocker,
      merge: req.merge === true && req.goal.side !== undefined ? { x: req.goal.x, y: req.goal.y, dir: req.goal.dir, side: req.goal.side } : undefined,
      mergeSplitter: ms,
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
