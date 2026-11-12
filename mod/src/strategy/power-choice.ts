import type { MapPosition } from "factorio:runtime"
import type { ProtoFacts } from "../modules/facts"
import type { Patch } from "../world/resources"
import * as CS from "./constraints"
import type { ConstraintStore } from "./constraints"

// B185 (user, in-session 2026-11-11): new power comes from solar fields only when building them takes less time than a
// steam block with its own coal mine and belt from the nearest free coal patch, or when no coal can be found. The time
// is a crude estimate: crew seconds per placed entity, walking out and back along the belt, and the raw resources of
// everything placed at the factory's plate rate. Pure: no Factorio globals (T1: mod/unit/power-choice.test.ts).

/** Proposed: crew seconds to place one entity, fetching it and short walks included. */
export const CREW_ENTITY_SECONDS = 2
/** Game data: a character runs 0.15 tiles/tick (no exoskeleton). */
export const CREW_TILES_PER_SECOND = 9

/** What one option places: entity name → count, and the tiles the crew walk for it. */
export interface BuildEstimate {
  entities: { name: string; count: number }[]
  walkTiles: number
}

/** Raw resources (ore, wood...) per item through its recipe chain; fluids cost nothing here. */
export function rawCost(facts: ProtoFacts, item: string, memo: Record<string, number> = {}, depth = 0): number {
  const known = memo[item]
  if (known !== undefined) return known
  if (facts.isFluid?.(item) === true) return 0
  const name = facts.recipeForItem(item)
  const recipe = name !== undefined ? facts.recipe(name) : undefined
  let out = 0
  for (const p of recipe?.products ?? []) if (p.name === item) out += p.amount
  if (recipe === undefined || out <= 0 || depth > 12) {
    memo[item] = 1
    return 1
  }
  memo[item] = 1 // a cycle reads as raw
  let cost = 0
  for (const ing of recipe.ingredients) if (ing.fluid !== true) cost += ing.amount * rawCost(facts, ing.name, memo, depth + 1)
  memo[item] = cost / out
  return memo[item]
}

/** Seconds to build an option: crew placing and walking, plus its raw resources at `platesPerSecond`. */
export function buildSeconds(facts: ProtoFacts, est: BuildEstimate, platesPerSecond: number): number {
  const memo: Record<string, number> = {}
  let placed = 0
  let raw = 0
  for (const e of est.entities) {
    placed += e.count
    raw += e.count * rawCost(facts, facts.itemToPlace(e.name) ?? e.name, memo)
  }
  const materials = platesPerSecond > 0 ? raw / platesPerSecond : math.huge
  return placed * CREW_ENTITY_SECONDS + est.walkTiles / CREW_TILES_PER_SECOND + materials
}

/** Adds `count` of `name` to an entity list (merging). */
export function addEntities(list: { name: string; count: number }[], name: string, count: number): void {
  if (count <= 0) return
  for (const e of list) {
    if (e.name === name) {
      e.count += count
      return
    }
  }
  list.push({ name, count })
}

/** Known patches of a resource (by resource or product name). */
export function patchCount(patches: Patch[], what: string): number {
  let n = 0
  for (const p of patches) if (p.name === what || p.product === what) n++
  return n
}

/**
 * Power must come from solar fields: a steam block's fuel found no patch (`solarPower` holds the patch count known at the
 * failure; a flag from before counts as no news), and the exploration has found no new patch of it since.
 */
export function noCoal(constraints: ConstraintStore | undefined, patches: Patch[]): boolean {
  for (const what of CS.keys(constraints, "solarPower")) {
    const seen = CS.value(constraints, "solarPower", what)
    if (seen === undefined || patchCount(patches, what) <= seen) return true
  }
  return false
}

/** Proposed: a coal patch needs this many tiles no mine covers to count as free (the bootstrap's smallest patch). */
export const MIN_FREE_FUEL_TILES = 8

/** A placed module as far as the coal distance needs it. */
export interface MineFootprint {
  canonical: { anchor?: { resource?: string } }
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * Tiles from `from` to the nearest known patch of `fuel` with free tiles (its tile count less the share of its box that
 * mines of it cover), or `math.huge` when there is none.
 */
export function coalDistance(modules: MineFootprint[], patches: Patch[], from: MapPosition, fuel: string): number {
  let best = math.huge
  for (const p of patches) {
    if (p.product !== fuel) continue
    const area = (p.x2 - p.x1 + 1) * (p.y2 - p.y1 + 1)
    let covered = 0
    for (const m of modules) {
      if (m.canonical.anchor?.resource !== p.name) continue
      const w = math.min(p.x2 + 1, m.rect.x + m.rect.w) - math.max(p.x1, m.rect.x)
      const h = math.min(p.y2 + 1, m.rect.y + m.rect.h) - math.max(p.y1, m.rect.y)
      if (w > 0 && h > 0) covered += w * h
    }
    if (p.tiles * (1 - math.min(1, covered / area)) < MIN_FREE_FUEL_TILES) continue
    const dx = math.max(p.x1 - from.x, 0, from.x - p.x2)
    const dy = math.max(p.y1 - from.y, 0, from.y - p.y2)
    best = math.min(best, math.sqrt(dx * dx + dy * dy))
  }
  return best
}
