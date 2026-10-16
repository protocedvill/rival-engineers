import { addEdge, addNode, LogicalEdge, LogicalGraph, LogicalNode, newGraph, StateShares } from "../src/planner/logical"
import { classify, edgeVerdict, newReconcileState, reconcile, ReconcileParams, recordRemedy } from "../src/strategy/reconcile"
import { eq, ok, run, test } from "./harness"

// T1: the reconciler (SPEC §5.8, D26): node classification from measured states and rates, the root-cause walk
// (upstream for starved, downstream for backed-up, to the power or fuel supply), hysteresis and remedy limits.

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

const TICK = 10000

function st(x: Partial<StateShares>): StateShares {
  const s: StateShares = { working: 0, starved: 0, blocked: 0, unpowered: 0, unfuelled: 0, idle: 0, ...x }
  return s
}

function node(g: LogicalGraph, id: string, kind: LogicalNode["kind"], item: string, planned: number, states: StateShares, out: number, extra: Partial<LogicalNode> = {}): LogicalNode {
  return addNode(g, {
    id,
    role: id,
    kind,
    item,
    capacity: { inputs: [], outputs: [{ item, perSecond: planned * 1.2 }] },
    planned: { inputs: [], outputs: [{ item, perSecond: planned }] },
    powerW: kind === "power" ? 1e6 : 0,
    lifecycle: "built",
    status: "unknown",
    createdTick: 0,
    builtTick: 0,
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item, perSecond: out }], machines: 4, states },
    ...extra,
  })
}

