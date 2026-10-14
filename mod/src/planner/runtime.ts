// Planner at runtime: layout jobs in `storage`, stepped every tick under budget (§5.6): the terrain model scans the
// region (terrainChunksPerTick), then the plan job places and routes (plannerWorkPerTick work units). A finished plan
// becomes a build through the Job Board: clear jobs for trees and rocks first (the controller won't mine where a
// ghost is selected), then ghosts on the faction's force with place (and fuel) jobs, so the crew build it physically.
// The Factory Graph of a plan is exported to JSON for tools/render (D29).

import { LuaEntity, LuaSurface } from "factorio:runtime"
import { getConfig } from "../config"
import { getJob } from "../jobs/board"
import { addClearJob, addPlaceJob, getFaction } from "../jobs/faction"
import { prototypeFacts } from "../modules/prototype-facts"
import { stampModule } from "../modules/stamp"
import { EntitySpec, layoutTiles, routeEntities } from "./build-list"
import { beltTiers, BeltTier, tierByBelt } from "./capacity"
import { buildGraph, FactoryGraph } from "./graph"
import { keyX, keyY } from "./grid"
import { LayoutState } from "./layout"
import { newPlanJob, PlanJob, PlanRequest, stepPlan } from "./plan"
import { LayoutPolicy, selectPolicy } from "./policy"
import { newTerrain, requestArea, stepTerrain, terrainReady, terrainView } from "./terrain"

export interface BuildState {
  phase: "clear" | "place" | "done"
  faction: string
  clearJobs: number[]
  placeJobs: number[]
  fuel?: { item: string; count: number }
  priority?: number
  failed: string[]
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
    topology: c.layoutTopology,
    utilization: c.beltUtilization,
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
}

/** Starts a layout job: scan the request's region, then place and route, all under the per-tick budgets. */
export function startPlan(o: StartPlanOptions): PlannerEntry {
  const p = planner()
  if (p.entries[o.id] !== undefined) error(`planner job ${o.id} exists`)
  const t = newTerrain(`plan:${o.id}`, o.surface, o.force)
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
  }
  p.entries[o.id] = entry
  p.order.push(o.id)
  return entry
}

export function removePlan(id: string): void {
  const p = planner()
  delete p.entries[id]
  const i = p.order.indexOf(id)
  if (i >= 0) p.order.splice(i, 1)
  if (storage.terrains) delete storage.terrains[`plan:${id}`]
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
      const tier = tierByBelt(tiers(), entry.belt) ?? tiers()[0]
      entry.job = newPlanJob(entry.request, tier)
      entry.phase = "plan"
    }
    return
  }
  if (entry.phase === "plan") {
    entry.planTicks++
    // Rescans of dirty chunks keep running under budget while planning.
    stepTerrain(t, c.terrainChunksPerTick)
    if (stepPlan(entry.job!, terrainView(t), prototypeFacts, entryPolicy(entry), c.plannerWorkPerTick)) entry.phase = entry.job!.phase === "done" ? "done" : "failed"
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

/** Trees and rocks on the tiles a layout builds on. */
export function obstaclesUnder(surface: LuaSurface, layout: LayoutState): LuaEntity[] {
  const out: LuaEntity[] = []
  const seen: Record<string, boolean> = {}
  for (const k of layoutTiles(layout)) {
    const x = keyX(k)
    const y = keyY(k)
    for (const e of surface.find_entities_filtered({ area: { left_top: { x: x + 0.05, y: y + 0.05 }, right_bottom: { x: x + 0.95, y: y + 0.95 } }, type: ["tree", "simple-entity"] })) {
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
  return surface.create_entity(params as never)
}

export interface StampResult {
  entities: LuaEntity[]
  failed: string[]
}

/** Creates a layout's modules and routes as real entities or as ghosts. */
export function stampLayout(surface: LuaSurface, force: string, layout: LayoutState, ghost: boolean): StampResult {
  const entities: LuaEntity[] = []
  const failed: string[] = []
  for (const m of layout.modules) {
    const placed = stampModule(surface, force, m.def, m.origin, { ghost })
    for (let i = 0; i < placed.length; i++) {
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

/**
 * Turns a finished plan into Job Board work for its faction: clear jobs now, ghosts and place jobs once the clearing
 * is done (`stepBuild`).
 */
export function startBuild(entry: PlannerEntry, opts: { fuel?: { item: string; count: number }; priority?: number } = {}): BuildState {
  if (entry.phase !== "done" || entry.job === undefined) error(`plan ${entry.id} is not done`)
  const faction = getFaction(entry.faction ?? "")
  if (faction === undefined) error(`plan ${entry.id} has no faction`)
  const surface = game.surfaces[entry.surface]
  const clearJobs: number[] = []
  for (const e of obstaclesUnder(surface, entry.job.layout)) clearJobs.push(addClearJob(faction, e, opts.priority))
  entry.build = { phase: "clear", faction: faction.name, clearJobs, placeJobs: [], fuel: opts.fuel, priority: opts.priority, failed: [] }
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
    const r = stampLayout(game.surfaces[entry.surface], entry.force, entry.job!.layout, true)
    for (const f of r.failed) b.failed.push(`ghost ${f}`)
    for (const g of r.entities) {
      const id = addPlaceJob(faction, g, { fuel: b.fuel, priority: b.priority })
      if (id !== undefined) b.placeJobs.push(id)
    }
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
