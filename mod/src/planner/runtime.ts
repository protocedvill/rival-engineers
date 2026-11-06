// Planner at runtime: layout jobs in `storage`, stepped every tick under budget (§5.6): the terrain model scans the
// region (terrainChunksPerTick), then the plan job places and routes (plannerWorkPerTick work units). A finished plan
// becomes a build through the Job Board: clear jobs for trees and rocks first (the controller won't mine where a
// ghost is selected), then ghosts on the faction's force with place (and fuel) jobs, so the crew build it physically.
// The Factory Graph of a plan is exported to JSON for tools/render (D29).

import { evictableTiles } from "../strategy/evict"
import type { JobId } from "../shared/ids"
import { hardGhostFailure, preflightSpecs, staleUnderRoutes, staleUnderSpecs, tuneMergeSplitters } from "./conflicts"

export { tuneMergeSplitters }
import { LuaEntity, LuaSurface } from "factorio:runtime"
import { Config, getConfig } from "../config"
import { getJob } from "../jobs/board"
import { addClearJob, addPlaceJob, clearJobFor, getFaction } from "../jobs/faction"
import type { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import { ownGhostAt, stampModule } from "../modules/stamp"
import { registerBuffer } from "../modules/buffers"
import { allParts, BuildParts, EntitySpec, layoutTiles, partEntities, partTiles, routeEntities } from "./build-list"
import { beltTiers, BeltTier, tierByBelt } from "./capacity"
import { buildGraph, FactoryGraph } from "./graph"
import { claimed, otherClaims, otherOreFields } from "../world/claims"
import { FOREIGN, FREE, keyX, keyY, OWN, ROCK, TerrainView, tkey, TREE, Vec } from "./grid"
import { isPoleTag, LayoutState } from "./layout"
import { newPlanJob, PlanJob, PlanRequest, stepPlan } from "./plan"
import { LayoutPolicy, selectPolicy } from "./policy"
import { markDirty, newTerrain, requestArea, stepTerrain, terrainReady, terrainView } from "./terrain"
import { chunkKnown, KnownGround } from "../strategy/arms"
import { countWork, findEntities } from "../work"

export interface BuildState {
  /**
   * `poles` (D71 b): the plan's new pole-line poles are placed before anything is cleared, so a pole line the plan
   * evicts is picked up only once its replacement stands (make before break); `clear`, then `place`.
   */
  phase: "poles" | "clear" | "place" | "done"
  faction: string
  clearJobs: JobId[]
  placeJobs: JobId[]
  fuel?: { item: string; count: number }
  priority?: number
  failed: string[]
  /** B138: specs whose ghost could not be created this attempt (retried with backoff, then rerouted/relocated). */
  failedSpecs?: EntitySpec[]
  /** B138: earliest tick to retry a failed ghost creation. */
  retryAt?: number
  /** B144: a failed ghost whose blocker a retry cannot clear (terrain, foreign, or an overlap in the plan's own list). */
  hard?: string
  /** B144: the tiles behind `hard`, for the bad-build ledger. */
  badTiles?: Vec[]
  /** Build only these parts (a plan on top of a base); absent: everything in the layout. */
  parts?: BuildParts
  /** B23: entities of a completed shared mine (a base module not in `parts`); ghosted after the clear. */
  extraAdd?: EntitySpec[]
  /** Ghosts created (for re-planning their place jobs if jobs get dropped). */
  ghosts?: LuaEntity[]
  /** B69: tapped belts (unit numbers) picked up after another build finished them. */
  tapCleared?: Record<number, boolean>
  /** D71 (b): place jobs of the replacement poles (`poles` phase), and the evicted poles cleared once they are done. */
  poleJobs?: JobId[]
  breakAfter?: LuaEntity[]
}

export interface PlannerEntry {
  id: string
  surface: string
  force: string
  faction?: string
  terrain: string
  phase: "scan" | "plan" | "done" | "failed"
  request: PlanRequest
  /** Policy id ("auto" or empty: from config). */
  policy?: string
  belt: string
  job?: PlanJob
  startTick: number
  scanTicks: number
  planTicks: number
  build?: BuildState
  /** The terrain belongs to someone else (a faction's): removePlan keeps it. */
  sharedTerrain?: boolean
  /** Plan on top of this faction's base layout (storage.factories[name].layout), and keep off its bootstrap sites. */
  baseFaction?: string
  /** Max underground distance override (1 = no undergrounds: `logistics` not researched yet). */
  maxUnderground?: number
  /** Topology override for this plan (B2: a goal whose producers feed several consumers through splitter taps). */
  topology?: string
}

declare global {
  interface RivalEngineersStorage {
    planner?: { entries: Record<string, PlannerEntry>; order: string[] }
  }
}

function planner(): { entries: Record<string, PlannerEntry>; order: string[] } {
  storage.planner ??= { entries: {}, order: [] }
  return storage.planner
}

export function getPlannerEntry(id: string): PlannerEntry | undefined {
  return planner().entries[id]
}

export function entryPolicy(entry: PlannerEntry): LayoutPolicy {
  const c = getConfig()
  const p = basePolicy(entry, c)
  const k = entry.request.windowScale ?? 1
  if (k !== 1) p.router = { ...p.router, margin: math.floor(p.router.margin * k) }
  return p
}

function basePolicy(entry: PlannerEntry, c: Config): LayoutPolicy {
  return selectPolicy(entry.policy ?? c.layoutPolicy, { modules: entry.request.modules.length }, {
    corridorMin: c.layoutCorridorMin,
    corridorPreferred: c.layoutCorridorPreferred,
    topology: entry.topology ?? c.layoutTopology,
    utilization: c.beltUtilization,
    smelting: c.layoutSmelting,
    placementSoftClaim: c.plannerPlacementSoftClaim,
    routerSoftClaim: c.plannerRouterSoftClaim,
    routerSoftClaimDecay: c.plannerRouterSoftClaimDecay,
    routerBundleFactor: c.plannerRouterBundleFactor,
    placementGrowthBand: c.plannerPlacementGrowthBand,
    placementGrowthBandUnits: c.plannerPlacementGrowthBandUnits,
    placementGrowthBlocked: c.plannerPlacementGrowthBlocked,
    poleEvict: c.plannerPoleEvictCost,
    placementNewField: c.plannerPlacementNewField,
  })
}

export function tiers(): BeltTier[] {
  return beltTiers(prototypeFacts)
}

export interface StartPlanOptions {
  id: string
  surface: string
  force: string
  faction?: string
  request: PlanRequest
  policy?: string
  belt?: string
  /** Reuse this terrain model (e.g. the faction's) instead of a new one; it is kept when the plan is removed. */
  terrain?: string
  baseFaction?: string
  maxUnderground?: number
  topology?: string
  /** D62: scan only this ground of the region (home zone, explored strips, charted chunks); all of it when unset. */
  known?: KnownGround
}

/** Starts a layout job: scan the request's region, then place and route, all under the per-tick budgets. */
export function startPlan(o: StartPlanOptions): PlannerEntry {
  const p = planner()
  if (p.entries[o.id] !== undefined) error(`planner job ${o.id} exists`)
  const t = (o.terrain !== undefined ? storage.terrains?.[o.terrain] : undefined) ?? newTerrain(`plan:${o.id}`, o.surface, o.force)
  const known = o.known
  if (known !== undefined) {
    const force = game.forces[o.force]
    const surface = game.surfaces[o.surface]
    requestArea(t, o.request.region, (cx, cy) => chunkKnown(cx, cy, known, (x, y) => force !== undefined && surface !== undefined && force.is_chunk_charted(surface, { x, y })))
  } else requestArea(t, o.request.region)
  const entry: PlannerEntry = {
    id: o.id,
    surface: o.surface,
    force: o.force,
    faction: o.faction,
    terrain: t.id,
    phase: "scan",
    request: o.request,
    policy: o.policy,
    belt: o.belt ?? "transport-belt",
    startTick: game.tick,
    scanTicks: 0,
    planTicks: 0,
    sharedTerrain: o.terrain !== undefined,
    baseFaction: o.baseFaction,
    maxUnderground: o.maxUnderground,
    topology: o.topology,
  }
  p.entries[o.id] = entry
  p.order.push(o.id)
  return entry
}

export function removePlan(id: string): void {
  const p = planner()
  const e = p.entries[id]
  delete p.entries[id]
  const i = p.order.indexOf(id)
  if (i >= 0) p.order.splice(i, 1)
  if (storage.terrains && !(e?.sharedTerrain ?? false)) delete storage.terrains[`plan:${id}`]
}

/**
 * The terrain as a plan of a faction sees it: tiles its burner bootstrap reserved (sites and their margins) count as
 * its own structures, except tiles the faction's planned base already uses (the base layout blocks those itself).
 * Tiles another faction on the surface claimed (world/claims.ts) count as foreign structures.
 */
export function factionView(entry: PlannerEntry, base: TerrainView): TerrainView {
  return claimView(entry.baseFaction, entry.surface, base)
}

/** `factionView` for faction `name` on `surface`; with `ownReserved` false, only other factions' claims. */
export function claimView(name: string | undefined, surface: string, base: TerrainView, ownReserved = true): TerrainView {
  const faction = name !== undefined ? storage.factions[name] : undefined
  const reserved = ownReserved ? faction?.brain?.reserved : undefined
  const others = name !== undefined ? otherClaims(name, surface) : []
  const fields = name !== undefined ? otherOreFields(name, surface) : []
  // B15 / D51: the faction's own bootstrap mining sites are clearable ground (evicted when a plan takes it).
  const evictable = evictableTiles(faction?.brain)
  const layout = name !== undefined ? storage.factories?.[name]?.layout : undefined
  const poles = (layout?.poles?.length ?? 0) > 0
  if (reserved === undefined && others.length === 0 && evictable === undefined && !poles) return base
  return {
    block: (x, y) => {
      // B37: the faction's own pole-line poles (built or ghosts) are clearable ground: the layout's pole tag carries
      // the eviction cost, and a plan that takes the tile evicts the line.
      if (poles && isPoleTag(layout!.occ[tkey(x, y)]) && base.block(x, y) === OWN) return FREE
      if (evictable !== undefined && evictable[tkey(x, y)] && (layout === undefined || (layout.occ[tkey(x, y)] === undefined && layout.routeOcc[tkey(x, y)] === undefined))) {
        const raw = base.block(x, y)
        if (raw === FREE || raw === TREE || raw === ROCK || raw === OWN) return TREE
      }
      const b = base.block(x, y)
      if (b !== FREE && b !== TREE && b !== ROCK) return b
      const k = tkey(x, y)
      if (others.length > 0 && claimed(others, k)) return FOREIGN
      if (reserved === undefined || !reserved[k]) return b
      if (layout !== undefined && (layout.occ[k] !== undefined || layout.routeOcc[k] !== undefined || layout.reserved[k] !== undefined || layout.mine?.[k] !== undefined)) return b
      return OWN
    },
    // D46: ore of another faction's field is not this faction's resource (a drill reaching it is refused, B6).
    ore: (x, y) => {
      const o = base.ore(x, y)
      if (o !== undefined && fields.length > 0 && claimed(fields, tkey(x, y))) return `claimed:${o}`
      return o
    },
    oreTiles:
      base.oreTiles !== undefined
        ? (resource, rect) => (fields.length > 0 ? base.oreTiles!(resource, rect).filter((k) => !claimed(fields, k)) : base.oreTiles!(resource, rect))
        : undefined,
    stamp: base.stamp,
  }
}

/** One tick of one planner job; `budget`: its share of the planner's work this tick (default: all of it). */
export function stepEntry(entry: PlannerEntry, budget?: number): void {
  const c = getConfig()
  const t = storage.terrains?.[entry.terrain]
  if (t === undefined) return
  if (entry.phase === "scan") {
    entry.scanTicks++
    stepTerrain(t, c.terrainChunksPerTick)
    if (terrainReady(t)) {
      let all = tiers()
      if (entry.maxUnderground !== undefined) all = all.map((x) => ({ ...x, maxUnderground: math.min(x.maxUnderground, entry.maxUnderground!) }))
      const tier = tierByBelt(all, entry.belt) ?? all[0]
      const base = entry.baseFaction !== undefined ? storage.factories?.[entry.baseFaction]?.layout : undefined
      entry.job = newPlanJob(entry.request, tier, base, all)
      entry.phase = "plan"
    }
    return
  }
  if (entry.phase === "plan") {
    entry.planTicks++
    // Rescans of dirty chunks keep running under budget while planning.
    stepTerrain(t, c.terrainChunksPerTick)
    const st = entry.job!.stats
    const w0 = st.work
    const c0 = st.candidates ?? 0
    const e0 = st.expansions
    const finished = stepPlan(entry.job!, factionView(entry, terrainView(t)), prototypeFacts, entryPolicy(entry), budget ?? c.plannerWorkPerTick)
    countWork("plannerWork", st.work - w0)
    countWork("placementCandidates", (st.candidates ?? 0) - c0)
    countWork("routerExpansions", st.expansions - e0)
    if (finished) entry.phase = entry.job!.phase === "done" ? "done" : "failed"
    // Soaks (frame dumps on): a plan still planning after a game-minute is captured once, so a slow plan can be replayed
    // and profiled whether it is adopted or not.
    else if (entry.planTicks === SLOW_PLAN_TICKS && c.frameDumpIntervalTicks > 0) exportPlanInput(entry, `rival-engineers/plans/slow/${entry.id}-t${game.tick}.input.lua`, 3000)
    return
  }
  if (entry.build !== undefined && entry.build.phase !== "done") stepBuild(entry)
}

/** Plans still planning after this many ticks have their input captured in soaks (`plans/slow/`). */
const SLOW_PLAN_TICKS = 3600

/**
 * The planner's work budget (`planner-work-per-tick`) is the whole mod's, shared by the jobs planning this tick (user,
 * 2026-10-20): each gets an equal share of what is left, and work a job doesn't use passes to the next. A job planning
 * alone gets all of it.
 */
export function onPlannerTick(): void {
  const p = storage.planner
  if (p === undefined) return
  let left = getConfig().plannerWorkPerTick
  let planning = 0
  for (const id of p.order) if (p.entries[id]?.phase === "plan") planning++
  for (const id of p.order) {
    const e = p.entries[id]
    if (e === undefined) continue
    if (e.phase !== "plan") {
      stepEntry(e)
      continue
    }
    const share = math.max(1, math.floor(left / planning))
    const w0 = e.job!.stats.work
    stepEntry(e, share)
    left = math.max(0, left - (e.job!.stats.work - w0))
    planning--
  }
}

// ---------------------------------------------------------------------------------------------------------
// Building

/** Trees and rocks on the tiles a layout (or some of its parts) builds on. */
export function obstaclesUnder(surface: LuaSurface, layout: LayoutState, parts?: BuildParts): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<string, boolean> = {}
  for (const k of parts !== undefined ? partTiles(layout, parts) : layoutTiles(layout)) {
    const x = keyX(k)
    const y = keyY(k)
    for (const e of findEntities(surface, { area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: ["tree", "simple-entity"] })) {
      const key = `${e.name}@${e.position.x},${e.position.y}`
      if (seen[key]) continue
      seen[key] = true
      out.push(e)
    }
  }
  return out
}