function belt(g: LogicalGraph, id: string, from: string | undefined, to: string, item: string, planned: number, measured?: { rate: number; from: number; to: number; cap?: number }): LogicalEdge {
  return addEdge(g, {
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

const isFuel = (item: string): boolean => item === "coal"

/** Runs evaluations until statuses settle (unknown → first status at once). */
function settle(g: LogicalGraph, n = 1) {
  const s = newReconcileState()
  let r = reconcile(g, s, { tick: TICK, params: P, isFuel })
  for (let i = 1; i < n; i++) r = reconcile(g, s, { tick: TICK, params: P, isFuel })
  return { s, r }
}

/** Outpost → smelter → gears, the usual chain. */
function chain(outpost: StateShares, outOut: number, smelter: StateShares, smOut: number, gears: StateShares, gOut: number) {
  const g = newGraph()
  node(g, "mine", "outpost", "iron-ore", outOut, outpost, outOut, { measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-ore", perSecond: outOut }], machines: 4, states: outpost, estimated: true } })
  node(g, "smelt", "module", "iron-plate", 2, smelter, smOut, { measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: smOut }], machines: 8, states: smelter, missing: { "iron-ore": 0.8 } } })
  node(g, "gears", "module", "iron-gear-wheel", 1, gears, gOut, { measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-gear-wheel", perSecond: gOut }], machines: 2, states: gears, missing: { "iron-plate": 0.9 } } })
  return g
}

test("classify: on plan is ok; below plan the dominant state decides; no power marks a node even on plan; idle is ok", () => {
  const g = newGraph()
  const a = node(g, "a", "module", "x", 1, st({ working: 0.9, starved: 0.1 }), 0.95)
  eq(classify(a, P).status, "ok", "on plan")
  const b = node(g, "b", "module", "x", 1, st({ working: 0.3, starved: 0.6, blocked: 0.1 }), 0.3)
  eq(classify(b, P).status, "starved", "below plan, starved most")
  const c = node(g, "c", "module", "x", 1, st({ working: 0.3, starved: 0.1, blocked: 0.6 }), 0.3)
  eq(classify(c, P).status, "backed-up", "below plan, blocked most")
  const d = node(g, "d", "module", "x", 1, st({ working: 0.4, unpowered: 0.6 }), 1)
  eq(classify(d, P).status, "unpowered", "no power, even at plan")
  const e = node(g, "e", "labs", "research-unit", 1, st({ idle: 0.95, working: 0.05 }), 0.05)
  eq(classify(e, P).status, "ok", "labs without research are idle, not starved")
  const f = node(g, "f", "power", "electricity", 1e6, st({ working: 0.3, unfuelled: 0.7 }), 0)
  eq(classify(f, P).status, "unfuelled", "boilers without fuel")
  const u = node(g, "u", "module", "x", 1, st({}), 0)
  u.measured = undefined
  eq(classify(u, P).status, "unknown", "not measured")
})

test("edge verdict: stale, full (at its belt's capacity), intake-limited, broken, sparse", () => {
  const g = newGraph()
  node(g, "a", "module", "x", 1, st({ working: 1 }), 1)
  node(g, "b", "module", "y", 1, st({ working: 1 }), 1)
  eq(edgeVerdict(belt(g, "e0", "a", "b", "x", 10), TICK, P), "stale", "never probed")
  eq(edgeVerdict(belt(g, "e1", "a", "b", "x", 20, { rate: 14.6, from: 1, to: 1 }), TICK, P), "full", "at capacity")
  eq(edgeVerdict(belt(g, "e2", "a", "b", "x", 5, { rate: 1.2, from: 1, to: 0.9 }), TICK, P), "intake", "waiting at the consumer")
  eq(edgeVerdict(belt(g, "e3", "a", "b", "x", 5, { rate: 0, from: 1, to: 0 }), TICK, P), "broken", "piles up at the producer only")
  eq(edgeVerdict(belt(g, "e4", "a", "b", "x", 5, { rate: 2, from: 0.1, to: 0 }), TICK, P), "sparse", "sparse")
  const old = belt(g, "e5", "a", "b", "x", 5, { rate: 2, from: 0, to: 0 })
  old.measuredTick = TICK - P.probeMaxAge - 1
  eq(edgeVerdict(old, TICK, P), "stale", "too old")
})

test("starved chain: gears ← smelter ← outpost without power: the root cause is the outpost's power", () => {
  const g = chain(st({ working: 0.1, unpowered: 0.9 }), 0.2, st({ working: 0.1, starved: 0.9 }), 0.2, st({ working: 0.1, starved: 0.9 }), 0.1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.2, from: 0, to: 0 })
  belt(g, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.2, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.gears.status, "starved", "gears")
  eq(g.nodes.smelt.status, "starved", "smelter")
  eq(g.nodes.mine.status, "unpowered", "outpost")
  const c = g.nodes.gears.cause!
  eq(c.kind, "node", `gears' cause kind (${c.why})`)
  eq(c.id, "mine", "gears' cause is the outpost")
  eq(c.what, "no power node", c.why)
  eq(r.remedies.length, 0, "nothing to remedy without a power node")
  // With a power node that has spare capacity: the pole line is suspect (repair); at full load: grow the power.
  const g2 = chain(st({ working: 0.1, unpowered: 0.9 }), 0.2, st({ working: 0.1, starved: 0.9 }), 0.2, st({ working: 0.1, starved: 0.9 }), 0.1)
  belt(g2, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.2, from: 0, to: 0 })
  belt(g2, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.2, from: 0, to: 0 })
  const pw = node(g2, "pw", "power", "electricity", 1e6, st({ working: 1 }), 2e5)
  pw.measured!.load = 0.2
  addEdge(g2, { id: "p", role: "p", kind: "power", item: "electricity", from: "pw", to: "mine", plannedRate: 1e5, physical: ["line1"] })
  const r2 = settle(g2).r
  eq(g2.nodes.gears.cause!.what, "not connected", g2.nodes.gears.cause!.why)
  eq(r2.remedies.length, 1, "one remedy")
  eq(r2.remedies[0].kind, "repair", "repair the pole line")
  eq(r2.remedies[0].edge, "p", "the power edge")
  pw.measured!.load = 0.97
  g2.nodes.gears.status = "unknown"
  const r3 = settle(g2).r
  eq(r3.remedies[0].kind, "grow", "power at full load: grow it")
  eq(r3.remedies[0].node, "pw", "the power node")
})

test("starved by an undersized producer: the outpost runs flat out, the belt is sparse → grow the outpost", () => {
  const g = chain(st({ working: 0.97, blocked: 0.03 }), 1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 1, from: 0.05, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.smelt.status, "starved", "smelter starved")
  eq(g.nodes.smelt.cause!.what, "undersized", g.nodes.smelt.cause!.why)
  eq(r.remedies.length, 1, "one remedy")
  eq(r.remedies[0].kind, "grow", "grow")
  eq(r.remedies[0].node, "mine", "the outpost")
})

test("a belt still filling: the producer makes much more than arrives → wait (no grow)", () => {
  const g = chain(st({ working: 0.97 }), 2, st({ working: 0.3, starved: 0.7 }), 0.4, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.4, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.smelt.cause!.what, "filling", g.nodes.smelt.cause!.why)
  eq(r.remedies.length, 0, "no remedy")
})

test("broken belt: items pile up at the producer and none arrive → repair the route; the producer is backed up for the same cause", () => {
  const g = chain(st({ working: 0.05, blocked: 0.95 }), 0.1, st({ working: 0.05, starved: 0.95 }), 0.1, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0, from: 1, to: 0 })
  g.nodes.mine.planned.outputs = [{ item: "iron-ore", perSecond: 2 }]
  const { r } = settle(g)
  eq(g.nodes.mine.status, "backed-up", "outpost backed up")
  eq(g.nodes.smelt.cause!.kind, "edge", g.nodes.smelt.cause!.why)
  eq(g.nodes.smelt.cause!.what, "broken", "broken edge")
  eq(g.nodes.mine.cause!.id, "ore", "the outpost's cause is the same edge")
  eq(r.remedies.length, 1, "one remedy for both symptoms")
  eq(r.remedies[0].kind, "repair", "repair")
  eq(r.remedies[0].edge, "ore", "the ore edge")
})

