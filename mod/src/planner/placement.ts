// Module placement on real terrain (SPEC §5.3): choose an origin and a rotation/mirror for a module instance so it is
// compact (packing strategy of the LayoutPolicy), its ports face where their connections come from, it respects the
// obstacle map (water, cliffs, structures, ore we need, trees and rocks at a clearing cost) and its site (`shore`: the
// anchor's water tiles are water; `resource-patch`: the drills' mining areas cover the resource).
//
// Resumable and budgeted: `stepPlacement` builds summed-area tables over a search window row by row, then scores
// candidates (every transform × origin within the radius) in O(1) each. Radii grow (policy.searchRadii) until one
// candidate is feasible. Pure: no Factorio globals.

import { moduleId } from "../shared/ids"
import { planFailure } from "../shared/plan-failure"
import type { PlanFailure } from "../shared/plan-failure"

import { expandHeadModule, expandModule, expandMoves, expandTail } from "../modules/build"
import { ProtoFacts } from "../modules/facts"
import { entityRect, IDENTITY, transformModule, transformPoint, transformRect, Transform } from "../modules/geometry"
import { ModuleDef, ModuleEntity, Port } from "../modules/types"
import { laneClaimConflict, moduleGrowthClaimConflict, placementClaimConflict } from "./claims"
import { laneTag } from "./claim-tags"
import { CLIFF, DX, DY, FOREIGN, FREE, inflate, keyX, keyY, manhattan, OWN, Rect, rectContains, ROCK, TerrainView, tkey, TREE, UNKNOWN, Vec, WATER } from "./grid"
import { commitModule, findModule, isPoleTag, Route, growthEnd, growthStrip, LayoutState, layoutMargins, lineKey, markModule, moduleMargin, PlacedModule, portApproach, portOutside, portTag, portTile, spanConflicts, unmarkModule } from "./layout"
import { CandidateFeatures, LayoutPolicy, packingScorer, placementTerms } from "./policy"
import { CandidateTrace, describeTile, newPlacementAcc, noteFeasible, noteReject, PlacementAcc, planTrace, RejectTrace } from "./trace"
import { beltDrillCap, claimPart, connectedPatch, materializeMinePlan, planWholePatch } from "./mine-plan"

export interface PlacementRequest {
  /** Instance id. */
  id: string
  /** The module in its canonical orientation. */
  def: ModuleDef
  /** Where each belt port's connection comes from (world tile), by port id. */
  targets: Record<string, Vec>
  /** Cluster centre: existing production. */
  center: Vec
  /** Planning region: the search never leaves it. */
  region: Rect
  /** Rectangles the footprint must not overlap (a module re-placed after its routes failed avoids its old spot). */
  avoid?: Rect[]
  /**
   * D50 / B9: modules whose soft claims don't count for this one: its direct partners (it feeds them or they feed it).
   * Their ports sit at their growing end, where a partner belongs; growth reroutes their connection anyway.
   */
  softExempt?: Record<string, boolean>
  /** D57: patches (`patchKey`) a mine found no room on, with the terrain stamp they were searched under. */
  dead?: Record<string, string>
}

/** D57: a connected patch of free ore a new mine may use. */
export interface SitePatch {
  key: string
  tiles: number
  x1: number
  y1: number
  x2: number
  y2: number
  /** Distance from the request centre to its nearest free ore tile, plus `newField` for a fresh field. */
  rank: number
  fresh: boolean
}

interface TDef {
  t: Transform
  def: ModuleDef
  /** Belt ports: local outside tile, outward normal, port id. */
  ports: { id: string; ox: number; oy: number; nx: number; ny: number }[]
}

export interface PlacementSearch {
  req: PlacementRequest
  phase: "site" | "sat" | "scan" | "done" | "failed"
  /** Site search: ring radius reached, and the target point found. */
  ring: number
  /** Next point of the current ring (`ringPoint` index): a ring is scanned across ticks under the budget. */
  ringIdx?: number
  target?: Vec
  /** D57 (mines): the ranked free-ore patches, the next one to try, the one being searched, and those found full. */
  patches?: SitePatch[]
  patchIdx?: number
  patch?: SitePatch & { r: number }
  deadFound?: Record<string, string>
  /** D57: patches tried (searched or skipped as remembered dead). */
  patchesTried?: number
  radiusIdx: number
  tdefs: TDef[]
  /** Window (world) and the summed-area tables over it, (w + 1) × (h + 1). */
  wx: number
  wy: number
  ww: number
  wh: number
  row: number
  sat: Record<string, number[]>
  /** B26: tiles of the window in the near band of other modules' growth areas (built with the window). */
  band?: Record<number, boolean>
  /** Candidate cursor: transform index and origin offset index (on a grid of `stride`). */
  ti: number
  ci: number
  /** 2: coarse pass, then the best few per transform are refined at ±1; 1: full scan (fallback). */
  stride: number
  top: { score: number; ox: number; oy: number }[][]
  refine: { ti: number; ox: number; oy: number }[]
  ri: number
  best?: { score: number; ti: number; ox: number; oy: number; coverage: number; clear: number }
  work: number
  /** Candidates scored (work counters, SPEC §9). */
  candidates: number
  reason?: string
  /** D69: the typed failure, when the search knows what kind it is (no patch, no position, no site). */
  failure?: PlanFailure
  /** Machine-readable certificate explaining why candidates were rejected. */
  rejections?: Record<string, { count: number; sample: Vec }>
  result?: PlacedModule
  /** Decision trace (T1 plan dumps only: set while `planTrace.sink` is on, never in game). */
  trace?: PlacementAcc
  /**
   * B45: other modules' unconnected port lane ends near the window; `ok` once known to lead out without the candidate,
   * `box` the bounds of that way out, and `sealedBy` whether a candidate footprint (`rectKey`) walls it in (M7: the
   * transforms of a module share two footprints, and the refine pass revisits origins: each is flooded once).
   */
  openPorts?: { x: number; y: number; out?: number; ok?: boolean; path?: Vec[]; box?: Rect; sealedBy?: Record<string, boolean> }[]
}

const LAYERS = ["hard", "ore", "clear", "water", "mods", "res", "soft", "band", "gblock"]

function transformsOf(def: ModuleDef): Transform[] {
  const out: Transform[] = []
  const rots = def.rotatable ? [0, 1, 2, 3] : [0]
  const mirrors = def.mirrorable ? [false, true] : [false]
  for (const mirror of mirrors) for (const rot of rots) out.push({ rot, mirror })
  return out
}

function isMining(def: ModuleDef): boolean {
  return def.site === "resource-patch"
}

/**
 * D52: ore coverage of the FIRST growth unit of a candidate mining outpost (0..1), or undefined if it can't grow or
 * the unit leaves the search window. A mine placed where its first expansion lands off-ore will deplete and be
 * unable to grow in place (seed 222: the red-line iron mine sat on the wide part of an irregular patch, and the only
 * growth direction led into a neck with no ore under the drills).
 */
function firstGrowthCoverage(s: PlacementSearch, td: TDef, ox: number, oy: number, end: "auto" | "head" | "tail" = "auto"): number | undefined {
  const cdef = s.req.def
  const spec = cdef.expand
  if (spec === undefined || spec.maxUnits < 1) return undefined
  const W = cdef.footprint.w
  const H = cdef.footprint.h
  const strip = growthStrip(cdef, 0, end)
  const r = transformRect(strip, W, H, td.t)
  const n = sum(s, "res", { x: ox + r.x, y: oy + r.y, w: r.w, h: r.h })
  if (n === undefined) return undefined
  return n / (r.w * r.h)
}

function tdefOf(def: ModuleDef, t: Transform): TDef {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  const ports: TDef["ports"] = []
  for (const p of d.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const dx = DX[math.floor(p.dir / 4)]
    const dy = DY[math.floor(p.dir / 4)]
    const sign = p.kind === "belt-in" ? -1 : 1
    ports.push({ id: p.id, ox: math.floor(p.pos.x) + sign * dx, oy: math.floor(p.pos.y) + sign * dy, nx: sign * dx, ny: sign * dy })
  }
  return { t, def: d, ports }
}

export function newPlacement(req: PlacementRequest): PlacementSearch {
  const tdefs: TDef[] = []
  for (const t of transformsOf(req.def)) tdefs.push(tdefOf(req.def, t))
  return {
    req,
    phase: req.def.site !== undefined ? "site" : "sat",
    ring: 0,
    target: req.def.site !== undefined ? undefined : req.center,
    radiusIdx: 0,
    tdefs,
    wx: 0,
    wy: 0,
    ww: 0,
    wh: 0,
    row: 0,
    sat: {},
    ti: 0,
    ci: 0,
    stride: 2,
    top: [],
    refine: [],
    ri: -1,
    work: 0,
    candidates: 0,
    trace: planTrace.sink !== undefined ? newPlacementAcc() : undefined,
  }
}

const TOP_K = 3

/** Whether a tile is a site point: water with land next to it (shore), or ore of the resource. */
export function patchKey(resource: string, p: { x1: number; y1: number; x2: number; y2: number }): string {
  return `${resource}:${p.x1},${p.y1},${p.x2},${p.y2}`
}

/** Tiles closer than this (Chebyshev) belong to one patch, as in `world/resources.ts`. */
const PATCH_JOIN = 2

/**
 * D57 (a, b): the connected patches of free ore of the mine's resource in the region: ore not under a structure, route,
 * reservation or another mine's claim (trees and rocks as the policy clears them). Patches with too little free ore
 * for the template's drill areas at `minOreCoverage` are left out. Ranked by distance to the request centre, a fresh
 * field (no mine of this resource on or next to it) `newField` tiles farther (the user, 2026-10-20). Returns the work.
 */
function buildPatches(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): number {
  const resource = s.req.def.anchor?.resource
  const region = s.req.region
  s.patches = []
  s.patchIdx = 0
  if (resource === undefined) return 1
  const treeHard = policy.obstacles.trees !== "clear"
  const rockHard = policy.obstacles.rocks !== "clear"
  const free = (x: number, y: number, k: number): boolean => {
    const b = terrain.block(x, y)
    if (b >= OWN || b === WATER || (b === TREE && treeHard) || (b === ROCK && rockHard)) return false
    return placementClaimConflict(state, k, s.req.id) === undefined
  }
  const keys: number[] = []
  if (terrain.oreTiles !== undefined) {
    for (const k of terrain.oreTiles(resource, region)) keys.push(k)
  } else {
    for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) if (terrain.ore(x, y) === resource) keys.push(tkey(x, y))
  }
  const isFree: Record<number, boolean> = {}
  for (const k of keys) if (free(keyX(k), keyY(k), k)) isFree[k] = true
  let need = 0
  for (const a of s.req.def.anchor?.miningAreas ?? []) need += math.ceil(policy.minOreCoverage * a.w * a.h)
  // Mines of this resource already in the layout: a patch on or next to one is not a fresh field.
  const mines: Rect[] = []
  for (const m of state.modules) if (m.id !== s.req.id && isMining(m.canonical) && m.canonical.anchor?.resource === resource) mines.push(inflate(m.rect, PATCH_JOIN + 1))
  const newField = policy.placement.newField ?? 0
  const seen: Record<number, boolean> = {}
  const c = s.req.center
  for (const k0 of keys) {
    if (!isFree[k0] || seen[k0]) continue
    seen[k0] = true
    const stack = [k0]
    let n = 0
    let x1 = keyX(k0)
    let y1 = keyY(k0)
    let x2 = x1
    let y2 = y1
    let near = math.huge
    while (stack.length > 0) {
      const k = stack.pop()!
      const x = keyX(k)
      const y = keyY(k)
      n++
      x1 = math.min(x1, x)
      y1 = math.min(y1, y)
      x2 = math.max(x2, x)
      y2 = math.max(y2, y)
      near = math.min(near, math.sqrt((x - c.x) * (x - c.x) + (y - c.y) * (y - c.y)))
      for (let dx = -PATCH_JOIN; dx <= PATCH_JOIN; dx++) {
        for (let dy = -PATCH_JOIN; dy <= PATCH_JOIN; dy++) {
          const j = tkey(x + dx, y + dy)
          if (isFree[j] && !seen[j]) {
            seen[j] = true
            stack.push(j)
          }
        }
      }
    }
    if (n < need) continue
    const box = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }
    let fresh = true
    for (const r of mines) if (r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h) fresh = false
    s.patches.push({ key: patchKey(resource, { x1, y1, x2, y2 }), tiles: n, x1, y1, x2, y2, rank: near + (fresh ? newField : 0), fresh })
  }
  s.patches.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.x1 !== b.x1 ? a.x1 - b.x1 : a.y1 - b.y1))
  return 1 + keys.length / 8
}

