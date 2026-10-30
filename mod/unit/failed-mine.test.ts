import { eq, run, test } from "./harness"
import { exhausted } from "../src/shared/exhausted"

// Kept from the old `failedMineOre` test: the same reasons, now classified by the shared knowledge-failure rule.
// The difference is deliberate: "no free <ore> patch in the region" used to need a second, separate regex in the
// factory; it is the same knowledge failure and is now recognised by the same classifier.

test("failed mine: the ore is read from a no-feasible-position module role", () => {
  eq(exhausted("module n31 (iron-ore>iron-plate*>logistic-science-pack>labs#2): no feasible position (2 of 2 patches tried)")?.what, "iron-ore")
  eq(exhausted("module n38 (coal*>iron-plate*>logistic-science-pack>labs#2): no feasible position (2 of 2 patches tried)")?.what, "coal")
  eq(exhausted("module n39 (power): no feasible position"), undefined)
})

test("failed mine: other failures and reasons do not look like an unplaceable mine", () => {
  // The region-wide variants are knowledge failures too, of the ore/site kinds.
  eq(exhausted("no free copper-ore patch in the region")?.kind, "ore")
  eq(exhausted("module n31 (iron-ore>iron-plate): no path"), undefined)
  eq(exhausted(undefined), undefined)
})

run("failed-mine")
