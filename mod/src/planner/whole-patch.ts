// Whole-patch mine preparation (D52/B33/B45): turns an accepted mine placement into its whole-patch plan. M7: runs in
// steps under the planner budget (`stepWholePatch`); the state is plain data, so a plan job holds it in `storage`.

import { ProtoFacts } from "../modules/facts"
import { IDENTITY } from "../modules/geometry"
import { moduleGrowthClaimConflict } from "./claims"
import { FOREIGN, FREE, inflate, keyX, keyY, OWN, Rect, rectContains, ROCK, TerrainView, tkey, TREE, UNKNOWN, Vec } from "./grid"
import { findModule, LayoutState, moduleMargin, PlacedModule, portApproach, portOutside } from "./layout"
import { beltDrillCap, claimPart, connectedPatch, materializeMinePlan, MaterializedMinePlan, newPatchSearch, PatchPlan, PatchSearch, stepPatchSearch } from "./mine-plan"
import { drillCount, isMining, LANE_HOP, LaneEnd, LaneHop, laneLeadsOut, laneWayOut, openPortEnds, stripOreUnits } from "./placement"
import { LayoutPolicy } from "./policy"

/** A mine's whole-patch preparation in progress. */
export interface WholePatchPrep {
  stage: "start" | "search" | "done"
  patch?: PatchPlan
  search?: PatchSearch
  /** B45: 1 once the patch is planned again around the port lanes the first plan walled in. */
  attempt: number
  keepOut: Record<number, boolean>
  near?: Vec
  cap?: number
  maxLanes?: number
  /** Other modules' open port lanes that lead out now (B45). */
  lanes?: LaneEnd[]
}

/** The inputs every step needs (passed again each step, never stored). */
export interface WholePatchArgs {
  terrain: TerrainView
  facts: ProtoFacts
  region: Rect
  policy: LayoutPolicy
  state?: LayoutState
  splitters: boolean
}

export function newWholePatchPrep(): WholePatchPrep {
  return { stage: "start", attempt: 0, keepOut: {} }
}

/**
 * Work units of the steps outside the grid search, in the planner's budget scale (about 5 µs of plain Lua a unit),
 * measured on the T1 replays (Lua 5.4): following the patch costs ~4 µs a patch tile (one unit); materialising a plan
 * and checking its claim, margin and fit ~17 µs a claimed tile (`CLAIM_TILE_WORK` units); a B45 lane flood ~2.4 µs a
 * state (`LANE_STATES_PER_UNIT` states a unit).
 */
const CLAIM_TILE_WORK = 3
const LANE_STATES_PER_UNIT = 2

/** Ground the layout already gives to someone else reads as own structures: no planned drill, belt or pole there. */
function takenFn(m: PlacedModule, state: LayoutState | undefined): (this: void, x: number, y: number) => boolean {
  return (x, y) => state !== undefined && moduleGrowthClaimConflict(state, tkey(x, y), m.id) !== undefined
}

/** The mine stays the strip it was placed as; its growth is clipped to its ore (`stripOreUnits`). */
function strip(p: WholePatchPrep, m: PlacedModule, a: WholePatchArgs): void {
  if (m.canonical.expand !== undefined) m.oreUnits = stripOreUnits(m, a.terrain, a.facts)
  p.stage = "done"
  p.search = undefined
}

function drillOf(m: PlacedModule, a: WholePatchArgs) {
  const name = m.canonical.params?.drill
  return typeof name === "string" ? a.facts.entity(name) : undefined
}

