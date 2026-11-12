import { feedsBuildingAll, goalStalled, placingOwners, stockWaits } from "../src/strategy/goal-holds"
import { newGraph, addNode, addEdge } from "../src/planner/logical"
import type { GoalSpec } from "../src/strategy/design"
import type { FactoryGoal, FactoryState } from "../src/strategy/factory"
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

test("B180 (m7-fresh6 seed 11, g111/g112): the parts building goals still place, so a remedy waits for them", () => {
  const spec = (owner: string) => ({ name: "transport-belt", x: 0.5, y: 0.5, dir: 0, owner })
  const repair = goal("building", { id: "g111", kind: "repair", plannedTick: 1000, progressTick: 2000, growBuild: { phase: "place", clearJobs: [], add: [spec("route:a"), spec("n63")], ghosts: [], placeJobs: [] } } as never)
  const plan = goal("building", { id: "g120", plannedTick: 1000, progressTick: 2000, plan: "1:g120:1" } as never)
  const stalled = goal("building", { id: "g99", kind: "repair", plannedTick: 0, progressTick: 0, growBuild: { phase: "place", clearJobs: [], add: [spec("route:c")], ghosts: [], placeJobs: [] } } as never)
  const done = goal("done", { id: "g98", kind: "repair", growBuild: { phase: "done", clearJobs: [], add: [spec("route:d")], ghosts: [], placeJobs: [] } } as never)
  const f = { goals: [repair, plan, stalled, done] } as unknown as FactoryState
  const owners = placingOwners(f, 3000, 2500, (id) => (id === "1:g120:1" ? { modules: ["n200"], routes: ["route:b"], poles: [] } : undefined) as never)
  eq(owners["route:a"], "g111", "a repair's route")
  eq(owners["n63"], "g111", "a repair's module poles")
  eq(owners["route:b"], "g120", "a plan's route")
  eq(owners["n200"], "g120", "a plan's module")
  eq(owners["route:c"], undefined, "a stalled goal holds nothing")
  eq(owners["route:d"], undefined, "a finished goal holds nothing")
})

test("B185 (user, 2026-11-11): a solar power goal waits for the stock rows making its buildings", () => {
  const field = { role: "power#2", generator: "solar-field", def: { entities: [{ name: "solar-panel" }, { name: "accumulator" }, { name: "medium-electric-pole" }] } }
  const power = { kind: "power", nodes: [field], edges: [], techs: [] } as unknown as GoalSpec
  const rows = { kind: "production", nodes: [{ role: "stock:solar-panel" }, { role: "stock:accumulator" }], edges: [], techs: [] } as unknown as GoalSpec
  const id = (e: string): string => e
  const empty = { graph: newGraph(), goals: [] } as unknown as FactoryState
  eq(stockWaits(empty, [power, rows], power, id).join(","), "stock:solar-panel,stock:accumulator", "rows still to build (no pole stock planned: no wait)")
  eq(stockWaits(empty, [power], power, id).length, 0, "no stock planned: nothing to wait for")
  const g = newGraph()
  addNode(g, { id: "n1", role: "stock:solar-panel", kind: "module", lifecycle: "built" } as never)
  addNode(g, { id: "n2", role: "stock:accumulator", kind: "module", lifecycle: "building" } as never)
  const f = { graph: g, goals: [] } as unknown as FactoryState
  eq(stockWaits(f, [power], power, id).join(","), "stock:accumulator", "only the row still building")
})

test("B196: a solar power goal waits for the research of a building whose recipe is still locked", () => {
  const field = { role: "power#2", generator: "solar-field", def: { entities: [{ name: "solar-panel" }, { name: "accumulator" }, { name: "medium-electric-pole" }] } }
  const power = { kind: "power", nodes: [field], edges: [], techs: [] } as unknown as GoalSpec
  const id = (e: string): string => e
  const empty = { graph: newGraph(), goals: [] } as unknown as FactoryState
  const locked = (item: string): boolean => item === "solar-panel" || item === "accumulator"
  eq(stockWaits(empty, [power], power, id, locked).join(","), "research:solar-panel,research:accumulator", "no stock row yet: the research")
  eq(stockWaits(empty, [power], power, id, () => false).length, 0, "all enabled, no rows planned: nothing to wait for")
})

test("B198: with a production goal stalled, a chain restoring a built module's unfed input may start, layer by layer", () => {
  const g = newGraph()
  addNode(g, { id: "n1", role: "steel", kind: "module", lifecycle: "built" } as never)
  addNode(g, { id: "n2", role: "engines", kind: "module", lifecycle: "built" } as never)
  const f = { graph: g, goals: [] } as unknown as FactoryState
  const mine = { kind: "production", nodes: [{ role: "ore" }], edges: [], techs: [] } as unknown as GoalSpec
  const smelter = { kind: "production", nodes: [{ role: "plates" }], edges: [{ from: "ore", to: "plates", toPort: "in" }, { from: "plates", to: "steel", toPort: "in-ore" }], techs: [] } as unknown as GoalSpec
  const other = { kind: "production", nodes: [{ role: "gears" }], edges: [{ from: "gears", to: "engines", toPort: "in-gear" }], techs: [] } as unknown as GoalSpec
  addEdge(g, { id: "e1", role: "x=>engines.in-gear", kind: "belt", item: "gear", to: "n2", toPort: "in-gear" } as never)
  eq(feedsBuildingAll(f, [mine, smelter, other], true).join(","), "true,true,false", "the smelter restores steel's input; the mine feeds the smelter; engines are fed")
  eq(feedsBuildingAll(f, [mine, smelter, other], false).join(","), "false,false,false", "no stalled production: built modules wait their turn")
})

run("goal-holds")
