// The planner's layout state: placed module instances, their reserved tiles and the routed belts (SPEC §5.3). It is an
// overlay on the terrain model (grid.ts): the router and placement read both. Plain tables, so it lives in `storage`.
// Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import { portOutsideTile, Transform, transformRect } from "../modules/geometry"
import { rateOf, rotateVec } from "../modules/rates"
import { ModuleDef, Port } from "../modules/types"
import type { ConnectionId, LayoutClaimTag, ModuleId, PoleId, PoleLineId, RouteId } from "../shared/ids"
import { claimInteractionTile, claimMineTile, claimModuleTile, claimRouteTile, claimSoftTile, releaseInteractionTile, releaseMineClaims, releaseModuleTile, releasePoleTile, releaseReservation, releaseRouteTile, releaseSoftClaims, reserveFreeTile, reserveTile } from "./claims"
import { isPoleTag, moduleTag, poleTag, portTag } from "./claim-tags"
import { CLIFF, DX, DY, FOREIGN, keyX, keyY, OWN, Rect, rectContains, TerrainView, tkey, UNKNOWN, Vec, WATER } from "./grid"

export { isPoleTag, portTag }
/** Re-exported for the strategy layer, which already imports this module as a namespace. */
export { releasePoleTile }

export interface PlacedModule {
  /** Instance id (unique in the layout). */
  id: ModuleId
  /** The module in its canonical orientation (for expansion), and as placed (transformed, module-local). */
  canonical: ModuleDef
  def: ModuleDef
  transform: Transform
  /** World tile of the placed module's top-left corner. */
  origin: Vec
  /** World footprint. */
  rect: Rect
  /** Built already (routes to it may not be ripped... and it never moves). */
  fixed?: boolean
  /** D52: immutable whole-patch design; `def` is partial or complete, while `claim` is reserved up front. */
  minePlan?: { full: ModuleDef; claim: number[]; occupied: number[]; complete: boolean }
  /**
   * B33: a strip mine without a whole-patch plan (its plan did not fit): how many more growth units still put every
   * new drill on its ore. Its growth area (and so its hard claim) stops there instead of running the belt-limited
   * `expand.maxUnits` off the patch. Absent: not known (older saves, non-mines): `maxUnits`.
   */
  oreUnits?: number
}

export interface PortRef {
  module: string
  port: string
}

/** One piece of a route. `dir` is a direction index (0..3 = N, E, S, W). */
export interface RouteStep {
  kind: "belt" | "ug-in" | "ug-out" | "splitter"
  x: number
  y: number
  dir: number
  /** Splitter: the second tile (the first, x/y, is the tapped route's belt, which the splitter replaces). */
  x2?: number
  y2?: number
}

export interface UgSpan {
  /** Line coordinate range (inclusive) along the axis. */
  a: number
  b: number
  route: string
}

export interface Route {
  id: RouteId
  /** Connection id this route serves. */
  conn: ConnectionId
  item: string
  from?: PortRef
  to: PortRef
  steps: RouteStep[]
  /** Heading items enter the first step with (the producer port's direction). */
  startDir?: number
  /** Tiles this route occupies (belts, underground ends, a splitter's second tile, a side-load blocker). */
  tiles: number[]
  spans: { line: string; span: UgSpan }[]
  /** Splitter tap: the route whose belt the splitter replaces. */
  tapOf?: RouteId
  belt: string
  underground: string
  splitter: string
  /** Belt tiles + underground ends (entities placed). */
  length: number
  undergrounds: number
  cost: number
  /** A one-tile stub into an input port fed from outside the layout (crew or another faction plan). */
  external?: boolean
  /** Side-loading: the unfed belt behind the port tile that makes the arrival a side-load, not a curve. */
  blocker?: RouteStep
  /** B60 provider-group merge: the existing belt this route side-loads into, instead of the consumer port. */
  merge?: { x: number; y: number; dir: number; side: "left" | "right" }
  /**
   * Provider-group merge through a splitter: the trunk tile it replaces (`x`,`y`, owned by the other route) and its
   * second tile (`x2`,`y2`, owned by this route). Used where a side-load is impossible: the trunk tile is a curve, an
   * underground or already a splitter. The trunk's second output lane is left unconnected, so it backs up and the
   * splitter feeds everything into the trunk.
   */
  mergeSplitter?: { x: number; y: number; dir: number; x2: number; y2: number }
  /** Times ripped up. */
  ripped: number
  /** Built already (part of the faction's base): never ripped up. */
  fixed?: boolean
}

/** A planned pole between modules (world tile; the entity sits at its centre). See power.ts. */
export interface PlannedPole {
  id: PoleId
  name: string
  x: number
  y: number
  /** The pole line (network edge) it belongs to. */
  line: PoleLineId
}

/** One edge of the pole network: poles from a powered component to a module. */
export interface PoleLine {
  id: PoleLineId
  /** The module joined to the network, and the owner of the powered pole it was joined from. */
  to: ModuleId
  from: string
  poles: PoleId[]
}

