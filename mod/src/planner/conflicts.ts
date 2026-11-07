// Build conflicts (M5a.2): a faction's planned parts (modules, routes, poles) checked against the world. A planned
// entity that is neither built nor a ghost of the faction is missing; a missing one, or a ghost, whose ground holds an
// entity of another force (another faction's building or ghost, a player's) is in conflict. The faction's brain
// (strategy/factory.ts) then reroutes conflicting routes (reroute.ts) or gives up a conflicting module's location
// (`abandonParts`), and the crew picks up what became useless, like a player deconstructing.

import { LuaEntity, LuaSurface } from "factorio:runtime"
import { addClearJob, addPlaceJob } from "../jobs/faction"
import { getJob } from "../jobs/board"
import { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import { registerBuffer } from "../modules/buffers"
import { ownGhostAt } from "../modules/stamp"
import { foreignEntitiesOn } from "../world/claims"
import { allParts, BuildParts, entityDiff, EntitySpec, partEntities, partTiles, routeEntities } from "./build-list"
import type { JobId, RouteId } from "../shared/ids"
import { ccw, DX, DY, keyX, keyY, tkey, Vec } from "./grid"
import { dependentRoutes, findModule, findPort, LayoutState, portTile, removeModule, ripRoute } from "./layout"
import { keepBridges, rehomeKeptPoles, removePoleLines } from "./power"
import { destroyEntity, markDirty } from "./terrain"
import { findEntities } from "../work"

export interface PartConflict {
  kind: "route" | "module" | "pole"
  /** Route id, module id or pole line id. */
  id: string
  /** What stands in the way (name, force, position). */
  blocker: string
  at: Vec
}

export interface BuildCheck {
  /** Planned entities with neither a built entity nor a ghost of the faction. */
  missing: EntitySpec[]
  /** Parts with a missing entity or a ghost blocked by another force's entity (one per part). */
  conflicts: PartConflict[]
  /**
   * B52: planned belts, undergrounds, splitters and inserters whose own entity of that name stands there facing another
   * way (another goal's stale copy of a rerouted route turned it): pick it up, then place the planned one.
   */
  misdirected: { spec: EntitySpec; entity: LuaEntity }[]
  /**
   * B56: planned route pieces with no own entity or ghost, standing on the faction's own belt pieces of another kind
   * or place (an older copy of a rerouted connection): the ghost can't be created over them. Pick them up, then place.
   */
  stale: { spec: EntitySpec; entities: LuaEntity[] }[]
  /**
   * B95: the faction's own undergrounds between a route's underground pair, on its line and facing its flow: the
   * entrance pairs with the nearest such exit, so the route's items surface there (sweep 3e1c4d7 seed 4819313: an old
   * route's underground between a new pair's ends; 2/s of ore made, none arriving, "nothing missing"). Pick them up.
   */
  intruders: LuaEntity[]
  /** M7c.8: with a faction given, the `missing` entities that stand as its ghost with no job to build it. */
  orphans: EntitySpec[]
}

/** True when `ghost` has a place job that can still build it (not failed, done or gone). */
function ghostHasJob(faction: FactionState, ghost: LuaEntity): boolean {
  const id = faction.ghostJobs[ghost.unit_number!]
  if (id === undefined) return false
  const j = getJob(faction.board, id)
  return j !== undefined && j.status !== "failed" && j.status !== "done"
}

const BELT_TYPES = ["transport-belt", "underground-belt", "splitter"]
/**
 * M7c.8: route pieces that block a planned piece on their tile like a stale belt does: pipes too (seed 11, minute 780:
 * an older copy of a water route left a pipe-to-ground facing west where the new route's exit goes; the new entrance
 * connected to nothing and the sulfur plant had no water for an hour, "nothing missing").
 */
const ROUTE_TYPES = [...BELT_TYPES, "pipe", "pipe-to-ground", "pump"]

/**
 * B56: the faction's own belts, undergrounds and splitters on `e`'s tiles that are not `e` itself (seed 3333: a reroute
 * planned an underground exit where the old copy's belt still stood, so its ghost was never created and the coal never
 * arrived; repairs failed on the same ghost forever).
 */
export function staleBeltsUnder(surface: LuaSurface, force: string, e: EntitySpec): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<number, boolean> = {}
  for (const k of specTiles(e)) {
    const x = keyX(k)
    const y = keyY(k)
    for (const b of findEntities(surface, { area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: ROUTE_TYPES, force })) {
      if (b.unit_number === undefined || seen[b.unit_number]) continue
      seen[b.unit_number] = true
      // The planned piece itself (B52's misdirected check handles a wrong direction of the same name).
      if (b.name === e.name && b.position.x === e.x && b.position.y === e.y) continue
      out.push(b)
    }
  }
  return out
}

/**
 * Entity types whose direction carries the plan (a belt's flow, an inserter's pickup side; M7c.8: the side a
 * pipe-to-ground goes underground, a pump's flow).
 */
