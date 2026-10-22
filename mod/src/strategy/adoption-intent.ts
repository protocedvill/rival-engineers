// The persisted record of an adoption in progress. Adoption changes storage (the layout, graph and reservations) and
// creates Factorio work (clear jobs, ghosts, a build job); a Lua error part-way leaves a half-applied state. This
// module owns the phase vocabulary and the resume decision. The adapter in `factory.ts` makes every phase safe to run
// again and clears the record at the commit point (the goal becoming `building`).
//
// Pure: no Factorio globals, so the decision is T1-testable and survives a save/reload unchanged.

import type { GoalStatus } from "./goal-lifecycle"

export type AdoptionPhase = "prepared" | "state" | "world" | "build"

/** Phases in execution order. `prepared` means the delta is validated and nothing persistent has changed yet. */
export const ADOPTION_PHASES: AdoptionPhase[] = ["prepared", "state", "world", "build"]

export interface AdoptionIntent {
  goal: string
  plan: string
  /** The last phase that was entered; a resumed adoption re-runs from the top and every phase is idempotent. */
  phase: AdoptionPhase
  /** The tick the record was last written or advanced (a diagnostic aid, not a decision input). */
  tick: number
}

export function beginAdoption(goal: string, plan: string, tick: number): AdoptionIntent {
  return { goal, plan, phase: "prepared", tick }
}

/** Advances the record forward; never backwards. Returns whether it moved. */
export function advanceAdoption(intent: AdoptionIntent, phase: AdoptionPhase): boolean {
  if (phaseIndex(phase) <= phaseIndex(intent.phase)) return false
  intent.phase = phase
  return true
}

function phaseIndex(phase: AdoptionPhase): number {
  for (let i = 0; i < ADOPTION_PHASES.length; i++) if (ADOPTION_PHASES[i] === phase) return i
  return -1
}

export type AdoptionResume = "fresh" | "resume" | "other"

/** Whether a persisted record belongs to the adoption being attempted now. */
export function adoptionResume(intent: AdoptionIntent | undefined, goal: string, plan: string): AdoptionResume {
  if (intent === undefined) return "fresh"
  if (intent.goal === goal && intent.plan === plan) return "resume"
  return "other"
}

/**
 * A record is stale when its goal is no longer planning (the adoption committed, or the goal failed) or its plan entry
 * is gone. The tick reconciles it to a diagnostic and clears it; the half-applied effects, if any, stay and are the
 * build's responsibility.
 */
export function adoptionShouldClear(intent: AdoptionIntent, status: GoalStatus | undefined, planExists: boolean): boolean {
  return status !== "planning" || !planExists
}

/** One stable line for diagnostics and logs. */
export function describeAdoption(intent: AdoptionIntent): string {
  return `goal ${intent.goal} plan ${intent.plan} phase ${intent.phase} since tick ${intent.tick}`
}