export interface LayoutState {
  /**
   * Monotonic logical-layout revision. Old saves/captures have no revision and read as 0 through `layoutRevision`.
   * Planner copies preserve it; every mutation through this module advances it. Runtime owners can therefore detect
   * that an intent was planned against an older layout instead of silently executing a stale copy.
   */
  revision?: number
  modules: PlacedModule[]
  /** Module footprints ("m:<id>") and tiles module entities interact with outside their footprint ("x:<id>"). */
  occ: Record<number, LayoutClaimTag>
  /** Port outside tiles ("p:<module>.<port>"): only the route of that port may use them. */
  reserved: Record<number, LayoutClaimTag>
  /** Route tiles → route id. */
  routeOcc: Record<number, RouteId>
  /** Reserved routing corridors around modules (routes prefer them; other modules stay out of `corridor.min`). */
  corridor: Record<number, boolean>
  /**
   * B9 soft claims (D48 (4)): tiles an expandable module (`ModuleDef.expand`) can still grow into, up to its unit cap →
   * that module's id. Placement and routing pay a cost there (policy weights), nothing blocks.
   */
  soft?: Record<number, ModuleId>
  /**
   * B52: the growth unit a soft-claimed tile belongs to (0: the unit next to the module). Routes pay less for each unit
   * farther out (`softClaimDecay`). Absent (a mine's claim, a layout from before B52): unit 0.
   */
  softUnit?: Record<number, number>
  /**
   * D52 (3): a mining outpost's planned room to grow (its growth area: tile → outpost id) is a hard claim: no other
   * module, no other module's route and no pole may take it (the user saw poles block mine expansion).
   */
  mine?: Record<number, ModuleId>
  /** Underground spans per line ("h<y>" or "v<x>"). */
  spans: Record<string, UgSpan[]>
  routes: Record<string, Route>
  routeOrder: RouteId[]
  /** Poles between modules (power.ts), occupying `occ` tiles tagged "x:<line>". */
  poles?: PlannedPole[]
  poleLines?: PoleLine[]
  /**
   * B37: poles of lines that a module, route or growth took the ground of (`evictPoleLines`). The adoption picks them
   * up; the plan's pole step (or the growth's) joins what they powered again.
   */
  evictedPoles?: PlannedPole[]
}

/**
 * B37: removes every pole line with a pole on one of `keys` (the whole line: a line with a gap joins nothing). Its poles
 * go to `evictedPoles`. Returns the removed line ids.
 */
export function evictPoleLines(state: LayoutState, keys: number[]): string[] {
  if (state.poles === undefined || state.poles.length === 0) return []
  const drop: Record<string, boolean> = {}
  const lines: string[] = []
  for (const k of keys) {
    const o = state.occ[k]
    if (!isPoleTag(o)) continue
    const line = string.sub(o!, 3)
    if (drop[line]) continue
    drop[line] = true
    lines.push(line)
  }
  if (lines.length === 0) return []
  const kept: PlannedPole[] = []
  state.evictedPoles ??= []
  for (const p of state.poles) {
    if (!drop[p.line]) {
      kept.push(p)
      continue
    }
    const k = tkey(p.x, p.y)
    releasePoleTile(state, k, p.line)
    state.evictedPoles.push(p)
  }
  state.poles = kept
  state.poleLines = (state.poleLines ?? []).filter((l) => !drop[l.id])
  if (lines.length > 0) bumpLayout(state)
  return lines
}

export function newLayout(): LayoutState {
  return { revision: 0, modules: [], occ: {}, reserved: {}, routeOcc: {}, corridor: {}, spans: {}, routes: {}, routeOrder: [] }
}

/** Compatible revision read for layouts stored before revisions existed. */
export function layoutRevision(state: LayoutState): number {
  return state.revision ?? 0
}

/** Records one completed logical-layout mutation. */
export function bumpLayout(state: LayoutState): number {
  state.revision = layoutRevision(state) + 1
  return state.revision
}

export function findModule(state: LayoutState, id: string): PlacedModule | undefined {
  for (const m of state.modules) if (m.id === id) return m
  return undefined
}

export function findPort(m: PlacedModule, id: string): Port | undefined {
  for (const p of m.def.ports) if (p.id === id) return p
  return undefined
}

/** World tile (integer, top-left) of a port's own tile and of its outside tile. */
export function portTile(m: PlacedModule, p: Port): Vec {
  return { x: m.origin.x + math.floor(p.pos.x), y: m.origin.y + math.floor(p.pos.y) }
}

export function portOutside(m: PlacedModule, p: Port): Vec {
  const o = portOutsideTile(p)
  return { x: m.origin.x + math.floor(o.x), y: m.origin.y + math.floor(o.y) }
}

/** A port's planned rate (items/s) from its module's rates; several ports of a module with one item share it. */
export function portRate(state: LayoutState, ref: PortRef, output: boolean): number | undefined {
  const m = findModule(state, ref.module)
  const p = m ? findPort(m, ref.port) : undefined
  if (!m || !p || p.item === undefined) return undefined
  const list = output ? m.def.rates.outputs : m.def.rates.inputs
  // Several ports of a module may carry the same item: split its rate evenly.
  let n = 0
  for (const q of m.def.ports) if (q.item === p.item && q.kind === p.kind) n++
  return rateOf(list, p.item) / math.max(1, n)
}

/** The tile beyond a port's outside tile, straight out from the module. */
export function portApproach(m: PlacedModule, p: Port): Vec {
  const o = portOutside(m, p)
  const t = portTile(m, p)
  return { x: 2 * o.x - t.x, y: 2 * o.y - t.y }
}

function isBelt(type: string | undefined): boolean {
  return type === "transport-belt" || type === "underground-belt" || type === "splitter"
}

/**
 * Module-local tiles outside the footprint that the module's entities interact with: where an edge belt points
 * (other than a belt-out port, whose outside tile is reserved for its route) and inserter pickup/drop tiles. Routes
 * must keep off them, or they would feed into or be fed by the module by accident.
 */
