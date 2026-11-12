/**
 * Plan failures that prove the faction's *known* ground is exhausted.
 *
 * The placer enumerates every candidate it knows (free ore patches in the plan region, shores, ore tiles) before it
 * gives up. When it gives up with one of these failures, retrying with the same knowledge cannot succeed: only more
 * world (exploration) or a different location can. Treating them like ordinary design failures burns the goal's
 * attempt budget and, in a soak, the fail-fast budget, for a statement that was already true on the first attempt
 * (seed 1376111: `no feasible position (1 of 1 patches tried)` three times, one attempt short of the exploration
 * that would have looked for another patch).
 *
 * Kept pure and free of game types so the rule is testable as T1 and usable from any planner.
 */
import type { PlanFailure } from "./plan-failure"

export type ExhaustedKind = "patch" | "ore" | "site"

export interface Exhausted {
  /** What the search wanted: an ore name for `patch`/`ore`, a site name for `site`. */
  what: string
  kind: ExhaustedKind
}

/**
 * The first knowledge failure among a plan's failures, or `undefined` when there is none (D69: from the failure kind,
 * not its text). A mine that tried every known patch (`no-position` with its ore) → patch; no free patch of the ore in
 * the region → ore; no site of a kind → site. A module with no ore of its own that found no position is an ordinary
 * failure (the region grows on the next attempt).
 */
export function exhausted(failures: PlanFailure[]): Exhausted | undefined {
  for (const f of failures) {
    if (f.what === undefined) continue
    if (f.kind === "no-position") return { what: f.what, kind: "patch" }
    if (f.kind === "no-patch") return { what: f.what, kind: "ore" }
    if (f.kind === "no-site") return { what: f.what, kind: "site" }
  }
  return undefined
}
