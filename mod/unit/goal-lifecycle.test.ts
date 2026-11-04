import { canTransitionGoal, everDone, GoalStatus, modulePlaced, nextGoalStatus } from "../src/strategy/goal-lifecycle"
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

test("B135: a module is placed when no still-valid ghost lies in its rect", () => {
  const rect = { x: 10, y: 20, w: 8, h: 6 }
  ok(modulePlaced(rect, []), "no ghost: placed")
  ok(modulePlaced(rect, [{ valid: true, position: { x: 30, y: 30 } }]), "a ghost elsewhere does not block")
  ok(!modulePlaced(rect, [{ valid: true, position: { x: 12, y: 24 } }]), "a ghost inside blocks")
  ok(modulePlaced(rect, [{ valid: false, position: { x: 12, y: 24 } }]), "an invalid ghost does not")
  ok(!modulePlaced(rect, [{ valid: true, position: { x: 10, y: 20 } }]), "the left/top edge counts")
  ok(modulePlaced(rect, [{ valid: true, position: { x: 18, y: 26 } }]), "the right/bottom edge is outside")
})

run("goal-lifecycle")
