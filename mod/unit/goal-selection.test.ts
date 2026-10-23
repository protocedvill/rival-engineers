import { selectGoals, GoalSelectionSpec, GoalSelectionState } from "../src/strategy/goal-selection"
import { eq, run, test } from "./harness"

function state(overrides: Partial<GoalSelectionState> = {}): GoalSelectionState {
  return {
    active: {},
    built: {},
    planning: false,
    powerNodeExists: false,
    growingPower: false,
    researched: {},
    growMaxFails: 3,
    ...overrides,
  }
}

function spec(kind: GoalSelectionSpec["kind"], extra: Partial<GoalSelectionSpec> = {}): GoalSelectionSpec {
  return { kind, techs: [], ...extra }
}

test("labs explain that first power must be built", () => {
  const result = selectGoals([spec("labs")], state())
  eq(result.decisions[0].action, "skip")
  eq(result.decisions[0].waiting, "labs wait for power")
})

test("production waits for active foundations and research", () => {
  const foundations = selectGoals([spec("production")], state({ active: { power: true, labs: true } }))
  eq(foundations.decisions[0].waiting, "production waits for power, labs")
  const research = selectGoals([spec("production", { techs: ["automation", "logistics"] })], state({ researched: { automation: true } }))
  eq(research.decisions[0].waiting, "production waits for research: logistics")
})

test("power growth goes before other growth and consumers", () => {
  const specs = [
    spec("grow", { growth: { role: "iron", have: 1, need: 2, units: 1, power: false, failed: 0 } }),
    spec("mall"),
    spec("grow", { growth: { role: "power", have: 1, need: 2, units: 1, power: true, failed: 0 } }),
  ]
  const result = selectGoals(specs, state())
  eq(result.decisions[0].action, "skip")
  eq(result.decisions[1].waiting, "mall waits for the steam block's growth")
  eq(result.decisions[2].action, "start")
})

test("blocked growth is reported but does not hold another goal", () => {
  const specs = [
    spec("grow", { growth: { role: "copper", have: 2, need: 4, units: 0, power: false, failed: 1 } }),
    spec("mall"),
  ]
  const result = selectGoals(specs, state())
  eq(result.pending, 1)
  eq(result.waiting[0], "copper short (2/4): cannot grow (1 failed expansions)")
  eq(result.decisions[0].index, 1)
  eq(result.decisions[0].action, "start")
})

test("B29: power growth is not held up by an active production build", () => {
  const grow = spec("grow", { growth: { role: "coal>power", have: 1, need: 3.47, units: 2, power: true, failed: 0 } })
  const result = selectGoals([grow], state({ active: { production: true } }))
  eq(result.decisions[0].action, "start")
})

test("B52: a growth waits for any other goal still building (the mall's routes would be rerouted under it)", () => {
  const grow = spec("grow", { growth: { role: "power", have: 1, need: 2, units: 1, power: true, failed: 0 } })
  for (const kind of ["mall", "repair", "temp", "radar"] as GoalSelectionSpec["kind"][]) {
    const result = selectGoals([grow], state({ active: { [kind]: true } }))
    eq(result.decisions[0].action, "skip", kind)
    eq(result.decisions[0].waiting, `grow waits for ${kind}`, kind)
  }
  eq(selectGoals([grow], state({ active: { grow: false } })).decisions[0].action, "start", "nothing building")
})

test("a planning goal freezes new starts", () => {
  const result = selectGoals([spec("power")], state({ planning: true }))
  eq(result.decisions.length, 0)
  eq(result.pending, 1)
})

run("goal-selection")