/** The window rect a patch is searched over (for its terrain stamp). */
function patchArea(p: SitePatch, margin: number): Rect {
  return { x: p.x1 - margin, y: p.y1 - margin, w: p.x2 - p.x1 + 1 + 2 * margin, h: p.y2 - p.y1 + 1 + 2 * margin }
}

/**
 * D57: starts the window search on the next ranked patch, skipping (c) those remembered as having no room under the
 * same terrain; fails once none is left. Returns the work.
 */
function nextPatch(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): number {
  let used = 0
  if (s.patches === undefined) used += buildPatches(s, state, terrain, policy)
  const list = s.patches!
  while (s.patchIdx! < list.length) {
    const p = list[s.patchIdx!]
    s.patchIdx = s.patchIdx! + 1
    s.patchesTried = (s.patchesTried ?? 0) + 1
    used++
    const dead = s.req.dead?.[p.key]
    if (dead !== undefined && terrain.stamp !== undefined && dead === terrain.stamp(patchArea(p, maxDim(s)))) continue
    // Module centres anywhere over the patch's box (and half a footprint past it).
    const r = math.ceil(math.max(p.x2 - p.x1 + 1, p.y2 - p.y1 + 1) / 2) + 1
    s.patch = { ...p, r }
    s.target = { x: math.floor((p.x1 + p.x2 + 1) / 2), y: math.floor((p.y1 + p.y2 + 1) / 2) }
    s.radiusIdx = 0
    startWindow(s, state, policy)
    return used
  }
  s.phase = "failed"
  const ore = s.req.def.anchor?.resource
  s.failure = list.length === 0 ? planFailure("no-patch", `no free ${ore ?? "ore"} patch in the region`, ore) : planFailure("no-position", `no feasible position (${s.patchesTried ?? 0} of ${list.length} patches tried)`, ore)
  s.reason = s.failure.reason
  if (s.trace !== undefined) finishTrace(s, state, terrain, policy)
  return used
}

/**
 * D57 (c): a patch with no room is remembered under its terrain stamp, unless a module this plan placed (not fixed:
 * not built) lies over it: then it is full only for this plan.
 */
function noteDeadPatch(s: PlacementSearch, state: LayoutState, terrain: TerrainView): void {
  const p = s.patch
  if (p === undefined || terrain.stamp === undefined) return
  const area = patchArea(p, maxDim(s))
  for (const m of state.modules) {
    if (m.fixed || m.id === s.req.id) continue
    if (m.rect.x < area.x + area.w && area.x < m.rect.x + m.rect.w && m.rect.y < area.y + area.h && area.y < m.rect.y + m.rect.h) return
  }
  s.deadFound ??= {}
  s.deadFound[p.key] = terrain.stamp(area)
}

function sitePoint(def: ModuleDef, terrain: TerrainView, x: number, y: number): boolean {
  if (def.site === "shore") {
    if (terrain.block(x, y) !== WATER) return false
    for (let d = 0; d < 4; d++) {
      const b = terrain.block(x + DX[d], y + DY[d])
      if (b !== WATER && b !== UNKNOWN && b !== CLIFF) return true
    }
    return false
  }
  return terrain.ore(x, y) === def.anchor?.resource
}

/**
 * M6: search radii around the target; resource-patch modules (mining outposts) get one more, up to
 * OUTPOST_FAR_RADIUS (within the plan's region): the ore near the core runs out once several clusters mine it.
 */
const OUTPOST_FAR_RADIUS = 192
function radii(s: PlacementSearch, policy: LayoutPolicy): number[] {
  // D57: a mine searches one window over the patch it is trying.
  if (s.patch !== undefined) return [s.patch.r]
  if (s.req.def.site !== "resource-patch") return policy.searchRadii
  const last = policy.searchRadii[policy.searchRadii.length - 1] ?? 0
  return last >= OUTPOST_FAR_RADIUS ? policy.searchRadii : [...policy.searchRadii, OUTPOST_FAR_RADIUS]
}

function maxDim(s: PlacementSearch): number {
  let m = 0
  for (const td of s.tdefs) m = math.max(m, td.def.footprint.w, td.def.footprint.h)
  return m
}

/** B26: an expandable non-mining module: the length of its whole growth band (0 if it can't grow or is a mine). */
function ownGrowthLength(def: ModuleDef): number {
  const spec = def.expand
  if (spec === undefined || spec.maxUnits < 1 || isMining(def)) return 0
  return spec.maxUnits * (spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h)
}

/**
 * B26 / M7: the length of the growth band `evaluate` scores (`growthBandUnits` units on the end `tryExpand` grows), 0 for
 * a mine or a module that can't grow. Was the whole band up to `maxUnits`: a blue-pack assembler row (~300 tiles of
 * growth) made a 711×224 window at the smallest radius, rebuilt for every re-placement.
 */
function scoredGrowthLength(def: ModuleDef, policy: LayoutPolicy): number {
  const spec = def.expand
  if (spec === undefined || spec.maxUnits < 1 || isMining(def)) return 0
  const units = math.min(spec.maxUnits, policy.placement.growthBandUnits ?? spec.maxUnits)
  return units * (spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h)
}

/** The window's margin around the scanned square: the largest footprint, its corridor ring and its scored growth band. */
function windowMargin(s: PlacementSearch, policy: LayoutPolicy): number {
  return maxDim(s) + policy.corridor.preferred + 4 + scoredGrowthLength(s.req.def, policy) + policy.corridor.min
}

/**
 * B26: the near band of every other expandable module (its first `growthBandUnits` growth units, on the end
 * `tryExpand` grows), inside the window. Mines are left out: their room to grow is already a hard claim (D52 (3)).
 */
function nearBandTiles(s: PlacementSearch, state: LayoutState, policy: LayoutPolicy): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  const units = policy.placement.growthBandUnits ?? 0
  if (units <= 0 || (policy.placement.growthBand ?? 0) <= 0) return out
  for (const m of state.modules) {
    const c = m.canonical
    // Partners (P28) are exempt as from the soft claim: their feed ports sit at this growing end.
    if (m.id === s.req.id || (s.req.softExempt ?? {})[m.id] || m.minePlan !== undefined || c.expand === undefined || c.expand.maxUnits < 1) continue
    const n = math.min(units, c.expand.maxUnits)
    for (let i = 0; i < n; i++) {
      const r = transformRect(growthStrip(c, i, "auto"), c.footprint.w, c.footprint.h, m.transform)
      const x1 = math.max(m.origin.x + r.x, s.wx)
      const y1 = math.max(m.origin.y + r.y, s.wy)
      const x2 = math.min(m.origin.x + r.x + r.w, s.wx + s.ww)
      const y2 = math.min(m.origin.y + r.y + r.h, s.wy + s.wh)
      for (let x = x1; x < x2; x++) for (let y = y1; y < y2; y++) out[tkey(x, y)] = true
    }
  }
  return out
}

/**
 * B45: the lane end (approach tile) of every belt port in the layout that no route uses yet, except module `except`'s,
 * inside `area`. A later route must still reach it, so a new module must not wall it in.
 */
export function openPortEnds(state: LayoutState, except: string | undefined, area?: Rect): LaneEnd[] {
  const out: LaneEnd[] = []
  for (const m of state.modules) {
    if (m.id === except) continue
    for (const p of m.def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
      const o = portOutside(m, p)
      if (state.routeOcc[tkey(o.x, o.y)] !== undefined) continue
      const a = portLaneEnd(m, p)
      if (state.reserved[tkey(a.x, a.y)] !== portTag(m.id, p.id)) continue
      if (area !== undefined && !rectContains(area, a.x, a.y)) continue
      out.push(a)
    }
  }
  return out
}

/**
 * B57: how far an underground may jump on a lane's way out: the `transport-belt` tier's underground (game data, 5). A
 * lane walled in by one belt or a short claim is not sealed: the router goes under it.
 */
export const LANE_HOP = 5

/**
 * B57: what a lane's way out may go under (an underground's span): anything but a module or unknown ground; and, as the
 * router, not along another underground's span on the same line (seed 11: a pocket "led out" along a route's spans).
 */
export interface LaneHop {
  under: (this: void, x: number, y: number) => boolean
  max: number
  state?: LayoutState
}

/** B57: an underground from (x, y) heading `d` to (ex, ey) overlaps no other underground on its line. */
function spanFree(state: LayoutState | undefined, x: number, y: number, ex: number, ey: number, d: number): boolean {
  if (state === undefined) return true
  const a = d % 2 === 1 ? math.min(x, ex) : math.min(y, ey)
  const b = d % 2 === 1 ? math.max(x, ex) : math.max(y, ey)
  return spanConflicts(state, lineKey(x, y, d), a, b).length === 0
}

/**
 * B45: a way out of a port lane ending at `start`: a path over `free` ground (and, with `hop`, undergrounds under what
 * `hop.under` allows, as the router's seal check) to a tile `need` steps (Manhattan) away, or undefined if the lane is
 * walled in (seed 222, D54: the power plant's coal mine, its claim and its margin sealed the labs' pack input, and every
 * later production plan failed on "no path").
 * With `goal`, reaching it (or a tile next to it) also counts: a lane to a partner in the same pocket is not sealed.
 * B57: farthest-first (a bucket per distance), not breadth-first: on open ground it walks about `need` tiles straight
 * out, so a far `need` stays cheap, and it only explores a whole pocket when the lane is in one (8 steps let a 112-tile
 * pocket through on seed 555555 and a 221-tile one on seed 11).
 */