/** B42: every entity `layout` plans, keyed `name@x,y` (`%g`: positions went through module arithmetic). */
export function layoutEntityKeys(layout: LayoutState): Record<string, boolean> {
  const keys: Record<string, boolean> = {}
  for (const e of partEntities(layout, allParts(layout))) keys[string.format("%s@%g,%g", e.name, e.x, e.y)] = true
  return keys
}

/** Types under a ghost that are not built structures. */
const NOT_STRUCTURES = ["entity-ghost", "tile-ghost", "character", "character-corpse", "item-request-proxy", "item-entity"]

/**
 * B42: the faction's own built entities under `ghost` that the layout (`layoutEntityKeys`) does not plan: an obsolete
 * route piece put back, say. Nothing else removes them, so the ghost could never be placed. A live entity with the
 * ghost's own name and position is the planned one already built (B41), not a stray.
 */
export function strayUnder(surface: LuaSurface, force: string, planned: Record<string, boolean>, ghost: LuaEntity): LuaEntity[] {
  const box = ghost.bounding_box
  const area = { left_top: { x: box.left_top.x + 0.05, y: box.left_top.y + 0.05 }, right_bottom: { x: box.right_bottom.x - 0.05, y: box.right_bottom.y - 0.05 } }
  const out: LuaEntity[] = []
  for (const e of findEntities(surface, { area, force })) {
    if (NOT_STRUCTURES.indexOf(e.type) >= 0) continue
    if (e.name === ghost.ghost_name && e.position.x === ghost.position.x && e.position.y === ghost.position.y) continue
    if (planned[string.format("%s@%g,%g", e.name, e.position.x, e.position.y)]) continue
    out.push(e)
  }
  return out
}

