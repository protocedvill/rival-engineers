import { eq, ok, run, test } from "./harness"
import { BAD_SPOT_TICKS, badSpotRects, recordBadSpot } from "../src/jobs/bad-spots"
import { chooseStandingSpot } from "../src/jobs/board"

// T1: B111. A standing spot whose walk found no path is avoided for a while, so the batch planner picks the next spot
// within reach instead of the same unreachable one (fixed seed 222: hours of hand-fuelling walks into a corridor
// between steam-engine rows).

test("B111: an unreachable spot is avoided and the next spot within reach is picked", () => {
  const target = [{ x: 10.5, y: 10.5 }]
  const from = { x: 0, y: 10.5 }
  const first = chooseStandingSpot(target, [], from, 5)!
  ok(first !== undefined, "a spot")
  const spots: Record<string, number> = {}
  recordBadSpot(spots, first, 100)
  const second = chooseStandingSpot(target, badSpotRects(spots, 200), from, 5)!
  ok(second !== undefined, "another spot")
  ok(math.abs(second.x - first.x) + math.abs(second.y - first.y) >= 0.5, `a different spot (${first.x},${first.y} then ${second.x},${second.y})`)
})

test("B111: a bad spot expires", () => {
  const spots: Record<string, number> = {}
  recordBadSpot(spots, { x: 3.2, y: 4.7 }, 0)
  eq(badSpotRects(spots, BAD_SPOT_TICKS - 1).length, 1, "still avoided")
  eq(badSpotRects(spots, BAD_SPOT_TICKS).length, 0, "expired")
  eq(spots["3,4.5"], undefined, "and dropped")
})

run("bad-spots")
