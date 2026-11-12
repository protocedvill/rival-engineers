import { eq, run, test } from "./harness"
import { exhausted } from "../src/shared/exhausted"
import { planFailure } from "../src/shared/plan-failure"

// The knowledge-failure rule (seed 1376111), decided from the failure kind since D69 rather than its text.

test("failed mine: a mine that tried every known patch is a patch failure of its ore", () => {
  eq(exhausted([planFailure("no-position", "no feasible position (2 of 2 patches tried)", "iron-ore")])?.what, "iron-ore")
  eq(exhausted([planFailure("no-position", "no feasible position (2 of 2 patches tried)", "coal")])?.kind, "patch")
  // A module with no ore of its own (a steam block, a smelter) is an ordinary failure. Parsed from the text, a smelter
  // role `(iron-plate>labs): no feasible position` once read as a patch failure of "iron-plate".
  eq(exhausted([planFailure("no-position", "no feasible position")]), undefined)
})

test("failed mine: region-wide failures are ore and site failures; others are not knowledge failures", () => {
  eq(exhausted([planFailure("no-patch", "no free copper-ore patch in the region", "copper-ore")])?.kind, "ore")
  eq(exhausted([planFailure("no-site", "no steam site in the region", "steam")])?.what, "steam")
  eq(exhausted([planFailure("other", "no path")]), undefined)
  eq(exhausted([planFailure("other", "no path"), planFailure("no-patch", "no free coal patch in the region", "coal")])?.what, "coal", "any failure of the plan")
  eq(exhausted([]), undefined)
})

run("failed-mine")
