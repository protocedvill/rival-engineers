import { addJob, claim, newBoard } from "../src/jobs/board"
import { boardDiagnostics } from "../src/diagnostics-core"
import { eq, ok, run, test } from "./harness"

test("diagnostics explain dependency, backoff and ready jobs", () => {
  const board = newBoard<unknown>()
  const first = addJob(board, { kind: "craft", pos: { x: 0, y: 0 }, payload: {} }, 10)
  const dependent = addJob(board, { kind: "place", pos: { x: 1, y: 0 }, deps: [first.id], materials: [{ item: "iron-plate", count: 9 }], payload: {} }, 10)
  const delayed = addJob(board, { kind: "fuel", pos: { x: 2, y: 0 }, payload: {} }, 10)
  delayed.retryAt = 50
  const out = boardDiagnostics(board, {}, 20)
  eq(out.jobs[0].blocker, "board-ready")
  eq(out.jobs[1].blocker, "dependency-open")
  eq(out.jobs[1].relatedJob, first.id)
  eq(out.jobs[2].blocker, "backoff")
  eq(out.invariants.length, 0)
  eq(out.jobs[1].materials, undefined, "dependency is the first blocker, so materials are not evaluated yet")
  ok(dependent.id !== delayed.id)
})

test("diagnostics catch one-sided claims", () => {
  const board = newBoard<unknown>()
  const job = addJob(board, { kind: "clear", pos: { x: 0, y: 0 }, payload: {} }, 0)
  ok(claim(board, [job.id], 7, 0))
  const out = boardDiagnostics(board, { 7: { claims: [] } }, 0)
  eq(out.jobs[0].blocker, "claimed")
  eq(out.invariants[0].code, "claim-not-reciprocal")
})

run("diagnostics")
