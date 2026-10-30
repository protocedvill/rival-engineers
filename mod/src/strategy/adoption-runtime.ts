// Runtime glue for the persisted adoption record (adoption-intent.ts). It lives outside factory.ts because TSTL emits
// one main-chunk local per top-level function and import, and Lua caps a chunk at 200 locals (the build guards 185).
// Everything here is a thin adapter: the phase/resume rules stay pure in adoption-intent.ts.

import { addClearJob, clearJobFor } from "../jobs/faction"
import { recordDiagnostic } from "../diagnostic-events"
import type { LuaEntity } from "factorio:runtime"
import * as RT from "../planner/runtime"
import { advanceAdoption, adoptionResume, adoptionShouldClear, beginAdoption, describeAdoption } from "./adoption-intent"
import type { AdoptionIntent } from "./adoption-intent"
import type { FactoryGoal, FactoryState } from "./factory"
import type { FactionState } from "../jobs/types"

export type { AdoptionIntent } from "./adoption-intent"

/**
 * Clears a persisted record whose adoption has committed (the goal is no longer planning) or whose goal/plan vanished.
 * A record whose goal is still planning is left for the adoption to resume.
 */
export function reconcile(faction: FactionState, f: FactoryState): void {
  const intent = f.adoption
  if (intent === undefined) return
  const goal = f.goals.find((g) => g.id === intent.goal)
  const entry = RT.getPlannerEntry(intent.plan)
  if (!adoptionShouldClear(intent, goal?.status, entry !== undefined)) return
  recordDiagnostic(faction, { tick: game.tick, kind: "planner", goal: intent.goal, plan: intent.plan, decision: "adoption-intent-cleared", reason: describeAdoption(intent) })
  log(`[rival-engineers] faction ${faction.name}: clears a stale adoption record (${describeAdoption(intent)})`)
  f.adoption = undefined
}

/**
 * Starts (or resumes) the record for this adoption, recording why. A record for another plan is discarded with a
 * diagnostic: only one plan is active at a time, so it is a leftover from an interrupted adoption that will not be
 * completed.
 */
export function begin(faction: FactionState, f: FactoryState, g: FactoryGoal, plan: string, tick: number): AdoptionIntent {
  const resume = adoptionResume(f.adoption, g.id, plan)
  if (resume === "other" && f.adoption !== undefined) {
    recordDiagnostic(faction, { tick, kind: "planner", goal: g.id, plan, decision: "adoption-intent-orphaned", reason: describeAdoption(f.adoption) })
    log(`[rival-engineers] faction ${faction.name}: discards an interrupted adoption record for another plan (${describeAdoption(f.adoption)})`)
  } else if (resume === "resume" && f.adoption !== undefined) {
    recordDiagnostic(faction, { tick, kind: "planner", goal: g.id, plan, decision: "adoption-resumed", reason: describeAdoption(f.adoption) })
    log(`[rival-engineers] faction ${faction.name}: resumes the interrupted adoption of plan ${plan} (${f.adoption.phase})`)
  }
  const intent = resume === "resume" && f.adoption !== undefined ? f.adoption : beginAdoption(g.id, plan, tick)
  intent.tick = tick
  f.adoption = intent
  return intent
}

export function advance(intent: AdoptionIntent, phase: "state" | "world" | "build"): void {
  advanceAdoption(intent, phase)
}

/** Adds a clear job for `e` unless one is already scheduled, so a resumed adoption cannot queue it twice. */
export function queueClear(faction: FactionState, b: RT.BuildState, e: LuaEntity, priority: number): void {
  if (e.valid && clearJobFor(faction, e) !== undefined) return
  b.clearJobs.push(addClearJob(faction, e, priority))
}
