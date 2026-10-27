/**
 * Plan failures that prove the faction's *known* ground is exhausted.
 *
 * The placer enumerates every candidate it knows (free ore patches in the plan region, shores, ore tiles) before it
 * gives up. When it gives up with one of these reasons, retrying with the same knowledge cannot succeed: only more
 * world (exploration) or a different location can. Treating them like ordinary design failures burns the goal's
 * attempt budget and, in a soak, the fail-fast budget, for a statement that was already true on the first attempt
 * (seed 1376111: `no feasible position (1 of 1 patches tried)` three times, one attempt short of the exploration
 * that would have looked for another patch).
 *
 * Kept pure and free of game types so the rule is testable as T1 and usable from any planner.
 */
export type ExhaustedKind = "patch" | "ore" | "site"

export interface Exhausted {
  /** What the search wanted: an ore name for `patch`/`ore`, a site name for `site`. */
  what: string
  kind: ExhaustedKind
}

/**
 * Classify a plan failure reason, or `undefined` when it is not a knowledge failure.
 *
 * Recognised (produced by `planner/placement.ts` and the site searches):
 *  - `module n58 (iron-ore*>iron-plate*>mall#2): no feasible position (1 of 1 patches tried)` → patch, `iron-ore`
 *  - `no free iron-ore patch in the region` → ore, `iron-ore`
 *  - `no steam site in the region` → site, `steam`
 */
export function exhausted(reason: string | undefined): Exhausted | undefined {
  if (reason === undefined) return undefined
  if (string.find(reason, "no feasible position", 1, true)[0] !== undefined) {
    // The role may carry a `*` marker (a shared producer: `coal*>...`), which is not part of the resource name.
    let [ore] = string.match(reason, "%(([%w%-]+)>[^)]*%): no feasible position")
    if (ore === undefined) [ore] = string.match(reason, "%(([%w%-]+)%*>[^)]*%): no feasible position")
    if (ore !== undefined) return { what: ore, kind: "patch" }
  }
  {
    const [ore] = string.match(reason, "no free (%S+) patch in the region")
    if (ore !== undefined) return { what: ore, kind: "ore" }
  }
  {
    const [site] = string.match(reason, "no (%S+) site in the region")
    if (site !== undefined) return { what: site, kind: "site" }
  }
  return undefined
}
