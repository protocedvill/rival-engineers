import { EntityFacts } from "../src/modules/facts"
import { miningOutpost } from "../src/modules/generators"
import { moduleId } from "../src/shared/ids"
import { powerCheck } from "../src/modules/poles"
import { EAST, NORTH, SOUTH, WEST } from "../src/modules/types"
import { entityRect, portOutsideTile } from "../src/modules/geometry"
import { partEntities } from "../src/planner/build-list"
import { FREE, keyX, keyY, Rect, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { commitModule, modulesOnTiles, newLayout, PlacedModule } from "../src/planner/layout"
import { connectedPatch, liveGrowth, materializeMinePlan, newPatchSearch, planWholePatch, stepPatchSearch, WholePatchMinePlan } from "../src/planner/mine-plan"
import { placeNow, tryExpand } from "../src/planner/placement"
import { newWholePatchPrep, prepareWholePatchPlacement, stepWholePatch } from "../src/planner/whole-patch"
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

test("B44: a whole-patch plan does not depend on where the patch lies (shifts across the lane pitch)", () => {
  // The B33 review test's 18x15 patch and an irregular one; the lane pitch is 9 tiles for a 3-wide drill.
  const shapes: [string, (this: void, x: number, y: number) => boolean][] = [
    ["rect", (x, y) => x >= 0 && x < 18 && y >= 0 && y < 15],
    ["L", (x, y) => (x >= 0 && x < 20 && y >= 0 && y < 9) || (x >= 11 && x < 20 && y >= 0 && y < 23)],
  ]
  for (const [name, inside] of shapes) {
    let first: string | undefined
    for (let dx = 0; dx < 9; dx++) {
      for (const dy of [0, 4, 7]) {
        const ox = 400 + dx
        const oy = 2000 + dy
        const region = { x: ox - 40, y: oy - 40, w: 100, h: 100 }
        const view = terrain(region, (x, y) => (inside(x - ox, y - oy) ? "iron-ore" : undefined))
        const patch = connectedPatch(view, "iron-ore", [{ x: ox, y: oy }], region)!
        const plan = planWholePatch(view, patch, DRILL)
        const rel: string[] = [plan.axis]
        for (const d of plan.drills) rel.push(string.format("%g,%g/%g", d.x - ox, d.y - oy, d.lane - (plan.axis === "y" ? ox : oy)))
        const key = rel.join(" ")
        if (first === undefined) first = key
        eq(key, first, `${name} shifted by ${dx},${dy}`)
      }
    }
  }
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

function planKey(p: WholePatchMinePlan): string {
  const parts: string[] = [p.axis]
  for (const d of p.drills) parts.push(string.format("%g,%g,%g,%d,%d", d.x, d.y, d.lane, d.side, d.ore ?? -1))
  return `${parts.join(" ")} | ${p.covered.join(",")}`
}

test("M7: the whole-patch search and the mine's preparation run in budgeted steps and give the one-shot result", () => {
  const region = { x: 0, y: 0, w: 100, h: 80 }
  // An irregular field with a foreign ore beside it (B6 keeps drills out of its reach).
  const view = terrain(region, (x, y) => {
    if ((x >= 20 && x < 44 && y >= 20 && y < 38) || (x >= 38 && x < 53 && y >= 32 && y < 47)) return "iron-ore"
    if (x >= 53 && x < 60 && y >= 32 && y < 40) return "copper-ore"
    return undefined
  })
  const patch = connectedPatch(view, "iron-ore", [{ x: 25, y: 25 }], region)!
  const once = planWholePatch(view, patch, DRILL)
  const s = newPatchSearch(patch, DRILL)
  const budget = 100
  let steps = 0
  let most = 0
  let total = 0
  while (s.result === undefined) {
    const used = stepPatchSearch(s, view, DRILL, budget)
    steps++
    total += used
    most = math.max(most, used)
  }
  eq(planKey(s.result), planKey(once), "stepped search plans the same mine")
  ok(steps >= 5, `${steps} steps of at most ${budget} work (+ one piece)`)
  ok(most <= 2 * budget, `largest step ${most} work (total ${total})`)

  const policy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const, searchRadii: [0] }
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), rotatable: false, mirrorable: false }
  const place = (): PlacedModule => {
    const placed = placeNow({ id: "mine", def: raw, targets: {}, center: { x: 25, y: 25 }, region }, newLayout(), view, policy)
    eq(placed.phase, "done", `small placement (${placed.reason})`)
    return placed.result!
  }
  const a = place()
  prepareWholePatchPlacement(a, view, F, region, policy)
  const b = place()
  const prep = newWholePatchPrep()
  let prepSteps = 0
  while (prep.stage !== "done") {
    stepWholePatch(prep, b, { terrain: view, facts: F, region, policy, splitters: false }, budget)
    prepSteps++
  }
  ok(a.minePlan !== undefined && b.minePlan !== undefined, "both get the whole-patch plan")
  eq(b.minePlan!.claim.join(","), a.minePlan!.claim.join(","), "stepped preparation claims the same tiles")
  eq(`${b.origin.x},${b.origin.y} ${b.def.entities.length}`, `${a.origin.x},${a.origin.y} ${a.def.entities.length}`, "same origin and entities")
  ok(prepSteps > steps, `preparation took ${prepSteps} steps`)
})