export function laneWayOut(start: LaneEnd, free: (this: void, x: number, y: number) => boolean, need: number, hop?: LaneHop, goal?: Vec): Vec[] | undefined {
  // B85: states are (tile, heading), as the router's seal check has them: a belt goes on or turns left or right (never
  // back), and an underground runs straight along the heading, from where the belt is. A tile-only flood let a lane turn
  // round in a one-wide dead end, or dive sideways from the lane end, under a belt there (seed 5480563: lab cluster 3's
  // red assembler faced into such a pocket; every lane check passed it, and the router found it sealed).
  const from: Record<number, number> = {}
  const buckets: number[][] = [[]]
  const k0 = tkey(start.x, start.y)
  for (let h = 0; h < 4; h++) {
    if (start.out !== undefined && h !== start.out) continue
    from[k0 * 4 + h] = -1
    buckets[0].push(k0 * 4 + h)
  }
  const path = (st: number): Vec[] => {
    const out: Vec[] = []
    for (let at = st; at !== -1; at = from[at]) out.push({ x: keyX(math.floor(at / 4)), y: keyY(math.floor(at / 4)) })
    return out
  }
  let top = 0
  while (top >= 0) {
    const st = buckets[top]?.pop()
    if (st === undefined) {
      top--
      continue
    }
    const h = st % 4
    const cx = keyX(math.floor(st / 4))
    const cy = keyY(math.floor(st / 4))
    // A step on or to either side; then (with `hop`) the undergrounds straight on: the exit 2..max tiles on, over tiles
    // it may go under, and its exit belt feeds the tile straight on.
    const moves: { x: number; y: number; d: number; ex?: number; ey?: number }[] = []
    for (const nd of [h, (h + 1) % 4, (h + 3) % 4]) moves.push({ x: cx + DX[nd], y: cy + DY[nd], d: nd })
    if (hop !== undefined) {
      for (let n = 2; n <= hop.max; n++) {
        const ex = cx + DX[h] * n
        const ey = cy + DY[h] * n
        if (!hop.under(ex - DX[h], ey - DY[h])) break
        moves.push({ x: ex + DX[h], y: ey + DY[h], d: h, ex, ey })
      }
    }
    for (const mv of moves) {
      const ns = tkey(mv.x, mv.y) * 4 + mv.d
      if (from[ns] !== undefined || !free(mv.x, mv.y)) continue
      if (mv.ex !== undefined && mv.ey !== undefined) {
        const es = tkey(mv.ex, mv.ey) * 4 + mv.d
        if (from[es] !== undefined || !free(mv.ex, mv.ey) || !spanFree(hop!.state, cx, cy, mv.ex, mv.ey, mv.d)) continue
        from[es] = st
        from[ns] = es
      } else from[ns] = st
      const dist = math.abs(mv.x - start.x) + math.abs(mv.y - start.y)
      if (dist >= need || (goal !== undefined && math.abs(mv.x - goal.x) + math.abs(mv.y - goal.y) <= 1)) return path(ns)
      const b = buckets[dist]
      if (b === undefined) buckets[dist] = [ns]
      else b.push(ns)
      if (dist > top) top = dist
    }
  }
  return undefined
}

/** B85: a lane end, and the heading a belt leaves it with (away from its module); undefined: any. */
export interface LaneEnd extends Vec {
  out?: number
}

/** B85: the direction index (DX/DY) of a unit step, or undefined. */
export function stepDir(dx: number, dy: number): number | undefined {
  for (let d = 0; d < 4; d++) if (DX[d] === dx && DY[d] === dy) return d
  return undefined
}

/** B85: the lane end of port `p` of module `m` (its approach tile), heading out of the module. */
export function portLaneEnd(m: PlacedModule, p: Port): LaneEnd {
  const o = portOutside(m, p)
  const a = portApproach(m, p)
  return { x: a.x, y: a.y, out: stepDir(a.x - o.x, a.y - o.y) }
}

/**
 * B51 / B57: the ground a lane of port `tag` may lead out over in a layout (not a module, route, mine claim or another
 * port's reservation; trees and rocks pass), and what its undergrounds may go under (anything but a module).
 */
export function layoutLaneGround(state: LayoutState, terrain: TerrainView, tag: string): { free: (this: void, x: number, y: number) => boolean; hop: LaneHop } {
  const protectedLane = laneTag(tag)
  const margins = layoutMargins(state)
  const free = (x: number, y: number): boolean => {
    const k = tkey(x, y)
    if (laneClaimConflict(state, k, tag, protectedLane) !== undefined) return false
    const r = state.reserved[k]
    if (r === tag || r === protectedLane) return true
    // B85: a module's margin ring is own ground once built (reserved by the faction): not a way out.
    if (margins[k]) return false
    const b = terrain.block(x, y)
    return b === FREE || b === TREE || b === ROCK
  }
  const under = (x: number, y: number): boolean => {
    const o = state.occ[tkey(x, y)]
    return !(o !== undefined && string.sub(o, 1, 2) === "m:") && terrain.block(x, y) !== UNKNOWN
  }
  return { free, hop: { under, max: LANE_HOP, state } }
}

/** B57: the reservation tag of a protected lane's way out (a plan keeps it clear; see plan.ts `guardLanes`). */
export { laneTag }

/**
 * B51: the belt inputs of module `id` not in `fed` whose lane (from the approach tile) no longer leads `need` steps out
 * over ground a route could use (`layoutLaneGround`).
 */
export function sealedInputs(state: LayoutState, terrain: TerrainView, id: string, fed: Record<string, boolean>, need: number): string[] {
  const m = findModule(state, id)
  const out: string[] = []
  if (m === undefined) return out
  for (const p of m.def.ports) {
    if (p.kind !== "belt-in" || fed[p.id]) continue
    const g = layoutLaneGround(state, terrain, portTag(m.id, p.id))
    if (!laneLeadsOut(portLaneEnd(m, p), g.free, need, g.hop)) out.push(p.id)
  }
  return out
}

export function laneLeadsOut(start: LaneEnd, free: (this: void, x: number, y: number) => boolean, need: number, hop?: LaneHop, goal?: Vec): boolean {
  return laneWayOut(start, free, need, hop, goal) !== undefined
}

/**
 * B45: whether `blocked` walls in an open port lane that leads out without it. B57: each lane's way out is found once
 * (`openPorts[].path`); only a candidate that touches it is checked again.
 */
function sealsPortLane(s: PlacementSearch, state: LayoutState | undefined, blocked: Rect, need: number): boolean {
  const ports = s.openPorts ?? []
  for (const p of ports) {
    if (p.ok === undefined) wayOutWithout(s, state, p, need)
    if (!p.ok || !rectsOverlap(p.box!, blocked)) continue
    let touches = false
    for (const t of p.path!) if (rectContains(blocked, t.x, t.y)) touches = true
    if (!touches) continue
    p.sealedBy ??= {}
    const key = `${blocked.x},${blocked.y},${blocked.w},${blocked.h}`
    let sealed = p.sealedBy[key]
    if (sealed === undefined) {
      sealed = laneWayOut(p, laneFree(s, state, blocked), need, laneHop(s, state, blocked)) === undefined
      p.sealedBy[key] = sealed
    }
    if (sealed) return true
  }
  return false
}

/** B45: a port lane's way out with no candidate in it (`p.path`, `p.ok`, and its bounds `p.box`). */
function wayOutWithout(s: PlacementSearch, state: LayoutState | undefined, p: NonNullable<PlacementSearch["openPorts"]>[number], need: number): void {
  p.path = laneWayOut(p, laneFree(s, state), need, laneHop(s, state))
  p.ok = p.path !== undefined
  if (p.path === undefined) return
  let x1 = math.huge
  let y1 = math.huge
  let x2 = -math.huge
  let y2 = -math.huge
  for (const t of p.path) {
    x1 = math.min(x1, t.x)
    y1 = math.min(y1, t.y)
    x2 = math.max(x2, t.x)
    y2 = math.max(y2, t.y)
  }
  p.box = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }
}

/** B45 / B85: ground a lane may lead out over in the window: not hard, not a placed module's margin ring, not `blocked`. */
function laneFree(s: PlacementSearch, state: LayoutState | undefined, blocked?: Rect): (this: void, x: number, y: number) => boolean {
  const margins = state !== undefined ? layoutMargins(state) : {}
  return (x, y) => margins[tkey(x, y)] !== true && (sum(s, "hard", { x, y, w: 1, h: 1 }) ?? 0) === 0 && (blocked === undefined || !rectContains(blocked, x, y))
}

/** B57: a lane's undergrounds go under anything but a module (or `blocked`). */
function laneHop(s: PlacementSearch, state: LayoutState | undefined, blocked?: Rect): LaneHop {
  return { under: (x, y) => (sum(s, "mods", { x, y, w: 1, h: 1 }) ?? 0) === 0 && (blocked === undefined || !rectContains(blocked, x, y)), max: LANE_HOP, state }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * B57 (seed 11): each of the candidate's own belt ports must have a lane that leads out past its own footprint, or to
 * its connection's target (the iron mine for green science faced into a 221-tile pocket; only one tile of clearance
 * was checked).
 */
function ownLanesOut(s: PlacementSearch, state: LayoutState, policy: LayoutPolicy, td: TDef, ox: number, oy: number): boolean {
  const need = policy.placement.portEscape ?? 0
  if (need <= 0) return true
  const rect = { x: ox, y: oy, w: td.def.footprint.w, h: td.def.footprint.h }
  // B85: the candidate's own margin ring and the placed modules' rings are own ground once built: not a way out.
  const ring = inflate(rect, 1)
  const margins = layoutMargins(state)
  const free = (x: number, y: number): boolean => !rectContains(ring, x, y) && !margins[tkey(x, y)] && (sum(s, "hard", { x, y, w: 1, h: 1 }) ?? 0) === 0
  const hop: LaneHop = { under: (x, y) => !rectContains(rect, x, y) && (sum(s, "mods", { x, y, w: 1, h: 1 }) ?? 0) === 0, max: LANE_HOP, state }
  for (const p of td.ports) {
    // Reaching the port's connection (its target) is enough: the partner may share the pocket.
    if (!laneLeadsOut({ x: ox + p.ox + p.nx, y: oy + p.oy + p.ny, out: stepDir(p.nx, p.ny) }, free, need, hop, s.req.targets[p.id])) return false
  }
  return true
}

/** B57: `ownLanesOut`, only for a candidate that would become the best (a flood per port is too dear for every one). */
function sealGate(s: PlacementSearch, state: LayoutState, policy: LayoutPolicy, td: TDef, ox: number, oy: number): boolean {
  if (ownLanesOut(s, state, policy, td, ox, oy)) return true
  reject(s, "own-lane-sealed", ox, oy)
  return false
}

function startWindow(s: PlacementSearch, state: LayoutState, policy: LayoutPolicy): void {
  const R = radii(s, policy)[s.radiusIdx]
  // B26: an expandable module's own scored growth band (and its corridor ring) must fit in the window.
  const M = windowMargin(s, policy)
  const t = s.target!
  s.wx = math.max(t.x - R - M, s.req.region.x)
  s.wy = math.max(t.y - R - M, s.req.region.y)
  s.ww = math.min(t.x + R + M, s.req.region.x + s.req.region.w) - s.wx
  s.wh = math.min(t.y + R + M, s.req.region.y + s.req.region.h) - s.wy
  s.row = 0
  s.sat = {}
  s.band = nearBandTiles(s, state, policy)
  s.openPorts = openPortEnds(state, s.req.id, { x: s.wx, y: s.wy, w: s.ww, h: s.wh })
  for (const l of LAYERS) {
    const a: number[] = []
    for (let i = 0; i < s.ww + 1; i++) a.push(0)
    s.sat[l] = a
  }
  s.ti = 0
  s.ci = 0
  s.stride = 2
  s.top = []
  s.refine = []
  s.ri = -1
  s.phase = "sat"
}

