// D69 (user decision in-session 2026-10-29, done in M7a): a planner failure says what failed as a type, not only as
// text. The planner keeps the text for logs and diagnostics (`PlanJob.failures`); the factory decides from the kind
// (`PlanJob.failed`) instead of searching the text for "no merge target" or "site in the region".
//
// Pure leaf: no Factorio globals, no imports (T1-usable from planner and strategy alike).

export type PlanFailureKind =
  /** A mine found no free patch of its ore in the plan region (`what`: the ore). */
  | "no-patch"
  /** A module found no feasible position; for a mine every known patch was tried (`what`: its ore, if it mines one). */
  | "no-position"
  /** A site-anchored module (a steam block's shore) found no site in the region (`what`: the site kind). */
  | "no-site"
  /** A route into a port another belt already feeds found no side-load or splitter spot on that belt. */
  | "no-merge-target"
  /** Anything else (blocked routes, pole paths, port mismatches): retried by the ordinary attempt ladder. */
  | "other"

export interface PlanFailure {
  kind: PlanFailureKind
  /** The text logged and shown in diagnostics. */
  reason: string
  /** The ore or site the search wanted (see the kinds). */
  what?: string
}

export function planFailure(kind: PlanFailureKind, reason: string, what?: string): PlanFailure {
  return { kind, reason, what }
}

/** Whether `x` is a failure rather than the result it stands in for (results never carry `kind` + `reason`). */
export function isPlanFailure(x: unknown): x is PlanFailure {
  const f = x as PlanFailure
  return typeof x === "object" && typeof f.kind === "string" && typeof f.reason === "string"
}