test("B21 finds an older module under a later whole-patch claim", () => {
  const base = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const old: PlacedModule = {
    id: moduleId("temp"),
    canonical: base,
    def: base,
    transform: { rot: 0, mirror: false },
    origin: { x: 10, y: 10 },
    rect: { x: 10, y: 10, w: 5, h: 5 },
  }
  const mine: PlacedModule = {
    id: moduleId("mine"),
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

test("B55: no stage of a whole-patch mine stands on the tile its output belt leaves through", () => {
  // Seed 6666666 (m6-prof, 2026-10-21): completing the mall's partial iron mine put a small pole on the tile just
  // outside its out port (inside the mine's rect: the pole placer gets a one-tile perimeter ring), where the built
  // output route started. B25 lets own routes on the mine's own tiles give way, so the completion picked the belt up,
  // the repair could never re-place it, and the mall and a green cluster starved for the rest of the run.
  let checked = 0
  let failures = 0
  for (const w of [9, 12, 15, 21]) {
    for (const h of [8, 12, 20]) {
      const region = { x: 0, y: 0, w: 80, h: 80 }
      const inside = (x: number, y: number): boolean => x >= 20 && x < 20 + w && y >= 20 && y < 20 + h
      const view = terrain(region, (x, y) => (inside(x, y) ? "iron-ore" : undefined))
      const patch = connectedPatch(view, "iron-ore", [{ x: 21, y: 21 }], region)
      if (patch === undefined) continue
      const plan = planWholePatch(view, patch, DRILL)
      if (plan.drills.length < 2) continue
      for (const rows of [2, 4]) {
        const base = miningOutpost(F, { resource: "iron-ore", rows, sides: 1 })
        for (const near of [{ x: -50, y: 30 }, { x: 150, y: 30 }, { x: 30, y: -50 }, { x: 30, y: 150 }]) {
          const stages = materializeMinePlan(base, plan, F, near)
          if (stages === undefined) continue
          for (const def of [stages.initial, stages.full]) {
            const out = portOutsideTile(def.ports[0])
            const ox = math.floor(out.x)
            const oy = math.floor(out.y)
            for (const e of def.entities) {
              const r = entityRect(e, F)
              if (ox >= r.x && ox < r.x + r.w && oy >= r.y && oy < r.y + r.h) {
                failures++
                if (failures <= 5) ok(false, `${w}x${h} rows=${rows} near ${near.x},${near.y}: ${e.name} at ${e.x},${e.y} on the out port's outside tile ${ox},${oy}`)
              }
            }
            checked++
          }
        }
      }
    }
  }
  eq(failures, 0, `entities on an out port's outside tile (${checked} stages checked)`)
  ok(checked >= 60, `${checked} stages checked`)
})

test("B55: a completion whose full plan covers its own output tile is refused", () => {
  // A full plan made before the B55 fix (an old save) can still hold a pole on the out port's outside tile.
  const region = { x: 0, y: 0, w: 100, h: 80 }
  const view = terrain(region, (x, y) => (x >= 20 && x < 56 && y >= 18 && y < 58 ? "iron-ore" : undefined))
  const policy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const, searchRadii: [0] }
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), rotatable: false, mirrorable: false }
  const state = newLayout()
  const placed = placeNow({ id: "mine", def: raw, targets: {}, center: { x: 25, y: 25 }, region }, state, view, policy)
  eq(placed.phase, "done", `small placement (${placed.reason})`)
  const m = placed.result!
  prepareWholePatchPlacement(m, view, F, region, policy)
  ok(m.minePlan !== undefined, "whole-patch plan attached")
  commitModule(state, m, F, policy.corridor.preferred)
  const out = portOutsideTile(m.minePlan!.full.ports[0])
  m.minePlan!.full = { ...m.minePlan!.full, entities: [...m.minePlan!.full.entities, { name: "small-electric-pole", x: math.floor(out.x) + 0.5, y: math.floor(out.y) + 0.5 }] }
  const r = tryExpand(state, view, F, policy, "mine", 1)
  ok(!r.ok, "completion refused")
  ok(string.find(r.reason ?? "", "covers its output", 1, true)[0] !== undefined, `reason: ${r.reason}`)
})

