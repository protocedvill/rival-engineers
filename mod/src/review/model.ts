import { MapPosition } from "factorio:runtime"
import { depsDone, isReady } from "../jobs/board"
import { FactionState } from "../jobs/types"
import { brainReport } from "../strategy/bootstrap"
import { crewTime, jobOfAction, TimeBreakdown } from "./time"
import { TimeCategory } from "./types"

// The data behind the inspector GUI: plain tables built from storage, so the GUI only renders them and
// tests can check them without a player.

export interface OldestJob {
  id: number
  kind: string
  ageTicks: number
  /** Why it is not being worked: "ready" (nobody took it), "deps", "back-off". */
  state: string
  reason?: string
  attempts: number
}

export interface FactionView {
  name: string
  index: number
  count: number
  force: string
  paused: boolean
  crew: number[]
  alive: number
  base?: MapPosition
  /** Brain phase: the current goal, or "done", or "no brain". */
  phase: string
  goalsDone: number
  goals: number
  steps: number
  waiting: string[]
  jobs: { ready: number; deps: number; backoff: number; claimed: number; done: number; failed: number; added: number; releases: number }
  oldest?: OldestJob
  stalls: number
  /** An unrecovered stall, if the faction is stalled right now. */
  stalled?: { since: number; reason: string; goal?: string }
  lastStall?: { tick: number; reason: string; recovered?: number }
}

export interface CrewView {
  id: number
  faction: string
  dead: boolean
  position?: MapPosition
  /** The running action, e.g. "mine iron-ore", plus its phase. */
  action?: string
  actionPhase?: string
  /** The job that action serves, e.g. "#12 place stone-furnace". */
  job?: string
  /** Actions queued on the controller (running one included). */
  queue: number
  claims: number
  category?: TimeCategory
  categoryTicks: number
  total?: TimeBreakdown
  recent?: TimeBreakdown
  jobsDone: number
  jobsReleased: number
  hauls: number
  deposits: number
  plans: number
  byKind: Record<string, number>
  lastFailure?: string
}

export function factionNames(): string[] {
  return storage.factionOrder
}

export function factionView(name: string, tick: number): FactionView | undefined {
  const f: FactionState | undefined = storage.factions[name]
  if (f === undefined) return undefined
  const board = f.board
  const jobs = { ready: 0, deps: 0, backoff: 0, claimed: 0, done: board.counters.completions, failed: board.counters.failures, added: board.counters.added, releases: board.counters.releases }
  let oldest: OldestJob | undefined
  for (const id of board.active) {
    const j = board.jobs[id]
    if (j.status === "claimed") {
      jobs.claimed++
      continue
    }
    if (j.status !== "open") continue
    let state: string
    if (isReady(board, j, tick)) {
      jobs.ready++
      state = "ready"
    } else if (!depsDone(board, j)) {
      jobs.deps++
      state = "deps"
    } else {
      jobs.backoff++
      state = "back-off"
    }
    // Oldest open job that could run: dependency chains are waiting by design, so prefer ready/back-off ones.
    if (state !== "deps" && (oldest === undefined || j.createdTick < tick - oldest.ageTicks)) {
      oldest = { id, kind: j.payload.kind, ageTicks: tick - j.createdTick, state, reason: j.reason, attempts: j.attempts }
    }
  }
  let alive = 0
  for (const id of f.crew) {
    const m = storage.crew[id]
    if (m !== undefined && !m.dead && m.character.valid) alive++
  }
  const report = brainReport(f)
  let phase = "no brain (jobs added from outside)"
  let stalled: FactionView["stalled"]
  let lastStall: FactionView["lastStall"]
  let stalls = 0
  if (report) {
    phase = report.done ? "bootstrap done (first-electricity materials)" : (report.current ?? "planning")
    stalls = report.stalls.length
    const last = report.stalls[report.stalls.length - 1]
    if (last !== undefined) {
      lastStall = { tick: last.tick, reason: last.reason, recovered: last.recoveredTick }
      if (last.recoveredTick === undefined) stalled = { since: last.tick - last.idleFor, reason: last.reason, goal: last.goal }
    }
  }
  const index = storage.factionOrder.indexOf(name) + 1
  return {
    name,
    index,
    count: storage.factionOrder.length,
    force: f.force,
    paused: f.paused,
    crew: f.crew,
    alive,
    base: f.brain?.hub ?? f.brain?.base,
    phase,
    goalsDone: report?.goalsDone ?? 0,
    goals: report?.goals ?? 0,
    steps: report?.steps ?? 0,
    waiting: report?.waiting ?? [],
    jobs,
    oldest,
    stalls,
    stalled,
    lastStall,
  }
}

