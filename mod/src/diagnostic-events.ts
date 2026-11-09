// Bounded, structured decision history. Events are plain save-safe data: never put LuaObjects in this stream.

import type { GoalId, JobId } from "./shared/ids"

export type DiagnosticEventKind = "crew-plan" | "crew-supply" | "goal" | "planner" | "churn"

/**
 * Stable decision codes for host tools. Keep them free of prose and stable across saves; put the explanation in
 * `reason`/`detail`. A new decision is added here so a typo cannot silently create a new code in telemetry.
 */
export type DiagnosticDecision = "idle" | "batch" | "haul" | "growth-rejected" | "adoption-resumed" | "adoption-intent-orphaned" | "adoption-intent-cleared" | "stale-plan-rejected" | "invalid-plan-delta" | "orphan-claims" | "orphan-ghost"

export interface DiagnosticEvent {
  seq?: number
  tick: number
  lastTick?: number
  repeats?: number
  kind: DiagnosticEventKind
  member?: number
  job?: JobId
  goal?: GoalId
  plan?: string
  decision: DiagnosticDecision
  reason?: string
  counts?: Record<string, number>
  data?: Record<string, unknown>
}

export interface DiagnosticEventStore {
  next: number
  /** Independent buckets prevent a noisy subsystem from evicting another subsystem's evidence. */
  buckets: DiagnosticEventBuckets
  /** Subject → last event, used only to coalesce identical idle/failure observations. */
  last?: Record<string, { signature: string; seq: number }>
}

export interface DiagnosticEventBuckets {
  "crew-plan"?: DiagnosticEvent[]
  "crew-supply"?: DiagnosticEvent[]
  goal?: DiagnosticEvent[]
  planner?: DiagnosticEvent[]
  churn?: DiagnosticEvent[]
}

export interface DiagnosticEventOwner {
  diagnosticEvents?: DiagnosticEventStore
}

export const DIAGNOSTIC_EVENTS_KEPT_PER_KIND = 512

function store(owner: DiagnosticEventOwner): DiagnosticEventStore {
  owner.diagnosticEvents ??= { next: 1, buckets: {} }
  return owner.diagnosticEvents
}

/** Append an event, or coalesce it with the latest event for `subject` when the signature is unchanged. */
export function recordDiagnostic(owner: DiagnosticEventOwner, event: DiagnosticEvent, subject?: string, signature?: string): DiagnosticEvent {
  const state = store(owner)
  const events = (state.buckets[event.kind] ??= [])
  if (subject !== undefined && signature !== undefined) {
    const previous = state.last?.[subject]
    if (previous?.signature === signature) {
      for (let i = events.length - 1; i >= 0; i--) {
        const found = events[i]
        if (found.seq !== previous.seq) continue
        found.lastTick = event.tick
        found.repeats = (found.repeats ?? 1) + 1
        return found
      }
    }
  }
  event.seq = state.next++
  events.push(event)
  while (events.length > DIAGNOSTIC_EVENTS_KEPT_PER_KIND) events.shift()
  if (subject !== undefined && signature !== undefined) {
    state.last ??= {}
    state.last[subject] = { signature, seq: event.seq }
  }
  return event
}

export function recentDiagnosticBuckets(owner: DiagnosticEventOwner, limitPerKind = 64): DiagnosticEventBuckets {
  const out: DiagnosticEventBuckets = {}
  const buckets = owner.diagnosticEvents?.buckets
  if (buckets === undefined) return out
  for (const kind of ["crew-plan", "crew-supply", "goal", "planner", "churn"] as DiagnosticEventKind[]) {
    const events = buckets[kind]
    if (events !== undefined) out[kind] = events.slice(math.max(0, events.length - limitPerKind))
  }
  return out
}

export interface ChurnFinding {
  code: "job-churn" | "preempt-churn" | "plan-churn"
  detail: string
  numerator: number
  denominator: number
}

/** Pure detector over cumulative counters. Callers decide whether and how often to report it. */
export function detectChurn(input: {
  claims: number
  releases: number
  completions: number
  preemptions: number
  preemptTaken: number
  planFailures?: number
  planSuccesses?: number
}, minimum = 32, ratio = 10): ChurnFinding[] {
  const out: ChurnFinding[] = []
  const boardMoves = input.claims + input.releases
  if (boardMoves >= minimum && boardMoves > ratio * math.max(1, input.completions)) out.push({ code: "job-churn", detail: `${boardMoves} claims/releases for ${input.completions} completions`, numerator: boardMoves, denominator: input.completions })
  if (input.preemptions >= minimum && input.preemptions > ratio * math.max(1, input.preemptTaken)) out.push({ code: "preempt-churn", detail: `${input.preemptions} preemptions for ${input.preemptTaken} successful takes`, numerator: input.preemptions, denominator: input.preemptTaken })
  const attempts = (input.planFailures ?? 0) + (input.planSuccesses ?? 0)
  if (attempts >= minimum && (input.planFailures ?? 0) > ratio * math.max(1, input.planSuccesses ?? 0)) out.push({ code: "plan-churn", detail: `${input.planFailures} failed plans for ${input.planSuccesses} successful plans`, numerator: input.planFailures ?? 0, denominator: input.planSuccesses ?? 0 })
  return out
}
