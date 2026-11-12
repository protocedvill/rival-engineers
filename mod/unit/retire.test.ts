import { eq, run, test } from "./harness"
import { beginRetire, pruneRetiring, replacement, RetireFeed, RetireRecord, shouldRetire } from "../src/strategy/retire"

// T1: D76 retirement (replaces goalpost 1's verified handover). A retiring provider keeps producing until its drills run
// dry or every consumer port it feeds is also fed by a built provider that did not feed that port when it began.

function feed(role: string, port: string, built = true): RetireFeed {
  return { role, port, built }
}

test("retire: a role is marked once and keeps its first reason and the feeds it already had", () => {
  const records: Record<string, RetireRecord> = {}
  const feeds = [feed("coal>power", "power.in-fuel"), feed("coal>power~2", "power.in-fuel"), feed("coal>mall", "mall.in-coal")]
  eq(beginRetire(records, "coal>power", "n27", 100, "worked out", feeds), true)
  eq(beginRetire(records, "coal>power", "n27", 900, "second reason", []), false)
  eq(records["coal>power"].since, 100)
  eq(records["coal>power"].why, "worked out")
  eq(records["coal>power"].had.join(","), "coal>power~2@power.in-fuel", "only feeds into its own ports")
})

test("retire: a provider that already fed its port when retirement began is not its replacement", () => {
  const records: Record<string, RetireRecord> = {}
  const feeds = [feed("coal>power", "power.in-fuel"), feed("coal>power~2", "power.in-fuel")]
  beginRetire(records, "coal>power", "n27", 100, "low", feeds)
  const r = records["coal>power"]
  eq(replacement(r, feeds), undefined)
  // The design's replacement (`~3`) is planned, not built: still waiting.
  eq(shouldRetire(r, false, [...feeds, feed("coal>power~3", "power.in-fuel", false)]), false)
  eq(replacement(r, [...feeds, feed("coal>power~3", "power.in-fuel")]), "coal>power~3")
})

test("retire: every port it feeds must be covered; dry drills retire it at once", () => {
  const records: Record<string, RetireRecord> = {}
  const feeds = [feed("ore", "smelt.in-ore"), feed("ore", "mall.in-ore")]
  beginRetire(records, "ore", "n5", 0, "lead", feeds)
  const r = records["ore"]
  eq(shouldRetire(r, false, [...feeds, feed("ore~2", "smelt.in-ore")]), false, "one port still waits")
  eq(shouldRetire(r, false, [...feeds, feed("ore~2", "smelt.in-ore"), feed("ore~3", "mall.in-ore")]), true)
  eq(shouldRetire(r, true, feeds), true, "dry")
  // A burner outpost whose replacement can never be built keeps producing (no time limit).
  eq(shouldRetire(r, false, feeds), false)
  eq(replacement(r, []), "", "it feeds nothing any more")
})

test("retire: a new provider of the same family feeding other consumers is not a replacement (fixed seed 222)", () => {
  // The family's first mine fed the first smelter; `~2` fed the parallel smelter. A new first-family mine for the
  // first smelter must not retire `~2`, whose smelter would starve.
  const records: Record<string, RetireRecord> = {}
  const feeds = [feed("ore>plate", "n15.in-ore"), feed("ore>plate~2", "n29.in-ore")]
  beginRetire(records, "ore>plate~2", "n25", 0, "lead", feeds)
  eq(shouldRetire(records["ore>plate~2"], false, [...feeds, feed("ore>plate~3", "n15.in-ore")]), false)
})

test("retire: records of roles gone from the graph are dropped", () => {
  const records: Record<string, RetireRecord> = {}
  beginRetire(records, "a", "n1", 0, "x", [])
  beginRetire(records, "b", "n2", 0, "y", [])
  eq(pruneRetiring(records, ["b"]), true)
  eq(records.a, undefined)
  eq(pruneRetiring(records, []), false)
})

run("retire")
