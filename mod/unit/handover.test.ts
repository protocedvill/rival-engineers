import { eq, run, test } from "./harness"
import { beginHandover, HandoverFeed, HandoverRecord, handoverVerdict, pruneHandovers, servedPorts } from "../src/strategy/handover"

function feed(role: string, toModule: string, toPort: string, built = true): HandoverFeed {
  return { role, node: `${role}-node`, toModule, toPort, built }
}

function record(role = "coal>power#4", since = 0): HandoverRecord {
  return { role, node: `${role}-node`, since, why: "worked out" }
}

test("handover: a role is marked once and keeps its first reason", () => {
  const records: Record<string, HandoverRecord> = {}
  eq(beginHandover(records, "coal>power#4", "n27", 100, "worked out"), true)
  eq(beginHandover(records, "coal>power#4", "n27", 900, "second reason"), false)
  eq(records["coal>power#4"].since, 100)
  eq(records["coal>power#4"].why, "worked out")
})

test("handover: the ports a role feeds are distinct and in feed order", () => {
  const feeds = [feed("old", "power", "in-fuel"), feed("old", "power", "in-fuel"), feed("old", "mall", "in-coal"), feed("other", "labs", "in-x")]
  eq(servedPorts(feeds, "old").join(","), "power.in-fuel,mall.in-coal")
  eq(servedPorts(feeds, "missing").length, 0)
})

test("handover: waiting while no built replacement covers every port", () => {
  const r = record()
  // Only the retiring provider feeds: nothing to replace it yet.
  eq(handoverVerdict(r, [feed("coal>power#4", "power", "in-fuel")], 60, 10), "waiting")
  // The replacement exists but is still being built.
  eq(handoverVerdict(r, [feed("coal>power#4", "power", "in-fuel"), feed("coal>power#5", "power", "in-fuel", false)], 60, 10), "waiting")
  // One port covered, another not: still waiting.
  const two = [feed("coal>power#4", "power", "in-fuel"), feed("coal>power#4", "mall", "in-coal"), feed("coal>power#5", "power", "in-fuel")]
  eq(handoverVerdict(r, two, 60, 10), "waiting")
})

test("handover: complete once a built replacement covers every port", () => {
  const r = record()
  const feeds = [feed("coal>power#4", "power", "in-fuel"), feed("coal>power#4", "mall", "in-coal"), feed("coal>power#5", "power", "in-fuel"), feed("coal>power#6", "mall", "in-coal")]
  eq(handoverVerdict(r, feeds, 60, 10), "complete")
  // A built replacement that feeds a different item's port does not count.
  const wrong = [feed("coal>power#4", "power", "in-fuel"), feed("coal>power#5", "power", "in-water")]
  eq(handoverVerdict(r, wrong, 60, 10), "waiting")
})

test("handover: a role that feeds nothing may be retired at once", () => {
  eq(handoverVerdict(record(), [], 0, 10), "complete")
  eq(handoverVerdict(record(), [feed("someone-else", "power", "in-fuel")], 0, 10), "complete")
})

test("handover: stalled only after the wait limit, so a replacement that can never exist cannot starve forever", () => {
  const r = record("coal>power#4", 1000)
  const feeds = [feed("coal>power#4", "power", "in-fuel")]
  eq(handoverVerdict(r, feeds, 1000 + 10 * 3600 - 1, 10), "waiting")
  eq(handoverVerdict(r, feeds, 1000 + 10 * 3600, 10), "stalled")
})

test("handover: records of roles that left the graph are dropped", () => {
  const records: Record<string, HandoverRecord> = {}
  beginHandover(records, "a", "n1", 0, "x")
  beginHandover(records, "b", "n2", 0, "y")
  eq(pruneHandovers(records, ["a", "b"]), true)
  eq(pruneHandovers(records, ["a"]), true)
  eq(records.b, undefined)
  eq(pruneHandovers(records, []), false)
  eq(records.a, undefined)
})

run("handover")
