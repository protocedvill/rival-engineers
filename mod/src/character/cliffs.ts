// M7d (D83, proposed): destroying cliffs and filling water. Any capsule whose action destroys cliffs (vanilla: cliff explosives) is a
// blasting item; the crew throws it as the scripted projectile (a player-less character cannot use a capsule,
// engine-capabilities "D83 finding").
import { LuaForce } from "factorio:runtime"
import { getConfig } from "../config"

interface BlastItem {
  item: string
  projectile: string
  range: number
}

let cache: BlastItem[] | undefined

/** Every item that destroys cliffs, with its projectile and throw range (from prototypes; computed once per load). */
function blastItems(): BlastItem[] {
  if (cache !== undefined) return cache
  cache = []
  for (const [name, proto] of pairs(prototypes.item)) {
    if (proto.type !== "capsule") continue
    const action = proto.capsule_action as unknown as { type: string; attack_parameters?: { range?: number; ammo_type?: { action?: unknown } } } | undefined
    if (action === undefined || action.type !== "destroy-cliffs") continue
    const range = action.attack_parameters?.range ?? 10
    cache.push({ item: name as string, projectile: projectileOf(action.attack_parameters?.ammo_type?.action) ?? (name as string), range })
  }
  cache.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
  return cache
}

/** The first projectile named in a trigger (an action or a list of them, each with a delivery or a list of them). */
function projectileOf(trigger: unknown): string | undefined {
  const list = (trigger as { type?: string }[] | { type?: string } | undefined)
  if (list === undefined) return undefined
  const items = (list as { type?: string }).type !== undefined ? [list as Record<string, unknown>] : (list as Record<string, unknown>[])
  for (const t of items) {
    const d = t.action_delivery as Record<string, unknown> | Record<string, unknown>[] | undefined
    if (d === undefined) continue
    const ds = (d as Record<string, unknown>).type !== undefined ? [d as Record<string, unknown>] : (d as Record<string, unknown>[])
    for (const x of ds) if (x.type === "projectile" && typeof x.projectile === "string") return x.projectile
  }
  return undefined
}

/** The item `force` can make to destroy cliffs (its recipe is enabled), or undefined. */
export function blastItemFor(force: LuaForce): string | undefined {
  for (const b of blastItems()) if (force.recipes[b.item]?.enabled === true) return b.item
  return undefined
}

export function blastProjectile(item: string): string {
  for (const b of blastItems()) if (b.item === item) return b.projectile
  return item
}

export function blastRange(item: string): number {
  for (const b of blastItems()) if (b.item === item) return b.range
  return 10
}

/** M7d (D83): whether `force`'s plans may take cliff tiles (it can make a blasting item; the cost setting allows it). */
export function canBlastFor(force: LuaForce | undefined): boolean {
  return force !== undefined && getConfig().plannerCliffClearCost >= 0 && blastItemFor(force) !== undefined
}

/** Entity types a build clears off its tiles first: trees and rocks, and cliffs once the force can blast them. */
export function obstacleTypes(force: LuaForce | undefined): string[] {
  return canBlastFor(force) ? ["tree", "simple-entity", "cliff"] : ["tree", "simple-entity"]
}

let fillCache: { item: string; tile: string }[] | undefined

/**
 * Items that turn water into land (vanilla: landfill): an item placing a tile that may only go where there is no
 * ground (its placement condition holds `ground_tile`).
 */
function fillItems(): { item: string; tile: string }[] {
  if (fillCache !== undefined) return fillCache
  fillCache = []
  for (const [name, proto] of pairs(prototypes.item)) {
    const r = proto.place_as_tile_result
    if (r === undefined) continue
    const layers = (r.condition as unknown as { layers?: Record<string, boolean> }).layers
    if (layers?.["ground_tile"] !== true) continue
    fillCache.push({ item: name as string, tile: r.result.name })
  }
  fillCache.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
  return fillCache
}

/** The item `force` can make to fill water (its recipe is enabled), or undefined. */
export function fillItemFor(force: LuaForce): string | undefined {
  for (const f of fillItems()) if (force.recipes[f.item]?.enabled === true) return f.item
  return undefined
}

/** The tile `item` places. */
export function fillTile(item: string): string {
  for (const f of fillItems()) if (f.item === item) return f.tile
  return item
}

/** M7d (D83): whether `force`'s routes and pole lines may cross water tiles (it can make landfill; the setting allows). */
export function canFillFor(force: LuaForce | undefined): boolean {
  return force !== undefined && getConfig().plannerLandfillCost > 0 && fillItemFor(force) !== undefined
}
