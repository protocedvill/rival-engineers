import { labArray, miningOutpost, smelterColumn, steamBlock } from "../src/modules/generators"
import { ModuleDef } from "../src/modules/types"
import { moduleId } from "../src/shared/ids"
import { beltTiers } from "../src/planner/capacity"
import { CLIFF, FREE, rectContains, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { planGrowth } from "../src/planner/grow"
import { commitModule, growthArea, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { cloneLayout, ConnectionRequest, newRoutingJob, runJob } from "../src/planner/plan"
import { placeNow } from "../src/planner/placement"
import { polesNow, unpoweredModules } from "../src/planner/power"
import { selectPolicy } from "../src/planner/policy"
import { RouteRequest, tileCost } from "../src/planner/router"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1, B37: pole lines give way like trees. A growth, a new module or a route may take a pole line's tile at a small
// cost (`obstacles.poleEvict`); the line is evicted (its poles listed for pick-up) and a new line joins what it powered.

const POLICY = selectPolicy("early-compact", {})
const TIER = beltTiers(F)[0]

function free(w: number, h: number): TerrainView {
  return { block: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? UNKNOWN : FREE), ore: () => undefined }
}

function place(l: LayoutState, id: string, def: ModuleDef, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(l, m, F, 2)
  return m
}

/** A steam block and a lab array 60 tiles east, joined by a pole line (the line the tests then run into). */
function powered(): LayoutState {
  const l = newLayout()
  place(l, "steam", steamBlock(F, { boilers: 1 }), 2, 20)
  place(l, "labs", labArray(F, { labs: 2, packs: ["automation-science-pack"] }), 70, 20)
  const j = polesNow(l, free(100, 80), F, POLICY, "poles:a:")
  eq(j.phase, "done", "first line done")
  eq(unpoweredModules(l, F).length, 0, "labs powered")
  return l
}

function lineTiles(l: LayoutState, line: string): number[] {
  const out: number[] = []
  for (const p of l.poles ?? []) if (p.line === line) out.push(tkey(p.x, p.y))
  return out
}

test("B37: a smelter grows over a pole line: the line is evicted, its poles picked up, a new line joins the labs", () => {
  const l = powered()
  const line = l.poleLines![0].id
  const poles = l.poles!.map((p) => `${p.x},${p.y}`).join(" ")
  print(`  line ${line}: ${poles}`)
  // The smelter north of the line, its growth (south, 4 tiles a unit) reaching over it within 2 units.
  let lowest = 0
  for (const p of l.poles!) if (p.x >= 30 && p.x < 47) lowest = math.max(lowest, p.y)
  const sm = place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 36, lowest - 13)
  polesNow(l, free(100, 80), F, POLICY, "poles:b:")
  eq(unpoweredModules(l, F).length, 0, "smelter powered too")
  const g = growthArea(sm)!
  let inside = 0
  for (const p of l.poles!) if (p.line === line && rectContains({ x: g.x, y: g.y, w: g.w, h: 8 }, p.x, p.y)) inside++
  ok(inside > 0, `a pole of ${line} stands in the smelter's first 2 growth units (${g.x},${g.y} ${g.w}x8)`)
  const grown = planGrowth(l, free(100, 80), F, POLICY, TIER, "smelt", 2)
  ok(grown.ok, `grown (${grown.reason})`)
  ok(!grown.layout.poleLines!.some((x) => x.id === line), "the old line is gone from the layout")
  for (const k of lineTiles(l, line)) ok(grown.layout.occ[k] !== `x:${line}`, "its tiles are untagged")
  eq(unpoweredModules(grown.layout, F).length, 0, "everything powered again")
  let picked = 0
  let built = 0
  for (const e of grown.remove) if (e.name === "small-electric-pole") picked++
  for (const e of grown.add) if (e.name === "small-electric-pole" && string.sub(e.owner, 1, 11) === "poles:grow:") built++
  ok(picked > 0, `${picked} poles of the old line picked up`)
  ok(built > 0, `${built} poles of the new line built`)
  for (const p of grown.layout.poles!) ok(!rectContains(findRect(grown.layout, "smelt"), p.x, p.y), `pole ${p.id} off the grown smelter`)
})

function findRect(l: LayoutState, id: string): { x: number; y: number; w: number; h: number } {
  for (const m of l.modules) if (m.id === id) return m.rect
  error(`no module ${id}`)
}

