// Job Board scheduling logic (SPEC §5.2): pure data and functions, no Factorio globals, so T1 unit tests
import { jobId } from "../shared/ids"
import type { JobId } from "../shared/ids"
// can run it outside the game (mod/unit/board.test.ts). The runtime side (mod/src/jobs/crew.ts) owns the
// entities and controller actions; it keeps them in each job's `payload`.
//
// A board belongs to one faction and lives in storage. Claims are exclusive: a job has at most one
// `claimedBy`, and `claim` refuses (and counts) any attempt to claim a job that is not ready and unclaimed.

export interface Pos {
  x: number
  y: number
}

/** Axis-aligned box, left-top to right-bottom, in map coordinates. */
export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface ItemCount {
  item: string
  count: number
}

export type JobKind = "gather" | "craft" | "haul" | "place" | "fuel" | "clear"

/** open → claimed → done, or back to open (released), or failed (terminal, with a reason). */
export type JobStatus = "open" | "claimed" | "done" | "failed"

export interface Job<P = unknown> {
  id: JobId
  kind: JobKind
  /** Where the work happens: nearest-first selection and locality batching measure from here. */
  pos: Pos
  /** Tiles the finished job occupies (place jobs). Crew members don't pick standing spots inside these. */
  footprint?: Rect
  /** Items the crew member must carry to do the job. */
  materials: ItemCount[]
  /** Jobs that must be done first. A failed dependency fails this job too. */
  deps: JobId[]
  /** Higher first. */
  priority: number
  status: JobStatus
  claimedBy?: number
  /** Failed attempts so far (releases that count against the job). */
  attempts: number
  /** Unpenalised releases so far (crew death, a character in the way...). */
  deferrals?: number
  /** Not claimable before this tick (back-off after a failed attempt). */
  retryAt: number
  /** Why the last attempt failed, or why the job failed. */
  reason?: string
  /** Who finished it. */
  doneBy?: number
  createdTick: number
  finishedTick?: number
  /** Runtime data (entities, item names...), opaque to the board. */
  payload: P
}

export interface JobSpec<P> {
  kind: JobKind
  pos: Pos
  footprint?: Rect
  materials?: ItemCount[]
  deps?: JobId[]
  priority?: number
  payload: P
}

export interface BoardCounters {
  added: number
  /** Successful claims (one per job claimed). */
  claims: number
  /** Claim attempts on a job that was already claimed or not ready. Must stay 0. */
  doubleClaims: number
  releases: number
  completions: number
  failures: number
}

export interface ClaimEvent {
  tick: number
  job: number
  member: number
  event: "claim" | "release" | "done" | "fail"
  reason?: string
}

export interface Board<P = unknown> {
  jobs: Record<number, Job<P>>
  /** Ids of jobs that are open or claimed, in creation order (iteration order must be deterministic). */
  active: number[]
  nextId: number
  counters: BoardCounters
  /** The most recent claim events, newest last (bounded by CLAIM_LOG_KEPT). */
  claimLog: ClaimEvent[]
}

export const CLAIM_LOG_KEPT = 512

export function newBoard<P>(): Board<P> {
  return {
    jobs: {},
    active: [],
    nextId: 1,
    counters: { added: 0, claims: 0, doubleClaims: 0, releases: 0, completions: 0, failures: 0 },
    claimLog: [],
  }
}

function logEvent(board: Board<unknown>, event: ClaimEvent): void {
  board.claimLog.push(event)
  if (board.claimLog.length > CLAIM_LOG_KEPT) board.claimLog.shift()
}

export function addJob<P>(board: Board<P>, spec: JobSpec<P>, tick: number): Job<P> {
  const id = jobId(board.nextId++)
  const job: Job<P> = {
    id,
    kind: spec.kind,
    pos: { x: spec.pos.x, y: spec.pos.y },
    footprint: spec.footprint,
    materials: spec.materials ?? [],
    deps: spec.deps ?? [],
    priority: spec.priority ?? 0,
    status: "open",
    attempts: 0,
    retryAt: tick,
    createdTick: tick,
    payload: spec.payload,
  }
  board.jobs[id] = job
  board.active.push(id)
  board.counters.added++
  return job
}

export function getJob<P>(board: Board<P>, id: number): Job<P> | undefined {
  return board.jobs[id]
}

export function depsDone(board: Board<unknown>, job: Job<unknown>): boolean {
  for (const dep of job.deps) {
    const d: Job<unknown> | undefined = board.jobs[dep]
    if (d === undefined || d.status !== "done") return false
  }
  return true
}

