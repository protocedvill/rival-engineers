import { countReady, Job } from "../jobs/board"
import { CrewMember, FactionState, JobPayload } from "../jobs/types"
import { CrewTime, reviewStorage, TIME_CATEGORIES, TimeCategory } from "./types"

// Per-crew time accounting for the live inspector ("where is time wasted"). Runs every tick after the
// controllers have stepped and puts the tick into exactly one category per living crew member, so the
// categories always sum to the ticks observed. Cheap (a few table lookups per member), storage only,
// deterministic (SPEC §5.6), and it never changes what the crew does.

/** Recent window: REVIEW_BUCKETS buckets of REVIEW_BUCKET_TICKS ticks (about the last minute of game time). */
export const REVIEW_BUCKET_TICKS = 600
export const REVIEW_BUCKETS = 6

function isLogistics(job: Job<JobPayload> | undefined): boolean {
  if (!job) return false
  const k = job.payload.kind
  return k === "haul" || k === "deposit" || k === "transfer"
}

/** The job a controller action serves, if any (the walk to a batch's standing spot serves none). */
export function jobOfAction(faction: FactionState, member: CrewMember, actionId: number): Job<JobPayload> | undefined {
  for (const ca of member.actions) {
    if (ca.action === actionId) return ca.job !== undefined ? faction.board.jobs[ca.job] : undefined
  }
  return undefined
}

/** What the member is doing this tick. `ready` is the faction's ready-job count, computed only when needed. */
export function classify(faction: FactionState, member: CrewMember, ready: (this: void) => number): TimeCategory {
  const ctrl = storage.controllers[member.controller]
  const actionId = ctrl?.queue[0]
  const action = actionId !== undefined ? storage.actions[actionId] : undefined
  if (action) {
    const walk = action.walk
    if (walk && walk.phase !== "follow") return "pathing"
    if (isLogistics(jobOfAction(faction, member, action.id))) return "hauling"
    const kind = action.spec.kind
    if (walk || kind === "walk" || action.phase === "approach") return "walking"
    switch (kind) {
      case "mine":
      case "pickUp":
        return "mining"
      case "craft":
        return "crafting"
      case "place":
        return "placing"
      case "insert":
      case "take":
        return "hauling"
    }
  }
  if (member.claims.length > 0 || member.actions.length > 0) return "other"
  return ready() > 0 ? "waiting" : "idle"
}

function newCrewTime(tick: number, category: TimeCategory): CrewTime {
  const buckets = []
  for (let i = 0; i < REVIEW_BUCKETS; i++) buckets.push({})
  return { start: tick, ticks: 0, total: {}, buckets, bucket: 0, bucketStart: tick, current: category, currentSince: tick }
}

/** Adds one tick of `category` to `t`. */
export function accrue(t: CrewTime, category: TimeCategory, tick: number): void {
  if (tick - t.bucketStart >= REVIEW_BUCKET_TICKS) {
    t.bucket = (t.bucket + 1) % REVIEW_BUCKETS
    t.buckets[t.bucket] = {}
    t.bucketStart = tick
  }
  t.ticks++
  t.total[category] = (t.total[category] ?? 0) + 1
  const b = t.buckets[t.bucket]
  b[category] = (b[category] ?? 0) + 1
  if (t.current !== category) {
    t.current = category
    t.currentSince = tick
  }
}

export function onTimeTick(): void {
  const order = storage.factionOrder
  if (order.length === 0) return
  const times = reviewStorage().time
  const tick = game.tick
  for (const name of order) {
    const faction = storage.factions[name]
    let readyCount: number | undefined
    const ready = (): number => {
      readyCount ??= countReady(faction.board, tick)
      return readyCount
    }
    for (const id of faction.crew) {
      const member = storage.crew[id]
      if (member === undefined || member.dead || !member.character.valid) continue
      const category = classify(faction, member, ready)
      let t = times[id]
      if (t === undefined) {
        t = newCrewTime(tick, category)
        times[id] = t
      }
      accrue(t, category, tick)
    }
  }
}

export interface TimeBreakdown {
  ticks: number
  byCategory: Record<TimeCategory, number>
}

function breakdownOf(parts: Partial<Record<TimeCategory, number>>[]): TimeBreakdown {
  const byCategory = {} as Record<TimeCategory, number>
  let ticks = 0
  for (const c of TIME_CATEGORIES) {
    let n = 0
    for (const p of parts) n += p[c] ?? 0
    byCategory[c] = n
    ticks += n
  }
  return { ticks, byCategory }
}

/** Since the member was first seen, and over the recent window. */
export function crewTime(id: number): { total: TimeBreakdown; recent: TimeBreakdown; current: TimeCategory; currentSince: number; start: number } | undefined {
  const t = storage.review?.time[id]
  if (!t) return undefined
  return { total: breakdownOf([t.total]), recent: breakdownOf(t.buckets), current: t.current, currentSince: t.currentSince, start: t.start }
}