export function interactionTiles(def: ModuleDef, facts: ProtoFacts): Vec[] {
  const out: Vec[] = []
  const w = def.footprint.w
  const h = def.footprint.h
  const portOut: Record<string, boolean> = {}
  for (const p of def.ports) {
    if (p.kind === "belt-out" || p.kind === "belt-in") {
      const o = portOutsideTile(p)
      portOut[`${math.floor(o.x)},${math.floor(o.y)}`] = true
    }
  }
  const add = (x: number, y: number): void => {
    const tx = math.floor(x)
    const ty = math.floor(y)
    if (tx >= 0 && ty >= 0 && tx < w && ty < h) return
    if (portOut[`${tx},${ty}`]) return
    out.push({ x: tx, y: ty })
  }
  for (const e of def.entities) {
    const f = facts.entity(e.name)
    const d = math.floor((e.dir ?? 0) / 4)
    if (isBelt(f?.type) && f?.type !== "splitter") {
      if (f?.type === "underground-belt" && e.ioType === "input") continue
      add(e.x + DX[d], e.y + DY[d])
    } else if (f?.type === "inserter") {
      if (f.pickupVector) {
        const v = rotateVec(f.pickupVector, e.dir)
        add(e.x + v.x, e.y + v.y)
      }
      if (f.dropVectorIns) {
        const v = rotateVec(f.dropVectorIns, e.dir)
        add(e.x + v.x, e.y + v.y)
      }
    }
  }
  return out
}

/** Entity tiles of a placed module (world), for checks. */
export function moduleTiles(m: PlacedModule): number[] {
  if (m.minePlan !== undefined) return m.minePlan.occupied
  const out: number[] = []
  for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++) for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++) out.push(tkey(x, y))
  return out
}

/**
 * A module's footprint and the 1-tile margin around it, which the faction reserves (`factoryReserveTiles`). B45: a
 * whole-patch mine's margin follows its claimed tiles, not its bounding box: the box can wrap around ground the mine
 * leaves free (seed 222: another module's port lane), which would read as own ground to every later plan.
 */
export function moduleMargin(m: PlacedModule): number[] {
  const out: number[] = []
  if (m.minePlan !== undefined) {
    const seen: Record<number, boolean> = {}
    for (const k of [...m.minePlan.claim, ...m.minePlan.occupied]) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = tkey(keyX(k) + dx, keyY(k) + dy)
          if (seen[n]) continue
          seen[n] = true
          out.push(n)
        }
      }
    }
    return out
  }
  for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) out.push(tkey(x, y))
  return out
}

/** B85: the last `layoutMargins` result (derived data, never stored: keyed by the layout object and its revision). */
let marginCache: { state: LayoutState; revision: number; modules: number; tiles: Record<number, boolean> } | undefined

/**
 * B85: every module's footprint and margin ring (`moduleMargin`). The faction reserves the ring (`factoryReserveTiles`),
 * so once built it reads as own ground to every later plan: lane tests must see it as a wall already while planning.
 */
export function layoutMargins(state: LayoutState): Record<number, boolean> {
  const c = marginCache
  if (c !== undefined && c.state === state && c.revision === layoutRevision(state) && c.modules === state.modules.length) return c.tiles
  const tiles: Record<number, boolean> = {}
  for (const m of state.modules) for (const k of moduleMargin(m)) tiles[k] = true
  marginCache = { state, revision: layoutRevision(state), modules: state.modules.length, tiles }
  return tiles
}

/** Modules whose actual entity footprint intersects `tiles`, even if a later overlapping claim replaced `occ`. */
export function modulesOnTiles(state: LayoutState, tiles: Record<number, boolean>): PlacedModule[] {
  const out: PlacedModule[] = []
  for (const m of state.modules) {
    for (const k of moduleTiles(m)) {
      if (!tiles[k]) continue
      out.push(m)
      break
    }
  }
  return out
}

/** Adds a placed module's tiles to the layout: footprint, interaction tiles, port reservations, corridor ring. */
export function commitModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts, corridor: number): void {
  // B63: never two entries per id. `findModule` returns the first, while a removal filters every entry with the id, so
  // a duplicate silently orphaned the second entry's `occ`/`reserved` claims (`checkClaimOwners`: "names missing
  // interaction owner"), which discarded every later plan and stalled the factory.
  for (let i = 0; i < state.modules.length; i++) {
    const old = state.modules[i]
    if (old.id !== m.id) continue
    unmarkModule(state, old, facts)
    state.modules[i] = m
    markModule(state, m, facts, corridor)
    return
  }
  state.modules.push(m)
  markModule(state, m, facts, corridor)
}

/**
 * B63: removes a module id and releases **every** entry's claims for it (a layout saved before the duplicate guard may
 * hold two). Returns how many entries went. Callers that removed the module ad hoc leaked the second entry's claims.
 */
export function removeModule(state: LayoutState, id: string, facts: ProtoFacts): number {
  let n = 0
  // Unmark every entry *before* filtering: filtering first would drop the duplicates this exists to release.
  for (const m of state.modules) {
    if (m.id !== id) continue
    unmarkModule(state, m, facts)
    n++
  }
  if (n > 0) state.modules = state.modules.filter((x) => x.id !== id)
  return n
}

