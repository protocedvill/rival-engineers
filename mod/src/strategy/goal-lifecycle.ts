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
 * B135: whether a module's own entities all stand in a plan. Only ghosts at the module's own entity positions block it:
 * a route, pole line or another module's ghost passing through the rect must not keep it unbuilt. A module can be marked
 * built before the whole plan finishes (the blue line's steel smelter stood while the same plan's pumpjack waited for its
 * steel).
 */
export function modulePlaced(positions: readonly { x: number; y: number }[], ghosts: readonly { valid: boolean; position: { x: number; y: number } }[]): boolean {
  const own: Record<string, boolean> = {}
  for (const p of positions) own[`${p.x},${p.y}`] = true
  for (const gh of ghosts) {
    if (!gh.valid) continue
    if (own[`${gh.position.x},${gh.position.y}`] === true) return false
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
