// Module placement on real terrain (SPEC §5.3): choose an origin and a rotation/mirror for a module instance so it is
// compact (packing strategy of the LayoutPolicy), its ports face where their connections come from, it respects the
// obstacle map (water, cliffs, structures, ore we need, trees and rocks at a clearing cost) and its site (`shore`: the
// anchor's water tiles are water; `resource-patch`: the drills' mining areas cover the resource).
//
// Resumable and budgeted: `stepPlacement` builds summed-area tables over a search window row by row, then scores
// candidates (every transform × origin within the radius) in O(1) each. Radii grow (policy.searchRadii) until one
// candidate is feasible. Pure: no Factorio globals.

import { expandModule, expandMoves } from "../modules/build"
import { ProtoFacts } from "../modules/facts"
import { transformModule, transformPoint, Transform } from "../modules/geometry"
import { ModuleDef, ModuleEntity } from "../modules/types"
import { CLIFF, DX, DY, FOREIGN, FREE, inflate, manhattan, OWN, Rect, rectContains, ROCK, TerrainView, tkey, TREE, UNKNOWN, Vec, WATER } from "./grid"
import { commitModule, findModule, LayoutState, markModule, PlacedModule, portOutside, portTile, unmarkModule } from "./layout"
import { CandidateFeatures, LayoutPolicy, packingScorer } from "./policy"

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
  target?: Vec
  radiusIdx: number
  tdefs: TDef[]
  /** Window (world) and the summed-area tables over it, (w + 1) × (h + 1). */
  wx: number
  wy: number
  ww: number
  wh: number
  row: number
  sat: Record<string, number[]>
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
  result?: PlacedModule
}

const LAYERS = ["hard", "ore", "clear", "water", "mods", "res", "soft"]

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
  }
}

const TOP_K = 3

/** Whether a tile is a site point: water with land next to it (shore), or ore of the resource. */
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
  if (s.req.def.site !== "resource-patch") return policy.searchRadii
  const last = policy.searchRadii[policy.searchRadii.length - 1] ?? 0
  return last >= OUTPOST_FAR_RADIUS ? policy.searchRadii : [...policy.searchRadii, OUTPOST_FAR_RADIUS]
}

function maxDim(s: PlacementSearch): number {
  let m = 0
  for (const td of s.tdefs) m = math.max(m, td.def.footprint.w, td.def.footprint.h)
  return m
}

