import { eq, run, test } from "./harness"
import { FailedPlanFacts, learnFromFailure, strongestReplan } from "../src/strategy/failure-rules"
import { planFailure } from "../src/shared/plan-failure"

// T1: D69 failure rule. What a failed plan teaches the design, from typed failures (was six detectors in
// `factory.ts` `updatePlanning`, two of them reading the failure text).

function facts(over: Partial<FailedPlanFacts>): FailedPlanFacts {
  return {
    failures: [],
    edges: [],
    nodes: [],
    provider: () => undefined,
    portFed: () => false,
    aliasOf: () => undefined,
    fallbackFor: () => false,
    ...over,
  }
}

function kinds(f: FailedPlanFacts): string {
  return learnFromFailure(f)
    .map((l) => `${l.kind}:${l.key}`)
    .join(" ")
}

const A = { role: "coal*>a=>a.in", from: "coal*>a", to: "a", toPort: "in" }
const B = { role: "coal*>a=>b.in", from: "coal*>a", to: "b", toPort: "in" }

test("B60/B61: a new shared provider that can't reach every consumer splits", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("other", "no path") }], edges: [A, B], nodes: [{ id: "n1", role: "coal*>a" }] })
  eq(kinds(f), "providerSplit:coal*>a")
  // Built already: it is a provider with taps, not a new shared one.
  eq(kinds({ ...f, provider: () => "built" }), "providerNoTap:coal*>a=>a.in noTap:coal*>a")
})

test("B71/B80: no merge target, or a port another belt feeds, takes no merge", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("no-merge-target", "no merge target for n1.in") }], edges: [A] })
  eq(kinds(f), "noMerge:a.in", "from the failure kind, not its text")
  eq(kinds({ ...f, failures: [{ key: A.role, failure: planFailure("other", "no merge target for n1.in") }] }), "", "the text alone does not count")
  eq(kinds({ ...f, failures: [{ key: A.role, failure: planFailure("other", "no path") }], portFed: () => true }), "noMerge:a.in")
})

test("D68: an unplaceable producer whose item has a built producer with capacity falls back to tapping it", () => {
  const f = facts({ failures: [{ key: "module:n7", failure: planFailure("no-position", "no feasible position", "coal") }], nodes: [{ id: "n7", role: "coal>power~2", item: "coal" }], fallbackFor: (item) => item === "coal" })
  eq(kinds(f), "fallback:coal")
  eq(kinds({ ...f, fallbackFor: () => false }), "")
})

test("B72: a new provider folded into a shared mine whose route failed gets a site of its own", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("other", "no path") }], edges: [A], nodes: [{ id: "n9", role: "coal*>a" }], aliasOf: (id) => (id === "n9" ? "n3" : undefined) })
  eq(kinds(f), "ownSite:coal*>a")
})

test("the strongest replan wins, in the order the factory always reported", () => {
  eq(strongestReplan(["without taps", "without that merge"]), "without that merge")
  eq(strongestReplan(["without taps", "parallel providers"]), "parallel providers")
  eq(strongestReplan([]), undefined)
})

run("failure-rules")
