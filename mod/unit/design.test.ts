import { generate, GeneratorName } from "../src/modules/generators"
import { ModuleDef } from "../src/modules/types"
import { beltTiers } from "../src/planner/capacity"
import { addNode, LogicalGraph, newGraph } from "../src/planner/logical"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { design, DesignContext, DesignNode, diffDesign, generatorFor, goalsFrom, isPowerRole } from "../src/strategy/design"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: the factory design (module selection and sizing from the solver), the goal diff against the logical graph, and
// the D24 overflow remedies (SPEC §5.5, §5.8).

const RED = "automation-science-pack"

function ctx(changes: Partial<DesignContext> = {}, policy: Partial<LayoutPolicy> = {}): DesignContext {
  return {
    facts: F,
    make: (gen: GeneratorName, params: Record<string, unknown>) => generate(F, gen, params),
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
  ok(byRole(split.nodes, "labs#1") !== undefined && byRole(split.nodes, "labs#2") !== undefined, "two lab arrays")
  for (const e of split.edges) ok(e.rate <= 0.3 + 1e-9, `edge ${e.role} ${e.rate}/s fits after the split`)
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

run("design")
