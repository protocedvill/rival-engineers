import { LuaEntity, MapPosition, OnScriptPathRequestFinishedEvent } from "factorio:runtime"
import { countWork } from "../work"

// Async pathfinding for character bodies. Results arrive via on_script_path_request_finished
// and are kept in storage so they survive save/load and are visible to every peer.
/** Requests a path that ends within `radius` of `goal`. */
export function requestCharacterPath(character: LuaEntity, goal: MapPosition, radius = 1): number {
  const proto = character.prototype
  countWork("pathRequests")
  const id = character.surface.request_path({
    bounding_box: proto.collision_box,
    collision_mask: proto.collision_mask,
    start: character.position,
    goal,
    // Not the character's force: the unit pathfinder treats entities of any force the requester could
    // attack (neutral trees and walls, other factions' buildings) as destroyable and paths straight
    // through them. The neutral force attacks nothing, so every obstacle blocks, as for a walking player.
    // See test "pathfinder only routes around obstacles when requested as the neutral force".
    force: "neutral",
    radius,
    entity_to_ignore: character,
    pathfind_flags: { cache: false, prefer_straight_paths: true },
  })
  storage.pathRequests[id] = { status: "pending" }
  return id
}

export function getPathRequest(id: number): PathRequestState | undefined {
  return storage.pathRequests[id]
}

export function forgetPathRequest(id: number): void {
  delete storage.pathRequests[id]
}

export function onPathRequestFinished(event: OnScriptPathRequestFinishedEvent): void {
  const request = storage.pathRequests[event.id]
  if (!request) return
  request.status = event.path ? "found" : "failed"
  request.path = event.path
  request.tryAgainLater = event.try_again_later
}
