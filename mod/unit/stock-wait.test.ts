import { handCraftSeconds, waitForStockRow } from "../src/strategy/stock-wait"
import { eq, near, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: M7d.6 (generated mall widened to every building, user in-session 2026-11-16). The crew waits for a generated
// stock row only while the row makes the shortfall sooner than a hand-craft and is not starved.

test("M7d.6: hand-craft seconds include hand-craftable intermediates, not supplied ones", () => {
  // boiler 0.5 s + its stone furnace 0.5 s + 4 pipes at 0.5 s; stone and plates are supplied.
  near(handCraftSeconds(F, "boiler", 1)!, 3, 1e-9, "one boiler")
  near(handCraftSeconds(F, "boiler", 2)!, 6, 1e-9, "two boilers")
  // A pump's engine unit is an advanced-crafting recipe: supplied, not crafted by hand. Pump 2 s + one pipe 0.5 s.
  near(handCraftSeconds(F, "pump", 1)!, 2.5, 1e-9, "a pump without its engine unit")
  eq(handCraftSeconds(F, "engine-unit", 1), undefined, "a machine-only item cannot be hand-crafted")
  eq(handCraftSeconds(F, "iron-plate", 1), undefined, "nor a smelted one")
})

test("M7d.6: the crew waits for a generated stock row only when it is faster and not starved", () => {
  // 10 boilers: 30 s by hand. A row making 0.5/s needs 20 s: wait. One making 10 a game-minute needs 60 s: craft.
  eq(waitForStockRow(30, 10, 0.5, "ok"), true, "the row is faster")
  eq(waitForStockRow(30, 10, 10 / 60, "ok"), false, "the row is slower: hand-craft")
  eq(waitForStockRow(30, 10, 0.5, "starved"), false, "a starved row makes nothing")
  eq(waitForStockRow(30, 10, 0.5, "unpowered"), false, "nor an unpowered one")
  eq(waitForStockRow(30, 10, 0, "ok"), false, "a row with no planned rate")
  eq(waitForStockRow(undefined, 10, 0.001, "starved"), true, "an item the crew cannot hand-craft is always waited for")
})

run("stock-wait")