test("B37: a route crosses a pole line at the eviction cost; committing it evicts the line, the pole step re-joins", () => {
  const l = powered()
  const line = l.poleLines![0].id
  const p0 = l.poles![math.floor(l.poles!.length / 2)]
  const req: RouteRequest = { id: "r", conn: "r", item: "coal", to: { module: "labs", port: "in" }, goal: { x: 0, y: 0, dir: 0 }, tier: TIER, own: {} }
  const view = free(100, 80)
  const onPole = tileCost(l, view, POLICY, req, false, p0.x, p0.y)
  const beside = tileCost(l, view, POLICY, req, false, p0.x, p0.y - 3)
  ok(onPole >= 0, "a pole tile is passable")
  ok(onPole > beside, `and costs more than free ground (${onPole} vs ${beside})`)
  const pol = { ...POLICY, obstacles: { ...POLICY.obstacles, poleEvict: 1000 } }
  ok(tileCost(l, view, pol, req, false, p0.x, p0.y) > 900, "the setting sets the cost")
  // A band of cliffs across the map along the line, open only on the middle pole's tile: a route from a smelter north
  // of the band to one south of it must take that pole's tile.
  const walled: TerrainView = {
    block: (x, y) => {
      const b = view.block(x, y)
      if (b === FREE && y >= p0.y - 4 && y <= p0.y + 4 && x !== p0.x) return CLIFF
      return b
    },
    ore: () => undefined,
  }
  place(l, "src", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 }), p0.x - 5, p0.y - 20)
  place(l, "dst", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), p0.x - 5, p0.y + 8)
  const conns: ConnectionRequest[] = [{ id: "plates", from: { module: "src", port: "out" }, to: { module: "dst", port: "in-ore" } }]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: p0.x, y: p0.y }, region: { x: 0, y: 0, w: 100, h: 80 } }, TIER, cloneLayout(l)), walled, F, POLICY)
  eq(job.phase, "done", `routed (${tostring(job.failures.plates)})`)
  ok(job.layout.routeOcc[tkey(p0.x, p0.y)] !== undefined, "the route takes the pole's tile")
  ok(!job.layout.poleLines!.some((x) => x.id === line), "the crossed line is gone")
  eq((job.layout.evictedPoles ?? []).length, lineTiles(l, line).length, "all its poles are listed for pick-up")
  ok(unpoweredModules(job.layout, F).indexOf("labs") >= 0, "the labs lost power")
  const j = polesNow(job.layout, walled, F, POLICY, "poles:c:")
  eq(unpoweredModules(job.layout, F).length, 0, `the pole step joins the labs again (${tostring(j.failures.labs)})`)
  for (const p of job.layout.poles!) ok(job.layout.routeOcc[tkey(p.x, p.y)] === undefined, `pole ${p.id} off the route`)
})

test("B37: a new module placed on a pole line evicts it; new line ids never repeat an evicted one", () => {
  const l = powered()
  const line = l.poleLines![0].id
  const p0 = l.poles![math.floor(l.poles!.length / 2)]
  place(l, "smelt", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), p0.x - 3, p0.y - 3)
  ok(!l.poleLines!.some((x) => x.id === line), "the line under the module is gone")
  ok((l.evictedPoles ?? []).length > 0, "its poles are listed for pick-up")
  for (const p of l.evictedPoles!) eq(p.line, line, "only that line")
  const j = polesNow(l, free(100, 80), F, POLICY, "poles:a:")
  eq(unpoweredModules(l, F).length, 0, `everything powered again (${tostring(j.failures.labs)})`)
  for (const x of l.poleLines!) ok(x.id !== line, `new line ${x.id} has a fresh id`)
})

test("B37: the placement search may put a module on a pole line (old: hard), and prefers free ground at equal cost", () => {
  const l = powered()
  const p0 = l.poles![math.floor(l.poles!.length / 2)]
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  // Only a 14-row band around the line is buildable (cliffs elsewhere): every 8-row spot in it crosses the line.
  const band: TerrainView = { block: (x, y) => (y >= p0.y - 7 && y <= p0.y + 6 ? free(100, 80).block(x, y) : CLIFF), ore: () => undefined }
  const region = { x: 28, y: 0, w: 36, h: 80 }
  const s = placeNow({ id: "smelt", def, targets: {}, center: { x: p0.x, y: p0.y }, region }, l, band, POLICY)
  const why: string[] = []
  for (const [r, f] of pairs(s.rejections ?? {})) why.push(`${r as string}=${f.count}@${f.sample.x},${f.sample.y}`)
  eq(s.phase, "done", `placed on the line (${tostring(s.reason)}: ${why.join(" ")})`)
  let covers = false
  for (const p of l.poles!) if (rectContains(s.result!.rect, p.x, p.y)) covers = true
  ok(covers, "its footprint covers a pole")
  // With room off the line, the cost keeps it off.
  const s2 = placeNow({ id: "smelt", def, targets: {}, center: { x: p0.x, y: p0.y }, region }, l, free(100, 80), POLICY)
  eq(s2.phase, "done", "placed")
  for (const p of l.poles!) ok(!rectContains(s2.result!.rect, p.x, p.y), `pole ${p.id} not under the module when free ground is as good`)
})

run("pole-eviction")
