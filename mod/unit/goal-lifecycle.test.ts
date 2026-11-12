import { canTransitionGoal, everDone, GoalStatus, modulePlaced, nextGoalStatus, stallDecision } from "../src/strategy/goal-lifecycle"
import { eq, ok, run, test } from "./harness"

test("goal lifecycle admits only the coordinator's intended transitions", () => {
  const allowed: Record<GoalStatus, GoalStatus[]> = {
    planning: ["planning", "building", "failed"],
    building: ["building", "done", "failed"],
    done: [],
    failed: [],
  }
  const statuses: GoalStatus[] = ["planning", "building", "done", "failed"]
  for (const from of statuses) {
    for (const to of statuses) eq(canTransitionGoal(from, to), allowed[from].indexOf(to) >= 0, `${from} -> ${to}`)
  }
})

test("goal lifecycle fails closed at terminal states", () => {
  eq(nextGoalStatus("planning", "building", "g1"), "building")
  const [success, message] = pcall(() => nextGoalStatus("done", "planning", "g1"))
  ok(!success, "done goal was reopened")
  ok(tostring(message).indexOf("invalid goal transition g1: done -> planning") >= 0, tostring(message))
})

test("B108: the factory has power once any power goal is done, even when a later one failed", () => {
  // Two factions, seed 3333: the third power block found no coal (g28 failed, D62 exploring); the outpost radar waited
  // for "power" because the last power goal was not done, so nothing ever explored.
  const goals = [
    { kind: "power", status: "done" as GoalStatus },
    { kind: "production", status: "done" as GoalStatus },
    { kind: "power", status: "done" as GoalStatus },
    { kind: "power", status: "failed" as GoalStatus },
  ]
  ok(everDone(goals, "power"), "built power counts")
  ok(!everDone([{ kind: "power", status: "building" }], "power"), "a power goal still building is no power")
  ok(!everDone([{ kind: "production", status: "done" }], "power"), "no power goal")
})

test("B135: a module is placed when its own entities have no still-valid ghost", () => {
  const own = [{ x: 10.5, y: 20.5 }, { x: 12.5, y: 24.5 }]
  ok(modulePlaced(own, []), "no ghost: placed")
  ok(modulePlaced(own, [{ valid: true, position: { x: 11.5, y: 21.5 } }]), "a route ghost inside the rect does not block")
  ok(!modulePlaced(own, [{ valid: true, position: { x: 12.5, y: 24.5 } }]), "a ghost on an own entity blocks")
  ok(modulePlaced(own, [{ valid: false, position: { x: 12.5, y: 24.5 } }]), "an invalid ghost does not")
})

test("review fix: a stall waits once for the plan running at the deadline, never for its retries", () => {
  const key = (d: { fire: boolean; hold?: string[] }): string => `${d.fire}|${(d.hold ?? []).join(",")}`
  eq(key(stallDecision(false, ["p1"], undefined)), "false|", "not overdue: nothing")
  eq(key(stallDecision(true, [], undefined)), "true|", "overdue, nothing planning: stall")
  // g207: one long plan holds the stall until it ends (an adoption is progress and resets the clock and hold).
  eq(key(stallDecision(true, ["p1"], undefined)), "false|p1", "the running plan gets its grace")
  eq(key(stallDecision(true, ["p1"], ["p1"])), "false|p1", "still running: still held")
  // Layers14: p1 failed and the goal replans at once as p2. The retry gets no new grace.
  eq(key(stallDecision(true, ["p2"], ["p1"])), "true|", "the held plan ended without progress: stall, though p2 plans")
})

run("goal-lifecycle")
