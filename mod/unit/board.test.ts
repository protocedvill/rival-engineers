import {
  addJob,
  Board,
  chooseStandingSpot,
  claim,
  complete,
  countReady,
  distance,
  fitMaterials,
  isReady,
  missingMaterials,
  newBoard,
  planBatch,
  planTrip,
  Pos,
  Rect,
  release,
  releaseAllOf,
  selectJob,
} from "../src/jobs/board"
import { eq, ok, run, test } from "./harness"

const RELEASE = { penalize: true, maxAttempts: 3, retryTicks: 100 }

function place(board: Board, x: number, y: number, priority = 0, deps: number[] = []): number {
  const footprint: Rect = { x1: x - 0.5, y1: y - 0.5, x2: x + 0.5, y2: y + 0.5 }
  return addJob(board, { kind: "place", pos: { x, y }, footprint, priority, deps, payload: undefined }, 0).id
}

test("selectJob: highest priority wins over distance", () => {
  const b = newBoard()
  place(b, 1, 0, 0)
  const far = place(b, 50, 0, 5)
  eq(selectJob(b, { x: 0, y: 0 }, 0)!.id, far, "priority first")
})

test("selectJob: nearest among equal priority, ties broken by id", () => {
  const b = newBoard()
  place(b, 10, 0)
  const near = place(b, 3, 0)
  eq(selectJob(b, { x: 0, y: 0 }, 0)!.id, near, "nearest")
  const c = newBoard()
  const first = place(c, 0, 5)
  place(c, 5, 0)
  eq(selectJob(c, { x: 0, y: 0 }, 0)!.id, first, "equal distance: lower id")
})

test("selectJob: accept filter vetoes candidates", () => {
  const b = newBoard()
  const a = place(b, 1, 0)
  const c = place(b, 2, 0)
  eq(selectJob(b, { x: 0, y: 0 }, 0, (j) => j.id !== a)!.id, c)
})

test("deps: a job is ready only once every dependency is done", () => {
  const b = newBoard()
  const base = place(b, 0, 0)
  const top = place(b, 0, 0, 10, [base])
  ok(!isReady(b, b.jobs[top], 0), "dependent not ready")
  eq(selectJob(b, { x: 0, y: 0 }, 0)!.id, base, "the dependency is picked despite lower priority")
  ok(claim(b, [base], 1, 0))
  ok(!isReady(b, b.jobs[top], 0), "claimed dependency is not done")
  ok(complete(b, base, 1, 5))
  ok(isReady(b, b.jobs[top], 5), "ready after the dependency is done")
})

test("claims are exclusive and all-or-nothing", () => {
  const b = newBoard()
  const j1 = place(b, 0, 0)
  const j2 = place(b, 1, 0)
  ok(claim(b, [j1], 1, 0), "first claim")
  ok(!claim(b, [j1], 2, 0), "second member refused")
  eq(b.jobs[j1].claimedBy, 1, "claim kept by the first member")
  eq(b.counters.doubleClaims, 1, "double claim counted")
  ok(!claim(b, [j2, j1], 2, 0), "batch containing a claimed job refused")
  eq(b.jobs[j2].status, "open", "nothing in the refused batch was claimed")
  eq(countReady(b, 0), 1, "one ready job left")
  ok(!complete(b, j1, 2, 0), "only the claimant can complete")
  ok(complete(b, j1, 1, 0))
  eq(b.counters.claims, 1)
  eq(b.counters.completions, 1)
})

test("release: back-off doubles, then the job fails with the reason", () => {
  const b = newBoard()
  const j = place(b, 0, 0)
  ok(claim(b, [j], 1, 0))
  ok(release(b, j, 1, 10, { ...RELEASE, reason: "cannot-place" }))
  eq(b.jobs[j].retryAt, 110, "first back-off")
  ok(!isReady(b, b.jobs[j], 109), "not before the back-off")
  ok(claim(b, [j], 2, 110), "another member may retry")
  ok(release(b, j, 2, 120, { ...RELEASE, reason: "cannot-place" }))
  eq(b.jobs[j].retryAt, 320, "second back-off doubled")
  ok(claim(b, [j], 1, 320))
  ok(release(b, j, 1, 330, { ...RELEASE, reason: "cannot-place" }))
  eq(b.jobs[j].status, "failed", "failed after max attempts")
  eq(b.jobs[j].reason, "cannot-place")
  eq(b.active.length, 0, "failed jobs leave the active list")
})

