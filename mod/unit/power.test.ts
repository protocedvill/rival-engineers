import { labArray, miningOutpost, radarCell, steamBlock } from "../src/modules/generators"
import { IDENTITY, Transform, transformModule } from "../src/modules/geometry"
import { connectionId } from "../src/shared/ids"
import { moduleId } from "../src/shared/ids"
import { ModuleDef } from "../src/modules/types"
import { CLIFF, FREE, OWN, TerrainView, tkey, UNKNOWN, WATER } from "../src/planner/grid"
import { commitModule, growthArea, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { newPoleJob, polesNow, powerRoles, stepPoles, unpoweredModules } from "../src/planner/power"
import { selectPolicy } from "../src/planner/policy"
import { RouteRequest, tileCost } from "../src/planner/router"
import { beltTiers } from "../src/planner/capacity"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: the pole network planner (SPEC §5.3 Power): lines of small poles join every consumer module's poles to a
// generator module's, around obstacles, within wire reach, on free tiles only.

const POLICY = selectPolicy("early-compact", {})

function place(state: LayoutState, id: string, def: ModuleDef, x: number, y: number, t: Transform = IDENTITY): PlacedModule {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  const m: PlacedModule = { id: moduleId(id), canonical: def, def: d, transform: t, origin: { x, y }, rect: { x, y, w: d.footprint.w, h: d.footprint.h } }
  commitModule(state, m, F, 1)
  return m
}

/** Free terrain w × h with optional per-tile blocks. */
function terrain(w: number, h: number, blocks: Record<number, number> = {}): TerrainView {
  return {
    block: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? UNKNOWN : (blocks[tkey(x, y)] ?? FREE)),
    ore: () => undefined,
  }
}

/** Checks every planned pole: on a free tile, and the line chains within wire reach. */
function poleProblems(layout: LayoutState, view: TerrainView): string[] {
  const out: string[] = []
  for (const p of layout.poles ?? []) {
    if (view.block(p.x, p.y) !== FREE) out.push(`pole ${p.id} on blocked terrain`)
    const occ = layout.occ[tkey(p.x, p.y)]
    if (occ !== `x:${p.line}`) out.push(`pole ${p.id} tile tagged ${occ}`)
    if (layout.routeOcc[tkey(p.x, p.y)] !== undefined) out.push(`pole ${p.id} on a route`)
  }
  return out
}

const steam = steamBlock(F, { boilers: 1 })
const labs = labArray(F, { labs: 2, packs: ["automation-science-pack"] })

test("power roles: the steam block is a source, a lab array a consumer", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  place(layout, "labs", labs, 40, 4)
  const r = powerRoles(layout, F)
  eq(r.sources.join(","), "steam", "sources")
  eq(r.consumers.join(","), "labs", "consumers")
})

test("a line of small poles joins a lab array 40 tiles from the steam block; each hop within wire reach", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  place(layout, "labs", labs, 50, 4)
  const view = terrain(80, 30)
  eq(unpoweredModules(layout, F).join(","), "labs", "unpowered before")
  const job = polesNow(layout, view, F, POLICY)
  eq(job.phase, "done", "done")
  eq(unpoweredModules(layout, F).length, 0, "everything powered after")
  const n = layout.poles?.length ?? 0
  // The gap between the two modules' nearest poles is about 41 tiles: at least 5 hops, few more.
  ok(n >= 5 && n <= 8, `${n} poles`)
  eq(poleProblems(layout, view).length, 0, poleProblems(layout, view).join("; "))
  eq(layout.poleLines?.length, 1, "one line")
  eq(layout.poleLines![0].to, "labs", "joined the labs")
})

