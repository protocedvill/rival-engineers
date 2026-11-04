// M7c runtime glue for fluids: fluid connections and pumpjack fields chosen from the faction's real wells. The design
// sizes a pumpjack field on nominal wells (it cannot know a field before it plans); when a goal plans it, the module is
// generated again from a real field near the plan's centre and placed exactly there (`ModuleRequest.at`).

import { LuaSurface } from "factorio:runtime"
import { decodeWells, encodeWells } from "../modules/generators"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import type { Rect, Vec } from "../planner/grid"
import type { ConnectionRequest } from "../planner/plan"
import { isStructureType } from "../planner/terrain"
import { findEntities } from "../work"

/** Wells this close (Chebyshev tiles) belong to one field (agent guess: vanilla fields space wells a few tiles apart). */
const FIELD_JOIN = 12
/** A pumpjack field's margin around its pumpjacks (`PUMPJACK_FIELD_MARGIN` in the generator). */
const FIELD_MARGIN = 2

/** The fluid connection a goal's edge of `item` needs (undefined: `item` is no fluid, a belt carries it). */
export function fluidConnection(item: string, pole: string): ConnectionRequest["fluid"] | undefined {
  if (prototypes.fluid[item] === undefined) return undefined
  const extent = (prototypes.utility_constants as unknown as { default_pipeline_extent?: number }).default_pipeline_extent ?? 320
  return { name: item, pipe: "pipe", underground: "pipe-to-ground", pump: "pump", maxUnderground: prototypeFacts.entity("pipe-to-ground")?.maxPipeUnderground ?? 10, extent, pole }
}

interface Well {
  x: number
  y: number
  perSecond: number
}

/** Crude per second a pumpjack makes on a well (its product per cycle × mining speed / time × the well's yield). */
function wellRate(resource: string, amount: number, pumpjack: string): number {
  const p = prototypes.entity[resource]
  const product = p?.mineable_properties.products?.[0]
  const normal = p?.normal_resource_amount ?? 0
  const time = p?.mineable_properties.mining_time ?? 1
  const speed = prototypes.entity[pumpjack]?.mining_speed ?? 1
  if (product === undefined || normal <= 0) return 0
  return ((product.amount ?? 10) * speed * (amount / normal)) / time
}

/**
 * A pumpjack field module for `need` per second of `resource` from the wells inside `region`: the nearest field to
 * `center` that yields enough, else the richest. Undefined when no well is known there. Only chunks `known` to the
 * faction count (home zone, explored strips, radar-scanned chunks).
 */
/**
 * M7c.8 (seed 11, minute 720–747): whether a pumpjack (built or a ghost, any force) already stands on a well. A second
 * crude provider was placed on the only known field again and again ("no room at its fixed spot", 8 failed plans in a
 * row): a field whose wells are all taken is no field for a new provider, so the goal explores for another one.
 */
function wellTaken(surface: LuaSurface, at: Vec): boolean {
  const area = { left_top: { x: at.x - 0.4, y: at.y - 0.4 }, right_bottom: { x: at.x + 0.4, y: at.y + 0.4 } }
  return findEntities(surface, { type: "mining-drill", area, limit: 1 }).length > 0 || findEntities(surface, { ghost_type: "mining-drill", area, limit: 1 }).length > 0
}

