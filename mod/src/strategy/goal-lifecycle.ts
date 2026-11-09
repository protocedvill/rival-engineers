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

/**
 * Review fix (stall detector): whether an overdue stall may fire now. Planner work is not progress: a goal that keeps
 * failing and replanning computes forever and places nothing (the Layers14 coal-provider loop). But one long plan may
 * legitimately outlast `stallTicks` (the 26-module g207 chain took >15 game-min). So the plan(s) running when the
 * deadline passes get one grace (`hold`): the stall waits while one of them still runs. When they end without progress
 * (a failed plan; an adoption counts as progress and clears the hold), the stall fires even if a retry is planning: a
 * retry gets no new grace.
 */
export function stallDecision(overdue: boolean, running: readonly string[], hold: readonly string[] | undefined): { fire: boolean; hold?: string[] } {
  if (!overdue) return { fire: false }
  if (hold === undefined) return running.length > 0 ? { fire: false, hold: [...running] } : { fire: true }
  for (const id of hold) if (running.indexOf(id) >= 0) return { fire: false, hold: [...hold] }
  return { fire: true }
}