test("B74: a completion that covers its own output route is refused; another own route still gives way (B25)", () => {
  // Soak vps-d67 seed 7718665: the mine's output belt ran along its unbuilt top row and the completion put a pole on
  // its second tile; nothing measured the break while the mine stood backed up, and three clusters starved 150 min.
  const region = { x: 0, y: 0, w: 100, h: 80 }
  const view = terrain(region, (x, y) => (x >= 20 && x < 56 && y >= 18 && y < 58 ? "iron-ore" : undefined))
  const policy = { ...selectPolicy("early-compact", {}), topology: "splitter-tap" as const, searchRadii: [0] }
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), rotatable: false, mirrorable: false }
  const attempt = (from: string): ReturnType<typeof tryExpand> => {
    const state = newLayout()
    const placed = placeNow({ id: "mine", def: raw, targets: {}, center: { x: 25, y: 25 }, region }, state, view, policy)
    eq(placed.phase, "done", `small placement (${placed.reason})`)
    const m = placed.result!
    prepareWholePatchPlacement(m, view, F, region, policy)
    commitModule(state, m, F, policy.corridor.preferred)
    // A tile of the completion's new ground, inside the mine's rect (B25's "own" tiles).
    const current: Record<string, boolean> = {}
    for (const e of m.def.entities) current[`${e.name}@${e.x},${e.y}`] = true
    const added = m.minePlan!.full.entities.find((e) => !current[`${e.name}@${e.x},${e.y}`])!
    const er = entityRect(added, F)
    const k = tkey(m.origin.x + er.x, m.origin.y + er.y)
    state.routes["r"] = { id: "r", conn: "c", item: "iron-ore", from: { module: moduleId(from), port: "out" }, to: { module: moduleId("smelter"), port: "in-ore" }, steps: [], tiles: [k], spans: [], belt: "transport-belt", underground: "underground-belt" } as never
    state.routeOrder.push("r" as never)
    state.routeOcc[k] = "r" as never
    return tryExpand(state, view, F, policy, "mine", 1)
  }
  const own = attempt("mine")
  ok(!own.ok, "completion over its own output route refused")
  ok(string.find(own.reason ?? "", "own output route", 1, true)[0] !== undefined, `reason: ${own.reason}`)
  const other = attempt("other")
  ok(other.ok, `another module's route on the mine's tiles gives way (B25): ${other.reason}`)
})

/** P44 (b): belts of `def` that side-load: one feeding into the side of a belt that something also feeds from behind. */
function sideLoads(def: { entities: { name: string; x: number; y: number; dir?: number }[] }): string[] {
  const DXS = [0, 1, 0, -1]
  const DYS = [-1, 0, 1, 0]
  const belts: Record<string, number> = {}
  const splitters: Record<string, number> = {}
  for (const e of def.entities) {
    const d = math.floor((e.dir ?? 0) / 4)
    if (e.name === "transport-belt") belts[`${math.floor(e.x)},${math.floor(e.y)}`] = d
    if (e.name === "splitter") {
      // Two tiles across its direction.
      const px = d % 2 === 0 ? 0.5 : 0
      const py = d % 2 === 0 ? 0 : 0.5
      splitters[`${math.floor(e.x - px)},${math.floor(e.y - py)}`] = d
      splitters[`${math.floor(e.x + px)},${math.floor(e.y + py)}`] = d
    }
  }
  const feedsFromBehind = (x: number, y: number, d: number): boolean => {
    const k = `${x - DXS[d]},${y - DYS[d]}`
    return belts[k] === d || splitters[k] === d
  }
  const out: string[] = []
  for (const [k, d] of pairs(belts)) {
    const [xs, ys] = string.match(k as string, "(-?%d+),(-?%d+)")
    const x = tonumber(xs)! + DXS[d as number]
    const y = tonumber(ys)! + DYS[d as number]
    const t = belts[`${x},${y}`]
    const sp = splitters[`${x},${y}`]
    if (sp !== undefined && sp !== d) out.push(`${k} into a splitter's side`)
    if (t === undefined || t === d || (t + 2) % 4 === d) continue
    if (feedsFromBehind(x, y, t)) out.push(`${k} side-loads into ${x},${y}`)
  }
  return out
}

