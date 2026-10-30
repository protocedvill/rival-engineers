import { labArray } from "../src/modules/generators"
import { moduleId } from "../src/shared/ids"
import { checkClaimOwners } from "../src/planner/claims"
import { commitModule, LayoutState, markModule, newLayout, PlacedModule, removeModule } from "../src/planner/layout"
import { eq, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1, B63: one module entry per id, and removing an id releases every entry's claims. `commitModule` used to push
// unconditionally while `findModule` returns the first match and a removal filtered *all* entries with the id: the
// second entry's `occ`/`reserved` claims survived (`checkClaimOwners`: "names missing interaction owner"), and every
// later plan that cloned the layout was discarded as `invalid-layout-claims`.

function mk(id: string, x: number, y: number): PlacedModule {
  const def = labArray(F, { labs: 2, packs: ["automation-science-pack"] })
  return { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h } }
}

test("B63: committing a module id twice keeps one entry and leaves no orphan claims", () => {
  const l: LayoutState = newLayout()
  commitModule(l, mk("dup", 10, 10), F, 2)
  commitModule(l, mk("dup", 10, 10), F, 2)
  eq(l.modules.length, 1, "one entry per id")
  eq(checkClaimOwners(l).length, 0, `no orphan claims: ${checkClaimOwners(l).slice(0, 3).join("; ")}`)
  removeModule(l, moduleId("dup"), F)
  eq(l.modules.length, 0, "removed")
  eq(checkClaimOwners(l).length, 0, `no orphan claims after removal: ${checkClaimOwners(l).slice(0, 3).join("; ")}`)
})

test("B63: a duplicate already in the layout (a save from before the guard) is released whole", () => {
  const l: LayoutState = newLayout()
  commitModule(l, mk("dup", 10, 10), F, 2)
  // The legacy shape: a second entry for the same id, with its own claims.
  const second = mk("dup", 30, 30)
  markModule(l, second, F, 2)
  l.modules.push(second)
  eq(l.modules.length, 2, "two entries exist")
  eq(checkClaimOwners(l).length, 0, "the duplicate is self-consistent while both are present")
  removeModule(l, moduleId("dup"), F)
  eq(l.modules.length, 0, "both entries removed")
  eq(checkClaimOwners(l).length, 0, `every entry released its claims: ${checkClaimOwners(l).slice(0, 3).join("; ")}`)
})

run("module-claims")
