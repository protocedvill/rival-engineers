// What a layout builds: module entities at their origins plus route entities (belts, underground pairs, splitters,
// side-load blockers), as world entity specs. A splitter tap replaces the tapped route's belt on its first tile.
// Pure: no Factorio globals.

import { worldEntity } from "./world-entity"
import { DX, DY, dirValue, tkey } from "./grid"
import { LayoutState, moduleMargin, moduleTiles, Route, RouteStep } from "./layout"
import type { PoleId, RouteId } from "../shared/ids"

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
  /** D42: a module buffer chest (its slots are limited when built). */
  buffer?: boolean
  /**
   * B100: what the entity carries, for rebuild diffs: a route's item, or `module:<id>` for a module's entities. A belt
   * that carries something else after a rebuild is picked up and placed again, so its old items go with it.
   */
  carries?: string
}

/** Diff key: an entity stands unchanged only with the same name, place, direction, underground end and carried item. */
function diffKey(e: EntitySpec): string {
  return string.format("%s@%g,%g:%g:%s:%s", e.name, e.x, e.y, e.dir, e.ioType ?? "", e.carries ?? "")
}

/** What a rebuild from `before` to `after` picks up and builds (an entity in both, unchanged, stays). */
export function entityDiff(before: EntitySpec[], after: EntitySpec[]): { remove: EntitySpec[]; add: EntitySpec[] } {
  const had: Record<string, boolean> = {}
  for (const e of before) had[diffKey(e)] = true
  const has: Record<string, boolean> = {}
  for (const e of after) has[diffKey(e)] = true
  return { remove: before.filter((e) => !has[diffKey(e)]), add: after.filter((e) => !had[diffKey(e)]) }
}

export function moduleEntities(layout: LayoutState): EntitySpec[] {
  const out: EntitySpec[] = []
  for (const m of layout.modules) for (const e of m.def.entities) out.push({ ...worldEntity(e, m.origin, m.id), carries: `module:${m.id}` })
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
        splitters.push({ name: r.splitter, x: (s.x + s.x2!) / 2 + 0.5, y: (s.y + s.y2!) / 2 + 0.5, dir: dirValue(s.dir), owner: id, carries: r.item })
        replaced[tkey(s.x, s.y)] = true
        continue
      }
      if (r.fluid !== undefined) {
        out.push(fluidEntity(r, s))
        continue
      }
      const spec: EntitySpec = { name: s.kind === "belt" ? r.belt : r.underground, x: s.x + 0.5, y: s.y + 0.5, dir: dirValue(s.dir), owner: id, carries: r.item }
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

/**
 * M7b: the entity of a fluid route step. A pipe-to-ground faces its above-ground side: back against the flow at the
 * entrance, along it at the exit. A pump (two tiles along the flow) faces the flow and sits between its tiles.
 */
function fluidEntity(r: Route, s: RouteStep): EntitySpec {
  const f = r.fluid!
  if (s.kind === "pump") return { name: f.pump, x: s.x + 0.5 + DX[s.dir] / 2, y: s.y + 0.5 + DY[s.dir] / 2, dir: dirValue(s.dir), owner: r.id, carries: f.name }
  if (s.kind === "pipe-ug-in") return { name: f.underground, x: s.x + 0.5, y: s.y + 0.5, dir: dirValue((s.dir + 2) % 4), owner: r.id, carries: f.name }
  if (s.kind === "pipe-ug-out") return { name: f.underground, x: s.x + 0.5, y: s.y + 0.5, dir: dirValue(s.dir), owner: r.id, carries: f.name }
  return { name: f.pipe, x: s.x + 0.5, y: s.y + 0.5, dir: 0, owner: r.id, carries: f.name }
}

/** Which parts of a layout to build (a plan on top of an existing base builds only what it added). */
export interface BuildParts {
  modules: string[]
  routes: RouteId[]
  /** Planned pole ids (layout.poles). */
  poles: PoleId[]
}

/** Every part of a layout. */
export function allParts(layout: LayoutState): BuildParts {
  return { modules: layout.modules.map((m) => m.id), routes: [...layout.routeOrder], poles: (layout.poles ?? []).map((p) => p.id) }
}

/** World entity specs of the listed parts: module entities, route entities (splitters replace tapped belts), poles. */
export function partEntities(layout: LayoutState, parts: BuildParts): EntitySpec[] {
  const out: EntitySpec[] = []
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  for (const m of layout.modules) if (mods[m.id]) for (const e of m.def.entities) out.push({ ...worldEntity(e, m.origin, m.id), carries: `module:${m.id}` })
  const routes: Record<string, boolean> = {}
  for (const id of parts.routes) routes[id] = true
  for (const e of routeEntities(layout)) if (routes[e.owner]) out.push(e)
  const poles: Record<string, boolean> = {}
  for (const id of parts.poles) poles[id] = true
  for (const p of layout.poles ?? []) if (poles[p.id]) out.push({ name: p.name, x: p.x + 0.5, y: p.y + 0.5, dir: 0, owner: p.line })
  return out
}

/** The tiles the listed parts build on (footprints, route tiles, pole tiles). */
export function partTiles(layout: LayoutState, parts: BuildParts): number[] {
  const out: number[] = []
  const seen: Record<number, boolean> = {}
  const add = (k: number): void => {
    if (seen[k]) return
    seen[k] = true
    out.push(k)
  }
  const mods: Record<string, boolean> = {}
  for (const id of parts.modules) mods[id] = true
  for (const m of layout.modules) if (mods[m.id]) for (const k of moduleTiles(m)) add(k)
  for (const id of parts.routes) for (const k of layout.routes[id]?.tiles ?? []) add(k)
  const poles: Record<string, boolean> = {}
  for (const id of parts.poles) poles[id] = true
  for (const p of layout.poles ?? []) if (poles[p.id]) add(tkey(p.x, p.y))
  return out
}

/**
 * What the factory keeps the bootstrap off (`brain.reserved`): every tile the layout builds on plus a one-tile margin
 * around each module. Recomputed from the layout whenever the layout gives up ground (M6a.2: a growth that rerouted a
 * route left its old tiles reserved, and later plans saw them as the faction's own entities; seed 11's labs port was
 * walled in by them).
 */
export function factoryReserveTiles(layout: LayoutState): number[] {
  const out = layoutTiles(layout)
  const seen: Record<number, boolean> = {}
  for (const k of out) seen[k] = true
  // D52 (3): mining outposts' room to grow too (the bootstrap and other factions keep off it).
  for (const [k] of pairs(layout.mine ?? {})) {
    if (seen[k as number]) continue
    seen[k as number] = true
    out.push(k as number)
  }
  for (const m of layout.modules) {
    for (const k of moduleMargin(m)) {
      if (seen[k]) continue
      seen[k] = true
      out.push(k)
    }
  }
  return out
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
  for (const m of layout.modules) for (const k of moduleTiles(m)) add(k)
  for (const id of layout.routeOrder) for (const k of layout.routes[id].tiles) add(k)
  for (const p of layout.poles ?? []) add(tkey(p.x, p.y))
  return out
}

/** Items to build everything (one per entity, by entity name: the item that places it is the caller's mapping). */
export function entityBill(specs: EntitySpec[]): Record<string, number> {
  const bill: Record<string, number> = {}
  for (const e of specs) bill[e.name] = (bill[e.name] ?? 0) + 1
  return bill
}
