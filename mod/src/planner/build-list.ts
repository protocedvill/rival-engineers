// What a layout builds: module entities at their origins plus route entities (belts, underground pairs, splitters,
// side-load blockers), as world entity specs. A splitter tap replaces the tapped route's belt on its first tile.
// Pure: no Factorio globals.

import { worldEntity } from "./world-entity"
import { dirValue, tkey } from "./grid"
import { LayoutState } from "./layout"

export interface EntitySpec {
  name: string
  /** Centre, world. */
  x: number
  y: number
  /** Factorio direction (0, 4, 8, 12). */
  dir: number
  recipe?: string
  ioType?: "input" | "output"
  /** Module instance or route id. */
  owner: string
}

export function moduleEntities(layout: LayoutState): EntitySpec[] {
  const out: EntitySpec[] = []
  for (const m of layout.modules) for (const e of m.def.entities) out.push(worldEntity(e, m.origin, m.id))
  return out
}

export function routeEntities(layout: LayoutState): EntitySpec[] {
  const out: EntitySpec[] = []
  const splitters: EntitySpec[] = []
  const replaced: Record<number, boolean> = {}
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    const steps = r.blocker ? [...r.steps, r.blocker] : r.steps
    for (const s of steps) {
      if (s.kind === "splitter") {
        splitters.push({ name: r.splitter, x: (s.x + s.x2!) / 2 + 0.5, y: (s.y + s.y2!) / 2 + 0.5, dir: dirValue(s.dir), owner: id })
        replaced[tkey(s.x, s.y)] = true
        continue
      }
      const spec: EntitySpec = { name: s.kind === "belt" ? r.belt : r.underground, x: s.x + 0.5, y: s.y + 0.5, dir: dirValue(s.dir), owner: id }
      if (s.kind === "ug-in") spec.ioType = "input"
      if (s.kind === "ug-out") spec.ioType = "output"
      out.push(spec)
    }
  }
  const kept: EntitySpec[] = []
  for (const e of out) if (!replaced[tkey(math.floor(e.x), math.floor(e.y))]) kept.push(e)
  for (const s of splitters) kept.push(s)
  return kept
}

/** Every tile the layout builds on (footprints, route tiles, splitter tiles): where trees and rocks must go. */
export function layoutTiles(layout: LayoutState): number[] {
  const out: number[] = []
  const seen: Record<number, boolean> = {}
  const add = (k: number): void => {
    if (seen[k]) return
    seen[k] = true
    out.push(k)
  }
  for (const m of layout.modules) for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++) for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++) add(tkey(x, y))
  for (const id of layout.routeOrder) for (const k of layout.routes[id].tiles) add(k)
  return out
}

/** Items to build everything (one per entity, by entity name: the item that places it is the caller's mapping). */
export function entityBill(specs: EntitySpec[]): Record<string, number> {
  const bill: Record<string, number> = {}
  for (const e of specs) bill[e.name] = (bill[e.name] ?? 0) + 1
  return bill
}
