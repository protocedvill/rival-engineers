// Storage schema 2 (B159 follow-up): rewrite every stored tile key from the old full-map encoding to the new key
// (`grid.ts`): small keys near the origin (Factorio's Lua 5.2 hashes large numeric keys ~27x slower) and the negative
// full-map form far out. Pure: plain tables only, no game/prototypes/settings, so T1 and the schema migration share it.
//
// The set of key-bearing fields is deliberately explicit: a recursive rewrite of every number would corrupt counts,
// positions, unit numbers and patch ids. Active planner entries are also rekeyed; their transient search state (a pipe
// or belt search, a placement scan) is dropped and its connection put back in the queue, so the plan resumes from its
// committed layout instead of carrying window indexes and partial searches across the encoding change.

import { keyX, keyY, tkey } from "./grid"
import type { LayoutState } from "./layout"
import type { TerrainState } from "./terrain"
import type { PlannerEntry } from "./runtime"
import type { PlanJob, PlanRequest } from "./plan"
import type { BrainState } from "../strategy/types"
import type { FactionState } from "../jobs/types"
import type { FactoryState } from "../strategy/factory"

export interface RekeyStorage {
  factions?: Record<string, FactionState>
  factories?: Record<string, FactoryState>
  terrains?: Record<string, TerrainState>
  planner?: { entries: Record<string, PlannerEntry>; order: string[] }
}

function rekeyKey(k: number): number {
  return tkey(keyX(k), keyY(k))
}

function rekeyMap<T>(map: Record<number, T> | undefined): Record<number, T> | undefined {
  if (map === undefined) return undefined
  const out: Record<number, T> = {}
  for (const [k, v] of pairs(map)) out[rekeyKey(k as number)] = v as T
  return out
}

function rekeyArray(keys: number[] | undefined): number[] | undefined {
  if (keys === undefined) return undefined
  const out: number[] = []
  for (const k of keys) out.push(rekeyKey(k))
  return out
}

/** Rewrites a layout's tile maps, route tiles and mine-plan claims. Idempotent: rekeying a new key returns it. */
export function rekeyLayout(layout: LayoutState): void {
  layout.occ = rekeyMap(layout.occ) ?? {}
  layout.reserved = rekeyMap(layout.reserved) ?? {}
  layout.routeOcc = rekeyMap(layout.routeOcc) ?? {}
  layout.corridor = rekeyMap(layout.corridor) ?? {}
  const soft = rekeyMap(layout.soft)
  if (soft !== undefined) layout.soft = soft
  const softUnit = rekeyMap(layout.softUnit)
  if (softUnit !== undefined) layout.softUnit = softUnit
  const mine = rekeyMap(layout.mine)
  if (mine !== undefined) layout.mine = mine
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    if (r === undefined) continue
    const tiles = rekeyArray(r.tiles)
    if (tiles !== undefined) r.tiles = tiles
  }
  for (const m of layout.modules) {
    if (m.minePlan === undefined) continue
    m.minePlan.claim = rekeyArray(m.minePlan.claim) ?? []
    m.minePlan.occupied = rekeyArray(m.minePlan.occupied) ?? []
  }
}

/** A plan request's tile-keyed fields: a fluid connection's verified-free map (start/goal lanes). */
export function rekeyRequest(request: PlanRequest): void {
  for (const c of request.connections) {
    const free = c.fluid?.verifiedFree
    if (free !== undefined) c.fluid!.verifiedFree = rekeyMap(free)
  }
}

function rekeyTerrain(t: TerrainState): void {
  t.chunks = rekeyMap(t.chunks) ?? {}
  t.queued = rekeyMap(t.queued) ?? {}
  const queue = rekeyArray(t.queue)
  if (queue !== undefined) t.queue = queue
}

function rekeyBrain(brain: BrainState): void {
  brain.reserved = rekeyMap(brain.reserved) ?? {}
  brain.reservedBy = rekeyMap(brain.reservedBy)
  brain.oreFields = rekeyMap(brain.oreFields)
  // `badPatches` is keyed by patch id, not a tile key.
  for (const site of brain.sites ?? []) site.tiles = rekeyArray(site.tiles) ?? []
}

function rekeyFactory(f: FactoryState): void {
  rekeyLayout(f.layout)
  f.radarChunks = rekeyMap(f.radarChunks)
}

function rekeyJob(job: PlanJob): void {
  rekeyLayout(job.layout)
  if (job.request !== undefined) rekeyRequest(job.request)
  if (job.laneBase !== undefined) rekeyLayout(job.laneBase)
  const laneKeep = rekeyArray(job.laneKeep)
  if (laneKeep !== undefined) job.laneKeep = laneKeep
  const newLaneKeep = rekeyArray(job.newLaneKeep)
  if (newLaneKeep !== undefined) job.newLaneKeep = newLaneKeep
  // Drop the transient search/placement state and retry its connection after the encoding change; its committed routes
  // are in `job.layout` and were rekeyed above.
  if (job.current !== undefined) {
    job.queue.unshift(job.current.conn)
    job.current = undefined
  }
  if (job.pipe !== undefined) {
    job.queue.unshift(job.pipe.conn)
    job.pipe = undefined
  }
  job.placement = undefined
  job.wholePatch = undefined
  job.poleJob = undefined
}

function rekeyEntry(entry: PlannerEntry): void {
  if (entry.request !== undefined) rekeyRequest(entry.request)
  if (entry.job !== undefined) rekeyJob(entry.job)
}

export function rekeyStorage(value: RekeyStorage): void {
  for (const [, t] of pairs(value.terrains ?? {})) rekeyTerrain(t as TerrainState)
  for (const [, f] of pairs(value.factories ?? {})) rekeyFactory(f as FactoryState)
  for (const [, faction] of pairs(value.factions ?? {})) {
    const brain = (faction as FactionState).brain
    if (brain !== undefined) rekeyBrain(brain)
  }
  const planner = value.planner
  if (planner !== undefined) {
    for (const id of planner.order) {
      const entry = planner.entries[id]
      if (entry !== undefined) rekeyEntry(entry)
    }
  }
}
