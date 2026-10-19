// Planner at runtime: layout jobs in `storage`, stepped every tick under budget (§5.6): the terrain model scans the
// region (terrainChunksPerTick), then the plan job places and routes (plannerWorkPerTick work units). A finished plan
// becomes a build through the Job Board: clear jobs for trees and rocks first (the controller won't mine where a
// ghost is selected), then ghosts on the faction's force with place (and fuel) jobs, so the crew build it physically.
// The Factory Graph of a plan is exported to JSON for tools/render (D29).

import { evictableTiles } from "../strategy/evict"
import { LuaEntity, LuaSurface } from "factorio:runtime"
import { getConfig } from "../config"
import { getJob } from "../jobs/board"
import { addClearJob, addPlaceJob, getFaction } from "../jobs/faction"
import { prototypeFacts } from "../modules/prototype-facts"
import { stampModule } from "../modules/stamp"
import { registerBuffer } from "../modules/buffers"
import { BuildParts, EntitySpec, layoutTiles, partEntities, partTiles, routeEntities } from "./build-list"
import { beltTiers, BeltTier, tierByBelt } from "./capacity"
import { buildGraph, FactoryGraph } from "./graph"
import { claimed, otherClaims, otherOreFields } from "../world/claims"
import { FOREIGN, FREE, keyX, keyY, OWN, ROCK, TerrainView, tkey, TREE } from "./grid"
import { LayoutState } from "./layout"
import { newPlanJob, PlanJob, PlanRequest, stepPlan } from "./plan"
import { LayoutPolicy, selectPolicy } from "./policy"
import { markDirty, newTerrain, requestArea, stepTerrain, terrainReady, terrainView } from "./terrain"
import { countWork, findEntities } from "../work"