export function markModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts, corridor: number): void {
  // B37: pole lines on the module's ground (footprint, interaction tiles, port lanes, a mine's claim) give way.
  if ((state.poles?.length ?? 0) > 0) {
    const keys = [...moduleTiles(m)]
    for (const t of interactionTiles(m.def, facts)) keys.push(tkey(m.origin.x + t.x, m.origin.y + t.y))
    for (const p of m.def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
      const o = portOutside(m, p)
      const a = portApproach(m, p)
      keys.push(tkey(o.x, o.y), tkey(a.x, a.y))
    }
    if (m.minePlan !== undefined) for (const k of m.minePlan.claim) keys.push(k)
    const ga = m.canonical.anchor?.resource !== undefined ? growthArea(m) : undefined
    if (ga !== undefined) for (let x = ga.x; x < ga.x + ga.w; x++) for (let y = ga.y; y < ga.y + ga.h; y++) keys.push(tkey(x, y))
    evictPoleLines(state, keys)
  }
  for (const k of moduleTiles(m)) {
    claimModuleTile(state, k, m.id)
    delete state.corridor[k]
  }
  for (const t of interactionTiles(m.def, facts)) {
    claimInteractionTile(state, tkey(m.origin.x + t.x, m.origin.y + t.y), m.id)
  }
  for (const p of m.def.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = portOutside(m, p)
    reserveTile(state, tkey(o.x, o.y), portTag(m.id, p.id))
    // The approach tile beyond it too (P5 lane): later routes must not box in a port, built or not yet connected.
    const a = portApproach(m, p)
    const ka = tkey(a.x, a.y)
    if (state.occ[ka] === undefined) reserveFreeTile(state, ka, portTag(m.id, p.id))
  }
  // B9: the area it can still grow into (soft claim); D52 (3): hard for a mining outpost.
  const g = growthArea(m)
  if (m.minePlan !== undefined) {
    for (const k of m.minePlan.claim) {
      claimMineTile(state, k, m.id)
      claimSoftTile(state, k, m.id, 0)
    }
  } else if (g !== undefined && m.canonical.anchor?.resource !== undefined) {
    for (let x = g.x; x < g.x + g.w; x++) {
      for (let y = g.y; y < g.y + g.h; y++) claimMineTile(state, tkey(x, y), m.id)
    }
  }
  if (g !== undefined) {
    // Unit by unit outwards (their rects tile `g`), so each tile knows how far out it is (B52).
    const units = growthUnitRects(m)
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      for (let x = u.x; x < u.x + u.w; x++) {
        for (let y = u.y; y < u.y + u.h; y++) claimSoftTile(state, tkey(x, y), m.id, i)
      }
    }
  }
  const r = m.rect
  for (let x = r.x - corridor; x < r.x + r.w + corridor; x++) {
    for (let y = r.y - corridor; y < r.y + r.h + corridor; y++) {
      const k = tkey(x, y)
      if (!rectContains(r, x, y) && state.occ[k] === undefined) state.corridor[k] = true
    }
  }
  bumpLayout(state)
}

/**
 * The end an expandable module grows at: "auto" is the end `tryExpand(..., "auto")` grows, the one whose entities move
 * (`expandMoves`: the head when it holds fewer entities than the tail).
 */
export function growthEnd(def: ModuleDef, end: "auto" | "head" | "tail" = "auto"): "head" | "tail" {
  if (end !== "auto") return end
  const spec = def.expand!
  let head = 0
  let tail = 0
  for (const e of def.entities) if ((spec.axis === "x" ? e.x : e.y) >= spec.insertAt) tail++
  else head++
  return head < tail ? "head" : "tail"
}

/** The canonical strip of new ground growth unit `i` (0 = the first) adds at one end. */
export function growthStrip(def: ModuleDef, i: number, end: "auto" | "head" | "tail" = "auto"): Rect {
  const spec = def.expand!
  const W = def.footprint.w
  const H = def.footprint.h
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const head = growthEnd(def, end) === "head"
  return spec.axis === "x"
    ? { x: head ? -(i + 1) * size : W + i * size, y: 0, w: size, h: H }
    : { x: 0, y: head ? -(i + 1) * size : H + i * size, w: W, h: size }
}

/** B33: growth units a module may still add as planned (its cap, and for a strip mine the units over its ore). */
export function plannedGrowthUnits(m: PlacedModule): number {
  if (m.minePlan !== undefined) return 0
  const spec = m.canonical.expand
  if (spec === undefined || spec.maxUnits <= 0) return 0
  return m.oreUnits !== undefined ? math.max(0, math.min(spec.maxUnits, m.oreUnits)) : spec.maxUnits
}

/** B33: the world rects of a module's next `n` growth units (default: every planned one) in order, on `end`. */
export function growthUnitRects(m: PlacedModule, n?: number, end: "auto" | "head" | "tail" = "auto"): Rect[] {
  const out: Rect[] = []
  const c = m.canonical
  const units = n ?? plannedGrowthUnits(m)
  if (c.expand === undefined) return out
  for (let i = 0; i < units; i++) {
    const r = transformRect(growthStrip(c, i, end), c.footprint.w, c.footprint.h, m.transform)
    out.push({ x: m.origin.x + r.x, y: m.origin.y + r.y, w: r.w, h: r.h })
  }
  return out
}

/**
 * B9: the world rect an expandable module would add if it grew by every unit it still may (`plannedGrowthUnits`), on
 * the side `tryExpand` would grow it (the end that moves fewer entities, as `expandMoves` decides); undefined if it
 * can't. B33: a strip mine's stops at the end of its ore.
 */
