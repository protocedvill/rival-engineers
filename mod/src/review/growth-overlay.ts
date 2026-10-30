import { Color, LuaPlayer, LuaRenderObject, LuaSurface } from "factorio:runtime"
import { entityRect } from "../modules/geometry"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleEntity } from "../modules/types"
import { Rect, tkey } from "../planner/grid"
import { growthUnitRects, LayoutState, PlacedModule, plannedGrowthUnits } from "../planner/layout"
import { getFactory } from "../strategy/factory"
import { OverlayContext, registerOverlayLayer } from "./overlay"

// B33: in-game growth-plan overlay (review tools, off by default). Per module of the faction's layout:
// - expandable modules: the footprint (white), the planned growth units in order (+1, +2, ...: amber, the first ones
//   brightest), an arrow from the module to its last planned unit (the growth direction), and for a strip mine the
//   units its cap would allow past the end of its ore (red, not claimed);
// - D52 whole-patch mines: the full planned footprint (violet), built drills (green), still unbuilt planned drills
//   (violet, thin), and the outline of the ore patch around them (yellow, read from the surface's resources).
// Rendering only: nothing is stored besides the render objects the overlay framework already tracks. Read this
// overlay before debugging growth placement: it shows the space the planner plans to use, not only what is built.

const WHITE: Color = { r: 0.9, g: 0.9, b: 0.9, a: 0.8 }
const AMBER: Color = { r: 1, g: 0.65, b: 0.1 }
const AMBER_DIM: Color = { r: 0.6, g: 0.4, b: 0.1, a: 0.6 }
const RED: Color = { r: 1, g: 0.2, b: 0.2, a: 0.7 }
const VIOLET: Color = { r: 0.75, g: 0.35, b: 1 }
const GREEN: Color = { r: 0.25, g: 0.95, b: 0.3 }
const ORE: Color = { r: 1, g: 0.95, b: 0.2 }

/** Caps per redraw (a big base stays cheap). */
export const GROWTH_MAX_MODULES = 80
export const GROWTH_MAX_ORE_EDGES = 3000

export interface GrowthDrawCounts {
  modules: number
  units: number
  offOre: number
  plannedDrills: number
  builtDrills: number
  oreEdges: number
}

type Add = (this: void, obj: LuaRenderObject) => void

function key(e: ModuleEntity): string {
  return string.format("%s@%g,%g", e.name, e.x, e.y)
}

