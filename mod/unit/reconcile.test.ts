import { addEdge, addNode, LogicalEdge, LogicalGraph, LogicalNode, newGraph, StateShares } from "../src/planner/logical"
import { classify, edgeVerdict, newReconcileState, probeMaxAgeFor, reconcile, ReconcileParams, recordRemedy } from "../src/strategy/reconcile"
import { moduleId } from "../src/shared/ids"
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
  probeTicks: 600,
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
    id: moduleId(id),
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
    from: from !== undefined ? moduleId(from) : undefined,
    to: moduleId(to),
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
  // B52 (seed 3333): 5 of 9 boilers dry starve 10 of 18 engines; over all 27 machines neither share reached badShare.
  const f2 = node(g, "f2", "power", "electricity", 1e6, st({ working: 0.35, starved: 0.43, unfuelled: 0.22 }), 0)
  eq(classify(f2, P).status, "unfuelled", "dry boilers and the engines they starve")
  const f3 = node(g, "f3", "power", "electricity", 1e6, st({ working: 0.4, starved: 0.6 }), 0)
  eq(classify(f3, P).status, "starved", "no water (no boiler dry)")
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

test("B124: a starved consumer whose port is full while nothing goes in is a stopped lane: repair, not intake-limited", () => {
  // Seed 11 (min 610-770): iron ore stranded on a copper smelter's coal lane; coal waited at the port, 0/s went in.
  const g = chain(st({ working: 0.1, blocked: 0.9 }), 0.1, st({ working: 0.05, starved: 0.95 }), 0.1, st({ working: 0.1, starved: 0.9 }), 0.1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0, from: 1, to: 1 })
  belt(g, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.1, from: 0, to: 0 })
  const { r } = settle(g)
  const c = g.nodes.smelt.cause!
  eq(c.what, "stopped", c.why)
  eq(c.id, "ore", "the ore edge")
  eq(r.remedies.filter((x) => x.kind === "repair" && x.edge === "ore").length, 1, "repair the ore edge")
  // Items still go in (slowly): the module's intake is the limit, nothing to repair.
  const g2 = chain(st({ working: 0.1, blocked: 0.9 }), 0.1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.1, starved: 0.9 }), 0.1)
  belt(g2, "ore", "mine", "smelt", "iron-ore", 2, { rate: 1.2, from: 1, to: 1 })
  belt(g2, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.1, from: 0, to: 0 })
  const r2 = settle(g2).r
  eq(g2.nodes.smelt.cause!.what, "intake-limited", g2.nodes.smelt.cause!.why)
  eq(r2.remedies.filter((x) => x.edge === "ore").length, 0, "no repair")
})

test("B128: a trickle into a full port is a slow consumer, not a stopped lane", () => {
  // Seed 11, the first blue line's lab port: full, but 0.1/s went in (the labs used packs faster than the provider made
  // them). LOST_MIN_ITEMS called it "stopped" and every unclog repair found nothing.
  const g = chain(st({ working: 0.1, blocked: 0.9 }), 0.1, st({ working: 0.5, starved: 0.5 }), 0.1, st({ working: 0.1, starved: 0.9 }), 0.1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.1, from: 1, to: 1 })
  belt(g, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0.1, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.smelt.cause!.what, "intake-limited", g.nodes.smelt.cause!.why)
  eq(r.remedies.filter((x) => x.edge === "ore").length, 0, "no unclog repair for a trickle")
  eq(r.remedies.filter((x) => x.key.indexOf("unclog:") === 0).length, 0, "no unclog remedy at all")
})

