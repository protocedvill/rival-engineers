import { exhausted } from "../src/shared/exhausted"
import { eq, ok, run, test } from "./harness"

// T1: the knowledge-failure rule. A plan failure that proves the known ground is exhausted must be recognised on the
// first attempt (it fires exploration / a site pause immediately instead of burning the goal's attempts and the soak's
// fail-fast budget). Seed 1376111 produced all three shapes below in eight consecutive failures.

test("a mine with no room on any known patch is a patch knowledge failure", () => {
  const e = exhausted("module n58 (iron-ore*>iron-plate*>mall#2): no feasible position (1 of 1 patches tried)")
  ok(e !== undefined, "recognised")
  eq(e!.kind, "patch", "kind")
  eq(e!.what, "iron-ore", "resource name, without the shared-producer `*`")
})

test("a mine with no room keeps the shared-producer marker out of the resource name", () => {
  const e = exhausted("module n12 (coal*>iron-plate*>logistic-science-pack>labs#3): no feasible position (2 of 2 patches tried)")
  ok(e !== undefined, "recognised")
  eq(e!.what, "coal", "coal, not coal*")
})

test("no free patch anywhere in the region is an ore knowledge failure", () => {
  const e = exhausted("no free iron-ore patch in the region")
  ok(e !== undefined, "recognised")
  eq(e!.kind, "ore", "kind")
  eq(e!.what, "iron-ore", "resource")
})

test("no site of a kind in the region is a site knowledge failure", () => {
  const e = exhausted("no steam site in the region")
  ok(e !== undefined, "recognised")
  eq(e!.kind, "site", "kind")
  eq(e!.what, "steam", "site name")
})

test("a contested or broken failure is not a knowledge failure", () => {
  eq(exhausted(undefined), undefined, "no reason")
  eq(exhausted("no feasible merge target for route"), undefined, "merge target")
  eq(exhausted("occ -62,-484 names missing interaction owner n3"), undefined, "claim leak")
  eq(exhausted("iron-plate>labs => labs.in-ore: no path"), undefined, "a route that found no room is not exhaustion")
})

run("exhausted")
