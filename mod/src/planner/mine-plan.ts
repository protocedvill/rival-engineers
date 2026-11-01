// Whole-patch drill planning (D52/B21). Pure: no Factorio globals.
//
// A mine is planned once over the connected resource field. The result is a 2D set of drill positions, not a
// one-dimensional expansion strip. Placement may build any subset first; later growth chooses still-live positions
// from this immutable plan. The belt/pole layer is deliberately separate: it consumes this drill plan and reserves
// its own exact entity tiles.

import { finalizeModule } from "../modules/build"
import { EntityFacts, ProtoFacts } from "../modules/facts"
import { laneCapacity } from "../modules/generators"
import { entityRect, portOutsideTile, tileKey } from "../modules/geometry"
import { placePoles } from "../modules/poles"
import { EAST, ModuleDef, ModuleEntity, NORTH, Port, SOUTH, WEST } from "../modules/types"
import { DEFAULT_TIER_NAMES } from "./capacity"
import { OWN, Rect, rectContains, TerrainView, tkey, Vec } from "./grid"

export interface PatchPlan {
  resource: string
  /** Connected resource tiles, sorted by world tile key for deterministic persistence. */
  tiles: number[]
  bounds: Rect
}

export interface PlannedDrill {
  /** World centre. Vanilla 3x3 drills use half-tile centres. */
  x: number
  y: number
  /** Belt row this drill feeds; vertical rows have a fixed x, horizontal rows a fixed y. */
  lane: number
  side: -1 | 1
  /** B33: ore tiles of the patch's resource in its mining area (when planned). */
  ore?: number
  /** B33: tiles of its mining area. */
  area?: number
}

export interface WholePatchMinePlan {
  patch: PatchPlan
  /** Direction of the parallel belt lanes. */
  axis: "x" | "y"
  drills: PlannedDrill[]
  /** Patch tiles reached by at least one planned drill. */
  covered: number[]
}

export interface MaterializedMinePlan {
  initial: ModuleDef
  full: ModuleDef
  origin: Vec
  claim: number[]
  occupied: number[]
}

/** D46 uses the same connectivity as the runtime resource scanner. */
const PATCH_JOIN = 2

function inRegion(region: Rect, x: number, y: number): boolean {
  return rectContains(region, x, y)
}

/** The connected field containing `seeds`; touching another resource never joins it. */
export function connectedPatch(terrain: TerrainView, resource: string, seeds: Vec[], region: Rect): PatchPlan | undefined {
  const queued: Record<number, boolean> = {}
  const seen: Record<number, boolean> = {}
  const queue: Vec[] = []
  for (const p of seeds) {
    const x = math.floor(p.x)
    const y = math.floor(p.y)
    const k = tkey(x, y)
    if (!inRegion(region, x, y) || terrain.ore(x, y) !== resource || queued[k]) continue
    queued[k] = true
    queue.push({ x, y })
  }
  if (queue.length === 0) return undefined
  const tiles: number[] = []
  let x1 = queue[0].x
  let y1 = queue[0].y
  let x2 = x1 + 1
  let y2 = y1 + 1
  let qi = 0
  while (qi < queue.length) {
    const p = queue[qi++]
    const pk = tkey(p.x, p.y)
    if (seen[pk]) continue
    seen[pk] = true
    tiles.push(pk)
    x1 = math.min(x1, p.x)
    y1 = math.min(y1, p.y)
    x2 = math.max(x2, p.x + 1)
    y2 = math.max(y2, p.y + 1)
    for (let dx = -PATCH_JOIN; dx <= PATCH_JOIN; dx++) {
      for (let dy = -PATCH_JOIN; dy <= PATCH_JOIN; dy++) {
        if (dx === 0 && dy === 0) continue
        const x = p.x + dx
        const y = p.y + dy
        const k = tkey(x, y)
        if (!queued[k] && inRegion(region, x, y) && terrain.ore(x, y) === resource) {
          queued[k] = true
          queue.push({ x, y })
        }
      }
    }
  }
  tiles.sort((a, b) => a - b)
  return { resource, tiles, bounds: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } }
}

