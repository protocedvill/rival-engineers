import { describeGrowth, depthOrder, planGrowth, requiredRates, SupplyEdge, SupplyNode } from "../src/strategy/growth-plan"
import { eq, ok, run, test } from "./harness"

// T1, B65 phases 2-3 (prototype): the shape of chain growth. Seed 3891760's copper chain is the fixture: a smelter
// planned/fed for 0.183/s that its consumers ask 0.827/s of, fed by one 0.183/s mine.

function chain(): { nodes: SupplyNode[]; edges: SupplyEdge[] } {
  const nodes: SupplyNode[] = [
    // A 2x1 copper mine: 0.5/s per row unit, room for one more row.
    { role: "copper-ore>smelt", item: "copper-ore", planned: 0.183, capacity: 1, unitRate: 0.5, maxUnits: 2, inputs: [] },
    // A 4-furnace column: 0.333/s per 4-furnace unit, room for three more.
    { role: "copper-plate>labs", item: "copper-plate", planned: 0.183, capacity: 1.25, unitRate: 0.3333, maxUnits: 3, inputs: [{ item: "copper-ore", perOutput: 1 }] },
    // Consumers exist only as demand; their own supply is not modelled here.
    { role: "red>labs", item: "copper-plate", planned: 0.827, capacity: 0.827, unitRate: 0, maxUnits: 0, inputs: [] },
  ]
  const edges: SupplyEdge[] = [
    { from: "copper-ore>smelt", to: "copper-plate>labs", item: "copper-ore", rate: 0.183 },
    { from: "copper-plate>labs", to: "red>labs", item: "copper-plate", rate: 0.827 },
  ]
  return { nodes, edges }
}

test("phase 2: demand propagates up the feed chain to a fixpoint", () => {
  const { nodes, edges } = chain()
  const req = requiredRates(nodes, edges)
  eq(req["copper-plate>labs"], 0.827, "the smelter must deliver what its consumer asks")
  ok(math.abs((req["copper-ore>smelt"] ?? 0) - 0.827) < 1e-6, `the mine must feed the smelter: ${req["copper-ore>smelt"]}`)
})

test("phase 2: deepest first, ore before plates before packs", () => {
  const { nodes, edges } = chain()
  const order = depthOrder(nodes, edges)
  eq(order[0], "copper-ore>smelt", "the mine resolves first")
  eq(order[1], "copper-plate>labs", "then the smelter")
  eq(order[2], "red>labs", "then the consumer")
})

test("phase 3: prefer growing the chain in place", () => {
  const { nodes, edges } = chain()
  const plan = planGrowth(nodes, edges, requiredRates(nodes, edges))
  eq(plan.stuck.length, 0, "the chain can grow")
  const grow = plan.obligations.filter((o) => o.kind === "grow")
  eq(grow.length, 2, `both links grow: ${describeGrowth(plan)}`)
  // 0.827 − 0.183 = 0.644 short: 2 smelter units (0.667), 2 mine rows (1.0).
  eq((grow[0] as { units: number }).units, 2, "mine rows")
  eq((grow[1] as { units: number }).units, 2, "smelter units")
})

test("phase 3: a chain that cannot grow forks a new module", () => {
  const { nodes, edges } = chain()
  const plan = planGrowth(nodes, edges, requiredRates(nodes, edges), { canGrow: (role: string) => role !== "copper-ore>smelt" })
  const mine = plan.obligations.filter((o) => o.role === "copper-ore>smelt")
  eq(mine.length, 1, `the mine gets one obligation: ${describeGrowth(plan)}`)
  eq(mine[0].kind, "new", "a new mine module")
  // The smelter is not grown while its feed is a new (unbuilt) chain: the fork owns the growth.
  const smelt = plan.obligations.filter((o) => o.role === "copper-plate>labs")
  eq(smelt.length, 1, "the smelter still acts on its own shortfall")
})

test("phase 3: no ground for a new module is a stuck link, not a silent shortfall", () => {
  const { nodes, edges } = chain()
  const plan = planGrowth(nodes, edges, requiredRates(nodes, edges), {
    canGrow: (role: string) => role !== "copper-ore>smelt",
    canPlace: (role: string) => role !== "copper-ore>smelt",
  })
  eq(plan.stuck.length, 1, `stuck: ${describeGrowth(plan)}`)
  eq(plan.stuck[0].item, "copper-ore", "the patch is exhausted (the B62 exhausted-failure input)")
})

run("growth-plan")