function box(surface: LuaSurface, players: LuaPlayer[] | undefined, ttl: number, add: Add, r: Rect, color: Color, width: number, dashed = false): void {
  const lt = { x: r.x, y: r.y }
  const rb = { x: r.x + r.w, y: r.y + r.h }
  if (!dashed) {
    add(rendering.draw_rectangle({ color, width, filled: false, left_top: lt, right_bottom: rb, surface, players, time_to_live: ttl }))
    return
  }
  const corners = [lt, { x: rb.x, y: lt.y }, rb, { x: lt.x, y: rb.y }]
  for (let i = 0; i < 4; i++) add(rendering.draw_line({ color, width, from: corners[i], to: corners[(i + 1) % 4], dash_length: 0.5, gap_length: 0.4, surface, players, time_to_live: ttl }))
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

function drawStrip(m: PlacedModule, surface: LuaSurface, players: LuaPlayer[] | undefined, ttl: number, add: Add, n: GrowthDrawCounts): void {
  const spec = m.canonical.expand
  if (spec === undefined || spec.maxUnits <= 0) return
  const planned = plannedGrowthUnits(m)
  const units = growthUnitRects(m, spec.maxUnits)
  box(surface, players, ttl, add, m.rect, WHITE, 1)
  for (let i = 0; i < units.length; i++) {
    const r = units[i]
    if (i < planned) {
      box(surface, players, ttl, add, r, i < 2 ? AMBER : AMBER_DIM, i < 2 ? 2 : 1)
      add(rendering.draw_text({ text: `+${i + 1}`, surface, target: center(r), color: i < 2 ? AMBER : AMBER_DIM, scale: 1, alignment: "center", vertical_alignment: "middle", players, time_to_live: ttl }))
      n.units++
    } else if (m.oreUnits !== undefined) {
      // A strip mine's cap past its ore: not claimed, never grown.
      box(surface, players, ttl, add, r, RED, 1, true)
      n.offOre++
    }
  }
  if (planned > 0) {
    const from = center(m.rect)
    const to = center(units[planned - 1])
    add(rendering.draw_line({ color: AMBER, width: 3, from, to, surface, players, time_to_live: ttl }))
    add(rendering.draw_circle({ color: AMBER, radius: 0.5, width: 3, filled: true, target: to, surface, players, time_to_live: ttl }))
    add(rendering.draw_text({ text: `${m.id} grows ${planned}/${spec.maxUnits} units`, surface, target: { x: m.rect.x + 0.2, y: m.rect.y - 0.9 }, color: AMBER, scale: 1, players, time_to_live: ttl }))
  }
}

function drawMinePlan(m: PlacedModule, surface: LuaSurface, players: LuaPlayer[] | undefined, ttl: number, add: Add, n: GrowthDrawCounts): void {
  const plan = m.minePlan!
  const full = plan.full
  box(surface, players, ttl, add, { x: m.origin.x, y: m.origin.y, w: full.footprint.w, h: full.footprint.h }, VIOLET, 2)
  const built: Record<string, boolean> = {}
  for (const e of m.def.entities) built[key(e)] = true
  let resource: string | undefined
  let nBuilt = 0
  let nPlanned = 0
  for (const e of full.entities) {
    const f = prototypeFacts.entity(e.name)
    if (f?.type !== "mining-drill") continue
    resource ??= e.mines
    const r = entityRect(e, prototypeFacts)
    const wr = { x: m.origin.x + r.x, y: m.origin.y + r.y, w: r.w, h: r.h }
    if (built[key(e)]) {
      box(surface, players, ttl, add, wr, GREEN, 2)
      nBuilt++
    } else {
      box(surface, players, ttl, add, wr, VIOLET, 1, true)
      nPlanned++
    }
  }
  add(rendering.draw_text({ text: `${m.id} mine plan: ${nBuilt} built / ${nBuilt + nPlanned} planned drills${plan.complete ? " (complete)" : ""}`, surface, target: { x: m.origin.x + 0.2, y: m.origin.y - 0.9 }, color: VIOLET, scale: 1, players, time_to_live: ttl }))
  n.builtDrills += nBuilt
  n.plannedDrills += nPlanned
  if (resource === undefined) return
  // The patch around the plan: resource tiles of the mine's ore in its footprint plus a margin, outlined.
  const margin = 8
  const area = { left_top: { x: m.origin.x - margin, y: m.origin.y - margin }, right_bottom: { x: m.origin.x + full.footprint.w + margin, y: m.origin.y + full.footprint.h + margin } }
  const tiles: Record<number, boolean> = {}
  const list: { x: number; y: number }[] = []
  for (const e of surface.find_entities_filtered({ area, name: resource })) {
    const x = math.floor(e.position.x)
    const y = math.floor(e.position.y)
    tiles[tkey(x, y)] = true
    list.push({ x, y })
  }
  for (const p of list) {
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      if (tiles[tkey(p.x + dx, p.y + dy)]) continue
      if (n.oreEdges >= GROWTH_MAX_ORE_EDGES) return
      const from = dx === 1 ? { x: p.x + 1, y: p.y } : dy === 1 ? { x: p.x, y: p.y + 1 } : { x: p.x, y: p.y }
      const to = dx === -1 ? { x: p.x, y: p.y + 1 } : dy === -1 ? { x: p.x + 1, y: p.y } : { x: p.x + 1, y: p.y + 1 }
      add(rendering.draw_line({ color: ORE, width: 1, from, to, surface, players, time_to_live: ttl, draw_on_ground: true }))
      n.oreEdges++
    }
  }
}

/** Draws a layout's growth plans on `surface` (for `players`, or everyone when undefined). Returns what it drew. */
export function drawGrowthLayout(layout: LayoutState, surface: LuaSurface, players: LuaPlayer[] | undefined, ttl: number, add: Add): GrowthDrawCounts {
  const n: GrowthDrawCounts = { modules: 0, units: 0, offOre: 0, plannedDrills: 0, builtDrills: 0, oreEdges: 0 }
  for (const m of layout.modules) {
    if (n.modules >= GROWTH_MAX_MODULES) break
    if (m.minePlan !== undefined) drawMinePlan(m, surface, players, ttl, add, n)
    else if (m.canonical.expand !== undefined && m.canonical.expand.maxUnits > 0) drawStrip(m, surface, players, ttl, add, n)
    else continue
    n.modules++
  }
  return n
}

function drawGrowth(ctx: OverlayContext): void {
  const f = getFactory(ctx.faction.name)
  if (f === undefined) return
  const surface = game.get_surface(ctx.faction.surface)
  if (surface === undefined) return
  drawGrowthLayout(f.layout, surface, [ctx.player], ctx.ttl, ctx.add)
  // The last failed in-place growth plan per module: the reason a grow goal gave up, next to the module.
  for (const m of f.layout.modules) {
    const fail = f.growthDiagnostics?.[m.id]
    if (fail === undefined) continue
    add(ctx, `growth failed t${fail.tick} (${fail.units} units): ${fail.reason}`, { x: m.rect.x + 0.2, y: m.rect.y + m.rect.h + 0.3 })
  }
}

function add(ctx: OverlayContext, text: string, target: { x: number; y: number }): void {
  ctx.add(rendering.draw_text({ text, surface: ctx.faction.surface, target, color: RED, scale: 1, players: [ctx.player], time_to_live: ctx.ttl }))
}

registerOverlayLayer("growth", "Growth plans (next units, mine plans, ore)", drawGrowth, false)