function drillEntityRect(x: number, y: number, drill: EntityFacts): Rect {
  return { x: math.floor(x - drill.tileW / 2 + 0.01), y: math.floor(y - drill.tileH / 2 + 0.01), w: drill.tileW, h: drill.tileH }
}

function miningRect(x: number, y: number, drill: EntityFacts): Rect {
  const r = drill.miningRadius ?? math.max(drill.tileW, drill.tileH) / 2
  const x1 = math.floor(x - r + 0.01)
  const y1 = math.floor(y - r + 0.01)
  return { x: x1, y: y1, w: math.ceil(x + r - 0.01) - x1, h: math.ceil(y + r - 0.01) - y1 }
}

export function candidateOk(terrain: TerrainView, resource: string, drill: EntityFacts, x: number, y: number): boolean {
  let collisionOre = false
  const er = drillEntityRect(x, y, drill)
  for (let tx = er.x; tx < er.x + er.w; tx++) {
    for (let ty = er.y; ty < er.y + er.h; ty++) {
      if (terrain.block(tx, ty) >= OWN) return false
      if (terrain.ore(tx, ty) === resource) collisionOre = true
    }
  }
  if (!collisionOre) return false
  // B6: a drill feeding a single-item line may not reach a foreign ore at all.
  const mr = miningRect(x, y, drill)
  for (let tx = mr.x; tx < mr.x + mr.w; tx++) {
    for (let ty = mr.y; ty < mr.y + mr.h; ty++) {
      const ore = terrain.ore(tx, ty)
      if (ore !== undefined && ore !== resource) return false
    }
  }
  return true
}

/**
 * M7: a drill position's check and the patch ore tiles it mines (false: no drill there), by doubled centre. The grid
 * phases of one `planWholePatch` revisit each centre (about four times), so each is read from the terrain once.
 */
type DrillSpots = Record<number, number[] | false>

function drillSpot(terrain: TerrainView, patch: PatchPlan, drill: EntityFacts, x: number, y: number, spots: DrillSpots): number[] | false {
  const key = tkey(2 * x, 2 * y)
  const known = spots[key]
  if (known !== undefined) return known
  let tiles: number[] | false = false
  if (candidateOk(terrain, patch.resource, drill, x, y)) {
    tiles = []
    const mr = miningRect(x, y, drill)
    for (let tx = mr.x; tx < mr.x + mr.w; tx++) for (let ty = mr.y; ty < mr.y + mr.h; ty++) if (terrain.ore(tx, ty) === patch.resource) tiles.push(tkey(tx, ty))
  }
  spots[key] = tiles
  return tiles
}

function addCandidate(
  terrain: TerrainView,
  patch: PatchPlan,
  drill: EntityFacts,
  axis: "x" | "y",
  lane: number,
  along: number,
  side: -1 | 1,
  drills: PlannedDrill[],
  covered: Record<number, boolean>,
  spots: DrillSpots,
): void {
  // One belt tile between the two drill columns: drill centres are (tileW + 1) / 2 from the belt centre.
  const away = (drill.tileW + 1) / 2
  const x = axis === "y" ? lane + side * away : along
  const y = axis === "y" ? along : lane + side * away
  const tiles = drillSpot(terrain, patch, drill, x, y, spots)
  if (tiles === false) return
  for (const k of tiles) covered[k] = true
  const mr = miningRect(x, y, drill)
  drills.push({ x, y, lane, side, ore: tiles.length, area: mr.w * mr.h })
}

