import { eq, run, test } from "./harness"
import { failedMineOre } from "../src/strategy/explore"

test("failed mine: the ore is read from a no-feasible-position module role", () => {
  eq(failedMineOre("module n31 (iron-ore>iron-plate*>logistic-science-pack>labs#2): no feasible position (2 of 2 patches tried)"), "iron-ore")
  eq(failedMineOre("module n38 (coal*>iron-plate*>logistic-science-pack>labs#2): no feasible position (2 of 2 patches tried)"), "coal")
  eq(failedMineOre("module n39 (power): no feasible position"), undefined)
})

test("failed mine: other failures and reasons do not look like an unplaceable mine", () => {
  eq(failedMineOre("no free copper-ore patch in the region"), undefined)
  eq(failedMineOre("module n31 (iron-ore>iron-plate): no path"), undefined)
  eq(failedMineOre(undefined), undefined)
})

run("failed-mine")
