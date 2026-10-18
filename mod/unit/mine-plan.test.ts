import { EntityFacts } from "../src/modules/facts"
import { miningOutpost } from "../src/modules/generators"
import { powerCheck } from "../src/modules/poles"
import { EAST, NORTH, SOUTH, WEST } from "../src/modules/types"
import { entityRect } from "../src/modules/geometry"
import { partEntities } from "../src/planner/build-list"
import { FREE, keyX, keyY, Rect, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { commitModule, modulesOnTiles, newLayout, PlacedModule } from "../src/planner/layout"
import { connectedPatch, liveGrowth, materializeMinePlan, planWholePatch } from "../src/planner/mine-plan"
import { placeNow, prepareWholePatchPlacement, tryExpand } from "../src/planner/placement"
import { selectPolicy } from "../src/planner/policy"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

const DRILL: EntityFacts = { name: "electric-mining-drill", type: "mining-drill", tileW: 3, tileH: 3, miningRadius: 2.49 }

function terrain(region: Rect, ore: (this: void, x: number, y: number) => string | undefined): TerrainView {
  return {
    block: (x, y) => (x >= region.x && y >= region.y && x < region.x + region.w && y < region.y + region.h ? FREE : UNKNOWN),
    ore: (x, y) => ore(x, y),
  }
}

test("D52 plans a wide irregular patch in both dimensions", () => {
  const region = { x: 0, y: 0, w: 80, h: 80 }
  const view = terrain(region, (x, y) => {
    const body = x >= 20 && x < 44 && y >= 20 && y < 38
    const arm = x >= 38 && x < 53 && y >= 32 && y < 47
    return body || arm ? "iron-ore" : undefined
  })
  const patch = connectedPatch(view, "iron-ore", [{ x: 25, y: 25 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  ok(plan.drills.length >= 12, `whole plan has ${plan.drills.length} drills`)
  let minX = math.huge
  let maxX = -math.huge
  let minY = math.huge
  let maxY = -math.huge
  for (const d of plan.drills) {
    minX = math.min(minX, d.x)
    maxX = math.max(maxX, d.x)
    minY = math.min(minY, d.y)
    maxY = math.max(maxY, d.y)
  }
  ok(maxX - minX > 9, "drills span several lateral lanes")
  ok(maxY - minY > 9, "drills span several positions along the lanes")
  ok(plan.covered.length >= math.floor(patch.tiles.length * 0.9), `${plan.covered.length}/${patch.tiles.length} patch tiles covered`)
})

test("D52 touching copper is neither joined nor put under an iron drill", () => {
  const region = { x: 0, y: 0, w: 70, h: 50 }
  const view = terrain(region, (x, y) => {
    if (x >= 10 && x < 30 && y >= 12 && y < 38) return "iron-ore"
    if (x >= 30 && x < 48 && y >= 12 && y < 38) return "copper-ore"
    return undefined
  })
  const patch = connectedPatch(view, "iron-ore", [{ x: 15, y: 20 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  eq(patch.tiles.length, 20 * 26, "only iron belongs to the patch")
  for (const d of plan.drills) {
    const x1 = math.floor(d.x - DRILL.miningRadius! + 0.01)
    const x2 = math.ceil(d.x + DRILL.miningRadius! - 0.01)
    const y1 = math.floor(d.y - DRILL.miningRadius! + 0.01)
    const y2 = math.ceil(d.y + DRILL.miningRadius! - 0.01)
    for (let x = x1; x < x2; x++) for (let y = y1; y < y2; y++) ok(view.ore(x, y) !== "copper-ore", `iron drill at ${d.x},${d.y} avoids copper`)
  }
})

test("D52 growth fills any live part of the preplanned patch", () => {
  const region = { x: 0, y: 0, w: 80, h: 60 }
  let depletedLeft = false
  const view = terrain(region, (x, y) => (x >= 12 && x < 62 && y >= 12 && y < 44 && (!depletedLeft || x >= 40) ? "iron-ore" : undefined))
  const patch = connectedPatch(view, "iron-ore", [{ x: 20, y: 20 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  const built: Record<number, boolean> = {}
  for (let i = 0; i < math.floor(plan.drills.length / 2); i++) built[i] = true
  depletedLeft = true
  const add = liveGrowth(plan, view, DRILL, built, 3)
  eq(add.length, 3, "three growth drills remain available")
  for (const d of add) ok(d.x >= 37.5, `growth jumps to live ore at x=${d.x}`)
})

test("D52 materializes one fixed port with partial and complete 2D stages", () => {
  const region = { x: 0, y: 0, w: 80, h: 70 }
  const view = terrain(region, (x, y) => (x >= 14 && x < 58 && y >= 14 && y < 52 ? "iron-ore" : undefined))
  const patch = connectedPatch(view, "iron-ore", [{ x: 20, y: 20 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  const base = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const stages = materializeMinePlan(base, plan, F, { x: 20, y: 20 })!
  const count = (def: typeof stages.full) => def.entities.filter((e) => e.name === "electric-mining-drill").length
  eq(count(stages.initial), 2, "requested initial drill count")
  eq(count(stages.full), plan.drills.length, "complete stage has every planned drill")
  eq(stages.initial.ports[0].pos.x, stages.full.ports[0].pos.x, "output x stays fixed")
  eq(stages.initial.ports[0].pos.y, stages.full.ports[0].pos.y, "output y stays fixed")
  ok(stages.claim.length > stages.occupied.length, "unbuilt drill cells are reserved")
  eq(powerCheck(stages.full.entities, F).unpowered.length, 0, "all planned drills are powered")
})

test("D52 whole-patch output uses the edge nearest the original route", () => {
  const region = { x: 0, y: 0, w: 80, h: 70 }
  const view = terrain(region, (x, y) => (x >= 14 && x < 58 && y >= 14 && y < 52 ? "iron-ore" : undefined))
  const patch = connectedPatch(view, "iron-ore", [{ x: 20, y: 20 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  const base = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const lowNear = plan.axis === "x" ? { x: -100, y: 30 } : { x: 30, y: -100 }
  const highNear = plan.axis === "x" ? { x: 100, y: 30 } : { x: 30, y: 100 }
  const low = materializeMinePlan(base, plan, F, lowNear)!
  const high = materializeMinePlan(base, plan, F, highNear)!
  eq(low.initial.ports[0].dir, plan.axis === "x" ? WEST : NORTH, "low-side consumer selects low-edge output")
  eq(high.initial.ports[0].dir, plan.axis === "x" ? EAST : SOUTH, "high-side consumer selects high-edge output")
  eq(low.initial.footprint.w, high.initial.footprint.w, "output choice keeps the patch footprint width")
  eq(low.initial.footprint.h, high.initial.footprint.h, "output choice keeps the patch footprint height")
})

test("D52 placement reserves the exact 2D plan and growth completes it without moving the port", () => {
  const region = { x: 0, y: 0, w: 100, h: 80 }
  const view = terrain(region, (x, y) => {
    if (x >= 20 && x < 56 && y >= 18 && y < 58) return "iron-ore"
    if (x >= 56 && x < 72 && y >= 18 && y < 58) return "copper-ore"
    return undefined
  })
  const policy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const, searchRadii: [0] }
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), rotatable: false, mirrorable: false }
  const state = newLayout()
  const placed = placeNow({ id: "mine", def: raw, targets: {}, center: { x: 25, y: 25 }, region }, state, view, policy)
  eq(placed.phase, "done", `small placement (${placed.reason})`)
  const m = placed.result!
  prepareWholePatchPlacement(m, view, F, region, policy)
  ok(m.minePlan !== undefined, "whole-patch plan attached")
  for (const k of m.minePlan!.claim) ok(view.ore(keyX(k), keyY(k)) !== "copper-ore", "iron infrastructure never claims touching copper")
  const port = { ...m.def.ports[0].pos }
  const partial = m.def.entities.filter((e) => e.name === "electric-mining-drill").length
  commitModule(state, m, F, policy.corridor.preferred)
  ok(tryExpand(state, view, F, policy, "mine", 1).ok, "completion succeeds")
  const complete = m.def.entities.filter((e) => e.name === "electric-mining-drill").length
  ok(complete > partial, `${partial} drills grow to ${complete}`)
  eq(m.def.ports[0].pos.x, port.x, "port x does not move")
  eq(m.def.ports[0].pos.y, port.y, "port y does not move")
})

test("B21 finds an older module under a later whole-patch claim", () => {
  const base = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const old: PlacedModule = {
    id: "temp",
    canonical: base,
    def: base,
    transform: { rot: 0, mirror: false },
    origin: { x: 10, y: 10 },
    rect: { x: 10, y: 10, w: 5, h: 5 },
  }
  const mine: PlacedModule = {
    id: "mine",
    canonical: base,
    def: base,
    transform: { rot: 0, mirror: false },
    origin: { x: 12, y: 12 },
    rect: { x: 12, y: 12, w: 5, h: 5 },
    minePlan: { full: base, claim: [], occupied: [tkey(12, 12)], complete: false },
  }
  const state = newLayout()
  state.modules.push(old, mine)
  const hits = modulesOnTiles(state, { [tkey(12, 12)]: true })
  eq(hits.length, 2, "both the old blocker and later exact mine are found")
  eq(hits[0].id, "temp", "older blocker remains discoverable")
  const remove = partEntities(state, { modules: ["temp"], routes: [], poles: [] })
  eq(remove.length, old.def.entities.length, "retirement selects only the temporary module's exact entities")
  for (const e of remove) eq(e.owner, "temp", "overlapping mine entities are preserved")
})

test("B21 an incomplete stage's poles never stand on the complete plan's belt paths", () => {
  // Seed 3333 (acceptance run 2026-10-18, tick ~75600) died on the first materialize of its whole-patch iron mine:
  // the initial (partial) stage's pole placer only saw the partial belt subset as occupied, so it dropped a pole on
  // a tile the complete stage's belt layer then claims (transport-belt@18.5,31.5 and small-electric-pole@18.5,31.5
  // overlapped and finalizeModule's occupancy check threw). The initial pole set must be a subset of the complete
  // stage's network, so every belt tile of the full plan blocks partial poles too.
  const region = { x: 0, y: 0, w: 80, h: 70 }
  // The shape that repros (pre-fix diag B05: rows=4, the consumer west of the patch):
  const view = terrain(region, (x, y) => (x >= 14 && x < 58 && y >= 18 && y < 40 ? "iron-ore" : undefined))
  const patch = connectedPatch(view, "iron-ore", [{ x: 17, y: 21 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  ok(plan.drills.length >= 10, `a multi-lane patch (${plan.drills.length} drills)`)
  for (const rows of [4, 2]) {
    const base = miningOutpost(F, { resource: "iron-ore", rows, sides: 1 })
    const stages = materializeMinePlan(base, plan, F, { x: 20, y: 18 })!
    const beltAt: Record<string, boolean> = {}
    for (const e of stages.full.entities) {
      if (e.name !== base.params?.belt) continue
      const r = entityRect(e, F)
      for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) beltAt[`${x},${y}`] = true
    }
    let poles = 0
    for (const e of stages.initial.entities) {
      if (F.entity(e.name)?.type !== "electric-pole") continue
      poles++
      const r = entityRect(e, F)
      for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++)
        ok(!beltAt[`${x},${y}`], `the partial stage's pole at ${e.x},${e.y} does not share the belt tile ${x},${y}`)
    }
    ok(poles > 0, "the partial stage has a power network")
  }
})

run("mine-plan")
