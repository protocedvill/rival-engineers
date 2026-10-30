// D69 (user decision in-session 2026-10-29, done in M7a): what a failed plan teaches the design, as one rule over typed
// failures. Each detector used to set its own flag map inside `factory.ts` `updatePlanning` (six of them, two reading
// the failure text); this returns the constraints to add and the factory stores them (`constraints.ts`).
//
// Pure: no Factorio globals (T1: mod/unit/failure-rules.test.ts).

import type { PlanFailure } from "../shared/plan-failure"
import type { ConstraintKind } from "./constraints"
import { feedKey, portKey } from "./constraints"

/** What a constraint change makes the next plan do; the factory logs the strongest one. */
export type Replan = "parallel providers" | "without that merge" | "a mine of its own" | "without taps"

export interface Learned {
  kind: ConstraintKind
  key: string
  replan: Replan
  /** Log line when the constraint is new (undefined: no line). */
  say?: string
}

export interface FailedPlanFacts {
  /** The plan's failures by key (a connection role, `module:<id>`, `power:<owner>`). */
  failures: { key: string; failure: PlanFailure }[]
  /** The goal's connections and modules. */
  edges: { role: string; from: string; to: string; toPort: string }[]
  nodes: { id: string; role: string; item?: string }[]
  /** Whether provider `role` already has a node in the faction's graph, and whether it is built. */
  provider: (this: void, role: string) => "built" | "planned" | undefined
  /** Whether another belt already feeds consumer `to`'s port `port` (so a route there can only merge). */
  portFed: (this: void, to: string, port: string, conn: string) => boolean
  /** The shared mine a plan folded module `id` into, if any (D52). */
  aliasOf: (this: void, id: string) => string | undefined
  /** Whether new consumers of `item` could tap a built producer with capacity instead (D68). */
  fallbackFor: (this: void, item: string) => boolean
}

/**
 * The constraints one failed plan teaches, in detection order:
 *
 * - B60/B61: a new shared provider whose site cannot reach several consumers → `providerSplit` (one provider each).
 * - B61: a failed feed from a provider the graph has → `providerNoTap` (reassign just that consumer).
 * - D68: a new producer that cannot be placed while a built one of its item has capacity → `fallback` (tap that one).
 * - B71/B80: a route into a port that found no merge target, or into a port another belt feeds → `noMerge`.
 * - B72: a new provider folded into a shared mine whose route failed → `ownSite`.
 * - B19: a failed connection from a provider the graph has → `noTap`.
 */
export function learnFromFailure(f: FailedPlanFacts): Learned[] {
  const out: Learned[] = []
  for (const { key, failure } of f.failures) {
    const [module] = string.match(key, "^module:(.*)$")
    const v = failure.reason
    for (const e of f.edges) {
      if (e.role !== key) continue
      let outgoing = 0
      for (const other of f.edges) if (other.from === e.from) outgoing++
      if (outgoing >= 2 && f.nodes.some((n) => n.role === e.from) && f.provider(e.from) !== "built") {
        out.push({ kind: "providerSplit", key: e.from, replan: "parallel providers", say: `${e.from} cannot reach every consumer from one site; planning parallel providers per consumer` })
      }
    }
    for (const e of f.edges) {
      if (e.role === key && f.provider(e.from) !== undefined) out.push({ kind: "providerNoTap", key: feedKey(e.from, e.to, e.toPort), replan: "without taps" })
    }
    for (const n of f.nodes) {
      if (n.id !== module || n.item === undefined || !f.fallbackFor(n.item)) continue
      out.push({ kind: "fallback", key: n.item, replan: "without taps", say: `D68 ${n.role} can't be placed (${v}): new ${n.item} consumers tap a built producer with capacity` })
    }
    for (const e of f.edges) {
      if (e.role !== key) continue
      if (failure.kind !== "no-merge-target" && !f.portFed(e.to, e.toPort, e.role)) continue
      const port = portKey(e.to, e.toPort)
      out.push({ kind: "noMerge", key: port, replan: "without that merge", say: `${port} takes no merge (${v}); its provider keeps it whole` })
    }
    for (const e of f.edges) {
      if (e.role !== key || f.provider(e.from) !== undefined) continue
      for (const n of f.nodes) {
        const mine = n.role === e.from ? f.aliasOf(n.id) : undefined
        if (mine !== undefined) out.push({ kind: "ownSite", key: n.role, replan: "a mine of its own", say: `${n.role} shared mine ${mine} has no route (${v}); it gets a site of its own` })
      }
    }
    for (const e of f.edges) {
      if (e.role === key && f.provider(e.from) !== undefined) out.push({ kind: "noTap", key: e.from, replan: "without taps", say: `${e.from} is not tapped again (${v})` })
    }
  }
  return out
}

/** The strongest replan among the newly added constraints (the order the factory always reported them in). */
export function strongestReplan(added: Replan[]): Replan | undefined {
  for (const r of ["parallel providers", "without that merge", "a mine of its own", "without taps"] as Replan[]) if (added.indexOf(r) >= 0) return r
  return undefined
}
