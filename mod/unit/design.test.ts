import { generate, GeneratorName } from "../src/modules/generators"
import { ModuleDef, Port } from "../src/modules/types"
import { rateOf } from "../src/modules/rates"
import { moduleId } from "../src/shared/ids"
import { beltTiers } from "../src/planner/capacity"
import { addEdge, addNode, connectModule, designGraphKey, LogicalGraph, newGraph, spareCapacity } from "../src/planner/logical"
import { newLayout } from "../src/planner/layout"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { BUILD_STOCK_MIN, buildMaterials, buildStock, checkEdges, design, DesignContext, DesignEdge, DesignNode, diffDesign, generatorFor, goalsFrom, isOilComplexRole, mergeSharedEdges, powerStock, producerFor, robotStock, stockRole, stuckRounds } from "../src/strategy/design"
import { sharing, spareForNode } from "../src/strategy/stage"
import { rolePower as isPowerRole } from "../src/strategy/node-facts"
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

/** After `electric-mining-drill` is researched (D54: the steam block gets its coal from an electric mine only then). */
const ELECTRIC = { "iron-plate": true, "copper-plate": true, "iron-gear-wheel": true, "transport-belt": true, "electric-mining-drill": true }

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

test("10 red/min to labs: 4 labs, a red line, two smelters fed by ore and coal outposts, a hand-fed steam block", () => {
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
  // D54: before electric drills the crew hand-feeds the boilers: no burner coal mine, no belt to the steam block.
  eq(byRole(d.nodes, "coal>power"), undefined, "no coal supply for the steam block yet")
  eq(d.nodes.length, 9, `9 modules: ${d.nodes.map((n) => `${n.role}:${n.generator}`).join(" | ")}`)
  eq(d.edges.length, 7, "7 flows")
  // The plate flows agree with the solver: 1/3 Fe/s and 1/6 Cu/s for 10 red/min.
  for (const e of d.edges) {
    if (e.to === `${RED}>labs` && e.item === "iron-plate") near(e.rate, 1 / 3, 1e-9, "iron plate flow")
    if (e.to === `${RED}>labs` && e.item === "copper-plate") near(e.rate, 1 / 6, 1e-9, "copper plate flow")
    eq(e.decision.action, "none", `edge ${e.role} fits a yellow belt`)
  }
  near(d.solve.items["iron-plate"].produced, 1 / 3, 1e-9, "solver iron")
  ok(d.techs.indexOf("automation") >= 0, "needs automation")
})

test("D51: of the assembler rows only gear rows carry a buffer (M7c.8: a pack row's buffer swallowed its packs)", () => {
  for (const item of ["iron-gear-wheel", "pipe"]) {
    const d = design(ctx({ buffer: "iron-chest", enabled: { ...ELECTRIC, pipe: true } }), { item, perSecond: 1 })
    eq(d.errors.length, 0, d.errors.join("; "))
    const row = byRole(d.nodes, `${item}>labs`)
    ok(row !== undefined && row.generator === "assembler-row", `${item}: ${d.nodes.map((n) => `${n.role}:${n.generator}`).join(" | ")}`)
    eq(row!.params.buffer, item === "iron-gear-wheel" ? "iron-chest" : "", `${item} row buffer`)
  }
})

test("M7c.8 (user, 2026-11-02): rows of the listed products get a buffer depot: engine units for pumps", () => {
  const blue = ctx({
    buffer: "iron-chest",
    bufferRows: ["iron-gear-wheel", "engine-unit"],
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  })
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const engine = d.nodes.find((n) => n.item === "engine-unit")!
  eq(engine.params.buffer, "iron-chest", "the engine row has a buffer")
  const pack = d.nodes.find((n) => n.item === "chemical-science-pack")!
  eq(pack.params.buffer, "", "the pack row has none")
})

test("M7d.5: from the first blue stage on, a furnace stack is planned at its maximum size", () => {
  const d = design(ctx({ maxSmelters: true }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  for (const role of [`iron-plate>${RED}>labs`, `copper-plate>${RED}>labs`]) {
    const smelter = byRole(d.nodes, role)!
    eq(smelter.params.furnaces, 24, `${role} is a full 24-furnace stack`)
  }
  // The rule is size-only: a small need still plans one stack, and the stage target never asks for a second one.
  eq(d.nodes.filter((n) => n.generator === "smelter-column").length, 2, "one iron and one copper stack")
})

test("B175 (user, 2026-11-09): the maximum stack size is for ore smelters only; steel is sized to its need", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true }
  const base = { enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] }
  const steelOf = (d: ReturnType<typeof design>): DesignNode => d.nodes.find((n) => n.generator === "smelter-column" && n.item === "steel-plate")!
  const sized = design(ctx(base), { item: "chemical-science-pack", perSecond: 10 / 60 })
  const maxed = design(ctx({ ...base, maxSmelters: true }), { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(maxed.errors.length, 0, maxed.errors.join("; "))
  eq(steelOf(maxed).params.furnaces, steelOf(sized).params.furnaces, "the steel stack keeps its needed size")
  const iron = maxed.nodes.find((n) => n.generator === "smelter-column" && n.item === "iron-plate")!
  eq(iron.params.furnaces, 24, "an ore stack is still a full 24-furnace stack")
})

test("D54: once electric drills are researched the steam block's coal comes from an electric mine", () => {
  const d = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const steamCoal = byRole(d.nodes, "coal>power")!
  eq(steamCoal.params.drill, "electric-mining-drill", "electric drills")
  ok(d.edges.some((e) => e.from === "coal>power" && e.to === "power"), "a belt to the steam block")
  // A built steam block without its coal: the diff plans the mine and its belt as a power goal.
  const g = graphWith(d, ["power", "labs"])
  const goals = goalsFrom(diffDesign(d, g, () => undefined), {})
  eq(goals[0].kind, "power", "a power goal first")
  eq(goals[0].nodes.map((n) => n.role).join(","), "coal>power", "for the coal mine")
  eq(goals[0].edges.length, 1, "and its belt")
})

test("B60 provider groups: an unexpandable fuel provider keeps its capacity and a parallel provider merges the residual", () => {
  const d = design(ctx({
    enabled: ELECTRIC,
    providerShort: { "coal>power": true },
    providerCaps: { "coal>power": 0.05 },
  }), { item: RED, perSecond: 1 })
  const old = byRole(d.nodes, "coal>power")!
  const parallel = byRole(d.nodes, "coal>power~2")!
  ok(old !== undefined && parallel !== undefined, `the old provider and a parallel provider: ${d.nodes.map((n) => `${n.role}=${n.need}`).join(",")}`)
  near(old.capacity, 0.05, 1e-9, "the old provider keeps exactly its real capacity")
  ok(old.need <= 0.05 + 1e-9, "the old provider is not asked to grow")
  ok(parallel.need > 0, "the parallel provider carries the residual")
  let merged = 0
  for (const e of d.edges) {
    if (e.from !== "coal>power~2" || e.to !== "power") continue
    eq(e.merge, true, "the residual merges into the existing power input")
    merged++
  }
  eq(merged, 1, "one merge edge")
  const g = graphWith(d, ["power", "labs", "coal>power"], { "coal>power": 0.05 })
  const diff = diffDesign(d, g, () => undefined)
  for (const gr of diff.grow) ok(gr.role !== "coal>power", "the unexpandable provider is never asked to grow")
  ok(diff.missing.some((n) => n.role === "coal>power~2"), "the parallel provider is missing and can be scheduled")
})

test("B97: a built parallel provider whose group lost its first member keeps its consumer (Built first, user 2026-10-29)", () => {
  // Sweep 3e1c4d7 seed 7625436: the first iron smelter of a group was deconstructed; the design planned one new provider
  // under the base role for everything, and the built `~2` dropped out of the design and starved (nothing planned its
  // ore) for 300 game-min.
  const d = design(ctx({
    enabled: ELECTRIC,
    providerCaps: { "coal>power~2": 0.05 },
    providerFeeds: { "coal>power~2": { "power.in-fuel": true } },
  }), { item: RED, perSecond: 1 })
  const kept = byRole(d.nodes, "coal>power~2")
  ok(kept !== undefined, `the built provider stays in the design: ${d.nodes.map((n) => n.role).join(",")}`)
  near(kept!.capacity, 0.05, 1e-9, "at its real capacity")
  ok(kept!.need <= 0.05 + 1e-9, "not asked to grow")
  ok(d.edges.some((e) => e.from === "coal>power~2" && e.to === "power"), "it keeps feeding the steam block")
  const rest = byRole(d.nodes, "coal>power")
  ok(rest !== undefined && rest.need > 0, "the rest goes to a new provider")
  ok(d.edges.some((e) => e.from === "coal>power" && e.to === "power" && e.merge === true), "which joins the kept belt")
})

test("B97: on the sharing path too, a built provider feeding the shared role's consumers keeps them first", () => {
  // Sweep 3e1c4d7 seed 7625436: the iron group was planned as a shared role (~3) for all three consumers, and the
  // built ~2 that fed the same ports dropped out of the design.
  const probe = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 1 })
  const ironEdge = probe.edges.find((e) => e.item === "iron-plate" && e.to === `${RED}>labs`)!
  const port = `${ironEdge.to}.${ironEdge.toPort}`
  const shared = "iron-plate>shared~3"
  const d = design(ctx({
    enabled: ELECTRIC,
    sharing: { keep: { [`iron-plate@${ironEdge.to}`]: shared }, spare: {} },
    providerCaps: { "iron-plate>shared~2": 0.05, [shared]: 5 },
    providerFeeds: { "iron-plate>shared~2": { [port]: true }, [shared]: { [port]: true } },
  }), { item: RED, perSecond: 1 })
  const kept = byRole(d.nodes, "iron-plate>shared~2")
  ok(kept !== undefined, `the built ~2 stays in the design: ${d.nodes.filter((n) => n.item === "iron-plate").map((n) => `${n.role}=${n.need}`).join(",")}`)
  near(kept!.capacity, 0.05, 1e-9, "at its real capacity")
  ok(d.edges.some((e) => e.from === "iron-plate>shared~2" && `${e.to}.${e.toPort}` === port), "it keeps feeding its consumer")
})

test("B71: a port that takes no merge stays whole on its short provider (no residual edge)", () => {
  // Soak vps-b69 seed 7718665: the residual merge into the mall's iron input had no side-load spot; 8 plans failed.
  const d = design(ctx({
    enabled: ELECTRIC,
    providerShort: { "coal>power": true },
    providerCaps: { "coal>power": 0.05 },
    noMerge: { "power.in-fuel": true },
  }), { item: RED, perSecond: 1 })
  ok(byRole(d.nodes, "coal>power") !== undefined, "the old provider stays")
  ok(!d.edges.some((e) => e.to === "power" && e.merge === true), `no merge edge into the power input: ${d.edges.filter((e) => e.to === "power").map((e) => e.from).join(",")}`)
  eq(d.errors.length, 0, d.errors.join("; "))
})