/** B36: a stamped module's buffer chest (ghost or real) is a registered buffer, like a route spec's (`createSpec`). */
function registerModuleBuffers(surface: LuaSurface, force: string, specs: { buffer?: boolean }[], placed: (LuaEntity | undefined)[]): void {
  for (let i = 0; i < specs.length; i++) {
    const e = placed[i]
    if (e !== undefined && specs[i].buffer) registerBuffer(surface, force, e)
  }
}

function createSpec(surface: LuaSurface, force: string, e: EntitySpec, ghost: boolean): LuaEntity | undefined {
  // B142: a retried build re-stamps the same plan; an existing ghost is the wanted result.
  if (ghost) {
    const existing = ownGhostAt(surface, force, e.name, { x: e.x, y: e.y }, e.dir)
    if (existing !== undefined) return existing
  }
  const params: Record<string, unknown> = { name: ghost ? "entity-ghost" : e.name, position: { x: e.x, y: e.y }, direction: e.dir, force }
  if (ghost) params.inner_name = e.name
  if (e.ioType !== undefined) params.type = e.ioType
  const created = surface.create_entity(params as never)
  if (created !== undefined && e.buffer) registerBuffer(surface, force, created)
  return created
}

export interface StampResult {
  entities: LuaEntity[]
  failed: string[]
  /** B142: the specs behind `failed`, so route-only failures can be rerouted instead of abandoning the plan. */
  failedSpecs: EntitySpec[]
}

