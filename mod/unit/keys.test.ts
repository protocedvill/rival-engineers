import { keyTaken, pruneFailedKeys } from "../src/jobs/keys"
import { eq, ok, run, test } from "./harness"

// T1: keyed jobs (bootstrap gathers, factory upkeep) and the B82 cooldown on a failed key.

test("B82: a key whose job failed stays taken for the cooldown, then frees (vps-d68b 1376111: one unreachable tree)", () => {
  const k = { jobKeys: { "tree:1,1": 7 } as Record<string, number> }
  const jobs: Record<number, { status: string; finishedTick?: number }> = { 7: { status: "claimed" } }
  ok(keyTaken(k, jobs, "tree:1,1", 100, 600), "an active job takes its key")
  jobs[7] = { status: "failed", finishedTick: 200 }
  ok(keyTaken(k, jobs, "tree:1,1", 300, 600), "a failed job still takes its key during the cooldown")
  delete jobs[7] // the board prunes finished jobs
  ok(keyTaken(k, jobs, "tree:1,1", 700, 600), "remembered after the board forgot the job")
  ok(!keyTaken(k, jobs, "tree:1,1", 800, 600), "free once the cooldown is over")
  k.jobKeys["ore:2,2"] = 8
  jobs[8] = { status: "done", finishedTick: 900 }
  ok(!keyTaken(k, jobs, "ore:2,2", 901, 600), "a done job frees its key at once")
})

test("B82: failed keys past the cooldown are pruned", () => {
  const k = { jobKeys: {}, failedKeys: { a: 0, b: 500 } as Record<string, number> }
  pruneFailedKeys(k, 700, 600)
  eq(k.failedKeys.a, undefined, "old one pruned")
  eq(k.failedKeys.b, 500, "recent one kept")
})

run("keys")