const DIRECTED: Record<string, boolean> = { "transport-belt": true, "underground-belt": true, splitter: true, inserter: true, loader: true, "loader-1x1": true, "pipe-to-ground": true, pump: true }

/** B52: an own entity of `e`'s name at its position that faces another way (or is the other underground end). */
function ownMisdirected(surface: LuaSurface, force: string, e: EntitySpec): LuaEntity | undefined {
  const found = findEntities(surface, { name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]
  if (found === undefined || !DIRECTED[found.type]) return undefined
  if (found.direction !== e.dir) return found
  if (e.ioType !== undefined && found.type === "underground-belt" && found.belt_to_ground_type !== e.ioType) return found
  return undefined
}

/** Tile keys under an entity spec (its prototype's footprint at its direction). */
export function specTiles(e: EntitySpec): number[] {
  const p = prototypes.entity[e.name]
  let w = p?.tile_width ?? 1
  let h = p?.tile_height ?? 1
  if (e.dir === 4 || e.dir === 12) [w, h] = [h, w]
  const x0 = math.floor(e.x - w / 2 + 0.01)
  const y0 = math.floor(e.y - h / 2 + 0.01)
  const out: number[] = []
  for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) out.push(tkey(x, y))
  return out
}

function ownBuilt(surface: LuaSurface, force: string, e: EntitySpec): LuaEntity | undefined {
  return findEntities(surface, { name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]
}

function ownGhost(surface: LuaSurface, force: string, e: EntitySpec): LuaEntity | undefined {
  // B150/B144: a ghost of the same entity facing another way is an orphan, not the planned piece. Matching only the
  // name adopted it and its place job built a belt that carried nothing to the port.
  return ownGhostAt(surface, force, e.name, { x: e.x, y: e.y }, e.dir)
}

/** Any own ghost of the entity's name at its tile, whatever it faces (removing a piece). */
function ownGhostAny(surface: LuaSurface, force: string, e: EntitySpec): LuaEntity | undefined {
  return findEntities(surface, { ghost_name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]
}

/** Key of a planned entity: name, tile and direction (and underground end). */
export function specKey(e: EntitySpec): string {
  // Tile coordinates, like `ghostKey`: an entity spec is centred on .5, a ghost reads back with the same centre but
  // `position.x` is a float; both keys must name the tile.
  return `${e.name}@${math.floor(e.x)},${math.floor(e.y)}@${e.dir ?? 0}@${e.ioType ?? ""}`
}

/** The tile key part a ghost would have as a planned spec (its direction and underground end included). */
function ghostKey(gh: LuaEntity): string {
  // `belt_to_ground_type` errors on any entity that is not an underground belt.
  const io = gh.ghost_name === "underground-belt" ? gh.belt_to_ground_type : undefined
  return `${gh.ghost_name ?? gh.name}@${math.floor(gh.position.x)},${math.floor(gh.position.y)}@${gh.direction}@${io === "input" || io === "output" ? io : ""}`
}

/** Every entity the live layout plans, keyed by `specKey`. */
export function plannedSpecKeys(layout: LayoutState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const e of partEntities(layout, allParts(layout))) out[specKey(e)] = true
  return out
}

/** B144: remove the faction's own ghosts on `specs`' tiles that no live layout part owns (a failed add list's retry). */
export function sweepOrphanGhostsAt(surface: LuaSurface, faction: FactionState, layout: LayoutState, specs: EntitySpec[]): number {
  const planned = plannedSpecKeys(layout)
  const seen: Record<number, boolean> = {}
  let swept = 0
  for (const e of specs) for (const k of specTiles(e)) {
    const x = keyX(k)
    const y = keyY(k)
    for (const gh of findEntities(surface, { area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: "entity-ghost", force: faction.force })) {
      if (gh.unit_number === undefined || seen[gh.unit_number]) continue
      if (math.floor(gh.position.x) !== x || math.floor(gh.position.y) !== y) continue
      seen[gh.unit_number] = true
      if (planned[ghostKey(gh)] === true) continue
      const unit = gh.unit_number
      destroyEntity(gh)
      delete faction.ghostJobs[unit]
      swept++
    }
  }
  return swept
}

/** Two planned entities of different kinds/directions on one tile (a plan that cannot stand as written). */
export function overlappingSpecs(specs: EntitySpec[]): { a: EntitySpec; b: EntitySpec; tile: Vec }[] {
  const owner: Record<number, EntitySpec> = {}
  const out: { a: EntitySpec; b: EntitySpec; tile: Vec }[] = []
  for (const e of specs) {
    const key = specKey(e)
    let clash = false
    for (const k of specTiles(e)) {
      const prev = owner[k]
      if (prev !== undefined && specKey(prev) !== key) clash = true
      else if (prev === undefined) owner[k] = e
    }
    if (clash) {
      // Report against the first tile's owner (the caller only needs one tile and the two specs).
      for (const k of specTiles(e)) if (owner[k] !== undefined && specKey(owner[k]) !== key) {
        out.push({ a: owner[k], b: e, tile: { x: keyX(k), y: keyY(k) } })
        break
      }
    }
  }
  return out
}

/**
 * B144 preflight, before any ghost is created: a script-created ghost on a tile **removes** the ghost already there
 * (CLAUDE.md), so a different ghost must be found first, not after a failed create.
 *
 * - two planned pieces on one tile (`overlappingSpecs`) block the later one;
 * - an own ghost no live layout part owns is swept (an orphan of an abandoned route);
 * - an own ghost the layout does plan (another goal's piece) blocks this spec: creating over it would delete it;
 * - a live own structure/foreign entity blocks this spec (a stale belt is picked up and retried instead).
 */
export function preflightSpecs(surface: LuaSurface, faction: FactionState, layout: LayoutState, specs: EntitySpec[]): { blocked: Record<string, { reason: string; at: Vec }>; swept: number } {
  const planned = plannedSpecKeys(layout)
  const blocked: Record<string, { reason: string; at: Vec }> = {}
  const overlaps = overlappingSpecs(specs)
  for (const o of overlaps) blocked[specKey(o.b)] = { reason: `overlap with ${o.a.name} at ${o.tile.x},${o.tile.y}`, at: o.tile }
  let swept = 0
  const seen: Record<number, boolean> = {}
  for (const e of specs) {
    const key = specKey(e)
    if (blocked[key] !== undefined) continue
    for (const k of specTiles(e)) {
      const x = keyX(k)
      const y = keyY(k)
      const area = { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }
      for (const gh of findEntities(surface, { area, type: "entity-ghost", force: faction.force })) {
        if (gh.unit_number === undefined || seen[gh.unit_number]) continue
        if (math.floor(gh.position.x) !== x || math.floor(gh.position.y) !== y) continue
        seen[gh.unit_number] = true
        const gkey = ghostKey(gh)
        if (gkey === key) continue
        if (planned[gkey] === true) {
          blocked[key] = { reason: `${gh.ghost_name} ghost is another planned piece at ${x},${y}`, at: { x, y } }
          break
        }
        const unit = gh.unit_number
        destroyEntity(gh)
        delete faction.ghostJobs[unit]
        swept++
      }
      if (blocked[key] !== undefined) break
    }
  }
  return { blocked, swept }
}

export type GhostBlockerKind = "orphan" | "stale" | "planned" | "foreign" | "structure" | "none"

/**
 * B144: what stands on a failed spec's tiles. `orphan` (an own ghost no layout part owns) and `stale` (an own belt
 * piece the plan does not want there) can be removed locally and the spec retried. `planned` (another planned piece
 * already stands there: an overlap inside the plan's own add list), `foreign` (another force) and `structure` (an own
 * module or machine) cannot: the plan itself is wrong for this ground.
 */
export function ghostBlockerKind(surface: LuaSurface, faction: FactionState, layout: LayoutState, e: EntitySpec): { kind: GhostBlockerKind; at: Vec; blocker?: string } {
  const planned = plannedSpecKeys(layout)
  const want = specKey(e)
  for (const k of specTiles(e)) {
    const x = keyX(k)
    const y = keyY(k)
    const area = { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }
    for (const gh of findEntities(surface, { area, type: "entity-ghost", force: faction.force })) {
      if (math.floor(gh.position.x) !== x || math.floor(gh.position.y) !== y) continue
      const key = ghostKey(gh)
      if (key === want) continue
      return planned[key] === true
        ? { kind: "planned", at: { x, y }, blocker: `${gh.ghost_name} ghost` }
        : { kind: "orphan", at: { x, y }, blocker: `${gh.ghost_name} ghost` }
    }
    const foreign = foreignEntitiesOn(surface, faction.force, [k])
    if (foreign.length > 0) return { kind: "foreign", at: { x, y }, blocker: `${foreign[0].name} of ${foreign[0].force.name}` }
    for (const b of findEntities(surface, { area, force: faction.force })) {
      if (math.floor(b.position.x) !== x || math.floor(b.position.y) !== y) continue
      if (b.type === "entity-ghost" || b.type === "character" || b.type === "item-entity" || b.type === "item-request-proxy") continue
      if (planned[`${b.name}@${x},${y}@${b.direction}@${b.type === "underground-belt" ? b.belt_to_ground_type : ""}`] === true) continue
      return { kind: ROUTE_TYPES.indexOf(b.type) >= 0 ? "stale" : "structure", at: { x, y }, blocker: b.name }
    }
  }
  return { kind: "none", at: { x: math.floor(e.x), y: math.floor(e.y) } }
}

/**
 * B144: whether failed ghosts include a blocker a retry cannot clear. `orphan`/`stale` are retryable (the sweep or the
 * crew's clear jobs remove them); everything else means this plan is wrong for the ground and should be rejected.
 */
export function hardGhostFailure(surface: LuaSurface, faction: FactionState, layout: LayoutState, specs: EntitySpec[]): { reason: string; tiles: Vec[] } | undefined {
  const tiles: Vec[] = []
  const reasons: string[] = []
  let hard = false
  for (const e of specs) {
    const b = ghostBlockerKind(surface, faction, layout, e)
    if (b.kind === "orphan" || b.kind === "stale") continue
    // A route piece with no blocker the engine names is not a bad site: B142 reroutes those routes around the failing
    // tiles (g192: 2 route belts with no blocker rejected a 21-module plan and dropped its 45 routes).
    if (b.kind === "none" && layout.routes[e.owner] !== undefined) continue
    hard = true
    tiles.push(b.at)
    reasons.push(b.kind === "none" ? `no blocker found at ${b.at.x},${b.at.y} (terrain?)` : `${b.kind} ${b.blocker ?? "blocked"} at ${b.at.x},${b.at.y}`)
  }
  return hard ? { reason: reasons.slice(0, 4).join("; "), tiles } : undefined
}

function partKind(layout: LayoutState, owner: string): PartConflict["kind"] {
  if (layout.routes[owner] !== undefined) return "route"
  if (findModule(layout, owner) !== undefined) return "module"
  return "pole"
}

/** B144: every own belt piece under `specs` that the plan does not want there (stale route pieces on any tile). */
export function staleUnderSpecs(surface: LuaSurface, force: string, specs: EntitySpec[]): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<number, boolean> = {}
  for (const e of specs) for (const b of staleBeltsUnder(surface, force, e)) {
    if (b.unit_number === undefined || seen[b.unit_number]) continue
    seen[b.unit_number] = true
    out.push(b)
  }
  return out
}

