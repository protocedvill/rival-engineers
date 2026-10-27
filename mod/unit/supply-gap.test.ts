import { addEdge, addNode, newGraph, supplyGaps } from "../src/planner/logical"
import { moduleId } from "../src/shared/ids"
import { eq, run, test } from "./harness"

// T1, B65 (supply): a provider whose consumers ask for more than the plan sized it to deliver is over-subscribed.
// Seed 3891760: a copper smelter sized (and fed) for 0.183/s carried 0.827/s of edges for 270 game-min, and the
// science it fed ran at a quarter of its rate. `planned` is the rate the input chain was built for; the edges are
// what later consumers attached.

function node(g: ReturnType<typeof newGraph>, id: string, role: string, item: string, planned: number) {
  addNode(g, {
    id: moduleId(id),
    role,
    kind: "module",
    item,
    capacity: { inputs: [], outputs: [{ item, perSecond: planned * 4 }] },
    planned: { inputs: [], outputs: [{ item, perSecond: planned }] },
    powerW: 0,
    lifecycle: "built",
    status: "ok",
    createdTick: 0,
  })
}

function edge(g: ReturnType<typeof newGraph>, id: string, from: string, to: string, item: string, rate: number) {
  addEdge(g, {
    id,
    role: id,
    kind: "belt",
    item,
    from: moduleId(from),
    fromPort: "out",
    to: moduleId(to),
    toPort: "in",
    plannedRate: rate,
    headroomRate: rate,
    physical: [],
  })
}

test("B65: a provider asked for more than its plan delivers is a supply gap", () => {
  const g = newGraph()
  node(g, "n17", "copper-plate>labs", "copper-plate", 0.183)
  node(g, "n14", "automation-science-pack>labs", "automation-science-pack", 0.183)
  edge(g, "e1", "n17", "n14", "copper-plate", 0.183)
  edge(g, "e2", "n17", "n24", "copper-plate", 0.412)
  edge(g, "e3", "n17", "mall", "copper-plate", 0.232)
  const gaps = supplyGaps(g)
  eq(gaps.length, 1, "one over-subscribed provider")
  eq(gaps[0].role, "copper-plate>labs", "the copper smelter")
  eq(gaps[0].planned, 0.183, "sized for 0.183/s")
  ok_committed(gaps[0].committed, 0.827)
})

test("B65: a provider within its plan, and another item, are not gaps", () => {
  const g = newGraph()
  node(g, "n49", "iron-plate>labs", "iron-plate", 1.375)
  node(g, "n47", "logistic-science-pack>labs", "logistic-science-pack", 0.183)
  edge(g, "e1", "n49", "n47", "iron-plate", 1.008)
  edge(g, "e2", "n49", "n48", "iron-plate", 0.367)
  eq(supplyGaps(g).length, 0, "1.375/s planned, 1.375/s asked")
})

function ok_committed(got: number, want: number) {
  // Float dust from the rate sums: compare with a tolerance.
  eq(math.abs(got - want) < 1e-6, true, `committed ${got}, want ${want}`)
}

run("supply-gap")