test("a failed job fails its dependents, but not unrelated jobs", () => {
  const b = newBoard()
  const base = place(b, 0, 0)
  const mid = place(b, 0, 0, 0, [base])
  const top = place(b, 0, 0, 0, [mid])
  const other = place(b, 9, 9)
  ok(claim(b, [base], 1, 0))
  ok(release(b, base, 1, 0, { reason: "blocked", penalize: true, maxAttempts: 1, retryTicks: 1 }))
  eq(b.jobs[mid].status, "failed")
  eq(b.jobs[top].reason, `dep-failed:${mid}`, "transitive")
  eq(b.jobs[other].status, "open", "unrelated job untouched")
  eq(selectJob(b, { x: 0, y: 0 }, 0)!.id, other)
})

test("releaseAllOf (crew death) releases without penalty", () => {
  const b = newBoard()
  const j1 = place(b, 0, 0)
  const j2 = place(b, 1, 0)
  const j3 = place(b, 2, 0)
  ok(claim(b, [j1, j2], 7, 0))
  ok(claim(b, [j3], 8, 0))
  const released = releaseAllOf(b, 7, 50, "crew-invalid")
  eq(released.length, 2)
  eq(b.jobs[j1].attempts, 0, "no attempt counted")
  ok(isReady(b, b.jobs[j1], 50) && isReady(b, b.jobs[j2], 50), "immediately claimable")
  eq(b.jobs[j3].claimedBy, 8, "other member's claim kept")
})

test("chooseStandingSpot: reaches every target, avoids footprints, nearest to the walker", () => {
  const targets: Pos[] = [
    { x: 0.5, y: 0.5 },
    { x: 4.5, y: 0.5 },
  ]
  const avoid: Rect[] = [
    { x1: 0, y1: 0, x2: 1, y2: 1 },
    { x1: 4, y1: 0, x2: 5, y2: 1 },
  ]
  const from = { x: 2.5, y: 20 }
  const spot = chooseStandingSpot(targets, avoid, from, 6)!
  ok(spot !== undefined, "found a spot")
  for (const t of targets) ok(distance(spot, t) <= 6, "in reach")
  for (const r of avoid) ok(!(spot.x > r.x1 - 0.3 && spot.x < r.x2 + 0.3 && spot.y > r.y1 - 0.3 && spot.y < r.y2 + 0.3), "outside footprints")
  ok(spot.y > 1, "on the walker's side")
  eq(chooseStandingSpot([{ x: 0, y: 0 }, { x: 30, y: 0 }], [], from, 6), undefined, "too spread out")
  const vetoed = chooseStandingSpot(targets, avoid, from, 6, (p) => p.y < 3, 1000)!
  ok(vetoed.y < 3, "runtime veto respected")
  eq(chooseStandingSpot(targets, avoid, from, 6, (p) => p.y < 3, 5), undefined, "bounded number of runtime checks")
})

test("planBatch: groups nearby ready jobs, skips far and claimed ones, respects maxJobs", () => {
  const b = newBoard()
  const ids: number[] = []
  for (let i = 0; i < 6; i++) ids.push(place(b, i + 0.5, 0.5))
  const far = place(b, 40.5, 0.5)
  const claimed = place(b, 2.5, 2.5)
  ok(claim(b, [claimed], 9, 0))
  const anchor = b.jobs[ids[0]]
  const batch = planBatch(b, anchor, { x: 0, y: 10 }, 0, { reach: 8, maxJobs: 4 })
  eq(batch.jobs.length, 4, "capped at maxJobs")
  eq(batch.jobs[0], anchor.id, "anchor first")
  ok(batch.jobs.indexOf(far) < 0 && batch.jobs.indexOf(claimed) < 0, "no far or claimed jobs")
  ok(batch.spot !== undefined, "has a spot")
  for (const id of batch.jobs) ok(distance(batch.spot!, b.jobs[id].pos) <= 8, "every job reachable from the spot")
  const all = planBatch(b, anchor, { x: 0, y: 10 }, 0, { reach: 8, maxJobs: 20 })
  eq(all.jobs.length, 6, "all six nearby")
})

test("simulation: two members drain a board with no double claims", () => {
  const b = newBoard()
  for (let x = 0; x < 10; x++) for (let y = 0; y < 4; y++) place(b, x * 2 + 0.5, y * 3 + 0.5, 0)
  const pos: Record<number, Pos> = { 1: { x: -5, y: 0 }, 2: { x: 25, y: 10 } }
  const held: Record<number, number[]> = { 1: [], 2: [] }
  const doneBy: Record<number, number> = {}
  for (let tick = 0; tick < 200 && b.active.length > 0; tick++) {
    for (const m of [1, 2]) {
      if (held[m].length > 0) {
        // Finish one job per tick.
        const id = held[m].shift()!
        ok(complete(b, id, m, tick), `member ${m} completes ${id}`)
        ok(doneBy[id] === undefined, `job ${id} done once`)
        doneBy[id] = m
        continue
      }
      const anchor = selectJob(b, pos[m], tick)
      if (!anchor) continue
      const batch = planBatch(b, anchor, pos[m], tick, { reach: 8, maxJobs: 6 })
      ok(claim(b, batch.jobs, m, tick), "claim succeeds")
      held[m] = batch.jobs
      if (batch.spot) pos[m] = batch.spot
    }
  }
  eq(b.active.length, 0, "board drained")
  eq(b.counters.completions, 40)
  eq(b.counters.doubleClaims, 0)
  let byOne = 0
  for (const id in doneBy) if (doneBy[id] === 1) byOne++
  ok(byOne > 5 && byOne < 35, `work shared (${byOne}/40 by member 1)`)
})

