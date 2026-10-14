import { LuaEntity, MapPosition } from "factorio:runtime"
import { BrainState } from "../strategy/types"
import { Board, ItemCount, Pos } from "./board"

// Runtime shapes for factions, crew and the per-job data the board carries. All of it lives in
// `storage`, so plain tables only.

/** What the crew needs to do a job, per kind. The board itself only sees `Job` fields. */
export type JobPayload =
  /** Fill `ghost` (an entity-ghost on the faction's force) by placing one `item`. `built` is set once placed. */
  | { kind: "place"; item: string; entity: string; position: MapPosition; direction: defines.direction; ghost: LuaEntity; ghostKey: number; built?: LuaEntity }
  /**
   * Insert `count` `item` into `target`, or into the entity built by place job `targetJob`. Used for fuel and
   * for feeding ore into a furnace. With `partial`, inserts what fits (leftovers are deposited later).
   */
  | { kind: "fuel"; item: string; count: number; target?: LuaEntity; targetJob?: number; partial?: boolean }
  /**
   * Mine `count` of the resource (or tree, rock) `target`; optionally deliver the product into `deliverTo`
   * (whatever fits; leftovers are deposited later).
   */
  | { kind: "gather"; item: string; count: number; target: LuaEntity; deliverTo?: LuaEntity }
  /**
   * Hand-craft `count` crafts of `recipe`. The job's materials are the ingredients (raw, the crafting queue
   * makes the intermediates). With `deliverTo`, the products go there afterwards.
   */
  | { kind: "craft"; recipe: string; count: number; item?: string; deliverTo?: LuaEntity }
  /** Collect: take up to `count` `item` from `from` (a furnace's output, a drill's fuel...) and put it in `to`. */
  | { kind: "transfer"; item: string; count: number; from: LuaEntity; to: LuaEntity }
  /** Created and claimed by a crew member for itself: put what it carries into the faction's depot. */
  | { kind: "deposit"; forMember: number }
  /** Created and claimed by a crew member for itself: take its batch's missing materials from stockpiles. */
  | { kind: "haul"; forMember: number }
  /** Remove `target`: the faction's own buildings are picked up, trees and rocks are mined. */
  | { kind: "clear"; target: LuaEntity }

export interface FactionState {
  name: string
  /** The surface the faction lives on (name). */
  surface: string
  /** The faction's LuaForce name. */
  force: string
  /** Crew member ids. */
  crew: number[]
  /** Chests the crew takes materials from. Only the faction's own. */
  stockpiles: LuaEntity[]
  board: Board<JobPayload>
  /** Ghost unit_number → place job id, so a ghost is planned once. */
  ghostJobs: Record<number, number>
  /** Paused factions don't claim new jobs (running work finishes). */
  paused: boolean
  /** Items crew members are on their way to take from the stockpiles, so others don't count them. */
  reserved: Record<string, number>
  /** The strategy layer (M3 burner bootstrap). Factions without one only work jobs added from outside. */
  brain?: BrainState
}

export interface CrewStats {
  /** Ticks observed. */
  ticks: number
  /** Ticks with no claimed job while the faction's board had ready jobs. */
  idleTicks: number
  /** Ticks holding at least one claim. */
  busyTicks: number
  batches: number
  jobsDone: number
  /** Releases after a failed attempt (penalised or transient). */
  jobsReleased: number
  hauls: number
  /** Batch plans that found a job (each costs a board scan and a standing-spot search). */
  plans: number
  /** Busy ticks by the payload kind of the job being worked (telemetry). */
  byKind?: Record<string, number>
  deposits?: number
}

/** A controller action the crew member queued, and the job it serves (none for a batch walk). */
export interface CrewAction {
  action: number
  job?: number
  /** A take from a stockpile reserves this until it finishes. */
  reserve?: ItemCount
}

export interface CrewMember {
  id: number
  faction: string
  character: LuaEntity
  controller: number
  /** Job ids this member holds. */
  claims: number[]
  /** Actions queued for the claims, in order. */
  actions: CrewAction[]
  /** Where the member is heading to stand for its batch, if anywhere. */
  spot?: Pos
  dead: boolean
  stats: CrewStats
}
