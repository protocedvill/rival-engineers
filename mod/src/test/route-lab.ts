import { LuaEntity, LuaForce, LuaSurface, LuaTransportLine } from "factorio:runtime"
import { curatedModule, generatedModule } from "../modules/library"
import { DX, DY } from "../planner/grid"
import { checkLayout, findModule, findPort, LayoutState, portTile, Route } from "../planner/layout"
import { ConnectionRequest, ModuleRequest } from "../planner/plan"
import { exportGraph, PlannerEntry } from "../planner/runtime"
import { TerrainView } from "../planner/grid"
import { dumpEntities } from "../telemetry"

// Scaffolding for the M4b routing tests (T2): the module set, an in-game belt-following check, power and feeds so the
// routed factory runs. The scaffolding is test equipment, not part of the plan (power networks are M5).

/** The M4 set (SPEC §8): mining outpost → smelter column → gear row → red tile (curated) → lab array, plus a steam
 * block on the shore. Coal (smelter, steam) and copper (red tile) come from outside the layout. */
export function m4Modules(withSteam: boolean): { modules: ModuleRequest[]; connections: ConnectionRequest[] } {
  const modules: ModuleRequest[] = [
    { id: "outpost", def: generatedModule("mining-outpost", { resource: "iron-ore", rows: 2, sides: 2 }) },
    { id: "smelter", def: generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4 }) },
    { id: "gears", def: generatedModule("assembler-row", { recipe: "iron-gear-wheel", count: 2 }) },
    { id: "red", def: curatedModule("red-tile-ramqvist") },
    { id: "labs", def: generatedModule("lab-array", { labs: 2, packs: ["automation-science-pack"] }) },
  ]
  const c = (id: string, from: [string, string] | undefined, to: [string, string]): ConnectionRequest => ({ id, from: from ? { module: from[0], port: from[1] } : undefined, to: { module: to[0], port: to[1] } })
  const connections = [
    c("ore", ["outpost", "out"], ["smelter", "in-ore"]),
    c("plates", ["smelter", "out"], ["gears", "in-iron-plate"]),
    c("gears", ["gears", "out"], ["red", "in-iron-gear-wheel"]),
    c("red", ["red", "out"], ["labs", "in-automation-science-pack"]),
    c("coal", undefined, ["smelter", "in-fuel"]),
    c("copper", undefined, ["red", "in-copper-plate"]),
  ]
  if (withSteam) {
    modules.push({ id: "steam", def: generatedModule("steam-block", { boilers: 1 }) })
    connections.push(c("steam-coal", undefined, ["steam", "in-fuel"]))
  }
  return { modules, connections }
}

export function maxUg(this: void, name: string): number {
  return prototypes.entity[name]?.max_underground_distance ?? 5
}

export function layoutProblems(layout: LayoutState, view: TerrainView): string[] {
  return checkLayout(layout, view, maxUg).problems
}

function beltAt(surface: LuaSurface, x: number, y: number): LuaEntity | undefined {
  return surface.find_entities_filtered({ position: { x: x + 0.5, y: y + 0.5 }, type: ["transport-belt", "underground-belt", "splitter"], limit: 1 })[0]
}

/**
 * Follows the built belts of a route the way items would go (belt outputs, underground pairs) and returns undefined
 * if it reaches the consumer's port tile, or where it stopped.
 */
export function followRoute(surface: LuaSurface, layout: LayoutState, route: Route): string | undefined {
  const to = findModule(layout, route.to.module)!
  const target = portTile(to, findPort(to, route.to.port)!)
  const first = route.steps[0]
  let e = first.kind === "splitter" ? beltAt(surface, first.x2!, first.y2!) : beltAt(surface, first.x, first.y)
  for (let i = 0; i < 1000 && e !== undefined; i++) {
    const tx = math.floor(e.position.x)
    const ty = math.floor(e.position.y)
    if (tx === target.x && ty === target.y) return undefined
    if (e.type === "underground-belt" && e.belt_to_ground_type === "input") {
      const n = e.neighbours as LuaEntity | undefined
      if (n === undefined) return `underground at ${tx},${ty} has no exit`
      e = n
      continue
    }
    const outs = e.belt_neighbours.outputs
    if (outs.length === 0) return `belt at ${tx},${ty} (${e.name}) has no output (target ${target.x},${target.y})`
    // A splitter has two outputs: follow the one on this route.
    let next = outs[0]
    if (outs.length > 1) {
      for (const o of outs) {
        for (const s of route.steps) if (math.floor(o.position.x) === s.x && math.floor(o.position.y) === s.y) next = o
      }
    }
    e = next
  }
  return "lost"
}