function keepTop(s: PlacementSearch, ti: number, score: number, ox: number, oy: number): void {
  let list = s.top[ti]
  if (list === undefined) {
    list = []
    s.top[ti] = list
  }
  list.push({ score, ox, oy })
  list.sort((a, b) => a.score - b.score)
  if (list.length > TOP_K) list.pop()
}

/** Builds one row of the summed-area tables. */
function satRow(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): void {
  const y = s.wy + s.row
  const W = s.ww + 1
  const resource = s.req.def.anchor?.resource
  const treeHard = policy.obstacles.trees !== "clear"
  const rockHard = policy.obstacles.rocks !== "clear"
  const clearTree = policy.router.clearTree
  const clearRock = policy.router.clearRock
  const clearPole = policy.obstacles.poleEvict ?? 0
  const aHard = s.sat.hard
  const aOre = s.sat.ore
  const aClear = s.sat.clear
  const aWater = s.sat.water
  const aMods = s.sat.mods
  const aRes = s.sat.res
  const aSoft = s.sat.soft
  const aBand = s.sat.band
  const aGblock = s.sat.gblock
  const band = s.band ?? {}
  // B26: tiles where this module's own growth would be refused (`tryExpand`'s checks), for expandable non-mining modules.
  const ownGrowth = ownGrowthLength(s.req.def) > 0
  const oreBlocks = policy.protectOre && !isMining(s.req.def)
  const treeBlocks = policy.obstacles.trees !== "clear"
  const rockBlocks = policy.obstacles.rocks !== "clear"
  const self = s.req.id
  const softTiles = state.soft
  const exempt = s.req.softExempt ?? {}
  const occ = state.occ
  const reserved = state.reserved
  const routeOcc = state.routeOcc
  const mine = state.mine ?? {}
  let hard = 0
  let ores = 0
  let clear = 0
  let water = 0
  let mods = 0
  let res = 0
  let soft = 0
  let nearBand = 0
  let gblock = 0
  const base = (s.row + 1) * W
  const prev = base - W
  aHard[base] = 0
  aOre[base] = 0
  aClear[base] = 0
  aWater[base] = 0
  aMods[base] = 0
  aRes[base] = 0
  aSoft[base] = 0
  aBand[base] = 0
  aGblock[base] = 0
  for (let i = 0; i < s.ww; i++) {
    const x = s.wx + i
    const k = tkey(x, y)
    const b = terrain.block(x, y)
    // B37: a pole line's tile is clearable ground (the line is evicted and re-poled), at `obstacles.poleEvict`.
    const pole = isPoleTag(occ[k])
    const o = pole ? undefined : occ[k]
    if (b >= OWN || (b === TREE && treeHard) || (b === ROCK && rockHard) || o !== undefined || reserved[k] !== undefined || routeOcc[k] !== undefined || (mine[k] !== undefined && mine[k] !== s.req.id)) hard++
    const ore = terrain.ore(x, y)
    if (ore !== undefined) {
      ores++
      if (ore === resource) res++
    }
    if (b === TREE) clear += clearTree
    else if (b === ROCK) clear += clearRock
    if (pole) clear += clearPole
    else if (b === WATER) water++
    if (o !== undefined && string.sub(o, 1, 2) === "m:") mods++
    if (softTiles !== undefined && softTiles[k] !== undefined && !exempt[softTiles[k]]) soft++
    if (band[k]) nearBand++
    if (
      ownGrowth &&
      ((b !== FREE && !(b === TREE && !treeBlocks) && !(b === ROCK && !rockBlocks)) ||
        o !== undefined ||
        routeOcc[k] !== undefined ||
        reserved[k] !== undefined ||
        (mine[k] !== undefined && mine[k] !== self) ||
        (softTiles !== undefined && softTiles[k] !== undefined && softTiles[k] !== self) ||
        (oreBlocks && ore !== undefined))
    )
      gblock++
    const j = base + i + 1
    const p = prev + i + 1
    aHard[j] = aHard[p] + hard
    aOre[j] = aOre[p] + ores
    aClear[j] = aClear[p] + clear
    aWater[j] = aWater[p] + water
    aMods[j] = aMods[p] + mods
    aRes[j] = aRes[p] + res
    aSoft[j] = aSoft[p] + soft
    aBand[j] = aBand[p] + nearBand
    aGblock[j] = aGblock[p] + gblock
  }
  s.row++
}

/** Sum of a layer over a world rect; undefined if the rect leaves the window. */
function sum(s: PlacementSearch, layer: string, r: Rect): number | undefined {
  const x1 = r.x - s.wx
  const y1 = r.y - s.wy
  const x2 = x1 + r.w
  const y2 = y1 + r.h
  if (x1 < 0 || y1 < 0 || x2 > s.ww || y2 > s.wh) return undefined
  const a = s.sat[layer]
  // A search saved before the layer existed (old storage) has no table for it.
  if (a === undefined) return 0
  const W = s.ww + 1
  return a[y2 * W + x2] - a[y1 * W + x2] - a[y2 * W + x1] + a[y1 * W + x1]
}

/** Why `evaluate` last rejected a candidate, and the features it last scored (plan traces; plain upvalue writes). */
let why = ""
let lastF: CandidateFeatures | undefined

/** Rejects a candidate: the trace's `why` and the search's failure certificate (counts and one sample per reason). */
function reject(s: PlacementSearch, reason: string, ox: number, oy: number): undefined {
  why = reason
  s.rejections ??= {}
  const finding = s.rejections[reason]
  if (finding === undefined) s.rejections[reason] = { count: 1, sample: { x: ox, y: oy } }
  else finding.count++
  return undefined
}

export function placementFailureCertificate(s: PlacementSearch): Record<string, { count: number; sample: Vec }> {
  return s.rejections ?? {}
}

function evaluate(s: PlacementSearch, policy: LayoutPolicy, td: TDef, ox: number, oy: number, state: LayoutState): { score: number; coverage: number; clear: number } | undefined {
  const def = td.def
  const rect = { x: ox, y: oy, w: def.footprint.w, h: def.footprint.h }
  if (!rectContains(s.req.region, rect.x, rect.y) || !rectContains(s.req.region, rect.x + rect.w - 1, rect.y + rect.h - 1)) {
    return reject(s, "region", ox, oy)
  }
  if (sum(s, "hard", rect) !== 0) {
    return reject(s, "hard", ox, oy)
  }
  for (const a of s.req.avoid ?? []) {
    if (rect.x < a.x + a.w && a.x < rect.x + rect.w && rect.y < a.y + a.h && a.y < rect.y + rect.h) {
      return reject(s, "avoid", ox, oy)
    }
  }
  const mining = isMining(def)
  // M7b: a module anchored to a resource (a pumpjack field) stands on its own wells.
  if (policy.protectOre && !mining && def.anchor?.resource === undefined && sum(s, "ore", rect) !== 0) {
    return reject(s, "ore", ox, oy)
  }
  if (sum(s, "mods", inflate(rect, policy.corridor.min)) !== 0) {
    return reject(s, "corridor", ox, oy)
  }
  const clear = sum(s, "clear", rect)!
  if (clear > policy.obstacles.maxClearCost) {
    return reject(s, "clear-cost", ox, oy)
  }
  if (def.site === "shore") {
    for (const w of def.anchor?.water ?? []) {
      const wr = { x: ox + w.x, y: oy + w.y, w: w.w, h: w.h }
      if (sum(s, "water", wr) !== w.w * w.h) {
        return reject(s, "shore", ox, oy)
      }
    }
  }
  let coverage = 1
  if (mining) {
    let have = 0
    let all = 0
    for (const a of def.anchor?.miningAreas ?? []) {
      const area = { x: ox + a.x, y: oy + a.y, w: a.w, h: a.h }
      const n = sum(s, "res", area)
      if (n === undefined || n < policy.minOreCoverage * a.w * a.h) {
        return reject(s, "coverage", ox, oy)
      }
      // B6: a drill mines every ore in its area; a second ore would clog the single-item line (D23).
      if (sum(s, "ore", area)! !== n) {
        return reject(s, "foreign-ore", ox, oy)
      }
      have += n
      all += a.w * a.h
    }
    coverage = all > 0 ? have / all : 1
  }
  // D52: a mine that can't expand in place is a dead end. Hard: an expandable outpost's first growth unit must still
  // have some ore (seed 222: the rotated red-line iron mine sat on the patch's right edge, its growth led off-ore, it
  // depleted and could not grow). Soft (below): prefer sites with more growth ore.
  let growthCoverage: number | undefined
  if (mining) {
    // D52/OutpostPlanner: the mine may grow at either end, so both ends count — it is a dead end only if neither has
    // ore. `def` is the transformed def (expand dropped); the expand spec lives on the canonical request def.
    const tailCov = firstGrowthCoverage(s, td, ox, oy, "tail")
    const headCov = firstGrowthCoverage(s, td, ox, oy, "head")
    const cands = [tailCov, headCov].filter((c): c is number => c !== undefined)
    if (cands.length > 0) {
      growthCoverage = Math.max(...cands)
      if ((s.req.def.expand?.maxUnits ?? 0) > 0 && growthCoverage === 0) {
        return reject(s, "no-growth-ore", ox, oy)
      }
    }
  }
  // B26: the same for any expandable module that is not a mine: how many units of its own growth band (on the end
  // `tryExpand` grows) are clear of what `tryExpand` refuses — terrain, ore, other modules and their corridor ring,
  // routes, port reservations, interaction tiles, mine and soft claims. Near units past the first refused one count too.
  let growthBlocked: number | undefined
  const spec = s.req.def.expand
  if (!mining && spec !== undefined && spec.maxUnits > 0 && (policy.placement.growthBlocked ?? 0) > 0) {
    const cdef = s.req.def
    // Only the near band counts (the units growth needs first, `growthBandUnits`): asking every unit up to the cap
    // to be clear (a smelter's is 20 tiles deep) pulled whole clusters apart on the plan replays.
    const want = math.min(spec.maxUnits, policy.placement.growthBandUnits ?? spec.maxUnits)
    let clearUnits = 0
    for (let i = 0; i < want; i++) {
      const r = transformRect(growthStrip(cdef, i, "auto"), cdef.footprint.w, cdef.footprint.h, td.t)
      const wr = { x: ox + r.x, y: oy + r.y, w: r.w, h: r.h }
      const g = sum(s, "gblock", wr)
      const near = sum(s, "mods", inflate(wr, policy.corridor.min))
      if (g === undefined || g > 0 || near === undefined || near > 0) break
      clearUnits++
    }
    growthBlocked = want - clearUnits
  }
  let portDist = 0
  let facingAway = 0
  for (const p of td.ports) {
    const x = ox + p.ox
    const y = oy + p.oy
    if (sum(s, "hard", { x, y, w: 1, h: 1 }) !== 0) {
      return reject(s, "port-blocked", ox, oy)
    }
    // Port clearance: the tile beyond the outside tile is not another module or blocked, so the port has a lane out.
    if (sum(s, "hard", { x: x + p.nx, y: y + p.ny, w: 1, h: 1 }) !== 0 || sum(s, "mods", { x: x + p.nx, y: y + p.ny, w: 1, h: 1 }) !== 0) {
      return reject(s, "port-lane", ox, oy)
    }
    if (policy.protectOre && sum(s, "ore", { x, y, w: 1, h: 1 }) !== 0 && !mining) portDist += policy.router.oreTile
    const t = s.req.targets[p.id]
    if (t === undefined) continue
    portDist += math.abs(t.x - x) + math.abs(t.y - y)
    if (p.nx * (t.x - x) + p.ny * (t.y - y) < 0) facingAway++
  }
  // B45: nor wall in another module's unconnected port lane (its margin ring reads as own ground to later plans).
  const escape = policy.placement.portEscape ?? 0
  if (escape > 0 && sealsPortLane(s, state, inflate(rect, 1), escape)) {
    return reject(s, "port-sealed", ox, oy)
  }
  const adjacent = sum(s, "mods", inflate(rect, policy.corridor.preferred + 1)) ?? 0
  const inner = sum(s, "mods", inflate(rect, policy.corridor.preferred)) ?? 0
  const f: CandidateFeatures = {
    centerDist: manhattan({ x: ox + def.footprint.w / 2, y: oy + def.footprint.h / 2 }, s.req.center),
    portDist,
    facingAway,
    clearCost: clear,
    adjacent,
    exactGap: adjacent - inner,
    coverage,
    growthCoverage,
    softClaim: sum(s, "soft", rect) ?? 0,
    growthBand: sum(s, "band", rect) ?? 0,
    growthBlocked,
  }
  lastF = f
  return { score: packingScorer(policy.packing)(f, policy), coverage, clear }
}

