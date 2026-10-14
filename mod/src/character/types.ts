import { LuaEntity, MapPosition } from "factorio:runtime"
import { ProgressTracker } from "./steering"

// Data shapes for the Character Controller. Everything here lives in `storage`, so it must be plain
// tables: no class instances, functions or metatables.

/** What a caller asks a controller to do (SPEC §5.1). */
export type ActionSpec =
  /** Walk until within `radius` (default 1) of `goal`. */
  | { kind: "walk"; goal: MapPosition; radius?: number }
  /**
   * Mine `target` (a resource, tree, rock...) or the resource at `position`. With `count`, stop after
   * that many of the primary product. Without it (or when the target is depleted first), mine until the
   * target is gone.
   */
  | { kind: "mine"; target?: LuaEntity; position?: MapPosition; count?: number }
  /** Hand-craft `count` crafts of `recipe` at real speed. */
  | { kind: "craft"; recipe: string; count: number }
  /** Place one `item` at `position` facing `direction` (default north). */
  | { kind: "place"; item: string; position: MapPosition; direction?: defines.direction }
  /** Move `count` of `item` from the character into `entity`. */
  | { kind: "insert"; entity: LuaEntity; item: string; count: number }
  /** Move `count` of `item` from `entity` into the character. */
  | { kind: "take"; entity: LuaEntity; item: string; count: number }
  /** Mine a placed entity back into the inventory. */
  | { kind: "pickUp"; entity: LuaEntity }

export type ActionKind = ActionSpec["kind"]

export type ActionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

/** Why an action failed. Stable strings: M2's Job Board branches on them. */
export type FailureReason =
  | "character-invalid"
  | "no-path"
  | "stuck"
  | "unreachable"
  | "target-invalid"
  | "not-minable"
  | "inventory-full"
  | "stalled"
  | "unknown-recipe"
  | "recipe-locked"
  | "not-handcraftable"
  | "missing-ingredients"
  | "craft-interrupted"
  | "not-placeable"
  | "missing-item"
  | "cannot-place"
  | "target-full"
  | "not-enough"

/** When to stop walking early: the action's target is within the engine's reach. */
export type ReachGoal =
  | { kind: "entity"; entity: LuaEntity }
  | { kind: "resource"; entity: LuaEntity }
  | { kind: "build"; position: MapPosition }

export interface WalkState {
  goal: MapPosition
  /** Arrive when within this distance of `goal`. */
  radius: number
  reach?: ReachGoal
  phase: "request" | "pending" | "retry-wait" | "follow"
  requestId?: number
  retryAtTick?: number
  waypoints?: MapPosition[]
  index: number
  tracker: ProgressTracker
  /** Re-paths done so far (stuck, or path ended short of the goal). */
  repaths: number
  /** Pathfinder "try again later" answers so far. */
  busyRetries: number
  teleports: number
}

/** Counters reported with the result, for telemetry and tests. */
export interface ActionStats {
  repaths: number
  teleports: number
  /** Sum of the lengths of every path followed. */
  pathTiles: number
  walkTicks: number
  /** Items mined, crafted, inserted or taken. */
  items: number
}

export interface ActionRecord {
  id: number
  controller: number
  spec: ActionSpec
  status: ActionStatus
  reason?: FailureReason
  /** Human-readable detail for logs. */
  detail?: string
  queuedTick: number
  startedTick?: number
  finishedTick?: number
  stats: ActionStats

  // Runtime state of a running action.
  phase?: "start" | "approach" | "work"
  walk?: WalkState
  target?: LuaEntity
  item?: string
  baseline?: number
  goalCount?: number
  lastProgressTick?: number
  lastProgressValue?: number
  /** The entity a `place` action created. */
  placed?: LuaEntity
}

export interface ControllerState {
  id: number
  character: LuaEntity
  /** Action ids, in order. The first one is running. */
  queue: number[]
  /** Finished action ids, oldest first; trimmed to keep storage bounded. */
  finished: number[]
  dead: boolean
}
