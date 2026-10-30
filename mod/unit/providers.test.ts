import { assignProviders, ConsumerObligation, ProviderState, residualDemand } from "../src/strategy/providers"
import { eq, run, test } from "./harness"

function provider(role: string, capacity: number, assigned?: number): ProviderState {
  return { node: `n:${role}`, role, item: "coal", capacity, assigned, expandable: false }
}

function consumer(module: string, port: string, rate: number, priority = 0, preferred?: string): ConsumerObligation {
  return { module, port, item: "coal", rate, priority, provider: preferred }
}

test("provider groups: an existing provider keeps its committed assignment and the residual gets a second provider", () => {
  const p = assignProviders([provider("coal>power", 1), provider("coal>mall#2", 2)], [
    consumer("n1", "in-fuel", 1, 0, "coal>power"),
    consumer("n2", "in-fuel", 1, 1),
  ])
  eq(p.assignments.length, 2)
  eq(p.assignments.map((a) => `${a.module}:${a.role}`).sort().join(","), "n1:coal>power,n2:coal>mall#2")
  eq(p.residual.length, 0)
  eq(residualDemand(p), 0)
})

test("provider groups: preserved assignments win over new consumers; scarce capacity is deterministic", () => {
  const p = assignProviders([provider("coal>power", 1), provider("coal>mall#2", 1)], [
    consumer("n1", "in-fuel", 1, 0, "coal>power"),
    consumer("n2", "in-fuel", 1, 0),
    consumer("n3", "in-fuel", 1, 0),
  ])
  eq(p.assignments.length, 2)
  eq(p.assignments.map((a) => a.module).sort().join(","), "n1,n2")
  eq(p.residual[0].module, "n3")
  eq(residualDemand(p), 1)
})

test("provider groups: no provider means every consumer is residual", () => {
  const p = assignProviders([], [consumer("n1", "in-fuel", 2), consumer("n2", "in-fuel", 1)])
  eq(p.assignments.length, 0)
  eq(p.residual.length, 2)
  eq(p.capacity, 0)
  eq(residualDemand(p), 3)
})

run("providers")