export function growthArea(m: PlacedModule): Rect | undefined {
  const units = plannedGrowthUnits(m)
  if (units <= 0) return undefined
  const rects = growthUnitRects(m, units)
  let x1 = math.huge
  let y1 = math.huge
  let x2 = -math.huge
  let y2 = -math.huge
  for (const r of rects) {
    x1 = math.min(x1, r.x)
    y1 = math.min(y1, r.y)
    x2 = math.max(x2, r.x + r.w)
    y2 = math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** B52: gives each soft-claimed tile without a growth unit (marked before units were recorded) the unit it lies in. */
export function fillSoftUnits(state: LayoutState): void {
  if (state.soft === undefined) return
  state.softUnit ??= {}
  for (const m of state.modules) {
    const units = growthUnitRects(m)
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      for (let x = u.x; x < u.x + u.w; x++) {
        for (let y = u.y; y < u.y + u.h; y++) {
          const k = tkey(x, y)
          if (state.soft[k] === m.id && state.softUnit[k] === undefined) state.softUnit[k] = i
        }
      }
    }
  }
}

/** Removes a module's tiles (before re-marking it grown). Routes are untouched. */
export function unmarkModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts): void {
  releaseSoftClaims(state, m.id)
  releaseMineClaims(state, m.id)
  for (const k of moduleTiles(m)) releaseModuleTile(state, k, m.id)
  for (const t of interactionTiles(m.def, facts)) {
    releaseInteractionTile(state, tkey(m.origin.x + t.x, m.origin.y + t.y), m.id)
  }
  for (const p of m.def.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = portOutside(m, p)
    releaseReservation(state, tkey(o.x, o.y), portTag(m.id, p.id))
    const a = portApproach(m, p)
    releaseReservation(state, tkey(a.x, a.y), portTag(m.id, p.id))
  }
  bumpLayout(state)
}

export function lineKey(x: number, y: number, dir: number): string {
  return dir % 2 === 1 ? `h${y}` : `v${x}`
}

export function commitRoute(state: LayoutState, route: Route): void {
  // B58: replacing a route in place (same id) must take its splitter taps with it. Otherwise the old tap keeps its
  // splitter on the new route's tiles, which may now be an underground span: the splitter stands with no input, the
  // logical edge still looks connected, and the reconciler finds "nothing missing".
  if (state.routes[route.id] !== undefined) ripRoute(state, route.id)
  // B37: pole lines on the route's tiles give way.
  evictPoleLines(state, route.tiles)
  state.routes[route.id] = route
  state.routeOrder.push(route.id)
  for (const k of route.tiles) claimRouteTile(state, k, route.id)
  for (const s of route.spans) {
    let list = state.spans[s.line]
    if (list === undefined) {
      list = []
      state.spans[s.line] = list
    }
    list.push(s.span)
  }
  bumpLayout(state)
}

/** Removes a route (and the splitter taps hanging off it). Returns the removed route ids. */
/**
 * B88: routes `rids` and every route that taps one of them, at any depth (what `ripRoute` takes with each): the routes a
 * connection's own route carries. Layout order.
 */
export function tapTree(state: LayoutState, rids: RouteId[]): RouteId[] {
  const inTree: Record<string, boolean> = {}
  for (const id of rids) if (state.routes[id] !== undefined) inTree[id] = true
  let grew = true
  while (grew) {
    grew = false
    for (const id of state.routeOrder) {
      const t = state.routes[id]?.tapOf
      if (!inTree[id] && t !== undefined && inTree[t]) {
        inTree[id] = true
        grew = true
      }
    }
  }
  return state.routeOrder.filter((id) => inTree[id])
}

/**
 * B91: routes `rids` and every route that depends on one of them, at any depth: its splitter taps (`tapOf`) and the
 * provider-group joins onto its belt (a side-load `merge` or a `mergeSplitter` on one of its tiles). A route that moves
 * takes them with it: a join left behind points at a tile the trunk may no longer run straight through (sweep 922c77c
 * seed 2034469: a growth rerouted a trunk into a curve under a built merge splitter; the splitter cut it). Layout order.
 */
export function dependentRoutes(state: LayoutState, rids: RouteId[]): RouteId[] {
  const inTree: Record<string, boolean> = {}
  const tiles: Record<number, boolean> = {}
  const add = (id: string): void => {
    inTree[id] = true
    for (const k of state.routes[id]?.tiles ?? []) tiles[k] = true
  }
  for (const id of rids) if (state.routes[id] !== undefined) add(id)
  let grew = true
  while (grew) {
    grew = false
    for (const id of state.routeOrder) {
      if (inTree[id]) continue
      const r = state.routes[id]
      if (r === undefined) continue
      const join = r.merge ?? r.mergeSplitter
      if ((r.tapOf !== undefined && inTree[r.tapOf]) || (join !== undefined && tiles[tkey(join.x, join.y)])) {
        add(id)
        grew = true
      }
    }
  }
  return state.routeOrder.filter((id) => inTree[id])
}

export function ripRoute(state: LayoutState, id: RouteId): RouteId[] {
  const route = state.routes[id]
  if (route === undefined) return []
  const removed: RouteId[] = [id]
  for (const other of [...state.routeOrder]) {
    if (state.routes[other]?.tapOf === id) for (const r of ripRoute(state, other)) removed.push(r)
  }
  for (const k of route.tiles) releaseRouteTile(state, k, id)
  for (const s of route.spans) {
    const list = state.spans[s.line]
    if (list === undefined) continue
    const kept = list.filter((x) => x.route !== id)
    if (kept.length > 0) state.spans[s.line] = kept
    else delete state.spans[s.line]
  }
  delete state.routes[id]
  const i = state.routeOrder.indexOf(id)
  if (i >= 0) state.routeOrder.splice(i, 1)
  bumpLayout(state)
  return removed
}