function phasePlan(terrain: TerrainView, patch: PatchPlan, drill: EntityFacts, axis: "x" | "y", crossPhase: number, alongPhase: number, spots: DrillSpots): WholePatchMinePlan {
  const drills: PlannedDrill[] = []
  const coveredMap: Record<number, boolean> = {}
  // Repeating [drill][drill][belt][drill][drill]: derived from prototype width, not a tuned distance.
  // Two drill columns, a belt, and one outside pole tile on either side (the existing powered mine blueprint).
  const lanePitch = 2 * drill.tileW + 3
  const alongPitch = axis === "y" ? drill.tileH : drill.tileW
  const cross1 = axis === "y" ? patch.bounds.x - drill.tileW : patch.bounds.y - drill.tileH
  const cross2 = axis === "y" ? patch.bounds.x + patch.bounds.w + drill.tileW : patch.bounds.y + patch.bounds.h + drill.tileH
  const along1 = axis === "y" ? patch.bounds.y - drill.tileH : patch.bounds.x - drill.tileW
  const along2 = axis === "y" ? patch.bounds.y + patch.bounds.h + drill.tileH : patch.bounds.x + patch.bounds.w + drill.tileW
  let lane = math.floor((cross1 - crossPhase) / lanePitch) * lanePitch + crossPhase + 0.5
  while (lane <= cross2) {
    let along = math.floor((along1 - alongPhase) / alongPitch) * alongPitch + alongPhase + drill.tileH / 2
    while (along <= along2) {
      addCandidate(terrain, patch, drill, axis, lane, along, -1, drills, coveredMap, spots)
      addCandidate(terrain, patch, drill, axis, lane, along, 1, drills, coveredMap, spots)
      along += alongPitch
    }
    lane += lanePitch
  }
  drills.sort((a, b) => (a.lane !== b.lane ? a.lane - b.lane : axis === "y" ? a.y - b.y : a.x - b.x))
  const covered: number[] = []
  for (const k of patch.tiles) if (coveredMap[k]) covered.push(k)
  return { patch, axis, drills, covered }
}

function better(a: WholePatchMinePlan, b: WholePatchMinePlan | undefined): boolean {
  if (b === undefined) return true
  if (a.covered.length !== b.covered.length) return a.covered.length > b.covered.length
  if (a.drills.length !== b.drills.length) return a.drills.length > b.drills.length
  // Stable final tie-break: vertical lanes, then lexicographic first drill.
  if (a.axis !== b.axis) return a.axis === "y"
  const ad = a.drills[0]
  const bd = b.drills[0]
  if (ad === undefined) return false
  if (bd === undefined) return true
  if (ad.x !== bd.x) return ad.x < bd.x
  if (ad.y !== bd.y) return ad.y < bd.y
  // B44: two grid phases can put the same first drill on either side of a different lane. Without this the first
  // phase tried won, and phases count from absolute coordinates: the plan depended on the patch's x mod lane pitch.
  return ad.lane < bd.lane
}

/**
 * Plans the densest regular paired-row drill grid over the entire connected patch. Like OutpostPlanner, every grid
 * phase is tried; unlike the old expand strip, both dimensions participate and irregular edges simply omit drills.
 */
export function planWholePatch(terrain: TerrainView, patch: PatchPlan, drill: EntityFacts): WholePatchMinePlan {
  if (drill.type !== "mining-drill") error(`${drill.name} is not a mining drill`)
  let best: WholePatchMinePlan | undefined
  const lanePitch = 2 * drill.tileW + 3
  const spots: DrillSpots = {}
  for (const axis of ["y", "x"] as const) {
    const alongPitch = axis === "y" ? drill.tileH : drill.tileW
    for (let cross = 0; cross < lanePitch; cross++) {
      for (let along = 0; along < alongPitch; along++) {
        const p = phasePlan(terrain, patch, drill, axis, cross, along, spots)
        if (better(p, best)) best = p
      }
    }
  }
  return best!
}

/**
 * B33: the most drills one whole-patch mine can use. Every lane joins one collector and leaves through one output
 * belt, so drills past both lanes of that belt only idle (a starting iron patch holds 3-4 belts' worth). Game data:
 * the belt's lane speed and the drill's mining rate on this resource.
 */
export function beltDrillCap(facts: ProtoFacts, belt: string, drill: EntityFacts, resource: string): number {
  const perDrill = (drill.miningSpeed ?? 0.5) / (facts.resourceMiningTime(resource) ?? 1)
  return math.max(1, math.floor((2 * laneCapacity(facts, belt)) / perDrill + 1e-9))
}