/** Point `i` of ring `r` around `c`, in scan order: the top and bottom rows by x (alternating), then the sides by y. */
function ringPoint(c: Vec, r: number, i: number): Vec {
  if (r === 0) return { x: c.x, y: c.y }
  const row = 2 * (2 * r + 1)
  if (i < row) return { x: c.x - r + math.floor(i / 2), y: i % 2 === 0 ? c.y - r : c.y + r }
  const j = i - row
  return { x: j % 2 === 0 ? c.x - r : c.x + r, y: c.y - r + 1 + math.floor(j / 2) }
}

/** Advances a placement search by about `budget` work units. Returns the work used. */
export function stepPlacement(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  let used = 0
  while (used < budget && (s.phase === "site" || s.phase === "sat" || s.phase === "scan")) {
    if (s.phase === "site" && isMining(s.req.def)) {
      used += nextPatch(s, state, terrain, policy)
      continue
    }
    if (s.phase === "site") {
      // Ring by ring around the centre: the nearest shore tile or ore tile of the resource. Only points whose window
      // (`startWindow`: the target ± the largest radius and margin, clipped to the region) still meets the region count:
      // the rings are clipped to that box. Half a work unit a tile checked, as `satRow` (B53: r / 2 a ring of 8r tiles
      // let one planner tick scan ~16× its budget; a region with no water spun at ~50 ms a tick).
      const c = s.req.center
      const r = s.ring
      const reg = s.req.region
      let reach = 0
      for (const R of radii(s, policy)) reach = math.max(reach, R)
      reach += windowMargin(s, policy)
      const bx1 = reg.x - reach
      const by1 = reg.y - reach
      const bx2 = reg.x + reg.w - 1 + reach
      const by2 = reg.y + reg.h - 1 + reach
      const maxR = math.min(math.max(reg.w, reg.h), math.max(c.x - bx1, bx2 - c.x, c.y - by1, by2 - c.y))
      if (r > maxR) {
        s.phase = "failed"
        s.failure = planFailure("no-site", `no ${s.req.def.site} site in the region`, s.req.def.site)
        s.reason = s.failure.reason
        if (s.trace !== undefined) finishTrace(s, state, terrain, policy)
        break
      }
      // Resumes the ring where the last step stopped; half a work unit a point checked.
      let found: Vec | undefined
      const n = r === 0 ? 1 : 8 * r
      let i = s.ringIdx ?? 0
      while (i < n && found === undefined && used < budget) {
        const p = ringPoint(c, r, i)
        i++
        if (p.x < bx1 || p.x > bx2 || p.y < by1 || p.y > by2) continue
        used += 0.5
        if (sitePoint(s.req.def, terrain, p.x, p.y)) found = p
      }
      if (found === undefined && i < n) {
        s.ringIdx = i
        break
      }
      s.ringIdx = undefined
      used += 0.5
      s.ring++
      if (found !== undefined) {
        s.target = found
        startWindow(s, state, policy)
      }
      continue
    }
    if (s.phase === "sat") {
      if (s.ww <= 0 && s.row === 0 && s.sat.hard === undefined) startWindow(s, state, policy)
      if (s.row >= s.wh) {
        s.phase = "scan"
        continue
      }
      satRow(s, state, terrain, policy)
      used += s.ww / 2
      continue
    }
    // Scan: candidates for transform ti, origin index ci over a (2R + 1)² square around the target, every `stride`
    // tiles; then refine (±1 around the best few per transform of a coarse pass).
    const R = radii(s, policy)[s.radiusIdx]
    const side = 2 * R + 1
    const n = math.floor((side - 1) / s.stride) + 1
    if (s.ri >= 0) {
      if (s.ri >= s.refine.length) {
        s.ti = s.tdefs.length
        s.ri = -1
        s.refine = []
        s.stride = 0
      } else {
        const c = s.refine[s.ri]
        const e = evaluate(s, policy, s.tdefs[c.ti], c.ox, c.oy, state)
        s.candidates = (s.candidates ?? 0) + 1
        if (s.trace !== undefined) traceCandidate(s, c.ti, c.ox, c.oy, e?.score)
        if (e !== undefined && (s.best === undefined || e.score < s.best.score - 1e-9) && sealGate(s, state, policy, s.tdefs[c.ti], c.ox, c.oy)) s.best = { score: e.score, ti: c.ti, ox: c.ox, oy: c.oy, coverage: e.coverage, clear: e.clear }
        s.ri++
        used++
        continue
      }
    }
    if (s.ti >= s.tdefs.length) {
      if (s.stride === 2 && s.best !== undefined) {
        // Refine around the coarse pass's best candidates.
        const seen: Record<string, boolean> = {}
        for (let ti = 0; ti < s.tdefs.length; ti++) {
          for (const c of s.top[ti] ?? []) {
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                const key = `${ti}:${c.ox + dx},${c.oy + dy}`
                if ((dx === 0 && dy === 0) || seen[key]) continue
                seen[key] = true
                s.refine.push({ ti, ox: c.ox + dx, oy: c.oy + dy })
              }
            }
          }
        }
        s.ri = 0
        continue
      }
      if (s.stride === 2) {
        // Nothing feasible on the coarse grid: scan every origin before widening the radius.
        s.stride = 1
        s.ti = 0
        s.ci = 0
        continue
      }
      if (s.best !== undefined) {
        const td = s.tdefs[s.best.ti]
        const m: PlacedModule = {
          id: moduleId(s.req.id),
          canonical: s.req.def,
          def: td.def,
          transform: td.t,
          origin: { x: s.best.ox, y: s.best.oy },
          rect: { x: s.best.ox, y: s.best.oy, w: td.def.footprint.w, h: td.def.footprint.h },
        }
        s.result = m
        s.phase = "done"
        if (s.trace !== undefined) finishTrace(s, state, terrain, policy)
      } else if (s.radiusIdx + 1 < radii(s, policy).length) {
        s.radiusIdx++
        startWindow(s, state, policy)
      } else if (s.patch !== undefined) {
        // B50 / D57: no room on this patch (seed 3333: the home field was built out): remember it, try the next one.
        noteDeadPatch(s, state, terrain)
        s.patch = undefined
        s.target = undefined
        s.radiusIdx = 0
        s.phase = "site"
      } else {
        s.phase = "failed"
        s.failure = planFailure("no-position", "no feasible position", s.req.def.anchor?.resource)
        s.reason = s.failure.reason
        if (s.trace !== undefined) finishTrace(s, state, terrain, policy)
      }
      continue
    }
    const td = s.tdefs[s.ti]
    const t = s.target!
    const cx = (s.ci % n) * s.stride
    const cy = math.floor(s.ci / n) * s.stride
    const ox = t.x - R + cx - math.floor(td.def.footprint.w / 2)
    const oy = t.y - R + cy - math.floor(td.def.footprint.h / 2)
    const e = evaluate(s, policy, td, ox, oy, state)
    s.candidates = (s.candidates ?? 0) + 1
    if (s.trace !== undefined) traceCandidate(s, s.ti, ox, oy, e?.score)
    if (e !== undefined) {
      if ((s.best === undefined || e.score < s.best.score - 1e-9) && sealGate(s, state, policy, td, ox, oy)) s.best = { score: e.score, ti: s.ti, ox, oy, coverage: e.coverage, clear: e.clear }
      if (s.stride === 2) keepTop(s, s.ti, e.score, ox, oy)
    }
    used++
    s.ci++
    if (s.ci >= n * n) {
      s.ci = 0
      s.ti++
    }
  }
  s.work += used
  return used
}

// ---------------------------------------------------------------------------------------------------------
// Decision trace (planner/trace.ts): only runs while a tool has `planTrace.sink` set.

function tname(t: Transform): string {
  return `r${t.rot}${t.mirror ? "m" : ""}`
}

function traceCandidate(s: PlacementSearch, ti: number, ox: number, oy: number, score: number | undefined): void {
  const acc = s.trace!
  if (score !== undefined) {
    noteFeasible(acc, ti, ox, oy, score)
    return
  }
  const def = s.tdefs[ti].def
  noteReject(acc, why, ti, ox, oy, manhattan({ x: ox + def.footprint.w / 2, y: oy + def.footprint.h / 2 }, s.req.center))
}

/** The first tile of `r` where `test` holds, described. */
function firstTile(state: LayoutState, terrain: TerrainView, r: Rect, test: (this: void, x: number, y: number) => boolean): string | undefined {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (test(x, y)) return `${x},${y}: ${describeTile(state, terrain, x, y)}`
  return undefined
}

/** What rules out a rejected candidate, in words (re-derived from the layout and terrain, like `satRow` does). */
function rejectBlocker(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, reason: string, td: TDef, ox: number, oy: number): string {
  const def = td.def
  const rect = { x: ox, y: oy, w: def.footprint.w, h: def.footprint.h }
  const treeHard = policy.obstacles.trees !== "clear"
  const rockHard = policy.obstacles.rocks !== "clear"
  const hard = (x: number, y: number): boolean => {
    const k = tkey(x, y)
    const b = terrain.block(x, y)
    return b >= OWN || (b === TREE && treeHard) || (b === ROCK && rockHard) || placementClaimConflict(state, k, s.req.id) !== undefined
  }
  const isMod = (x: number, y: number): boolean => {
    const o = state.occ[tkey(x, y)]
    return o !== undefined && string.sub(o, 1, 2) === "m:"
  }
  if (reason === "hard") return `blocked at ${firstTile(state, terrain, rect, hard) ?? "?"}`
  if (reason === "ore") return `ore at ${firstTile(state, terrain, rect, (x, y) => terrain.ore(x, y) !== undefined) ?? "?"}`
  if (reason === "corridor") return `module within ${policy.corridor.min} tiles at ${firstTile(state, terrain, inflate(rect, policy.corridor.min), isMod) ?? "?"}`
  if (reason === "clear-cost") return `clearing cost over ${policy.obstacles.maxClearCost}`
  if (reason === "region") return "footprint leaves the planning region"
  if (reason === "avoid") return "overlaps an avoided rectangle (old footprint or the request's avoid list)"
  if (reason === "port-blocked" || reason === "port-lane") {
    for (const p of td.ports) {
      const x = ox + p.ox + (reason === "port-lane" ? p.nx : 0)
      const y = oy + p.oy + (reason === "port-lane" ? p.ny : 0)
      if (hard(x, y) || (reason === "port-lane" && isMod(x, y))) return `port ${p.id} ${reason === "port-lane" ? "lane" : "outside tile"} at ${x},${y}: ${describeTile(state, terrain, x, y)}`
    }
  }
  return reason
}

