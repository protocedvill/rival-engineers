import { LuaForce, LuaSurface } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { EAST, ModuleDef, NORTH, SOUTH } from "../modules/types"
import { beltTiers } from "../planner/capacity"
import { Vec } from "../planner/grid"
import { commitModule, findModule, LayoutState, newLayout, PlacedModule } from "../planner/layout"
import { addEdge, addNode, LogicalGraph, LogicalNode, NodeKind } from "../planner/logical"
import { newRoutingJob, runJob } from "../planner/plan"
import { selectPolicy } from "../planner/policy"
import { stampParts } from "../planner/runtime"
import { newTerrain, requestArea, stepTerrain, terrainView } from "../planner/terrain"
import { startBootstrap } from "../strategy/bootstrap"
import { FactoryState, getFactory, reconcileNow, startFactory } from "../strategy/factory"
import { describeMachines } from "../strategy/measure"
import { at, createLab, Lab } from "./lab"
import { feed, followRoute } from "./route-lab"

// M5b T2 (SPEC §8 M5, §5.8): measurement and the reconciler on real entities. A module deliberately starved by an
// unpowered outpost upstream is classified starved with that outpost as its root cause; a smelter backed up behind an
// unpowered consumer; a smelter without fuel; labs fed by an undersized belt (the edge measured at its capacity); and a
// belt cut out of a built route is found, repaired by the crew through a reconciler goal, and the smelter recovers.

const SPEED = 100
let speed = 1
let seq = 0

/** Test cadence: measure every second, a 10 s window, 5 s probes, no warm-up, 2 confirmations. */
function fastReconciler(): void {
  setConfigOverride("factoryEnabled", false)
  setConfigOverride("measureIntervalTicks", 60)
  setConfigOverride("measureWindowSamples", 10)
  setConfigOverride("measureProbeTicks", 300)
  setConfigOverride("reconcileWarmupTicks", 0)
  setConfigOverride("reconcileConfirm", 2)
  setConfigOverride("reconcileCooldownTicks", 1200)
}

/** A faction whose bootstrap brain never thinks (the test drives the reconciler), with a factory state. */
function testFaction(lab: Lab, dx: number, dy: number): { faction: FactionState; f: FactoryState } {
  const faction = createFaction(`rec-${++seq}`, { position: at(lab, dx, dy), crew: 1, starterItems: {} })
  const brain = startBootstrap(faction, at(lab, dx, dy))
  brain.nextThink = math.huge
  const f = startFactory(faction)
  return { faction, f }
}

function scan(lab: Lab, force: string) {
  const t = newTerrain(`rec-t-${++seq}`, lab.surface.name, force)
  const r = lab.radius
  requestArea(t, { x: math.floor(lab.origin.x) - r, y: math.floor(lab.origin.y) - r, w: 2 * r, h: 2 * r })
  while (stepTerrain(t, 100) > 0) {
    // synchronous scan for the test
  }
  return t
}