test("B127: a producer blocked inside itself while it starves for an input: trace the input, don't repair its belt out", () => {
  // m7c-cont12 seed 11: circuit module (cable assemblers full, circuit assemblers short of iron) read backed-up; its
  // intact circuit belt was "repaired" three times while the iron feed's ore lane was held.
  const g = chain(st({ working: 0.1, blocked: 0.9 }), 0.1, st({ working: 0.05, starved: 0.95 }), 0.1, st({ starved: 0.4, blocked: 0.6 }), 0)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0, from: 1, to: 1 })
  belt(g, "plates", "smelt", "gears", "iron-plate", 2, { rate: 0, from: 0, to: 0 })
  node(g, "lab", "labs", "research-unit", 1, st({ starved: 1 }), 0)
  belt(g, "out", "gears", "lab", "iron-gear-wheel", 1, { rate: 0, from: 0, to: 0 })
  g.nodes.gears.measured!.missing = { "iron-plate": 0.4 }
  const { r } = settle(g)
  eq(r.remedies.filter((x) => x.edge === "out").length, 0, "no repair of the module's own output belt")
  eq(r.remedies.filter((x) => x.kind === "repair" && x.edge === "ore").length, 1, "the held ore lane is repaired")
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
  addEdge(g2, { id: "p", role: "p", kind: "power", item: "electricity", from: moduleId("pw"), to: moduleId("mine"), plannedRate: 1e5, physical: ["line1"] })
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

test("depleted outpost: the drills ran out of ore → expand in place over the rest of the patch (D52/B21)", () => {
  const g = newGraph()
  node(g, "mine", "outpost", "iron-ore", 1, st({ starved: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-ore", perSecond: 0 }], machines: 4, states: st({ starved: 1 }), missing: { depleted: 1 }, estimated: true },
  })
  node(g, "smelt", "module", "iron-plate", 2, st({ starved: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: 0 }], machines: 8, states: st({ starved: 1 }), missing: { "iron-ore": 1 } },
  })
  belt(g, "ore", "mine", "smelt", "iron-ore", 1, { rate: 0, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.mine.status, "starved", "outpost starved (worked out)")
  eq(g.nodes.mine.cause!.what, "depleted", g.nodes.mine.cause!.why)
  const grow = r.remedies.filter((x) => x.kind === "deplete" && x.node === "mine")
  eq(grow.length, 1, "a deplete remedy for the worked-out outpost")
  ok(grow[0] !== undefined && grow[0].key === "deplete:mine", "keyed by the depletion")
})

test("B98: a depleted outpost that is retiring (D67, D76) gets no deplete remedy (its retirement owns it)", () => {
  // Seed 2034469: n32 ran out while its replacement (D67) was being built; the deplete remedy re-planned a 60-s
  // in-patch move every measurement and threw it away ("wait" for the replacement's goal), ~190 ms/tick for hours.
  const g = newGraph()
  node(g, "mine", "outpost", "iron-ore", 1, st({ starved: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-ore", perSecond: 0 }], machines: 4, states: st({ starved: 1 }), missing: { depleted: 1 }, estimated: true },
  })
  node(g, "smelt", "module", "iron-plate", 2, st({ starved: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: 0 }], machines: 8, states: st({ starved: 1 }), missing: { "iron-ore": 1 } },
  })
  belt(g, "ore", "mine", "smelt", "iron-ore", 1, { rate: 0, from: 0, to: 0 })
  const r = reconcile(g, newReconcileState(), { tick: TICK, params: P, isFuel, retiring: (n) => n.id === "mine" })
  eq(g.nodes.mine.cause!.what, "depleted", g.nodes.mine.cause!.why)
  eq(r.remedies.filter((x) => x.node === "mine").length, 0, "no remedy: its replacement is under way")
})

test("B99: a consumer fed by a node folded into a shared mine is traced through that mine (backed up, nothing arrives → repair)", () => {
  // Soak vps-b97b-7625436: cluster 3's coal came from n41, an alias of the power plant's whole-patch coal mine n15. n41
  // has no machines of its own, so it was never measured ("unknown") and the unfuelled smelter never got a remedy;
  // n15 was backed up behind a stray underground on its trunk.
  const g = newGraph()
  node(g, "mine", "outpost", "coal", 2, st({ working: 0.05, blocked: 0.95 }), 0)
  node(g, "alias", "outpost", "coal", 0.2, st({}), 0, { alias: moduleId("mine"), measured: undefined })
  node(g, "smelt", "module", "iron-plate", 1, st({ unfuelled: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: 0 }], machines: 4, states: st({ unfuelled: 1 }), missing: { coal: 1 } },
  })
  node(g, "pw", "power", "electricity", 1, st({ working: 1 }), 1)
  belt(g, "trunk", "mine", "pw", "coal", 1.5, { rate: 0, from: 1, to: 0 })
  belt(g, "fuel", "alias", "smelt", "coal", 0.2, { rate: 0, from: 0, to: 0 })
  const { r } = settle(g, 2)
  eq(g.nodes.smelt.status, "unfuelled", "smelter unfuelled")
  ok(g.nodes.smelt.cause !== undefined && g.nodes.smelt.cause.what === "broken", `traced to a broken belt: ${g.nodes.smelt.cause?.why}`)
  ok(r.remedies.some((x) => x.kind === "repair" && x.edge === "fuel"), `the fuel belt is repaired: ${r.remedies.map((x) => `${x.kind}:${x.edge ?? x.node}`).join(",")}`)
})

