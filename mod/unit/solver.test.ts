import { lineFor, miningFor, RatioSolver, solveNow, SolveProblem } from "../src/strategy/solver"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: the ratio solver (SPEC §5.8, D21) against hand-computed values (docs/analysis/module-catalog-estimate.md).

const RESOURCES = ["iron-ore", "copper-ore", "coal", "stone"]

function problem(targets: Record<string, number>, extra: Partial<SolveProblem> = {}): SolveProblem {
  const t: { item: string; perSecond: number }[] = []
  for (const [item, perMin] of pairs(targets)) t.push({ item: item as string, perSecond: (perMin as number) / 60 })
  t.sort((a, b) => (a.item < b.item ? -1 : 1))
  return {
    targets: t,
    machines: ["assembling-machine-1", "stone-furnace"],
    drills: ["electric-mining-drill"],
    resources: RESOURCES,
    fuel: "coal",
    boiler: "boiler",
    engine: "steam-engine",
    ...extra,
  }
}

test("30 red + 30 green/min: 3.75 Fe/s and 1.25 Cu/s; 12 + 4 stone furnaces; assembler counts", () => {
  const job = solveNow(problem({ "automation-science-pack": 30, "logistic-science-pack": 30 }), F)
  eq(job.phase, "done", "phase")
  const r = job.result
  near(r.items["iron-plate"].produced, 3.75, 1e-9, "iron plates/s")
  near(r.items["copper-plate"].produced, 1.25, 1e-9, "copper plates/s")
  near(lineFor(r, "iron-plate")!.machines, 12, 1e-9, "iron furnaces")
  near(lineFor(r, "copper-plate")!.machines, 4, 1e-9, "copper furnaces")
  eq(lineFor(r, "iron-plate")!.machine, "stone-furnace", "smelting machine from the category")
  near(lineFor(r, "automation-science-pack")!.machines, 5, 1e-9, "red assemblers")
  near(lineFor(r, "logistic-science-pack")!.machines, 6, 1e-9, "green assemblers")
  // Gears: 0.5 (red) + 0.5 (inserters) + 0.25 (belt crafts) per second; AM1 makes 1 gear/s.
  near(r.items["iron-gear-wheel"].produced, 1.25, 1e-9, "gears/s")
  near(lineFor(r, "iron-gear-wheel")!.machines, 1.25, 1e-9, "gear assemblers")
  near(lineFor(r, "copper-cable")!.machines, 0.75, 1e-9, "cable assemblers")
  near(lineFor(r, "electronic-circuit")!.machines, 0.5, 1e-9, "circuit assemblers")
  near(lineFor(r, "inserter")!.machines, 0.5, 1e-9, "inserter assemblers")
  near(lineFor(r, "transport-belt")!.crafts, 0.25, 1e-9, "belt crafts/s (2 belts per craft)")
  near(miningFor(r, "iron-ore")!.drills, 7.5, 1e-9, "iron drills (0.5 ore/s each)")
  near(miningFor(r, "copper-ore")!.drills, 2.5, 1e-9, "copper drills")
  near(r.raw["iron-ore"], 3.75, 1e-9, "raw iron ore")
  eq(r.errors.length, 0, "errors")
})

test("fuel and power: 16 furnaces burn 0.36 coal/s; the electric demand is the coal-drill fixed point", () => {
  const r = solveNow(problem({ "automation-science-pack": 30, "logistic-science-pack": 30 }), F).result
  near(r.burnerFuel, (16 * 90000) / 4e6, 1e-9, "furnace coal/s")
  // Assemblers 14.25 × 75 kW; drills (7.5 + 2.5 + coal) × 90 kW; coal drills = (0.36 + W / 4 MJ) / 0.5.
  const W = r.electricW
  const coalDrills = (0.36 + W / 4e6) / 0.5
  near(W, 14.25 * 75000 + 90000 * (10 + coalDrills), 1e-3, "electric W satisfies the fixed point")
  near(W, (1068750 + 900000 + 90000 * 0.72) / (1 - 90000 / 2e6), 1e-3, "closed form")
  near(miningFor(r, "coal")!.drills, coalDrills, 1e-6, "coal drills")
  near(r.boilers, W / 1.8e6, 1e-9, "boilers")
  near(r.engines, W / 0.9e6, 1e-9, "engines")
  near(r.boilerFuel, W / 4e6, 1e-9, "boiler coal/s")
  near(r.raw.coal, r.burnerFuel + r.boilerFuel, 1e-9, "raw coal = burners + boilers")
})

test("10 red/min: one third of an iron furnace column's worth, gears inside", () => {
  const r = solveNow(problem({ "automation-science-pack": 10 }), F).result
  near(r.items["iron-plate"].produced, 1 / 3, 1e-9, "iron plates/s (one gear = 2 plates per pack)")
  near(r.items["copper-plate"].produced, 1 / 6, 1e-9, "copper plates/s")
  near(lineFor(r, "automation-science-pack")!.machines, 10 / 6, 1e-9, "red assemblers")
  ok(lineFor(r, "logistic-science-pack") === undefined, "no green")
})

test("locked recipes are planned with and reported with their technology", () => {
  const enabled: Record<string, boolean> = { "iron-plate": true, "copper-plate": true, "iron-gear-wheel": true }
  const r = solveNow(problem({ "automation-science-pack": 10 }, { enabled }), F).result
  let red: string | undefined
  for (const l of r.locked) if (l.recipe === "automation-science-pack") red = l.tech ?? "?"
  ok(red !== undefined, "red science reported locked")
  eq(r.locked.length, 1, "only red is locked")
})

test("raw overrides stop the recursion (plates supplied from outside)", () => {
  const r = solveNow(problem({ "automation-science-pack": 30 }, { raw: ["copper-plate", "iron-plate"] }), F).result
  ok(lineFor(r, "copper-plate") === undefined, "no copper smelting")
  near(r.raw["copper-plate"], 0.5, 1e-9, "copper plates raw")
  near(r.raw["iron-plate"], 1, 1e-9, "iron plates raw")
  ok(miningFor(r, "iron-ore") === undefined, "no iron mining")
})

test("resumable: a 1-unit budget per step gives the same result as one big step", () => {
  const p = problem({ "automation-science-pack": 30, "logistic-science-pack": 30 })
  const job = RatioSolver.start(p, F)
  let steps = 0
  while (!RatioSolver.step(job, F, 1)) steps++
  const big = solveNow(p, F).result
  ok(steps > 10, `stepped ${steps} times`)
  near(job.result.electricW, big.electricW, 1e-6, "same electric demand")
  near(job.result.items["iron-plate"].produced, big.items["iron-plate"].produced, 1e-12, "same iron")
  eq(job.result.lines.length, big.lines.length, "same lines")
})

test("burner drills: mining burns fuel instead of power", () => {
  const r = solveNow(problem({ "iron-plate": 60 }, { drills: ["burner-mining-drill"] }), F).result
  const m = miningFor(r, "iron-ore")!
  near(m.drills, 1 / 0.25, 1e-9, "4 burner drills for 1 ore/s")
  eq(m.powerW, 0, "no electricity")
  ok(m.fuelPerSecond > 0, "fuel")
  eq(r.electricW, 0, "no electric demand")
})

run("solver")
