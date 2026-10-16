import { generate, GeneratorName } from "../src/modules/generators"
import { ModuleDef } from "../src/modules/types"
import { beltTiers } from "../src/planner/capacity"
import { addNode, LogicalGraph, newGraph } from "../src/planner/logical"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { design, DesignContext, DesignNode, diffDesign, generatorFor, goalsFrom, isPowerRole, producerFor, stuckRounds } from "../src/strategy/design"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: the factory design (module selection and sizing from the solver), the goal diff against the logical graph, and
// the D24 overflow remedies (SPEC §5.5, §5.8).

const RED = "automation-science-pack"

function ctx(changes: Partial<DesignContext> = {}, policy: Partial<LayoutPolicy> = {}): DesignContext {
  return {
    facts: F,
    make: (gen, params) => generate(F, gen as GeneratorName, params),
    researched: {},
    enabled: { "iron-plate": true, "copper-plate": true, "iron-gear-wheel": true, "transport-belt": true },
    plannable: { electronics: true, automation: true },
    resources: ["iron-ore", "copper-ore", "coal", "stone"],
    fuel: "coal",
    assembler: "assembling-machine-1",
    furnace: "stone-furnace",
    electricDrill: "electric-mining-drill",
    burnerDrill: "burner-mining-drill",
    lab: "lab",
    boiler: "boiler",
    engine: "steam-engine",
    packs: [RED, "logistic-science-pack"],
    researchUnitTime: 15,
    tiers: beltTiers(F),
    policy: { ...selectPolicy("early-compact", {}), ...policy },
    ...changes,
  }
}

function byRole(nodes: DesignNode[], role: string): DesignNode | undefined {
  for (const n of nodes) if (n.role === role) return n
  return undefined
}

const SMELT_FE = `iron-plate>${RED}>labs`
const SMELT_CU = `copper-plate>${RED}>labs`

test("module selection by recipe structure: outposts, smelters, red line, circuit block, assembler row", () => {
  const c = ctx()
  eq(generatorFor(c, "iron-ore"), "mining-outpost", "ore")
  eq(generatorFor(c, "iron-plate"), "smelter-column", "plate")
  eq(generatorFor(c, RED), "red-line", "red science (gear intermediate)")
  eq(generatorFor(c, "electronic-circuit"), "circuit-block", "circuits (cable yields 2)")
  eq(generatorFor(c, "iron-gear-wheel"), "assembler-row", "gears")
  eq(tostring(generatorFor(c, "inserter")), "nil", "3 ingredients: no generator (curated, M6)")
})

test("10 red/min to labs: 4 labs, a red line, two smelters fed by ore and coal outposts, a steam block and its coal", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  eq(d.clusters, 1, "one cluster")
  const labs = byRole(d.nodes, "labs")!
  eq(labs.params.labs, 4, "labs = 2⌈R·15 s / 2⌉")
  const red = byRole(d.nodes, `${RED}>labs`)!
  eq(red.generator, "red-line", "red line")
  eq(red.params.units, 1, "one unit (0.2 red/s)")
  eq(byRole(d.nodes, SMELT_FE)!.params.furnaces, 4, "iron smelter 4 furnaces")
  eq(byRole(d.nodes, SMELT_CU)!.params.furnaces, 4, "copper smelter 4 furnaces")
  const ironOre = byRole(d.nodes, `iron-ore>${SMELT_FE}`)!
  eq(ironOre.params.drill, "electric-mining-drill", "plannable research: electric drills")
  ok(byRole(d.nodes, `coal>${SMELT_FE}`) !== undefined, "coal outpost for the iron smelter (point-to-point)")
  ok(byRole(d.nodes, `coal>${SMELT_CU}`) !== undefined, "coal outpost for the copper smelter")
  const steam = byRole(d.nodes, "power")!
  eq(steam.params.boilers, 1, "one boiler")
  ok(d.electricW > 0 && d.electricW <= steam.capacity, `electric ${d.electricW} W within ${steam.capacity}`)
  const steamCoal = byRole(d.nodes, "coal>power")!
  eq(steamCoal.params.drill, "burner-mining-drill", "the steam block's own coal: burner drills (no power yet)")
  eq(d.nodes.length, 10, `10 modules: ${d.nodes.map((n) => `${n.role}:${n.generator}`).join(" | ")}`)
  eq(d.edges.length, 8, "8 flows")
  // The plate flows agree with the solver: 1/3 Fe/s and 1/6 Cu/s for 10 red/min.
  for (const e of d.edges) {
    if (e.to === `${RED}>labs` && e.item === "iron-plate") near(e.rate, 1 / 3, 1e-9, "iron plate flow")
    if (e.to === `${RED}>labs` && e.item === "copper-plate") near(e.rate, 1 / 6, 1e-9, "copper plate flow")
    eq(e.decision.action, "none", `edge ${e.role} fits a yellow belt`)
  }
  near(d.solve.items["iron-plate"].produced, 1 / 3, 1e-9, "solver iron")
  ok(d.techs.indexOf("automation") >= 0, "needs automation")
})