test("an undersized belt into labs: the edge runs at its capacity → cause at-capacity, no remedy", () => {
  const g = newGraph()
  node(g, "red", "module", "automation-science-pack", 20, st({ working: 0.7, blocked: 0.3 }), 14)
  node(g, "labs", "labs", "research-unit", 20, st({ working: 0.7, starved: 0.3 }), 14, { measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "research-unit", perSecond: 14 }], machines: 20, states: st({ working: 0.7, starved: 0.3 }), missing: { "automation-science-pack": 0.3 } } })
  belt(g, "packs", "red", "labs", "automation-science-pack", 20, { rate: 14.7, from: 1, to: 1, cap: 14.85 })
  const { r } = settle(g)
  eq(g.nodes.labs.status, "starved", "labs starved")
  eq(g.nodes.labs.cause!.kind, "edge", g.nodes.labs.cause!.why)
  eq(g.nodes.labs.cause!.what, "at-capacity", "the belt is full")
  eq(r.remedies.length, 0, "no automatic remedy")
})

test("backed up by an unpowered consumer: the smelter's cause is the gear row's power", () => {
  const g = chain(st({ working: 0.9 }), 2, st({ working: 0.2, blocked: 0.8 }), 0.4, st({ working: 0.1, unpowered: 0.9 }), 0.1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.5, from: 1, to: 1 })
  belt(g, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.4, from: 1, to: 1 })
  settle(g)
  eq(g.nodes.smelt.status, "backed-up", "smelter backed up")
  eq(g.nodes.smelt.cause!.id, "gears", g.nodes.smelt.cause!.why)
  eq(g.nodes.smelt.cause!.what, "no power node", "gears without power")
})

test("unfuelled: a burner fed by the crew gets upkeep; one with a coal belt is traced to the coal outpost", () => {
  const g = newGraph()
  node(g, "steam-coal", "outpost", "coal", 1, st({ working: 0.1, unfuelled: 0.9 }), 0.1)
  const r1 = settle(g).r
  eq(g.nodes["steam-coal"].status, "unfuelled", "burner drills out of fuel")
  eq(r1.remedies[0].kind, "upkeep", "the crew refuels")
  const g2 = chain(st({ working: 0.9 }), 2, st({ working: 0.2, unfuelled: 0.8 }), 0.4, st({ working: 0.95 }), 1)
  node(g2, "coal", "outpost", "coal", 0.5, st({ working: 0.98 }), 0.5)
  belt(g2, "fuel", "coal", "smelt", "coal", 0.5, { rate: 0.5, from: 0, to: 0 })
  const r2 = settle(g2).r
  eq(g2.nodes.smelt.status, "unfuelled", "smelter unfuelled")
  eq(g2.nodes.smelt.cause!.id, "coal", g2.nodes.smelt.cause!.why)
  eq(r2.remedies[0].kind, "grow", "grow the coal outpost")
})

test("hysteresis: a known status changes only after `confirm` evaluations; warm-up keeps new nodes unknown", () => {
  const g = newGraph()
  const n = node(g, "a", "module", "x", 1, st({ working: 1 }), 1)
  const s = newReconcileState()
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(n.status, "ok", "first status at once")
  n.measured!.states = st({ working: 0.2, starved: 0.8 })
  n.measured!.outputs = [{ item: "x", perSecond: 0.2 }]
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(n.status, "ok", "1st evaluation")
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(n.status, "ok", "2nd")
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(n.status, "starved", "3rd: changed")
  // A one-off good sample doesn't flip it back.
  n.measured!.states = st({ working: 1 })
  n.measured!.outputs = [{ item: "x", perSecond: 1 }]
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  n.measured!.states = st({ working: 0.2, starved: 0.8 })
  n.measured!.outputs = [{ item: "x", perSecond: 0.2 }]
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(n.status, "starved", "no flip-flop")
  const young = node(g, "b", "module", "x", 1, st({ working: 0, starved: 1 }), 0, { builtTick: TICK - 10 })
  reconcile(g, s, { tick: TICK, params: P, isFuel })
  eq(young.status, "unknown", "warming up")
})

