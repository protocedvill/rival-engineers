import { advanceAdoption, adoptionResume, adoptionShouldClear, beginAdoption, describeAdoption } from "../src/strategy/adoption-intent"
import { eq, ok, run, test } from "./harness"

test("an adoption record starts prepared and only advances forward", () => {
  const intent = beginAdoption("g1", "p1", 100)
  eq(intent.phase, "prepared")
  ok(advanceAdoption(intent, "state"), "prepared -> state")
  ok(advanceAdoption(intent, "world"), "state -> world")
  ok(advanceAdoption(intent, "build"), "world -> build")
  ok(!advanceAdoption(intent, "build"), "the same phase does not move")
  ok(!advanceAdoption(intent, "state"), "never backwards")
  eq(intent.phase, "build")
})

test("a persisted record is resumed only for its own goal and plan", () => {
  const intent = beginAdoption("g1", "p1", 100)
  eq(adoptionResume(undefined, "g1", "p1"), "fresh")
  eq(adoptionResume(intent, "g1", "p1"), "resume")
  eq(adoptionResume(intent, "g2", "p1"), "other")
  eq(adoptionResume(intent, "g1", "p2"), "other")
})

test("a record whose goal committed or whose plan vanished is stale", () => {
  const intent = beginAdoption("g1", "p1", 100)
  ok(!adoptionShouldClear(intent, "planning", true), "still adopting")
  ok(adoptionShouldClear(intent, "building", true), "committed")
  ok(adoptionShouldClear(intent, "failed", true), "goal failed")
  ok(adoptionShouldClear(intent, "planning", false), "plan entry gone")
  ok(adoptionShouldClear(intent, undefined, true), "goal gone")
})

test("the diagnostic line names the goal, plan and phase", () => {
  const intent = beginAdoption("g7", "p9", 1234)
  advanceAdoption(intent, "world")
  eq(describeAdoption(intent), "goal g7 plan p9 phase world since tick 1234")
})

run("adoption-intent")
