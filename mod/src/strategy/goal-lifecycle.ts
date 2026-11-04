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
 * B135: whether a module's own entities all stand in a plan: no still-valid ghost lies inside its rect. A module can be
 * marked built before the whole plan finishes (the blue line's steel smelter stood while the same plan's pumpjack waited
 * for its steel).
 */
export function modulePlaced(rect: { x: number; y: number; w: number; h: number }, ghosts: readonly { valid: boolean; position: { x: number; y: number } }[]): boolean {
  for (const gh of ghosts) {
    if (!gh.valid) continue
    const x = gh.position.x
    const y = gh.position.y
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return false
  }
  return true
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