function placeDef(layout: LayoutState, id: string, def: ModuleDef, origin: Vec): PlacedModule {
  const m: PlacedModule = { id, canonical: def, def, transform: { rot: 0, mirror: false }, origin, rect: { x: origin.x, y: origin.y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(layout, m, prototypeFacts, 2)
  return m
}

function node(g: LogicalGraph, m: PlacedModule, kind: NodeKind, item: string, planned: number, tick: number): LogicalNode {
  const def = m.def
  return addNode(g, {
    id: m.id,
    role: m.id,
    kind,
    module: def.id,
    recipe: def.recipe,
    item,
    capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs },
    planned: { inputs: def.rates.inputs.filter((r) => r.item !== "electricity"), outputs: [{ item, perSecond: planned }] },
    powerW: 0,
    lifecycle: "built",
    status: "unknown",
    createdTick: tick,
    builtTick: tick,
  })
}

function edge(g: LogicalGraph, id: string, from: string, fromPort: string, to: string, toPort: string, item: string, rate: number): void {
  addEdge(g, { id, role: id, kind: "belt", item, from, fromPort, to, toPort, plannedRate: rate, physical: [`route:${id}`], belt: "transport-belt" })
}

/** An electric-energy-interface and a pole next to a module's power pole (test power). */
function power(surface: LuaSurface, force: LuaForce | string, m: PlacedModule): void {
  for (const p of m.def.ports) {
    if (p.kind !== "power") continue
    const pos = { x: m.origin.x + p.pos.x, y: m.origin.y + p.pos.y }
    const spot = surface.find_non_colliding_position("electric-energy-interface", pos, 6, 0.5, false)!
    const eei = surface.create_entity({ name: "electric-energy-interface", position: spot, force })!
    eei.power_production = 1e7
    eei.electric_buffer_size = 1e8
    eei.energy = 1e8
    const pole = surface.find_non_colliding_position("small-electric-pole", spot, 3, 1, true)
    if (pole !== undefined) surface.create_entity({ name: "small-electric-pole", position: pole, force })
  }
}

interface Chain {
  lab: Lab
  faction: FactionState
  f: FactoryState
  mine: PlacedModule
  smelt: PlacedModule
  gears: PlacedModule
}

/**
 * Iron outpost (electric drills on ore) → smelter column (stone furnaces) → gear row, placed 20 tiles apart, routed
 * and built as real entities. Power and fuel are left to each test.
 */
function chainLab(): Chain {
  const lab = createLab(48)
  const { faction, f } = testFaction(lab, 30, 30)
  const s = lab.surface
  const ox = math.floor(lab.origin.x)
  const oy = math.floor(lab.origin.y)
  for (let x = -20; x < 0; x++) for (let y = 22; y < 40; y++) s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount: 100000 })
  const t = scan(lab, faction.force)
  const layout = newLayout()
  const mine = placeDef(layout, "mine", generatedModule("mining-outpost", { resource: "iron-ore", rows: 2, sides: 2 }), { x: ox - 15, y: oy + 24 })
  const smelt = placeDef(layout, "smelt", generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4 }), { x: ox - 5, y: oy - 8 })
  const gears = placeDef(layout, "gears", generatedModule("assembler-row", { recipe: "iron-gear-wheel", count: 2 }), { x: ox + 14, y: oy - 30 })
  const conns = [
    { id: "ore", from: { module: "mine", port: "out" }, to: { module: "smelt", port: "in-ore" } },
    { id: "plates", from: { module: "smelt", port: "out" }, to: { module: "gears", port: "in-iron-plate" } },
  ]
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: ox, y: oy }, region: { x: ox - 48, y: oy - 48, w: 96, h: 96 } }, beltTiers(prototypeFacts)[0], layout), terrainView(t), prototypeFacts, selectPolicy("early-compact", {}))
  assert(job.phase === "done", "routed")
  const r = stampParts(s, faction.force, job.layout, { modules: ["mine", "smelt", "gears"], routes: ["route:ore", "route:plates"], poles: [] }, false)
  assert(r.failed.length === 0, r.failed.join("; "))
  f.layout = job.layout
  const tick = game.tick
  const mineRate = rateOut(mine.def, "iron-ore")
  node(f.graph, findModule(job.layout, "mine")!, "outpost", "iron-ore", mineRate, tick)
  node(f.graph, findModule(job.layout, "smelt")!, "module", "iron-plate", math.min(mineRate, rateOut(smelt.def, "iron-plate")), tick)
  node(f.graph, findModule(job.layout, "gears")!, "module", "iron-gear-wheel", rateOut(gears.def, "iron-gear-wheel") * 0.5, tick)
  edge(f.graph, "ore", "mine", "out", "smelt", "in-ore", "iron-ore", mineRate)
  edge(f.graph, "plates", "smelt", "out", "gears", "in-iron-plate", "iron-plate", rateOut(smelt.def, "iron-plate"))
  return { lab, faction, f, mine: findModule(job.layout, "mine")!, smelt: findModule(job.layout, "smelt")!, gears: findModule(job.layout, "gears")! }
}

function rateOut(def: ModuleDef, item: string): number {
  let v = 0
  for (const r of def.rates.outputs) if (r.item === item) v += r.perSecond
  return v
}

function fuelFurnaces(c: Chain): void {
  const m = c.smelt
  // Furnaces and the column's burner inserters (in a real build they take coal from the fuel lane).
  for (const e of c.lab.surface.find_entities_filtered({ name: ["stone-furnace", "burner-inserter"], area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })) {
    if (e.get_fuel_inventory()!.get_item_count("coal") < 5) e.insert({ name: "coal", count: 10 })
  }
}

