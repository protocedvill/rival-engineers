import { eq, near, run, test } from "./harness"
import { addEdge, LogicalEdge, newGraph, portShare } from "../src/planner/logical"
import { moduleId } from "../src/shared/ids"

// T1: B186. An edge probe measures the consumer port's whole flow of its item; each belt edge into that port gets its
// planned share (seed 3333: ten green lines into one lab port each read the port's flow, and the sharing draw summed them).

function belt(id: string, from: string, to: string, toPort: string, item: string, plannedRate: number): LogicalEdge {
  return { id, role: id, kind: "belt", item, from: moduleId(from), to: moduleId(to), toPort, plannedRate, physical: [] } as never
}

test("B186: edges into one port split its measured flow by plan; other ports and items keep theirs", () => {
  const g = newGraph()
  const a = addEdge(g, belt("a", "g1", "labs", "in-green", "logistic-science-pack", 0.28))
  const b = addEdge(g, belt("b", "g2", "labs", "in-green", "logistic-science-pack", 0.14))
  const red = addEdge(g, belt("r", "r1", "labs", "in-red", "automation-science-pack", 0.3))
  near(portShare(g, a, 0.42), 0.28, 1e-9, "two thirds of the port's flow")
  near(portShare(g, b, 0.42), 0.14, 1e-9, "a third")
  eq(portShare(g, red, 0.5), 0.5, "a port with one edge keeps the whole flow")
  const z = addEdge(g, belt("z", "g3", "labs", "in-green", "logistic-science-pack", 0))
  a.plannedRate = 0
  b.plannedRate = 0
  near(portShare(g, z, 0.3), 0.1, 1e-9, "nothing planned: equal shares")
})

run("port-share")
