import { miningOutpost, smelterColumn } from "../src/modules/generators"
import { beltTiers } from "../src/planner/capacity"
import { FREE, TerrainView, UNKNOWN } from "../src/planner/grid"
import { planGrowth } from "../src/planner/grow"
import { checkLayout, commitModule, findModule, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { ConnectionRequest, newRoutingJob, runJob } from "../src/planner/plan"
import { selectPolicy } from "../src/planner/policy"
import { ModuleDef } from "../src/modules/types"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: growing a built module in place (expand-first): new units, moved entities, rerouted ports, entity diff.

const POLICY = selectPolicy("early-compact", {})
const TIER = beltTiers(F)[0]

function free(w: number, h: number): TerrainView {
  return { block: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? UNKNOWN : FREE), ore: () => undefined }
}

function place(l: LayoutState, id: string, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id, canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(l, m, F, 2)
  return m
}

test("a built 4-furnace smelter grows to 8: 4 furnaces added, the moved end rebuilt, its routes rerouted and valid", () => {
  const view = free(90, 90)
  const l = newLayout()
  const smelter = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const ore = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  place(l, "smelt", smelter, 40, 20)
  place(l, "mine", ore, 44, 60)
  const conns: ConnectionRequest[] = [{ id: "ore", from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } }]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: 45, y: 45 }, region: { x: 0, y: 0, w: 90, h: 90 } }, TIER, l), view, F, POLICY)
  eq(job.phase, "done", "routed")
  const g = planGrowth(job.layout, view, F, POLICY, TIER, "smelt", 1)
  ok(g.ok, `grown: ${g.reason}`)
  const m = findModule(g.layout, "smelt")!
  eq(m.canonical.params?.furnaces, 4, "params of the base def kept")
  let furnaces = 0
  for (const e of m.def.entities) if (e.name === "stone-furnace") furnaces++
  eq(furnaces, 8, "8 furnaces")
  let added = 0
  for (const e of g.add) if (e.name === "stone-furnace") added++
  eq(added, 4, "4 furnaces to build")
  for (const e of g.remove) ok(e.name !== "stone-furnace", "no furnace picked up")
  ok(g.remove.length > 0, "the moved end is picked up")
  eq(g.rerouted.join(","), "ore", "the ore route rerouted")
  const problems = checkLayout(g.layout, view, () => 5).problems
  eq(problems.length, 0, problems.join("; "))
})

run("grow")
