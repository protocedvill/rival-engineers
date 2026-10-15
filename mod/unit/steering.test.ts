import { Dir8, directionTowards, distance, newProgressTracker, nextWaypointIndex, pathLength, updateProgress } from "../src/character/steering"
import { eq, near, ok, run, test } from "./harness"

test("directionTowards: the 8 compass directions (y grows south)", () => {
  eq(directionTowards(0, -1), Dir8.north, "north")
  eq(directionTowards(1, -1), Dir8.northeast, "northeast")
  eq(directionTowards(1, 0), Dir8.east, "east")
  eq(directionTowards(1, 1), Dir8.southeast, "southeast")
  eq(directionTowards(0, 1), Dir8.south, "south")
  eq(directionTowards(-1, 1), Dir8.southwest, "southwest")
  eq(directionTowards(-1, 0), Dir8.west, "west")
  eq(directionTowards(-1, -1), Dir8.northwest, "northwest")
})

test("directionTowards: sector boundaries at 22.5 degrees", () => {
  // tan(22.5°) ≈ 0.4142: just under stays cardinal, just over turns diagonal.
  eq(directionTowards(1, 0.41), Dir8.east, "shallow east")
  eq(directionTowards(1, 0.42), Dir8.southeast, "steeper east")
  eq(directionTowards(0.41, -1), Dir8.north, "shallow north")
  eq(directionTowards(0.42, -1), Dir8.northeast, "steeper north")
  eq(directionTowards(-100, 3), Dir8.west, "long west")
})

test("directionTowards: zero vector has no direction", () => {
  eq(directionTowards(0, 0), undefined, "zero")
})

test("nextWaypointIndex skips reached waypoints and stops at the first far one", () => {
  const wps = [
    { x: 0, y: 0 },
    { x: 0.2, y: 0 },
    { x: 5, y: 0 },
  ]
  eq(nextWaypointIndex({ x: 0, y: 0 }, wps, 0, 0.3, 0.3), 2, "skips the two close ones")
  eq(nextWaypointIndex({ x: 5, y: 0.1 }, wps, 2, 0.3, 0.3), 3, "finished")
  eq(nextWaypointIndex({ x: 3, y: 0 }, wps, 2, 0.3, 0.3), 2, "still heading to the last")
})

test("nextWaypointIndex uses the final tolerance for the last waypoint", () => {
  const wps = [{ x: 0, y: 0 }, { x: 4, y: 0 }]
  eq(nextWaypointIndex({ x: 3.8, y: 0 }, wps, 1, 0.3, 0.1), 1, "0.2 away > final tolerance 0.1")
  eq(nextWaypointIndex({ x: 3.95, y: 0 }, wps, 1, 0.3, 0.1), 2, "within final tolerance")
})

test("steering simulation: an 8-way walker converges on every waypoint", () => {
  // Simulate the controller's loop at running speed 0.15 tiles/tick along an awkward path.
  const wps = [
    { x: 3.3, y: 1.1 },
    { x: 3.3, y: 7.9 },
    { x: -4.6, y: 12.2 },
    { x: 10, y: 10 },
  ]
  const speed = 0.15
  const diag = speed / math.sqrt(2)
  const step: Record<number, [number, number]> = {
    [Dir8.north]: [0, -speed],
    [Dir8.northeast]: [diag, -diag],
    [Dir8.east]: [speed, 0],
    [Dir8.southeast]: [diag, diag],
    [Dir8.south]: [0, speed],
    [Dir8.southwest]: [-diag, diag],
    [Dir8.west]: [-speed, 0],
    [Dir8.northwest]: [-diag, -diag],
  }
  let pos = { x: 0, y: 0 }
  let index = 0
  let ticks = 0
  while (ticks < 1000) {
    index = nextWaypointIndex(pos, wps, index, 0.3, 0.25)
    if (index >= wps.length) break
    const wp = wps[index]
    const [dx, dy] = step[directionTowards(wp.x - pos.x, wp.y - pos.y)!]
    pos = { x: pos.x + dx, y: pos.y + dy }
    ticks++
  }
  eq(index, wps.length, "reached the end")
  ok(distance(pos, wps[3]) <= 0.25, "ended on the goal")
  const ideal = pathLength({ x: 0, y: 0 }, wps) / speed
  ok(ticks < ideal * 1.15, `8-way steering overhead under 15% (${ticks} vs ${ideal})`)
})

test("pathLength sums the segments from the start", () => {
  near(pathLength({ x: 0, y: 0 }, [{ x: 3, y: 4 }, { x: 3, y: 10 }]), 11)
  near(pathLength({ x: 1, y: 1 }, []), 0)
})

test("updateProgress: getting closer is progress", () => {
  const t = newProgressTracker(0)
  ok(!updateProgress(t, 0, 10, 0, 60), "first sample")
  for (let tick = 1; tick <= 200; tick++) ok(!updateProgress(t, 0, 10 - tick * 0.04, tick, 60), `tick ${tick}`)
})

test("updateProgress: no progress for more than stuckTicks is stuck", () => {
  const t = newProgressTracker(0)
  updateProgress(t, 0, 10, 0, 60)
  ok(!updateProgress(t, 0, 10, 60, 60), "exactly stuckTicks is not yet stuck")
  ok(updateProgress(t, 0, 10, 61, 60), "one more tick is")
})

test("updateProgress: sliding sideways without closing in is stuck", () => {
  const t = newProgressTracker(0)
  updateProgress(t, 0, 10, 0, 60)
  // Distance wobbles by less than minImprovement (0.1).
  let stuck = false
  for (let tick = 1; tick <= 61; tick++) stuck = updateProgress(t, 0, 10 - (tick % 2) * 0.05, tick, 60)
  ok(stuck, "stuck while wobbling")
})

test("updateProgress: reaching a new waypoint resets the clock", () => {
  const t = newProgressTracker(0)
  updateProgress(t, 0, 10, 0, 60)
  ok(!updateProgress(t, 1, 20, 59, 60), "switch waypoint")
  ok(!updateProgress(t, 1, 20, 119, 60), "60 ticks after the switch")
  ok(updateProgress(t, 1, 20, 120, 60), "61 ticks after the switch")
})

run("steering")