/**
 * B56: before a build stamps its routes, the faction's own belt pieces on their tiles that are not the planned piece
 * (another kind, another place, or the same belt facing another way): the ghost could not be created over them.
 */
export function staleUnderRoutes(surface: LuaSurface, force: string, layout: LayoutState, routes: RouteId[]): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<number, boolean> = {}
  const push = (e: LuaEntity): void => {
    if (e.unit_number === undefined || seen[e.unit_number]) return
    seen[e.unit_number] = true
    out.push(e)
  }
  for (const e of partEntities(layout, { modules: [], routes, poles: [] })) {
    if (ownBuilt(surface, force, e) !== undefined) {
      const wrong = ownMisdirected(surface, force, e)
      if (wrong !== undefined) push(wrong)
      continue
    }
    for (const b of staleBeltsUnder(surface, force, e)) push(b)
  }
  return out
}

/**
 * M7c.8 (seed 11): what to check for a belt edge's routes: those routes, plus the pieces other routes stand on their
 * tiles (the splitters of taps off them and of merges onto them), which carry the edge's items too. A merge splitter
 * onto an ore branch stood unbuilt over the branch's old belt; the branch's own pieces all stood, so its repair found
 * "nothing missing" while only the merge route's check (never run: its edge looked fine) saw the stale belt.
 */