test("B72: a provider role marked ownSite asks for a new site (the plan does not fold it into a shared mine)", () => {
  // Soak vps-d67 seed 7718665: labs#3's copper mine completed a built whole-patch mine whose output was boxed in.
  const before = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 1 })
  const mine = before.nodes.find((n) => n.item === "copper-ore")!
  ok(mine !== undefined && mine.newSite === undefined, "a copper mine, free to share a patch")
  const after = design(ctx({ enabled: ELECTRIC, ownSite: { [mine.role]: true } }), { item: RED, perSecond: 1 })
  eq(byRole(after.nodes, mine.role)?.newSite, true, "the marked role needs its own site")
  ok(after.nodes.every((n) => n.role === mine.role || n.newSite === undefined), "no other provider is marked")
})

test("B60 provider groups: a short parallel provider gets its own next role without crashing", () => {
  const d = design(ctx({
    enabled: ELECTRIC,
    providerShort: { "coal>power": true, "coal>power~2": true },
    providerCaps: { "coal>power": 0.001, "coal>power~2": 0.001 },
  }), { item: RED, perSecond: 1 })
  ok(byRole(d.nodes, "coal>power") !== undefined, "first provider")
  ok(byRole(d.nodes, "coal>power~2") !== undefined, "second provider")
  ok(byRole(d.nodes, "coal>power~3") !== undefined, `third provider: ${d.nodes.map((n) => `${n.role}=${n.need}`).join(",")}`)
})

test("B66: steam blocks that cannot grow keep their capacity and the excess goes to the next steam block", () => {
  const one = design(ctx({ enabled: ELECTRIC, powerCaps: [{ role: "power", capacity: 1e5 }] }), { item: RED, perSecond: 1 })
  const second = byRole(one.nodes, "power#2")!
  ok(second !== undefined && second.need > 0, `power#2 takes the excess: ${one.nodes.map((n) => `${n.role}=${n.need}`).join(",")}`)
  eq(byRole(one.nodes, "power#3"), undefined, "no third block while power#2 can still grow")

  const two = design(ctx({ enabled: ELECTRIC, powerCaps: [{ role: "power", capacity: 1e5 }, { role: "power#2", capacity: 1e5 }] }), { item: RED, perSecond: 1 })
  const capped = byRole(two.nodes, "power#2")!
  const third = byRole(two.nodes, "power#3")!
  ok(third !== undefined, `power#3 once power#2 cannot grow either: ${two.nodes.map((n) => `${n.role}=${n.need}`).join(",")}`)
  near(capped.capacity, 1e5, 1e-6, "power#2 keeps exactly its real capacity")
  ok(capped.need <= 1e5 + 1e-6, "power#2 is not asked to grow")
  near(1e5 + capped.need + third.need, second.need + 1e5, 1, "the blocks together carry the same excess")
  ok(two.edges.some((e) => e.to === "power#3" && e.item === "coal"), "the third block gets coal")
})

test("B200: a capped steam block is not asked for the excess the next block carries (steam mode)", () => {
  const d = design(ctx({ enabled: ELECTRIC, powerCaps: [{ role: "power", capacity: 1e5 }] }), { item: RED, perSecond: 1 })
  const main = byRole(d.nodes, "power")!
  const second = byRole(d.nodes, "power#2")!
  ok(main.need <= 1e5 + 1e-6, `power stays at its real capacity: ${main.need}`)
  let pooled = 0
  for (const n of d.nodes) if (n.kind === "power") pooled += n.need
  ok(math.abs(pooled - (1e5 + second.need)) < 1, `the pool asks for the load once: ${pooled}`)
})

test("B184 (user, 2026-11-11): a steam block that found no shore is planned inland, its water from a water pump", () => {
  const caps = [{ role: "power", capacity: 1e5 }]
  const d = design(ctx({ enabled: ELECTRIC, powerCaps: caps, inlandPower: { "power#2": true } }), { item: RED, perSecond: 1 })
  const inland = byRole(d.nodes, "power#2")!
  eq(inland.params.water, "pipe", "power#2 is the inland variant")
  eq(inland.def.site, undefined, "it needs no shore")
  ok(inland.capacity > 0, "it makes power without a pump of its own")
  const water = d.edges.find((e) => e.to === "power#2" && e.item === "water")
  ok(water !== undefined && water.rate > 0, `a water edge feeds it: ${d.edges.map((e) => `${e.from}->${e.to}:${e.item}`).join(",")}`)
  eq(byRole(d.nodes, water!.from)?.generator, "water-pump", "from a water pump")
  ok(d.edges.some((e) => e.to === "power#2" && e.item === "coal"), "it still gets coal")
  eq(byRole(d.nodes, "power")?.params.water, undefined, "the shore block is unchanged")
})

test("B184: the inland steam block's water input matches its steam", () => {
  const shore = generate(F, "steam-block", { boilers: 2 })
  const inland = generate(F, "steam-block", { boilers: 2, water: "pipe" })
  near(rateOf(inland.rates.outputs, "electricity"), rateOf(shore.rates.outputs, "electricity"), 1e-6, "the same power")
  ok(rateOf(inland.rates.inputs, "water") > 0, "it takes water")
  eq(inland.ports.find((p) => p.id === "in-water")?.kind, "pipe-in", "through a pipe port")
  eq(inland.entities.some((e) => e.name === "offshore-pump"), false, "no offshore pump")
})

test("B185: a solar field unit sustains its panels' daily average, carried through the night by its accumulators", () => {
  const one = generate(F, "solar-field", { units: 1 })
  // 6 panels × 60 kW × 0.7 = 252 kW by day on average; 5 × 5 MJ carry 5 × 50 kW = 250 kW through a Nauvis night.
  near(rateOf(one.rates.outputs, "electricity"), 250000, 1, "the accumulators bound it")
  eq(rateOf(one.rates.inputs, "electricity"), 0, "the accumulators' charging is no demand")
  eq(one.site, undefined, "no site")
  const two = generate(F, "solar-field", { units: 2 })
  near(rateOf(two.rates.outputs, "electricity"), 500000, 1, "units add up")
  ok(one.requiresTech.indexOf("solar-energy") >= 0 && one.requiresTech.indexOf("electric-energy-accumulators") >= 0, `needs both techs: ${one.requiresTech.join(",")}`)
})

/** B194: solar fields machines can make: their recipes, plus the battery chain (advanced oil, crude) and 3-input rows. */
const OIL_CHAIN: Partial<DesignContext> = {
  enabled: { ...ELECTRIC, "solar-panel": true, accumulator: true, "medium-electric-pole": true, "iron-stick": true, "steel-plate": true, "plastic-bar": true, sulfur: true, "basic-oil-processing": true, "advanced-oil-processing": true, "sulfuric-acid": true, battery: true },
  resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
  rowInputs: 3,
}

test("B185 (user, 2026-11-11): in solar mode built steam blocks keep their capacity and the rest of the power is solar", () => {
  const caps = [{ role: "power", capacity: 1e5 }]
  const d = design(ctx({ ...OIL_CHAIN, powerCaps: caps, solarPower: true }), { item: RED, perSecond: 1 })
  const steam = byRole(d.nodes, "power")!
  ok(steam.need <= 1e5 + 1e-6, `the built block is not asked to grow: ${steam.need}`)
  const solar = d.nodes.filter((n) => n.generator === "solar-field")
  ok(solar.length >= 1, `a solar field: ${d.nodes.map((n) => `${n.role}:${n.generator}`).join(",")}`)
  eq(solar[0].role, "power#2", "as the next power role")
  eq(d.nodes.some((n) => n.role !== "power" && n.generator === "steam-block"), false, "no new steam block")
  eq(d.edges.some((e) => solar.some((n) => n.role === e.to)), false, "nothing feeds a solar field")
  let total = 0
  for (const n of d.nodes) if (n.kind === "power") total += math.min(n.need, n.capacity)
  ok(total + 1 >= d.electricW, `the power roles carry the demand: ${total} of ${d.electricW}`)
  ok(d.techs.indexOf("solar-energy") >= 0, "solar research comes with it")
})

/** Electric mining and every solar-field building's recipe. */
const SOLAR = { ...ELECTRIC, "solar-panel": true, accumulator: true, "medium-electric-pole": true, "iron-stick": true }

test("B185 (user, 2026-11-11) / B194: the factory makes and stocks every solar-field building machines can make", () => {
  const all = (): boolean => true
  // B194: accumulators only with a battery chain (oil); medium poles (user, 2026-11-12), not wooden small ones.
  eq(powerStock(ctx({ ...OIL_CHAIN, solarPower: true }), all).map((s) => s.item).join(","), "accumulator,medium-electric-pole,solar-panel", "panels, accumulators and poles")
  eq(powerStock(ctx({ ...OIL_CHAIN, solarPower: true }), (r) => r !== "accumulator").map((s) => s.item).join(","), "medium-electric-pole,solar-panel", "each once its recipe is enabled")
  eq(powerStock(ctx({ solarPower: true, rowInputs: 3 }), all).map((s) => s.item).join(","), "medium-electric-pole,solar-panel", "no batteries without oil: no accumulator row")
})

test("B194: forced solar that machines can't build yet (no battery chain) stays steam, at the steam-mode caps", () => {
  const d = design(ctx({ enabled: SOLAR, powerCaps: [{ role: "power", capacity: 1e4 }], steamCaps: [{ role: "power", capacity: 1e5 }], solarPower: true }), { item: RED, perSecond: 1 })
  eq(d.nodes.some((n) => n.generator === "solar-field"), false, `no solar field: ${d.nodes.map((n) => `${n.role}:${n.generator}`).join(",")}`)
  eq(d.nodes.some((n) => string.sub(n.role, 1, 6) === "stock:"), false, "no stock rows")
  eq(byRole(d.nodes, "power#2")?.generator, "steam-block", "a steam block for the rest")
  const extra = byRole(d.nodes, "power#2")!.need
  ok(math.abs(extra - (d.electricW - 1e5)) < 1, `power#2 takes the rest past the steam-mode cap: ${extra} of ${d.electricW}`)
})

