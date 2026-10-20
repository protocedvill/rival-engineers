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
import { tkey, Vec } from "./grid"
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

/** Checks `parts` of `layout` against the world (see the file comment). */
export function checkBuild(surface: LuaSurface, force: string, layout: LayoutState, parts: BuildParts, only?: (this: void, e: EntitySpec) => boolean): BuildCheck {
  const missing: EntitySpec[] = []
  const conflicts: PartConflict[] = []
  const seen: Record<string, boolean> = {}
  for (const e of partEntities(layout, parts)) {
    if (only !== undefined && !only(e)) continue
    if (ownBuilt(surface, force, e) !== undefined) continue
    const ghost = ownGhost(surface, force, e)
    if (ghost === undefined) missing.push(e)
    if (seen[e.owner]) continue
    const foreign = foreignEntitiesOn(surface, force, specTiles(e))
    if (foreign.length === 0) continue
    seen[e.owner] = true
    const b = foreign[0]
    conflicts.push({ kind: partKind(layout, e.owner), id: e.owner, blocker: `${b.name === "entity-ghost" ? `${b.ghost_name} ghost` : b.name} of ${b.force.name}`, at: { x: e.x, y: e.y } })
  }
  return { missing, conflicts }
}

/**
 * Makes the world follow a diff: own entities of `remove` get clear jobs (the crew picks them up and keeps the items),
 * own ghosts of it are removed; `add` gets ghosts and place jobs. Returns the new ghosts and job ids.
 */
export function applyDiff(surface: LuaSurface, faction: FactionState, remove: EntitySpec[], add: EntitySpec[], opts: { fuel?: { item: string; count: number }; priority?: number }): { ghosts: LuaEntity[]; placeJobs: number[]; clearJobs: number[]; failed: string[] } {
  const force = faction.force
  const clearJobs: number[] = []
  for (const e of remove) {
    const ghost = ownGhost(surface, force, e)
    if (ghost !== undefined) destroyEntity(ghost)
    const built = ownBuilt(surface, force, e)
    if (built !== undefined) clearJobs.push(addClearJob(faction, built, opts.priority))
  }
  const ghosts: LuaEntity[] = []
  const placeJobs: number[] = []
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
export function abandonParts(surface: LuaSurface, faction: FactionState, layout: LayoutState, parts: BuildParts, priority?: number): { tiles: number[]; clearJobs: number[]; routes: string[] } {
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
