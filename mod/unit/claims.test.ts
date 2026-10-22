import {
  checkClaimOwners,
  claimInteractionTile,
  claimMineTile,
  claimModuleTile,
  claimPoleTile,
  claimRouteTile,
  claimSoftTile,
  claimsAt,
  laneClaimConflict,
  moduleGrowthClaimConflict,
  placementClaimConflict,
  poleClaimConflict,
  releaseInteractionTile,
  releaseLaneReservation,
  releaseMineClaims,
  releaseModuleTile,
  releasePoleTile,
  releaseReservation,
  releaseRouteTile,
  releaseSoftClaims,
  reserveFreeTile,
  reserveTile,
  routeClaimConflict,
} from "../src/planner/claims"
import { laneTag, portTag } from "../src/planner/claim-tags"
import { tkey } from "../src/planner/grid"
import { newLayout, Route } from "../src/planner/layout"
import { eq, ok, run, test } from "./harness"

test("claims expose every existing index through one typed vocabulary", () => {
  const state = newLayout()
  const k = tkey(3, 4)
  state.occ[k] = "x:poles:g1:0"
  state.reserved[k] = "lane:p:m1.in"
  state.routeOcc[k] = "route:r1"
  state.mine = { [k]: "m1" }
  state.soft = { [k]: "m1" }
  const claims = claimsAt(state, k)
  eq(claims.map((c) => c.kind).join(","), "pole-line,lane-reservation,route,mine-growth,soft-growth")
  eq(claims.map((c) => c.strength).join(","), "evictable,hard,evictable,hard,soft")
})

test("typed conflict queries preserve route, placement, pole and lane policies", () => {
  const state = newLayout()
  const k = tkey(1, 1)
  state.occ[k] = "x:poles:g1:0"
  eq(routeClaimConflict(state, k, {}, undefined, "to", false), undefined, "routes evict poles")
  ok(poleClaimConflict(state, k)?.code === "occupied", "poles do not overlap poles")
  eq(placementClaimConflict(state, k), undefined, "placements evict poles")

  delete state.occ[k]
  state.reserved[k] = "p:to.in"
  eq(routeClaimConflict(state, k, { "p:to.in": true }, undefined, "to", false), undefined, "own port")
  ok(laneClaimConflict(state, k, "p:to.in", "lane:p:to.in") === undefined, "own lane")
  ok(placementClaimConflict(state, k)?.code === "reserved", "placement reservation")

  delete state.reserved[k]
  state.routeOcc[k] = "route:r1"
  eq(routeClaimConflict(state, k, {}, undefined, "to", true), undefined, "rippable route")
  state.routes["route:r1"] = { fixed: true } as Route
  ok(routeClaimConflict(state, k, {}, undefined, "to", true)?.code === "routed", "fixed route")
})

test("module growth policy admits its own ground and refuses every other claim", () => {
  const state = newLayout()
  const k = tkey(1, 1)
  eq(moduleGrowthClaimConflict(state, k, "m1"), undefined, "free ground")
  claimModuleTile(state, k, "m1")
  eq(moduleGrowthClaimConflict(state, k, "m1"), undefined, "its own footprint")
  ok(moduleGrowthClaimConflict(state, k, "m2")?.code === "occupied", "another module's footprint")
  releaseModuleTile(state, k, "m1")

  reserveTile(state, k, portTag("m1", "in"))
  eq(moduleGrowthClaimConflict(state, k, "m1"), undefined, "its own port reservation")
  ok(moduleGrowthClaimConflict(state, k, "m2")?.code === "reserved", "another port's reservation")
  reserveTile(state, k, portTag("m2", "in"))
  ok(moduleGrowthClaimConflict(state, k, "m1")?.code === "reserved")
  releaseReservation(state, k, portTag("m2", "in"))

  claimRouteTile(state, k, "route:r1")
  ok(moduleGrowthClaimConflict(state, k, "m1")?.code === "routed", "routes never give way to growth")
  releaseRouteTile(state, k, "route:r1")

  claimMineTile(state, k, "m2")
  ok(moduleGrowthClaimConflict(state, k, "m1")?.code === "mine-claimed", "another mine's growth claim")
  eq(moduleGrowthClaimConflict(state, k, "m2"), undefined, "its own mine claim")
  releaseMineClaims(state, "m2")

  claimPoleTile(state, k, "poles:g1:0")
  eq(moduleGrowthClaimConflict(state, k, "m1"), undefined, "pole lines give way")
})

test("claim writes pair every add with an ownership-checked remove", () => {
  const state = newLayout()
  const k = tkey(5, 5)
  claimModuleTile(state, k, "m1")
  eq(state.occ[k], "m:m1")
  ok(!releaseModuleTile(state, k, "m2"), "another module cannot free the tile")
  ok(releaseModuleTile(state, k, "m1"), "its owner can")
  eq(state.occ[k], undefined)

  ok(claimInteractionTile(state, k, "m1"), "a free tile takes an interaction claim")
  ok(!claimInteractionTile(state, k, "m2"), "an occupied tile does not")
  ok(releaseInteractionTile(state, k, "m1"))
  eq(state.occ[k], undefined)

  claimPoleTile(state, k, "poles:g1:0")
  ok(!releasePoleTile(state, k, "poles:g1:1"), "another line cannot free the tile")
  ok(releasePoleTile(state, k, "poles:g1:0"))

  reserveTile(state, k, portTag("m1", "in"))
  ok(!releaseReservation(state, k, portTag("m2", "in")), "another port cannot free the tile")
  ok(releaseReservation(state, k, portTag("m1", "in")))
  ok(reserveFreeTile(state, k, laneTag(portTag("m1", "in"))), "a free tile takes a lane")
  ok(!reserveFreeTile(state, k, "lane:other"), "a reserved tile does not")
  ok(releaseLaneReservation(state, k), "the lane goes when the plan ends")
  eq(state.reserved[k], undefined)
})

test("mine and soft writes stay paired and refuse occupied ground", () => {
  const state = newLayout()
  const a = tkey(1, 1)
  const b = tkey(2, 1)
  claimModuleTile(state, b, "m1")
  ok(!claimMineTile(state, b, "m1"), "an occupied tile is not claimable")
  ok(claimMineTile(state, a, "m1"))
  ok(claimSoftTile(state, a, "m1", 3))
  eq(state.softUnit?.[a], 3)
  ok(!claimSoftTile(state, a, "m2", 0), "a claimed tile is not re-claimed")
  eq(releaseMineClaims(state, "m2"), 0)
  eq(releaseMineClaims(state, "m1"), 1)
  eq(releaseSoftClaims(state, "m1"), 1)
  eq(state.mine?.[a], undefined)
  eq(state.soft?.[a], undefined)
  eq(state.softUnit?.[a], undefined)
})

test("claim ownership checks find orphaned and one-sided index entries", () => {
  const state = newLayout()
  state.occ[tkey(1, 1)] = "m:gone"
  state.reserved[tkey(2, 1)] = "p:gone.in"
  state.mine = { [tkey(3, 1)]: "gone" }
  state.softUnit = { [tkey(4, 1)]: 2 }
  const problems = checkClaimOwners(state)
  ok(problems.some((p) => p.indexOf("missing module gone") >= 0), problems.join("; "))
  ok(problems.some((p) => p.indexOf("missing port owner p:gone.in") >= 0), problems.join("; "))
  ok(problems.some((p) => p.indexOf("soft unit 4,1 has no soft claim") >= 0), problems.join("; "))
})

run("claims")
