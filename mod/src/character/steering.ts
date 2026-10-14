// Pure path-following math for the Character Controller. No Factorio globals here: this module is
// unit-tested outside the game (T1, `npm run test:unit`).

export interface Vec {
  readonly x: number
  readonly y: number
}

/** The 8 compass directions as `defines.direction` values (Factorio 2.0 uses 16 directions). */
export const Dir8 = {
  north: 0,
  northeast: 2,
  east: 4,
  southeast: 6,
  south: 8,
  southwest: 10,
  west: 12,
  northwest: 14,
} as const
export type Dir8 = (typeof Dir8)[keyof typeof Dir8]

const TAN_22_5 = 0.41421356237309503

export function distance(a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * The 8-way direction closest to the vector (dx, dy). Map y grows southward. Returns undefined for a
 * zero vector. Uses slope comparisons rather than atan2 (absent from Lua 5.3+).
 */
export function directionTowards(dx: number, dy: number): Dir8 | undefined {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 1e-9 && ay < 1e-9) return undefined
  if (ay <= ax * TAN_22_5) return dx > 0 ? Dir8.east : Dir8.west
  if (ax <= ay * TAN_22_5) return dy > 0 ? Dir8.south : Dir8.north
  if (dx > 0) return dy > 0 ? Dir8.southeast : Dir8.northeast
  return dy > 0 ? Dir8.southwest : Dir8.northwest
}

/**
 * Index of the waypoint to steer towards: skips every waypoint (from `index` on) that `pos` is
 * already within `tolerance` of. The last waypoint uses `finalTolerance`. Returns `waypoints.length`
 * when the path is finished.
 */
export function nextWaypointIndex(
  pos: Vec,
  waypoints: readonly Vec[],
  index: number,
  tolerance: number,
  finalTolerance: number,
): number {
  const n = waypoints.length
  while (index < n) {
    const tol = index === n - 1 ? finalTolerance : tolerance
    if (distance(pos, waypoints[index]) > tol) break
    index++
  }
  return index
}

/** Total length of a polyline from `start` through every waypoint. */
export function pathLength(start: Vec, waypoints: readonly Vec[]): number {
  let total = 0
  let prev = start
  for (const wp of waypoints) {
    total += distance(prev, wp)
    prev = wp
  }
  return total
}

/**
 * Stuck detection: tracks the best (smallest) distance to the current waypoint. Getting at least
 * `minImprovement` closer, or switching waypoint, counts as progress. Sliding along a wall without
 * getting closer does not.
 */
export interface ProgressTracker {
  waypoint: number
  best: number
  lastProgressTick: number
}

export function newProgressTracker(tick: number): ProgressTracker {
  return { waypoint: -1, best: 1e9, lastProgressTick: tick }
}

/** Updates the tracker and returns true when there was no progress for more than `stuckTicks`. */
export function updateProgress(
  tracker: ProgressTracker,
  waypoint: number,
  dist: number,
  tick: number,
  stuckTicks: number,
  minImprovement = 0.1,
): boolean {
  if (waypoint !== tracker.waypoint) {
    tracker.waypoint = waypoint
    tracker.best = dist
    tracker.lastProgressTick = tick
    return false
  }
  if (dist <= tracker.best - minImprovement) {
    tracker.best = dist
    tracker.lastProgressTick = tick
    return false
  }
  return tick - tracker.lastProgressTick > stuckTicks
}