test("a belt still filling: the producer makes much more than arrives → wait (no grow)", () => {
  const g = chain(st({ working: 0.97 }), 2, st({ working: 0.3, starved: 0.7 }), 0.4, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 0.4, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.smelt.cause!.what, "filling", g.nodes.smelt.cause!.why)
  eq(r.remedies.length, 0, "no remedy")
})

test("B69: nothing arrives while the producer makes the item (its other belts take it) → repair the route, not wait", () => {
  // Soak vps-d66 seed 5387208: the mall's iron smelter ran flat out for the mall, never backed up, while the tap to a red
  // science assembler had no splitter: the assembler starved for 150 game-min as a "filling" belt.
  const g = chain(st({ working: 0.97 }), 2, st({ starved: 1 }), 0, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 0.2, { rate: 0, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.smelt.cause!.what, "broken", g.nodes.smelt.cause!.why)
  eq(r.remedies.length, 1, "one remedy")
  eq(r.remedies[0].kind, "repair", "repair")
  eq(r.remedies[0].edge, "ore", "the silent edge")
})

test("M7c.8: a trickle too thin for one probe to catch is not 'none reaches' (no repair of an intact route)", () => {
  // fixes-360 seed 11: the labs#2 iron-plate tap got 0.03-0.5/s; 10 s probes saw no plate and re-laid the route 3 times.
  const g = chain(st({ working: 0.97 }), 0.1, st({ starved: 1 }), 0, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 0.2, { rate: 0, from: 0, to: 0 })
  const { r } = settle(g)
  eq(r.remedies.filter((x) => x.kind === "repair").length, 0, "no repair")
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
  addEdge(g, { id: "p", role: "p", kind: "power", item: "electricity", from: moduleId("pw"), to: moduleId("a"), plannedRate: 1e5, physical: [] })
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

test("B102: a root cause whose node recovered starts a new history (its remedies can act again when it fails later)", () => {
  // Sweep 628fa29 seed 1264816: cluster 2's ore belt used up its repairs at ~90 min (nothing missing then); it worked from
  // ~125 min, lost a belt at ~150 min, and was never repaired again (300 game-min).
  const g = chain(st({ working: 0.97 }), 1, st({ working: 0.5, starved: 0.5 }), 1, st({ working: 0.95 }), 1)
  belt(g, "ore", "mine", "smelt", "iron-ore", 2, { rate: 1, from: 0, to: 0 })
  const s = newReconcileState()
  const at = (tick: number) => {
    g.edges.ore.measuredTick = tick
    for (const id of g.nodeOrder) if (g.nodes[id].measured !== undefined) g.nodes[id].measured!.tick = tick
    return reconcile(g, s, { tick, params: P, isFuel }).remedies
  }
  let t = TICK
  for (let i = 0; i < P.maxRemedies; i++) {
    const r = at(t)
    eq(r.length, 1, `remedy ${i + 1}`)
    recordRemedy(s, r[0], t, "nothing missing")
    t += P.cooldownTicks
  }
  eq(at(t).length, 0, "the limit is reached")
  // The smelter recovers (confirmed ok) ...
  const smelt = g.nodes.smelt
  const starved = smelt.measured!.states
  smelt.measured!.states = st({ working: 0.95 })
  smelt.measured!.missing = {}
  for (let i = 0; i < P.confirm; i++) at((t += 60))
  eq(smelt.status, "ok", "the smelter is ok again")
  // ... and fails again later: a new episode.
  smelt.measured!.states = starved
  smelt.measured!.missing = { "iron-ore": 0.8 }
  let again = 0
  for (let i = 0; i < P.confirm + 1; i++) again += at((t += P.cooldownTicks)).length
  ok(again > 0, "its repair can act again")
})

test("B103: a node's plan is at least what its belts are planned to carry (a shared smelter planned for one consumer)", () => {
  // 1264816 (B102 replay): cluster 1's iron smelter kept its first plan (0.37/s) while its belts were planned for 3.4/s;
  // making 0.63/s it was "ok", so the starved labs behind it got no remedy (science held at ~27/min of 30).
  const g = newGraph()
  node(g, "smelt", "module", "iron-plate", 0.37, st({ working: 0.17, starved: 0.83 }), 0.63, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: 0.63 }], machines: 12, states: st({ working: 0.17, starved: 0.83 }), missing: { "iron-ore": 0.83 } },
  })
  node(g, "a", "module", "x", 1, st({ working: 1 }), 1)
  node(g, "b", "module", "y", 1, st({ working: 1 }), 1)
  belt(g, "ea", "smelt", "a", "iron-plate", 1.9)
  belt(g, "eb", "smelt", "b", "iron-plate", 1.5)
  settle(g, 2)
  eq(g.nodes.smelt.status, "starved", `starved against its belts' plan: ${g.nodes.smelt.statusReason}`)
})