test("D52 (3): a mining outpost's room to grow is a hard claim: the pole line goes around it", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  // The labs east of the strip the mine grows into (south of it, x 30..38): a straight line would cross it.
  place(layout, "labs", labs, 60, 20)
  const mine = place(layout, "mine", miningOutpost(F, { resource: "coal", rows: 2, sides: 2, drill: "burner-mining-drill" }), 30, 0)
  const g = growthArea(mine)!
  print(`  mine ${mine.rect.x},${mine.rect.y} ${mine.rect.w}x${mine.rect.h}, growth ${g.x},${g.y} ${g.w}x${g.h}`)
  let claimed = 0
  for (const [, owner] of pairs(layout.mine ?? {})) if (owner === "mine") claimed++
  eq(claimed, g.w * g.h, "every tile of its growth area is claimed")
  const view = terrain(100, 90)
  const job = polesNow(layout, view, F, POLICY)
  eq(job.phase, "done", "done")
  eq(unpoweredModules(layout, F).length, 0, "everything powered")
  for (const p of layout.poles ?? []) ok(layout.mine![tkey(p.x, p.y)] === undefined, `pole ${p.id} at ${p.x},${p.y} off the mine's room to grow`)
  // Routes: another module's route can't take it, the outpost's own can.
  const req = (to: string): RouteRequest => ({ id: "r", conn: "r", item: "coal", to: { module: to, port: "in" }, goal: { x: 0, y: 0, dir: 0 }, tier: beltTiers(F)[0], own: {} })
  ok(tileCost(layout, view, POLICY, req("labs"), false, g.x + 1, g.y + 3) < 0, "another module's route is refused")
  ok(tileCost(layout, view, POLICY, req("mine"), false, g.x + 1, g.y + 3) >= 0, "the outpost's own route may pass")
})

test("poles go around a lake and never stand on water, cliffs or other structures", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 10)
  place(layout, "labs", labs, 55, 12)
  const blocks: Record<number, number> = {}
  // A wall of water 12 wide from y = 0 to y = 34 (open below), and a cliff band.
  for (let x = 25; x < 37; x++) for (let y = 0; y < 34; y++) blocks[tkey(x, y)] = WATER
  for (let x = 40; x < 42; x++) for (let y = 0; y < 30; y++) blocks[tkey(x, y)] = CLIFF
  blocks[tkey(20, 36)] = OWN
  const view = terrain(80, 50, blocks)
  const job = polesNow(layout, view, F, POLICY)
  eq(unpoweredModules(layout, F).length, 0, `powered (failures: ${tostring(job.failures.labs)})`)
  eq(poleProblems(layout, view).length, 0, poleProblems(layout, view).join("; "))
  let below = false
  for (const p of layout.poles!) if (p.y >= 34) below = true
  ok(below, "the line passes below the lake")
})

test("no generator yet: nothing to connect, no poles; modules within reach need none", () => {
  const a = newLayout()
  place(a, "labs", labs, 2, 2)
  const j = polesNow(a, terrain(40, 20), F, POLICY)
  eq(j.phase, "done", "done")
  eq(a.poles?.length ?? 0, 0, "no poles without a generator")
  const b = newLayout()
  place(b, "steam", steam, 2, 2)
  // The lab array's poles are within 7.5 of the steam block's right-hand poles.
  place(b, "labs", labs, 8, 2)
  polesNow(b, terrain(40, 20), F, POLICY)
  eq(b.poles?.length ?? 0, 0, "adjacent modules join directly")
  eq(unpoweredModules(b, F).length, 0, "powered")
})

test("B43: a consumer whose trunk line was evicted joins through the line still hanging off it", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  const m = place(layout, "labs", labs, 50, 4)
  polesNow(layout, terrain(80, 30), F, POLICY)
  eq(unpoweredModules(layout, F).length, 0, "joined first")
  // B37 evicted the line's first part (report 333968: a route took the trunk): only its last two poles stay, as a line
  // of their own still joined to the labs.
  const line = layout.poleLines![0]
  const keep = layout.poles!.filter((p) => p.line === line.id).slice(-2)
  for (const p of layout.poles!) delete layout.occ[tkey(p.x, p.y)]
  layout.poles = keep.map((p, i) => ({ ...p, id: `poles:old:0.${i}`, line: "poles:old:0" }))
  for (const p of layout.poles) layout.occ[tkey(p.x, p.y)] = "x:poles:old:0"
  layout.poleLines = [{ id: connectionId("poles:old:0"), from: "poles:gone", to: moduleId("labs"), poles: layout.poles.map((p) => p.id) }]
  // Every tile in wire reach of the labs' own poles is taken (a mine's growth room in the report).
  for (const e of m.def.entities) {
    if (e.name !== "small-electric-pole") continue
    for (let x = math.floor(m.origin.x + e.x) - 8; x <= m.origin.x + e.x + 8; x++) {
      for (let y = math.floor(m.origin.y + e.y) - 8; y <= m.origin.y + e.y + 8; y++) {
        const k = tkey(x, y)
        if (layout.occ[k] === undefined) layout.reserved[k] = "test"
      }
    }
  }
  eq(unpoweredModules(layout, F).join(","), "labs", "cut off")
  const job = polesNow(layout, terrain(80, 30), F, POLICY, "poles:new:")
  eq(unpoweredModules(layout, F).length, 0, `joined again (${tostring(job.failures.labs)})`)
})

