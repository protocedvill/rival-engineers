import { addEdge, addNode, LogicalGraph, LogicalNode, newGraph } from "../src/planner/logical"
import { ReconcileParams } from "../src/strategy/reconcile"
import { graphLayout } from "../src/review/graph-layout"
import { eq, near, ok, run, test } from "./harness"

function assert(cond: boolean, what: string): void {
  if (!cond) error(`assert: ${what}`, 2)
}

// T1: the factory-graph window's layout (B16): nodes by dataflow depth (sources left, consumers right, belt and
// crew edges only), cycle leftovers one level past the rest, and the edge rows with the reconciler's probe verdicts.

const TICK = 10000

const P: ReconcileParams = {
  warmupTicks: 600,
  confirm: 3,
  shortfall: 0.25,
  badShare: 0.5,
  minActive: 0.1,
  busyShare: 0.85,
  edgeFull: 0.9,
  portFull: 0.5,
  arrivedShare: 0.75,
  probeMaxAge: 3600,
  maxRemedies: 2,
  cooldownTicks: 1000,
}

function node(g: LogicalGraph, id: string, kind: LogicalNode["kind"], item: string, planned: number, extra: Partial<LogicalNode> = {}): LogicalNode {
  return addNode(g, {
    id,
    role: id,
    kind,
    item,
    capacity: { inputs: [], outputs: [{ item, perSecond: planned * 1.2 }] },
    planned: { inputs: [], outputs: [{ item, perSecond: planned }] },
    powerW: 0,
    lifecycle: "built",
    status: "ok",
    createdTick: 0,
    builtTick: 0,
    ...extra,
  })
}

function belt(g: LogicalGraph, id: string, from: string | undefined, to: string, item: string, planned: number, measured?: { rate: number; from: number; to: number; cap?: number }): void {
  addEdge(g, {
    id,
    role: id,
    kind: "belt",
    item,
    from,
    to,
    plannedRate: planned,
    physical: [`route:${id}`],
    measuredRate: measured?.rate,
    measuredTick: measured !== undefined ? TICK : undefined,
    measuredFull: measured !== undefined ? { from: measured.from, to: measured.to } : undefined,
    capacityRate: measured?.cap ?? 15,
  })
}

test("layout: sources left, one level per dataflow step; power edges drawn but flat", () => {
  const g = newGraph()
  node(g, "mine", "outpost", "iron-ore", 4)
  node(g, "smelt", "module", "iron-plate", 2)
  node(g, "gears", "module", "iron-gear-wheel", 1)
  node(g, "power", "power", "electricity", 1e6)
  belt(g, "e0", "mine", "smelt", "iron-ore", 4)
  belt(g, "e1", "smelt", "gears", "iron-plate", 2)
  addEdge(g, { id: "p0", role: "power>base", kind: "power", item: "electricity", from: "power", to: "smelt", plannedRate: 1e6, physical: [] })
  const v1 = graphLayout(g, TICK, P)
  eq(v1.levels.length, 3, "three depth levels")
  eq(v1.levels[0].map((n) => n.id).join(","), "mine,power", "sources and generators at level 0")
  eq(v1.levels[1].length, 1, "smelt alone at level 1")
  eq(v1.levels[2][0].id, "gears", "gears at level 2")
  eq(v1.edges.length, 3, "all edges in the table")
  ok(v1.edges[2].verdict === undefined, "power edge has no probe verdict")
})

test("layout: cycle leftovers land one level past the deepest resolved node", () => {
  const g = newGraph()
  node(g, "x", "module", "x", 1)
  node(g, "a", "module", "a", 1)
  node(g, "b", "module", "b", 1)
  node(g, "c", "module", "c", 1)
  belt(g, "e0", "x", "a", "x", 1)
  belt(g, "e1", "a", "b", "a", 1)
  belt(g, "e2", "b", "c", "b", 1)
  belt(g, "e3", "c", "a", "c", 1)
  const v = graphLayout(g, TICK, P)
  eq(v.levels.length, 2, "producing half + the stuck cycle")
  eq(v.levels[0][0].id, "x", "x resolves at 0")
  eq(v.levels[1].map((n) => n.id).join(","), "a,b,c", "cycle shares one level")
})

test("edge rows carry the probe verdicts; a crew-fed edge has no producer", () => {
  const g = newGraph()
  node(g, "a", "module", "a", 1)
  node(g, "b", "module", "b", 1)
  node(g, "c", "module", "c", 1)
  belt(g, "broken", "a", "b", "a", 5, { rate: 0, from: 1, to: 0 })
  belt(g, "sparse", "b", "c", "b", 5, { rate: 1.2, from: 0.2, to: 0.1 })
  belt(g, "fresh", undefined, "a", "x", 2)
  const v = graphLayout(g, TICK, P)
  const verdictOf: Record<string, string | undefined> = {}
  for (const e of v.edges) verdictOf[e.id] = e.verdict
  eq(verdictOf.broken, "broken", "piles up at the producer")
  eq(verdictOf.sparse, "sparse", "below plan while flowing")
  const fresh = v.edges.find((e) => e.id === "fresh")
  ok(fresh !== undefined && fresh.from === undefined, "no producer outside the graph")
  ok(fresh!.verdict === "stale", "never probed")
})

test("node rows: measured vs planned rate, load for power, cause text, status counts", () => {
  const g = newGraph()
  const mine = node(g, "mine", "outpost", "iron-ore", 4)
  mine.measured = { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-ore", perSecond: 3 }], machines: 4, states: { working: 0.6, starved: 0.4, blocked: 0, unpowered: 0, unfuelled: 0, idle: 0 } }
  mine.status = "starved"
  mine.cause = { kind: "node", id: "mine", what: "starved 40%", why: "dry patch" }
  node(g, "power", "power", "electricity", 1e6, { measured: { tick: TICK, window: 3600, inputs: [], outputs: [], load: 0.42, states: { working: 0.42, starved: 0, blocked: 0, unpowered: 0, unfuelled: 0, idle: 0.58 } } })
  node(g, "later", "module", "plates", 2, { lifecycle: "planned", status: "unknown" })
  const v = graphLayout(g, TICK, P)
  const m = v.nodes[0]
  assert(m.measuredOut !== undefined, "measured output present")
  near(m.measuredOut ?? 0, 3, 1e-9, "measured output rate")
  near(m.plannedOut, 4, 1e-9, "planned output rate")
  eq(m.cause, "node mine: starved 40% (dry patch)", "cause as where: what (why)")
  const p = v.nodes[1]
  near(p.load ?? 0, 0.42, 1e-9, "power load")
  const l = v.nodes[2]
  eq(l.lifecycle, "planned", "planned lifecycle kept")
  ok(l.measuredOut === undefined, "planned node has no measurement")
  eq(v.statusCounts.starved, 1, "one starved")
  eq(v.statusCounts.unknown, 1, "planned nodes stay unknown")
})

run("graph-layout")
