// M7c: when a goal holds up others (goal ordering, B52/B98 growth waits) and when it no longer may. Pure: plain factory
// state only (split out of `factory.ts`, whose compiled chunk sits at the Lua locals limit).

import type { BuildParts } from "../planner/build-list"
import * as LG from "../planner/logical"
import type { GoalId } from "../shared/ids"
import type { GoalSpec } from "./design"
import type { FactoryGoal, FactoryState } from "./factory"

/**
 * M7c (user-approved 2026-11-02): a building goal that has placed nothing for `stallTicks`. Growths stop waiting for it
 * (B52/B98 in `startGrow`), so the ones that would unblock it may start (seed 11: the blue line waited ~6 game-hours on
 * 3 pumpjacks needing steel, while the iron mine feeding its steel waited for it). It keeps its kind's ordering lock.
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

/**
 * B180 (m7-fresh6 seed 11, g111/g112): the parts building goals are still placing (route, module or pole-line ids), each
 * with its goal. A remedy that changed one of them under such a goal left that goal placing pieces no layout owned any
 * more (reported as orphans) and then blocked it on the new pieces; the remedy waits for the goal instead. A stalled
 * goal places nothing, so nothing waits for it (as in B52).
 */
export function placingOwners(f: FactoryState, tick: number, stallTicks: number, planParts: (this: void, plan: string) => BuildParts | undefined): Record<string, GoalId> {
  const out: Record<string, GoalId> = {}
  for (const g of f.goals) {
    if (g.status !== "building" || goalStalled(tick, stallTicks, g)) continue
    for (const e of g.growBuild?.add ?? []) out[e.owner] ??= g.id
    const parts = g.plan !== undefined ? planParts(g.plan) : undefined
    for (const id of [...(parts?.routes ?? []), ...(parts?.modules ?? [])]) out[id] ??= g.id
  }
  return out
}