function describeAction(spec: { kind: string } & Record<string, unknown>): string {
  const s = spec as Record<string, unknown>
  switch (spec.kind) {
    case "walk":
      return "walk"
    case "mine": {
      const t = s.target as { valid: boolean; name: string } | undefined
      return t && t.valid ? `mine ${t.name}` : "mine"
    }
    case "craft":
      return `craft ${s.count as number}× ${s.recipe as string}`
    case "place":
      return `place ${s.item as string}`
    case "insert":
    case "take": {
      const e = s.entity as { valid: boolean; name: string } | undefined
      return `${spec.kind} ${s.count as number} ${s.item as string}${e && e.valid ? (spec.kind === "insert" ? " → " : " ← ") + e.name : ""}`
    }
    case "pickUp": {
      const e = s.entity as { valid: boolean; name: string } | undefined
      return e && e.valid ? `pick up ${e.name}` : "pick up"
    }
  }
  return spec.kind
}

export function jobLabel(job: { id: number; payload: { kind: string } & Record<string, unknown> }): string {
  const p = job.payload as Record<string, unknown>
  let what = ""
  if (typeof p.item === "string") what = " " + p.item
  else if (typeof p.recipe === "string") what = " " + p.recipe
  return `#${job.id} ${job.payload.kind}${what}`
}

export function crewView(id: number, tick: number): CrewView | undefined {
  const m = storage.crew[id]
  if (m === undefined) return undefined
  const f = storage.factions[m.faction]
  const ctrl = storage.controllers[m.controller] as (typeof storage.controllers)[number] | undefined
  const view: CrewView = {
    id,
    faction: m.faction,
    dead: m.dead || !m.character.valid,
    position: m.character.valid ? { x: m.character.position.x, y: m.character.position.y } : undefined,
    queue: ctrl?.queue.length ?? 0,
    claims: m.claims.length,
    categoryTicks: 0,
    jobsDone: m.stats.jobsDone,
    jobsReleased: m.stats.jobsReleased,
    hauls: m.stats.hauls,
    deposits: m.stats.deposits ?? 0,
    plans: m.stats.plans,
    byKind: m.stats.byKind ?? {},
  }
  const actionId = ctrl?.queue[0]
  const action = actionId !== undefined ? storage.actions[actionId] : undefined
  if (action) {
    view.action = describeAction(action.spec as never)
    view.actionPhase = action.walk ? `${action.phase ?? action.status}/${action.walk.phase}` : (action.phase ?? action.status)
    if (f !== undefined) {
      const job = jobOfAction(f, m, action.id)
      if (job) view.job = jobLabel(job as never)
    }
  }
  if (ctrl !== undefined) {
    for (let i = ctrl.finished.length - 1; i >= 0; i--) {
      const a = storage.actions[ctrl.finished[i]]
      if (a !== undefined && a.status === "failed") {
        view.lastFailure = `${describeAction(a.spec as never)}: ${a.reason ?? "?"}${a.detail ? " (" + a.detail + ")" : ""} at ${math.floor((a.finishedTick ?? 0) / 60)} s`
        break
      }
    }
  }
  const t = crewTime(id)
  if (t) {
    view.category = t.current
    view.categoryTicks = tick - t.currentSince
    view.total = t.total
    view.recent = t.recent
  }
  return view
}