function describe_(g: LogicalGraph, f: FactoryState): string {
  const parts: string[] = []
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    const sh = n.measured?.states
    parts.push(`${id}: ${n.status} (${n.statusReason ?? ""}) states ${sh !== undefined ? string.format("w%.2f s%.2f b%.2f p%.2f f%.2f i%.2f", sh.working, sh.starved, sh.blocked, sh.unpowered, sh.unfuelled, sh.idle) : "-"} [${f.meter !== undefined ? describeMachines(f.meter, id) : ""}] cause ${n.cause !== undefined ? `${n.cause.kind} ${n.cause.id} ${n.cause.what}: ${n.cause.why}` : "-"}`)
  }
  for (const id of g.edgeOrder) {
    const e = g.edges[id]
    parts.push(`edge ${id}: ${string.format("%.2f", e.measuredRate ?? -1)}/s (planned ${string.format("%.2f", e.plannedRate)}) full ${e.measuredFull !== undefined ? string.format("%.2f/%.2f", e.measuredFull.from, e.measuredFull.to) : "-"}`)
  }
  return parts.join("\n  ")
}

/** Runs the reconciler every second (game time) until `check` passes or `ticks` run out. */
function reconcileUntil(faction: FactionState, f: FactoryState, ticks: number, each: (this: void) => void, check: (this: void) => boolean, then: (this: void, ok: boolean) => void): void {
  let n = 0
  on_tick(() => {
    n++
    each()
    if (n % 60 !== 0) return
    reconcileNow(faction, f)
    if (check()) {
      then(true)
      return false
    }
    if (n >= ticks) {
      then(false)
      return false
    }
  })
}