/** Creates some parts of a layout (modules, routes, poles) as real entities or as ghosts. */
export function stampParts(surface: LuaSurface, force: string, layout: LayoutState, parts: BuildParts, ghost: boolean): StampResult {
  const entities: LuaEntity[] = []
  const failed: string[] = []
  const failedSpecs: EntitySpec[] = []
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  for (const m of layout.modules) {
    if (!mods[m.id]) continue
    const placed = stampModule(surface, force, m.def, m.origin, { ghost })
    registerModuleBuffers(surface, force, m.def.entities, placed)
    for (let i = 0; i < m.def.entities.length; i++) {
      const e = placed[i]
      if (e === undefined) {
        const me = m.def.entities[i]
        failed.push(`${m.id}: ${me.name}@${m.origin.x + me.x},${m.origin.y + me.y}`)
        failedSpecs.push({ name: me.name, x: m.origin.x + me.x, y: m.origin.y + me.y, dir: me.dir ?? 0, owner: m.id })
      } else entities.push(e)
    }
  }
  const routes: BuildParts = { modules: [], routes: parts.routes, poles: [] }
  for (const spec of partEntities(layout, routes)) {
    const e = createSpec(surface, force, spec, ghost)
    if (e === undefined) {
      failed.push(`${spec.owner}: ${spec.name}@${spec.x},${spec.y}`)
      failedSpecs.push(spec)
    } else entities.push(e)
  }
  const poles: BuildParts = { modules: [], routes: [], poles: parts.poles }
  for (const spec of partEntities(layout, poles)) {
    // B41: B37 can re-plan an evicted line through some of the same tiles. Those poles deliberately stay built;
    // Factorio nevertheless permits a pole ghost on top of a live pole, and that ghost can never be revived.
    // Reuse the live pole instead of creating an impossible ghost/place job for it.
    if (ghost && findEntities(surface, { name: spec.name, position: { x: spec.x, y: spec.y }, force, limit: 1 }).length > 0) continue
    // D71 (b) / B152: a replacement pole ghosted ahead of the build, or a pole ghost left by a partial stamp whose
    // other pieces failed. It must join `entities`: stepBuild gives a job to every entity of a successful stamp, and a
    // skipped ghost would stay in the world with no job forever (its line then reads as power in the layout only).
    if (ghost) {
      const existing = findEntities(surface, { ghost_name: spec.name, position: { x: spec.x, y: spec.y }, force, limit: 1 })[0]
      if (existing !== undefined) {
        entities.push(existing)
        continue
      }
    }
    const e = createSpec(surface, force, spec, ghost)
    if (e === undefined) {
      failed.push(`${spec.owner}: ${spec.name}@${spec.x},${spec.y}`)
      failedSpecs.push(spec)
    } else entities.push(e)
  }
  return { entities, failed, failedSpecs }
}

