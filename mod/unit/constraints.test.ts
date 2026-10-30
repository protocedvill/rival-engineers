import { eq, run, test } from "./harness"
import * as CS from "../src/strategy/constraints"

// T1: D69 constraint store. One store with scoped keys replaces a flag map per bug on the factory state.

test("constraints: a flag is added once; has/flags/keys read it", () => {
  const s: CS.ConstraintStore = {}
  eq(CS.add(s, "noTap", "coal>power"), true)
  eq(CS.add(s, "noTap", "coal>power"), false, "not new")
  eq(CS.has(s, "noTap", "coal>power"), true)
  eq(CS.has(s, "noTap", "iron"), false)
  eq(CS.has(undefined, "noTap", "coal>power"), false)
  CS.add(s, "noTap", "a")
  eq(CS.keys(s, "noTap").join(","), "a,coal>power", "sorted")
  eq(CS.flags(s, "noTap")!["a"], true)
  eq(CS.flags(s, "noMerge"), undefined, "no flags of a kind: undefined")
})

test("constraints: counting kinds hold numbers", () => {
  const s: CS.ConstraintStore = {}
  eq(CS.value(s, "growFails", "r"), undefined)
  CS.setValue(s, "growFails", "r", 2)
  eq(CS.value(s, "growFails", "r"), 2)
  eq(CS.values(s, "growFails")!["r"], 2)
  CS.clear(s, "growFails")
  eq(CS.value(s, "growFails", "r"), undefined)
})

test("constraints: dropping a provider role drops its provider and feed entries, not ports or items", () => {
  const s: CS.ConstraintStore = {}
  CS.add(s, "noTap", "coal>power")
  CS.add(s, "providerShort", "coal>power")
  CS.setValue(s, "growFails", "coal>power", 3)
  CS.setValue(s, "cluster1Caps", "coal>power", 0.5)
  CS.add(s, "providerNoTap", CS.feedKey("coal>power", "power", "in-fuel"))
  CS.add(s, "providerNoTap", CS.feedKey("coal>power~2", "power", "in-fuel"))
  CS.add(s, "noMerge", CS.portKey("coal>power", "in"))
  CS.add(s, "fallback", "coal")
  CS.dropRole(s, "coal>power")
  eq(CS.has(s, "noTap", "coal>power") || CS.has(s, "providerShort", "coal>power"), false)
  eq(CS.value(s, "growFails", "coal>power"), undefined)
  eq(CS.value(s, "cluster1Caps", "coal>power"), undefined)
  eq(CS.keys(s, "providerNoTap").join(","), "coal>power~2=>power.in-fuel", "only its own feeds")
  eq(CS.has(s, "noMerge", "coal>power.in"), true, "a consumer port stays")
  eq(CS.has(s, "fallback", "coal"), true, "an item stays")
})

test("constraints: a pre-D69 save's maps move into the store", () => {
  const state: Record<string, unknown> = { noTap: { a: true }, growFails: { b: 2 }, other: 1 }
  const s = CS.adoptLegacy(state, undefined)!
  eq(CS.has(s, "noTap", "a"), true)
  eq(CS.value(s, "growFails", "b"), 2)
  eq(state.noTap, undefined, "moved, not copied")
  eq(state.other, 1)
  eq(CS.adoptLegacy({}, undefined), undefined, "nothing to move")
})

run("constraints")