/** The connected patch, the part of it the mine claims and the lanes to keep open. Work: one unit per patch tile. */
function start(p: WholePatchPrep, m: PlacedModule, a: WholePatchArgs): number {
  if (!isMining(m.canonical) || m.minePlan !== undefined) {
    p.stage = "done"
    return 1
  }
  const resource = m.canonical.anchor?.resource
  const belt = m.canonical.params?.belt
  const drill = drillOf(m, a)
  if (resource === undefined || drill === undefined || typeof belt !== "string") {
    strip(p, m, a)
    return 1
  }
  const seeds: Vec[] = []
  for (const r of m.def.anchor?.miningAreas ?? []) {
    for (let x = m.origin.x + r.x; x < m.origin.x + r.x + r.w; x++) {
      for (let y = m.origin.y + r.y; y < m.origin.y + r.y + r.h; y++) if (a.terrain.ore(x, y) === resource) seeds.push({ x, y })
    }
  }
  const patch = connectedPatch(a.terrain, resource, seeds, a.region)
  if (patch === undefined) {
    strip(p, m, a)
    return 1 + seeds.length
  }
  // Preserve the routing intent of the accepted small placement. Its output was oriented toward the consumer;
  // using that outside tile as the materializer's target chooses the matching edge of the whole-patch plan.
  const oldOut = m.def.ports.find((q) => q.id === "out")
  p.near = oldOut !== undefined ? portOutside(m, oldOut) : { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }
  // The part it claims: a shared (splitter-tap) mine one full output belt over as many lanes as that takes; a
  // point-to-point mine, which only ever feeds its one consumer, one lane of the patch's grid (the strip it was placed
  // as, on the full-coverage grid and only over ore) holding at most as many drills as its template could grow to, so
  // the rest of the field stays free for the next consumer's own mine (the seed 11 / 3333 replays: two coal outposts
  // on one small field).
  let cap = beltDrillCap(a.facts, belt, drill, resource)
  let maxLanes = math.huge
  const spec = m.canonical.expand
  // P44 (b) (user, 2026-10-28: "Splitters, cap before"): rows past the first join the collector through splitters; with
  // none researched, the mine is one row (its two drill columns fill the two lanes of its belt, no side-load).
  if (!a.splitters) maxLanes = 1
  if (a.policy.topology !== "splitter-tap") {
    maxLanes = 1
    if (spec !== undefined) {
      let perUnit = 0
      for (const e of spec.unit.entities) if (a.facts.entity(e.name)?.type === "mining-drill") perUnit++
      cap = math.min(cap, drillCount(m.canonical, a.facts) + spec.maxUnits * perUnit)
    }
  }
  p.cap = cap
  p.maxLanes = maxLanes
  // B45: the plan, its claim and its margin must not wall in another module's unconnected port lane: when they do, the
  // patch is planned again around each such lane's way out (and a tile either side of it, the margin), once.
  const escape = escapeOf(a)
  const g = grounds(m, a)
  const flood = { n: 0 }
  p.lanes = escape > 0 ? openPortEnds(a.state!, m.id).filter((l) => laneLeadsOut(l, g.ground, escape, g.hop, undefined, flood)) : []
  p.patch = patch
  p.search = newPatchSearch(patch, drill)
  p.stage = "search"
  return patch.tiles.length + math.ceil(flood.n / LANE_STATES_PER_UNIT)
}

function escapeOf(a: WholePatchArgs): number {
  return a.state !== undefined ? (a.policy.placement.portEscape ?? 0) : 0
}

/** B45/B57: ground a lane may cross, and where it may hop under (anything but a module; nor the mine and its margin). */
function grounds(m: PlacedModule, a: WholePatchArgs): { ground: (this: void, x: number, y: number) => boolean; under: (this: void, x: number, y: number) => boolean; hop: LaneHop } {
  const taken = takenFn(m, a.state)
  // Memoised for the piece (the floods of every lane read the same tiles; the layout does not change within a piece).
  const groundAt: Record<number, boolean> = {}
  const underAt: Record<number, boolean> = {}
  const ground = (x: number, y: number): boolean => {
    const k = tkey(x, y)
    const known = groundAt[k]
    if (known !== undefined) return known
    const b = a.terrain.block(x, y)
    const v = !taken(x, y) && (b === FREE || b === TREE || b === ROCK)
    groundAt[k] = v
    return v
  }
  const under = (x: number, y: number): boolean => {
    const k = tkey(x, y)
    const known = underAt[k]
    if (known !== undefined) return known
    const o = a.state?.occ[k]
    const v = !(o !== undefined && string.sub(o, 1, 2) === "m:" && o !== `m:${m.id}`) && a.terrain.block(x, y) !== UNKNOWN
    underAt[k] = v
    return v
  }
  return { ground, under, hop: { under, max: LANE_HOP, state: a.state } }
}

/** The terrain the grid search reads: taken ground reads as own structures, kept-out lane ground as foreign. */
function planView(p: WholePatchPrep, m: PlacedModule, a: WholePatchArgs): TerrainView {
  const taken = takenFn(m, a.state)
  return {
    block: (x, y) => (p.keepOut[tkey(x, y)] ? FOREIGN : taken(x, y) ? OWN : a.terrain.block(x, y)),
    ore: (x, y) => a.terrain.ore(x, y),
  }
}

/**
 * The searched plan, cut to the mine's part and materialised. B45: when its claim and margin wall in an open lane, the
 * lane's way out is kept out and the patch is searched again (once); still sealed, the mine stays a strip.
 */
function finishSearch(p: WholePatchPrep, m: PlacedModule, a: WholePatchArgs): number {
  const drill = drillOf(m, a)!
  const view = planView(p, m, a)
  const plan = claimPart(p.search!.result!, view, drill, p.near!, p.cap!, p.maxLanes!)
  const built = materializeMinePlan(m.canonical, plan, a.facts, p.near!, a.policy.minOreCoverage, p.maxLanes! > 1 ? "splitter" : undefined)
  if (built === undefined) {
    strip(p, m, a)
    return 1 + plan.drills.length
  }
  const flood = { n: 0 }
  const margin: Record<number, boolean> = {}
  for (const k of moduleMargin({ ...m, minePlan: { full: built.full, claim: built.claim, occupied: built.occupied, complete: false } })) margin[k] = true
  const g = grounds(m, a)
  const escape = escapeOf(a)
  let sealed = false
  for (const l of p.lanes ?? []) {
    const ground = (x: number, y: number): boolean => g.ground(x, y) && !margin[tkey(x, y)]
    const under = (x: number, y: number): boolean => g.under(x, y) && !margin[tkey(x, y)]
    if (laneLeadsOut(l, ground, escape, { under, max: LANE_HOP, state: a.state }, undefined, flood)) continue
    sealed = true
    for (const t of laneWayOut(l, g.ground, escape, g.hop, undefined, flood)!) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) p.keepOut[tkey(t.x + dx, t.y + dy)] = true
  }
  const work = 1 + built.claim.length * CLAIM_TILE_WORK + math.ceil(flood.n / LANE_STATES_PER_UNIT)
  if (sealed) {
    if (p.attempt === 1) strip(p, m, a)
    else {
      p.attempt = 1
      p.search = newPatchSearch(p.patch!, drill)
    }
    return work
  }
  if (fits(m, a, built)) adopt(m, built)
  else if (m.canonical.expand !== undefined) m.oreUnits = stripOreUnits(m, a.terrain, a.facts)
  p.stage = "done"
  p.search = undefined
  return work
}