/** Creates a layout's modules and routes as real entities or as ghosts. */
export function stampLayout(surface: LuaSurface, force: string, layout: LayoutState, ghost: boolean): StampResult {
  const entities: LuaEntity[] = []
  const failed: string[] = []
  const failedSpecs: EntitySpec[] = []
  for (const m of layout.modules) {
    const placed = stampModule(surface, force, m.def, m.origin, { ghost })
    registerModuleBuffers(surface, force, m.def.entities, placed)
    for (let i = 0; i < m.def.entities.length; i++) {
      const e = placed[i]
      if (e === undefined) {
        const me = m.def.entities[i]
        failed.push(`${m.id}: ${me.name}@${m.origin.x + me.x},${m.origin.y + me.y}`)
        failedSpecs.push({ name: me.name, x: m.origin.x + me.x, y: m.origin.y + me.y, dir: me.dir ?? 0, owner: m.id })
      } else entities.push(e)
    }
  }
  for (const spec of routeEntities(layout)) {
    const e = createSpec(surface, force, spec, ghost)
    if (e === undefined) {
      failed.push(`${spec.owner}: ${spec.name}@${spec.x},${spec.y}`)
      failedSpecs.push(spec)
    } else entities.push(e)
  }
  return { entities, failed, failedSpecs }
}

/** Built belts where new splitter taps of `parts` go onto routes outside `parts` (the base layout's). */
/** The tiles where new splitter taps of `parts` replace a belt of a route outside `parts`. */
function tapSpots(layout: LayoutState, parts: BuildParts | undefined): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  if (parts === undefined) return out
  const mine: Record<string, boolean> = {}
  for (const id of parts.routes) mine[id] = true
  for (const id of parts.routes) {
    const r = layout.routes[id]
    if (r === undefined || r.tapOf === undefined || mine[r.tapOf]) continue
    const st = r.steps[0]
    if (st === undefined || st.kind !== "splitter") continue
    out.push({ x: st.x + 0.5, y: st.y + 0.5 })
  }
  return out
}

export function tappedBelts(surface: LuaSurface, layout: LayoutState, parts: BuildParts | undefined, force: string): LuaEntity[] {
  const out: LuaEntity[] = []
  for (const position of tapSpots(layout, parts)) for (const e of findEntities(surface, { type: "transport-belt", force, position, limit: 1 })) out.push(e)
  return out
}

/**
 * B69 (soak vps-d66 seed 5387208): a tap on a route another build has not finished. The splitter's ghost cannot go over
 * that route's belt ghost, and the build completed without its tap (the consumer never got the item). Waits while such
 * a ghost has a place job, then picks the built belt up like `startBuild` does (once per belt). True while waiting.
 */
function tapsPending(b: BuildState, surface: LuaSurface, force: string, layout: LayoutState): boolean {
  const faction = getFaction(b.faction)!
  let wait = false
  for (const position of tapSpots(layout, b.parts)) {
    for (const g of findEntities(surface, { name: "entity-ghost", force, position, limit: 1 })) {
      if (g.ghost_type === "transport-belt" && faction.ghostJobs[g.unit_number!] !== undefined) wait = true
    }
    for (const e of findEntities(surface, { type: "transport-belt", force, position, limit: 1 })) {
      b.tapCleared ??= {}
      if (e.unit_number === undefined || b.tapCleared[e.unit_number]) continue
      b.tapCleared[e.unit_number] = true
      if (clearJobFor(faction, e) === undefined) b.clearJobs.push(addClearJob(faction, e, b.priority))
      wait = true
    }
  }
  return wait
}