function startWindow(s: PlacementSearch, policy: LayoutPolicy): void {
  const R = radii(s, policy)[s.radiusIdx]
  const M = maxDim(s) + policy.corridor.preferred + 4
  const t = s.target!
  s.wx = math.max(t.x - R - M, s.req.region.x)
  s.wy = math.max(t.y - R - M, s.req.region.y)
  s.ww = math.min(t.x + R + M, s.req.region.x + s.req.region.w) - s.wx
  s.wh = math.min(t.y + R + M, s.req.region.y + s.req.region.h) - s.wy
  s.row = 0
  s.sat = {}
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
  const aHard = s.sat.hard
  const aOre = s.sat.ore
  const aClear = s.sat.clear
  const aWater = s.sat.water
  const aMods = s.sat.mods
  const aRes = s.sat.res
  const aSoft = s.sat.soft
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
  const base = (s.row + 1) * W
  const prev = base - W
  aHard[base] = 0
  aOre[base] = 0
  aClear[base] = 0
  aWater[base] = 0
  aMods[base] = 0
  aRes[base] = 0
  aSoft[base] = 0
  for (let i = 0; i < s.ww; i++) {
    const x = s.wx + i
    const k = tkey(x, y)
    const b = terrain.block(x, y)
    const o = occ[k]
    if (b >= OWN || (b === TREE && treeHard) || (b === ROCK && rockHard) || o !== undefined || reserved[k] !== undefined || routeOcc[k] !== undefined || (mine[k] !== undefined && mine[k] !== s.req.id)) hard++
    const ore = terrain.ore(x, y)
    if (ore !== undefined) {
      ores++
      if (ore === resource) res++
    }
    if (b === TREE) clear += clearTree
    else if (b === ROCK) clear += clearRock
    else if (b === WATER) water++
    if (o !== undefined && string.sub(o, 1, 2) === "m:") mods++
    if (softTiles !== undefined && softTiles[k] !== undefined && !exempt[softTiles[k]]) soft++
    const j = base + i + 1
    const p = prev + i + 1
    aHard[j] = aHard[p] + hard
    aOre[j] = aOre[p] + ores
    aClear[j] = aClear[p] + clear
    aWater[j] = aWater[p] + water
    aMods[j] = aMods[p] + mods
    aRes[j] = aRes[p] + res
    aSoft[j] = aSoft[p] + soft
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

function evaluate(s: PlacementSearch, policy: LayoutPolicy, td: TDef, ox: number, oy: number): { score: number; coverage: number; clear: number } | undefined {
  const def = td.def
  const rect = { x: ox, y: oy, w: def.footprint.w, h: def.footprint.h }
  if (!rectContains(s.req.region, rect.x, rect.y) || !rectContains(s.req.region, rect.x + rect.w - 1, rect.y + rect.h - 1)) return undefined
  if (sum(s, "hard", rect) !== 0) return undefined
  for (const a of s.req.avoid ?? []) if (rect.x < a.x + a.w && a.x < rect.x + rect.w && rect.y < a.y + a.h && a.y < rect.y + rect.h) return undefined
  const mining = isMining(def)
  if (policy.protectOre && !mining && sum(s, "ore", rect) !== 0) return undefined
  if (sum(s, "mods", inflate(rect, policy.corridor.min)) !== 0) return undefined
  const clear = sum(s, "clear", rect)!
  if (clear > policy.obstacles.maxClearCost) return undefined
  if (def.site === "shore") {
    for (const w of def.anchor?.water ?? []) {
      const wr = { x: ox + w.x, y: oy + w.y, w: w.w, h: w.h }
      if (sum(s, "water", wr) !== w.w * w.h) return undefined
    }
  }
  let coverage = 1
  if (mining) {
    let have = 0
    let all = 0
    for (const a of def.anchor?.miningAreas ?? []) {
      const area = { x: ox + a.x, y: oy + a.y, w: a.w, h: a.h }
      const n = sum(s, "res", area)
      if (n === undefined || n < policy.minOreCoverage * a.w * a.h) return undefined
      // B6: a drill mines every ore in its area; a second ore would clog the single-item line (D23).
      if (sum(s, "ore", area)! !== n) return undefined
      have += n
      all += a.w * a.h
    }
    coverage = all > 0 ? have / all : 1
  }
  let portDist = 0
  let facingAway = 0
  for (const p of td.ports) {
    const x = ox + p.ox
    const y = oy + p.oy
    if (sum(s, "hard", { x, y, w: 1, h: 1 }) !== 0) return undefined
    // Port clearance: the tile beyond the outside tile is not another module or blocked, so the port has a lane out.
    if (sum(s, "hard", { x: x + p.nx, y: y + p.ny, w: 1, h: 1 }) !== 0 || sum(s, "mods", { x: x + p.nx, y: y + p.ny, w: 1, h: 1 }) !== 0) return undefined
    if (policy.protectOre && sum(s, "ore", { x, y, w: 1, h: 1 }) !== 0 && !mining) portDist += policy.router.oreTile
    const t = s.req.targets[p.id]
    if (t === undefined) continue
    portDist += math.abs(t.x - x) + math.abs(t.y - y)
    if (p.nx * (t.x - x) + p.ny * (t.y - y) < 0) facingAway++
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
    softClaim: sum(s, "soft", rect) ?? 0,
  }
  return { score: packingScorer(policy.packing)(f, policy), coverage, clear }
}

/** Advances a placement search by about `budget` work units. Returns the work used. */
export function stepPlacement(s: PlacementSearch, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  let used = 0
  while (used < budget && (s.phase === "site" || s.phase === "sat" || s.phase === "scan")) {
    if (s.phase === "site") {
      // Ring by ring around the centre: the nearest shore tile or ore tile of the resource.
      const c = s.req.center
      const r = s.ring
      const maxR = math.max(s.req.region.w, s.req.region.h)
      if (r > maxR) {
        s.phase = "failed"
        s.reason = `no ${s.req.def.site} site in the region`
        break
      }
      let found: Vec | undefined
      for (let x = c.x - r; x <= c.x + r && found === undefined; x++) {
        for (const y of r === 0 ? [c.y] : [c.y - r, c.y + r]) if (found === undefined && sitePoint(s.req.def, terrain, x, y)) found = { x, y }
      }
      for (let y = c.y - r + 1; y <= c.y + r - 1 && found === undefined && r > 0; y++) {
        for (const x of [c.x - r, c.x + r]) if (found === undefined && sitePoint(s.req.def, terrain, x, y)) found = { x, y }
      }
      used += math.max(1, r) / 2
      s.ring++
      if (found !== undefined) {
        s.target = found
        startWindow(s, policy)
      }
      continue
    }
    if (s.phase === "sat") {
      if (s.ww <= 0 && s.row === 0 && s.sat.hard === undefined) startWindow(s, policy)
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
        const e = evaluate(s, policy, s.tdefs[c.ti], c.ox, c.oy)
        s.candidates = (s.candidates ?? 0) + 1
        if (e !== undefined && (s.best === undefined || e.score < s.best.score - 1e-9)) s.best = { score: e.score, ti: c.ti, ox: c.ox, oy: c.oy, coverage: e.coverage, clear: e.clear }
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
          id: s.req.id,
          canonical: s.req.def,
          def: td.def,
          transform: td.t,
          origin: { x: s.best.ox, y: s.best.oy },
          rect: { x: s.best.ox, y: s.best.oy, w: td.def.footprint.w, h: td.def.footprint.h },
        }
        s.result = m
        s.phase = "done"
      } else if (s.radiusIdx + 1 < radii(s, policy).length) {
        s.radiusIdx++
        startWindow(s, policy)
      } else {
        s.phase = "failed"
        s.reason = "no feasible position"
      }
      continue
    }
    const td = s.tdefs[s.ti]
    const t = s.target!
    const cx = (s.ci % n) * s.stride
    const cy = math.floor(s.ci / n) * s.stride
    const ox = t.x - R + cx - math.floor(td.def.footprint.w / 2)
    const oy = t.y - R + cy - math.floor(td.def.footprint.h / 2)
    const e = evaluate(s, policy, td, ox, oy)
    s.candidates = (s.candidates ?? 0) + 1
    if (e !== undefined) {
      if (s.best === undefined || e.score < s.best.score - 1e-9) s.best = { score: e.score, ti: s.ti, ox, oy, coverage: e.coverage, clear: e.clear }
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

/** Places synchronously (tests, tools). */
export function placeNow(req: PlacementRequest, state: LayoutState, terrain: TerrainView, policy: LayoutPolicy): PlacementSearch {
  const s = newPlacement(req)
  while (s.phase !== "done" && s.phase !== "failed") stepPlacement(s, state, terrain, policy, 1e9)
  return s
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
    if (m.fixed || c.expand === undefined || c.expand.maxUnits < units) continue
    if (c.generator === undefined || c.generator !== def.generator) continue
    if (c.recipe !== def.recipe || c.site !== def.site) continue
    if (c.anchor?.resource !== def.anchor?.resource) continue
    return m
  }
  return undefined
}

function axisCoord(e: ModuleEntity, axis: "x" | "y"): number {
  return axis === "x" ? e.x : e.y
}

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
 * routes, ore). Keeps whichever end moves fewer entities in place (`expandMoves`). Commits on success.
 */
export function tryExpand(state: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, id: string, k: number): ExpansionResult {
  const m = findModule(state, id)
  if (m === undefined) return { ok: false, reason: "unknown module", movedPorts: [], moved: [] }
  const canon = m.canonical
  const spec = canon.expand
  if (spec === undefined || k < 1 || k > spec.maxUnits) return { ok: false, reason: "cannot expand by that much", movedPorts: [], moved: [] }
  const grown = expandModule(canon, k, facts)
  const moves = expandMoves(canon, k)
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const headMoves = moves.originShift.x !== 0 || moves.originShift.y !== 0
  // An entity that stays put: a head entity if the tail moves, a tail entity if the head moves.
  let anchor: ModuleEntity | undefined
  for (const e of canon.entities) {
    const tail = axisCoord(e, spec.axis) >= spec.insertAt
    if (tail === headMoves) {
      anchor = e
      break
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
      const o = state.occ[kk]
      if (o !== undefined && !ownTags[o]) return { ok: false, reason: `occupied at ${x},${y}`, movedPorts: [], moved: [] }
      if (state.routeOcc[kk] !== undefined) return { ok: false, reason: `route at ${x},${y}`, movedPorts: [], moved: [] }
      const mo = state.mine?.[kk]
      if (mo !== undefined && mo !== m.id) return { ok: false, reason: `mine claim of ${mo} at ${x},${y}`, movedPorts: [], moved: [] }
      const r = state.reserved[kk]
      if (r !== undefined && string.sub(r, 1, 3 + string.len(m.id)) !== `p:${m.id}.`) return { ok: false, reason: `reserved at ${x},${y}`, movedPorts: [], moved: [] }
      if (policy.protectOre && !mining && terrain.ore(x, y) !== undefined) return { ok: false, reason: `ore at ${x},${y}`, movedPorts: [], moved: [] }
    }
  }
  if (mining) {
    // B6: the grown drills' mining areas must not reach a second ore (or another faction's field, D46).
    const resource = canon.anchor?.resource
    for (const a of placed.anchor?.miningAreas ?? []) {
      // M6a.2 (seed 222): a drill with none of its ore in reach can't be placed at all (worked-out ground).
      let mine = false
      for (let x = origin.x + a.x; x < origin.x + a.x + a.w; x++) {
        for (let y = origin.y + a.y; y < origin.y + a.y + a.h; y++) {
          const ore = terrain.ore(x, y)
          if (ore !== undefined && ore !== resource) return { ok: false, reason: `foreign ore ${ore} at ${x},${y}`, movedPorts: [], moved: [] }
          if (ore === resource) mine = true
        }
      }
      if (!mine) return { ok: false, reason: `no ${resource} under a drill at ${origin.x + a.x},${origin.y + a.y}`, movedPorts: [], moved: [] }
    }
  }
  const ring = inflate(rect, policy.corridor.min)
  for (let x = ring.x; x < ring.x + ring.w; x++) {
    for (let y = ring.y; y < ring.y + ring.h; y++) {
      const o = state.occ[tkey(x, y)]
      if (o !== undefined && string.sub(o, 1, 2) === "m:" && !ownTags[o]) return { ok: false, reason: `too close to ${o}`, movedPorts: [], moved: [] }
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
    if (occ !== undefined && !ownTags[occ]) return { ok: false, reason: `port ${p.id} outside tile occupied`, movedPorts: [], moved: [] }
    const b = terrain.block(o.x, o.y)
    if (b === WATER || b === CLIFF || b === UNKNOWN || b === OWN || b === FOREIGN) return { ok: false, reason: `port ${p.id} outside tile blocked`, movedPorts: [], moved: [] }
  }
  unmarkModule(state, m, facts)
  m.canonical = grown
  m.def = placed
  m.origin = origin
  m.rect = rect
  markModule(state, m, facts, policy.corridor.preferred)
  const movedPorts: string[] = []
  for (const p of m.def.ports) {
    const now = portTile(m, p)
    const was = before[p.id]
    if (was === undefined || was.x !== now.x || was.y !== now.y) movedPorts.push(p.id)
  }
  return { ok: true, movedPorts, moved: moves.moved }
}