/** Open, past its back-off, and every dependency done. */
export function isReady(board: Board<unknown>, job: Job<unknown>, tick: number): boolean {
  return job.status === "open" && job.retryAt <= tick && depsDone(board, job)
}

export function distance(a: Pos, b: Pos): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** True if `a` should be picked before `b` by a crew member at `from`: priority, then distance, then id. */
export function better(a: Job<unknown>, b: Job<unknown>, from: Pos): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  const da = distance(from, a.pos)
  const db = distance(from, b.pos)
  if (Math.abs(da - db) > 1e-9) return da < db
  return a.id < b.id
}

export type JobFilter<P> = (this: void, job: Job<P>) => boolean

/** The highest-priority ready job, nearest first (ties by id). `accept` can veto candidates. */
export function selectJob<P>(board: Board<P>, from: Pos, tick: number, accept?: JobFilter<P>): Job<P> | undefined {
  let best: Job<P> | undefined
  for (const id of board.active) {
    const job = board.jobs[id]
    if (!isReady(board, job, tick)) continue
    if (accept && !accept(job)) continue
    if (best === undefined || better(job, best, from)) best = job
  }
  return best
}

export function countReady(board: Board<unknown>, tick: number): number {
  let n = 0
  for (const id of board.active) if (isReady(board, board.jobs[id], tick)) n++
  return n
}

/**
 * Claims every job in `ids` for `member`, or none: all must be ready. Each refused job counts as a
 * double-claim attempt if it is already claimed. Returns whether the claim happened.
 */
export function claim(board: Board<unknown>, ids: number[], member: number, tick: number): boolean {
  let okAll = true
  for (const id of ids) {
    const job: Job<unknown> | undefined = board.jobs[id]
    if (job === undefined || !isReady(board, job, tick)) {
      if (job !== undefined && job.status === "claimed") board.counters.doubleClaims++
      okAll = false
    }
  }
  if (!okAll) return false
  for (const id of ids) {
    const job = board.jobs[id]
    job.status = "claimed"
    job.claimedBy = member
    board.counters.claims++
    logEvent(board, { tick, job: id, member, event: "claim" })
  }
  return true
}

function removeActive(board: Board<unknown>, id: number): void {
  const index = board.active.indexOf(id)
  if (index >= 0) board.active.splice(index, 1)
}

/** Marks a claimed job done by its claimant. Returns false if `member` does not hold the claim. */
export function complete(board: Board<unknown>, id: number, member: number, tick: number): boolean {
  const job: Job<unknown> | undefined = board.jobs[id]
  if (job === undefined || job.status !== "claimed" || job.claimedBy !== member) return false
  job.status = "done"
  job.claimedBy = undefined
  job.doneBy = member
  job.finishedTick = tick
  board.counters.completions++
  removeActive(board, id)
  logEvent(board, { tick, job: id, member, event: "done" })
  return true
}

/** Fails a job for good, and every active job that depends on it (transitively). */
export function failJob(board: Board<unknown>, id: number, reason: string, tick: number, member = 0): void {
  const job: Job<unknown> | undefined = board.jobs[id]
  if (job === undefined || job.status === "done" || job.status === "failed") return
  job.status = "failed"
  job.claimedBy = undefined
  job.reason = reason
  job.finishedTick = tick
  board.counters.failures++
  removeActive(board, id)
  logEvent(board, { tick, job: id, member, event: "fail", reason })
  for (const other of [...board.active]) {
    const o = board.jobs[other]
    if (o.deps.indexOf(jobId(id)) >= 0) failJob(board, other, `dep-failed:${id}`, tick, member)
  }
}

export interface ReleaseOptions {
  reason?: string
  /** Counts as a failed attempt: back-off, and fail after maxAttempts. False for e.g. crew death. */
  penalize: boolean
  maxAttempts: number
  /** Base back-off in ticks; doubles with each attempt. */
  retryTicks: number
  /** Unpenalised releases only: claimable again after this many ticks (default 0). */
  delay?: number
}

/**
 * Gives a claimed job back. A penalised release backs off (retryTicks × 2^(attempts−1)) or fails the
 * job once it has used up maxAttempts. Returns false if `member` does not hold the claim.
 */
export function release(board: Board<unknown>, id: number, member: number, tick: number, options: ReleaseOptions): boolean {
  const job: Job<unknown> | undefined = board.jobs[id]
  if (job === undefined || job.status !== "claimed" || job.claimedBy !== member) return false
  board.counters.releases++
  logEvent(board, { tick, job: id, member, event: "release", reason: options.reason })
  job.status = "open"
  job.claimedBy = undefined
  if (options.reason !== undefined) job.reason = options.reason
  if (!options.penalize) {
    job.deferrals = (job.deferrals ?? 0) + 1
    job.retryAt = tick + (options.delay ?? 0)
    return true
  }
  job.attempts++
  if (job.attempts >= options.maxAttempts) {
    failJob(board, id, options.reason ?? "failed", tick, member)
    return true
  }
  job.retryAt = tick + options.retryTicks * 2 ** (job.attempts - 1)
  return true
}