/**
 * B33 / D52 (1) "or the part of it the outpost claims": the part of a whole-patch plan one mine claims when the patch
 * holds more than `cap` drills. Whole lanes, nearest to `near` across the lanes first (so the part is one contiguous
 * band of the full plan's grid, at the same maximum coverage), the last lane cut at the drills nearest `near` along
 * it, at most `maxLanes` lanes. The rest of the patch stays free for the next mine. The patch itself is kept whole
 * (the overlay outlines it).
 */
export function claimPart(plan: WholePatchMinePlan, terrain: TerrainView, drill: EntityFacts, near: Vec, cap: number, maxLanes = math.huge): WholePatchMinePlan {
  let lanes = 0
  const seenLane: Record<string, boolean> = {}
  for (const d of plan.drills) if (!seenLane[tostring(d.lane)]) { seenLane[tostring(d.lane)] = true; lanes++ }
  if (plan.drills.length <= cap && lanes <= maxLanes) return plan
  const nearCross = plan.axis === "y" ? near.x : near.y
  const nearAlong = plan.axis === "y" ? near.y : near.x
  const order: number[] = []
  for (let i = 0; i < plan.drills.length; i++) order.push(i)
  order.sort((a, b) => {
    const da = plan.drills[a]
    const db = plan.drills[b]
    const ca = math.abs(da.lane - nearCross)
    const cb = math.abs(db.lane - nearCross)
    if (ca !== cb) return ca - cb
    if (da.lane !== db.lane) return da.lane - db.lane
    const aa = math.abs((plan.axis === "y" ? da.y : da.x) - nearAlong)
    const ab = math.abs((plan.axis === "y" ? db.y : db.x) - nearAlong)
    return aa !== ab ? aa - ab : a - b
  })
  const drills: PlannedDrill[] = []
  const coveredMap: Record<number, boolean> = {}
  const taken: Record<string, boolean> = {}
  let nLanes = 0
  for (let i = 0; i < math.min(cap, order.length); i++) {
    const d = plan.drills[order[i]]
    if (!taken[tostring(d.lane)]) {
      if (nLanes >= maxLanes) break
      taken[tostring(d.lane)] = true
      nLanes++
    }
    drills.push(d)
    const mr = miningRect(d.x, d.y, drill)
    for (let tx = mr.x; tx < mr.x + mr.w; tx++) {
      for (let ty = mr.y; ty < mr.y + mr.h; ty++) if (terrain.ore(tx, ty) === plan.patch.resource) coveredMap[tkey(tx, ty)] = true
    }
  }
  drills.sort((a, b) => (a.lane !== b.lane ? a.lane - b.lane : plan.axis === "y" ? a.y - b.y : a.x - b.x))
  const covered: number[] = []
  for (const k of plan.patch.tiles) if (coveredMap[k]) covered.push(k)
  return { patch: plan.patch, axis: plan.axis, drills, covered }
}

function shifted(e: ModuleEntity, dx: number, dy: number): ModuleEntity {
  return { ...e, x: e.x + dx, y: e.y + dy }
}

function entityKey(e: ModuleEntity): string {
  return string.format("%s@%g,%g", e.name, e.x, e.y)
}

function pushUnique(out: ModuleEntity[], seen: Record<string, boolean>, e: ModuleEntity): void {
  const k = entityKey(e)
  if (seen[k]) return
  seen[k] = true
  out.push(e)
}

function dirFor(axis: "x" | "y", kind: "minus" | "plus"): 0 | 4 | 8 | 12 {
  if (axis === "y") {
    return kind === "minus" ? EAST : WEST
  }
  return kind === "minus" ? SOUTH : NORTH
}

/**
 * B90 (sweep 922c77c seed 8033112): a mine's poles must be reachable from outside it. Its claim and its margin ring (own
 * ground once built) keep any later pole off them, so some pole must be within wire reach of the first tile past the
 * ring; else no pole line can ever join the mine (its only pole sat 8 tiles deep in a splitter-collector mine: "no pole
 * path" for every later plan). When none is, link poles join the nearest one to the edge over tiles no future entity
 * takes (the footprint keeps one perimeter row for poles). Returns the poles to add.
 */
