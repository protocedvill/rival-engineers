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