/** Releases every job `member` holds, without penalty (e.g. the crew member died). */
export function releaseAllOf(board: Board<unknown>, member: number, tick: number, reason: string): number[] {
  const released: number[] = []
  for (const id of [...board.active]) {
    const job = board.jobs[id]
    if (job.status === "claimed" && job.claimedBy === member) {
      release(board, id, member, tick, { reason, penalize: false, maxAttempts: 1, retryTicks: 0 })
      released.push(id)
    }
  }
  return released
}

// ---------------------------------------------------------------------------------------------------
// Locality batching: place every reachable job from one standing spot.

/** Half the side of the square a standing character is treated as occupying (its box is ±0.2). */
const STANDER_HALF = 0.3

function overlaps(p: Pos, r: Rect): boolean {
  return p.x + STANDER_HALF > r.x1 && p.x - STANDER_HALF < r.x2 && p.y + STANDER_HALF > r.y1 && p.y - STANDER_HALF < r.y2
}

/**
 * The standing spot nearest to `from` from which every target is within `reach` (centre distance)
 * and that is outside every `avoid` rect. Candidates lie on a half-tile grid (tile centres and edges).
 * `isFree` is the runtime's collision check against real entities; it is called in order of preference
 * and at most `maxFreeChecks` times. Returns undefined if no candidate works.
 */
export function chooseStandingSpot(
  targets: Pos[],
  avoid: Rect[],
  from: Pos,
  reach: number,
  isFree?: (this: void, p: Pos) => boolean,
  maxFreeChecks = 12,
): Pos | undefined {
  if (targets.length === 0) return undefined
  let minX = targets[0].x
  let maxX = minX
  let minY = targets[0].y
  let maxY = minY
  for (const t of targets) {
    minX = Math.min(minX, t.x)
    maxX = Math.max(maxX, t.x)
    minY = Math.min(minY, t.y)
    maxY = Math.max(maxY, t.y)
  }
  // Any spot within reach of every target lies within reach of the bbox corners' span.
  const x0 = Math.floor(maxX - reach)
  const x1 = Math.ceil(minX + reach)
  const y0 = Math.floor(maxY - reach)
  const y1 = Math.ceil(minY + reach)
  if (x0 > x1 || y0 > y1) return undefined
  // Only avoid rects near the candidate area matter.
  const near: Rect[] = []
  for (const r of avoid) if (r.x2 >= x0 - 1 && r.x1 <= x1 + 1 && r.y2 >= y0 - 1 && r.y1 <= y1 + 1) near.push(r)

  const candidates: { p: Pos; d: number }[] = []
  for (let x = x0; x <= x1; x += 0.5) {
    for (let y = y0; y <= y1; y += 0.5) {
      const p = { x, y }
      let ok = true
      for (const t of targets) {
        if (distance(p, t) > reach) {
          ok = false
          break
        }
      }
      if (!ok) continue
      for (const r of near) {
        if (overlaps(p, r)) {
          ok = false
          break
        }
      }
      if (ok) candidates.push({ p, d: distance(p, from) })
    }
  }
  candidates.sort((a, b) => {
    if (a.d !== b.d) return a.d - b.d
    if (a.p.x !== b.p.x) return a.p.x - b.p.x
    return a.p.y - b.p.y
  })
  let checks = 0
  for (const c of candidates) {
    if (!isFree) return c.p
    if (checks++ >= maxFreeChecks) break
    if (isFree(c.p)) return c.p
  }
  return undefined
}

export interface BatchOptions<P> {
  /** Distance from the standing spot to every job position (centre to centre). */
  reach: number
  maxJobs: number
  accept?: JobFilter<P>
  isFree?: (this: void, p: Pos) => boolean
  /** More places not to stand, e.g. where other crew members stand or are heading. */
  extraAvoid?: Rect[]
}

export interface Batch {
  jobs: number[]
  /** Where to stand. Undefined: no common spot was found, so each job approaches on its own. */
  spot?: Pos
}

/**
 * Starting from `anchor` (already selected), collects other ready jobs of the same kind within reach of
 * the anchor, nearest the anchor first, and finds one standing spot that reaches all of them. Jobs are
 * dropped farthest-first until a spot exists. Footprints of every active job are avoided, so the crew
 * member never stands where something is about to be built.
 */