test("B185 (user, 2026-11-11): a design with a solar field adds machine-made stock rows for its buildings", () => {
  const d = design(ctx({ ...OIL_CHAIN, powerCaps: [{ role: "power", capacity: 1e5 }], solarPower: true }), { item: RED, perSecond: 1 })
  const rows = d.nodes.filter((n) => string.sub(n.role, 1, 6) === "stock:").map((n) => n.role)
  rows.sort()
  eq(rows.join(","), "stock:accumulator,stock:medium-electric-pole,stock:solar-panel", "one stock row per building of a field")
  const plain = design(ctx({ ...OIL_CHAIN }), { item: RED, perSecond: 1 })
  eq(plain.nodes.some((n) => string.sub(n.role, 1, 6) === "stock:"), false, "no solar field, no stock rows")
})

test("B185 (user, 2026-11-11): new power is solar only when it builds faster than a coal mine and a belt back", () => {
  const caps = [{ role: "power", capacity: 1e5 }]
  const gen = (c: Partial<DesignContext>): string => {
    const d = design(ctx({ ...OIL_CHAIN, powerCaps: caps, ...c }), { item: RED, perSecond: 1 })
    return byRole(d.nodes, "power#2")?.generator ?? "none"
  }
  eq(gen({ coalDistance: 30 }), "steam-block", "a coal patch 30 tiles away: steam")
  eq(gen({ coalDistance: 5000 }), "solar-field", "the nearest free coal 5000 tiles away: solar")
  eq(gen({ coalDistance: math.huge }), "solar-field", "no free coal known: solar")
  eq(gen({}), "steam-block", "not compared without a coal distance")
  const locked = design(ctx({ enabled: ELECTRIC, powerCaps: caps, coalDistance: 5000 }), { item: RED, perSecond: 1 })
  eq(byRole(locked.nodes, "power#2")?.generator, "steam-block", "solar recipes not enabled: steam")
})

test("D65: a module's power demand scales with its utilization, like its inputs", () => {
  const d = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 1 })
  let checked = 0
  for (const n of d.nodes) {
    if (n.kind === "power" || n.kind === "labs" || n.capacity <= 0) continue
    let nameplate = 0
    for (const r of n.def.rates.inputs) if (r.kind === "power" || r.item === "electricity") nameplate += r.perSecond
    if (nameplate <= 0) continue
    near(n.powerW, nameplate * math.min(1, n.need / n.capacity), 1e-6, `${n.role}: ${n.powerW} W of ${nameplate} at ${n.need}/${n.capacity}`)
    if (n.need < n.capacity - 1e-9) checked++
  }
  ok(checked > 0, "at least one module runs below its capacity")
})

test("B61 provider groups: a shared provider that cannot reach all consumers gets one parallel provider per consumer", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>test", [`coal@${SMELT_CU}`]: "coal*>test" }
  const c = ctx({
    enabled: ELECTRIC,
    sharing: { keep, spare: { coal: { "coal*>test": 100 } }, split: { "coal*>test": true } },
  })
  const d = design(c, { item: RED, perSecond: 1 })
  const split = d.nodes.filter((n) => n.role === "coal*>test~2" || n.role === "coal*>test~3")
  eq(split.length, 2, `two parallel providers: ${d.nodes.map((n) => n.role).join(",")}`)
  let coalEdges = 0
  for (const e of d.edges) if (e.from === "coal*>test~2" || e.from === "coal*>test~3") coalEdges++
  eq(coalEdges, 2, "one consumer feed per parallel provider")
  ok(byRole(d.nodes, "coal*>test") === undefined, "the infeasible shared group itself is not planned")
})

test("B61 provider groups: a fresh shared group marked split also gets one provider per consumer", () => {
  const role = `coal*>${SMELT_FE}`
  const d = design(ctx({
    enabled: ELECTRIC,
    sharing: { keep: {}, spare: {}, split: { [role]: true } },
  }), { item: RED, perSecond: 1 })
  const split = d.nodes.filter((n) => n.role === `${role}~2` || n.role === `${role}~3`)
  eq(split.length, 2, `two parallel fresh providers: ${d.nodes.map((n) => n.role).join(",")}`)
  ok(byRole(d.nodes, role) === undefined, "the fresh shared group is not planned as one node")
})

test("B61 provider groups: an exact failed feed is not kept; another consumer gets its own provider", () => {
  const d = design(ctx({
    enabled: ELECTRIC,
    sharing: {
      keep: { [`coal@${SMELT_FE}@in-fuel`]: "coal>old" },
      spare: {},
    },
  }), { item: RED, perSecond: 1 })
  ok(byRole(d.nodes, "coal>old") !== undefined, "the exact kept feed")
  ok(byRole(d.nodes, `coal>${SMELT_CU}`) !== undefined, "the unkept consumer gets its own provider")
})

test("B61 provider groups: a blocked exact feed overrides exact and legacy kept assignments", () => {
  const role = "coal>old"
  const d = design(ctx({
    enabled: ELECTRIC,
    sharing: {
      keep: {
        [`coal@${SMELT_FE}@in-fuel`]: role,
        [`coal@${SMELT_FE}`]: role,
        [`coal@${SMELT_CU}@in-fuel`]: role,
        [`coal@${SMELT_CU}`]: role,
      },
      spare: {},
      blocked: { [`${role}=>${SMELT_CU}.in-fuel`]: true },
    },
  }), { item: RED, perSecond: 1 })
  ok(byRole(d.nodes, role) !== undefined, "the provider keeps its feasible consumer")
  ok(byRole(d.nodes, `coal>${SMELT_CU}`) !== undefined, "the blocked consumer gets a separate provider")
  for (const e of d.edges) ok(!(e.from === role && e.to === SMELT_CU), "the blocked feed is absent")
})