test("P44 (b): a several-row whole-patch mine joins its rows with splitters: no side-load, port fixed, drills powered", () => {
  const region = { x: 0, y: 0, w: 80, h: 70 }
  const view = terrain(region, (x, y) => (x >= 14 && x < 58 && y >= 14 && y < 52 ? "iron-ore" : undefined))
  const patch = connectedPatch(view, "iron-ore", [{ x: 20, y: 20 }], region)!
  const plan = planWholePatch(view, patch, DRILL)
  const base = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const lanes: Record<string, boolean> = {}
  let laneCount = 0
  for (const d of plan.drills) if (!lanes[tostring(d.lane)]) { lanes[tostring(d.lane)] = true; laneCount++ }
  ok(laneCount >= 3, `several rows (${laneCount})`)
  // The old collector side-loads every row but the farthest.
  const old = materializeMinePlan(base, plan, F, { x: 20, y: 20 })!
  ok(sideLoads(old.full).length >= laneCount - 1, `the side-load collector side-loads (${sideLoads(old.full).length})`)
  for (const near of [{ x: 20, y: 20 }, { x: 60, y: 60 }, { x: -100, y: 30 }, { x: 30, y: 100 }]) {
    const st = materializeMinePlan(base, plan, F, near, 0, "splitter")!
    const splitters = st.full.entities.filter((e) => e.name === "splitter").length
    eq(splitters, laneCount - 1, `one splitter per row but the farthest (near ${near.x},${near.y})`)
    const sl = sideLoads(st.full)
    eq(sl.length, 0, `no side-load (near ${near.x},${near.y}): ${sl.join("; ")}`)
    eq(sideLoads(st.initial).length, 0, "nor in the partial stage")
    eq(st.initial.ports[0].pos.x, st.full.ports[0].pos.x, "output x stays fixed")
    eq(st.initial.ports[0].pos.y, st.full.ports[0].pos.y, "output y stays fixed")
    eq(powerCheck(st.full.entities, F).unpowered.length, 0, "all planned drills are powered")
    eq(st.full.params?.collector, "splitter", "the mine records its collector")
  }
})

test("B90: a whole-patch mine's first stage always has a pole reachable from past its margin ring", () => {
  // Sweep 922c77c seed 8033112: a splitter-collector mine's only first-stage pole sat 8 tiles from open ground (its claim
  // and margin ring all round): "no pole path" for every later plan.
  const reach = 7.5
  let checked = 0
  const fails: string[] = []
  for (const shape of ["wide", "tall"]) {
    const region = { x: 0, y: 0, w: 100, h: 100 }
    const view = terrain(region, (x, y) => {
      if (shape === "rect") return x >= 14 && x < 58 && y >= 14 && y < 52 ? "iron-ore" : undefined
      if (shape === "wide") return x >= 10 && x < 80 && y >= 30 && y < 50 ? "iron-ore" : undefined
      return x >= 30 && x < 52 && y >= 8 && y < 90 ? "iron-ore" : undefined
    })
    const patch = connectedPatch(view, "iron-ore", [{ x: 40, y: 40 }], region)!
    const plan = planWholePatch(view, patch, DRILL)
    for (const rows of [2, 4]) {
      const base = miningOutpost(F, { resource: "iron-ore", rows, sides: 1 })
      for (const near of [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 50, y: -50 }]) {
        for (const style of ["side", "splitter"]) {
          const st = materializeMinePlan(base, plan, F, near, 0, style === "splitter" ? "splitter" : undefined)
          if (st === undefined) continue
          const fp = st.initial.footprint
          const ok1 = st.initial.entities.some((e) => e.name === "small-electric-pole" && math.min(e.x + 1.5, fp.w + 1.5 - e.x, e.y + 1.5, fp.h + 1.5 - e.y) <= reach)
          checked++
          if (!ok1) fails.push(`${shape} rows ${rows} near ${near.x},${near.y} ${style}`)
        }
      }
    }
  }
  print(`  B90: ${checked} first stages checked, ${fails.length} without a reachable pole`)
  eq(fails.length, 0, fails.join("; "))
})

run("mine-plan")