export function planBatch<P>(board: Board<P>, anchor: Job<P>, from: Pos, tick: number, options: BatchOptions<P>): Batch {
  const members: Job<P>[] = [anchor]
  const nearby: { job: Job<P>; d: number }[] = []
  const avoid: Rect[] = options.extraAvoid ? [...options.extraAvoid] : []
  for (const id of board.active) {
    const job = board.jobs[id]
    if (job.footprint) avoid.push(job.footprint)
    if (job === anchor || job.kind !== anchor.kind || !isReady(board, job, tick)) continue
    if (options.accept && !options.accept(job)) continue
    const d = distance(job.pos, anchor.pos)
    if (d <= options.reach) nearby.push({ job, d })
  }
  nearby.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.job.id - b.job.id))
  for (const n of nearby) {
    if (members.length >= options.maxJobs) break
    members.push(n.job)
  }
  while (members.length > 0) {
    const targets: Pos[] = []
    for (const m of members) targets.push(m.pos)
    const spot = chooseStandingSpot(targets, avoid, from, options.reach, options.isFree)
    if (spot) {
      const ids: number[] = []
      for (const m of members) ids.push(m.id)
      return { jobs: ids, spot }
    }
    if (members.length === 1) break
    members.pop()
  }
  return { jobs: [anchor.id] }
}

/**
 * Keeps the jobs (in order) whose materials fit in `available` cumulatively, so a batch never claims more
 * than the crew member can carry in or fetch. `available` is not modified. The first job is always
 * checked like the others.
 */
export function fitMaterials<P>(jobs: Job<P>[], available: Record<string, number>): Job<P>[] {
  const left: Record<string, number> = {}
  for (const item in available) left[item] = available[item]
  const kept: Job<P>[] = []
  for (const job of jobs) {
    let fits = true
    for (const m of job.materials) if ((left[m.item] ?? 0) < m.count) fits = false
    if (!fits) continue
    for (const m of job.materials) left[m.item] -= m.count
    kept.push(job)
  }
  return kept
}

/** Items still needed for `jobs` beyond what is `held` (sorted by item name for determinism). */
export function missingMaterials(jobs: Job<unknown>[], held: Record<string, number>): ItemCount[] {
  const need: Record<string, number> = {}
  const names: string[] = []
  for (const job of jobs) {
    for (const m of job.materials) {
      if (need[m.item] === undefined) {
        need[m.item] = 0
        names.push(m.item)
      }
      need[m.item] += m.count
    }
  }
  names.sort()
  const out: ItemCount[] = []
  for (const item of names) {
    const missing = need[item] - (held[item] ?? 0)
    if (missing > 0) out.push({ item, count: missing })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Trip batching (B3): mining work whose products go back to the depot is chained into one trip.

export interface TripOptions<P> {
  /** Most jobs in one trip, the anchor included. */
  maxJobs: number
  /** Every job of the trip lies within this distance of the anchor. */
  radius: number
  /** Which other ready jobs may join the trip (same kind of work, materials in hand...). */
  accept: JobFilter<P>
  /** Inventory slots a job's products take (fractions add up: 4 wood are 0.04 of a 100-stack slot). */
  load: (this: void, job: Job<P>) => number
  /** Slots the trip may fill. The anchor always goes, whatever its load. */
  capacity: number
}

/**
 * The anchor plus nearby ready jobs to do in one trip, in visiting order: each next job is the nearest remaining
 * candidate to the previous one (ties by id). Stops at `maxJobs` or when the next job's load would exceed `capacity`.
 */
export function planTrip<P>(board: Board<P>, anchor: Job<P>, tick: number, options: TripOptions<P>): number[] {
  const trip = [anchor.id]
  let used = options.load(anchor)
  const candidates: Job<P>[] = []
  for (const id of board.active) {
    const job = board.jobs[id]
    if (job.id === anchor.id || !isReady(board, job, tick) || !options.accept(job)) continue
    if (distance(job.pos, anchor.pos) > options.radius) continue
    candidates.push(job)
  }
  let last = anchor.pos
  while (trip.length < options.maxJobs && candidates.length > 0) {
    let bestIndex = 0
    let bestD = math.huge
    for (let i = 0; i < candidates.length; i++) {
      const d = distance(last, candidates[i].pos)
      if (d < bestD - 1e-9 || (math.abs(d - bestD) <= 1e-9 && candidates[i].id < candidates[bestIndex].id)) {
        bestD = d
        bestIndex = i
      }
    }
    const next = candidates[bestIndex]
    const load = options.load(next)
    if (used + load > options.capacity) break
    used += load
    trip.push(next.id)
    last = next.pos
    candidates.splice(bestIndex, 1)
  }
  return trip
}