test("B61 provider groups: splitting a cluster-suffixed role does not reuse that role", () => {
  const role = "coal*>test#3"
  const oldParallel = "coal*>test#2"
  const d = design(ctx({
    enabled: ELECTRIC,
    providerCaps: { [oldParallel]: 1, [role]: 1 },
    sharing: {
      keep: { [`coal@${SMELT_FE}@in-fuel`]: role, [`coal@${SMELT_CU}@in-fuel`]: role },
      spare: {},
      split: { [role]: true },
    },
  }), { item: RED, perSecond: 1 })
  ok(byRole(d.nodes, role) === undefined, `the infeasible role is not reused: ${d.nodes.map((n) => n.role).join(",")}`)
  ok(byRole(d.nodes, oldParallel) === undefined, `another built parallel role is not reused: ${d.nodes.map((n) => n.role).join(",")}`)
  let split = 0
  for (const n of d.nodes) if (string.find(n.role, `${role}~`, 1, true)[0] === 1) split++
  eq(split, 2, `two fresh parallel roles: ${d.nodes.map((n) => n.role).join(",")}`)
  ok(byRole(d.nodes, `${role}~2`) !== undefined && byRole(d.nodes, `${role}~3`) !== undefined, "the next two fresh suffixes (B68: ~N, never a #N cluster suffix)")
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
      id: moduleId(`n${g.nextId++}`),
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

test("goal diff: from nothing, power first (the steam block, hand-fed), then labs, then the production chain", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const diff = diffDesign(d, newGraph(), () => undefined)
  eq(diff.missing.length, 9, "all missing")
  const goals = goalsFrom(diff, {})
  eq(goals.map((gs) => gs.kind).join(","), "power,labs,production", "order")
  eq(goals[0].nodes.map((n) => n.role).sort().join(","), "power", "power goal (D54: no coal mine yet)")
  eq(goals[0].edges.length, 0, "no coal belt")
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

test("M7d.5 (user): power is one pool, so a short cluster block does not grow while the pool covers the need", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const first = byRole(d.nodes, "power")!
  d.nodes.push({ ...first, role: "power#2", need: 30e6, capacity: 10e6, powerW: 10e6 })
  const roles = d.nodes.map((n) => n.role)
  const caps: Record<string, number> = {}
  for (const n of d.nodes) caps[n.role] = n.capacity
  caps.power = 40e6
  caps["power#2"] = 10e6
  // Cluster 3's own block is short (30 MW > 10 MW), but the installed pool (40 + 10) covers the total need.
  const diff = diffDesign(d, graphWith(d, roles, caps), () => undefined)
  for (const gr of diff.grow) ok(gr.role !== "power#2", "the short per-cluster block is not grown while the pool covers it")
  // When the pool itself is short, a short power block still gets its grow goal.
  caps.power = 10e6
  const short = diffDesign(d, graphWith(d, roles, caps), () => undefined)
  ok(short.grow.some((gr) => gr.role === "power#2"), "a real pool shortfall still grows a power block")
})

test("goal diff: a built mall (a sink planned at a utilization, no output rate) is never a growth (M6a.2)", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const base = d.nodes[0]
  d.nodes.push({ ...base, role: "mall", kind: "sink", item: "mall", need: 0.25, capacity: 1, inputs: [] })
  const roles: string[] = []
  for (const n of d.nodes) roles.push(n.role)
  const diff = diffDesign(d, graphWith(d, roles, { mall: 0 }), () => undefined)
  for (const gr of diff.grow) ok(gr.role !== "mall", "the mall does not grow")
  for (const n of diff.missing) ok(n.role !== "mall", "and is not missing")
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

test("B189: a node shared by cluster walks has one edge per role, at the summed rate", () => {
  // The robot chain's circuit row serves the stock rows of every walk (6 repeated edges before the fix).
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true, "flying-robot-frame": true, "construction-robot": true, roboport: true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const stock = robotStock((t) => t === "construction-robotics", (r) => enabled[r as keyof typeof enabled] === true)
  {
    const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60, stock })
    const seen: Record<string, boolean> = {}
    const dups: string[] = []
    for (const e of d.edges) {
      if (seen[e.role]) dups.push(e.role)
      seen[e.role] = true
    }
    eq(dups.length, 0, `no repeated edge: ${dups.slice(0, 2).join(", ")}`)
  }
})

test("B189: mergeSharedEdges adds the copies' rates and keeps a copy's faster belt", () => {
  const base = { item: "iron-plate", from: "a", fromPort: "out", to: "b", toPort: "in", belt: "transport-belt" }
  const edges: DesignEdge[] = [
    { ...base, role: "a=>b.in", rate: 1, headroomRate: 2, decision: { action: "none" } },
    { ...base, role: "c=>b.in", rate: 3, headroomRate: 6, decision: { action: "none" } },
    { ...base, role: "a=>b.in", rate: 2, headroomRate: 4, belt: "fast-transport-belt", decision: { action: "upgrade-tier", belt: "fast-transport-belt", usable: 30 } },
  ]
  mergeSharedEdges(edges)
  eq(edges.length, 2, "one edge per role")
  eq(edges[0].rate, 3, "rates add")
  eq(edges[0].headroomRate, 6, "headroom rates add")
  eq(edges[0].belt, "fast-transport-belt", "the upgraded copy's belt")
  eq(edges[1].role, "c=>b.in", "order kept")
})

test("splitter-tap topology: one producer per item, sized for every consumer", () => {
  const d = design(ctx({ enabled: ELECTRIC }, { topology: "splitter-tap" }), { item: RED, perSecond: 10 / 60 })
  let coal = 0
  for (const n of d.nodes) if (n.item === "coal") coal++
  eq(coal, 1, "one coal outpost")
  let coalEdges = 0
  for (const e of d.edges) if (e.item === "coal") coalEdges++
  eq(coalEdges, 3, "feeding both smelters and the steam block")
})

test("B2: recorded splitter taps: one coal producer feeds both smelters; the power node keeps its own coal", () => {
  const d = design(ctx({ enabled: ELECTRIC, taps: { coal: [SMELT_FE, SMELT_CU] } }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = byRole(d.nodes, "coal")
  ok(coal !== undefined, "one shared coal producer")
  eq(byRole(d.nodes, `coal>${SMELT_FE}`), undefined, "no point-to-point coal for the iron smelter")
  eq(byRole(d.nodes, `coal>${SMELT_CU}`), undefined, "nor for the copper smelter")
  ok(byRole(d.nodes, "coal>power") !== undefined, "power keeps its own fuel producer")
  let edges = 0
  for (const e of d.edges) if (e.from === "coal") edges++
  eq(edges, 2, "two edges from the shared producer")
  const p2p = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 10 / 60 })
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
  return ctx({ curated: { [GREEN]: GREEN_ID }, researchUnitTime: 30, make, enabled: ELECTRIC, ...changes })
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
  const s0 = design(ctx({ enabled: ELECTRIC }), { item: RED, perSecond: 10 / 60 })
  const powerCoal = byRole(s0.nodes, "coal>power")!
  const keep = { "coal@power": "coal>power" }
  let used = 0
  for (const e of s0.edges) if (e.from === "coal>power") used += e.rate
  const room = powerCoal.capacity - used
  ok(room > 0.1, `the steam block's coal outpost has room (${room}/s)`)
  const d = design(ctx({ enabled: ELECTRIC, sharing: { keep, spare: { coal: { "coal>power": room } } } }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = d.nodes.filter((n) => n.item === "coal")
  eq(coal.length, 1, `one coal producer: ${coal.map((n) => n.role).join(" | ")}`)
  eq(coal[0].role, "coal>power", "the steam block's")
  const fed = d.edges.filter((e) => e.from === "coal>power").map((e) => e.to).sort()
  eq(fed.join(","), [SMELT_CU, SMELT_FE, "power"].sort().join(","), "feeds both smelters and the steam block")
  near(coal[0].need, used + d.edges.filter((e) => e.from === "coal>power" && e.to !== "power").reduce((a, e) => a + e.rate, 0), 1e-9, "sized for all three")
  // Without room the smelters share one new outpost: 2 mines instead of 3.
  const tight = design(ctx({ enabled: ELECTRIC, sharing: { keep, spare: {} } }), { item: RED, perSecond: 10 / 60 })
  eq(tight.nodes.filter((n) => n.item === "coal").length, 2, "power's own + one shared")
})

test("M7d.5: a pumpjack field's spare is its well capacity, not its planned draw", () => {
  // Measured on seed 11: 15 pumpjacks made ~210 crude/s while the six crude edges planned 42/s. Using `planned` made the
  // field look full and the design added another field for demand that did not exist.
  const node = {
    role: "crude-oil*>oil-complex",
    item: "crude-oil",
    generator: "pumpjack-field",
    capacity: { inputs: [], outputs: [{ item: "crude-oil", perSecond: 210 }] },
    planned: { inputs: [], outputs: [{ item: "crude-oil", perSecond: 42 }] },
  }
  near(spareForNode(node as never, 42), 168, 1e-9, "rated capacity minus draw")
  near(spareForNode(node as never, 42, 180), 138, 1e-9, "a live potential overrides the plan-time rating")
  const smelter = { ...node, generator: "smelter-column" }
  near(spareForNode(smelter as never, 42), 0, 1e-9, "other providers keep the planned-output rule")
  const water = { ...node, item: "water", generator: "water-pump", capacity: { inputs: [], outputs: [{ item: "water", perSecond: 1200 }] }, planned: { inputs: [], outputs: [{ item: "water", perSecond: 60 }] } }
  near(spareForNode(water as never, 60), 1140, 1e-9, "a water pump's spare is its pump capacity")
})

test("M7d.5: a spare provider whose old consumer is not in this walk still takes a new consumer", () => {
  // The robot chain's new sulfur row needed water. A built water line with spare ran beside its port, but its old
  // consumer (an earlier sulfur row) was not part of the new goal, so `spare` was never offered and the design planned
  // a new water pump/line through the built block. Fresh demands now try every spare provider of the item.
  const d = design(ctx({ enabled: ELECTRIC, sharing: { keep: {}, spare: { coal: { "coal>power": 100 } } } }), { item: RED, perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = d.nodes.filter((n) => n.item === "coal")
  eq(coal.length, 1, `one coal provider: ${coal.map((n) => n.role).join(" | ")}`)
  eq(coal[0].role, "coal>power", "the spare built provider")
  ok(d.edges.filter((e) => e.from === "coal>power").length >= 3, "it feeds the power block and the smelters")
})

test("P36 (b): when a new coal outpost can't be placed, new consumers in every cluster tap the nearest built one, which grows", () => {
  const s1 = design(greenCtx({ researchUnitTime: 15 }), { item: RED, perSecond: 10 / 60 })
  const keep = keepOf(s1)
  const d = design(greenCtx({ sharing: { keep, spare: {}, fallback: { coal: ["coal>power", `coal>${SMELT_FE}`] } } }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  const coal = d.nodes.filter((n) => n.item === "coal")
  const roles = coal.map((n) => n.role).sort()
  for (const n of coal) ok(string.find(n.role, "coal*>", 1, true)[0] === undefined, `no new shared coal producer (${n.role})`)
  eq(coal.length, 3, `only the built ones: ${roles.join(" | ")}`)
  let seen = 0
  for (const n of d.nodes) if (n.role === "coal>power") seen++
  eq(seen, 1, "the tapped producer appears once (its per-cluster copies merged)")
  let fed = 0
  let into = 0
  let cluster2 = 0
  for (const e of d.edges) {
    if (e.from !== "coal>power") continue
    fed += e.rate
    into++
    if (string.find(e.to, "#2", 1, true)[0] !== undefined) cluster2++
  }
  ok(into >= 3 && cluster2 >= 1, `the steam block's outpost feeds the new consumers of both clusters (${into} edges, ${cluster2} in cluster 2)`)
  near(byRole(d.nodes, "coal>power")!.need, fed, 1e-6, "its need is every edge it feeds (the diff grows it)")
  // Unchanged without a fallback: new shared producers.
  const plain = design(greenCtx({ sharing: { keep, spare: {} } }), STAGE2)
  ok(plain.nodes.filter((n) => string.find(n.role, "coal*>", 1, true)[0] === 1).length >= 1, "without it, a new shared outpost")
})

test("M6: a steam block that can't grow gets a second one (power#2) for the excess, with its own coal", () => {
  const d0 = design(greenCtx(), STAGE2)
  const cap = 1.8e6
  ok(byRole(d0.nodes, "power")!.need > cap, "the design needs more than one boiler")
  const d = design(greenCtx({ powerCaps: [{ role: "power", capacity: cap }] }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  const p2 = byRole(d.nodes, "power#2")
  ok(p2 !== undefined, "second steam block")
  ok(p2!.capacity + 1e-6 >= byRole(d.nodes, "power")!.need - cap, `covers the excess (${p2!.capacity} W)`)
  ok(byRole(d.nodes, "coal>power#2") !== undefined, "its own coal")
  ok(isPowerRole("power#2") && isPowerRole("coal>power#2"), "power roles")
})

test("B68: a parallel fuel provider of power never shares a role with the coal supply of power#2", () => {
  // Seeds 5387208/8646103/7718665: parallelRole("coal>power") was "coal>power#2", the point-to-point role of power#2's
  // coal. The design merged the two into one node feeding both blocks, so the built parallel mine (which feeds power)
  // read as power#2's coal: "coal>power#2 short (2/3.33): cannot grow", and power#2 never got a coal belt of its own.
  const d = design(greenCtx({ powerCaps: [{ role: "power", capacity: 1.8e6 }], providerShort: { "coal>power": true }, providerCaps: { "coal>power": 0.05 } }), STAGE2)
  eq(d.errors.length, 0, d.errors.join("; "))
  ok(byRole(d.nodes, "power#2") !== undefined, "second steam block")
  const into: Record<string, string[]> = {}
  for (const e of d.edges) if (e.item === "coal" && isPowerRole(e.to) && string.match(e.to, "^power")[0] !== undefined) {
    into[e.from] ??= []
    into[e.from].push(e.to)
  }
  for (const [from, tos] of pairs(into)) ok((tos as string[]).length === 1, `${from as string} feeds one steam block: ${(tos as string[]).join(",")}`)
  ok(into["coal>power"] !== undefined, "the old provider feeds power")
  let parallel = 0
  let second = 0
  for (const [from, tos] of pairs(into)) {
    if (from === "coal>power") continue
    if ((tos as string[])[0] === "power") parallel++
    if ((tos as string[])[0] === "power#2") second++
  }
  ok(parallel >= 1, "a parallel provider feeds power")
  ok(second >= 1, "power#2 has its own coal")
  ok(isPowerRole("coal>power~2") && isPowerRole("coal>power#2~3"), "parallel fuel providers are power roles")
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

test("B77: the design cache key changes when a goal adds only connections (vps-b76-r4410923 g19 → g20)", () => {
  const d = design(ctx(), { item: RED, perSecond: 10 / 60 })
  const g = graphWith(d, d.nodes.map((n) => n.role))
  const e = d.edges[0]
  const before = designGraphKey(g)
  const from = g.nodeOrder.find((id) => g.nodes[id].role === e.from)!
  const to = g.nodeOrder.find((id) => g.nodes[id].role === e.to)!
  addEdge(g, { id: `flow:${e.role}`, role: e.role, kind: "belt", item: e.item, from: moduleId(from), fromPort: e.fromPort, to: moduleId(to), toPort: e.toPort, plannedRate: e.rate, physical: [] } as never)
  ok(designGraphKey(g) !== before, "a new edge changes the key")
  // The diff a stale key would have served lists the built edge as missing; the fresh one does not.
  const missing = diffDesign(d, g, () => undefined).missingEdges.map((x) => x.role)
  ok(missing.indexOf(e.role) < 0, "the built edge is not missing")
})

test("B78: a node folded into a shared mine connects through that mine's module (vps-b77a 2034469 n22 → n16)", () => {
  const g = newGraph()
  const node = (id: string, alias?: string) => addNode(g, { id: moduleId(id), role: id, kind: "outpost", item: "iron-ore", capacity: { inputs: [], outputs: [] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0, alias: alias !== undefined ? moduleId(alias) : undefined })
  node("n16")
  node("n22", "n16")
  node("n30")
  const layout: Record<string, boolean> = { n16: true }
  const has = (id: string): boolean => layout[id] === true
  eq(connectModule(g, "n22", has), "n16", "the alias's module")
  eq(connectModule(g, "n16", has), "n16", "a module of its own")
  eq(connectModule(g, "n30", has), undefined, "no module, no alias")
})

test("B80: a consumer moved whole to a parallel provider stays on its short provider when its port takes no merge (vps-b79-r1459426)", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>test", [`coal@${SMELT_CU}`]: "coal*>test" }
  const base = { enabled: ELECTRIC, sharing: { keep, spare: {} }, providerShort: { "coal*>test": true }, providerCaps: { "coal*>test": 0.001 } }
  const before = design(ctx(base), { item: RED, perSecond: 1 })
  // The short provider keeps a sliver; the consumer past its capacity moves whole to coal*>test~2 (no merge flag).
  const whole = before.edges.find((e) => e.from === "coal*>test~2" && e.merge !== true)
  ok(whole !== undefined, `a consumer moved whole: ${before.edges.filter((e) => e.item === "coal").map((e) => `${e.from}->${e.to}${e.merge ? " (merge)" : ""}`).join(", ")}`)
  const port = `${whole!.to}.${whole!.toPort}`
  const after = design(ctx({ ...base, noMerge: { [port]: true } }), { item: RED, perSecond: 1 })
  ok(!after.edges.some((e) => e.from === "coal*>test~2" && e.to === whole!.to), "no second feed into the no-merge port")
  ok(after.edges.some((e) => e.from === "coal*>test" && e.to === whole!.to), "its short provider keeps it whole")
  eq(after.errors.length, 0, after.errors.join("; "))
})

test("D68: a split coal group taps the fallback producer instead of one new mine per consumer (vps-b80d 1264816)", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>test", [`coal@${SMELT_CU}`]: "coal*>test" }
  const split = design(ctx({ enabled: ELECTRIC, sharing: { keep, spare: {}, split: { "coal*>test": true } } }), { item: RED, perSecond: 1 })
  ok(split.nodes.some((n) => n.role === "coal*>test~2"), "without a fallback: parallel providers")
  const d = design(ctx({ enabled: ELECTRIC, sharing: { keep, spare: {}, split: { "coal*>test": true }, fallback: { coal: ["coal>power"] } } }), { item: RED, perSecond: 1 })
  ok(!d.nodes.some((n) => string.find(n.role, "coal*>test", 1, true)[0] !== undefined), `no parallel coal providers: ${d.nodes.map((n) => n.role).join(",")}`)
  for (const smelter of [SMELT_FE, SMELT_CU]) ok(d.edges.some((e) => e.from === "coal>power" && e.to === smelter), `${smelter} taps coal>power`)
  eq(d.errors.length, 0, d.errors.join("; "))
})

test("D68: spare capacity is full-speed output minus the planned belt draw", () => {
  const g = newGraph()
  addNode(g, { id: moduleId("m"), role: "coal>power", kind: "outpost", item: "coal", capacity: { inputs: [], outputs: [{ item: "coal", perSecond: 1 }] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  addNode(g, { id: moduleId("p"), role: "power", kind: "power", item: "electricity", capacity: { inputs: [], outputs: [] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  addEdge(g, { id: "e", role: "coal>power=>power.in-fuel", kind: "belt", item: "coal", from: moduleId("m"), to: moduleId("p"), plannedRate: 0.189, physical: [] })
  near(spareCapacity(g, "m"), 0.811, 1e-9, "1 - 0.189")
})

test("M7c: spare capacity counts a consumer's measured draw when it is above the plan (user-approved 2026-11-01)", () => {
  const g = newGraph()
  addNode(g, { id: moduleId("m"), role: "coal>power", kind: "outpost", item: "coal", capacity: { inputs: [], outputs: [{ item: "coal", perSecond: 1 }] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  addNode(g, { id: moduleId("p"), role: "power", kind: "power", item: "electricity", capacity: { inputs: [], outputs: [] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  addEdge(g, { id: "e", role: "coal>power=>power.in-fuel", kind: "belt", item: "coal", from: moduleId("m"), to: moduleId("p"), plannedRate: 0.189, physical: [] })
  g.edges["e"].measuredRate = 0.9
  near(spareCapacity(g, "m"), 0.1, 1e-9, "1 - measured 0.9")
  g.edges["e"].measuredRate = 0.05
  near(spareCapacity(g, "m"), 0.811, 1e-9, "a draw below the plan still reserves the plan")
})

test("M7c: a kept consumer measured drawing more than planned sizes its provider for that draw (seed 11 iron columns)", () => {
  const s1 = design(greenCtx({ researchUnitTime: 15 }), { item: RED, perSecond: 10 / 60 })
  const fuel = s1.edges.find((e) => e.item === "coal" && e.to === SMELT_FE)!
  const keep = keepOf(s1)
  const planned = design(greenCtx({ sharing: { keep, spare: {} } }), STAGE2)
  const before = planned.edges.find((e) => e.item === "coal" && e.to === SMELT_FE)!
  const drawn = design(greenCtx({ sharing: { keep, spare: {}, draw: { [`coal@${SMELT_FE}@${fuel.toPort}`]: before.rate * 3 } } }), STAGE2)
  eq(drawn.errors.length, 0, drawn.errors.join("; "))
  const after = drawn.edges.find((e) => e.item === "coal" && e.to === SMELT_FE)!
  near(after.rate, before.rate * 3, 1e-9, "the demand counts the measured draw")
  const provider = byRole(drawn.nodes, after.from)!
  ok(provider.need + 1e-9 >= after.rate, `its provider ${after.from} is sized for it (${provider.need} >= ${after.rate})`)
})

test("B81: a retiring provider's replacement never shares the provider it replaces (newSite; vps-d68a 5480563 n18)", () => {
  const d = design(ctx({ enabled: ELECTRIC, retiring: { "coal>power": true } }), { item: RED, perSecond: 10 / 60 })
  const repl = d.nodes.find((n) => n.item === "coal" && n.role !== "coal>power" && d.edges.some((e) => e.from === n.role && e.to === "power"))
  ok(repl !== undefined, `a replacement for the steam block's coal: ${d.nodes.map((n) => n.role).join(",")}`)
  eq(repl!.newSite, true, "on a site of its own, never folded into the retiring mine")
  // Shared providers: the consumers of a retiring provider get a replacement group on a site of its own too.
  const keep = { [`coal@${SMELT_FE}`]: "coal*>old", [`coal@${SMELT_CU}`]: "coal*>old" }
  const g = design(ctx({ enabled: ELECTRIC, retiring: { "coal*>old": true }, sharing: { keep, spare: {} } }), { item: RED, perSecond: 1 })
  const group = g.nodes.filter((n) => n.item === "coal" && g.edges.some((e) => e.from === n.role && (e.to === SMELT_FE || e.to === SMELT_CU)))
  ok(group.length > 0, `a replacement group: ${g.nodes.map((n) => n.role).join(",")}`)
  for (const n of group) eq(n.newSite, true, `${n.role} on a site of its own`)
})

test("M7 (seed 11 g78): a retiring provider's replacement split per consumer still merges into the old belts", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>old", [`coal@${SMELT_CU}`]: "coal*>old" }
  // The heirs of a retiring provider form their own group (M7 B), a parallel role of the retiring one.
  const role = "coal*>old~2"
  const g = design(ctx({ enabled: ELECTRIC, retiring: { "coal*>old": true }, sharing: { keep, spare: {}, split: { [role]: true } } }), { item: RED, perSecond: 1 })
  const feeds = g.edges.filter((e) => e.item === "coal" && (e.to === SMELT_FE || e.to === SMELT_CU) && e.from !== "coal*>old")
  eq(feeds.length, 2, `one replacement feed per smelter: ${g.edges.filter((e) => e.item === "coal").map((e) => e.role).join(", ")}`)
  for (const e of feeds) {
    eq(e.from === role, false, `${e.role}: from a parallel provider, not the split group`)
    eq(e.merge, true, `${e.role} side-loads into the belt the retiring mine still feeds`)
  }
})

test("M7 B (seed 11 g111): a retiring provider's consumers get one replacement of their own, merging into its belts", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>old", [`coal@${SMELT_CU}`]: "coal*>old" }
  const g = design(ctx({ enabled: ELECTRIC, retiring: { "coal*>old": true }, sharing: { keep, spare: {} } }), { item: RED, perSecond: 1 })
  const feeds = g.edges.filter((e) => e.item === "coal" && (e.to === SMELT_FE || e.to === SMELT_CU))
  eq(feeds.length, 2, `one feed per smelter: ${g.edges.filter((e) => e.item === "coal").map((e) => e.role).join(", ")}`)
  for (const e of feeds) {
    eq(e.from, "coal*>old~2", `${e.role}: from the retiring mine's one replacement`)
    eq(e.merge, true, `${e.role} side-loads into the belt the retiring mine still feeds`)
  }
  eq(byRole(g.nodes, "coal*>old~2")!.newSite, true, "on a site of its own")
})

test("M7 B: a retiring provider's consumer whose port took no merge keeps the old belt (no heir edge)", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>old", [`coal@${SMELT_CU}`]: "coal*>old" }
  const g = design(ctx({ enabled: ELECTRIC, retiring: { "coal*>old": true }, noMerge: { [`${SMELT_CU}.in-fuel`]: true }, sharing: { keep, spare: {} } }), { item: RED, perSecond: 1 })
  const feeds = g.edges.filter((e) => e.item === "coal" && e.merge === true)
  eq(feeds.map((e) => e.to).join(","), SMELT_FE, `only the iron smelter gets a replacement: ${g.edges.filter((e) => e.item === "coal").map((e) => e.role).join(", ")}`)
})

test("M7 C: a top-up into a belt that still feeds its consumer below factory-min-top-up gets no provider", () => {
  const keep = { [`coal@${SMELT_FE}`]: "coal*>old", [`coal@${SMELT_CU}`]: "coal*>old" }
  const base = { enabled: ELECTRIC, retiring: { "coal*>old": true }, sharing: { keep, spare: {} } }
  const all = design(ctx({ ...base, minTopUp: 0 }), { item: RED, perSecond: 1 })
  const rates = all.edges.filter((e) => e.item === "coal" && e.merge === true).map((e) => e.rate)
  eq(rates.length, 2, "both smelters get a top-up without a threshold")
  const cut = (rates[0] + rates[1]) / 2
  const some = design(ctx({ ...base, minTopUp: cut }), { item: RED, perSecond: 1 })
  const left = some.edges.filter((e) => e.item === "coal" && e.merge === true)
  eq(left.length, rates[0] === rates[1] ? 2 : 1, `only the top-up at or above ${cut}/s is planned: ${left.map((e) => `${e.role} ${e.rate}`).join(", ")}`)
  for (const e of left) ok(e.rate >= cut - 1e-9, `${e.role} at ${e.rate}/s`)
  const none = design(ctx({ ...base, minTopUp: 100 }), { item: RED, perSecond: 1 })
  eq(none.edges.filter((e) => e.item === "coal" && e.merge === true).length, 0, "no top-up below the threshold")
  eq(none.errors.length, 0, none.errors.join("; "))
})

test("M7c: blue packs: fluid chains for plastic and sulfur, a pumpjack field, a water pump, assembler-2 rows", () => {
  const blue = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  })
  eq(generatorFor(blue, "crude-oil"), "pumpjack-field", "crude: pumped")
  eq(generatorFor(blue, "water"), "water-pump", "water: offshore pump")
  eq(tostring(generatorFor(blue, "petroleum-gas")), "nil", "petroleum is made inside a fluid chain")
  eq(generatorFor(blue, "plastic-bar"), "fluid-chain", "plastic")
  eq(generatorFor(blue, "sulfur"), "fluid-chain", "sulfur")
  eq(generatorFor(blue, "engine-unit"), "engine-cell", "engines: gears and pipes inside the cell")
  eq(generatorFor(blue, "steel-plate"), "smelter-column", "steel")
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const gens: Record<string, string[]> = {}
  for (const n of d.nodes) (gens[n.generator] ??= []).push(n.role)
  ok(gens["fluid-chain"] !== undefined && gens["fluid-chain"].length >= 2, `plastic and sulfur chains (${(gens["fluid-chain"] ?? []).join(", ")})`)
  ok(gens["pumpjack-field"] !== undefined, `a pumpjack field (errors: ${d.errors.join("; ")})`)
  ok(gens["water-pump"] !== undefined, "a water pump for sulfur")
  const engine = d.nodes.find((n) => n.item === "engine-unit")!
  eq(engine.params.machine, "assembling-machine-2", "engines need assembler 2 (advanced-crafting)")
  // Crude edges are fluid edges (pipe ports at both ends).
  const crude = d.edges.filter((e) => e.item === "crude-oil")
  ok(crude.length >= 1, "crude is delivered")
  eq(d.errors.length, 0, d.errors.join("; "))
})

test("M7d.5: advanced circuits and engines are self-contained cells (no cable, gear or pipe provider)", () => {
  const c = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
    buffer: "passive-provider-chest",
  })
  eq(generatorFor(c, "advanced-circuit"), "circuit-block", "advanced circuits: cable inside the block")
  eq(generatorFor(c, "engine-unit"), "engine-cell", "engines: gears and pipes inside the cell")
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const ac = d.nodes.find((n) => n.item === "advanced-circuit")!
  eq(ac.generator, "circuit-block", "advanced circuit block")
  ok(ac.def.recipes.indexOf("copper-cable") >= 0, "the advanced block makes its cable")
  eq(d.nodes.filter((n) => n.item === "copper-cable").length, 0, "no copper-cable provider")
  eq(d.edges.filter((e) => e.item === "copper-cable").length, 0, "no copper-cable route")
  const engine = d.nodes.find((n) => n.item === "engine-unit")!
  eq(engine.generator, "engine-cell", "engine cell")
  ok(engine.def.recipes.indexOf("iron-gear-wheel") >= 0 && engine.def.recipes.indexOf("pipe") >= 0, "the engine cell makes gears and pipes")
  eq(d.nodes.filter((n) => n.item === "iron-gear-wheel" || n.item === "pipe").length, 0, "no gear or pipe provider")
  eq(d.edges.filter((e) => e.item === "iron-gear-wheel" || e.item === "pipe").length, 0, "no gear or pipe route")
})

test("B57/B61: a sealed consumer port plans no provider until its module moves", () => {
  const blue = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
    noFeed: { "chemical-science-pack>labs.in-advanced-circuit": true },
  })
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  eq(d.edges.filter((e) => e.to === "chemical-science-pack>labs" && e.toPort === "in-advanced-circuit").length, 0, "no provider for the sealed port")
  ok(d.nodes.every((n) => n.item !== "advanced-circuit"), "no advanced-circuit provider at all")
})

test("M7d.5: a built pre-cell provider keeps its old generator until it is replaced", () => {
  const c = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
    builtGenerators: { "engine-unit>chemical-science-pack>labs": "assembler-row", "advanced-circuit>chemical-science-pack>labs": "assembler-row" },
  })
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const engine = d.nodes.find((n) => n.item === "engine-unit")!
  eq(engine.generator, "assembler-row", "the built engine row keeps its ports")
  const advanced = d.nodes.find((n) => n.item === "advanced-circuit")!
  eq(advanced.generator, "assembler-row", "the built advanced row keeps its ports")
})

test("M7c: two-input rows by default keep v1's curated green line (no three-ingredient rows)", () => {
  eq(tostring(generatorFor(ctx(), "inserter")), "nil", "inserter: still no generator at rowInputs 2")
})

test("M7c: with three-ingredient rows on, a curated module still keeps its item (the green line)", () => {
  const c = ctx({ rowInputs: 3, curated: { "logistic-science-pack": "green-line-hellpet" } })
  eq(generatorFor(c, "inserter"), "assembler-row", "an inserter row exists at 3")
  eq(producerFor(c, "logistic-science-pack"), "curated", "but green science stays on the curated line")
})

test("M7c: nodes behind an unresearched trigger technology go in a later goal; the pumpjack field first", () => {
  const blue = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  })
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  // Every module needs "tech:<generator>" in this test; fluid chains are behind the trigger.
  const diff = diffDesign(d, newGraph(), () => undefined)
  for (const n of diff.missing) n.def = { ...n.def, requiresTech: [`tech:${n.generator}`] }
  const goals = goalsFrom(diff, {}, (t) => t === "tech:fluid-chain")
  const prod = goals.filter((g) => g.kind === "production")
  ok(prod.length >= 2, `the production goal is split (${prod.length})`)
  const first = prod[0]
  ok(first.nodes.some((n) => n.generator === "pumpjack-field"), "the pumpjack field is in the first part")
  ok(!first.nodes.some((n) => n.generator === "fluid-chain"), "no fluid chain in the first part")
  const later = prod.find((g) => g.nodes.some((n) => n.generator === "fluid-chain"))!
  ok(later.edges.some((e) => e.item === "crude-oil"), "the crude edge belongs to the part that builds its consumer")
  // Without the callback (v1) nothing is split.
  eq(goalsFrom(diff, {}).filter((g) => g.kind === "production").length < prod.length, true, "v1: no split")
})

test("M7c.9: a crude edge over a belt's capacity is a pipe: it never splits the design into clusters", () => {
  const blue = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  })
  const d = design(blue, { item: "chemical-science-pack", perSecond: 0.25 })
  let crude = 0
  for (const e of d.edges) if (e.item === "crude-oil") crude += e.rate
  ok(crude > 14.85, `the crude demand is over a yellow belt's usable 14.85/s (${crude})`)
  for (const [role, why] of pairs(d.overflow)) ok(string.find(role as string, "crude-oil", 1, true) === undefined, `no overflow on a crude edge: ${role} ${why}`)
  eq(d.clusters, 1, "one cluster")
})

test("M7c.9: an edge more clusters do not shrink stops the split", () => {
  // Seed 11: an edge fed by a provider every cluster shares kept its rate (54 → 65/s) while the clusters went 2 → 1250.
  const c = ctx()
  const edge = { role: "iron-plate>x", item: "iron-plate", from: "a", fromPort: "out", to: "x", toPort: "in", rate: 40, headroomRate: 40, belt: "transport-belt", decision: { action: "none" } } as unknown as DesignEdge
  const w = { ctx: c, cluster: 1, suffix: "", nodes: [], edges: [edge], demands: [], errors: [], short: false } as unknown as Parameters<typeof checkEdges>[1]
  const rates: Record<string, number> = {}
  const first = checkEdges(c, w, {}, false, rates)
  ok(first > 1, `40/s on a yellow belt splits (${first})`)
  near(rates[edge.role], 40, 1e-9, "the split edge's rate is recorded")
  const overflow: Record<string, string> = {}
  eq(checkEdges(c, w, overflow, false, {}, rates), 1, "the same rate after the split: no further split")
  ok(string.find(overflow[edge.role] ?? "", "more clusters do not split it", 1, true) !== undefined, `the overflow says why (${overflow[edge.role]})`)
  edge.rate = 20
  ok(checkEdges(c, w, {}, false, {}, rates) > 1, "a rate that did shrink may split again")
})

test("M7d.5: construction robots and roboports stocked: the robot frame chain is planned (engines on lubricant, batteries)", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true, "flying-robot-frame": true, "construction-robot": true, roboport: true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  eq(generatorFor(c, "flying-robot-frame"), "assembler-row", "robot frames: a four-ingredient row")
  eq(generatorFor(c, "construction-robot"), "robot-cell", "construction robots: frames inside the cell")
  const stock = robotStock((t) => t === "construction-robotics", (r) => enabled[r as keyof typeof enabled] === true)
  eq(stock.map((s) => s.item).join(","), "construction-robot,roboport", "robots and roboports once researched")
  eq(robotStock(() => false, () => true).length, 0, "nothing before the research")
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60, stock })
  eq(d.errors.length, 0, d.errors.join("; "))
  const robots = d.nodes.find((n) => n.role === stockRole("construction-robot"))!
  ok(robots !== undefined && robots.kind === "sink" && robots.generator === "robot-cell", "a self-contained robot cell")
  ok((robots.params.buffer as string) !== "", "with buffer chests the crew collects from")
  ok(d.nodes.some((n) => n.role === stockRole("roboport")), "a roboport stock sink")
  ok(robots.def.recipes.indexOf("flying-robot-frame") >= 0, "the cell makes its frames")
  eq(d.nodes.filter((n) => n.item === "flying-robot-frame").length, 0, "no separate frame provider")
  eq(d.edges.filter((e) => e.item === "flying-robot-frame").length, 0, "no frame route")
  ok(d.nodes.some((n) => n.item === "electric-engine-unit" && n.generator === "assembler-row"), "an electric engine row")
  ok(d.nodes.some((n) => n.item === "battery" && n.generator === "chem-row"), "a battery row")
  ok(d.edges.some((e) => e.item === "lubricant"), "lubricant is piped")
  // M7d.5 (user, 2026-11-07): the first roboport is inside the same cell; the hub only names the entity.
  const hubbed = design({ ...c, buffer: "passive-provider-chest", robotHub: { robot: "construction-robot", roboport: "roboport", storageChest: "storage-chest", storage: 2 } }, { item: "chemical-science-pack", perSecond: 10 / 60, stock })
  eq(hubbed.errors.length, 0, hubbed.errors.join("; "))
  const hubRow = hubbed.nodes.find((n) => n.role === stockRole("construction-robot"))!
  eq(hubRow.generator, "robot-cell", "still one robot cell")
  eq(hubRow.params.roboport as string, "roboport", "the cell has the roboport")
  eq(hubRow.def.entities.filter((e) => e.name === "roboport").length, 1, "one roboport in it")
  const portRow = hubbed.nodes.find((n) => n.role === stockRole("roboport"))!
  eq(portRow.params.roboport, undefined, "the roboport stock row has none")
})

test("B175 (user, 2026-11-09): the steel smelters are built before the pumpjack field (a pumpjack takes steel to craft)", () => {
  // m7-fresh4 seeds 11, 3333, 44444: the raw-oil goal came before metals-steel; its pumpjacks could not be crafted on a
  // map with no steel yet, the goal stayed "building", and every later production and growth goal waited on it.
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const prod = goalsFrom(diffDesign(d, newGraph(), () => undefined), {}, undefined, true).filter((g) => g.kind === "production")
  const at = (pred: (this: void, n: DesignNode) => boolean): number => prod.findIndex((g) => g.nodes.some((n) => pred(n)))
  const steel = at((n) => n.generator === "smelter-column" && n.item === "steel-plate")
  const oil = at((n) => n.generator === "pumpjack-field")
  ok(steel >= 0 && oil >= 0, `both layers planned (steel ${steel}, oil ${oil}: ${prod.map((g) => g.phase).join(",")})`)
  ok(steel < oil, `steel before the pumpjacks (${prod.map((g) => g.phase).join(",")})`)
})

test("B178 (user, 2026-11-10): providers of build materials the crew cannot hand-craft come before the oil field", () => {
  // m7-fresh6 seeds 11, 3333, 44444: the crude line's pumps take engine units, the engine cell was in a layer after the
  // oil goal, and that goal stayed "building" with "no source for engine-unit" until the soak stopped.
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const materials = buildMaterials(F, d.nodes, d.edges, ["pipe", "pipe-to-ground", "pump"])
  ok(materials["engine-unit"] === true, "engine units (a pump's) are a build material")
  ok(materials["steel-plate"] === true, "steel (a pumpjack's) is a build material")
  ok(materials["iron-gear-wheel"] !== true, "gears are hand-crafted, no build material")
  ok(materials["plastic-bar"] !== true, "nothing placed here takes plastic")
  const prod = goalsFrom(diffDesign(d, newGraph(), () => undefined), {}, undefined, true, materials).filter((g) => g.kind === "production")
  const at = (pred: (this: void, n: DesignNode) => boolean): number => prod.findIndex((g) => g.nodes.some((n) => pred(n)))
  const engines = at((n) => n.generator === "engine-cell")
  const oil = at((n) => n.generator === "pumpjack-field")
  const circuits = at((n) => n.generator === "circuit-block" && n.item === "advanced-circuit")
  ok(engines >= 0 && oil >= 0 && circuits >= 0, `all planned (engines ${engines}, oil ${oil}, circuits ${circuits}: ${prod.map((g) => g.phase).join(",")})`)
  ok(engines < oil, `the engine cell before the pumpjacks (${prod.map((g) => g.phase).join(",")})`)
  ok(circuits > oil, `the advanced-circuit block stays after the oil it needs (${prod.map((g) => g.phase).join(",")})`)
})

test("B178: a build-material provider fed by a later layer stays in its own layer", () => {
  // Advanced circuits build roboports, but their plastic comes from oil: moving the block before the oil field would
  // only plan it with no plastic.
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const prod = goalsFrom(diffDesign(d, newGraph(), () => undefined), {}, undefined, true, { "advanced-circuit": true, "engine-unit": true }).filter((g) => g.kind === "production")
  const phaseOf = (gen: string, item?: string): string => prod.find((g) => g.nodes.some((n) => n.generator === gen && (item === undefined || n.item === item)))?.phase ?? "none"
  eq(phaseOf("engine-cell"), "materials", "the engine cell moves")
  eq(phaseOf("circuit-block", "advanced-circuit"), "circuits", "the advanced-circuit block does not")
})

test("B209: a connection between two built modules is planned before every new production layer", () => {
  // m7-b208 seed 44444: the oil complex was rebuilt (output sealed) and the water routes to the built sulfur and acid
  // rows went with it. Their edges-only goal came last, behind a 12-module stock goal that planned ~33 game-minutes
  // per attempt and kept failing: no acid, no batteries, no construction robots for 80+ game-minutes.
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60 })
  const full = diffDesign(d, newGraph(), () => undefined)
  const lost = full.missingEdges.find((e) => d.nodes.some((n) => n.role === e.from && n.item === "water"))
  ok(lost !== undefined, "a water edge")
  const built: Record<string, boolean> = { [lost!.from]: true, [lost!.to]: true }
  const diff = { ...full, missing: full.missing.filter((n) => !built[n.role]) }
  const prod = goalsFrom(diff, {}, undefined, true).filter((g) => g.kind === "production")
  ok(prod.length > 2, `several layers (${prod.map((g) => g.phase).join(",")})`)
  eq(prod[0].nodes.length, 0, "the first production goal places no module")
  ok(prod[0].edges.some((e) => e.role === lost!.role), `the lost connection is in it (${prod.map((g) => g.phase).join(",")})`)
})

test("M7d.5: a large robot production goal is split into dependency layers", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true, "flying-robot-frame": true, "construction-robot": true, roboport: true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 4, packs: [RED, "logistic-science-pack", "chemical-science-pack"] })
  const stock = robotStock((t) => t === "construction-robotics", (r) => enabled[r as keyof typeof enabled] === true)
  const d = design(c, { item: "chemical-science-pack", perSecond: 10 / 60, stock })
  const diff = diffDesign(d, newGraph(), () => undefined)
  const one = goalsFrom(diff, {})
  eq(one.filter((g) => g.kind === "production").length, 1, "the default is still one production goal")
  const split = goalsFrom(diff, {}, undefined, true)
  const prod = split.filter((g) => g.kind === "production")
  ok(prod.length >= 4, `the robot chain is split (${prod.length} production goals)`)
  const layerOf = (g: (typeof prod)[number]): string => {
    if (g.nodes.some((n) => n.generator === "mining-outpost" || n.generator === "pumpjack-field" || n.generator === "water-pump")) return "raw"
    if (g.nodes.some((n) => n.generator === "smelter-column")) return "metals"
    if (g.nodes.some((n) => n.generator === "oil-complex")) return "oil"
    if (g.nodes.some((n) => n.generator === "chem-row" || n.generator === "fluid-chain")) return "chemicals"
    if (g.nodes.some((n) => n.generator === "circuit-block" || n.generator === "engine-cell")) return "circuits"
    if (g.nodes.some((n) => n.generator === "robot-cell")) return "robot"
    return "parts/other"
  }
  const layers = prod.map((g) => layerOf(g))
  const pos = (l: string): number => layers.indexOf(l)
  ok(pos("raw") >= 0 && pos("metals") > pos("raw"), `raw before metals (${layers.join(",")})`)
  ok(pos("robot") > pos("parts/other") && pos("robot") > pos("circuits"), `the robot cell comes after its parts (${layers.join(",")})`)
  const robot = prod.find((g) => layerOf(g) === "robot")!
  ok(robot.nodes.some((n) => n.generator === "robot-cell"), "the robot cell is its own goal")
  ok(robot.edges.some((e) => e.to === stockRole("construction-robot")), "its input routes are planned with it")
  const metals = prod.find((g) => layerOf(g) === "metals")!
  ok(metals.edges.some((e) => e.item === "iron-ore"), "the ore edges are planned with the smelters")
})

