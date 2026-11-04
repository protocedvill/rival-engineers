import { LuaEntity, MapPosition } from "factorio:runtime"
import { BrainState } from "../strategy/types"
import { Board, ItemCount, Pos } from "./board"
import type { SupplyPoint } from "./supply"
import type { DiagnosticEventStore } from "../diagnostic-events"
import type { JobId } from "../shared/ids"

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
  /**
   * Take up to `count` `item` from `from` and put it in `to`. B32: the brain no longer creates these (the crew takes
   * from supply points directly when a job needs the item); kept so jobs in older saves still finish.
   */
  | { kind: "transfer"; item: string; count: number; from: LuaEntity; to: LuaEntity }
  /** Created and claimed by a crew member for itself: put what it carries into the faction's depot. */
  | { kind: "deposit"; forMember: number }
  /** Created and claimed by a crew member for itself: take its batch's missing materials from stockpiles and supply points (B32). */
  | { kind: "haul"; forMember: number }
  /** Remove `target`: the faction's own buildings are picked up, trees and rocks are mined. */
  | { kind: "clear"; target: LuaEntity; robotOrdered?: boolean }

export interface FactionState {
  /** B111: standing spots the crew could not walk to, avoided until the tick (`jobs/bad-spots.ts`). */
  badSpots?: Record<string, number>
  /**
   * M7d.5: clear jobs whose target carries a deconstruction order (robots in range take it down, like a player's
   * deconstruction planner). An order whose job ends without the target gone is cancelled (`jobs/robot-orders.ts`).
   */
  deconOrders?: { job: JobId; target: LuaEntity }[]
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
  ghostJobs: Record<number, JobId>
  /** Paused factions don't claim new jobs (running work finishes). */
  paused: boolean
  /** Items crew members are on their way to take (legacy: reservations made before B32 carry no source). */
  reserved: Record<string, number>
  /** B32: supply points the crew takes from besides the stockpiles (the brain registers them every think). */
  supplies?: SupplyPoint[]
  /** B32: takes on their way, by source unit number and item, so two members never count the same stack. */
  reservedAt?: Record<number, Record<string, number>>
  /** Empty the crew's pockets into the depot between jobs, as brain-driven factions always do (tests). */
  depositBetweenJobs?: boolean
  /** The strategy layer (M3 burner bootstrap). Factions without one only work jobs added from outside. */
  brain?: BrainState
  /** Bounded structured history for explaining why the crew and planners chose or rejected work. */
  diagnosticEvents?: DiagnosticEventStore
  /**
   * B102: entities to ghost once the listed clear jobs are over (a kept route's belt where a dropped splitter stands:
   * no ghost can go over the live splitter). `jobs/crew.ts` `placePendingGhosts` serves them.
   */
  pendingGhosts?: { name: string; x: number; y: number; dir: number; ioType?: "input" | "output"; after: JobId[]; priority?: number }[]
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
  /** D38: craft jobs queued in the background of another batch. */
  backgroundCrafts?: number
  /** M6: times the member cleared a way out of an enclosure (picked an entity up — re-placed from a ghost — or mined a tree/rock). */
  unboxed?: number
  /** Mining trips of more than one job (B3). */
  trips?: number
  /** B17: batches dropped to work a strictly higher-priority job first (a collect transfer on furnaces, a fuel refill). */
  preemptions?: number
  /** B31: preemptions whose re-plan claimed the job the member dropped its batch for. */
  preemptTaken?: number
  /** B36: items taken for jobs, by source kind (`depot`, `buffer`, `furnace`, `temp-out`, ... see `SupplyKind`). */
  takes?: Record<string, number>
}

/** A controller action the crew member queued, and the job it serves (none for a batch walk). */
export interface CrewAction {
  action: number
  job?: number
  /** B111: the standing spot this walk goes to (absent for other actions). */
  spot?: { x: number; y: number }
  /** A take from a stockpile reserves this until it finishes (`from`: the source's unit number, B32). */
  reserve?: ItemCount & { from?: number }
  /** B36: the source kind of a take (telemetry). */
  src?: string
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
  /** M7c.8: after a plan found nothing, the next plan waits until this tick unless the board changes (`idleBoard`). */
  idleUntil?: number
  /** M7c.8: the board's change count when that plan found nothing. */
  idleBoard?: number
  dead: boolean
  stats: CrewStats
  /** M6: walk failures in a row (no path, or a stuck/unreachable re-path loop); the member is boxed in at TRAPPED_NO_PATHS. */
  noPaths?: number
  /** B22: ticks one over the earliest tick of the next escape attempt when the last found nothing to clear. */
  unboxRetryAt?: number
  /** B30: ready fuel/transfer jobs when the member last planned; only jobs not in it can preempt its batch. */
  planSeen?: number[]
  /** B31: the urgent job this member just dropped its batch for; its next plan takes it first. */
  preemptFor?: number
}