export function routeCheck(layout: LayoutState, routes: RouteId[]): { routes: RouteId[]; only?: (this: void, e: EntitySpec) => boolean } {
  const deps = dependentRoutes(layout, routes)
  if (deps.length <= routes.length) return { routes }
  const own: Record<string, boolean> = {}
  const tiles: Record<number, boolean> = {}
  for (const rid of routes) {
    own[rid] = true
    for (const k of layout.routes[rid]?.tiles ?? []) tiles[k] = true
  }
  return { routes: deps, only: (e) => own[e.owner] === true || specTiles(e).some((k) => tiles[k] === true) }
}

/**
 * Checks `parts` of `layout` against the world (see the file comment). M7c.8 (fixes-360 seed 11, minute 370): with
 * `faction`, a ghost no job will ever build is missing too (`orphans`). A mine's pole line kept 6 pole ghosts whose
 * place jobs had failed; a ghost counted as present, so every repair of the mine's power edge said "nothing missing"
 * while its 24 drills had no power.
 */
export function checkBuild(surface: LuaSurface, force: string, layout: LayoutState, parts: BuildParts, only?: (this: void, e: EntitySpec) => boolean, faction?: FactionState): BuildCheck {
  const missing: EntitySpec[] = []
  const conflicts: PartConflict[] = []
  const misdirected: { spec: EntitySpec; entity: LuaEntity }[] = []
  const stale: { spec: EntitySpec; entities: LuaEntity[] }[] = []
  const seen: Record<string, boolean> = {}
  const orphans: EntitySpec[] = []
  for (const e of partEntities(layout, parts)) {
    if (only !== undefined && !only(e)) continue
    if (ownBuilt(surface, force, e) !== undefined) {
      const wrong = ownMisdirected(surface, force, e)
      if (wrong !== undefined) misdirected.push({ spec: e, entity: wrong })
      continue
    }
    const ghost = ownGhost(surface, force, e)
    if (ghost !== undefined && faction !== undefined && !ghostHasJob(faction, ghost)) {
      missing.push(e)
      orphans.push(e)
    }
    if (ghost === undefined) {
      const under = layout.routes[e.owner] !== undefined ? staleBeltsUnder(surface, force, e) : []
      if (under.length > 0) stale.push({ spec: e, entities: under })
      else missing.push(e)
    }
    if (seen[e.owner]) continue
    const foreign = foreignEntitiesOn(surface, force, specTiles(e))
    if (foreign.length === 0) continue
    seen[e.owner] = true
    const b = foreign[0]
    conflicts.push({ kind: partKind(layout, e.owner), id: e.owner, blocker: `${b.name === "entity-ghost" ? `${b.ghost_name} ghost` : b.name} of ${b.force.name}`, at: { x: e.x, y: e.y } })
  }
  const intruders: LuaEntity[] = []
  const seenIntruder: Record<number, boolean> = {}
  for (const rid of parts.routes) {
    const r = layout.routes[rid]
    if (r === undefined) continue
    for (let i = 0; i + 1 < r.steps.length; i++) {
      const a = r.steps[i]
      const b = r.steps[i + 1]
      if (a.kind !== "ug-in" || b.kind !== "ug-out") continue
      const dx = b.x === a.x ? 0 : b.x > a.x ? 1 : -1
      const dy = b.y === a.y ? 0 : b.y > a.y ? 1 : -1
      const n = math.abs(b.x - a.x) + math.abs(b.y - a.y)
      for (let t = 1; t < n; t++) {
        const x = a.x + dx * t
        const y = a.y + dy * t
        for (const u of findEntities(surface, { area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: "underground-belt", force })) {
          if (u.unit_number === undefined || seenIntruder[u.unit_number] || u.direction !== a.dir * 4) continue
          seenIntruder[u.unit_number] = true
          intruders.push(u)
        }
      }
    }
  }
  return { missing, conflicts, misdirected, stale, intruders, orphans }
}