export interface BuildState {
  phase: "clear" | "place" | "done"
  faction: string
  clearJobs: number[]
  placeJobs: number[]
  fuel?: { item: string; count: number }
  priority?: number
  failed: string[]
  /** Build only these parts (a plan on top of a base); absent: everything in the layout. */
  parts?: BuildParts
  /** B23: entities of a completed shared mine (a base module not in `parts`); ghosted after the clear. */
  extraAdd?: EntitySpec[]
  /** Ghosts created (for re-planning their place jobs if jobs get dropped). */
  ghosts?: LuaEntity[]
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
  return selectPolicy(entry.policy ?? c.layoutPolicy, { modules: entry.request.modules.length }, {
    corridorMin: c.layoutCorridorMin,
    corridorPreferred: c.layoutCorridorPreferred,
    topology: entry.topology ?? c.layoutTopology,
    utilization: c.beltUtilization,
    smelting: c.layoutSmelting,
    placementSoftClaim: c.plannerPlacementSoftClaim,
    routerSoftClaim: c.plannerRouterSoftClaim,
    routerBundleFactor: c.plannerRouterBundleFactor,
    placementGrowthBand: c.plannerPlacementGrowthBand,
    placementGrowthBandUnits: c.plannerPlacementGrowthBandUnits,
    placementGrowthBlocked: c.plannerPlacementGrowthBlocked,
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
}

/** Starts a layout job: scan the request's region, then place and route, all under the per-tick budgets. */
export function startPlan(o: StartPlanOptions): PlannerEntry {
  const p = planner()
  if (p.entries[o.id] !== undefined) error(`planner job ${o.id} exists`)
  const t = (o.terrain !== undefined ? storage.terrains?.[o.terrain] : undefined) ?? newTerrain(`plan:${o.id}`, o.surface, o.force)
  requestArea(t, o.request.region)
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
  if (reserved === undefined && others.length === 0 && evictable === undefined) return base
  const layout = name !== undefined ? storage.factories?.[name]?.layout : undefined
  return {
    block: (x, y) => {
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
  }
}

/** One tick of one planner job. */
export function stepEntry(entry: PlannerEntry): void {
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
    const finished = stepPlan(entry.job!, factionView(entry, terrainView(t)), prototypeFacts, entryPolicy(entry), c.plannerWorkPerTick)
    countWork("plannerWork", st.work - w0)
    countWork("placementCandidates", (st.candidates ?? 0) - c0)
    countWork("routerExpansions", st.expansions - e0)
    if (finished) entry.phase = entry.job!.phase === "done" ? "done" : "failed"
    return
  }
  if (entry.build !== undefined && entry.build.phase !== "done") stepBuild(entry)
}

export function onPlannerTick(): void {
  const p = storage.planner
  if (p === undefined) return
  for (const id of p.order) {
    const e = p.entries[id]
    if (e !== undefined) stepEntry(e)
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

function createSpec(surface: LuaSurface, force: string, e: EntitySpec, ghost: boolean): LuaEntity | undefined {
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
}

/** Creates some parts of a layout (modules, routes, poles) as real entities or as ghosts. */
export function stampParts(surface: LuaSurface, force: string, layout: LayoutState, parts: BuildParts, ghost: boolean): StampResult {
  const entities: LuaEntity[] = []
  const failed: string[] = []
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  for (const m of layout.modules) {
    if (!mods[m.id]) continue
    const placed = stampModule(surface, force, m.def, m.origin, { ghost })
    for (let i = 0; i < m.def.entities.length; i++) {
      const e = placed[i]
      if (e === undefined) failed.push(`${m.id}: ${m.def.entities[i].name}@${m.origin.x + m.def.entities[i].x},${m.origin.y + m.def.entities[i].y}`)
      else entities.push(e)
    }
  }
  const only: BuildParts = { modules: [], routes: parts.routes, poles: parts.poles }
  for (const spec of partEntities(layout, only)) {
    const e = createSpec(surface, force, spec, ghost)
    if (e === undefined) failed.push(`${spec.owner}: ${spec.name}@${spec.x},${spec.y}`)
    else entities.push(e)
  }
  return { entities, failed }
}

/** Creates a layout's modules and routes as real entities or as ghosts. */
export function stampLayout(surface: LuaSurface, force: string, layout: LayoutState, ghost: boolean): StampResult {
  const entities: LuaEntity[] = []
  const failed: string[] = []
  for (const m of layout.modules) {
    const placed = stampModule(surface, force, m.def, m.origin, { ghost })
    for (let i = 0; i < m.def.entities.length; i++) {
      const e = placed[i]
      if (e === undefined) failed.push(`${m.id}: ${m.def.entities[i].name}@${m.origin.x + m.def.entities[i].x},${m.origin.y + m.def.entities[i].y}`)
      else entities.push(e)
    }
  }
  for (const spec of routeEntities(layout)) {
    const e = createSpec(surface, force, spec, ghost)
    if (e === undefined) failed.push(`${spec.owner}: ${spec.name}@${spec.x},${spec.y}`)
    else entities.push(e)
  }
  return { entities, failed }
}

/** Built belts where new splitter taps of `parts` go onto routes outside `parts` (the base layout's). */
export function tappedBelts(surface: LuaSurface, layout: LayoutState, parts: BuildParts | undefined, force: string): LuaEntity[] {
  const out: LuaEntity[] = []
  if (parts === undefined) return out
  const mine: Record<string, boolean> = {}
  for (const id of parts.routes) mine[id] = true
  for (const id of parts.routes) {
    const r = layout.routes[id]
    if (r === undefined || r.tapOf === undefined || mine[r.tapOf]) continue
    const st = r.steps[0]
    if (st === undefined || st.kind !== "splitter") continue
    for (const e of findEntities(surface, { type: "transport-belt", force, position: { x: st.x + 0.5, y: st.y + 0.5 }, limit: 1 })) out.push(e)
  }
  return out
}

/**
 * Turns a finished plan into Job Board work for its faction: clear jobs now, ghosts and place jobs once the clearing
 * is done (`stepBuild`).
 */
export function startBuild(entry: PlannerEntry, opts: { fuel?: { item: string; count: number }; priority?: number; parts?: BuildParts; clear?: LuaEntity[] } = {}): BuildState {
  if (entry.phase !== "done" || entry.job === undefined) error(`plan ${entry.id} is not done`)
  const faction = getFaction(entry.faction ?? "")
  if (faction === undefined) error(`plan ${entry.id} has no faction`)
  const surface = game.surfaces[entry.surface]
  const clearJobs: number[] = []
  for (const e of obstaclesUnder(surface, entry.job.layout, opts.parts)) clearJobs.push(addClearJob(faction, e, opts.priority))
  // B15: entities of evicted bootstrap sites under the plan.
  for (const e of opts.clear ?? []) if (e.valid) clearJobs.push(addClearJob(faction, e, opts.priority))
  // B19: a new splitter tap on a built route replaces that route's belt: pick the belt up first.
  for (const e of tappedBelts(surface, entry.job.layout, opts.parts, faction.force)) clearJobs.push(addClearJob(faction, e, opts.priority))
  entry.build = { phase: "clear", faction: faction.name, clearJobs, placeJobs: [], fuel: opts.fuel, priority: opts.priority, failed: [], parts: opts.parts }
  return entry.build
}

export function stepBuild(entry: PlannerEntry): void {
  const b = entry.build!
  const faction = getFaction(b.faction)
  if (faction === undefined) return
  if (b.phase === "clear") {
    for (const id of b.clearJobs) {
      const j = getJob(faction.board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    const surface = game.surfaces[entry.surface]
    const r = b.parts !== undefined ? stampParts(surface, entry.force, entry.job!.layout, b.parts, true) : stampLayout(surface, entry.force, entry.job!.layout, true)
    for (const f of r.failed) b.failed.push(`ghost ${f}`)
    if (r.failed.length > 0) log(`[rival-engineers] plan ${entry.id}: ${r.failed.length} ghosts could not be created: ${r.failed.slice(0, 6).join("; ")}`)
    const stamped: LuaEntity[] = [...r.entities]
    // B23: a completed shared mine's new entities (a base module not in `parts`) join the same build.
    if (b.extraAdd !== undefined) {
      for (const s of b.extraAdd) {
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

/**
 * Writes what a plan job starts from (request, base layout, belt tiers, policy, and the terrain the plan sees over the
 * request's region as character rows) to script-output/<file> as a Lua chunk, so a failed in-game plan can be replayed
 * as a T1 test (mod/unit/fixtures, see plan-replay.test.ts). Regions wider than `maxSide` tiles are skipped.
 */
export function exportPlanInput(entry: PlannerEntry, file: string, maxSide = 400): boolean {
  const t = storage.terrains?.[entry.terrain]
  const r = entry.request.region
  if (t === undefined || r.w > maxSide || r.h > maxSide) return false
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
    blocks.push(b.join(""))
    ores.push(o.join(""))
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
    blocks,
    ores,
  }
  helpers.write_file(file, serpent.dump(data))
  return true
}