test("a feeder being grown (the steam block gaining boilers) keeps its consumers classified (M5b soak finding)", () => {
  const g = newGraph()
  const pw = node(g, "pw", "power", "electricity", 1e6, st({ working: 1 }), 5e5, { builtTick: 0 })
  const a = node(g, "a", "module", "x", 1, st({ working: 1 }), 1)
  addEdge(g, { id: "p", role: "p", kind: "power", item: "electricity", from: "pw", to: "a", plannedRate: 1e5, physical: [] })
  pw.lifecycle = "building"
  settle(g)
  eq(a.status, "ok", "the consumer is still classified")
  eq(pw.status, "unknown", "the growing node itself is not")
  const b = node(g, "b", "module", "y", 1, st({ working: 1 }), 1)
  const c = node(g, "c", "module", "z", 1, st({ working: 1 }), 1, { lifecycle: "building" })
  c.builtTick = undefined
  belt(g, "cb", "c", "b", "z", 1)
  settle(g)
  eq(b.status, "unknown", "a feeder never built yet: wait")
})

test("remedy limits: at most maxRemedies per root cause, cooldown between them", () => {
  const g = chain(st({ working: 0.97 }), 1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 1, from: 0, to: 0 })
  const s = newReconcileState()
  const at = (tick: number) => {
    for (const e of [g.edges.ore]) e.measuredTick = tick
    return reconcile(g, s, { tick, params: P, isFuel }).remedies
  }
  const r1 = at(TICK)
  eq(r1.length, 1, "first")
  recordRemedy(s, r1[0], TICK, "started")
  eq(at(TICK + 10).length, 0, "cooldown")
  const r2 = at(TICK + P.cooldownTicks)
  eq(r2.length, 1, "after the cooldown")
  recordRemedy(s, r2[0], TICK + P.cooldownTicks, "started")
  eq(at(TICK + 3 * P.cooldownTicks).length, 0, "limit reached")
  ok(s.log.length === 2, "logged")
})

test("B11 / D49: hand-fed labs before automated science are expected (no cause, no remedy); everything else is still checked", () => {
  const automated: Record<string, boolean> = {}
  const crewSupplied = (n: LogicalNode, item: string): boolean => n.kind === "labs" && !automated[item]
  const g = newGraph()
  // Labs starved of red packs, nothing in the graph makes them yet (the crew hand-feeds them).
  const labs = node(g, "labs", "labs", "research-unit", 0.2, st({ working: 0.3, starved: 0.7 }), 0.06, {
    planned: { inputs: [{ item: "automation-science-pack", perSecond: 0.2 }], outputs: [{ item: "research-unit", perSecond: 0.2 }] },
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "research-unit", perSecond: 0.06 }], machines: 4, states: st({ working: 0.3, starved: 0.7 }), missing: { "automation-science-pack": 0.7 } },
  })
  // An unrelated starved node next to it: still reported, traced and remedied.
  const ch = chain(st({ working: 0.97 }), 1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.95 }), 1)
  for (const id of ch.nodeOrder) addNode(g, ch.nodes[id])
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 1, from: 0, to: 0 })
  const s = newReconcileState()
  const r = reconcile(g, s, { tick: TICK, params: P, isFuel, crewSupplied })
  eq(labs.status, "expected", "hand-fed labs are expected")
  eq(labs.cause, undefined, "no root cause")
  eq(g.nodes.smelt.status, "starved", "the smelter is still checked from the start")
  eq(r.remedies.length, 1, "one remedy, for the outpost")
  eq(r.remedies[0].node, "mine", "grow the outpost")
  // Without the predicate (M5b behaviour) the labs were starved with an external cause.
  const g2 = newGraph()
  const labs2 = node(g2, "labs", "labs", "research-unit", 0.2, st({ working: 0.3, starved: 0.7 }), 0.06, { measured: labs.measured })
  reconcile(g2, newReconcileState(), { tick: TICK, params: P, isFuel })
  eq(labs2.status, "starved", "without crew supply the labs starve")
  eq(labs2.cause!.kind, "external", "crew-supplied cause")
  // Once the pack is automated, a starved lab is a problem again (after hysteresis).
  automated["automation-science-pack"] = true
  for (let i = 0; i < P.confirm; i++) reconcile(g, s, { tick: TICK, params: P, isFuel, crewSupplied })
  eq(labs.status, "starved", "automated pack: starved again")
  // Labs short of an automated pack and a hand-fed one: not expected (the automated one is a problem).
  automated["automation-science-pack"] = false
  labs.measured!.missing = { "automation-science-pack": 0.3, "logistic-science-pack": 0.4 }
  automated["logistic-science-pack"] = true
  for (let i = 0; i < P.confirm; i++) reconcile(g, s, { tick: TICK, params: P, isFuel, crewSupplied })
  eq(labs.status, "starved", "a mixed shortage is still starved")
})

test("a stale edge asks for a probe instead of acting", () => {
  const g = chain(st({ working: 0.97 }), 1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2)
  const { r } = settle(g)
  eq(g.nodes.smelt.cause!.kind, "measuring", "measuring")
  eq(r.probe[0], "ore", "probe the ore edge")
  eq(r.remedies.length, 0, "no remedy yet")
})

run("reconcile")
