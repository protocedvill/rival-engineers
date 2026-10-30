// M7c runtime glue for fluids: fluid connections and pumpjack fields chosen from the faction's real wells. The design
// sizes a pumpjack field on nominal wells (it cannot know a field before it plans); when a goal plans it, the module is
// generated again from a real field near the plan's centre and placed exactly there (`ModuleRequest.at`).

import { LuaSurface } from "factorio:runtime"
import { encodeWells } from "../modules/generators"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import type { Rect, Vec } from "../planner/grid"
import type { ConnectionRequest } from "../planner/plan"
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
 * `center` that yields enough, else the richest. Undefined when no well is known there.
 */
export function fieldModule(surface: LuaSurface, region: Rect, center: Vec, resource: string, need: number, pumpjack: string, make: (this: void, params: Record<string, unknown>) => ModuleDef): { def: ModuleDef; at: Vec } | undefined {
  const area = { left_top: { x: region.x, y: region.y }, right_bottom: { x: region.x + region.w, y: region.y + region.h } }
  const wells: Well[] = []
  for (const e of findEntities(surface, { type: "resource", name: resource, area })) {
    wells.push({ x: math.floor(e.position.x), y: math.floor(e.position.y), perSecond: wellRate(resource, e.amount, pumpjack) })
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
  let best: { i: number; total: number; d: number } | undefined
  for (let k = 0; k < fields; k++) {
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
  const chosen = wells.filter((_, i) => field[i] === best!.i)
  let minX = math.huge
  let minY = math.huge
  for (const w of chosen) {
    minX = math.min(minX, w.x)
    minY = math.min(minY, w.y)
  }
  const def = make({ wells: encodeWells(chosen), resource, pumpjack })
  return { def, at: { x: minX - 1 - FIELD_MARGIN, y: minY - 1 - FIELD_MARGIN } }
}