test("M7d.4: after advanced oil processing: one oil complex, pipe-fed chemistry rows, no fluid chains", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true }
  const blue = ctx({
    enabled,
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  })
  eq(generatorFor(blue, "petroleum-gas"), "oil-complex", "petroleum")
  eq(generatorFor(blue, "lubricant"), "oil-complex", "lubricant")
  eq(generatorFor(blue, "plastic-bar"), "chem-row", "plastic")
  eq(generatorFor(blue, "sulfur"), "chem-row", "sulfur")
  eq(generatorFor(blue, "sulfuric-acid"), "chem-row", "sulfuric acid (a fluid)")
  eq(generatorFor(blue, "battery"), "chem-row", "batteries")
  eq(generatorFor(blue, "electric-engine-unit"), "assembler-row", "electric engines (lubricant by pipe)")
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const gens: Record<string, string[]> = {}
  for (const n of d.nodes) (gens[n.generator] ??= []).push(n.role)
  eq(gens["fluid-chain"], undefined, "no fluid chains")
  eq((gens["oil-complex"] ?? []).join(","), "oil-complex", "one oil complex")
  ok((gens["chem-row"] ?? []).length >= 2, `plastic and sulfur rows (${(gens["chem-row"] ?? []).join(", ")})`)
  const complex = d.nodes.find((n) => n.generator === "oil-complex")!
  // Every petroleum edge comes from the complex's petroleum port; the complex takes crude and water.
  const pet = d.edges.filter((e) => e.item === "petroleum-gas")
  ok(pet.length >= 2, `petroleum to both rows (${pet.length})`)
  for (const e of pet) eq(`${e.from}.${e.fromPort}`, "oil-complex.out-petroleum-gas", e.role)
  let petNeed = 0
  for (const e of pet) petNeed += e.rate
  ok(rateOf(complex.def.rates.outputs, "petroleum-gas") + 1e-9 >= petNeed, `complex covers ${petNeed} petroleum/s`)
  ok(d.edges.some((e) => e.to === "oil-complex" && e.item === "crude-oil"), "crude into the complex")
  ok(d.edges.some((e) => e.to === "oil-complex" && e.item === "water"), "water into the complex")
  eq(complex.params.lubePlants, 0, "no lubricant asked for: no lubricant plants")
})