function linkPoles(footprint: { w: number; h: number }, poles: ModuleEntity[], blocked: Record<string, boolean>, facts: ProtoFacts, pole: string): ModuleEntity[] {
  if (poles.length === 0) return []
  const reach = facts.entity(pole)?.wireReach ?? 7.5
  // From a pole centre to the nearest tile centre past the margin ring (1.5 outside the footprint's edge).
  const outReach = (x: number, y: number): boolean => math.min(x + 1.5, footprint.w + 1.5 - x, y + 1.5, footprint.h + 1.5 - y) <= reach
  for (const p of poles) if (outReach(p.x, p.y)) return []
  const taken: Record<string, boolean> = {}
  for (const p of poles) taken[tileKey(math.floor(p.x), math.floor(p.y))] = true
  // Breadth-first over free tiles, from every pole, each step at most a wire's reach.
  const free: { x: number; y: number }[] = []
  for (let x = 0; x < footprint.w; x++) for (let y = 0; y < footprint.h; y++) if (!blocked[tileKey(x, y)] && !taken[tileKey(x, y)]) free.push({ x: x + 0.5, y: y + 0.5 })
  const prev: Record<number, number> = {}
  const queue: number[] = []
  const seen: Record<number, boolean> = {}
  const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= reach * reach
  for (let i = 0; i < free.length; i++) {
    for (const p of poles) {
      if (!seen[i] && near(free[i], p)) {
        seen[i] = true
        prev[i] = -1
        queue.push(i)
      }
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]
    if (outReach(free[i].x, free[i].y)) {
      const out: ModuleEntity[] = []
      for (let at = i; at !== -1; at = prev[at]) out.push({ name: pole, x: free[at].x, y: free[at].y })
      return out
    }
    for (let j = 0; j < free.length; j++) {
      if (seen[j] || !near(free[i], free[j])) continue
      seen[j] = true
      prev[j] = i
      queue.push(j)
    }
  }
  return []
}

/** The splitter of a belt's tier (game data: the vanilla tiers' names). */
function splitterFor(belt: string): string {
  for (const t of DEFAULT_TIER_NAMES) if (t.belt === belt) return t.splitter
  return "splitter"
}

function alongDir(axis: "x" | "y", sign: -1 | 1): 0 | 4 | 8 | 12 {
  return axis === "y" ? (sign < 0 ? NORTH : SOUTH) : sign < 0 ? WEST : EAST
}

function crossDir(axis: "x" | "y", sign: -1 | 1): 0 | 4 | 8 | 12 {
  return axis === "y" ? (sign < 0 ? WEST : EAST) : sign < 0 ? NORTH : SOUTH
}

function occupiedKeys(def: ModuleDef, origin: Vec, facts: ProtoFacts): number[] {
  const seen: Record<number, boolean> = {}
  const out: number[] = []
  for (const e of def.entities) {
    const r = entityRect(e, facts)
    for (let x = r.x; x < r.x + r.w; x++) {
      for (let y = r.y; y < r.y + r.h; y++) {
        const k = tkey(origin.x + x, origin.y + y)
        if (!seen[k]) { seen[k] = true; out.push(k) }
      }
    }
  }
  out.sort((a, b) => a - b)
  return out
}

/**
 * Turns a whole-patch drill grid into a fixed-port mine. Belts and poles for the entire plan are built initially;
 * only the nearest requested drills are built at first. Completing the plan adds the remaining drills without moving
 * the port, belts, poles, or any existing drill.
 */
