// T1: brands are a compile-time vocabulary only. The stored value must stay the plain string/number an old save has,
// so constructing one never changes it and two boundaries naming the same id agree at runtime.

import { connectionId, goalId, layoutClaimTag, worldClaimTag, jobId, moduleId, poleId, poleLineId, routeId } from "../src/shared/ids"
import { eq, run, test } from "./harness"

test("branded ids are the same value at runtime", () => {
  eq(moduleId("m1"), "m1")
  eq(goalId("g1"), "g1")
  eq(routeId("route:r1"), "route:r1")
  eq(connectionId("ore"), "ore")
  eq(poleLineId("poles:g1:0"), "poles:g1:0")
  eq(poleId("poles:g1:0.1"), "poles:g1:0.1")
  eq(jobId(7), 7)
  eq(layoutClaimTag("m:m1"), "m:m1")
  eq(worldClaimTag("site:1"), "site:1")
})

run("ids")
