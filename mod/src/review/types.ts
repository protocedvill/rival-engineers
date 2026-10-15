import { LuaEntity, LuaRenderObject } from "factorio:runtime"

// Storage shapes of the live review tools (inspector GUI, overlays, sandbox, per-crew time accounting).
// They extend the global storage interface here so the review code stays in its own files.

/**
 * What a crew member's body spends a tick on (SPEC §5.1 actions, seen from "where does time go"):
 * - walking: following a path (to a job's standing spot, a resource, a machine);
 * - pathing: waiting for the pathfinder, re-pathing after getting stuck, stepping out of a wedge;
 * - mining / crafting / placing: the work itself (placing includes the hand-speed delay);
 * - hauling: logistics: everything done for a haul, deposit or transfer job (walks included), and inserts/takes;
 * - waiting: no claim although the faction's board has ready jobs (none it could take: materials, fuel target);
 * - idle: no claim and no ready job on the board (the brain is waiting on machines, or the faction is paused);
 * - other: holds claims but has no running action this tick (planning, controller budget).
 */
export const TIME_CATEGORIES = ["walking", "pathing", "mining", "crafting", "placing", "hauling", "waiting", "idle", "other"] as const
export type TimeCategory = (typeof TIME_CATEGORIES)[number]

/** Per-crew-member time accounting. Every observed tick adds 1 to exactly one category. */
export interface CrewTime {
  /** First tick observed. */
  start: number
  /** Ticks observed (= the sum of `total`). */
  ticks: number
  total: Partial<Record<TimeCategory, number>>
  /** Ring of recent buckets (REVIEW_BUCKET_TICKS each); the sum is the recent window. */
  buckets: Partial<Record<TimeCategory, number>>[]
  bucket: number
  bucketStart: number
  /** The category of the last observed tick and since when it has not changed. */
  current: TimeCategory
  currentSince: number
}

export interface PlayerReview {
  open: boolean
  /** Selected faction (name) and crew member (id). */
  faction?: string
  crew?: number
  /** Crew member the camera follows (remote view centred on it). */
  follow?: number
  /** Overlay layer name → on. */
  layers: Record<string, boolean>
  /** Rendering objects drawn for this player (destroyed before each redraw). */
  renders: LuaRenderObject[]
  lastRefresh: number
  /** The character left behind when switching to spectator. */
  body?: LuaEntity
  /** Sandbox: jump to the first faction once it exists. */
  gotoFirstFaction?: boolean
}

export interface ReviewStorage {
  time: Record<number, CrewTime>
  players: Record<number, PlayerReview>
  /** The sandbox scenario's one-time setup is done. */
  sandboxReady?: boolean
  /** Last tick faction areas were charted for the players' forces. */
  lastChart?: number
}

declare global {
  interface RivalEngineersStorage {
    review?: ReviewStorage
  }
}

export function reviewStorage(): ReviewStorage {
  storage.review ??= { time: {}, players: {} }
  return storage.review
}
