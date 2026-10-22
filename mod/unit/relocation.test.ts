// T1: a relocated module's replacement goal waits for the old clear jobs (D55/P36). Otherwise it plans over a footprint
// the terrain still reports as OWN and fails every attempt in a few game-seconds (B59, seed 3333).

import { jobId } from "../src/shared/ids"
import { pendingRelocation, pruneRelocations } from "../src/strategy/relocation"
import { eq, ok, run, test } from "./harness"

test("a replacement waits only while one of its clear jobs is active", () => {
  const active = [jobId(4), jobId(9)]
  const relocation = { "coal>power": [jobId(4), jobId(5)], labs: [jobId(7)] }
  eq(pendingRelocation(relocation, ["labs", "coal>power"], active), "coal>power", "first held role")
  eq(pendingRelocation(relocation, ["labs"], active), undefined, "finished role")
  eq(pendingRelocation(undefined, ["coal>power"], active), undefined, "no relocations")
})

test("pruning drops finished roles and keeps busy ones", () => {
  const active = [jobId(9)]
  const relocation = { "coal>power": [jobId(4)], labs: [jobId(9)] }
  eq(pruneRelocations(relocation, active), true, "labs still busy")
  ok(relocation["coal>power"] === undefined, "finished role dropped")
  eq(relocation.labs?.length, 1, "busy role kept")
  eq(pruneRelocations(relocation, []), false, "nothing left")
  ok(relocation.labs === undefined, "busy role dropped once done")
})

run("relocation")
