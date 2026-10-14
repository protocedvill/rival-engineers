import { LuaEntity, MapPosition } from "factorio:runtime"
import { Config } from "../config"
import { forgetPathRequest, getPathRequest, requestCharacterPath } from "./pathing"
import { directionTowards, distance, newProgressTracker, nextWaypointIndex, pathLength, updateProgress } from "./steering"
import { ActionStats, FailureReason, ReachGoal, WalkState } from "./types"

// Walking as a resumable state machine: request a path, wait for the async result, then steer along
// the waypoints by setting walking_state every tick. Stuck → re-path, with bounded retries.

export type StepResult = "running" | "done" | { fail: FailureReason; detail?: string }

/** Steer to the next waypoint once within this distance of the current one. */
const WAYPOINT_TOLERANCE = 0.3
/** When the pathfinder says "try again later" (it is busy), wait this long. */
const BUSY_RETRY_TICKS = 30
const MAX_BUSY_RETRIES = 20

export function newWalk(goal: MapPosition, radius: number, reach: ReachGoal | undefined, tick: number): WalkState {
  return {
    goal: { x: goal.x, y: goal.y },
    radius,
    reach,
    phase: "request",
    index: 0,
    tracker: newProgressTracker(tick),
    repaths: 0,
    busyRetries: 0,
    teleports: 0,
  }
}

export function stopWalking(character: LuaEntity): void {
  character.walking_state = { walking: false, direction: defines.direction.north }
}

/** Whether the character can act on the reach goal from where it stands (the engine's reach rules). */
export function reachSatisfied(character: LuaEntity, reach: ReachGoal): boolean {
  switch (reach.kind) {
    case "entity":
      return reach.entity.valid && character.can_reach_entity(reach.entity)
    case "resource":
      // Hand-mining resources uses the shorter resource reach, measured to the resource's centre.
      return reach.entity.valid && distance(character.position, reach.entity.position) <= character.resource_reach_distance
    case "build":
      // build_distance is measured to the entity edge; stay a tile inside it.
      return distance(character.position, reach.position) <= character.build_distance - 1
  }
}

/** How close the pathfinder must get to the goal for a reach goal: comfortably inside the reach. */
export function pathRadiusFor(character: LuaEntity, reach: ReachGoal | undefined, radius: number): number {
  if (!reach) return Math.max(0.3, radius / 2)
  switch (reach.kind) {
    case "entity":
      return Math.max(1, character.reach_distance - 3)
    case "resource":
      return Math.max(0.5, character.resource_reach_distance - 1.2)
    case "build":
      return Math.max(1, character.build_distance - 3)
  }
}

function arrived(character: LuaEntity, walk: WalkState): boolean {
  if (walk.reach) return reachSatisfied(character, walk.reach)
  return distance(character.position, walk.goal) <= walk.radius
}

function repath(character: LuaEntity, walk: WalkState, stats: ActionStats, config: Config, reason: FailureReason): StepResult {
  stopWalking(character)
  if (walk.repaths >= config.maxRepaths) {
    return { fail: reason, detail: `after ${walk.repaths} re-paths` }
  }
  walk.repaths++
  stats.repaths++
  walk.phase = "request"
  walk.waypoints = undefined
  return "running"
}

/**
 * Debug only (breaks player parity): when stuck, hop two waypoints ahead (past a one-tile obstacle).
 * Bounded by maxRepaths like re-pathing, after which the walk re-paths normally.
 */
function teleportAhead(character: LuaEntity, walk: WalkState, stats: ActionStats, config: Config, tick: number): boolean {
  if (walk.teleports >= config.maxRepaths) return false
  const waypoints = walk.waypoints!
  const targetIndex = Math.min(walk.index + 2, waypoints.length - 1)
  const target = waypoints[targetIndex]
  const spot = character.surface.find_non_colliding_position("character", target, 3, 0.1)
  if (!spot || !character.teleport(spot)) return false
  walk.index = targetIndex
  walk.teleports++
  stats.teleports++
  walk.tracker = newProgressTracker(tick)
  return true
}

export function stepWalk(character: LuaEntity, walk: WalkState, stats: ActionStats, config: Config, tick: number): StepResult {
  if (arrived(character, walk)) {
    stopWalking(character)
    if (walk.requestId !== undefined) forgetPathRequest(walk.requestId)
    return "done"
  }

  if (walk.phase === "retry-wait") {
    if (tick < walk.retryAtTick!) return "running"
    walk.phase = "request"
  }

  if (walk.phase === "request") {
    stopWalking(character)
    walk.requestId = requestCharacterPath(character, walk.goal, pathRadiusFor(character, walk.reach, walk.radius))
    walk.phase = "pending"
    return "running"
  }

  if (walk.phase === "pending") {
    const request = getPathRequest(walk.requestId!)
    if (!request) {
      // The request was lost (e.g. storage migrated); ask again.
      walk.phase = "request"
      return "running"
    }
    if (request.status === "pending") return "running"
    forgetPathRequest(walk.requestId!)
    walk.requestId = undefined
    if (request.status === "failed") {
      if (request.tryAgainLater && walk.busyRetries < MAX_BUSY_RETRIES) {
        walk.busyRetries++
        walk.retryAtTick = tick + BUSY_RETRY_TICKS
        walk.phase = "retry-wait"
        return "running"
      }
      return { fail: "no-path", detail: request.tryAgainLater ? "pathfinder busy" : "pathfinder found no path" }
    }
    const waypoints: MapPosition[] = []
    for (const wp of request.path!) waypoints.push({ x: wp.position.x, y: wp.position.y })
    walk.waypoints = waypoints
    walk.index = 0
    walk.tracker = newProgressTracker(tick)
    walk.phase = "follow"
    stats.pathTiles += pathLength(character.position, waypoints)
  }

  // phase === "follow"
  const waypoints = walk.waypoints!
  const pos = character.position
  walk.index = nextWaypointIndex(pos, waypoints, walk.index, WAYPOINT_TOLERANCE, Math.min(WAYPOINT_TOLERANCE, walk.radius / 2))
  if (walk.index >= waypoints.length) {
    // The path ended but we are not there (goal moved, or the reach goal is not satisfiable from here).
    return repath(character, walk, stats, config, "unreachable")
  }
  const wp = waypoints[walk.index]
  if (updateProgress(walk.tracker, walk.index, distance(pos, wp), tick, config.stuckTicks)) {
    if (!(config.debugTeleportWhenStuck && teleportAhead(character, walk, stats, config, tick))) {
      return repath(character, walk, stats, config, "stuck")
    }
  }
  const direction = directionTowards(wp.x - pos.x, wp.y - pos.y)
  if (direction === undefined) return "running"
  character.walking_state = { walking: true, direction: direction as defines.direction }
  stats.walkTicks++
  return "running"
}