/**
 * B33: the whole plan must fit: every claimed tile buildable (trees and rocks as the policy clears them, own structures
 * the layout doesn't hold as D51 evicts them), in the region, untaken, and off other non-mine modules' corridor ring;
 * its output port must have a usable outside tile.
 */
function fits(m: PlacedModule, a: WholePatchArgs, built: MaterializedMinePlan): boolean {
  const taken = takenFn(m, a.state)
  const obstacles = a.policy.obstacles
  for (const k of built.claim) {
    const x = keyX(k)
    const y = keyY(k)
    // Own structures the layout doesn't know (bootstrap sites on the patch) are fine: adoption evicts them (D51 (3)).
    const b = a.terrain.block(x, y)
    if (!rectContains(a.region, x, y) || taken(x, y)) return false
    if (b !== FREE && b !== OWN && !(b === TREE && obstacles.trees === "clear") && !(b === ROCK && obstacles.rocks === "clear")) return false
  }
  const ownRect = { x: built.origin.x, y: built.origin.y, w: built.full.footprint.w, h: built.full.footprint.h }
  if (a.state !== undefined) {
    const ring = inflate(ownRect, a.policy.corridor.min)
    for (let x = ring.x; x < ring.x + ring.w; x++) {
      for (let y = ring.y; y < ring.y + ring.h; y++) {
        const o = a.state.occ[tkey(x, y)]
        if (o === undefined || string.sub(o, 1, 2) !== "m:" || o === `m:${m.id}`) continue
        const other = findModule(a.state, string.sub(o, 3))
        if (other === undefined || !isMining(other.canonical)) return false
      }
    }
  }
  const out = built.initial.ports.find((q) => q.id === "out")
  if (out === undefined) return true
  const probe: PlacedModule = { ...m, canonical: built.initial, def: built.initial, transform: IDENTITY, origin: built.origin, rect: ownRect }
  // The route starts on the outside tile and leaves over the approach tile: both must be ground the router can use
  // (own structures there are not evicted for a route; the seed 3333 replay's iron mine faced into its base).
  for (const o of [portOutside(probe, out), portApproach(probe, out)]) {
    const b = a.terrain.block(o.x, o.y)
    if (taken(o.x, o.y) || (b !== FREE && b !== TREE && b !== ROCK)) return false
  }
  return true
}

function adopt(m: PlacedModule, built: MaterializedMinePlan): void {
  m.canonical = built.initial
  m.def = built.initial
  m.transform = IDENTITY
  m.origin = built.origin
  m.rect = { x: built.origin.x, y: built.origin.y, w: built.full.footprint.w, h: built.full.footprint.h }
  m.oreUnits = undefined
  m.minePlan = { full: built.full, claim: built.claim, occupied: built.occupied, complete: false }
}

/** Advances a mine's whole-patch preparation until `budget` work is spent (at least one piece); returns the work used. */
export function stepWholePatch(p: WholePatchPrep, m: PlacedModule, a: WholePatchArgs, budget: number): number {
  let used = 0
  while (p.stage !== "done" && (used === 0 || used < budget)) {
    if (p.stage === "start") {
      used += start(p, m, a)
      continue
    }
    const s = p.search!
    if (s.result === undefined) used += stepPatchSearch(s, planView(p, m, a), drillOf(m, a)!, budget - used)
    else used += finishSearch(p, m, a)
  }
  return used
}

/**
 * Replaces the small linear placement template with its immutable, fixed-port whole-patch mine plan (D52), in every
 * topology (B33: point-to-point mines were left as strips whose growth ran off the patch). The plan covers the part of
 * the patch one output belt can carry (`claimPart`) and avoids ground other modules, routes, claims and reservations of
 * `state` already hold. When the plan does not fit (its entities on unbuildable or taken ground), the mine stays the
 * strip it was placed as and its growth is clipped to its ore (`stripOreUnits`). Run to completion; a plan job steps
 * it (`stepWholePatch`).
 */
export function prepareWholePatchPlacement(m: PlacedModule, terrain: TerrainView, facts: ProtoFacts, region: Rect, policy: LayoutPolicy, state?: LayoutState, splitters = false): void {
  const p = newWholePatchPrep()
  const a: WholePatchArgs = { terrain, facts, region, policy, state, splitters }
  while (p.stage !== "done") stepWholePatch(p, m, a, math.huge)
}