test("release with a delay (transient failure): no attempt spent, counted as a deferral", () => {
  const b = newBoard()
  const j = place(b, 0, 0)
  ok(claim(b, [j], 1, 0))
  ok(release(b, j, 1, 10, { ...RELEASE, penalize: false, delay: 30, reason: "blocked-by-character" }))
  eq(b.jobs[j].attempts, 0, "no attempt")
  eq(b.jobs[j].deferrals, 1, "one deferral")
  ok(!isReady(b, b.jobs[j], 39) && isReady(b, b.jobs[j], 40), "claimable after the delay")
})

test("planBatch: extraAvoid keeps the spot away from other crew members", () => {
  const b = newBoard()
  const a = place(b, 0.5, 0.5)
  const free = planBatch(b, b.jobs[a], { x: 0.5, y: 5 }, 0, { reach: 8, maxJobs: 1 })
  const blocker = { x1: free.spot!.x - 0.6, y1: free.spot!.y - 0.6, x2: free.spot!.x + 0.6, y2: free.spot!.y + 0.6 }
  const moved = planBatch(b, b.jobs[a], { x: 0.5, y: 5 }, 0, { reach: 8, maxJobs: 1, extraAvoid: [blocker] })
  ok(moved.spot !== undefined && distance(moved.spot, free.spot!) > 0.5, "picked another spot")
})

test("fitMaterials keeps jobs in order while the stock lasts; missingMaterials subtracts what is held", () => {
  const b = newBoard()
  const mk = (item: string, count: number) =>
    b.jobs[addJob(b, { kind: "place", pos: { x: 0, y: 0 }, materials: [{ item, count }], payload: undefined }, 0).id]
  const jobs = [mk("belt", 1), mk("belt", 1), mk("drill", 1), mk("belt", 1)]
  const kept = fitMaterials(jobs, { belt: 2, drill: 1 })
  eq(kept.length, 3, "third belt does not fit")
  eq(kept[2].id, jobs[2].id, "the drill still fits after the belts run out")
  const missing = missingMaterials(kept, { belt: 1 })
  eq(missing.length, 2)
  eq(missing[0].item, "belt", "sorted by name")
  eq(missing[0].count, 1)
  eq(missing[1].item, "drill")
  eq(missingMaterials(kept, { belt: 5, drill: 1 }).length, 0, "nothing missing")
})


function clearJob(board: Board, x: number, y: number, priority = 0): number {
  return addJob(board, { kind: "clear", pos: { x, y }, priority, payload: undefined }, 0).id
}

test("planTrip: chains the nearest jobs from the anchor, within the radius, up to maxJobs", () => {
  const b = newBoard()
  const a = clearJob(b, 0, 0)
  const far = clearJob(b, 30, 0)
  const j3 = clearJob(b, 3, 0)
  const j1 = clearJob(b, 1, 0)
  const j2 = clearJob(b, 2, 1)
  const opts = { maxJobs: 3, radius: 10, accept: () => true, load: () => 0.1, capacity: 10 }
  const trip = planTrip(b, b.jobs[a], 0, opts)
  eq(trip.join(","), [a, j1, j2].join(","), "nearest neighbour chain, capped at 3")
  const all = planTrip(b, b.jobs[a], 0, { ...opts, maxJobs: 10 })
  eq(all.join(","), [a, j1, j2, j3].join(","), "the far job is outside the radius")
  ok(all.indexOf(far) < 0, "far job left out")
})

test("planTrip: stops when the inventory would overflow; skips claimed and refused jobs", () => {
  const b = newBoard()
  const a = clearJob(b, 0, 0)
  const claimed = clearJob(b, 1, 0)
  const refused = clearJob(b, 1, 1)
  const j = clearJob(b, 2, 0)
  clearJob(b, 3, 0)
  claim(b, [claimed], 7, 0)
  const trip = planTrip(b, b.jobs[a], 0, { maxJobs: 10, radius: 10, accept: (job) => job.id !== refused, load: () => 1, capacity: 2.5 })
  eq(trip.join(","), [a, j].join(","), "anchor + one more fit in 2.5 slots")
})

run("board")