function candidateTrace(s: PlacementSearch, state: LayoutState, policy: LayoutPolicy, ti: number, ox: number, oy: number): CandidateTrace | undefined {
  const td = s.tdefs[ti]
  const e = evaluate(s, policy, td, ox, oy, state)
  if (e === undefined || lastF === undefined) return undefined
  return { transform: tname(td.t), origin: { x: ox, y: oy }, rect: { x: ox, y: oy, w: td.def.footprint.w, h: td.def.footprint.h }, score: e.score, terms: placementTerms(lastF, policy), features: lastF }
}

function finishTrace(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): void {
  const acc = s.trace!
  s.trace = undefined
  const sink = planTrace.sink
  if (sink === undefined) return
  const top: CandidateTrace[] = []
  for (const c of acc.top) {
    const t = candidateTrace(s, state, policy, c.ti, c.ox, c.oy)
    if (t !== undefined) top.push(t)
  }
  const rejected: Record<string, { count: number; examples: RejectTrace[] }> = {}
  for (const [reason, r] of pairs(acc.rejected)) {
    rejected[reason as string] = {
      count: r.count,
      examples: r.examples.map((x) => ({ transform: tname(s.tdefs[x.ti].t), origin: { x: x.ox, y: x.oy }, centerDist: x.dist, blocker: rejectBlocker(s, state, terrain, policy, reason as string, s.tdefs[x.ti], x.ox, x.oy) })),
    }
  }
  sink.placements.push({
    module: s.req.id,
    def: s.req.def.id,
    phase: s.phase === "done" ? "done" : "failed",
    reason: s.reason,
    center: s.req.center,
    target: s.target,
    radius: radii(s, policy)[s.radiusIdx],
    candidates: s.candidates,
    feasible: acc.feasible,
    chosen: s.best !== undefined ? candidateTrace(s, state, policy, s.best.ti, s.best.ox, s.best.oy) : undefined,
    top,
    rejected,
  })
}

/** Places synchronously (tests, tools). */
/**
 * M7b: a module generated for one spot (a pumpjack field on its wells) is placed exactly at `origin` if every footprint
 * tile is placeable and unclaimed, without a search. Returns the module, or the reason it cannot go there.
 */
export function placeFixed(state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, id: string, def: ModuleDef, origin: Vec, facts: ProtoFacts): PlacedModule | string {
  const td = tdefOf(def, IDENTITY)
  // B119: the module is generated around what stands there (a pumpjack field's pipes go around cliffs): only its
  // entities' tiles need placeable ground; elsewhere in the box only other structures block.
  const under: Record<number, boolean> = {}
  for (const e of def.entities) {
    const r = entityRect(e, facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) under[tkey(origin.x + x, origin.y + y)] = true
  }
  for (let x = origin.x; x < origin.x + def.footprint.w; x++) {
    for (let y = origin.y; y < origin.y + def.footprint.h; y++) {
      const b = terrain.block(x, y)
      if (!under[tkey(x, y)]) {
        if (b === OWN || b === FOREIGN) return `structure at ${x},${y}`
      } else {
        if (b === TREE && policy.obstacles.trees !== "clear") return `tree at ${x},${y}`
        if (b === ROCK && policy.obstacles.rocks !== "clear") return `rock at ${x},${y}`
        if (b !== FREE && b !== TREE && b !== ROCK) return `blocked (${describeTile(state, terrain, x, y)}) at ${x},${y}`
      }
      const c = placementClaimConflict(state, tkey(x, y), id)
      if (c !== undefined) return `${c.code} at ${x},${y}`
    }
  }
  return { id: moduleId(id), canonical: def, def: td.def, transform: IDENTITY, origin: { x: origin.x, y: origin.y }, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h } }
}

export function placeNow(req: PlacementRequest, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): PlacementSearch {
  const s = newPlacement(req)
  while (s.phase !== "done" && s.phase !== "failed") stepPlacement(s, state, terrain, policy, 1e9)
  return s
}

function drillCount(def: ModuleDef, facts: ProtoFacts): number {
  let n = 0
  for (const e of def.entities) if (facts.entity(e.name)?.type === "mining-drill") n++
  return n
}

/**
 * B33: growth units of a strip mine (no whole-patch plan) that still put every new drill on its ore (ore under the
 * drill's body, the whole-patch plan's own test), counted from the growing end until the first unit that doesn't.
 * Its growth area, and so its hard claim, stops there instead of running the belt-limited cap off the patch.
 */
export function stripOreUnits(m: PlacedModule, terrain: TerrainView, facts: ProtoFacts): number {
  const c = m.canonical
  const spec = c.expand
  const resource = c.anchor?.resource
  if (spec === undefined || resource === undefined || m.minePlan !== undefined) return 0
  // A mine grows at its tail (its head holds the output port, B25): unit i is the new ground past the far end.
  if (growthEnd(c) !== "tail") return spec.maxUnits
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const W = c.footprint.w
  const H = c.footprint.h
  let n = 0
  for (let i = 0; i < spec.maxUnits; i++) {
    const off = (spec.axis === "x" ? W : H) + i * size
    for (const e of spec.unit.entities) {
      if (facts.entity(e.name)?.type !== "mining-drill") continue
      const er = entityRect(e, facts)
      const local = spec.axis === "x" ? { x: er.x + off, y: er.y, w: er.w, h: er.h } : { x: er.x, y: er.y + off, w: er.w, h: er.h }
      const r = transformRect(local, W, H, m.transform)
      let on = false
      for (let x = m.origin.x + r.x; x < m.origin.x + r.x + r.w && !on; x++) for (let y = m.origin.y + r.y; y < m.origin.y + r.y + r.h; y++) if (terrain.ore(x, y) === resource) on = true
      if (!on) return n
    }
    n++
  }
  return n
}

/**
 * Replaces the small linear placement template with its immutable, fixed-port whole-patch mine plan (D52), in every
 * topology (B33: point-to-point mines were left as strips whose growth ran off the patch). The plan covers the part of
 * the patch one output belt can carry (`claimPart`) and avoids ground other modules, routes, claims and reservations of
 * `state` already hold. When the plan does not fit (its entities on unbuildable or taken ground), the mine stays the
 * strip it was placed as and its growth is clipped to its ore (`stripOreUnits`).
 */
export function prepareWholePatchPlacement(m: PlacedModule, terrain: TerrainView, facts: ProtoFacts, region: Rect, policy: LayoutPolicy, state?: LayoutState, splitters = false): void {
  if (!isMining(m.canonical) || m.minePlan !== undefined) return
  const strip = (): void => {
    if (m.canonical.expand !== undefined) m.oreUnits = stripOreUnits(m, terrain, facts)
  }
  const resource = m.canonical.anchor?.resource
  const drillName = m.canonical.params?.drill
  const belt = m.canonical.params?.belt
  if (resource === undefined || typeof drillName !== "string" || typeof belt !== "string") return strip()
  const drill = facts.entity(drillName)
  if (drill === undefined) return strip()
  // Ground the layout already gives to someone else reads as own structures: no planned drill, belt or pole there.
  const taken = (x: number, y: number): boolean => {
    if (state === undefined) return false
    return moduleGrowthClaimConflict(state, tkey(x, y), m.id) !== undefined
  }
  const view: TerrainView = {
    block: (x, y) => (taken(x, y) ? OWN : terrain.block(x, y)),
    ore: (x, y) => terrain.ore(x, y),
  }
  const seeds: Vec[] = []
  for (const a of m.def.anchor?.miningAreas ?? []) {
    for (let x = m.origin.x + a.x; x < m.origin.x + a.x + a.w; x++) {
      for (let y = m.origin.y + a.y; y < m.origin.y + a.y + a.h; y++) if (terrain.ore(x, y) === resource) seeds.push({ x, y })
    }
  }
  const patch = connectedPatch(terrain, resource, seeds, region)
  if (patch === undefined) return strip()
  // Preserve the routing intent of the accepted small placement. Its output was oriented toward the consumer;
  // using that outside tile as the materializer's target chooses the matching edge of the whole-patch plan.
  const oldOut = m.def.ports.find((p) => p.id === "out")
  const near = oldOut !== undefined ? portOutside(m, oldOut) : { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }
  // The part it claims: a shared (splitter-tap) mine one full output belt over as many lanes as that takes; a
  // point-to-point mine, which only ever feeds its one consumer, one lane of the patch's grid (the strip it was placed
  // as, on the full-coverage grid and only over ore) holding at most as many drills as its template could grow to, so
  // the rest of the field stays free for the next consumer's own mine (the seed 11 / 3333 replays: two coal outposts
  // on one small field).
  let cap = beltDrillCap(facts, belt, drill, resource)
  let maxLanes = math.huge
  const spec = m.canonical.expand
  // P44 (b) (user, 2026-10-28: "Splitters, cap before"): rows past the first join the collector through splitters; with
  // none researched, the mine is one row (its two drill columns fill the two lanes of its belt, no side-load).
  if (!splitters) maxLanes = 1
  if (policy.topology !== "splitter-tap") {
    maxLanes = 1
    if (spec !== undefined) {
      let perUnit = 0
      for (const e of spec.unit.entities) if (facts.entity(e.name)?.type === "mining-drill") perUnit++
      cap = math.min(cap, drillCount(m.canonical, facts) + spec.maxUnits * perUnit)
    }
  }
  // B45: the plan, its claim and its margin must not wall in another module's unconnected port lane: when they do, the
  // patch is planned again around each such lane's way out (and a tile either side of it, the margin), once.
  const escape = state !== undefined ? (policy.placement.portEscape ?? 0) : 0
  const ground = (x: number, y: number): boolean => {
    const b = terrain.block(x, y)
    return !taken(x, y) && (b === FREE || b === TREE || b === ROCK)
  }
  // B57: undergrounds may go under anything but a module (here: nor the planned mine and its margin).
  const under = (x: number, y: number): boolean => {
    const o = state?.occ[tkey(x, y)]
    return !(o !== undefined && string.sub(o, 1, 2) === "m:" && o !== `m:${m.id}`) && terrain.block(x, y) !== UNKNOWN
  }
  const hop: LaneHop = { under, max: LANE_HOP, state }
  const lanes = escape > 0 ? openPortEnds(state!, m.id).filter((a) => laneLeadsOut(a, ground, escape, hop)) : []
  const keepOut: Record<number, boolean> = {}
  const planView: TerrainView = { block: (x, y) => (keepOut[tkey(x, y)] ? FOREIGN : view.block(x, y)), ore: view.ore }
  let built: ReturnType<typeof materializeMinePlan>
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = claimPart(planWholePatch(planView, patch, drill), planView, drill, near, cap, maxLanes)
    built = materializeMinePlan(m.canonical, plan, facts, near, policy.minOreCoverage, maxLanes > 1 ? "splitter" : undefined)
    if (built === undefined) return strip()
    const margin: Record<number, boolean> = {}
    for (const k of moduleMargin({ ...m, minePlan: { full: built.full, claim: built.claim, occupied: built.occupied, complete: false } })) margin[k] = true
    let sealed = false
    for (const a of lanes) {
      if (laneLeadsOut(a, (x, y) => ground(x, y) && !margin[tkey(x, y)], escape, { under: (x, y) => under(x, y) && !margin[tkey(x, y)], max: LANE_HOP, state })) continue
      sealed = true
      for (const t of laneWayOut(a, ground, escape, hop)!) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keepOut[tkey(t.x + dx, t.y + dy)] = true
    }
    if (!sealed) break
    if (attempt === 1) return strip()
  }
  if (built === undefined) return strip()
  // B33: the whole plan must fit: every claimed tile buildable (trees and rocks as the policy clears them, own
  // structures the layout doesn't hold as D51 evicts them), in the region, untaken, and off other non-mine modules' corridor ring; its output port must have a usable outside tile.
  const ownRect = { x: built.origin.x, y: built.origin.y, w: built.full.footprint.w, h: built.full.footprint.h }
  for (const k of built.claim) {
    const x = keyX(k)
    const y = keyY(k)
    // Own structures the layout doesn't know (bootstrap sites on the patch) are fine: adoption evicts them (D51 (3)).
    const b = terrain.block(x, y)
    if (!rectContains(region, x, y) || taken(x, y)) return strip()
    if (b !== FREE && b !== OWN && !(b === TREE && policy.obstacles.trees === "clear") && !(b === ROCK && policy.obstacles.rocks === "clear")) return strip()
  }
  if (state !== undefined) {
    const ring = inflate(ownRect, policy.corridor.min)
    for (let x = ring.x; x < ring.x + ring.w; x++) {
      for (let y = ring.y; y < ring.y + ring.h; y++) {
        const o = state.occ[tkey(x, y)]
        if (o === undefined || string.sub(o, 1, 2) !== "m:" || o === `m:${m.id}`) continue
        const other = findModule(state, string.sub(o, 3))
        if (other === undefined || !isMining(other.canonical)) return strip()
      }
    }
  }
  const out = built.initial.ports.find((p) => p.id === "out")
  if (out !== undefined) {
    const probe: PlacedModule = { ...m, canonical: built.initial, def: built.initial, transform: IDENTITY, origin: built.origin, rect: ownRect }
    // The route starts on the outside tile and leaves over the approach tile: both must be ground the router can use
    // (own structures there are not evicted for a route; the seed 3333 replay's iron mine faced into its base).
    for (const o of [portOutside(probe, out), portApproach(probe, out)]) {
      const b = terrain.block(o.x, o.y)
      if (taken(o.x, o.y) || (b !== FREE && b !== TREE && b !== ROCK)) return strip()
    }
  }
  m.canonical = built.initial
  m.def = built.initial
  m.transform = IDENTITY
  m.origin = built.origin
  m.rect = ownRect
  m.oreUnits = undefined
  m.minePlan = { full: built.full, claim: built.claim, occupied: built.occupied, complete: false }
}

