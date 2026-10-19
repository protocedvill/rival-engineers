import { EntitySearchFilters, LuaEntity, LuaSurface } from "factorio:runtime"

// Deterministic work counters (SPEC §9 performance gates, backlog B10). They count what the AI does (planner work
// units, placement candidates scored, router expansions, path requests, entity scans, jobs processed, reconciler
// evaluations), not how long it takes, so a run's counts depend only on the seed, the config and the code: a rise
// against a committed baseline is a regression signal that wall-clock noise can't hide (tools/harness/workcounts.py).
// Per run (totals) and the peak per game-minute. Stored in `storage` (no gameplay effect). A leaf module: anything may
// import it.

export type WorkKind =
  | "plannerWork"
  | "placementCandidates"
  | "routerExpansions"
  | "pathRequests"
  | "entityScans"
  | "jobsProcessed"
  | "reconcilerEvaluations"

export const WORK_KINDS: WorkKind[] = ["plannerWork", "placementCandidates", "routerExpansions", "pathRequests", "entityScans", "jobsProcessed", "reconcilerEvaluations"]

const MINUTE = 3600

interface WorkState {
  total: Record<string, number>
  /** The current game-minute's counts, and the highest of any finished minute. */
  minute: Record<string, number>
  peak: Record<string, number>
  /** Index of the current minute (tick / 3600). */
  minuteIndex: number
}

declare global {
  interface RivalEngineersStorage {
    work?: WorkState
  }
}

function state(): WorkState {
  let w = storage.work
  if (w === undefined) {
    w = { total: {}, minute: {}, peak: {}, minuteIndex: math.floor(game.tick / MINUTE) }
    storage.work = w
  }
  return w
}

function rollover(w: WorkState): void {
  const idx = math.floor(game.tick / MINUTE)
  if (idx === w.minuteIndex) return
  for (const k of WORK_KINDS) {
    const v = w.minute[k] ?? 0
    if (v > (w.peak[k] ?? 0)) w.peak[k] = v
  }
  w.minute = {}
  w.minuteIndex = idx
}

export function countWork(kind: WorkKind, n = 1): void {
  if (n === 0) return
  const w = state()
  rollover(w)
  w.total[kind] = (w.total[kind] ?? 0) + n
  w.minute[kind] = (w.minute[kind] ?? 0) + n
}

/** Counted `find_entities_filtered` (AI code only; telemetry and the review tools don't count). */
export function findEntities(surface: LuaSurface, filter: EntitySearchFilters): LuaEntity[] {
  countWork("entityScans")
  return surface.find_entities_filtered(filter)
}

export function countEntities(surface: LuaSurface, filter: EntitySearchFilters): number {
  countWork("entityScans")
  return surface.count_entities_filtered(filter)
}

/** Totals and peaks per minute (the current minute counts toward the peak), rounded to 0.01. */
export function workReport(): { total: Record<string, number>; peakPerMinute: Record<string, number>; tick: number } {
  const w = state()
  rollover(w)
  const total: Record<string, number> = {}
  const peak: Record<string, number> = {}
  for (const k of WORK_KINDS) {
    total[k] = math.floor((w.total[k] ?? 0) * 100 + 0.5) / 100
    peak[k] = math.floor(math.max(w.peak[k] ?? 0, w.minute[k] ?? 0) * 100 + 0.5) / 100
  }
  return { total, peakPerMinute: peak, tick: game.tick }
}