/**
 * Provider handover (goalpost 1): a route outlives the connection that planned it. The retiring provider's belt to a
 * consumer is kept when its replacement side-loads into it (`Route.merge`), so the consumer never loses its feed while
 * the old module is deconstructed: the replacement connection adopts the route. Its `conn` becomes the replacement's
 * and `from` the replacement's port, while the laid tiles stay exactly where they are.
 */
export function adoptRoute(state: LayoutState, id: RouteId, conn: ConnectionId, from: PortRef | undefined): boolean {
  const route = state.routes[id]
  if (route === undefined) return false
  route.conn = conn
  route.from = from
  bumpLayout(state)
  return true
}

// ---------------------------------------------------------------------------------------------------------
// Derived-index checker. This checks the layout's internal bookkeeping only; `checkLayout` below checks geometry and
// terrain. Keeping the two separate makes this useful after pure mutations and on replay fixtures without a surface.
export interface LayoutIndexCheck {
  problems: string[]
}

/**
 * Checks that the canonical module/route/pole collections agree with their derived lookup indexes. This deliberately
 * reports every mismatch instead of throwing at the first one, so a failed replay explains the whole stale-state
 * chain. It accepts compatible old layouts: optional indexes that are absent are treated as empty.
 */
export function checkLayoutIndexes(state: LayoutState): LayoutIndexCheck {
  const problems: string[] = []
  const moduleIds: Record<string, boolean> = {}
  for (const m of state.modules) {
    if (moduleIds[m.id]) problems.push(`duplicate module ${m.id}`)
    moduleIds[m.id] = true
    for (const k of moduleTiles(m)) if (state.occ[k] !== moduleTag(m.id)) problems.push(`module ${m.id} tile ${keyX(k)},${keyY(k)} indexed as ${state.occ[k] ?? "free"}`)
  }

  const order: Record<string, boolean> = {}
  for (const id of state.routeOrder) {
    if (order[id]) problems.push(`route ${id} occurs twice in routeOrder`)
    order[id] = true
    const route = state.routes[id]
    if (route === undefined) {
      problems.push(`routeOrder contains missing route ${id}`)
      continue
    }
    // B88: a tap whose trunk is gone (a replanned connection's route replaced the trunk it tapped; telemetry crashed on it).
    if (route.tapOf !== undefined && state.routes[route.tapOf] === undefined) problems.push(`route ${id} taps missing route ${route.tapOf}`)
    for (const k of route.tiles) if (state.routeOcc[k] !== id) problems.push(`route ${id} tile ${keyX(k)},${keyY(k)} indexed as ${state.routeOcc[k] ?? "free"}`)
    for (const s of route.spans) {
      const found = state.spans[s.line]?.some((x) => x.route === id && x.a === s.span.a && x.b === s.span.b) ?? false
      if (!found) problems.push(`route ${id} span ${s.line}:${s.span.a}..${s.span.b} is not indexed`)
    }
  }
  for (const [id] of pairs(state.routes)) if (!order[id as string]) problems.push(`route ${id as string} missing from routeOrder`)
  for (const [k, id] of pairs(state.routeOcc)) {
    const route = state.routes[id as string]
    if (route === undefined) problems.push(`routeOcc ${keyX(k as number)},${keyY(k as number)} names missing route ${id as string}`)
    else if (route.tiles.indexOf(k as number) < 0) problems.push(`routeOcc ${keyX(k as number)},${keyY(k as number)} is not a tile of ${id as string}`)
  }
  for (const [line, spans] of pairs(state.spans)) {
    for (const span of spans as UgSpan[]) {
      const route = state.routes[span.route]
      if (route === undefined) problems.push(`span ${line as string}:${span.a}..${span.b} names missing route ${span.route}`)
      else if (!route.spans.some((s) => s.line === line && s.span.a === span.a && s.span.b === span.b)) problems.push(`span ${line as string}:${span.a}..${span.b} is not owned by route ${span.route}`)
    }
  }

  const listedPoleIds: Record<string, boolean> = {}
  const lineIds: Record<string, boolean> = {}
  for (const line of state.poleLines ?? []) {
    if (lineIds[line.id]) problems.push(`duplicate pole line ${line.id}`)
    lineIds[line.id] = true
    for (const id of line.poles) listedPoleIds[id] = true
  }
  const actualPoleIds: Record<string, boolean> = {}
  for (const pole of state.poles ?? []) {
    actualPoleIds[pole.id] = true
    if (!lineIds[pole.line]) problems.push(`pole ${pole.id} names missing line ${pole.line}`)
    if (!listedPoleIds[pole.id]) problems.push(`pole ${pole.id} is missing from line ${pole.line}`)
    const k = tkey(pole.x, pole.y)
    if (state.occ[k] !== poleTag(pole.line)) problems.push(`pole ${pole.id} tile ${pole.x},${pole.y} indexed as ${state.occ[k] ?? "free"}`)
  }
  for (const line of state.poleLines ?? []) {
    for (const id of line.poles) if (!actualPoleIds[id]) problems.push(`pole line ${line.id} names missing pole ${id}`)
  }
  return { problems }
}

