// D69 (user decision in-session 2026-10-29, done in M7a): what a failed plan teaches the design, as one rule over typed
// failures. Each detector used to set its own flag map inside `factory.ts` `updatePlanning` (six of them, two reading
// the failure text); this returns the constraints to add and the factory stores them (`constraints.ts`).
//
// Pure: no Factorio globals (T1: mod/unit/failure-rules.test.ts).

import type { PlanFailure } from "../shared/plan-failure"
import type { ConstraintKind } from "./constraints"
import { feedKey, portKey } from "./constraints"
import type { TerrainView } from "../planner/grid"
import { findModule, sealedGoalPorts } from "../planner/layout"
import type { LayoutState, PortRef } from "../planner/layout"
import { sealedInputs } from "../planner/placement"

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
  /**
   * Whether built provider `role` has at least one belt edge in the graph. Absent: every provider counts as connected.
   * An unconnected built provider is idle capacity a previous layer goal built for this very route (D84), not a tap.
   */
  connected?: (this: void, role: string) => boolean
}

/** A built provider with no route out yet (see `FailedPlanFacts.connected`). */
function idle(f: FailedPlanFacts, role: string): boolean {
  return f.connected !== undefined && f.provider(role) === "built" && !f.connected(role)
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
    // Review fix (M7d.5 Layers14): a failed route from an idle provider does not say tapping it is wrong. Forking one
    // for the consumer just builds another idle provider the same way (96 unconnected coal mines for one smelter).
    for (const e of f.edges) {
      if (e.role === key && f.provider(e.from) !== undefined && !idle(f, e.from)) out.push({ kind: "providerNoTap", key: feedKey(e.from, e.to, e.toPort), replan: "without taps" })
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
      if (e.role === key && f.provider(e.from) !== undefined && !idle(f, e.from)) out.push({ kind: "noTap", key: e.from, replan: "without taps", say: `${e.from} is not tapped again (${v})` })
    }
  }
  return out
}

/**
 * Review fix (M7d.5 Layers14): after a goal spent its plans, the idle providers whose route to a **built** consumer
 * failed. Each was placed by an earlier layer goal before its consumer existed; moving it lets the design plan it again
 * together with that route (an edge to a built consumer belongs to the provider's goal), placed toward the consumer.
 * A consumer that is not built yet is the plan's own module: re-placing it is the plan's job (`tryReplace`).
 */
export function idleProviderMoves(f: FailedPlanFacts): string[] {
  const out: string[] = []
  for (const { key } of f.failures) {
    for (const e of f.edges) {
      if (e.role !== key || !idle(f, e.from) || f.provider(e.to) !== "built" || out.indexOf(e.from) >= 0) continue
      out.push(e.from)
    }
  }
  out.sort()
  return out
}

/** The strongest replan among the newly added constraints (the order the factory always reported them in). */
export function strongestReplan(added: Replan[]): Replan | undefined {
  for (const r of ["parallel providers", "without that merge", "a mine of its own", "without taps"] as Replan[]) if (added.indexOf(r) >= 0) return r
  return undefined
}

/**
 * M7c.8: an outpost goal (one with a fixed site) whose only failures are pole lines (`power:<owner>`) fails the same way
 * on every attempt: the region radius ladder doesn't bound the pole search, the ground between site and base does.
 */
export function retryCannotHelp(outpost: boolean, failures: { key: string }[]): boolean {
  if (!outpost || failures.length === 0) return false
  for (const f of failures) if (string.find(f.key, "^power:")[0] === undefined) return false
  return true
}

/** A failed route's seal evidence, as `PlanEvidence` carries it (only the fields the no-feed rule reads). */
export interface SealEvidence {
  kind: string
  subject: string
  sealed?: { side: "start" | "goal"; port: PortRef; edge?: boolean }
}

/**
 * B57/B61 (review fix): the consumer ports a failed plan may mark `noFeed`. The evidence was proved on the **failed
 * plan's** layout, whose own routes can be what walled the port in (B63); those routes are discarded with the plan. A
 * port is only marked when the persistent `layout` still seals that very port (`sealedInputs`, unfed inputs only), not
 * when any other input of the module is sealed. `idOfRole` maps a connection subject's consumer role to its module id.
 */
export function noFeedPorts(layout: LayoutState, terrain: TerrainView, evidence: SealEvidence[], idOfRole: (this: void, role: string) => string | undefined, escape: number): PortRef[] {
  if (escape <= 0) return []
  const candidates: PortRef[] = []
  for (const { port } of sealedGoalPorts(layout, evidence)) candidates.push(port)
  for (const ev of evidence) {
    if (ev.kind !== "route" || ev.sealed === undefined || ev.sealed.edge === true) continue
    const m = string.match(ev.subject, "=>([^%.]+)%.([^%s]+)")
    if (m[0] === undefined || m[1] === undefined) continue
    const id = idOfRole(m[0])
    if (id !== undefined) candidates.push({ module: id as PortRef["module"], port: m[1] })
  }
  const sealedOf: Record<string, string[]> = {}
  const out: PortRef[] = []
  const seen: Record<string, boolean> = {}
  for (const c of candidates) {
    const key = `${c.module}.${c.port}`
    if (seen[key] === true || findModule(layout, c.module) === undefined) continue
    seen[key] = true
    const fed: Record<string, boolean> = {}
    for (const rid of layout.routeOrder) {
      const r = layout.routes[rid]
      if (r !== undefined && r.to.module === c.module) fed[r.to.port] = true
    }
    sealedOf[c.module] ??= sealedInputs(layout, terrain, c.module, fed, escape)
    if (sealedOf[c.module].indexOf(c.port) >= 0) out.push(c)
  }
  return out
}