test("B104: an edge measurement stays fresh for a whole probe round (one probe at a time over every belt)", () => {
  // 1264816 (B103 replay): ~38 belts at ~630 ticks a probe is a ~24000-tick round, but a measurement was fresh for 3600:
  // the trace of a starved smelter fed by three belts always met a stale one ("measuring", 300 game-min, no remedy).
  eq(probeMaxAgeFor(3600, 600, 30, 2), 3600, "two belts: the node window")
  eq(probeMaxAgeFor(3600, 600, 30, 38), 38 * 630, "38 belts: one round")
})

test("B105: a passive verdict on one feed does not hide another feed of the same item that has a cause to act on", () => {
  // 1264816 (B104 replay): cluster 1's smelter took ore from three mines into one port; the trace stopped at the first
  // ("below plan", no remedy) and never reached the second, backed up 71% ("broken": repair).
  const g = newGraph()
  node(g, "m1", "outpost", "iron-ore", 0.37, st({ working: 0.8 }), 0.3)
  node(g, "m2", "outpost", "iron-ore", 1, st({ working: 0.29, blocked: 0.71 }), 0.29)
  node(g, "smelt", "module", "iron-plate", 3.4, st({ working: 0.17, starved: 0.83 }), 0.63, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "iron-plate", perSecond: 0.63 }], machines: 12, states: st({ working: 0.17, starved: 0.83 }), missing: { "iron-ore": 0.83 } },
  })
  belt(g, "a", "m1", "smelt", "iron-ore", 0.37, { rate: 0.6, from: 0, to: 0 })
  belt(g, "b", "m2", "smelt", "iron-ore", 1, { rate: 0.6, from: 0, to: 0 })
  const { r } = settle(g, 2)
  eq(g.nodes.m2.status, "backed-up", "the second mine is backed up")
  ok(r.remedies.some((x) => x.kind === "repair" && x.edge === "b"), `its belt is repaired: ${g.nodes.smelt.cause?.why} | ${r.remedies.map((x) => `${x.kind}:${x.edge ?? x.node}`).join(",")}`)
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