/** Whether a span overlaps any on its line (other than `except`'s); returns the owners it overlaps. */
export function spanConflicts(state: LayoutState, line: string, a: number, b: number): string[] {
  const out: string[] = []
  const list = state.spans[line]
  if (list !== undefined) for (const s of list) if (s.a <= b && a <= s.b) out.push(s.route)
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Independent checker: what the acceptance tests assert about a finished layout.

export interface LayoutCheck {
  problems: string[]
}

function hardTerrain(b: number): boolean {
  return b === WATER || b === CLIFF || b === UNKNOWN || b === OWN || b === FOREIGN
}

/**
 * Checks a layout: module footprints are disjoint and on placeable terrain; every route is continuous from its
 * producer's outside tile into its consumer's port tile from the required side, stays out of every footprint,
 * water, cliffs and other structures, shares no tile with another route, and its undergrounds respect the tier's
 * maximum and do not interleave with others on the same line.
 */
export function checkLayout(state: LayoutState, terrain: TerrainView, maxUnderground: (this: void, ug: string) => number): LayoutCheck {
  const problems: string[] = []
  const foot: Record<number, string> = {}
  for (const m of state.modules) {
    for (const k of moduleTiles(m)) {
      if (foot[k] !== undefined) problems.push(`modules ${foot[k]} and ${m.id} overlap`)
      foot[k] = m.id
    }
  }
  const used: Record<number, string> = {}
  const claim = (route: Route, x: number, y: number, what: string): void => {
    const k = tkey(x, y)
    if (used[k] !== undefined && used[k] !== route.id) problems.push(`${route.id}: ${what} at ${x},${y} shares a tile with ${used[k]}`)
    used[k] = route.id
    if (foot[k] !== undefined) problems.push(`${route.id}: ${what} at ${x},${y} inside module ${foot[k]}`)
    if (hardTerrain(terrain.block(x, y))) problems.push(`${route.id}: ${what} at ${x},${y} on blocked terrain`)
  }
  const lines: Record<string, { a: number; b: number; route: string }[]> = {}
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    const to = findModule(state, r.to.module)
    const toPort = to ? findPort(to, r.to.port) : undefined
    if (!to || !toPort) {
      problems.push(`${id}: unknown target ${r.to.module}.${r.to.port}`)
      continue
    }
    const target = portTile(to, toPort)
    const portDir = math.floor(toPort.dir / 4)
    // The first tile: a belt-out's outside tile (or a splitter tap / an external stub).
    let expect: Vec | undefined
    let heading = -1
    let merged = false
    if (r.from !== undefined && r.tapOf === undefined) {
      const fm = findModule(state, r.from.module)
      const fp = fm ? findPort(fm, r.from.port) : undefined
      if (!fm || !fp) problems.push(`${id}: unknown source`)
      else {
        expect = portOutside(fm, fp)
        heading = math.floor(fp.dir / 4)
      }
    }
    for (let i = 0; i < r.steps.length; i++) {
      const s = r.steps[i]
      // A provider-group splitter merge ends the route: the branch arrives beside the trunk and the splitter replaces
      // both tiles, so the route stops here and joins the trunk's route to the same consumer.
      if (s.kind === "splitter" && i === r.steps.length - 1 && s.x2 !== undefined && s.y2 !== undefined && expect !== undefined && s.x2 === expect.x && s.y2 === expect.y) {
        claim(r, s.x2, s.y2, "splitter")
        const owner = state.routeOcc[tkey(s.x, s.y)]
        const other = owner !== undefined ? state.routes[owner] : undefined
        if (other === undefined || other.id === r.id || other.to.module !== r.to.module || other.to.port !== r.to.port) {
          problems.push(`${id}: merge splitter ${s.x},${s.y} is not a route to ${r.to.module}.${r.to.port}`)
        }
        expect = undefined
        merged = true
        break
      }
      if (expect !== undefined && (s.x !== expect.x || s.y !== expect.y)) problems.push(`${id}: step ${i} (${s.kind}) at ${s.x},${s.y}, expected ${expect.x},${expect.y}`)
      if (s.kind === "splitter") {
        claim(r, s.x2!, s.y2!, "splitter")
        expect = { x: s.x2! + DX[s.dir], y: s.y2! + DY[s.dir] }
        heading = s.dir
        continue
      }
      claim(r, s.x, s.y, s.kind)
      if (heading >= 0 && s.kind !== "belt" && s.dir !== heading) problems.push(`${id}: ${s.kind} at ${s.x},${s.y} not entered straight`)
      if (heading >= 0 && s.kind === "belt" && s.dir === (heading + 2) % 4) problems.push(`${id}: belt at ${s.x},${s.y} turns back`)
      if (s.kind === "ug-in") {
        const out = r.steps[i + 1]
        if (out === undefined || out.kind !== "ug-out" || out.dir !== s.dir) {
          problems.push(`${id}: underground entrance at ${s.x},${s.y} has no exit`)
          continue
        }
        const dist = math.abs(out.x - s.x) + math.abs(out.y - s.y)
        if (out.x !== s.x + DX[s.dir] * dist || out.y !== s.y + DY[s.dir] * dist) problems.push(`${id}: underground exit off line at ${out.x},${out.y}`)
        if (dist > maxUnderground(r.underground)) problems.push(`${id}: underground ${dist} > max ${maxUnderground(r.underground)}`)
        const line = lineKey(s.x, s.y, s.dir)
        const a = s.dir % 2 === 1 ? math.min(s.x, out.x) : math.min(s.y, out.y)
        const b = s.dir % 2 === 1 ? math.max(s.x, out.x) : math.max(s.y, out.y)
        lines[line] ??= []
        for (const o of lines[line]) if (o.a <= b && a <= o.b) problems.push(`${id}: underground span ${line} ${a}..${b} interleaves with ${o.route}`)
        lines[line].push({ a, b, route: id })
        expect = { x: out.x, y: out.y }
        heading = s.dir
        continue
      }
      expect = { x: s.x + DX[s.dir], y: s.y + DY[s.dir] }
      heading = s.dir
    }
    if (r.blocker) claim(r, r.blocker.x, r.blocker.y, "side-load blocker")
    // Arrival: into the port tile with the port's direction, or from the required side. A provider-group merge ends
    // on another belt of the same consumer: that belt (and its route) carries the joined flow into the port.
    const end = r.merge ?? target
    let want = toPort.side === undefined ? portDir : toPort.side === "left" ? (portDir + 1) % 4 : (portDir + 3) % 4
    if (r.merge !== undefined) {
      want = r.merge.side === "left" ? (r.merge.dir + 1) % 4 : (r.merge.dir + 3) % 4
      const owner = state.routeOcc[tkey(r.merge.x, r.merge.y)]
      const other = owner !== undefined ? state.routes[owner] : undefined
      if (other === undefined || other.id === r.id || other.to.module !== r.to.module || other.to.port !== r.to.port) {
        problems.push(`${id}: merge target ${r.merge.x},${r.merge.y} is not a route to ${r.to.module}.${r.to.port}`)
      }
    }
    if (merged) continue
    if (expect === undefined || expect.x !== end.x || expect.y !== end.y) problems.push(`${id}: does not end at ${to.id}.${toPort.id} (${target.x},${target.y})`)
    else if (heading !== want) problems.push(`${id}: arrives at ${to.id}.${toPort.id} heading ${heading}, needs ${want}`)
  }
  return { problems }
}