export function materializeMinePlan(base: ModuleDef, plan: WholePatchMinePlan, facts: ProtoFacts, near: Vec, minCoverage = 0, collectorStyle?: "splitter"): MaterializedMinePlan | undefined {
  const drillName = base.params?.drill
  const belt = base.params?.belt
  if (typeof drillName !== "string" || typeof belt !== "string" || plan.drills.length === 0) return undefined
  const drill = facts.entity(drillName)
  if (drill === undefined) return undefined
  const pole = base.entities.find((e) => facts.entity(e.name)?.type === "electric-pole")?.name
  const all: ModuleEntity[] = []
  const infrastructure: ModuleEntity[] = []
  const seen: Record<string, boolean> = {}
  const lanes: Record<string, PlannedDrill[]> = {}
  for (const d of plan.drills) {
    const k = tostring(d.lane)
    ;(lanes[k] ??= []).push(d)
  }
  const laneValues: number[] = []
  for (const [k] of pairs(lanes)) laneValues.push(tonumber(k as string)!)
  laneValues.sort((a, b) => a - b)
  let minAlong = math.huge
  let maxAlong = -math.huge
  for (const lane of laneValues) {
    const ds = lanes[tostring(lane)]
    for (const d of ds) {
      const a = plan.axis === "y" ? d.y : d.x
      const half = (plan.axis === "y" ? drill.tileH : drill.tileW) / 2
      minAlong = math.min(minAlong, a - half)
      maxAlong = math.max(maxAlong, a + half)
    }
  }
  const firstLane = laneValues[0]
  const lastLane = laneValues[laneValues.length - 1]
  // P44 (b) (user, 2026-10-28): with several rows, each row but the farthest joins the collector through a splitter (a
  // side-load put every row on one lane of the output belt). The collector then lies one row further out: the row
  // between is where each row's belt turns into its splitter's second input.
  const split = collectorStyle === "splitter" && laneValues.length > 1
  const gap = split ? 2 : 1
  const lowCollector = math.floor(minAlong - gap) + 0.5
  const highCollector = math.ceil(maxAlong + gap) - 0.5
  const nearAlong = plan.axis === "y" ? near.y : near.x
  const alongSign: -1 | 1 = math.abs(nearAlong - lowCollector) <= math.abs(nearAlong - highCollector) ? -1 : 1
  const collector = alongSign < 0 ? lowCollector : highCollector
  const nearCross = plan.axis === "y" ? near.x : near.y
  const outputLane = math.abs(nearCross - firstLane) <= math.abs(nearCross - lastLane) ? firstLane : lastLane
  const crossSign: -1 | 1 = outputLane === firstLane ? -1 : 1
  const farthestLane = crossSign < 0 ? lastLane : firstLane
  // Where the output belt leaves the footprint: the output lane, or with splitters two tiles past it (its splitter, then
  // the turn out; the tile behind the turn is the splitter's empty second output, so the turn keeps both lanes).
  const outputCross = split ? outputLane + 2 * crossSign : outputLane
  const at = (cross: number, along: number, name: string, dir: 0 | 4 | 8 | 12): ModuleEntity => (plan.axis === "y" ? { name, x: cross, y: along, dir } : { name, x: along, y: cross, dir })
  const splitterAt: Record<string, boolean> = {}
  if (split) {
    const splitter = splitterFor(belt)
    for (const lane of laneValues) {
      if (lane === farthestLane) continue
      // Facing the collector's flow, over the collector tile and the turn row: its inputs are the collector belt and
      // the row's turn, its outputs the collector on and an unbuilt tile (that side backs up, so all goes on).
      splitterAt[tostring(lane + crossSign)] = true
      pushUnique(infrastructure, seen, at(lane + crossSign, collector - alongSign / 2, splitter, crossDir(plan.axis, crossSign)))
    }
  }
  // One collector belt joins every row and leaves the footprint at a fixed extreme port.
  const c1 = math.min(farthestLane, outputCross)
  const c2 = math.max(farthestLane, outputCross)
  for (let c = math.floor(c1); c <= math.floor(c2); c++) {
    if (splitterAt[tostring(c + 0.5)]) continue
    const atOutput = c === math.floor(outputCross)
    pushUnique(infrastructure, seen, at(c + 0.5, collector, belt, atOutput ? alongDir(plan.axis, alongSign) : crossDir(plan.axis, crossSign)))
  }
  for (const lane of laneValues) {
    const ds = lanes[tostring(lane)]
    let far = collector
    for (const d of ds) {
      const a = plan.axis === "y" ? d.y : d.x
      const half = (plan.axis === "y" ? drill.tileH : drill.tileW) / 2
      far = alongSign < 0 ? math.max(far, a + half) : math.min(far, a - half)
    }
    const start = math.floor(math.min(collector, far)) + 1
    const stop = math.ceil(math.max(collector, far))
    // With splitters, a row's last tile (next to the collector) turns into its splitter.
    const turnAlong = collector - alongSign
    for (let a = start; a < stop; a++) {
      const turn = split && lane !== farthestLane && a + 0.5 === turnAlong
      pushUnique(infrastructure, seen, at(lane, a + 0.5, belt, turn ? crossDir(plan.axis, crossSign) : alongDir(plan.axis, alongSign)))
    }
  }
  for (const e of infrastructure) all.push(e)
  const drillEntities: ModuleEntity[] = []
  for (const d of plan.drills) drillEntities.push({ name: drillName, x: d.x, y: d.y, dir: dirFor(plan.axis, d.side < 0 ? "minus" : "plus"), mines: plan.patch.resource })
  for (const e of drillEntities) pushUnique(all, seen, e)

  let x1 = math.huge
  let y1 = math.huge
  let x2 = -math.huge
  let y2 = -math.huge
  for (const e of all) {
    const r = entityRect(e, facts)
    x1 = math.min(x1, r.x); y1 = math.min(y1, r.y)
    x2 = math.max(x2, r.x + r.w); y2 = math.max(y2, r.y + r.h)
  }
  // Give the pole placer one perimeter tile; it then chooses a connected network covering every future drill.
  if (pole !== undefined) { x1--; y1--; x2++; y2++ }
  const origin = { x: x1, y: y1 }
  const normInfra = infrastructure.map((e) => shifted(e, -x1, -y1))
  const normDrills = drillEntities.map((e) => shifted(e, -x1, -y1))
  const footprint = { w: x2 - x1, h: y2 - y1 }
  const output = plan.axis === "y" ? { x: outputCross - x1, y: collector - y1 } : { x: collector - x1, y: outputCross - y1 }
  const wanted = math.max(1, Number(base.params?.rows ?? 1) * Number(base.params?.sides ?? 1))
  const order: number[] = []
  for (let i = 0; i < plan.drills.length; i++) order.push(i)
  // Start at the collector's output lane, then choose the closest positions to the original placement along it.
  // B33: drills whose mining area holds at least `minCoverage` ore come first (the placement's own site rule), so the
  // first stage does not start on the thin edge of the patch nearest the consumer.
  const rich = (i: number): number => {
    const d = plan.drills[i]
    return d.ore !== undefined && d.area !== undefined && d.ore < minCoverage * d.area ? 1 : 0
  }
  order.sort((a, b) => {
    const ca = math.abs(plan.drills[a].lane - outputLane)
    const cb = math.abs(plan.drills[b].lane - outputLane)
    if (ca !== cb) return ca - cb
    if (rich(a) !== rich(b)) return rich(a) - rich(b)
    const da = math.abs(plan.drills[a].x - near.x) + math.abs(plan.drills[a].y - near.y)
    const db = math.abs(plan.drills[b].x - near.x) + math.abs(plan.drills[b].y - near.y)
    return da !== db ? da - db : a - b
  })
  const chosenLanes: Record<string, number> = {}
  const initialDrills: ModuleEntity[] = []
  for (let i = 0; i < math.min(wanted, order.length); i++) {
    const n = order[i]
    initialDrills.push(normDrills[n])
    const d = plan.drills[n]
    const a = plan.axis === "y" ? d.y : d.x
    const half = (plan.axis === "y" ? drill.tileH : drill.tileW) / 2
    const far = a - alongSign * half
    chosenLanes[tostring(d.lane)] = alongSign < 0 ? math.max(chosenLanes[tostring(d.lane)] ?? collector, far) : math.min(chosenLanes[tostring(d.lane)] ?? collector, far)
  }
  let minInitialLane = outputCross
  let maxInitialLane = outputCross
  for (const [k] of pairs(chosenLanes)) {
    minInitialLane = math.min(minInitialLane, tonumber(k as string)!)
    maxInitialLane = math.max(maxInitialLane, tonumber(k as string)!)
  }
  const initialInfrastructure: ModuleEntity[] = []
  for (let i = 0; i < infrastructure.length; i++) {
    const world = infrastructure[i]
    const cross = plan.axis === "y" ? world.x : world.y
    const along = plan.axis === "y" ? world.y : world.x
    // The collector (and, with splitters, the splitters on it) as far as the farthest initial row.
    const onCollector = (along === collector || (split && along === collector - alongSign / 2)) && cross >= minInitialLane && cross <= maxInitialLane
    const laneFar = chosenLanes[tostring(cross)]
    const onChosenLane = laneFar !== undefined && (alongSign < 0 ? along > collector && along <= laneFar : along < collector && along >= laneFar)
    if (onCollector || onChosenLane) initialInfrastructure.push(normInfra[i])
  }
  // Place only the partial stage's power network now. It remains a subset of the complete stage's network: a pole
  // must never stand where the complete stage's belt layer or any drill will go (the first call's `existing` only
  // marks the partial belt subset, so the whole layer's tiles are blocked explicitly).
  const futureDrillTiles: Record<string, boolean> = {}
  for (const e of normDrills) {
    const r = entityRect(e, facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) futureDrillTiles[tileKey(x, y)] = true
  }
  const futureBlocked: Record<string, boolean> = { ...futureDrillTiles }
  for (const e of normInfra) {
    const r = entityRect(e, facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) futureBlocked[tileKey(x, y)] = true
  }
  // B55: the out port's outside tile lies in the poles' perimeter ring, and the output route starts there: no pole of
  // either stage may take it (seed 6666666: the completion's pole picked the built route's first belt up for good).
  const outPort: Port = { id: "out", kind: "belt-out", pos: output, dir: alongDir(plan.axis, alongSign), item: facts.resourceProduct(plan.patch.resource) }
  const outside = portOutsideTile(outPort)
  const outsideKey = tileKey(math.floor(outside.x), math.floor(outside.y))
  futureBlocked[outsideKey] = true
  const initialPoles = pole !== undefined ? placePoles(footprint, [...initialInfrastructure, ...initialDrills], facts, pole, futureBlocked) : []
  if (pole !== undefined) for (const e of linkPoles(footprint, initialPoles, futureBlocked, facts, pole)) initialPoles.push(e)
  for (const e of initialPoles) initialInfrastructure.push(e)
  if (pole !== undefined) {
    for (const e of initialPoles) normInfra.push(e)
    for (const e of placePoles(footprint, [...normInfra, ...normDrills], facts, pole, { [outsideKey]: true })) normInfra.push(e)
  }
  const ports: Port[] = [outPort]
  const firstPole = initialInfrastructure.find((e) => e.name === pole)
  if (firstPole !== undefined) ports.push({ id: "power", kind: "power", pos: { x: firstPole.x, y: firstPole.y }, dir: NORTH })
  const make = (id: string, entities: ModuleEntity[]): ModuleDef => finalizeModule({
    id,
    source: base.source,
    generator: base.generator,
    provenance: base.provenance,
    description: base.description,
    footprint,
    entities,
    ports,
    rotatable: false,
    mirrorable: false,
    site: "resource-patch",
    anchor: { resource: plan.patch.resource },
    params: { ...(base.params ?? {}), wholePatch: 1, ...(split ? { collector: "splitter" } : {}) },
    notes: base.notes?.filter((n) => !n.startsWith("rates:")),
  }, facts)
  const tag = split ? "/split" : ""
  const full = make(`${base.id}/whole${tag}`, [...normInfra, ...normDrills])
  const initial = make(`${base.id}/partial${tag}`, [...initialInfrastructure, ...initialDrills])
  return { initial, full, origin, claim: occupiedKeys(full, origin, facts), occupied: occupiedKeys(initial, origin, facts) }
}

/** Chooses up to `count` unbuilt drills that still reach ore; position in the original plan is irrelevant. */
export function liveGrowth(plan: WholePatchMinePlan, terrain: TerrainView, drill: EntityFacts, built: Record<number, boolean>, count: number): PlannedDrill[] {
  const out: PlannedDrill[] = []
  for (let i = 0; i < plan.drills.length && out.length < count; i++) {
    if (built[i] || !candidateOk(terrain, plan.patch.resource, drill, plan.drills[i].x, plan.drills[i].y)) continue
    out.push(plan.drills[i])
  }
  return out
}

