// Factory goal scheduling policy. Pure: no Factorio globals, storage, entities, jobs, planner calls or logging.
//
// Keep this module boring. factory.ts translates the live game into this snapshot, then executes the returned
// decisions. That makes the ordering rules replayable in T1 without pretending Factorio objects can be serialized.

import type { GoalKind } from "./design"

export interface GoalSelectionSpec {
  kind: GoalKind
  cluster?: number
  techs: string[]
  growth?: { role: string; have: number; need: number; units: number; power: boolean; failed: number }
}

export interface GoalSelectionState {
  /** A planning/building goal already exists for each listed kind. */
  active: Partial<Record<GoalKind, boolean>>
  /** The most recent goal of each listed kind is done. */
  built: Partial<Record<GoalKind, boolean>>
  planning: boolean
  powerNodeExists: boolean
  /** The active growth goal expands the steam block. */
  growingPower: boolean
  researched: Record<string, boolean>
  growMaxFails: number
}

export interface GoalDecision {
  index: number
  /** A start is attempted by the runtime adapter. A grow attempt may still fail and allow later decisions. */
  action: "start" | "skip"
  /** User-facing causal explanation for a skip. Silent skips encode ordering without duplicating a reason. */
  waiting?: string
}

export interface GoalSelection {
  /** Blocked-growth explanations are always reported, even if another goal starts. */
  waiting: string[]
  /** Decisions in source order. The adapter stops after the first successfully started goal. */
  decisions: GoalDecision[]
  pending: number
}

function growthBlocked(spec: GoalSelectionSpec, maxFails: number): boolean {
  const g = spec.growth
  return spec.kind === "grow" && g !== undefined && (g.units < 1 || g.failed >= maxFails)
}

function shortGrowth(g: NonNullable<GoalSelectionSpec["growth"]>): string {
  const failed = g.failed > 0 ? ` (${g.failed} failed expansions)` : ""
  return `${g.role} short (${string.format("%.3g", g.have)}/${string.format("%.3g", g.need)}): cannot grow${failed}`
}

/** Evaluate ordering and blockers without touching live runtime state. */
export function selectGoals(specs: GoalSelectionSpec[], state: GoalSelectionState): GoalSelection {
  const waiting: string[] = []
  const pending: { spec: GoalSelectionSpec; index: number }[] = []
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index]
    if (growthBlocked(spec, state.growMaxFails)) waiting.push(shortGrowth(spec.growth!))
    else pending.push({ spec, index })
  }
  if (pending.length === 0 || state.planning) return { waiting, decisions: [], pending: pending.length }

  let powerGrow = false
  let anyGrow = false
  let earlierProduction: number | undefined
  for (const { spec } of pending) {
    if (spec.kind === "grow") {
      anyGrow = true
      if (spec.growth?.power) powerGrow = true
    }
    if (spec.kind === "production" && (earlierProduction === undefined || (spec.cluster ?? 1) < earlierProduction)) earlierProduction = spec.cluster ?? 1
  }

  const decisions: GoalDecision[] = []
  for (const { spec, index } of pending) {
    if (state.active[spec.kind]) {
      decisions.push({ index, action: "skip" })
      continue
    }
    const cluster = spec.cluster ?? 1
    if (spec.kind === "labs" && !state.built.power && !state.active.power && !state.powerNodeExists) {
      decisions.push({ index, action: "skip", waiting: "labs wait for power" })
      continue
    }
    if (cluster > 1 && (spec.kind === "labs" || spec.kind === "production")) {
      const blocked: string[] = []
      if (spec.kind === "labs" && (state.active.production || (earlierProduction !== undefined && earlierProduction < cluster))) blocked.push("the previous cluster's production")
      if (anyGrow || state.active.grow) blocked.push("growth of the built modules")
      if (blocked.length > 0) {
        decisions.push({ index, action: "skip", waiting: `${spec.kind} #${cluster} waits for ${blocked.join(", ")}` })
        continue
      }
    }
    if (spec.kind === "production" || spec.kind === "grow" || spec.kind === "mall") {
      const blocked: string[] = []
      // B52: a growth reroutes the routes around its module; a goal still building (the mall's included) would keep
      // placing its old copy of a rerouted route. A growth waits for every other active goal.
      const before: GoalKind[] = spec.kind === "production" ? ["power", "labs"] : spec.kind === "grow" ? ["power", "labs", "production", "mall", "repair", "temp", "radar"] : ["power", "labs", "production"]
      for (const kind of before) {
        // B29: a power/fuel growth is the critical path out of a power-short production stall. An active production
        // building must not block it; `startGrow` still waits if its reroute would touch that production's route (B52).
        if (spec.kind === "grow" && spec.growth?.power === true && kind === "production") continue
        if (state.active[kind]) blocked.push(kind)
      }
      if (spec.kind !== "grow" && (powerGrow || state.growingPower)) blocked.push("the steam block's growth")
      if (blocked.length > 0) {
        decisions.push({ index, action: "skip", waiting: `${spec.kind} waits for ${blocked.join(", ")}` })
        continue
      }
      const missing = spec.techs.filter((tech) => !state.researched[tech])
      if (missing.length > 0) {
        decisions.push({ index, action: "skip", waiting: `${spec.kind} waits for research: ${missing.join(", ")}` })
        continue
      }
    }
    if (spec.kind === "grow" && powerGrow && !spec.growth?.power) {
      decisions.push({ index, action: "skip" })
      continue
    }
    decisions.push({ index, action: "start" })
  }
  return { waiting, decisions, pending: pending.length }
}
