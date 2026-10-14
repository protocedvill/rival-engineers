import { clearConfigOverrides } from "../config"
import { computeResearchGoal } from "../strategy/research"

// SPEC §3.2 (D30): the v1 research goal is computed from prototypes, never hardcoded.

describe("research goal", () => {
  before_each(() => clearConfigOverrides())

  // 42 = 39 pack-researched techs + 3 trigger techs (steam-power, electronics, automation-science-pack). The M2
  // report said 43 because it counted the oil-processing trigger itself ("mine crude-oil") as reachable.
  test("is the 42 red/green technologies reachable without steel or oil (vanilla 2.0.77)", () => {
    if (script.active_mods["space-age"]) return // the count below is for vanilla
    const goal = computeResearchGoal()
    const has: Record<string, boolean> = {}
    for (const name of goal) has[name] = true
    log(`[m3] research goal (${goal.length}): ${goal.join(", ")}`)
    assert(goal.length === 42, `research goal has ${goal.length} technologies`)
    // The four reachable trigger technologies, and pack technologies of both colours.
    for (const name of ["steam-power", "electronics", "automation-science-pack", "logistic-science-pack", "automation", "steel-processing", "automation-2", "logistics-2"]) {
      assert(has[name], `${name} is in the goal`)
    }
    // Excluded: the steel and crude-oil triggers and everything behind them, and anything needing blue.
    for (const name of ["steel-axe", "oil-processing", "plastics", "advanced-circuit", "sulfur-processing", "modules", "chemical-science-pack", "logistics-3"]) {
      assert(!has[name], `${name} is not in the goal`)
    }
  })

  test("follows the configured packs and exclusions", () => {
    const redOnly = computeResearchGoal(["automation-science-pack"], ["steel-plate", "crude-oil"])
    const withSteelAxe = computeResearchGoal(["automation-science-pack", "logistic-science-pack"], ["crude-oil"])
    const full = computeResearchGoal()
    assert(redOnly.length > 0 && redOnly.length < full.length, `red only: ${redOnly.length}`)
    assert(withSteelAxe.length === full.length + 1, `allowing steel adds steel-axe: ${withSteelAxe.length} vs ${full.length}`)
  })
})