/**
 * Turns a finished plan into Job Board work for its faction: clear jobs now, ghosts and place jobs once the clearing
 * is done (`stepBuild`).
 */
export function startBuild(entry: PlannerEntry, opts: { fuel?: { item: string; count: number }; priority?: number; parts?: BuildParts; clear?: LuaEntity[]; breakAfter?: LuaEntity[] } = {}): BuildState {
  if (entry.phase !== "done" || entry.job === undefined) error(`plan ${entry.id} is not done`)
  const faction = getFaction(entry.faction ?? "")
  if (faction === undefined) error(`plan ${entry.id} has no faction`)
  const surface = game.surfaces[entry.surface]
  const clearJobs: JobId[] = []
  // Re-entrant: an adoption resumed after a Lua error must not queue the same target twice.
  // M7c.9: a target with an open clear job (another goal's, or a resumed adoption's) is waited on too: before, the
  // build skipped it and placed its ghosts while the tree still stood.
  const queueClear = (e: LuaEntity): void => {
    const open = e.valid ? (clearJobFor(faction, e) as JobId | undefined) : undefined
    if (open !== undefined) {
      if (clearJobs.indexOf(open) < 0) clearJobs.push(open)
      return
    }
    clearJobs.push(addClearJob(faction, e, opts.priority))
  }
  for (const e of obstaclesUnder(surface, entry.job.layout, opts.parts)) queueClear(e)
  // B15: entities of evicted bootstrap sites under the plan.
  for (const e of opts.clear ?? []) if (e.valid) queueClear(e)
  // B19: a new splitter tap on a built route replaces that route's belt: pick the belt up first.
  const queued: Record<number, boolean> = {}
  for (const e of tappedBelts(surface, entry.job.layout, opts.parts, faction.force)) {
    if (e.unit_number !== undefined) queued[e.unit_number] = true
    queueClear(e)
  }
  // B56: the faction's own stale belt pieces on the new routes' tiles (an older copy of a rerouted connection).
  if (opts.parts !== undefined) {
    for (const e of staleUnderRoutes(surface, faction.force, entry.job.layout, opts.parts.routes)) {
      if (e.unit_number !== undefined && queued[e.unit_number]) continue
      queueClear(e)
    }
  }
  entry.build = { phase: "clear", faction: faction.name, clearJobs, placeJobs: [], fuel: opts.fuel, priority: opts.priority, failed: [], parts: opts.parts }
  // D71 (b) (user decision in-session 2026-10-30): make before break. Evicted pole lines (`breakAfter`) are picked up
  // only after the plan's new poles stand; until then they keep the modules they served powered (two-faction seed 222:
  // a goal that evicted 22 poles left most of the factory dark for ~30 game-min while its 153-entity build went up).
  const breakAfter = (opts.breakAfter ?? []).filter((e) => e.valid)
  const poleJobs = breakAfter.length > 0 && opts.parts !== undefined ? placeReplacementPoles(surface, faction, partEntities(entry.job.layout, { modules: [], routes: [], poles: opts.parts.poles }), clearJobs, opts) : []
  if (poleJobs.length > 0) {
    entry.build.phase = "poles"
    entry.build.poleJobs = poleJobs
    entry.build.breakAfter = breakAfter
  } else for (const e of breakAfter) queueClear(e)
  return entry.build
}

/**
 * D71 (b): ghosts the electric poles among `specs` whose tiles nothing still has to be cleared from (`clearJobs`), with
 * place jobs, so they stand before the poles they replace are picked up. Poles where an obstacle or an old entity goes
 * first wait for the normal stamp (which reuses a live pole or ghost at its spot).
 */
export function placeReplacementPoles(surface: LuaSurface, faction: FactionState, specs: EntitySpec[], clearJobs: JobId[], opts: { fuel?: { item: string; count: number }; priority?: number }): JobId[] {
  const blocked: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (const id of clearJobs) {
    const j = getJob(faction.board, id)
    const t = j !== undefined && j.payload.kind === "clear" ? j.payload.target : undefined
    if (t === undefined || !t.valid) continue
    const b = t.bounding_box
    blocked.push({ x1: b.left_top.x, y1: b.left_top.y, x2: b.right_bottom.x, y2: b.right_bottom.y })
  }
  const out: JobId[] = []
  for (const spec of specs) {
    const proto = prototypes.entity[spec.name]
    if (proto?.type !== "electric-pole") continue
    const hw = (proto?.tile_width ?? 1) / 2
    const hh = (proto?.tile_height ?? 1) / 2
    if (blocked.some((b) => spec.x + hw > b.x1 && spec.x - hw < b.x2 && spec.y + hh > b.y1 && spec.y - hh < b.y2)) continue
    if (findEntities(surface, { name: spec.name, position: { x: spec.x, y: spec.y }, force: faction.force, limit: 1 }).length > 0) continue
    const g = createSpec(surface, faction.force, spec, true)
    if (g === undefined) continue
    markDirty(surface.name, g.bounding_box.left_top, g.bounding_box.right_bottom)
    const id = addPlaceJob(faction, g, { fuel: opts.fuel, priority: opts.priority })
    if (id !== undefined) out.push(id)
  }
  return out
}