test("power roles: the steam block and its fuel supply", () => {
  ok(isPowerRole("power") && isPowerRole("power#2") && isPowerRole("coal>power") && isPowerRole("coal>power#3"), "power roles")
  ok(!isPowerRole("power-armor>labs") && !isPowerRole("coal>iron-plate>labs"), "not power roles")
})

function graphWith(d: ReturnType<typeof design>, roles: string[], capacity: Record<string, number> = {}): LogicalGraph {
  const g = newGraph()
  for (const n of d.nodes) {
    if (roles.indexOf(n.role) < 0) continue
    const cap = capacity[n.role] ?? n.capacity
    addNode(g, {
      id: `n${g.nextId++}`,
      role: n.role,
      kind: n.kind,
      item: n.item,
      capacity: { inputs: [], outputs: [{ item: n.item, perSecond: cap }] },
      planned: { inputs: [], outputs: [] },
      powerW: n.powerW,
      lifecycle: "built",
      status: "unknown",
      createdTick: 0,
    })
  }
  return g
}

test("goal diff: from nothing, power first (steam + its coal), then labs, then the production chain", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const diff = diffDesign(d, newGraph(), () => undefined)
  eq(diff.missing.length, 10, "all missing")
  const goals = goalsFrom(diff, {})
  eq(goals.map((gs) => gs.kind).join(","), "power,labs,production", "order")
  eq(goals[0].nodes.map((n) => n.role).sort().join(","), "coal>power,power", "power goal")
  eq(goals[0].edges.length, 1, "coal → steam")
  eq(goals[2].nodes.length, 7, "production modules")
  ok(goals[2].techs.indexOf("automation") >= 0, "production needs automation")
  eq(goals[2].edges.length, 7, "every other flow, including red → labs")
})

test("goal diff: built power and labs leave only production; a short smelter grows (expand-first)", () => {
  const c = ctx()
  const d = design(c, { item: RED, perSecond: 10 / 60 })
  const g = graphWith(d, ["power", "coal>power", "labs"])
  const goals = goalsFrom(diffDesign(d, g, () => undefined), {})
  eq(goals.map((gs) => gs.kind).join(","), "production", "only production")
  // A higher target: the existing 4-furnace iron smelter (1.25/s) is short of 2 Fe/s.
  const d2 = design(c, { item: RED, perSecond: 1 })
  const smelter = generate(F, "smelter-column", { recipe: "iron-plate", furnaces: 4 }) as ModuleDef
  const all: string[] = []
  for (const n of d2.nodes) all.push(n.role)
  const g2 = graphWith(d2, all, { [SMELT_FE]: 1.25 })
  let id = ""
  for (const nid of g2.nodeOrder) if (g2.nodes[nid].role === SMELT_FE) id = nid
  const diff = diffDesign(d2, g2, (node) => (node === id ? smelter : undefined))
  eq(diff.grow.length, 1, "one module to grow")
  eq(diff.grow[0].role, SMELT_FE, "the iron smelter")
  near(diff.grow[0].need, 2, 1e-9, "needs 2 Fe/s")
  eq(diff.grow[0].units, 1, "one more unit (4 furnaces, +1.25/s)")
  const goals2 = goalsFrom(diff, {})
  eq(goals2[goals2.length - 1].kind, "grow", "a grow goal")
})

test("D24: an edge over its usable capacity upgrades its belt tier when researched, else splits into clusters", () => {
  // A tiny utilization cap makes the 1/3 plate/s flows overflow a yellow belt (usable 0.3/s).
  const tight = { utilization: 0.02 }
  const split = design(ctx({}, tight), { item: RED, perSecond: 10 / 60 })
  eq(split.clusters, 2, "parallel-route × 2 → two production clusters")
  ok(byRole(split.nodes, "labs") !== undefined && byRole(split.nodes, "labs#2") !== undefined, "two lab arrays (cluster 1 keeps the plain roles)")
  for (const e of split.edges) if (!isPowerRole(e.to)) ok(e.rate <= 0.3 + 1e-9, `edge ${e.role} ${e.rate}/s fits after the split`)
  let remedies = 0
  for (const [, v] of pairs(split.overflow)) if (string.find(v as string, "parallel", 1, true)[0] !== undefined) remedies++
  ok(remedies > 0, "remedy recorded")
  const up = design(ctx({ researched: { "logistics-2": true } }, tight), { item: RED, perSecond: 10 / 60 })
  eq(up.clusters, 1, "no split with fast belts available")
  let fast = 0
  for (const e of up.edges) if (e.belt === "fast-transport-belt") fast++
  ok(fast > 0, "overflowing edges ride fast belts")
})

