import { eq, near, ok, run, test } from "./harness"
import { buildSeconds, coalDistance, CREW_ENTITY_SECONDS, CREW_TILES_PER_SECOND, noCoal, rawCost } from "../src/strategy/power-choice"
import type { Patch } from "../src/world/resources"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: B185 (user, 2026-11-11): the build-time estimate that picks solar fields or a steam block with a coal mine.

test("B185: raw cost follows the recipe chain; ores count 1, fluids 0", () => {
  eq(rawCost(F, "iron-ore"), 1, "an ore")
  eq(rawCost(F, "iron-plate"), 1, "a plate")
  near(rawCost(F, "electronic-circuit"), 2.5, 1e-9, "1 iron + 3 cables (1.5 copper)")
  // 5 steel (25 iron) + 15 circuits (37.5) + 15 copper.
  near(rawCost(F, "solar-panel"), 77.5, 1e-9, "a solar panel")
})

test("B185: build seconds add crew placing, walking and materials at the plate rate", () => {
  const est = { entities: [{ name: "transport-belt", count: 100 }], walkTiles: 200 }
  const belt = rawCost(F, "transport-belt")
  near(buildSeconds(F, est, 10), 100 * CREW_ENTITY_SECONDS + 200 / CREW_TILES_PER_SECOND + (100 * belt) / 10, 1e-6, "the three parts")
  ok(buildSeconds(F, est, 0) === math.huge, "no plates: never")
})

function patch(id: number, x1: number, y1: number, size: number): Patch {
  return { id, name: "coal", product: "coal", tiles: size * size, amount: 1e5, center: { x: x1 + size / 2, y: y1 + size / 2 }, x1, y1, x2: x1 + size - 1, y2: y1 + size - 1 }
}

test("B185: the coal distance skips patches its mines cover", () => {
  const near = patch(1, 10, 0, 10)
  const far = patch(2, 300, 0, 10)
  const from = { x: 0, y: 5 }
  eq(coalDistance([], [near, far], from, "coal"), 10, "the nearest patch's edge")
  const mine = { canonical: { anchor: { resource: "coal" } }, rect: { x: 10, y: 0, w: 10, h: 10 } }
  eq(coalDistance([mine], [near, far], from, "coal"), 300, "a mined-out patch is skipped")
  const half = { canonical: { anchor: { resource: "coal" } }, rect: { x: 10, y: 0, w: 5, h: 10 } }
  eq(coalDistance([half], [near, far], from, "coal"), 10, "half a patch is still free")
  eq(coalDistance([mine], [near], from, "coal"), math.huge, "none free")
  eq(coalDistance([], [near], from, "iron-ore"), math.huge, "another fuel")
})

test("B185: no coal holds until the exploration finds another patch", () => {
  const c = { solarPower: { coal: 1 } }
  eq(noCoal(undefined, []), false, "no failure")
  eq(noCoal(c, [patch(1, 0, 0, 4)]), true, "the patch known at the failure")
  eq(noCoal(c, [patch(1, 0, 0, 4), patch(2, 50, 0, 4)]), false, "a new patch: compare again")
  eq(noCoal({ solarPower: { coal: true } }, [patch(1, 0, 0, 4), patch(2, 50, 0, 4)]), true, "a flag from before")
})

run("power-choice")