export function fieldModule(surface: LuaSurface, region: Rect, known: (this: void, cx: number, cy: number) => boolean, center: Vec, resource: string, need: number, pumpjack: string, make: (this: void, params: Record<string, unknown>) => ModuleDef, taken?: Record<string, boolean>, avoid: Rect[] = []): { def: ModuleDef; at: Vec } | undefined {
  // B115: only known ground (the plan's chunk rule), generated now if it is not yet: a mine's patch search generates its
  // chunks through the planner's terrain scan, this search reads the surface directly.
  const chunks: Vec[] = []
  let missing = 0
  for (let cy = math.floor(region.y / 32); cy <= math.floor((region.y + region.h - 1) / 32); cy++) {
    for (let cx = math.floor(region.x / 32); cx <= math.floor((region.x + region.w - 1) / 32); cx++) {
      if (!known(cx, cy)) continue
      chunks.push({ x: cx, y: cy })
      if (!surface.is_chunk_generated({ x: cx, y: cy })) {
        surface.request_to_generate_chunks({ x: cx * 32 + 16, y: cy * 32 + 16 }, 0)
        missing++
      }
    }
  }
  if (missing > 0) surface.force_generate_chunk_requests()
  const wells: Well[] = []
  for (const c of chunks) {
    const area = { left_top: { x: c.x * 32, y: c.y * 32 }, right_bottom: { x: c.x * 32 + 32, y: c.y * 32 + 32 } }
    for (const e of findEntities(surface, { type: "resource", name: resource, area })) {
      // B118: an area search matches boxes that overlap it: a well on a chunk border was found in both chunks.
      if (math.floor(e.position.x / 32) !== c.x || math.floor(e.position.y / 32) !== c.y) continue
      if (wellTaken(surface, e.position) || taken?.[`${math.floor(e.position.x)},${math.floor(e.position.y)}`] === true) continue
      wells.push({ x: math.floor(e.position.x), y: math.floor(e.position.y), perSecond: wellRate(resource, e.amount, pumpjack) })
    }
  }
  if (wells.length === 0) return undefined
  wells.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))
  // Fields: wells joined within FIELD_JOIN.
  const field: number[] = []
  let fields = 0
  for (let i = 0; i < wells.length; i++) {
    if (field[i] !== undefined) continue
    field[i] = fields
    const stack = [i]
    while (stack.length > 0) {
      const a = wells[stack.pop()!]
      for (let j = 0; j < wells.length; j++) {
        if (field[j] !== undefined) continue
        if (math.max(math.abs(wells[j].x - a.x), math.abs(wells[j].y - a.y)) <= FIELD_JOIN) {
          field[j] = fields
          stack.push(j)
        }
      }
    }
    fields++
  }
  // M7c.8: fields in order of preference; one that can't be laid out (every well on a cliff, or the generator finds no
  // layout) is skipped for the next, rather than reading as no field at all (seed 11 explored 2000 tiles out for crude
  // while a free field lay 30 tiles from its first one).
  const tried: Record<number, boolean> = {}
  for (;;) {
    let best: { i: number; total: number; d: number } | undefined
    for (let k = 0; k < fields; k++) {
      if (tried[k]) continue
      let total = 0
      let cx = 0
      let cy = 0
      let n = 0
      for (let i = 0; i < wells.length; i++) {
        if (field[i] !== k) continue
        total += wells[i].perSecond
        cx += wells[i].x
        cy += wells[i].y
        n++
      }
      const d = math.abs(cx / n - center.x) + math.abs(cy / n - center.y)
      const enough = total >= need
      const better = best === undefined || (enough && (best.total < need || d < best.d)) || (!enough && best.total < need && total > best.total)
      if (better) best = { i: k, total, d }
    }
    if (best === undefined) return undefined
    tried[best.i] = true
    const built = layField(surface, wells.filter((_, i) => field[i] === best!.i), resource, pumpjack, make, avoid)
    if (built !== undefined) return built
  }
}