test("M7d.5: an oil family reuses its built complex instead of forking per design", () => {
  const blue = ctx({
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
    providerCaps: { "oil-complex": 10 },
    oilLube: { "oil-complex": true },
  })
  const d = design(blue, { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const complexes = d.nodes.filter((n) => n.generator === "oil-complex")
  eq(complexes.map((n) => n.role).join(","), "oil-complex", "one family member, no ~2")
  eq(complexes[0].capacity, 10, "the built capacity is kept")
})

test("B193: lubricant with a built complex that has no lubricant plant goes to a parallel complex, not the built role", () => {
  // `m7-b186` seed 11, min 269: the new complex was named `oil-complex` (the walk had no node of that role yet), so the
  // diff bound it to the built 1/0 complex and its lubricant edge asked a port that complex does not have (12 plans).
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "plastic-bar": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "electric-engine-unit": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 3, packs: ["electric-engine-unit"], providerCaps: { "oil-complex": 10 } })
  const d = design(c, { item: "electric-engine-unit", perSecond: 0.1 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const lube = d.edges.filter((e) => e.item === "lubricant")
  ok(lube.length > 0, "the engines take lubricant")
  for (const e of lube) eq(e.from, "oil-complex~2", `${e.role}: from the parallel complex`)
  eq(d.nodes.filter((n) => n.generator === "oil-complex").map((n) => n.role).join(","), "oil-complex~2", "one new complex, not the built role")
})

test("review fix: consumers kept by a parallel oil complex (oil-complex~2) are not planned again", () => {
  const base = {
    enabled: { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "sulfuric-acid": true, battery: true, "electric-engine-unit": true },
    resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"],
    assemblers: ["assembling-machine-1", "assembling-machine-2"],
    rowInputs: 3,
    packs: [RED, "logistic-science-pack", "chemical-science-pack"],
  }
  const first = design(ctx(base), { item: "chemical-science-pack", perSecond: 10 / 60 })
  const keep: Record<string, string> = {}
  for (const e of first.edges) if (e.item === "petroleum-gas" || e.item === "lubricant") keep[`${e.item}@${e.to}@${e.toPort}`] = "oil-complex~2"
  ok(Object.keys(keep).length >= 2, "the first design has oil consumers")
  const again = design(ctx({ ...base, sharing: { keep, spare: {} } }), { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(again.nodes.filter((n) => n.generator === "oil-complex").map((n) => n.role).join(","), "", "every oil consumer is kept: no new complex")
  ok(isOilComplexRole("oil-complex") && isOilComplexRole("oil-complex~2") && isOilComplexRole("oil-complex#2~3"), "family roles")
  ok(!isOilComplexRole("oil-comple"), "not a prefix of the base name")
})

test("M7d.4: electric engines and plastic: one oil complex makes the lubricant and the petroleum", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "plastic-bar": true, "basic-oil-processing": true, "advanced-oil-processing": true, lubricant: true, "electric-engine-unit": true }
  const c = ctx({ enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 3, packs: ["electric-engine-unit"] })
  const d = design(c, { item: "electric-engine-unit", perSecond: 0.1 })
  eq(d.errors.length, 0, d.errors.join("; "))
  const complexes = d.nodes.filter((n) => n.generator === "oil-complex")
  eq(complexes.map((n) => n.role).join(","), "oil-complex", "one oil complex")
  const lube = d.edges.filter((e) => e.item === "lubricant")
  ok(lube.length >= 1, "lubricant is delivered")
  for (const e of lube) eq(`${e.from}.${e.fromPort}`, "oil-complex.out-lubricant", e.role)
  let need = 0
  for (const e of lube) need += e.rate
  ok(rateOf(complexes[0].def.rates.outputs, "lubricant") + 1e-9 >= need, `lubricant ${need}/s covered (${complexes[0].params.lubePlants} plants)`)
  const engines = d.nodes.find((n) => n.item === "electric-engine-unit" && n.generator === "assembler-row")
  ok(engines !== undefined, "an electric engine row")
})

test("M7d.4: a fluid chain already built keeps its role as a fluid chain after the switch", () => {
  const enabled = { ...ELECTRIC, "steel-plate": true, "engine-unit": true, "advanced-circuit": true, "plastic-bar": true, sulfur: true, "chemical-science-pack": true, "basic-oil-processing": true, "advanced-oil-processing": true }
  const base = { enabled, resources: ["iron-ore", "copper-ore", "coal", "stone", "crude-oil"], assemblers: ["assembling-machine-1", "assembling-machine-2"], rowInputs: 3, packs: [RED, "logistic-science-pack", "chemical-science-pack"] }
  const first = design(ctx(base), { item: "chemical-science-pack", perSecond: 10 / 60 })
  const plastic = first.nodes.find((n) => n.item === "plastic-bar")!
  eq(plastic.generator, "chem-row", "new: a chemistry row")
  const again = design(ctx({ ...base, builtGenerators: { [plastic.role]: "fluid-chain" } }), { item: "chemical-science-pack", perSecond: 10 / 60 })
  eq(again.nodes.find((n) => n.role === plastic.role)?.generator, "fluid-chain", "built: still a fluid chain")
  eq(again.errors.length, 0, again.errors.join("; "))
})

test("review fix (Layers14): a built provider with no belt edge is offered as spare, not skipped", () => {
  const g = newGraph()
  const coal = [{ item: "coal", perSecond: 2 }]
  addNode(g, { id: moduleId("idle"), role: "coal*>smelter", kind: "outpost", item: "coal", capacity: { inputs: [], outputs: coal }, planned: { inputs: [], outputs: coal }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  addNode(g, { id: moduleId("planned"), role: "coal*>other", kind: "outpost", item: "coal", capacity: { inputs: [], outputs: coal }, planned: { inputs: [], outputs: coal }, powerW: 0, lifecycle: "planned", status: "unknown", createdTick: 0 })
  addNode(g, { id: moduleId("steam"), role: "power", kind: "power", item: "electricity", capacity: { inputs: [], outputs: [{ item: "electricity", perSecond: 1e6 }] }, planned: { inputs: [], outputs: [] }, powerW: 0, lifecycle: "built", status: "unknown", createdTick: 0 })
  const f = { faction: "x", graph: g, layout: newLayout() } as never
  const s = sharing({ config: { factorySharedProviders: 1 } as never, force: {} as never }, f, 0, true)!
  eq(s.spare.coal?.["coal*>smelter"], 2, "the idle built mine's planned output is spare")
  eq(s.spare.coal?.["coal*>other"], undefined, "a provider not built yet is not")
  eq(s.spare.electricity, undefined, "power is not a tap")
})

test("B205 (user, 2026-11-12): once medium poles are researched every new module but the solar field uses them", () => {
  const d = design(ctx({ pole: "medium-electric-pole" }), { item: RED, perSecond: 1 })
  ok(d.nodes.length > 0, "a design")
  for (const n of d.nodes) {
    if (n.generator === "solar-field") continue
    const small = n.def.entities.some((e) => e.name === "small-electric-pole")
    eq(small, false, `${n.role} (${n.generator}) has no small pole`)
  }
  const plain = design(ctx({}), { item: RED, perSecond: 1 })
  ok(plain.nodes.some((n) => n.def.entities.some((e) => e.name === "small-electric-pole")), "before the research: the generators' default")
})

/** A stand-in mall for T1: a gear row whose chest-out ports name what a mall makes. */
function fakeMall(products: string[]): ModuleDef {
  const def = generate(F, "assembler-row", { recipe: "iron-gear-wheel", count: 2 }) as ModuleDef
  return { ...def, ports: [...def.ports, ...products.map((item) => ({ id: `out-${item}`, kind: "chest-out", pos: { x: 0.5, y: 0.5 }, dir: 0, item }) as Port)] }
}

test("B205 (user, 2026-11-12): with the mall, buildings the design places in numbers get machine-made stock rows", () => {
  const mall = fakeMall(["transport-belt", "inserter", "assembling-machine-1", "electric-mining-drill", "pipe"])
  const c = ctx({
    enabled: { ...ELECTRIC, pipe: true, "stone-furnace": true, lab: true, "electronic-circuit": true, "copper-cable": true, inserter: true, "assembling-machine-1": true, boiler: true, "steam-engine": true },
    rowInputs: 3,
    make: (gen, params) => (gen === "curated" ? mall : (generate(F, gen as GeneratorName, params) as ModuleDef)),
  })
  const target = { item: RED, perSecond: 1, mall: { id: "fake-mall", utilization: 0.25 } }
  // Before robots are coming nothing builds from the stock: no generated rows.
  eq(design(c, target).nodes.some((n) => string.sub(n.role, 1, 6) === "stock:"), false, "no robots yet, no generated stock")
  c.builtGenerators = { "stock:construction-robot": "robot-cell" }
  const d = design(c, target)
  const rows = d.nodes.filter((n) => string.sub(n.role, 1, 6) === "stock:").map((n) => n.role)
  rows.sort()
  ok(rows.indexOf("stock:stone-furnace") >= 0, `the furnaces of its smelter columns: ${rows.join(",")}`)
  for (const item of ["transport-belt", "inserter", "assembling-machine-1", "electric-mining-drill", "pipe"]) ok(rows.indexOf(`stock:${item}`) < 0, `not ${item}: the mall makes it`)
  // Without the mall, or for buildings the design places fewer than BUILD_STOCK_MIN times, no generated rows.
  const plain = design(c, { item: RED, perSecond: 1 })
  eq(plain.nodes.some((n) => string.sub(n.role, 1, 6) === "stock:"), false, "no mall, no generated stock")
  const first = design(c, { ...target, stock: [{ item: "stone-furnace", perSecond: 0.01 }] })
  for (const st of buildStock(c, first, target, { "stone-furnace": true })) {
    let placed = 0
    for (const n of first.nodes) for (const e of n.def.entities) if ((F.itemToPlace(e.name) ?? e.name) === st.item) placed++
    ok(placed >= BUILD_STOCK_MIN, `${st.item}: placed ${placed} times`)
    ok(st.item !== "stone-furnace", "a building already stocked is not stocked twice")
  }
})

run("design")