/**
 * B57 relocation candidates: the goal ports a failed plan's router proved walled in (`sealed` on the goal side, the flood
 * not cut by the window edge), on modules of `layout`, in evidence order. B76: a port some route of `layout` already
 * ends at is not a candidate: its lane is walled in by its own feed belt, the module is fed, and relocating it tore down
 * working red-science smelters (vps-b75-r4410923 n15/n17, no science for 130 min).
 */
export function sealedGoalPorts(layout: LayoutState, evidence: { kind: string; subject: string; sealed?: { side: "start" | "goal"; port: PortRef; edge?: boolean } }[]): { port: PortRef; subject: string }[] {
  const fed: Record<string, boolean> = {}
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    if (r !== undefined) fed[`${r.to.module}.${r.to.port}`] = true
  }
  const out: { port: PortRef; subject: string }[] = []
  for (const ev of evidence) {
    const s = ev.sealed
    if (ev.kind !== "route" || s === undefined || s.side !== "goal" || s.edge === true) continue
    if (findModule(layout, s.port.module) === undefined || fed[`${s.port.module}.${s.port.port}`]) continue
    out.push({ port: s.port, subject: ev.subject })
  }
  return out
}

/**
 * B83: whether any of routes `rids` brings items to port `to` in the layout: a plain route ends on the port's tile; a
 * provider-group merge (side-load or splitter) lands if the route owning its trunk tile does, followed a few hops.
 * vps-b81-r5480563 (and vps-d68a): copper side-load stubs onto a trunk the layout no longer had; every entity of the
 * edge's routes stood, so the reconciler's repair found "nothing missing" while no copper reached the smelter.
 */
export function routesLand(layout: LayoutState, rids: string[], to: PortRef): boolean {
  const m = findModule(layout, to.module)
  const p = m !== undefined ? findPort(m, to.port) : undefined
  if (m === undefined || p === undefined) return false
  // A route's last belt is the port's outside tile (the module's input inserter picks up from it).
  const goal = portOutside(m, p)
  const inner = portTile(m, p)
  for (const rid of rids) {
    let r: Route | undefined = layout.routes[rid as RouteId]
    for (let hop = 0; hop < 8 && r !== undefined; hop++) {
      const join: { x: number; y: number } | undefined = r.merge ?? r.mergeSplitter
      if (join === undefined) {
        const last = r.steps[r.steps.length - 1]
        if (r.to.module === to.module && r.to.port === to.port && last !== undefined && ((last.x === goal.x && last.y === goal.y) || (last.x === inner.x && last.y === inner.y))) return true
        break
      }
      const owner: RouteId | undefined = layout.routeOcc[tkey(join.x, join.y)]
      r = owner !== undefined && owner !== r.id ? layout.routes[owner] : undefined
    }
  }
  return false
}

/** B84: whether a route of the layout already starts at belt-out port `from` (directly, not as a splitter tap). */
export function portFeedsRoute(layout: LayoutState, from: PortRef): boolean {
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    if (r !== undefined && r.tapOf === undefined && r.from !== undefined && r.from.module === from.module && r.from.port === from.port) return true
  }
  return false
}

/**
 * B86: whether route `rid` dangles: it is a provider-group merge (side-load or splitter) whose trunk tile no route owns
 * any more, followed through a chain of merges. A plain route never dangles. A dangling stub brings nothing to its port.
 */
export function routeDangles(layout: LayoutState, rid: string): boolean {
  let r: Route | undefined = layout.routes[rid as RouteId]
  for (let hop = 0; hop < 8 && r !== undefined; hop++) {
    const join: { x: number; y: number } | undefined = r.merge ?? r.mergeSplitter
    if (join === undefined) return false
    const owner: RouteId | undefined = layout.routeOcc[tkey(join.x, join.y)]
    if (owner === undefined || owner === r.id) return true
    r = layout.routes[owner]
  }
  return r === undefined
}
