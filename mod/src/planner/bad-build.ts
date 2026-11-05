// B144: tiles where a build could not stamp a ghost because of a blocker that a retry cannot clear (terrain, a foreign
// entity, another module, or an overlap inside the plan's own add list). The next plan for the same role avoids them.
// Pure: the caller owns `storage` and the tick.

import { Rect, Vec } from "./grid"

/** How long a bad build tile is avoided (agent guess: long enough for the next attempt, short enough to retry later). */
export const BAD_BUILD_TICKS = 30 * 60 * 60
/** Most entries kept per faction; the oldest expiry goes first. */
export const BAD_BUILD_CAP = 32
/** Half-size of the avoided square around a bad tile (agent guess: one tile covers the blocked footprint and its edge). */
export const BAD_BUILD_RADIUS = 1

export interface BadBuild {
  /** The design role whose plan hit the blocker (a goal retries the same roles). */
  role: string
  x: number
  y: number
  /** Avoided until this tick. */
  until: number
  reason: string
}

export interface BadBuildHost {
  buildBad?: BadBuild[]
}

/** Drops expired entries. Returns the live list (mutating the host when it had expired entries). */
export function pruneBadBuild(host: BadBuildHost, tick: number): BadBuild[] {
  const list = host.buildBad ?? []
  const live = list.filter((e) => e.until > tick)
  if (live.length !== list.length) host.buildBad = live
  return live
}

/**
 * Records `tiles` as bad for every role in `roles` until `BAD_BUILD_TICKS` from now. Re-recording a tile extends it.
 * Returns how many entries were added (not how many were refreshed).
 */
export function recordBadBuild(host: BadBuildHost, roles: string[], tiles: Vec[], tick: number, reason: string): number {
  if (tiles.length === 0 || roles.length === 0) return 0
  const list = pruneBadBuild(host, tick)
  const until = tick + BAD_BUILD_TICKS
  let added = 0
  for (const t of tiles) {
    const x = math.floor(t.x)
    const y = math.floor(t.y)
    for (const role of roles) {
      let found: BadBuild | undefined
      for (const e of list) if (e.role === role && e.x === x && e.y === y) {
        found = e
        break
      }
      if (found !== undefined) {
        found.until = until
        found.reason = reason
        continue
      }
      list.push({ role, x, y, until, reason })
      added++
    }
  }
  // Cap deterministically: the entry that expires first goes (ties: role, then y, then x).
  list.sort((a, b) => (a.until !== b.until ? a.until - b.until : a.role !== b.role ? (a.role < b.role ? -1 : 1) : a.y !== b.y ? a.y - b.y : a.x - b.x))
  while (list.length > BAD_BUILD_CAP) list.shift()
  host.buildBad = list
  return added
}

/** Avoid rectangles for the live entries of `roles` (the role of any node in the new goal). */
export function badBuildRects(host: BadBuildHost, roles: string[], tick: number): Rect[] {
  const live = pruneBadBuild(host, tick)
  const want: Record<string, boolean> = {}
  for (const r of roles) want[r] = true
  const out: Rect[] = []
  const seen: Record<string, boolean> = {}
  for (const e of live) {
    if (want[e.role] !== true) continue
    const k = `${e.x},${e.y}`
    if (seen[k]) continue
    seen[k] = true
    out.push({ x: e.x - BAD_BUILD_RADIUS, y: e.y - BAD_BUILD_RADIUS, w: 2 * BAD_BUILD_RADIUS + 1, h: 2 * BAD_BUILD_RADIUS + 1 })
  }
  // Deterministic order (an unordered list would make the planner's candidate order depend on insertion history).
  out.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))
  return out
}