test("a module that cannot grow big enough splits the target into clusters", () => {
  // 300 red/min = 5/s; a red line tops out at 10 units = 2 red/s.
  const d = design(ctx(), { item: RED, perSecond: 5 })
  eq(d.clusters, 3, "three clusters")
  for (const n of d.nodes) if (n.generator === "red-line") ok(n.capacity + 1e-9 >= n.need, `${n.role} covers its share`)
})

test("splitter-tap topology: one producer per item, sized for every consumer", () => {
  const d = design(ctx({}, { topology: "splitter-tap" }), { item: RED, perSecond: 10 / 60 })
  let coal = 0
  for (const n of d.nodes) if (n.item === "coal") coal++
  eq(coal, 1, "one coal outpost")
  let coalEdges = 0
  for (const e of d.edges) if (e.item === "coal") coalEdges++
  eq(coalEdges, 3, "feeding both smelters and the steam block")
})

test("B2: recorded splitter taps: one coal producer feeds both smelters; the power node keeps its own coal", () => {
  const d = design(ctx({ taps: { coal: [SMELT_FE, SMELT_CU] } }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = byRole(d.nodes, "coal")
  ok(coal !== undefined, "one shared coal producer")
  eq(byRole(d.nodes, `coal>${SMELT_FE}`), undefined, "no point-to-point coal for the iron smelter")
  eq(byRole(d.nodes, `coal>${SMELT_CU}`), undefined, "nor for the copper smelter")
  ok(byRole(d.nodes, "coal>power") !== undefined, "power keeps its own fuel producer")
  let edges = 0
  for (const e of d.edges) if (e.from === "coal") edges++
  eq(edges, 2, "two edges from the shared producer")
  const p2p = design(ctx(), { item: RED, perSecond: 10 / 60 })
  near(coal!.need, byRole(p2p.nodes, `coal>${SMELT_FE}`)!.need + byRole(p2p.nodes, `coal>${SMELT_CU}`)!.need, 1e-9, "sized for both")
})

// M6: the green line is curated (an inserter has three ingredients); T1 uses a stub with its measured rates.
const GREEN = "logistic-science-pack"
const GREEN_ID = "green-line-hellpet"
function greenStub(): ModuleDef {
  return {
    id: GREEN_ID,
    source: "curated",
    footprint: { w: 19, h: 12 },
    entities: [],
    ports: [
      { id: "out", kind: "belt-out", pos: { x: 0.5, y: 6.5 }, dir: 12, item: GREEN },
      { id: "in-copper-plate", kind: "belt-in", pos: { x: 18.5, y: 0.5 }, dir: 12, item: "copper-plate" },
      { id: "in-iron-plate", kind: "belt-in", pos: { x: 18.5, y: 5.5 }, dir: 12, item: "iron-plate" },
    ],
    recipe: GREEN,
    machines: [{ name: "assembling-machine-1", count: 11 }],
    rates: {
      inputs: [
        { item: "iron-plate", perSecond: 0.28 * 5.5 },
        { item: "copper-plate", perSecond: 0.28 * 1.5 },
        { item: "electricity", perSecond: 900000, kind: "power" },
      ],
      outputs: [{ item: GREEN, perSecond: 0.28 }],
    },
    requiresTech: ["logistic-science-pack", "logistics"],
    rotatable: true,
  } as unknown as ModuleDef
}

function greenCtx(changes: Partial<DesignContext> = {}): DesignContext {
  const make = (gen: string, params: Record<string, unknown>): ModuleDef => (gen === "curated" ? greenStub() : (generate(F, gen as GeneratorName, params) as ModuleDef))
  return ctx({ curated: { [GREEN]: GREEN_ID }, researchUnitTime: 30, make, ...changes })
}

const STAGE2 = { item: RED, perSecond: 0.55, also: [{ item: GREEN, perSecond: 0.55 }] }

test("M6: green science comes from the curated line (its chain has no generator for inserters)", () => {
  const c = greenCtx()
  eq(producerFor(c, GREEN), "curated", "green: curated")
  eq(producerFor(c, RED), "red-line", "red: still the generator (generators first)")
  eq(producerFor(c, "iron-plate"), "smelter-column", "plates: generators")
})

test("M6: 30 + 30/min (+10%) splits into two clusters around one steam block; cluster 1 keeps the stage-1 roles", () => {
  const d = design(greenCtx(), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  eq(d.clusters, 2, "a green line makes 0.28/s: two clusters")
  const labs = byRole(d.nodes, "labs")!
  eq(labs.params.labs, 10, "labs = 2⌈0.275 · 30 s / 2⌉")
  ok(byRole(d.nodes, "labs#2") !== undefined, "second lab array")
  eq(labs.inputs.length, 2, "labs take red and green")
  const g1 = byRole(d.nodes, `${GREEN}>labs`)!
  eq(g1.generator, "curated", "green line in cluster 1")
  ok(byRole(d.nodes, `${GREEN}>labs#2`) !== undefined, "green line in cluster 2")
  ok(byRole(d.nodes, `${RED}>labs`) !== undefined && byRole(d.nodes, `${RED}>labs#2`) !== undefined, "a red line per cluster")
  ok(byRole(d.nodes, `iron-plate>${GREEN}>labs`) !== undefined, "the green line's iron smelter")
  ok(byRole(d.nodes, "power") !== undefined, "one steam block")
  eq(byRole(d.nodes, "power#2"), undefined, "no second steam block")
  let demand = 0
  for (const n of d.nodes) if (n.kind !== "power") demand += n.powerW
  ok(byRole(d.nodes, "power")!.capacity + 1e-6 >= demand, `the steam block covers both clusters (${byRole(d.nodes, "power")!.capacity} W ≥ ${demand} W)`)
  for (const e of d.edges) if (e.item === GREEN) near(e.rate, 0.275, 1e-9, "each green line feeds its labs half the target")
})

test("M6: the stage-2 diff on a built stage-1 factory grows the labs and plans the green chain, then cluster 2", () => {
  const c = greenCtx()
  const s1 = design(greenCtx({ researchUnitTime: 15 }), { item: RED, perSecond: 10 / 60 })
  const all: string[] = []
  for (const n of s1.nodes) all.push(n.role)
  const g = graphWith(s1, all)
  const labDef = generate(F, "lab-array", byRole(s1.nodes, "labs")!.params) as ModuleDef
  let labsId = ""
  for (const id of g.nodeOrder) if (g.nodes[id].role === "labs") labsId = id
  const d = design(c, STAGE2)
  const diff = diffDesign(d, g, (node) => (node === labsId ? labDef : undefined))
  let labsGrow: { units: number; need: number; have: number } | undefined
  for (const gr of diff.grow) if (gr.role === "labs") labsGrow = gr
  ok(labsGrow !== undefined, "the labs grow")
  eq(labsGrow!.have, 4, "4 labs built")
  eq(labsGrow!.need, 10, "10 wanted")
  eq(labsGrow!.units, 3, "3 units of 2 labs")
  const goals = goalsFrom(diff, {})
  const kinds = goals.map((gs) => (gs.kind === "production" ? `production#${gs.cluster}` : gs.kind))
  ok(kinds.indexOf("production#1") >= 0 && kinds.indexOf("production#2") >= 0, `production per cluster: ${kinds.join(",")}`)
  ok(kinds.indexOf("production#1") < kinds.indexOf("production#2"), "cluster 1 first")
  for (const gs of goals) {
    if (gs.kind !== "production" || gs.cluster !== 1) continue
    for (const n of gs.nodes) ok(string.find(n.role, "#", 1, true)[0] === undefined, `cluster-1 goal holds only cluster-1 roles (${n.role})`)
    ok(byRole(gs.nodes, `${GREEN}>labs`) !== undefined, "cluster 1 builds its green line")
  }
})

function keepOf(d: ReturnType<typeof design>): Record<string, string> {
  const keep: Record<string, string> = {}
  for (const e of d.edges) keep[`${e.item}@${e.to}`] = e.from
  return keep
}

test("B19: shared providers: new smelters share one coal outpost per cluster; stage-1 smelters keep theirs", () => {
  const s1 = design(greenCtx({ researchUnitTime: 15 }), { item: RED, perSecond: 10 / 60 })
  const d = design(greenCtx({ sharing: { keep: keepOf(s1), spare: {} } }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = d.nodes.filter((n) => n.item === "coal")
  const roles = coal.map((n) => n.role).sort()
  ok(byRole(d.nodes, `coal>${SMELT_FE}`) !== undefined && byRole(d.nodes, `coal>${SMELT_CU}`) !== undefined, "stage-1 smelters keep their own coal")
  ok(byRole(d.nodes, "coal>power") !== undefined, "power keeps its own")
  let shared = 0
  for (const n of coal) if (string.find(n.role, "coal*>", 1, true)[0] === 1) shared++
  eq(shared, 2, `one shared coal producer per cluster: ${roles.join(" | ")}`)
  eq(coal.length, 5, "2 kept + power + 2 shared")
  const p2p = design(greenCtx(), STAGE2)
  ok(p2p.nodes.filter((n) => n.item === "coal").length >= 9, "point-to-point: one per smelter")
})

test("B19: one coal outpost feeds both smelter columns and the power block (power's outpost has room)", () => {
  // Power and its coal outpost are built (point-to-point, before splitters); production comes with splitters.
  const s0 = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const powerCoal = byRole(s0.nodes, "coal>power")!
  const keep = { "coal@power": "coal>power" }
  let used = 0
  for (const e of s0.edges) if (e.from === "coal>power") used += e.rate
  const room = powerCoal.capacity - used
  ok(room > 0.1, `the steam block's coal outpost has room (${room}/s)`)
  const d = design(ctx({ sharing: { keep, spare: { coal: { "coal>power": room } } } }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = d.nodes.filter((n) => n.item === "coal")
  eq(coal.length, 1, `one coal producer: ${coal.map((n) => n.role).join(" | ")}`)
  eq(coal[0].role, "coal>power", "the steam block's")
  const fed = d.edges.filter((e) => e.from === "coal>power").map((e) => e.to).sort()
  eq(fed.join(","), [SMELT_CU, SMELT_FE, "power"].sort().join(","), "feeds both smelters and the steam block")
  near(coal[0].need, used + d.edges.filter((e) => e.from === "coal>power" && e.to !== "power").reduce((a, e) => a + e.rate, 0), 1e-9, "sized for all three")
  // Without room the smelters share one new outpost: 2 mines instead of 3.
  const tight = design(ctx({ sharing: { keep, spare: {} } }), { item: RED, perSecond: 10 / 60 })
  eq(tight.nodes.filter((n) => n.item === "coal").length, 2, "power's own + one shared")
})

test("M6: a steam block that can't grow gets a second one (power#2) for the excess, with its own coal", () => {
  const d0 = design(greenCtx(), STAGE2)
  const cap = 1.8e6
  ok(byRole(d0.nodes, "power")!.need > cap, "the design needs more than one boiler")
  const d = design(greenCtx({ powerCap: cap }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  const p2 = byRole(d.nodes, "power#2")
  ok(p2 !== undefined, "second steam block")
  ok(p2!.capacity + 1e-6 >= byRole(d.nodes, "power")!.need - cap, `covers the excess (${p2!.capacity} W)`)
  ok(byRole(d.nodes, "coal>power#2") !== undefined, "its own coal")
  ok(isPowerRole("power#2") && isPowerRole("coal>power#2"), "power roles")
})

test("M6: a cluster-1 module that can't grow caps cluster 1's share; the other clusters make the rest", () => {
  // Cluster 1's labs stay at 4 of the 10 wanted: it takes 0.4 of its half, 0.2 of the target.
  const d = design(greenCtx({ cluster1Max: 0.2 }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  eq(byRole(d.nodes, "labs")!.params.labs, 4, "cluster 1 keeps 4 labs")
  let green1 = 0
  let rest = 0
  for (const e of d.edges) {
    if (e.item !== GREEN) continue
    if (e.to === "labs") green1 += e.rate
    else rest += e.rate
  }
  near(green1, 0.2 * 0.55, 1e-9, "cluster 1's green share")
  near(green1 + rest, 0.55, 1e-9, "the whole target is still planned")
  ok(d.clusters >= 3, `more clusters for the rest (${d.clusters}): a green line makes 0.28/s`)
})

test("B20: a build escalates after N leftover-ghost rounds that placed nothing; progress resets the count", () => {
  let stuck: number | undefined = undefined
  let last: number | undefined = undefined
  const seq = [5, 5, 5, 4, 4, 4, 4]
  const out: string[] = []
  for (const left of seq) {
    const r = stuckRounds(stuck, last, left, 3)
    stuck = r.stuck
    last = left
    out.push(r.escalate ? "E" : tostring(r.stuck))
  }
  eq(out.join(","), "0,1,2,0,1,2,E", "rounds 2-3 stuck, progress at 4 resets, escalates at the third stuck round")
  eq(stuckRounds(100, 1, 1, 0).escalate, false, "0 = never")
})

run("design")