describe("M5b reconciler", () => {
  before_all(() => {
    speed = game.speed
    game.speed = SPEED
  })
  after_all(() => {
    game.speed = speed
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    fastReconciler()
  })

  test("a deliberately starved module: gears ← smelter ← unpowered outpost is starved, root cause the outpost", () => {
    const c = chainLab()
    power(c.lab.surface, c.faction.force, c.gears)
    power(c.lab.surface, c.faction.force, c.smelt)
    const g = c.f.graph
    async(60 * 60 * 5)
    reconcileUntil(c.faction, c.f, 60 * 60 * 3, () => fuelFurnaces(c), () => g.nodes.gears.status === "starved" && g.nodes.gears.cause?.kind === "node", (ok) => {
      log(`[m5b] starved:\n  ${describe_(g, c.f)}`)
      assert(ok, "classified in time")
      assert(g.nodes.mine.status === "unpowered", `outpost ${g.nodes.mine.status}`)
      assert(g.nodes.smelt.status === "starved", `smelter ${g.nodes.smelt.status}`)
      assert(g.nodes.gears.cause!.id === "mine", `gears' root cause ${g.nodes.gears.cause!.id}: ${g.nodes.gears.cause!.why}`)
      assert(g.nodes.gears.cause!.what === "no power node", g.nodes.gears.cause!.what)
      assert(g.nodes.smelt.cause!.id === "mine", "the smelter's root cause too")
      done()
    })
  })

  test("backed up: a smelter whose consumer has no power is backed-up, root cause the consumer", () => {
    const c = chainLab()
    power(c.lab.surface, c.faction.force, c.mine)
    power(c.lab.surface, c.faction.force, c.smelt)
    const g = c.f.graph
    // The plate belt (~40 tiles) and then the furnaces' output slots must fill before the column blocks.
    async(60 * 60 * 32)
    reconcileUntil(c.faction, c.f, 60 * 60 * 30, () => fuelFurnaces(c), () => g.nodes.smelt.status === "backed-up" && g.nodes.smelt.cause?.id === "gears", (ok) => {
      log(`[m5b] backed-up:\n  ${describe_(g, c.f)}`)
      assert(ok, `smelter backed-up with the gear row as cause: ${g.nodes.smelt.status}, ${g.nodes.smelt.cause?.why}`)
      assert(g.nodes.gears.status === "unpowered", `gears ${g.nodes.gears.status}`)
      done()
    })
  })

  test("unfuelled: a smelter without coal is unfuelled; with no fuel belt its cause is the crew's fuel", () => {
    const c = chainLab()
    power(c.lab.surface, c.faction.force, c.mine)
    power(c.lab.surface, c.faction.force, c.gears)
    power(c.lab.surface, c.faction.force, c.smelt)
    const g = c.f.graph
    async(60 * 60 * 5)
    reconcileUntil(c.faction, c.f, 60 * 60 * 3, () => undefined, () => g.nodes.smelt.status === "unfuelled" && g.nodes.smelt.cause !== undefined && g.nodes.gears.cause !== undefined && g.nodes.gears.cause.kind !== "measuring", (ok) => {
      log(`[m5b] unfuelled:\n  ${describe_(g, c.f)}`)
      assert(ok, `smelter ${g.nodes.smelt.status}`)
      assert(g.nodes.smelt.cause!.what === "crew fuel", g.nodes.smelt.cause!.why)
      // The gear row starves behind it; its root cause is the smelter's fuel.
      assert(g.nodes.gears.status === "starved", `gears ${g.nodes.gears.status}`)
      assert(g.nodes.gears.cause?.id === "smelt" && g.nodes.gears.cause?.what === "crew fuel", `gears' cause ${g.nodes.gears.cause?.why}`)
      done()
    })
  })

  test("labs fed by an undersized belt: the pack edge is measured at the belt's capacity and is the root cause", () => {
    const lab = createLab(40)
    const { faction, f } = testFaction(lab, 0, 20)
    const s = lab.surface
    const force = game.forces[faction.force]
    // Fast labs: 12 labs at speed 30 could take 36 packs/s through fast inserters (~2.3/s each, 27/s); a yellow belt
    // carries 15/s.
    force.laboratory_speed_modifier = 29
    force.technologies["automation-science-pack"].researched = true
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const entities: ModuleDef["entities"] = []
    for (let i = 0; i < 6; i++) {
      const x = 3 * i + 1.5
      entities.push({ name: "lab", x, y: 1.5 }, { name: "fast-inserter", x, y: 3.5, dir: SOUTH }, { name: "lab", x, y: 7.5 }, { name: "fast-inserter", x, y: 5.5, dir: NORTH })
      entities.push({ name: "small-electric-pole", x: x - 1, y: 3.5 }, { name: "small-electric-pole", x: x - 1, y: 5.5 })
    }
    for (let x = 0; x < 18; x++) entities.push({ name: "transport-belt", x: x + 0.5, y: 4.5, dir: EAST })
    const RED = "automation-science-pack"
    const labDef: ModuleDef = {
      id: "lab-wall",
      source: "generated",
      footprint: { w: 18, h: 9 },
      entities,
      ports: [
        { id: "in", kind: "belt-in", pos: { x: 0.5, y: 4.5 }, dir: EAST, item: RED },
        { id: "power", kind: "power", pos: { x: 0.5, y: 3.5 }, dir: NORTH },
      ],
      recipes: [],
      machines: [{ name: "lab", count: 12 }],
      rates: { inputs: [{ item: RED, perSecond: 36 }], outputs: [{ item: "research-unit", perSecond: 36 }] },
      requiresTech: [],
      rotatable: false,
      mirrorable: false,
    }
    const srcDef: ModuleDef = {
      id: "red-source",
      source: "generated",
      footprint: { w: 1, h: 1 },
      entities: [{ name: "transport-belt", x: 0.5, y: 0.5, dir: EAST }],
      ports: [{ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: EAST, item: RED }],
      recipes: [],
      machines: [],
      rates: { inputs: [], outputs: [{ item: RED, perSecond: 25 }] },
      requiresTech: [],
      rotatable: false,
      mirrorable: false,
    }
    const layout = newLayout()
    const labs = placeDef(layout, "labs", labDef, { x: ox, y: oy - 4 })
    const src = placeDef(layout, "src", srcDef, { x: ox - 12, y: oy })
    const t = scan(lab, faction.force)
    const job = runJob(newRoutingJob({ modules: [], connections: [{ id: "packs", from: { module: "src", port: "out" }, to: { module: "labs", port: "in" } }], center: { x: ox, y: oy }, region: { x: ox - 40, y: oy - 40, w: 80, h: 80 } }, beltTiers(prototypeFacts)[0], layout), terrainView(t), prototypeFacts, selectPolicy("early-compact", {}))
    assert(job.phase === "done", "routed")
    const built = stampParts(s, faction.force, job.layout, { modules: ["labs", "src"], routes: ["route:packs"], poles: [] }, false)
    assert(built.failed.length === 0, built.failed.join("; "))
    power(s, force, findModule(job.layout, "labs")!)
    f.layout = job.layout
    const g = f.graph
    const tick = game.tick
    node(g, src, "source", RED, 25, tick)
    node(g, labs, "labs", "research-unit", 25, tick)
    g.nodes.labs.planned.inputs = [{ item: RED, perSecond: 25 }]
    edge(g, "packs", "src", "out", "labs", "in", RED, 25)
    const belt = s.find_entities_filtered({ position: { x: src.origin.x + 0.5, y: src.origin.y + 0.5 }, type: "transport-belt" })[0]
    const fs = [{ item: RED, lines: [belt.get_transport_line(1), belt.get_transport_line(2)], perTick: 25 / 60, credit: 0, next: 0 }]
    // Research that never ends: automation again whenever it finishes.
    const research = (): void => {
      if (force.current_research !== undefined) return
      force.technologies["automation"].researched = false
      force.add_research("automation")
    }
    async(60 * 60 * 5)
    reconcileUntil(faction, f, 60 * 60 * 3, () => {
      research()
      feed(fs)
    }, () => g.nodes.labs.cause?.what === "at-capacity", (ok) => {
      log(`[m5b] undersized belt:\n  ${describe_(g, f)}\n  route ${followRoute(s, f.layout, f.layout.routes["route:packs"]) ?? "connected"}`)
      const e = g.edges.packs
      assert(ok, `labs ${g.nodes.labs.status}, cause ${g.nodes.labs.cause?.why}`)
      assert(g.nodes.labs.status === "starved", `labs ${g.nodes.labs.status}`)
      assert(g.nodes.labs.cause!.id === "packs" && g.nodes.labs.cause!.what === "at-capacity", g.nodes.labs.cause!.why)
      assert(e.measuredRate! >= 13.5 && e.measuredRate! <= 15.5, `probe measured ${e.measuredRate}/s on a 15/s belt`)
      done()
    })
  })

  test("a belt cut out of a built route: found as a broken edge, repaired by the crew through a reconciler goal, the smelter recovers", () => {
    const c = chainLab()
    power(c.lab.surface, c.faction.force, c.mine)
    power(c.lab.surface, c.faction.force, c.gears)
    power(c.lab.surface, c.faction.force, c.smelt)
    const s = c.lab.surface
    const route = c.f.layout.routes["route:ore"]
    const step = route.steps[math.floor(route.steps.length / 2)]
    const cut = s.find_entities_filtered({ position: { x: step.x + 0.5, y: step.y + 0.5 }, type: "transport-belt" })[0]
    assert(cut !== undefined, "a belt to cut")
    cut.destroy()
    // The crew's materials: a chest of belts next to them.
    const chest = s.create_entity({ name: "iron-chest", position: at(c.lab, 30, 26), force: c.faction.force })!
    chest.insert({ name: "transport-belt", count: 20 })
    chest.insert({ name: "coal", count: 50 })
    addStockpile(c.faction, chest)
    const g = c.f.graph
    let repaired: number | undefined
    async(60 * 60 * 15)
    reconcileUntil(c.faction, c.f, 60 * 60 * 14, () => fuelFurnaces(c), () => {
      const goal = c.f.goals.filter((x) => x.kind === "repair")[0]
      if (goal?.status === "done" && repaired === undefined) repaired = game.tick
      return repaired !== undefined && g.nodes.smelt.status === "ok"
    }, (ok) => {
      log(`[m5b] repair:\n  ${describe_(g, c.f)}\n  goals ${serpent.line(c.f.goals.map((x) => `${x.id} ${x.kind} ${x.status} ${x.reason ?? ""}`))}\n  remedies ${serpent.line(c.f.reconciler?.log)}`)
      assert(ok, `repaired ${repaired}, smelter ${g.nodes.smelt.status}`)
      const log0 = c.f.reconciler!.log[0]
      assert(log0.kind === "repair" && log0.key === "repair:ore", `first remedy ${serpent.line(log0)}`)
      assert(s.find_entities_filtered({ position: { x: step.x + 0.5, y: step.y + 0.5 }, type: "transport-belt" }).length === 1, "the belt is back")
      assert(getFactory(c.faction.name) === c.f, "same factory")
      done()
    })
  })
})