export function commitPlacement(state: LayoutState, m: PlacedModule, facts: ProtoFacts, policy: LayoutPolicy): void {
  commitModule(state, m, facts, policy.corridor.preferred)
}

// ---------------------------------------------------------------------------------------------------------
// Expansion (LayoutPolicy.expansion): grow a placed module in place along its `expand` axis.

/** A placed module that can take `units` more units of the same kind as `def` (same generator and recipe). */
export function expansionCandidate(state: LayoutState, def: ModuleDef, units: number): PlacedModule | undefined {
  for (const m of state.modules) {
    const c = m.canonical
    if (m.fixed) continue
    if (m.minePlan !== undefined) {
      if (m.minePlan.complete) continue
    } else if (c.expand === undefined || c.expand.maxUnits < units) continue
    if (c.generator === undefined || c.generator !== def.generator) continue
    if (c.recipe !== def.recipe || c.site !== def.site) continue
    if (c.anchor?.resource !== def.anchor?.resource) continue
    return m
  }
  return undefined
}

/** A partial whole-patch mine compatible with a second logical outpost request. */
export function wholePatchCandidate(state: LayoutState, def: ModuleDef): PlacedModule | undefined {
  if (!isMining(def)) return undefined
  for (const m of state.modules) {
    // B23: a built (fixed) mine still counts: completing it adds the planned entities and moves nothing, so it is
    // compatible with `fixed` (never moves). A completed mine has no room left.
    if (m.minePlan === undefined || m.minePlan.complete) continue
    const c = m.canonical
    if (c.generator === def.generator && c.anchor?.resource === def.anchor?.resource) return m
  }
  return undefined
}

function axisCoord(e: ModuleEntity, axis: "x" | "y"): number {
  return axis === "x" ? e.x : e.y
}

/** B25: `tryExpand(..., "head")` refused because the grown layout would run a belt out of the module (`expandHeadModule`). */
export const HEAD_GROWTH_OPENS_BELT = "head growth would leave a belt open at the module edge (B25)"

export interface ExpansionResult {
  ok: boolean
  reason?: string
  /** Ports whose world tile changed: their routes must be rerouted. */
  movedPorts: string[]
  /** Entities removed and re-placed (canonical, pre-growth): see `expandMoves`. */
  moved: ModuleEntity[]
}

/**
 * Grows module `id` by `k` units if the new tiles are free (same rules as placement: terrain, other modules' corridor,
 * routes, ore). `end` picks which side the new units go on: "auto" keeps whichever end moves fewer entities in place
 * (`expandMoves`); "head" grows before 0 (D52/OutpostPlanner: a mine on the edge of an irregular patch grows back
 * toward the ore, not just away from it); "tail" grows past the far end. Commits on success.
 */
/**
 * D55 (user, 2026-10-20): a completed whole-patch mine whose ore is used up claims the next free part of its own patch:
 * a new plan with as many drills (and, point to point, one lane) over the ore left, next to its old output port. It
 * replaces the mine in `state` only if it covers more ore tiles than the mine's drills still reach (else the patch is
 * spent and the caller relocates the mine). Returns why it could not, or undefined.
 */
function reclaimWholePatch(state: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, m: PlacedModule): string | undefined {
  const resource = m.canonical.anchor?.resource
  const drillName = m.canonical.params?.drill
  if (m.minePlan === undefined || resource === undefined || typeof drillName !== "string") return "not a whole-patch mine"
  const drill = facts.entity(drillName)
  const out = m.def.ports.find((p) => p.id === "out")
  if (drill === undefined || out === undefined) return "not a whole-patch mine"
  const near = portOutside(m, out)
  // What the mine's drills still reach (their mining areas, game data).
  const reach = math.ceil(drill.miningRadius ?? math.max(drill.tileW, drill.tileH) / 2)
  const still: Record<number, boolean> = {}
  let have = 0
  const seeds: Vec[] = []
  const box = inflate(m.rect, reach)
  for (let x = box.x; x < box.x + box.w; x++) for (let y = box.y; y < box.y + box.h; y++) if (terrain.ore(x, y) === resource) seeds.push({ x, y })
  for (const e of m.def.entities) {
    if (facts.entity(e.name)?.type !== "mining-drill") continue
    for (let x = math.floor(m.origin.x + e.x - reach); x < m.origin.x + e.x + reach; x++) {
      for (let y = math.floor(m.origin.y + e.y - reach); y < m.origin.y + e.y + reach; y++) {
        const k = tkey(x, y)
        if (still[k] || terrain.ore(x, y) !== resource) continue
        still[k] = true
        have++
      }
    }
  }
  // The whole patch, wherever it reaches (bounded by what the terrain scan knows).
  const all = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }
  const patch = connectedPatch(terrain, resource, seeds, all)
  if (patch === undefined) return `no ${resource} left in its patch`
  unmarkModule(state, m, facts)
  const restore = (why: string): string => {
    markModule(state, m, facts, policy.corridor.preferred)
    return why
  }
  const taken = (x: number, y: number): boolean => {
    const k = tkey(x, y)
    return placementClaimConflict(state, k) !== undefined
  }
  const view: TerrainView = { block: (x, y) => (taken(x, y) ? FOREIGN : terrain.block(x, y)), ore: (x, y) => terrain.ore(x, y) }
  const cap = drillCount(m.minePlan.full, facts)
  // P44 (b): a mine keeps its collector: only a splitter-collector mine takes several rows.
  const collector = m.minePlan.full.params?.collector === "splitter" ? "splitter" : undefined
  const plan = claimPart(planWholePatch(view, patch, drill), view, drill, near, cap, policy.topology === "splitter-tap" && collector !== undefined ? math.huge : 1)
  if (plan.covered.length <= have) return restore(`its patch has no better part left (${plan.covered.length} ore tiles, its drills reach ${have})`)
  const built = materializeMinePlan(m.minePlan.full, plan, facts, near, policy.minOreCoverage, collector)
  if (built === undefined) return restore("no mine fits the rest of its patch")
  for (const k of built.claim) {
    const x = keyX(k)
    const y = keyY(k)
    const b = view.block(x, y)
    if (b !== FREE && b !== OWN && !(b === TREE && policy.obstacles.trees === "clear") && !(b === ROCK && policy.obstacles.rocks === "clear")) return restore(`the new part is blocked at ${x},${y}`)
  }
  const nout = built.full.ports.find((p) => p.id === "out")
  const rect = { x: built.origin.x, y: built.origin.y, w: built.full.footprint.w, h: built.full.footprint.h }
  if (nout !== undefined) {
    const probe: PlacedModule = { ...m, canonical: built.full, def: built.full, transform: IDENTITY, origin: built.origin, rect }
    for (const o of [portOutside(probe, nout), portApproach(probe, nout)]) {
      const b = view.block(o.x, o.y)
      if (b !== FREE && b !== TREE && b !== ROCK) return restore(`the new part's output is blocked at ${o.x},${o.y}`)
    }
  }
  m.canonical = built.full
  m.def = built.full
  m.transform = IDENTITY
  m.origin = built.origin
  m.rect = rect
  m.oreUnits = undefined
  m.minePlan = { full: built.full, claim: built.claim, occupied: [...built.claim], complete: true }
  markModule(state, m, facts, policy.corridor.preferred)
  return undefined
}

/** B74: route `rid` carries mine `mine`'s output: it starts at the mine, or taps a route that does. */
function fromMine(state: LayoutState, rid: string, mine: string): boolean {
  let r: Route | undefined = state.routes[rid]
  for (let hop = 0; r !== undefined && hop < 8; hop++) {
    if (r.from?.module === mine) return true
    r = r.tapOf !== undefined ? state.routes[r.tapOf] : undefined
  }
  return false
}