/** Side-loads a belt's arrival lane check: the first belt into the port tile must point into it. */
export function arrivalOk(surface: LuaSurface, layout: LayoutState, route: Route): boolean {
  const last = route.steps[route.steps.length - 1]
  const e = beltAt(surface, last.x, last.y)
  return e !== undefined && math.floor(e.direction / 4) === last.dir
}

/** Powers every module from an electric-energy-interface next to its power pole (test equipment). */
export function powerModules(surface: LuaSurface, force: LuaForce | string, layout: LayoutState): string[] {
  const problems: string[] = []
  for (const m of layout.modules) {
    for (const p of m.def.ports) {
      if (p.kind !== "power") continue
      const pos = { x: m.origin.x + p.pos.x, y: m.origin.y + p.pos.y }
      const spot = surface.find_non_colliding_position("electric-energy-interface", pos, 4, 0.5, false)
      if (spot === undefined) {
        problems.push(`no room to power ${m.id}`)
        continue
      }
      const eei = surface.create_entity({ name: "electric-energy-interface", position: spot, force })
      if (eei === undefined) problems.push(`could not power ${m.id}`)
      else {
        eei.power_production = 1e7
        eei.electric_buffer_size = 1e8
        eei.energy = 1e8
      }
      // A pole reaching both the module's pole and the interface, in case the interface fell outside its supply area.
      const pole = surface.find_non_colliding_position("small-electric-pole", spot, 3, 1, true)
      if (pole !== undefined) surface.create_entity({ name: "small-electric-pole", position: pole, force })
    }
  }
  return problems
}

export interface Feeder {
  item: string
  lines: LuaTransportLine[]
  perTick: number
  credit: number
  next: number
}

/** Feeders on the external stubs of a layout (test equipment standing in for the crew or another plan). */
export function feeders(surface: LuaSurface, layout: LayoutState, rates: Record<string, number>): Feeder[] {
  const out: Feeder[] = []
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    if (!r.external) continue
    const s = r.steps[0]
    const b = beltAt(surface, s.x, s.y)
    if (b === undefined) continue
    out.push({ item: r.item, lines: [b.get_transport_line(1), b.get_transport_line(2)], perTick: (rates[r.item] ?? 2) / 60, credit: 0, next: 0 })
  }
  return out
}

export function feed(fs: Feeder[]): void {
  for (const f of fs) {
    f.credit = math.min(f.credit + f.perTick, 10)
    while (f.credit >= 1) {
      let ok = false
      for (let k = 0; k < 2; k++) {
        const line = f.lines[(f.next + k) % 2]
        if (line.valid && line.can_insert_at_back() && line.insert_at_back({ name: f.item, count: 1 })) {
          f.next = (f.next + k + 1) % 2
          ok = true
          break
        }
      }
      if (!ok) break
      f.credit -= 1
    }
  }
}

/** Writes an entity dump plus the plan's graph for tools/render (script-output/m4b/<name>.{json,graph.json}). */
export function writeRender(surface: LuaSurface, entry: PlannerEntry, name: string, water = true): void {
  const r = entry.request.region
  let x1 = math.huge
  let y1 = math.huge
  let x2 = -math.huge
  let y2 = -math.huge
  for (const m of entry.job?.layout.modules ?? []) {
    x1 = math.min(x1, m.rect.x)
    y1 = math.min(y1, m.rect.y)
    x2 = math.max(x2, m.rect.x + m.rect.w)
    y2 = math.max(y2, m.rect.y + m.rect.h)
  }
  if (x1 === math.huge) {
    x1 = r.x
    y1 = r.y
    x2 = r.x + r.w
    y2 = r.y + r.h
  }
  const center = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
  const radius = math.max(x2 - x1, y2 - y1) / 2 + 12
  dumpEntities(`m4b/${name}.json`, center, radius, surface, water)
  exportGraph(entry, `m4b/${name}.graph.json`)
}

/** Items to build a layout, from the entities' placing items, plus `extra`. */
export function layoutBill(specs: { name: string }[], extra: Record<string, number> = {}): Record<string, number> {
  const bill: Record<string, number> = { ...extra }
  for (const s of specs) {
    const item = prototypes.entity[s.name].items_to_place_this?.[0]
    if (item !== undefined) bill[item.name] = (bill[item.name] ?? 0) + 1
  }
  return bill
}

export function dirVec(d: number): { x: number; y: number } {
  return { x: DX[d], y: DY[d] }
}

