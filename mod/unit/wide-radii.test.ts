import { eq, run, test } from "./harness"
import { wideRadii } from "../src/planner/placement"

// T1: B187. A module without a site searched at most the policy's last radius (96) around the plan centre, however wide
// the goal's retries made the region (seed 44444 g212: an 85-tile engine cell, no position on any attempt).

const POLICY = [24, 48, 96]

test("B187: the radius ladder doubles past the policy's radii until it covers the region", () => {
  eq(wideRadii(POLICY, { x: 0, y: 0 }, { x: -252, y: -252, w: 504, h: 504 }).join(","), "24,48,96,192,252", "region radius 252")
  eq(wideRadii(POLICY, { x: 0, y: 0 }, { x: -378, y: -378, w: 756, h: 756 }).join(","), "24,48,96,192,378", "region radius 378")
  // The centre sits off the region's middle (a retry's offset): the far side decides.
  eq(wideRadii(POLICY, { x: 24, y: 0 }, { x: -112, y: -112, w: 224, h: 224 }).join(","), "24,48,96,136", "off-centre")
})

test("B187: a region inside the policy's radii adds nothing", () => {
  eq(wideRadii(POLICY, { x: 0, y: 0 }, { x: -64, y: -64, w: 128, h: 128 }).join(","), "24,48,96", "radius 64")
  eq(wideRadii(POLICY, { x: 0, y: 0 }, { x: -96, y: -96, w: 192, h: 192 }).join(","), "24,48,96", "radius 96 exactly")
})

run("wide-radii")