export function tryExpand(state: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, id: string, k: number, end: "auto" | "head" | "tail" = "auto", reclaim = false): ExpansionResult {
  const m = findModule(state, id)
  if (m === undefined) return { ok: false, reason: "unknown module", movedPorts: [], moved: [] }
  if (reclaim) {
    const why = reclaimWholePatch(state, terrain, facts, policy, m)
    return why === undefined ? { ok: true, movedPorts: [], moved: [] } : { ok: false, reason: why, movedPorts: [], moved: [] }
  }
  if (m.minePlan !== undefined) {
    if (m.minePlan.complete || k < 1) return { ok: false, reason: "whole-patch mine is already complete", movedPorts: [], moved: [] }
    const current: Record<string, boolean> = {}
    for (const e of m.def.entities) current[string.format("%s@%g,%g:%g", e.name, e.x, e.y, e.dir ?? 0)] = true
    // B23: completion re-checks geometry (terrain, other modules, routes) but not ore: the patch was validated whole
    // at planning time, and between planning and completion the terrain can only lose ore (mining) — a drill over
    // depleted ground idles and the mine's depletion handling deals with it. (The captured g10 full plan even
    // contains drills whose mining rect touches the adjacent coal and copper patches, so a completion-time B6 check
    // would be stricter than the planning-time one that accepted them.)
    // B55: the tile its output route starts on is never the mine's, whatever B25 lets give way (a full plan made
    // before the fix could put a pole there).
    const fullOut = m.minePlan.full.ports.find((p) => p.id === "out")
    const outside = fullOut !== undefined ? portOutside(m, fullOut) : undefined
    for (const e of m.minePlan.full.entities) {
      if (current[string.format("%s@%g,%g:%g", e.name, e.x, e.y, e.dir ?? 0)]) continue
      const er = entityRect(e, facts)
      if (outside !== undefined && outside.x >= m.origin.x + er.x && outside.x < m.origin.x + er.x + er.w && outside.y >= m.origin.y + er.y && outside.y < m.origin.y + er.y + er.h)
        return { ok: false, reason: `planned mine covers its output at ${outside.x},${outside.y}`, movedPorts: [], moved: [] }
      for (let x = m.origin.x + er.x; x < m.origin.x + er.x + er.w; x++) {
        for (let y = m.origin.y + er.y; y < m.origin.y + er.y + er.h; y++) {
          const kk = tkey(x, y)
          const b = terrain.block(x, y)
          // B24: the mine's own D52 footprint is reserved — the adoption reserves the whole rect plus 1 ring and the
          // plan's claim is the mine's own — so those tiles read as OWN for a later request, but they are exactly
          // what the completion builds. Only a ground someone else reserved (or raw obstacles) still blocks.
          const own = state.mine?.[kk] === m.id || rectContains(m.rect, x, y)
          if (b !== FREE && b !== TREE && b !== ROCK && !(b === OWN && own)) return { ok: false, reason: `planned mine blocked at ${x},${y}`, movedPorts: [], moved: [] }
          const o = state.occ[kk]
          // B25: pole lines placed before the mine's claim, and the faction's own earlier routes, can stand on its
          // still unbuilt plan tiles (the plan is authored on a fixed grid and the claim only reserves free tiles).
          // The completion build picks those own structures up first and the reconcile layer re-routes the edge that
          // the rip breaks, so neither blocks a completion.
          // B37: pole lines anywhere on the new ground give way (markModule evicts them; the plan re-poles).
          if (o !== undefined && o !== `m:${m.id}` && o !== `x:${m.id}` && !isPoleTag(o) && !(own && string.sub(o as string, 1, 6) === "route:")) return { ok: false, reason: `planned mine occupied at ${x},${y}`, movedPorts: [], moved: [] }
          // B25: own earlier routes on the mine's own unbuilt tiles give way (the completion build picks their
          // belts up and reconcile re-routes the broken edge).
          const rid = state.routeOcc[kk]
          if (rid !== undefined && !own) return { ok: false, reason: `planned mine route at ${x},${y}`, movedPorts: [], moved: [] }
          // B74 (soak vps-d67 seed 7718665): B55 for the whole output route, not just its first tile. The mine's own
          // output belt ran west along its unbuilt top row; the completion put a pole on its second tile and picked the
          // belt up. With the mine backed up nothing measured the break, and three science clusters starved 150 min.
          if (rid !== undefined && fromMine(state, rid, m.id)) return { ok: false, reason: `planned mine covers its own output route at ${x},${y}`, movedPorts: [], moved: [] }
        }
      }
    }
    unmarkModule(state, m, facts)
    m.canonical = m.minePlan.full
    m.def = m.minePlan.full
    m.minePlan.complete = true
    m.minePlan.occupied = [...m.minePlan.claim]
    markModule(state, m, facts, policy.corridor.preferred)
    return { ok: true, movedPorts: [], moved: [] }
  }
  const canon = m.canonical
  const spec = canon.expand
  if (spec === undefined || k < 1 || k > spec.maxUnits) return { ok: false, reason: "cannot expand by that much", movedPorts: [], moved: [] }
  const grown = end === "head" ? expandHeadModule(canon, k, facts) : expandModule(canon, k, facts)
  if (grown === undefined) return { ok: false, reason: HEAD_GROWTH_OPENS_BELT, movedPorts: [], moved: [] }
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  // Which end stays put. "head" growth keeps the far end (largest coordinate) in place; otherwise `expandMoves` decides.
  let headMoves: boolean
  let anchor: ModuleEntity | undefined
  if (end === "head") {
    headMoves = true
    let best = -1
    for (const e of canon.entities) {
      const c = axisCoord(e, spec.axis)
      if (c > best) { best = c; anchor = e }
    }
  } else {
    const moves = expandMoves(canon, k)
    headMoves = end === "tail" ? false : (moves.originShift.x !== 0 || moves.originShift.y !== 0)
    for (const e of canon.entities) {
      const tail = axisCoord(e, spec.axis) >= spec.insertAt
      if (tail === headMoves) { anchor = e; break }
    }
  }
  if (anchor === undefined) return { ok: false, reason: "no fixed entity", movedPorts: [], moved: [] }
  const grownAnchor = headMoves ? (spec.axis === "x" ? { x: anchor.x + k * size, y: anchor.y } : { x: anchor.x, y: anchor.y + k * size }) : anchor
  const pOld = transformPoint(anchor, canon.footprint.w, canon.footprint.h, m.transform)
  const pNew = transformPoint(grownAnchor, grown.footprint.w, grown.footprint.h, m.transform)
  const placed = m.transform.rot === 0 && !m.transform.mirror ? grown : transformModule(grown, m.transform)
  const origin = { x: m.origin.x + pOld.x - pNew.x, y: m.origin.y + pOld.y - pNew.y }
  const rect = { x: origin.x, y: origin.y, w: placed.footprint.w, h: placed.footprint.h }
  const mining = isMining(canon)
  const ownTags: Record<string, boolean> = { [`m:${m.id}`]: true, [`x:${m.id}`]: true }
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      if (rectContains(m.rect, x, y)) continue
      const kk = tkey(x, y)
      const b = terrain.block(x, y)
      if (b !== FREE && !(b === TREE && policy.obstacles.trees === "clear") && !(b === ROCK && policy.obstacles.rocks === "clear")) return { ok: false, reason: `blocked at ${x},${y}`, movedPorts: [], moved: [] }
      const c = moduleGrowthClaimConflict(state, kk, m.id)
      // B37: a pole line on the new ground gives way (markModule evicts it; the growth re-poles).
      if (c !== undefined) {
        const why = c.code === "occupied" ? "occupied" : c.code === "routed" ? "route" : c.code === "mine-claimed" ? `mine claim of ${c.claim.owner}` : "reserved"
        return { ok: false, reason: `${why} at ${x},${y}`, movedPorts: [], moved: [] }
      }
      if (policy.protectOre && !mining && terrain.ore(x, y) !== undefined) return { ok: false, reason: `ore at ${x},${y}`, movedPorts: [], moved: [] }
    }
  }
  if (mining) {
    // B6: every grown drill's mining area must not reach a second ore (or another faction's field, D46).
    const resource = canon.anchor?.resource
    for (const a of placed.anchor?.miningAreas ?? []) {
      for (let x = origin.x + a.x; x < origin.x + a.x + a.w; x++) {
        for (let y = origin.y + a.y; y < origin.y + a.y + a.h; y++) {
          const ore = terrain.ore(x, y)
          if (ore !== undefined && ore !== resource) return { ok: false, reason: `foreign ore ${ore} at ${x},${y}`, movedPorts: [], moved: [] }
        }
      }
    }
    // A depleted outpost is expected to have old drills on worked-out ground. Only the drills added by this growth
    // need resource; otherwise depletion could never be remedied in place (M6a.2, seed 222). B33: under the drill
    // itself (the whole-patch plan's test), not just somewhere in its mining area: a strip growing on a drill that
    // only grazes the patch edge is growth off the patch.
    for (let i = 0; i < k; i++) {
      for (const e of spec.unit.entities) {
        const f = facts.entity(e.name)
        if (f?.type !== "mining-drill") continue
        const offset = end === "head" ? i * size : spec.insertAt + i * size
        const er = entityRect(e, facts)
        const local = spec.axis === "x" ? { x: er.x + offset, y: er.y, w: er.w, h: er.h } : { x: er.x, y: er.y + offset, w: er.w, h: er.h }
        const r = transformRect(local, grown.footprint.w, grown.footprint.h, m.transform)
        const x1 = origin.x + r.x
        const y1 = origin.y + r.y
        let mine = false
        for (let x = x1; x < x1 + r.w; x++) for (let y = y1; y < y1 + r.h; y++) if (terrain.ore(x, y) === resource) mine = true
        if (!mine) return { ok: false, reason: `no ${resource} under a drill at ${x1},${y1}`, movedPorts: [], moved: [] }
      }
    }
  }
  const ring = inflate(rect, policy.corridor.min)
  for (let x = ring.x; x < ring.x + ring.w; x++) {
    for (let y = ring.y; y < ring.y + ring.h; y++) {
      const o = state.occ[tkey(x, y)]
      if (o !== undefined && string.sub(o, 1, 2) === "m:" && !ownTags[o]) {
        const other = findModule(state, string.sub(o, 3))
        // Mining outposts intentionally cluster on one patch. Their footprints still cannot overlap (checked above),
        // but a mine's corridor ring may touch another mine while it fills the preplanned patch footprint.
        if (!mining || other === undefined || !isMining(other.canonical)) return { ok: false, reason: `too close to ${o}`, movedPorts: [], moved: [] }
      }
    }
  }
  const before: Record<string, Vec> = {}
  for (const p of m.def.ports) before[p.id] = portTile(m, p)
  const grownPlaced: PlacedModule = { ...m, canonical: grown, def: placed, origin, rect }
  // New port outside tiles must be usable.
  for (const p of placed.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = portOutside(grownPlaced, p)
    const occ = state.occ[tkey(o.x, o.y)]
    if (occ !== undefined && !ownTags[occ] && !isPoleTag(occ)) return { ok: false, reason: `port ${p.id} outside tile occupied`, movedPorts: [], moved: [] }
    const b = terrain.block(o.x, o.y)
    if (b === WATER || b === CLIFF || b === UNKNOWN || b === OWN || b === FOREIGN) return { ok: false, reason: `port ${p.id} outside tile blocked`, movedPorts: [], moved: [] }
  }
  unmarkModule(state, m, facts)
  m.canonical = grown
  m.def = placed
  m.origin = origin
  m.rect = rect
  // B33: a strip mine's growth claim keeps stopping where its ore ends.
  if (mining && m.oreUnits !== undefined) m.oreUnits = stripOreUnits(m, terrain, facts)
  markModule(state, m, facts, policy.corridor.preferred)
  const movedPorts: string[] = []
  for (const p of m.def.ports) {
    const now = portTile(m, p)
    const was = before[p.id]
    if (was === undefined || was.x !== now.x || was.y !== now.y) movedPorts.push(p.id)
  }
  // Forced head growth keeps every existing entity in place; forced tail growth moves the canonical tail. Auto keeps
  // the original minimum-movement behaviour.
  const moved = end === "auto" ? expandMoves(canon, k).moved : end === "head" ? [] : expandTail(canon)
  return { ok: true, movedPorts, moved }
}