test("B60 group remedy: a shared trunk at capacity asks for a parallel provider, not for one producer to grow", () => {
  const g = newGraph()
  const busy = st({ working: 1 })
  node(g, "p", "module", "iron-plate", 10, busy, 10)
  // Two consumers of the same provider; the first one's belt is at capacity.
  for (const c of ["a", "b"]) {
    node(g, c, "module", "gears", 2, st({ starved: 1 }), 0, {
      measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "gears", perSecond: 0 }], machines: 4, states: st({ starved: 1 }), missing: { "iron-plate": 1 } },
    })
  }
  belt(g, "pa", "p", "a", "iron-plate", 10, { rate: 14, from: 0, to: 0.1, cap: 15 })
  belt(g, "pb", "p", "b", "iron-plate", 10, { rate: 10, from: 0, to: 0.1, cap: 15 })
  const { r } = settle(g, 3)
  eq(r.remedies.length, 1, "one remedy")
  eq(r.remedies[0].kind, "parallel", "a shared trunk gets a parallel provider")
  eq(r.remedies[0].node, "p", "the shared provider")
})

test("B87: a module short of its own intermediate is traced through its belt inputs, not called crew-supplied", () => {
  // Soak vps-a06-r5387208: the red line (gears made inside the module) measured "missing gears" most. No edge carries
  // gears, so the trace stopped at "no producer (crew-supplied)" and never looked at its iron belt, where nothing
  // arrived while the smelter made 1.27/s: no remedy for 200 game-min.
  const g = newGraph()
  node(g, "smelt", "module", "iron-plate", 1, st({ working: 1 }), 1.27)
  node(g, "red", "module", "automation-science-pack", 0.2, st({ starved: 1 }), 0, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "automation-science-pack", perSecond: 0 }], machines: 3, states: st({ starved: 1 }), missing: { "iron-gear-wheel": 0.67, "iron-plate": 0.33 } },
  })
  belt(g, "plates", "smelt", "red", "iron-plate", 0.37, { rate: 0, from: 0, to: 0 })
  const { r } = settle(g)
  eq(g.nodes.red.cause!.what, "broken", g.nodes.red.cause!.why)
  eq(r.remedies.length, 1, "one remedy")
  eq(r.remedies[0].edge, "plates", "repair the silent plate belt")
  // Short of only an item no edge carries: still the external cause (hand-fed inputs keep their meaning).
  g.nodes.red.measured!.missing = { "iron-gear-wheel": 1 }
  const g2 = newGraph()
  node(g2, "red", "module", "automation-science-pack", 0.2, st({ starved: 1 }), 0, { measured: g.nodes.red.measured })
  settle(g2)
  eq(g2.nodes.red.cause!.kind, "external", "nothing else to trace")
})

test("B96: a shared producer's other belts carry the rest of its output: not 'filling', the producer flat out grows", () => {
  // Sweep 3e1c4d7 seed 1264816: the iron smelter made 0.633/s for three consumers; 0.3/s reached the green assembler, the
  // rest the others. Every evaluation called the green belt "filling" (0.3 < 0.75 x 0.633): no remedy for 300 game-min.
  const g = newGraph()
  node(g, "smelt", "module", "iron-plate", 0.6, st({ working: 0.97 }), 0.633)
  node(g, "green", "module", "logistic-science-pack", 0.2, st({ working: 0.3, starved: 0.7 }), 0.06, {
    measured: { tick: TICK, window: 3600, inputs: [], outputs: [{ item: "logistic-science-pack", perSecond: 0.06 }], machines: 2, states: st({ working: 0.3, starved: 0.7 }), missing: { "iron-plate": 0.7 } },
  })
  node(g, "red", "module", "automation-science-pack", 0.2, st({ working: 0.95 }), 0.2)
  belt(g, "to-green", "smelt", "green", "iron-plate", 0.5, { rate: 0.3, from: 0, to: 0 })
  belt(g, "to-red", "smelt", "red", "iron-plate", 0.4, { rate: 0.333, from: 0, to: 0 })
  const { r } = settle(g)
  ok(g.nodes.green.cause!.what !== "filling", `not filling: ${g.nodes.green.cause!.what} (${g.nodes.green.cause!.why})`)
  eq(g.nodes.green.cause!.what, "undersized", g.nodes.green.cause!.why)
  eq(r.remedies.length > 0 && r.remedies[0].kind === "grow" && r.remedies[0].node === "smelt", true, "grow the shared smelter")
})

run("reconcile")