/** Item names on one transport line of a belt entity. */
function lineItems(e: LuaEntity, line: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const it of e.get_transport_line(line).get_contents()) out[it.name] = true
  return out
}

/**
 * B107: the module's own belts downstream of its input port `port` (followed in the world, inside the module's rect)
 * where another of its input items fills both lanes: the port's item has no lane left there. Sweep 628fa29 seed
 * 1264816: a smelter column grew, its fuel arrived before the new ore side-load belt stood, the merge tile curved and
 * put coal on both lanes; 10 of 12 furnaces never saw ore again and every repair said "nothing missing". Picking the
 * belts up and placing them again empties them.
 *
 * B124 (soak m7c-cont8 seed 11, min 720): also belts holding an item that does not belong there at all: on those module
 * belts, an item that is none of the module's belt inputs (iron plates on an iron smelter's ore belt); on the edge's own
 * `routes`, any item but the route's (iron ore and iron plates stranded on coal lanes, 4 per lane, no source upstream).
 * Nothing takes such an item off its lane, so it stops the lane for good: 122 furnaces and 76 drills sat blocked while
 * their consumers starved, and every repair said "nothing missing".
 */
export function cloggedBelts(surface: LuaSurface, force: string, layout: LayoutState, module: string, port: string, routes: RouteId[] = []): { spec: EntitySpec; entity: LuaEntity }[] {
  const out: { spec: EntitySpec; entity: LuaEntity }[] = []
  const seen: Record<number, boolean> = {}
  const routeSet: Record<string, boolean> = {}
  const routeTiles: Record<number, boolean> = {}
  for (const rid of routes) {
    routeSet[rid] = true
    for (const k of layout.routes[rid]?.tiles ?? []) routeTiles[k] = true
  }
  for (const spec of routeEntities(layout)) {
    if (BELT_TYPES.indexOf(prototypes.entity[spec.name]?.type ?? "") < 0) continue
    // B126 (m7c-cont12 seed 11, minute 780): a branch's merge splitter stands on the trunk's tile but belongs to the
    // branch route. Coal stranded in it could only leave by its branch-side output (B125 filters the trunk item to the
    // trunk side), which has no belt: it held the trunk's ore lane for good. Pieces on the edge's tiles count too.
    if (!routeSet[spec.owner] && !specTiles(spec).some((k) => routeTiles[k] === true)) continue
    const item = spec.carries
    if (item === undefined) continue
    for (const e of findEntities(surface, { position: { x: spec.x, y: spec.y }, type: BELT_TYPES, force, limit: 1 })) {
      if (e.unit_number === undefined || seen[e.unit_number]) continue
      if (foreignOn(e, (name) => name === item)) {
        seen[e.unit_number] = true
        out.push({ spec, entity: e })
      }
    }
  }
  const m = findModule(layout, module)
  const p = m !== undefined ? findPort(m, port) : undefined
  if (m === undefined || p === undefined || p.kind !== "belt-in" || p.item === undefined) return out
  const others: Record<string, boolean> = {}
  const inputs: Record<string, boolean> = {}
  const outTiles: Record<number, boolean> = {}
  for (const q of m.def.ports) {
    if (q.kind === "belt-in" && q.item !== undefined) {
      inputs[q.item] = true
      if (q.item !== p.item) others[q.item] = true
    }
    if (q.kind === "belt-out") {
      const ot = portTile(m, q)
      outTiles[tkey(ot.x, ot.y)] = true
    }
  }
  const specs: Record<string, EntitySpec> = {}
  for (const e of partEntities(layout, { modules: [m.id], routes: [], poles: [] })) specs[string.format("%s@%g,%g", e.name, e.x, e.y)] = e
  const inside = (e: LuaEntity): boolean => e.position.x > m.rect.x && e.position.x < m.rect.x + m.rect.w && e.position.y > m.rect.y && e.position.y < m.rect.y + m.rect.h
  const t = portTile(m, p)
  let todo = findEntities(surface, { position: { x: t.x + 0.5, y: t.y + 0.5 }, type: BELT_TYPES, force, limit: 1 })
  while (todo.length > 0) {
    const e = todo.pop()!
    if (!e.valid || e.unit_number === undefined || seen[e.unit_number] || !inside(e)) continue
    // The input belt ends where the module's output starts (a belt-out port): its items belong there.
    if (outTiles[tkey(math.floor(e.position.x), math.floor(e.position.y))]) continue
    seen[e.unit_number] = true
    const spec = specs[string.format("%s@%g,%g", e.name, e.position.x, e.position.y)]
    if (spec !== undefined) {
      const a = lineItems(e, 1)
      const b = lineItems(e, 2)
      let bad = foreignOn(e, (name) => inputs[name] === true)
      for (const [item] of pairs(others)) if (a[item] && b[item]) bad = true
      if (bad) out.push({ spec, entity: e })
    }
    if (e.type === "underground-belt" && e.belt_to_ground_type === "input") {
      const n = e.neighbours as LuaEntity | undefined
      if (n !== undefined) todo.push(n)
    } else for (const o of e.belt_neighbours.outputs) todo.push(o)
  }
  return out
}