export function stepBuild(entry: PlannerEntry): void {
  const b = entry.build!
  const faction = getFaction(b.faction)
  if (faction === undefined) return
  if (b.phase === "poles") {
    for (const id of b.poleJobs ?? []) {
      const j = getJob(faction.board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    // The replacement poles stand: now the evicted ones go (with the rest of the clearing).
    for (const e of b.breakAfter ?? []) if (e.valid && clearJobFor(faction, e) === undefined) b.clearJobs.push(addClearJob(faction, e, b.priority))
    b.breakAfter = undefined
    b.phase = "clear"
    return
  }
  if (b.phase === "clear") {
    for (const id of b.clearJobs) {
      const j = getJob(faction.board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    // B138: a failed ghost must not let the plan advance to "place" and finish with a hole. Retry on the factory's build
    // round cadence (1800 ticks); the factory goal counts the rounds and relocates after `build-stuck-rounds`.
    if (b.retryAt !== undefined && game.tick < b.retryAt) return
    b.failed.length = 0
    b.hard = undefined
    b.badTiles = undefined
    const surface = game.surfaces[entry.surface]
    const layout = entry.job!.layout
    if (tapsPending(b, surface, entry.force, layout)) return
    // B144: a ghost of an earlier, abandoned route (or a completion ghost the layout never got) cannot be built and
    // blocks a different entity's ghost on its tile. Sweep only the plan's tiles and only ghosts no live layout part
    // owns, so another goal's build is untouched. Two pieces on one tile, or a tile another planned piece owns, reject
    // the plan before any ghost is created (creating over a ghost deletes it).
    const built = b.parts ?? allParts(layout)
    const pre = preflightSpecs(surface, faction, layout, partEntities(layout, built))
    if (pre.swept > 0) log(`[rival-engineers] plan ${entry.id}: swept ${pre.swept} orphan ghost(s) off its tiles`)
    const hardTiles: Vec[] = []
    let hardReason: string | undefined
    for (const [, why] of pairs(pre.blocked)) {
      hardReason = hardReason ?? why.reason
      hardTiles.push(why.at)
    }
    if (hardReason !== undefined) {
      b.hard = hardReason
      b.badTiles = hardTiles
      log(`[rival-engineers] plan ${entry.id}: rejected before stamping: ${hardReason}`)
      b.retryAt = game.tick + 1800
      return
    }
    // B144: an own belt/splitter the plan does not want on a tile is picked up first (a different-type own ghost was
    // swept above); the retry then stamps the planned piece instead of failing ten rounds and relocating.
    let staleQueued = false
    for (const e of staleUnderSpecs(surface, entry.force, partEntities(layout, built))) {
      const open = clearJobFor(faction, e) as JobId | undefined
      if (open !== undefined) {
        if (b.clearJobs.indexOf(open) < 0) b.clearJobs.push(open)
      } else b.clearJobs.push(addClearJob(faction, e, b.priority))
      staleQueued = true
    }
    if (staleQueued) {
      log(`[rival-engineers] plan ${entry.id}: picking up its own stale belt pieces before stamping`)
      return
    }
    const r = b.parts !== undefined ? stampParts(surface, entry.force, layout, b.parts, true) : stampLayout(surface, entry.force, layout, true)
    for (const f of r.failed) b.failed.push(`ghost ${f}`)
    b.failedSpecs = r.failedSpecs
    if (r.failed.length > 0) {
      // B144: an overlap inside the plan's own list, a foreign entity or a structure cannot be cleared by a retry. Fail
      // the goal now, before its place jobs exist, and record the tiles so the next plan avoids them.
      const hard = hardGhostFailure(surface, faction, layout, r.failedSpecs)
      if (hard !== undefined) {
        b.hard = hard.reason
        b.badTiles = hard.tiles
      }
      log(`[rival-engineers] plan ${entry.id}: ${r.failed.length} ghosts could not be created: ${r.failed.slice(0, 6).join("; ")}${hard !== undefined ? ` (hard: ${hard.reason})` : ""}`)
      b.retryAt = game.tick + 1800
      return
    }
    b.retryAt = undefined
    const stamped: LuaEntity[] = [...r.entities]
    // B23: a completed shared mine's new entities (a base module not in `parts`) join the same build.
    if (b.extraAdd !== undefined) {
      // B66 (5387208): the plan's own pole lines can put a pole on a completion pole's spot, and a pole can be built
      // there between planning and this stamp. Factorio accepts the second ghost (on the first ghost, or on the live
      // pole) but it can never be revived: its place job fails `cannot-place` forever and the goal stalls.
      const have: Record<string, boolean> = {}
      for (const g of stamped) if (g.valid) have[`${g.ghost_name}@${g.position.x},${g.position.y}`] = true
      for (const s of b.extraAdd) {
        if (have[`${s.name}@${s.x},${s.y}`]) continue
        if (findEntities(surface, { name: s.name, position: { x: s.x, y: s.y }, force: entry.force, limit: 1 }).length > 0) continue
        have[`${s.name}@${s.x},${s.y}`] = true
        const e = createSpec(surface, entry.force, s, true)
        if (e === undefined) b.failed.push(`ghost ${s.owner}: ${s.name}@${s.x},${s.y}`)
        else stamped.push(e)
      }
    }
    b.ghosts = stamped
    for (const g of stamped) {
      const id = addPlaceJob(faction, g, { fuel: b.fuel, priority: b.priority })
      if (id !== undefined) b.placeJobs.push(id)
    }
    // Ghost creation raises no event: mark their chunks for the terrain model (they are planned own structures).
    for (const g of stamped) if (g.valid) markDirty(entry.surface, g.bounding_box.left_top, g.bounding_box.right_bottom)
    b.phase = "place"
    return
  }
  if (b.phase === "place") {
    for (const id of b.placeJobs) {
      const j = getJob(faction.board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    b.phase = "done"
  }
}

// ---------------------------------------------------------------------------------------------------------
// Graph export (D29)

export function entryGraph(entry: PlannerEntry): FactoryGraph | undefined {
  if (entry.job === undefined) return undefined
  const force = game.forces[entry.force]
  const researched: Record<string, boolean> = {}
  if (force !== undefined) for (const [name, tech] of pairs(force.technologies)) if (tech.researched) researched[name as string] = true
  const g = buildGraph(entry.job.layout, entryPolicy(entry), { tiers: tiers(), researched })
  g.faction = entry.faction
  g.tick = game.tick
  return g
}

/** Writes the graph of a plan to script-output/<file> (JSON). Returns false if there is none. */
export function exportGraph(entry: PlannerEntry, file: string): boolean {
  const g = entryGraph(entry)
  if (g === undefined) return false
  helpers.write_file(file, helpers.table_to_json(g as never))
  return true
}

/** `<count><char>` runs of a row of single-character cells (the cell characters are never digits). */
function runLength(cells: string[]): string {
  const out: string[] = []
  let i = 0
  while (i < cells.length) {
    let j = i + 1
    while (j < cells.length && cells[j] === cells[i]) j++
    out.push(`${j - i}${cells[i]}`)
    i = j
  }
  return out.join("")
}

/**
 * Writes what a plan job starts from (request, base layout, belt tiers, policy, and the terrain the plan sees over the
 * request's region as character rows) to script-output/<file> as a Lua chunk, so a failed in-game plan can be replayed
 * as a T1 test (mod/unit/fixtures, see plan-replay.test.ts). Regions wider than `maxSide` tiles are skipped.
 */
export function exportPlanInput(entry: PlannerEntry, file: string, maxSide = 400): boolean {
  const t = storage.terrains?.[entry.terrain]
  const r = entry.request.region
  if (t === undefined || r.w > maxSide || r.h > maxSide) {
    log(`[rival-engineers] plan input ${file} not exported: ${t === undefined ? "no terrain" : `region ${r.w}x${r.h} over ${maxSide}`}`)
    return false
  }
  const view = factionView(entry, terrainView(t))
  const blockChars = [".", "T", "R", "#", "X", "~", "C", "?"]
  const oreChars: Record<string, string> = { "iron-ore": "i", "copper-ore": "c", coal: "k", stone: "s" }
  const blocks: string[] = []
  const ores: string[] = []
  for (let y = r.y; y < r.y + r.h; y++) {
    const b: string[] = []
    const o: string[] = []
    for (let x = r.x; x < r.x + r.w; x++) {
      b.push(blockChars[view.block(x, y)] ?? "?")
      const ore = view.ore(x, y)
      o.push(ore === undefined ? "." : (oreChars[ore] ?? "o"))
    }
    blocks.push(runLength(b))
    ores.push(runLength(o))
  }
  let all = tiers()
  if (entry.maxUnderground !== undefined) all = all.map((x) => ({ ...x, maxUnderground: math.min(x.maxUnderground, entry.maxUnderground!) }))
  const data = {
    id: entry.id,
    tick: game.tick,
    request: entry.request,
    belt: entry.belt,
    tiers: all,
    base: entry.baseFaction !== undefined ? storage.factories?.[entry.baseFaction]?.layout : undefined,
    policy: entryPolicy(entry),
    origin: { x: r.x, y: r.y },
    // M7c.8: rows are run-length encoded (`<count><char>`): a remote oil field's plan spans ~2,500 tiles a side.
    rle: true,
    blocks,
    ores,
  }
  helpers.write_file(file, serpent.dump(data))
  return true
}
