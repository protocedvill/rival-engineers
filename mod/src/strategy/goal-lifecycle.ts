/** Pure lifecycle rules for factory goals. Keep coordinator side effects out of this module. */

export type GoalStatus = "planning" | "building" | "done" | "failed"

const TRANSITIONS: Record<GoalStatus, Partial<Record<GoalStatus, boolean>>> = {
  planning: { planning: true, building: true, failed: true },
  building: { building: true, done: true, failed: true },
  done: {},
  failed: {},
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return TRANSITIONS[from][to] === true
}

/** Returns the validated next state, letting the owning coordinator perform the one persistent assignment. */
export function nextGoalStatus(from: GoalStatus, to: GoalStatus, goal = "?"): GoalStatus {
  if (!canTransitionGoal(from, to)) error(`invalid goal transition ${goal}: ${from} -> ${to}`)
  return to
}

/**
 * Whether goals of `kind` ever completed (the factory has one, e.g. power). Not the last goal of the kind: B108 (two
 * factions, seed 3333) a later power goal that failed for want of coal made "power not built", and the D62 outpost that
 * would find the coal waited for power forever.
 */
export function everDone(goals: readonly { kind: string; status: GoalStatus }[], kind: string): boolean {
  for (const g of goals) if (g.kind === kind && g.status === "done") return true
  return false
}
