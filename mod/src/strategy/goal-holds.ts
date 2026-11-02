// M7c: when a goal holds up others (goal ordering, B52/B98 growth waits) and when it no longer may. Pure: plain factory
// state only (split out of `factory.ts`, whose compiled chunk sits at the Lua locals limit).

import * as LG from "../planner/logical"
import type { GoalSpec } from "./design"
import type { FactoryGoal, FactoryState } from "./factory"

/**
 * M7c (user-approved 2026-11-02): a building goal that has placed nothing for `stallTicks`. It holds no ordering lock:
 * the goals that would unblock it may start (seed 11: the blue line waited ~6 game-hours on 3 pumpjacks needing steel,
 * while the iron mine feeding its steel waited for it to finish).
 */
export function goalStalled(tick: number, stallTicks: number, g: FactoryGoal | undefined): boolean {
  if (g === undefined || g.status !== "building") return false
  return tick - (g.progressTick ?? g.plannedTick ?? g.createdTick) >= stallTicks
}

/** M7c: whether the goal building graph node `id` is stalled (`goalStalled`). */
export function nodeGoalStalled(f: FactoryState, tick: number, stallTicks: number, id: string): boolean {
  const goal = f.graph.nodes[id]?.goal
  return goal !== undefined && goalStalled(tick, stallTicks, f.goals.find((g) => g.id === goal))
}

/** M7c: whether `spec` feeds an input of a module still being built that no edge of the graph feeds now. */
export function feedsBuilding(f: FactoryState, spec: GoalSpec): boolean {
  for (const e of spec.edges) {
    const to = LG.nodeByRole(f.graph, e.to)
    if (to === undefined || to.lifecycle !== "building") continue
    let fed = false
    for (const id of f.graph.edgeOrder) {
      const ge = f.graph.edges[id]
      if (ge.to === to.id && ge.toPort === e.toPort) fed = true
    }
    if (!fed) return true
  }
  return false
}
