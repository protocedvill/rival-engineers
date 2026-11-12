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
export function feedsBuilding(f: FactoryState, spec: GoalSpec, stalled = false): boolean {
  for (const e of spec.edges) {
    const to = LG.nodeByRole(f.graph, e.to)
    // B198: with a production goal stalled, an unfed input of a built module counts too (see `feedsBuildingAll`).
    if (to === undefined || !(to.lifecycle === "building" || (stalled && to.lifecycle === "built"))) continue
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
 * B198 (`m7-b197` seed 3333, min 330): `feedsBuilding` for every spec. While a production goal is stalled, a goal that
 * restores an input nothing feeds on a built module may start too, and so may the goals upstream of one that may (a
 * chain is split into layer goals: the mine's goal has no edge of its own). The steel column's iron supplier was torn
 * down (B51); its replacement chain waited for the oil complex, whose refinery craft waited for that steel.
 */
export function feedsBuildingAll(f: FactoryState, specs: GoalSpec[], stalled: boolean): boolean[] {
  const out = specs.map((s) => s.kind === "production" && feedsBuilding(f, s, stalled))
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < specs.length; i++) {
      if (out[i] || specs[i].kind !== "production") continue
      const roles: Record<string, boolean> = {}
      for (const n of specs[i].nodes) roles[n.role] = true
      for (let j = 0; j < specs.length && !out[i]; j++) {
        if (out[j] && specs[j].edges.some((e) => roles[e.from] === true)) out[i] = true
      }
      if (out[i]) changed = true
    }
  }
  return out
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

/**
 * B185 (user, 2026-11-11: solar buildings are made by machines): the stock rows (`stock:<item>`) a power goal's solar
 * fields wait for. A row waits while it is in the graph unbuilt or in another goal still to build; a stock the design
 * does not plan (its recipe not enabled yet) is waited for as `research:<item>` (B196, `locked`). `itemOf` maps an
 * entity to the item placing it.
 */
export function stockWaits(f: FactoryState, specs: GoalSpec[], spec: GoalSpec, itemOf: (this: void, entity: string) => string, locked?: (this: void, item: string) => boolean): string[] {
  const out: string[] = []
  for (const n of spec.nodes) {
    if (n.generator !== "solar-field") continue
    for (const e of n.def.entities) {
      const item = itemOf(e.name)
      // B196 (`m7-b193` seed 11, min 197): a building whose recipe is still locked has no stock row to wait for; the
      // goal started and its crew stalled placing solar panels nothing could make. It waits for the research instead.
      if (locked?.(item) === true) {
        if (out.indexOf(`research:${item}`) < 0) out.push(`research:${item}`)
        continue
      }
      const role = `stock:${item}`
      if (out.indexOf(role) >= 0) continue
      const built = LG.nodeByRole(f.graph, role)
      const planned = specs.some((s) => s !== spec && s.nodes.some((m) => m.role === role))
      if ((built !== undefined && built.lifecycle !== "built") || (built === undefined && planned)) out.push(role)
    }
  }
  return out
}
