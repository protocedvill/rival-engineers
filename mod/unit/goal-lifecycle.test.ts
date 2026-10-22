import { canTransitionGoal, GoalStatus, nextGoalStatus } from "../src/strategy/goal-lifecycle"
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

run("goal-lifecycle")
