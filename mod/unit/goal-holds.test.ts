import { goalStalled } from "../src/strategy/goal-holds"
import type { FactoryGoal } from "../src/strategy/factory"
import { eq, run, test } from "./harness"

function goal(status: FactoryGoal["status"], extra: Partial<FactoryGoal> = {}): FactoryGoal {
  return { id: "g1", kind: "production", status, nodes: [], edges: [], techs: [], attempts: 1, radius: 112, createdTick: 0, placed: 0, rounds: 0, ...extra } as unknown as FactoryGoal
}

test("M7c: a building goal with no placement for stall-ticks holds no lock (seed 11 blue line)", () => {
  const stall = 54000
  eq(goalStalled(1000, stall, goal("building", { plannedTick: 0, progressTick: 500 })), false, "recent progress")
  eq(goalStalled(60000, stall, goal("building", { plannedTick: 0, progressTick: 500 })), true, "no placement for longer than stall-ticks")
  eq(goalStalled(60000, stall, goal("building", { plannedTick: 10000 })), false, "an older save without progressTick counts from the plan")
  eq(goalStalled(90000, stall, goal("building", { plannedTick: 10000 })), true, "...and is stalled once stall-ticks passed since the plan")
  eq(goalStalled(1e9, stall, goal("planning")), false, "a planning goal is never stalled")
  eq(goalStalled(1e9, stall, undefined), false, "no goal")
})

run("goal-holds")