/** One field's module: its wells minus those on cliffs or water (B119); undefined when none is left or no layout fits. */
function layField(surface: LuaSurface, wells: Well[], resource: string, pumpjack: string, make: (this: void, params: Record<string, unknown>) => ModuleDef, avoid: Rect[]): { def: ModuleDef; at: Vec } | undefined {
  let chosen = wells
  // B119: cliffs and water in the field's box (seed 11's wells sit in a ring of cliffs). Pumpjacks on them are left
  // out; the generator routes pipes and poles around the rest.
  const box = (ws: Well[]): Rect => {
    let minX = math.huge
    let minY = math.huge
    let maxX = -math.huge
    let maxY = -math.huge
    for (const w of ws) {
      minX = math.min(minX, w.x)
      minY = math.min(minY, w.y)
      maxX = math.max(maxX, w.x)
      maxY = math.max(maxY, w.y)
    }
    return { x: minX - 1 - FIELD_MARGIN, y: minY - 1 - FIELD_MARGIN, w: maxX - minX + 3 + 2 * FIELD_MARGIN, h: maxY - minY + 3 + 2 * FIELD_MARGIN }
  }
  const b = box(chosen)
  const fieldArea = { left_top: { x: b.x, y: b.y }, right_bottom: { x: b.x + b.w, y: b.y + b.h } }
  const hard: Record<string, boolean> = {}
  const tiles: string[] = []
  const mark = (x: number, y: number): void => {
    const k = `${x},${y}`
    if (hard[k] || x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return
    hard[k] = true
    tiles.push(k)
  }
  for (const c of findEntities(surface, { type: "cliff", area: fieldArea })) {
    const bb = c.bounding_box
    for (let x = math.floor(bb.left_top.x); x < math.ceil(bb.right_bottom.x); x++) for (let y = math.floor(bb.left_top.y); y < math.ceil(bb.right_bottom.y); y++) mark(x, y)
  }
  for (const t of surface.find_tiles_filtered({ area: fieldArea, collision_mask: "water_tile" })) mark(t.position.x, t.position.y)
  chosen = chosen.filter((w) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (hard[`${w.x + dx},${w.y + dy}`]) return false
    return true
  })
  if (chosen.length === 0) return undefined
  // M7c.9 (seed 11, g166/g167: "no room at its fixed spot: structure at -442,-169", 8 plans): the module is placed at
  // its wells' box exactly, and only open ground there is its own; a structure in the box (another field's pumpjack and
  // poles 4 tiles off its edge well, a planned module) blocks it. Wells next to one are left out until the box is clear.
  const blockers: Rect[] = []
  for (const r of avoid) if (r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y) blockers.push(r)
  // Seed 1212121 g111/g112: a cliff stood between the field's wells, so every well's own 3×3 was clear but the fixed
  // module box still covered it and the plan failed "blocked (terrain cliff)". Treat each hard tile in the box as a
  // blocker too, so the nearest well is dropped and the box shrinks away from it.
  for (const [k] of pairs(hard)) {
    const parts = (k as string).split(",")
    blockers.push({ x: tonumber(parts[0])!, y: tonumber(parts[1])!, w: 1, h: 1 })
  }
  for (const e of findEntities(surface, { area: fieldArea })) {
    if (!isStructureType(e.type)) continue
    const bb = e.bounding_box
    const x = math.floor(bb.left_top.x)
    const y = math.floor(bb.left_top.y)
    blockers.push({ x, y, w: math.ceil(bb.right_bottom.x) - x, h: math.ceil(bb.right_bottom.y) - y })
  }
  for (;;) {
    const bx = box(chosen)
    let worst: { i: number; d: number } | undefined
    for (const r of blockers) {
      if (!(r.x < bx.x + bx.w && r.x + r.w > bx.x && r.y < bx.y + bx.h && r.y + r.h > bx.y)) continue
      // The well nearest the blocker (Manhattan distance from its centre to the rect) goes; ties keep sort order.
      for (let i = 0; i < chosen.length; i++) {
        const w = chosen[i]
        const d = math.max(r.x - (w.x + 0.5), w.x + 0.5 - (r.x + r.w), 0) + math.max(r.y - (w.y + 0.5), w.y + 0.5 - (r.y + r.h), 0)
        if (worst === undefined || d < worst.d) worst = { i, d }
      }
    }
    if (worst === undefined) break
    chosen = chosen.filter((_, i) => i !== worst!.i)
    if (chosen.length === 0) return undefined
  }
  const at = box(chosen)
  // The generator leaves out wells it cannot pipe to the port; none left means no field here.
  const [ok, def] = pcall(make, { wells: encodeWells(chosen), resource, pumpjack, obstacles: tiles.length > 0 ? tiles.join(";") : undefined })
  if (!ok) {
    log(`[rival-engineers] pumpjack field at ${at.x},${at.y}: ${tostring(def)}`)
    return undefined
  }
  return { def: def as ModuleDef, at: { x: at.x, y: at.y } }
}

/**
 * M7c.8: wells (tile `x,y`) of pumpjack-field modules, planned or built: a new field must not take them. A goal with two
 * crude providers picked the same free field twice (seed 11, g164/g165: "no room at its fixed spot", 8 plans), since
 * `wellTaken` sees only pumpjacks already on the ground.
 */
export function moduleWells(defs: ModuleDef[], into: Record<string, boolean> = {}): Record<string, boolean> {
  for (const d of defs) {
    if (d.generator !== "pumpjack-field" || typeof d.params?.wells !== "string") continue
    for (const w of decodeWells(d.params.wells as string)) into[`${w.x},${w.y}`] = true
  }
  return into
}
