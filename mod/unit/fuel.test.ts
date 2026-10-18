import { newGraph } from "../src/planner/logical"
import type { LogicalEdge, LogicalGraph, LogicalNode } from "../src/planner/logical"
import { FactoryGoal, FactoryState } from "../src/strategy/factory"
import { producerGrowing } from "../src/strategy/fuel"
import { newLayout } from "../src/planner/layout"
import { eq, run, test } from "./harness"

// T1: producerGrowing (M6a.2, seed 222): a fuel producer that is being grown still feeds the steam block (its built
// drills run through the growth), so P36 (a)'s hand-fuelling must not fire — at build priority it starved the
// growth's own craft jobs, which were never claimed.

function node(id: string, lifecycle: LogicalNode["lifecycle"], kind: LogicalNode["kind"]): LogicalNode {
  return { id, role: id, kind, capacity: { inputs: [], outputs: [] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle, status: "ok", createdTick: 0 }
}

function edge(id: string, from: string, to: string): LogicalEdge {
  return { id, role: `${from}>>${to}.in-fuel`, kind: "belt", item: "coal", from, to, plannedRate: 1, physical: [] }
}

function graph(lifecycle: LogicalNode["lifecycle"]): { g: LogicalGraph; power: LogicalNode; producer: LogicalNode } {
  const g = newGraph()
  const power = node("n1", "built", "power")
  const producer = node("n2", lifecycle, "outpost")
  const e = edge("e1", "n2", "n1")
  g.nodes["n1"] = power
  g.nodes["n2"] = producer
  g.nodeOrder.push("n1", "n2")
  g.edges["e1"] = e
  g.edgeOrder.push("e1")
  return { g, power, producer }
}

function goal(status: FactoryGoal["status"], target: string | undefined): FactoryGoal {
  return {
    id: "g8",
    kind: "grow",
    status,
    nodes: [],
    edges: [],
    techs: [],
    attempts: 1,
    radius: 96,
    createdTick: 0,
    placed: 0,
    rounds: 0,
    growth: target !== undefined ? { node: target, units: 2 } : undefined,
  }
}

function state(goals: FactoryGoal[], lifecycle: LogicalNode["lifecycle"] = "building"): FactoryState {
  const { g } = graph(lifecycle)
  return { faction: "1", terrain: "1", center: { x: 0, y: 0 }, layout: newLayout(), graph: g, goals } as unknown as FactoryState
}

test("producerGrowing: a growing fuel producer counts as feeding (M6a.2, seed 222)", () => {
  for (const status of ["building", "planning"] as FactoryGoal["status"][]) {
    const f = state([goal(status, "n2")])
    eq(producerGrowing(f, f.graph.nodes["n1"]), true, `growth goal ${status}`)
  }
})

test("producerGrowing: a built or unrelated producer does not", () => {
  const f = state([goal("building", "n2")], "built")
  eq(producerGrowing(f, f.graph.nodes["n1"]), false, "a built producer is not a growth")
  const f2 = state([goal("building", "n9")])
  eq(producerGrowing(f2, f2.graph.nodes["n1"]), false, "a growth of another node is not")
  const f3 = state([goal("done", "n2")])
  eq(producerGrowing(f3, f3.graph.nodes["n1"]), false, "a finished growth goal is not")
})

run("fuel")
