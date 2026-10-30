import { exploreNeed } from "../src/shared/explore-need"
import { eq, run, test } from "./harness"

test("D70: a search for an item the faction already makes is for extra capacity; otherwise it is required", () => {
  // Two factions, seed 3333: coal mines still worked while a third power block searched for more coal.
  const producers = [
    { item: "coal", built: true },
    { item: "iron-ore", built: false },
  ]
  eq(exploreNeed(producers, "coal"), "extra capacity")
  eq(exploreNeed(producers, "iron-ore"), "required", "a producer still being built makes nothing yet")
  eq(exploreNeed(producers, "copper-ore"), "required")
  eq(exploreNeed([], "coal"), "required")
})

run("explore-need")
