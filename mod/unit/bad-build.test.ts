import { eq, ok, run, test } from "./harness"
import { BAD_BUILD_CAP, BAD_BUILD_RADIUS, BAD_BUILD_TICKS, badBuildRects, recordBadBuild } from "../src/planner/bad-build"

// T1: B144. A plan rejected for a blocker a retry cannot clear (terrain, a foreign entity, a module, or an overlap in
// the plan's own add list) leaves its tiles behind, so the next plan for the same role starts away from them.

test("B144: a bad tile is avoided for its own role and expires", () => {
  const host: { buildBad?: { role: string; x: number; y: number; until: number; reason: string }[] } = {}
  eq(recordBadBuild(host, ["smelter"], [{ x: 10.7, y: -3.2 }], 100, "structure at 10,-4"), 1, "one entry")
  const rects = badBuildRects(host, ["smelter"], 200)
  eq(rects.length, 1, "the role avoids it")
  eq(rects[0].x, 10 - BAD_BUILD_RADIUS, "x around the tile")
  eq(rects[0].y, -4 - BAD_BUILD_RADIUS, "y around the tile")
  eq(badBuildRects(host, ["labs"], 200).length, 0, "another role does not")
  eq(badBuildRects(host, ["smelter"], BAD_BUILD_TICKS + 100).length, 0, "expired")
  eq(host.buildBad!.length, 0, "and dropped")
})

test("B144: recording the same tile again extends it instead of duplicating", () => {
  const host: { buildBad?: { role: string; x: number; y: number; until: number; reason: string }[] } = {}
  recordBadBuild(host, ["smelter"], [{ x: 4, y: 5 }], 0, "first")
  recordBadBuild(host, ["smelter"], [{ x: 4, y: 5 }], 100, "again")
  eq(host.buildBad!.length, 1, "one entry")
  ok(host.buildBad![0].until === BAD_BUILD_TICKS + 100, "extended")
  eq(host.buildBad![0].reason, "again", "reason updated")
})

test("B144: the ledger is capped, dropping the entry that expires first", () => {
  const host: { buildBad?: { role: string; x: number; y: number; until: number; reason: string }[] } = {}
  for (let i = 0; i < BAD_BUILD_CAP + 5; i++) recordBadBuild(host, ["smelter"], [{ x: i, y: 0 }], i, "blocked")
  eq(host.buildBad!.length, BAD_BUILD_CAP, "capped")
  // The oldest (smallest expiry) went first; the newest is still there.
  ok(host.buildBad![0].x > 0, `oldest dropped (${host.buildBad![0].x})`)
  ok(host.buildBad![host.buildBad!.length - 1].x === BAD_BUILD_CAP + 4, "newest kept")
})

run("bad-build")
