import { ARM_FIRST, ARM_SPACING, ARM_STRIP_HALF, armStrip, armTarget, chunkKnown, chunksAround, homeRect, noPatchResource, rectUnion } from "../src/strategy/arms"
import { eq, ok, run, test } from "./harness"

/** Compares plain {x, y, w?, h?} records field by field (eq compares tables by identity). */
function same(actual: { x: number; y: number; w?: number; h?: number }, expected: { x: number; y: number; w?: number; h?: number }, what = "value"): void {
  eq(`${actual.x},${actual.y},${actual.w ?? "-"},${actual.h ?? "-"}`, `${expected.x},${expected.y},${expected.w ?? "-"},${expected.h ?? "-"}`, what)
}

const HUB = { x: -16.5, y: 452.5 }

test("D62: arm targets go N, E, S, W from the hub, the first at ARM_FIRST and then ARM_SPACING apart", () => {
  same(armTarget(HUB, 0, 0), { x: -17, y: 452 - ARM_FIRST })
  same(armTarget(HUB, 1, 0), { x: -17 + ARM_FIRST, y: 452 })
  same(armTarget(HUB, 2, 1), { x: -17, y: 452 + ARM_FIRST + ARM_SPACING })
  same(armTarget(HUB, 3, 2), { x: -17 - ARM_FIRST - 2 * ARM_SPACING, y: 452 })
})

test("D62: an arm's strip runs from the home edge to just past its target, ARM_STRIP_HALF either side", () => {
  const home = 384
  for (let arm = 0; arm < 4; arm++) {
    const t = armTarget(HUB, arm, 1)
    const s = armStrip(HUB, arm, home, t)
    const inside = (x: number, y: number): boolean => x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h
    ok(inside(t.x, t.y), `arm ${arm}: target inside`)
    // The target's neighbourhood (where the radar may be nudged) and the home edge along the arm are covered.
    const dx = t.x === -17 ? 0 : t.x > -17 ? 1 : -1
    const dy = t.y === 452 ? 0 : t.y > 452 ? 1 : -1
    ok(inside(t.x + dx * ARM_STRIP_HALF, t.y + dy * ARM_STRIP_HALF), `arm ${arm}: past the target`)
    ok(inside(-17 + dx * (home - ARM_STRIP_HALF), 452 + dy * (home - ARM_STRIP_HALF)), `arm ${arm}: from the home edge`)
    ok(!inside(-17 + dx * (home - ARM_STRIP_HALF - 1), 452 + dy * (home - ARM_STRIP_HALF - 1)), `arm ${arm}: not into the home zone`)
    ok(inside(t.x + (dy !== 0 ? ARM_STRIP_HALF : 0), t.y + (dx !== 0 ? ARM_STRIP_HALF : 0)), `arm ${arm}: full width`)
  }
})

test("D62: chunks are known in the home zone and explored strips; elsewhere only when charted", () => {
  const known = { home: homeRect({ x: 0, y: 0 }, 384), explored: [{ x: -32, y: -700, w: 65, h: 400 }] }
  const charted: Record<string, boolean> = { "20,20": true }
  const isCharted = (cx: number, cy: number): boolean => charted[`${cx},${cy}`] === true
  ok(chunkKnown(0, 0, known, isCharted), "hub chunk")
  ok(chunkKnown(11, -12, known, isCharted), "home corner chunk")
  ok(!chunkKnown(12, 0, known, isCharted), "just past the home zone")
  ok(chunkKnown(0, -20, known, isCharted), "in the explored strip")
  ok(!chunkKnown(5, -20, known, isCharted), "beside the strip")
  ok(chunkKnown(20, 20, known, isCharted), "charted")
})

test("D62: a radar's nearby square and the no-patch failure text", () => {
  eq(chunksAround({ x: 40, y: -1 }, 1).length, 9)
  same(chunksAround({ x: 40, y: -1 }, 3)[0], { x: -2, y: -4 })
  eq(noPatchResource("module n45 (copper-ore>copper-plate*>labs#3): no free copper-ore patch in the region"), "copper-ore")
  eq(noPatchResource("module n36: no feasible position (1 of 1 patches tried)"), undefined)
  eq(noPatchResource(undefined), undefined)
  same(rectUnion({ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 2, h: 2 }), { x: -5, y: 0, w: 15, h: 22 })
})

run("arms")
