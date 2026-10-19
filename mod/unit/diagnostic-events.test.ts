import { detectChurn, DiagnosticEventStore, recordDiagnostic, recentDiagnosticBuckets } from "../src/diagnostic-events"
import { eq, run, test } from "./harness"

test("repeated observations coalesce without losing duration", () => {
  const owner: { diagnosticEvents?: DiagnosticEventStore } = {}
  recordDiagnostic(owner, { tick: 10, kind: "crew-plan", decision: "idle" }, "crew:1", "idle:materials")
  recordDiagnostic(owner, { tick: 20, kind: "crew-plan", decision: "idle" }, "crew:1", "idle:materials")
  const events = recentDiagnosticBuckets(owner)["crew-plan"]!
  eq(events.length, 1)
  eq(events[0].tick, 10)
  eq(events[0].lastTick, 20)
  eq(events[0].repeats, 2)
})

test("churn requires volume and a poor outcome ratio", () => {
  eq(detectChurn({ claims: 10, releases: 10, completions: 0, preemptions: 0, preemptTaken: 0 }).length, 0)
  const findings = detectChurn({ claims: 40, releases: 20, completions: 2, preemptions: 50, preemptTaken: 2 })
  eq(findings[0].code, "job-churn")
  eq(findings[1].code, "preempt-churn")
})

run("diagnostic-events")
