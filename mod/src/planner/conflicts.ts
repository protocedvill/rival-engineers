// Build conflicts (M5a.2): a faction's planned parts (modules, routes, poles) checked against the world. A planned
// entity that is neither built nor a ghost of the faction is missing; a missing one, or a ghost, whose ground holds an
// entity of another force (another faction's building or ghost, a player's) is in conflict. The faction's brain
// (strategy/factory.ts) then reroutes conflicting routes (reroute.ts) or gives up a conflicting module's location
// (`abandonParts`), and the crew picks up what became useless, like a player deconstructing.

import { LuaEntity, LuaSurface } from "factorio:runtime"
import { addClearJob, addPlaceJob } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import { registerBuffer } from "../modules/buffers"
import { foreignEntitiesOn } from "../world/claims"
import { BuildParts, EntitySpec, partEntities, partTiles } from "./build-list"
import type { JobId, RouteId } from "../shared/ids"
import { keyX, keyY, tkey, Vec } from "./grid"
import { findModule, LayoutState, ripRoute, unmarkModule } from "./layout"
import { removePoleLines } from "./power"
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
}

const BELT_TYPES = ["transport-belt", "underground-belt", "splitter"]

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
    for (const b of findEntities(surface, { area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: BELT_TYPES, force })) {
      if (b.unit_number === undefined || seen[b.unit_number]) continue
      seen[b.unit_number] = true
      // The planned piece itself (B52's misdirected check handles a wrong direction of the same name).
      if (b.name === e.name && b.position.x === e.x && b.position.y === e.y) continue
      out.push(b)
    }
  }
  return out
}

/** Entity types whose direction carries the plan (a belt's flow, an inserter's pickup side). */
const DIRECTED: Record<string, boolean> = { "transport-belt": true, "underground-belt": true, splitter: true, inserter: true, loader: true, "loader-1x1": true }

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
  return findEntities(surface, { ghost_name: e.name, position: { x: e.x, y: e.y }, force, limit: 1 })[0]
}

function partKind(layout: LayoutState, owner: string): PartConflict["kind"] {
  if (layout.routes[owner] !== undefined) return "route"
  if (findModule(layout, owner) !== undefined) return "module"
  return "pole"
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

/** Checks `parts` of `layout` against the world (see the file comment). */
export function checkBuild(surface: LuaSurface, force: string, layout: LayoutState, parts: BuildParts, only?: (this: void, e: EntitySpec) => boolean): BuildCheck {
  const missing: EntitySpec[] = []
  const conflicts: PartConflict[] = []
  const misdirected: { spec: EntitySpec; entity: LuaEntity }[] = []
  const stale: { spec: EntitySpec; entities: LuaEntity[] }[] = []
  const seen: Record<string, boolean> = {}
  for (const e of partEntities(layout, parts)) {
    if (only !== undefined && !only(e)) continue
    if (ownBuilt(surface, force, e) !== undefined) {
      const wrong = ownMisdirected(surface, force, e)
      if (wrong !== undefined) misdirected.push({ spec: e, entity: wrong })
      continue
    }
    const ghost = ownGhost(surface, force, e)
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
  return { missing, conflicts, misdirected, stale }
}

/**
 * Makes the world follow a diff: own entities of `remove` get clear jobs (the crew picks them up and keeps the items),
 * own ghosts of it are removed; `add` gets ghosts and place jobs. Returns the new ghosts and job ids.
 */
export function applyDiff(surface: LuaSurface, faction: FactionState, remove: EntitySpec[], add: EntitySpec[], opts: { fuel?: { item: string; count: number }; priority?: number }): { ghosts: LuaEntity[]; placeJobs: JobId[]; clearJobs: JobId[]; failed: string[] } {
  const force = faction.force
  const clearJobs: JobId[] = []
  for (const e of remove) {
    const ghost = ownGhost(surface, force, e)
    if (ghost !== undefined) destroyEntity(ghost)
    const built = ownBuilt(surface, force, e)
    if (built !== undefined) clearJobs.push(addClearJob(faction, built, opts.priority))
  }
  const ghosts: LuaEntity[] = []
  const placeJobs: JobId[] = []
  const failed: string[] = []
  for (const e of add) {
    if (ownBuilt(surface, force, e) !== undefined) continue
    let gh = ownGhost(surface, force, e)
    if (gh === undefined) {
      const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: { x: e.x, y: e.y }, direction: e.dir, force }
      if (e.ioType !== undefined) params.type = e.ioType
      if (e.recipe !== undefined && prototypes.entity[e.name]?.type === "assembling-machine") params.recipe = e.recipe
      gh = surface.create_entity(params as never)
      if (gh !== undefined && e.buffer) registerBuffer(surface, force, gh)
    }
    if (gh === undefined) {
      failed.push(`${e.owner}: ${e.name}@${e.x},${e.y}`)
      continue
    }
    ghosts.push(gh)
    markDirty(surface.name, gh.bounding_box.left_top, gh.bounding_box.right_bottom)
    const id = addPlaceJob(faction, gh, opts)
    if (id !== undefined) placeJobs.push(id)
    else if (faction.ghostJobs[gh.unit_number!] !== undefined) placeJobs.push(faction.ghostJobs[gh.unit_number!])
  }
  return { ghosts, placeJobs, clearJobs, failed }
}

/**
 * Gives up some parts of a layout (a module location something foreign took): their own ghosts are removed, their
 * built entities get clear jobs (the crew deconstructs them and keeps the items), and they leave the layout, with the
 * routes to and from removed modules and the pole lines of removed poles. Returns the tiles freed and the clear jobs.
 */
export function abandonParts(surface: LuaSurface, faction: FactionState, layout: LayoutState, parts: BuildParts, priority?: number): { tiles: number[]; clearJobs: JobId[]; routes: RouteId[] } {
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  const routes = [...parts.routes]
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    if ((mods[r.to.module] || (r.from !== undefined && mods[r.from.module])) && routes.indexOf(rid) < 0) routes.push(rid)
  }
  const lineIds: string[] = []
  for (const p of layout.poles ?? []) if (parts.poles.indexOf(p.id) >= 0 && lineIds.indexOf(p.line) < 0) lineIds.push(p.line)
  const all: BuildParts = { modules: parts.modules, routes, poles: (layout.poles ?? []).filter((p) => lineIds.indexOf(p.line) >= 0).map((p) => p.id) }
  const tiles = partTiles(layout, all)
  const { clearJobs } = applyDiff(surface, faction, partEntities(layout, all), [], { priority })
  for (const rid of routes) ripRoute(layout, rid)
  for (const id of parts.modules) {
    const m = findModule(layout, id)
    if (m === undefined) continue
    unmarkModule(layout, m, prototypeFacts)
    layout.modules = layout.modules.filter((x) => x.id !== id)
  }
  removePoleLines(layout, lineIds)
  return { tiles, clearJobs, routes }
}
