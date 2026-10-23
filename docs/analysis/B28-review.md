# B28 review: route window, replacement, and feed reachability

Status: **part 1 fixed** (`fc99a90`); **part 2 fixed** (M6b.42/M6b.43). The behavioral regression is in
`mod/unit/planner.test.ts`: the sealed re-placement leaves the old footprint's route margin; with the padding removed
it lands at (8,29), inside that margin.

## What the current code does

- `planner/router.ts` bounds a search to the connection's endpoints ± `router.margin`; `windowMargin`
  (`plan.ts` route request) scales it.
- `planner/plan.ts` retries a failed connection in this order:
  1. normal search;
  2. rip search (other routes are victims, at a cost);
  3. if "no path", widen ×3, then ×9, and search again;
  4. if still failing, `tryReplace` removes the consumer (or the producer when the seal check blames the start) and
     re-places it once, at most twice per module.
- `tryReplace` records the module's old rectangle in `job.avoid[mid]`; the replacement search treats that rectangle as
  a hard exclusion. It does **not** score candidates by whether their feeds can reach their partners.
- A module with `canonical.site !== undefined` (a mine, a shore steam block) or `fixed` is never replaced.
- The seal check (`newSeal` in `router.ts`) proves a side is enclosed **inside the current window**. If the flood
  reaches the window edge (`sealed.edge`), widening is allowed; if it closes before the edge, widening is skipped
  because a wider window cannot open that pocket.

## Why part 2 still fails

The evidence (`out/soak/m6a2-accept2/evidence/diag-b28-copper-wall-map.lua`, B28 row) is a feed whose two endpoints
sit in pockets with no passage even in rip mode. The retry ladder then does the best it can:

1. The window widens to ×9; the pockets are wider than that or genuinely closed, so every window fails.
2. `tryReplace` moves the consumer. The old rectangle is excluded, but a candidate **next to** it is still in the same
   pocket, so the new site has the same unroutable feed.
3. If the producer is site-anchored (a mine) or `fixed`, `tryReplace` skips it. If the consumer is also anchored, no
   module can move and the same plan fails every region retry.

So the open issue is not the route search; it is that **placement commits before feed feasibility is known**, and the
replacement search does not search far enough to leave the pocket.

## Options, cheapest first

1. **Make replacement leave the pocket (low risk).** Inflate the avoided rectangle in `tryReplace` by a margin
   (module footprint + `router.margin`) and/or keep every failed rectangle for that module, not just the last one.
   This directly fixes the observed "re-places at essentially the same doomed spot" and is a small, testable change.
2. **Score candidates by feed reachability (medium).** For each candidate, before committing all modules, check the
   new module's belt ports with the existing `laneWayOut`/seal machinery: at least one input lane must reach the
   current layout/partner side. Reject candidates that are enclosed. This is the same class as B45/B57's port-escape
   checks, but aimed at the actual producer/consumer, not only the module's own lane.
3. **Give the last real attempt a wider window (medium).** Raise the final scale for real plans (×27, or one
   work-capped unbounded attempt) while keeping comparison branches capped. The B28 capture says ×9 was already too
   small for one feed, so this is a fallback, not a substitute for 1/2.
4. **Explicit displacement search (larger).** When a feed is unroutable, search a ring of sites for the consumer (or
   the producer, if it is not site-anchored) with the feed as part of the score, and only then fail the goal. This is
   the "need design" part of the row; it should wait for a fresh reproduction.

## Recommendation

Do **1** now with a synthetic regression: two endpoints in a pocket, a free passage just outside the old avoided
rectangle, assert that the replacement finds it (or that the goal fails cleanly within the attempt budget instead of
repeating the same site). Then use a replay from the B28 capture to decide whether **2** or **3** is needed. Do not
start **4** without a current-seed reproduction; the B28 evidence is old (`m6a2`) and the acceptance runs since then
have not shown the same feed class.

## Related but separate

B58 (`seed 1212121`) is not B28: the coal feed's splitter tap stood on an underground span (the root route passed
under the tap's input tile), so the tap had no surface belt to take from. The tap search ripped its own trunk while
choosing the branch; the fix protects `req.taps` from rip-up (M6b.43), not a route-window change.