/** B124: whether any transport line of belt `e` holds an item `belongs` rejects. */
function foreignOn(e: LuaEntity, belongs: (this: void, name: string) => boolean): boolean {
  for (let i = 1; i <= e.get_max_transport_line_index(); i++) for (const it of e.get_transport_line(i).get_contents()) if (!belongs(it.name)) return true
  return false
}

/**
 * Makes the world follow a diff: own entities of `remove` get clear jobs (the crew picks them up and keeps the items),
 * own ghosts of it are removed; `add` gets ghosts and place jobs. Returns the new ghosts and job ids.
 */
/**
 * B101 (sweep 628fa29 seed 7718665): trees and rocks in the way of entities about to be placed. A tree centred in the
 * next tile can reach into a planned entity's box (0.15 of a belt tile there); its ghost then never revives. The box is
 * the prototype's collision box at the spec's place, turned for east/west.
 */
export function obstaclesFor(surface: LuaSurface, specs: EntitySpec[]): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<string, boolean> = {}
  for (const e of specs) {
    const box = prototypes.entity[e.name]?.collision_box
    if (box === undefined) continue
    const turned = e.dir === 4 || e.dir === 12
    const x1 = turned ? -box.right_bottom.y : box.left_top.x
    const x2 = turned ? -box.left_top.y : box.right_bottom.x
    const y1 = turned ? box.left_top.x : box.left_top.y
    const y2 = turned ? box.right_bottom.x : box.right_bottom.y
    const area = { left_top: { x: e.x + math.min(x1, x2), y: e.y + math.min(y1, y2) }, right_bottom: { x: e.x + math.max(x1, x2), y: e.y + math.max(y1, y2) } }
    for (const o of findEntities(surface, { area, type: ["tree", "simple-entity"] })) {
      const id = `${o.name}@${o.position.x},${o.position.y}`
      if (seen[id]) continue
      seen[id] = true
      out.push(o)
    }
  }
  return out
}

