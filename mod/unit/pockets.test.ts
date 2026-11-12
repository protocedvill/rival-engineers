import { eq, run, test } from "./harness"
import type { Rect } from "../src/jobs/board"
import { inPocket } from "../src/jobs/pockets"

// T1: B176. The steam-block corridor of the engine-capabilities finding, in local coordinates (x 0 = world 447, y 0 =
// world 54 in m7-fresh4 seed 11): engine columns at x -2.5 and 1.5 (3x5, boxes 2.5 x 4.7), small poles at (-0.5, 0.5)
// and (-0.5, 5.5). The pathfinder reached the corridor up to the first pole and nothing past it.

function box(x: number, y: number, w: number, h: number): Rect {
  return { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 }
}

function corridor(): Rect[] {
  const out: Rect[] = []
  for (const y of [0.5, 5.5]) {
    for (const x of [-2.5, 1.5]) out.push(box(x, y, 2.5, 4.6953125))
    out.push(box(-0.5, y, 0.296875, 0.296875))
  }
  return out
}

test("B176: a spot past a pole in a steam block's corridor is a pocket; the corridor before it is not", () => {
  const b = corridor()
  // Found by the pathfinder: open ground, the corridor mouth and the corridor up to the first pole.
  eq(inPocket({ x: 6, y: -6 }, b), false, "open ground")
  eq(inPocket({ x: -0.5, y: -4 }, b), false, "corridor mouth")
  eq(inPocket({ x: -0.5, y: -2.5 }, b), false, "corridor before the first pole")
  // Not found: the failing spot beside the pole, the corridor between the poles, the tile centre beside the pole.
  eq(inPocket({ x: 0, y: 1 }, b), true, "the spot beside the pole (447.0, 55.0)")
  eq(inPocket({ x: -0.5, y: 3 }, b), true, "the corridor between the poles")
  eq(inPocket({ x: 0, y: 3 }, b), true, "the tile centre beside the pole")
})

test("B176: an open corridor without poles is no pocket", () => {
  const b = corridor().filter((r) => r.x2 - r.x1 > 1)
  eq(inPocket({ x: -0.5, y: 3 }, b), false, "the corridor runs through")
})

test("B176: a closed ring is a pocket, a big open area inside it is not", () => {
  const ring = (half: number): Rect[] => [
    { x1: -half - 1, y1: -half - 1, x2: half + 1, y2: -half },
    { x1: -half - 1, y1: half, x2: half + 1, y2: half + 1 },
    { x1: -half - 1, y1: -half, x2: -half, y2: half },
    { x1: half, y1: -half, x2: half + 1, y2: half },
  ]
  eq(inPocket({ x: 0, y: 0 }, ring(3)), true, "a 6-tile room is a pocket")
  eq(inPocket({ x: 0, y: 0 }, ring(10)), false, "a 20-tile room counts as open ground")
})

test("B176: a spot close to a machine on open ground is no pocket (the pathfinder reached it)", () => {
  // engine-capabilities B176: a steam engine at (-2.5, 0.5) (box x <= -1.25), an assembler at (5.5, 0.5) (x >= 4.3).
  const b = [box(-2.5, 0.5, 2.5, 4.6953125), box(5.5, 0.5, 2.4, 2.4)]
  eq(inPocket({ x: -1.0, y: 0.5 }, b), false, "0.25 from the engine")
  eq(inPocket({ x: 4.0, y: 0.5 }, b), false, "0.3 from the assembler")
})

run("pockets")