test("B39: a second steam block joins the first one's network (old: its own island, powering nothing)", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  place(layout, "labs", labs, 12, 2)
  // The second plant 40 tiles south, nothing near it.
  place(layout, "steam2", steam, 2, 50)
  polesNow(layout, terrain(60, 80), F, POLICY)
  eq(unpoweredModules(layout, F).length, 0, "one network")
  ok((layout.poleLines ?? []).some((l) => l.to === "steam2"), "a line joins the second plant")
  eq(poleProblems(layout, terrain(60, 80)).length, 0, poleProblems(layout, terrain(60, 80)).join("; "))
})

test("budgeted: stepping 5 units at a time gives the same line", () => {
  const mk = (): LayoutState => {
    const l = newLayout()
    place(l, "steam", steam, 2, 2)
    place(l, "labs", labs, 50, 4)
    return l
  }
  const a = mk()
  polesNow(a, terrain(80, 30), F, POLICY)
  const b = mk()
  const job = newPoleJob("poles:", "small-electric-pole", F)
  let steps = 0
  while (!stepPoles(job, b, terrain(80, 30), F, POLICY, 5)) steps++
  ok(steps > 3, `${steps} steps`)
  eq(b.poles!.length, a.poles!.length, "same pole count")
  for (let i = 0; i < a.poles!.length; i++) eq(`${b.poles![i].x},${b.poles![i].y}`, `${a.poles![i].x},${a.poles![i].y}`, `pole ${i}`)
})

test("unreachable consumer (walled in by water): reported, not crashing", () => {
  const layout = newLayout()
  place(layout, "steam", steam, 2, 2)
  place(layout, "labs", labs, 50, 6)
  const blocks: Record<number, number> = {}
  // Wires span water, so the moat is wider than a hop and covers the whole map's height.
  for (let x = 28; x < 40; x++) for (let y = 0; y < 30; y++) blocks[tkey(x, y)] = WATER
  const job = polesNow(layout, terrain(80, 30, blocks), F, POLICY)
  eq(job.phase, "done", "done")
  ok(job.failures.labs !== undefined, "failure recorded")
  eq(unpoweredModules(layout, F).join(","), "labs", "still unpowered")
})

test("D62: a radar outpost 400 tiles out gets a pole line along its explored strip, around a lake, never onto unknown ground", () => {
  const layout = newLayout()
  // Home zone x 0..119, y 400..519 (the steam block in it); the arm's strip runs north from it, x 30..94, to y -20.
  place(layout, "steam", steam, 50, 460)
  place(layout, "radar", radarCell(F, {}), 60, 0)
  const blocks: Record<number, number> = {}
  // A lake across most of the strip at y 200..230 (a gap on its west side), and scattered cliffs.
  for (let y = 200; y <= 230; y++) for (let x = 40; x <= 94; x++) blocks[tkey(x, y)] = WATER
  for (let y = 0; y < 400; y += 37) for (let x = 30; x <= 94; x += 11) blocks[tkey(x, y)] = CLIFF
  const known = (x: number, y: number): boolean => (x >= 0 && x < 120 && y >= 400 && y < 520) || (x >= 30 && x <= 94 && y >= -20 && y < 400)
  const view: TerrainView = { block: (x, y) => (!known(x, y) ? UNKNOWN : (blocks[tkey(x, y)] ?? FREE)), ore: () => undefined }
  const job = polesNow(layout, view, F, POLICY)
  eq(job.phase, "done", "done")
  eq(unpoweredModules(layout, F).length, 0, `radar powered (${job.failures.radar ?? ""})`)
  eq(poleProblems(layout, view).length, 0, poleProblems(layout, view).join("; "))
  const n = layout.poles?.length ?? 0
  // About 460 tiles at up to 7.5 per hop, plus the detour: 62 at best.
  ok(n >= 60 && n <= 90, `${n} poles`)
  // 65 poles for about 75k work when written: less than a typical production plan.
  ok(job.work < 300000, `work ${job.work}`)
})

run("power")