export function applyDiff(surface: LuaSurface, faction: FactionState, remove: EntitySpec[], add: EntitySpec[], opts: { fuel?: { item: string; count: number }; priority?: number }, layout?: LayoutState): { ghosts: LuaEntity[]; placeJobs: JobId[]; clearJobs: JobId[]; failed: string[]; failedSpecs: EntitySpec[] } {
  const force = faction.force
  const clearJobs: JobId[] = []
  for (const e of remove) {
    // Removing a piece must find its ghost whatever way it faces (a turned orphan still occupies the tile).
    const ghost = ownGhostAny(surface, force, e)
    if (ghost !== undefined) destroyEntity(ghost)
    const built = ownBuilt(surface, force, e)
    if (built !== undefined) clearJobs.push(addClearJob(faction, built, opts.priority))
  }
  const ghosts: LuaEntity[] = []
  const placeJobs: JobId[] = []
  const failed: string[] = []
  const failedSpecs: EntitySpec[] = []
  // B144: find blockers before creating anything. Creating a ghost over a different ghost deletes that ghost (an engine
  // fact), so creation must not be the first time we look.
  const pre = layout !== undefined ? preflightSpecs(surface, faction, layout, add) : undefined
  for (const e of add) {
    if (ownBuilt(surface, force, e) !== undefined) continue
    const key = specKey(e)
    if (pre !== undefined && pre.blocked[key] !== undefined) {
      failed.push(`${e.owner}: ${e.name}@${e.x},${e.y}`)
      failedSpecs.push(e)
      continue
    }
    let gh: LuaEntity | undefined
    // B144: at most two local rounds. An orphan ghost of a different type on the tile (an abandoned route's, or one
    // this add list's earlier piece created) is removed; any other blocker is left for the caller's retry or rejection.
    for (let round = 0; round < 2 && gh === undefined; round++) {
      gh = ownGhost(surface, force, e)
      // M7c.8: a ghost whose place job failed or ended keeps no job: forget it so this one places it again.
      if (gh !== undefined && !ghostHasJob(faction, gh)) delete faction.ghostJobs[gh.unit_number!]
      if (gh !== undefined) break
      if (layout !== undefined) {
        const blocker = ghostBlockerKind(surface, faction, layout, e)
        if (blocker.kind === "planned" || blocker.kind === "foreign" || blocker.kind === "structure") break
        if (blocker.kind === "stale") {
          // Own built belt pieces the plan does not want there: the crew picks them up first (B56). The retry stamps it.
          for (const b of staleBeltsUnder(surface, force, e)) addClearJob(faction, b, opts.priority)
          break
        }
        if (blocker.kind === "orphan") {
          if (sweepOrphanGhostsAt(surface, faction, layout, [e]) === 0) break
          continue
        }
      }
      const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: { x: e.x, y: e.y }, direction: e.dir, force }
      if (e.ioType !== undefined) params.type = e.ioType
      if (e.recipe !== undefined && prototypes.entity[e.name]?.type === "assembling-machine") params.recipe = e.recipe
      gh = surface.create_entity(params as never)
      if (gh !== undefined && e.buffer) registerBuffer(surface, force, gh)
    }
    if (gh === undefined) {
      failed.push(`${e.owner}: ${e.name}@${e.x},${e.y}`)
      failedSpecs.push(e)
      continue
    }
    ghosts.push(gh)
    markDirty(surface.name, gh.bounding_box.left_top, gh.bounding_box.right_bottom)
  }
  // B144: two-phase stamp. No place jobs until every ghost of this add list stands; otherwise a partial stamp would
  // start the crew building a plan that can never complete, and a later retry would have nothing to re-create. The
  // successful ghosts stay for the retry (ownGhostAt reuses them).
  if (failed.length === 0) for (const gh of ghosts) {
    const id = addPlaceJob(faction, gh, opts)
    if (id !== undefined) placeJobs.push(id)
    else if (ghostHasJob(faction, gh)) placeJobs.push(faction.ghostJobs[gh.unit_number!])
  }
  return { ghosts, placeJobs, clearJobs, failed, failedSpecs }
}

/**
 * Gives up some parts of a layout (a module location something foreign took): their own ghosts are removed, their
 * built entities get clear jobs (the crew deconstructs them and keeps the items), and they leave the layout, with the
 * routes to and from removed modules and the pole lines of removed poles. Returns the tiles freed and the clear jobs.
 */
/** B102: kept route pieces a dropped splitter stood on, ghosted once that splitter's clear job is over (`jobs/crew.ts`). */
function restoreUnderSplitters(faction: FactionState, specs: EntitySpec[], clearJobs: JobId[], priority?: number): void {
  for (const e of specs) {
    const after: JobId[] = []
    for (const id of clearJobs) {
      const j = getJob(faction.board, id)
      const t = j !== undefined && j.payload.kind === "clear" ? j.payload.target : undefined
      if (t === undefined || !t.valid || t.type !== "splitter") continue
      const b = t.bounding_box
      if (e.x > b.left_top.x && e.x < b.right_bottom.x && e.y > b.left_top.y && e.y < b.right_bottom.y) after.push(id)
    }
    faction.pendingGhosts ??= []
    faction.pendingGhosts.push({ name: e.name, x: e.x, y: e.y, dir: e.dir, ioType: e.ioType, after, priority, owner: e.owner })
  }
}

export function abandonParts(surface: LuaSurface, faction: FactionState, layout: LayoutState, parts: BuildParts, priority?: number): { tiles: number[]; clearJobs: JobId[]; routes: RouteId[]; keptPoles: number } {
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  const routes = [...parts.routes]
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    if ((mods[r.to.module] || (r.from !== undefined && mods[r.from.module])) && routes.indexOf(rid) < 0) routes.push(rid)
  }
  const lineIds: string[] = []
  for (const p of layout.poles ?? []) if (parts.poles.indexOf(p.id) >= 0 && lineIds.indexOf(p.line) < 0) lineIds.push(p.line)
  // B63 (bridge rule): a pole that is the only path from a generator to a module that stays is not removed with the
  // abandoned ground. A line passing through it can carry everything behind it (3891760: 91 modules on a 17-tile gap).
  const bridge = keepBridges(layout, prototypeFacts, lineIds, parts.modules)
  const all: BuildParts = { modules: parts.modules, routes, poles: (layout.poles ?? []).filter((p) => bridge.dropLines.indexOf(p.line) >= 0).map((p) => p.id) }
  const keepTiles: Record<number, boolean> = {}
  for (const k of bridge.keepPoles) keepTiles[k.key] = true
  const going: EntitySpec[] = []
  for (const e of partEntities(layout, all)) if (keepTiles[tkey(math.floor(e.x), math.floor(e.y))] !== true) going.push(e)
  const tiles = partTiles(layout, all)
  const { clearJobs } = applyDiff(surface, faction, going, [], { priority }, layout)
  // B102 (sweep 628fa29 seed 1264816): a dropped tap's or merge's splitter stood on a kept route's tile in place of its
  // belt. Once the splitter is picked up, that belt goes back (else the kept route has a hole: cluster 2's ore stopped
  // there for 300 game-min).
  const dropped: Record<string, boolean> = {}
  for (const rid of routes) dropped[rid] = true
  const keptBefore = routeEntities(layout).filter((e) => !dropped[e.owner])
  for (const rid of routes) ripRoute(layout, rid)
  const restore = entityDiff(keptBefore, routeEntities(layout)).add
  if (restore.length > 0) restoreUnderSplitters(faction, restore, clearJobs, priority)
  for (const id of parts.modules) removeModule(layout, id, prototypeFacts)
  removePoleLines(layout, bridge.dropLines)
  rehomeKeptPoles(layout, bridge.keepPoles)
  return { tiles, clearJobs, routes, keptPoles: bridge.keepPoles.length }
}

// B125 (seed 11, soak m7c-cont10): a provider-group merge splitter (`Route.mergeSplitter`) replaces the trunk tile and
// the branch tile beside it. Its trunk-side output carries the joined flow on; its branch-side output faces whatever
// stands in front of the branch tile. At (470,-36) that was a coal route: half of the merged iron plates went onto the
// coal line, stranded there and stopped the iron smelters' fuel (B124 emptied the same 65 belts three times).
// A player sets such a splitter's filter to the item and its output priority to the trunk side: every item then leaves
// on the trunk side and waits there when the trunk is full; nothing ever leaves through the branch side.


/** The trunk side of a merge splitter facing `dir` (planner directions) with its trunk tile at x,y and branch at x2,y2. */
export function mergeTrunkSide(ms: { x: number; y: number; dir: number; x2: number; y2: number }): "left" | "right" {
  const l = ccw(ms.dir)
  return ms.x - ms.x2 === DX[l] && ms.y - ms.y2 === DY[l] ? "left" : "right"
}

/** The tile a merge splitter's branch-side output faces (planner tile coordinates). */
export function mergeBranchOutlet(ms: { dir: number; x2: number; y2: number }): { x: number; y: number } {
  return { x: ms.x2 + DX[ms.dir], y: ms.y2 + DY[ms.dir] }
}

function beltOn(surface: LuaSurface, force: string, x: number, y: number): boolean {
  return findEntities(surface, { position: { x: x + 0.5, y: y + 0.5 }, type: BELT_TYPES, force, limit: 1 }).length > 0
}

/**
 * Sets every built merge splitter's filter (its route's item) and output priority (the trunk side). Returns how many it
 * changed.
 *
 * B129 (m7c-cont12 seed 11): a merge splitter whose branch-side outlet has no belt is *meant* to have that outlet back
 * up, so the splitter sends everything down the trunk. B125's filter breaks that: with a filter, everything that is not
 * the route's item goes to the *other* (branch-side) output, where it sticks for good (B126 found and emptied it). Only
 * set the filter when something can actually leave through that side; otherwise clear it and let the dead outlet back up.
 */
export function tuneMergeSplitters(surface: LuaSurface, force: string, layout: LayoutState): number {
  let changed = 0
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    const ms = r?.mergeSplitter
    if (r === undefined || ms === undefined || r.fluid !== undefined) continue
    const x = (ms.x + ms.x2) / 2 + 0.5
    const y = (ms.y + ms.y2) / 2 + 0.5
    const side = mergeTrunkSide(ms)
    const out = mergeBranchOutlet(ms)
    const live = beltOn(surface, force, out.x, out.y)
    for (const e of findEntities(surface, { position: { x, y }, type: "splitter", force, limit: 1 }) as LuaEntity[]) {
      if (!live) {
        if (e.splitter_filter === undefined && e.splitter_output_priority === "none") continue
        e.splitter_filter = undefined as never
        e.splitter_output_priority = "none"
        changed++
        continue
      }
      const fl = e.splitter_filter
      // Read back, the filter's name is a prototype in the typings but a plain string in 2.0.77: accept both.
      const n = fl === undefined || typeof fl === "string" ? fl : (fl.name as unknown as string | { name: string } | undefined)
      const have = n === undefined || typeof n === "string" ? n : n.name
      if (have === r.item && e.splitter_output_priority === side) continue
      e.splitter_filter = { name: r.item } as never
      e.splitter_output_priority = side
      changed++
    }
  }
  return changed
}
