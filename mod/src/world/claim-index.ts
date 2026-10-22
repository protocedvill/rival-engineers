// Typed owner/kind boundary over a faction's world claim tables (`BrainState.reserved` / `oreFields`). The tile sets
// stay plain maps: old saves and other factions read them, and the planner treats them as terrain. This module owns
// the tag spelling, the paired owner index and the invariants, so a reservation can no longer be placed or dropped
// without saying who owns it. Pure: no Factorio globals.

import { keyX, keyY, tkey } from "../planner/grid"
import { LayoutState, moduleMargin, moduleTiles } from "../planner/layout"

/** A tile reservation table as stored in `BrainState`. `reservedBy` is absent in saves made before it existed. */
export interface WorldClaimTable {
  reserved: Record<number, boolean>
  reservedBy?: Record<number, string>
}

/** A bootstrap site as the claim sync needs it (the real `Site` satisfies this structurally). */
export interface ClaimSite {
  id: number
  status: string
  tiles: number[]
}

export type WorldClaimKind = "site" | "module" | "route" | "pole" | "mine"

export function siteClaim(id: number): string {
  return `site:${id}`
}

export function moduleClaim(id: string): string {
  return `module:${id}`
}

export function routeClaim(id: string): string {
  return `route:${id}`
}

export function poleClaim(id: string): string {
  return `pole:${id}`
}

export function mineClaim(id: string): string {
  return `mine:${id}`
}

/** The kind a tag names, or undefined for a malformed tag. */
export function claimKind(tag: string): WorldClaimKind | undefined {
  const colon = string.find(tag, ":")[0]
  if (colon === undefined) return undefined
  const kind = string.sub(tag, 1, colon - 1)
  if (kind === "site" || kind === "module" || kind === "route" || kind === "pole" || kind === "mine") return kind as WorldClaimKind
  return undefined
}

export function claimOwner(tag: string): string {
  const colon = string.find(tag, ":")[0]
  return colon !== undefined ? string.sub(tag, colon + 1) : ""
}

/** Reserves a tile for `tag`, recording the owner in the paired index. */
export function reserveWorldTile(table: WorldClaimTable, key: number, tag: string): void {
  table.reserved[key] = true
  table.reservedBy ??= {}
  table.reservedBy[key] = tag
}

/** Releases a tile and its owner. Returns whether the tile was reserved. */
export function releaseWorldTile(table: WorldClaimTable, key: number): boolean {
  const held = table.reserved[key] === true
  delete table.reserved[key]
  if (table.reservedBy !== undefined) delete table.reservedBy[key]
  return held
}

export function worldClaimTag(table: WorldClaimTable, key: number): string | undefined {
  return table.reserved[key] === true ? table.reservedBy?.[key] : undefined
}

/**
 * Rebuilds the faction's reservations: its live bootstrap sites plus what the factory layout holds. Sites keep their
 * ground (a failed site keeps its bad spot; a retired one gives it up), and factory tiles are owned by the module,
 * route or pole line that builds them. Tiles no longer claimed are dropped with their owner. Returns how many were
 * dropped.
 */
export function syncWorldClaims(table: WorldClaimTable, sites: ClaimSite[], layout: LayoutState): number {
  const keep: Record<number, string> = {}
  for (const site of sites) {
    if (site.status === "retired") continue
    for (const k of site.tiles) keep[k] = siteClaim(site.id)
  }
  for (const m of layout.modules) {
    for (const k of moduleTiles(m)) keep[k] = moduleClaim(m.id)
    for (const k of moduleMargin(m)) keep[k] = moduleClaim(m.id)
  }
  for (const id of layout.routeOrder) for (const k of layout.routes[id].tiles) keep[k] = routeClaim(id)
  for (const p of layout.poles ?? []) keep[tkey(p.x, p.y)] = poleClaim(p.id)
  for (const [k, owner] of pairs(layout.mine ?? {})) keep[k as number] = mineClaim(owner as string)

  let dropped = 0
  for (const [k] of pairs(table.reserved)) {
    if (keep[k as number] !== undefined) continue
    releaseWorldTile(table, k as number)
    dropped++
  }
  // A caller may have deleted a reservation directly (relocation); drop its orphaned owner too.
  if (table.reservedBy !== undefined) {
    for (const [k] of pairs(table.reservedBy)) if (table.reserved[k as number] !== true) delete table.reservedBy[k as number]
  }
  for (const [k, tag] of pairs(keep)) reserveWorldTile(table, k as number, tag as string)
  return dropped
}

/**
 * Owner-side invariants for the reservations. `live` holds the tags of every site, module, route, pole and mine that
 * currently exists. Untagged tiles are compatible old-save entries and are not reported.
 */
export function checkWorldClaimOwners(table: WorldClaimTable, live: Record<string, boolean>): string[] {
  const problems: string[] = []
  for (const [key, tag] of pairs(table.reservedBy ?? {})) {
    const k = key as number
    if (table.reserved[k] !== true) {
      problems.push(`owner ${tag as string} at ${keyX(k)},${keyY(k)} has no reservation`)
      continue
    }
    if (claimKind(tag as string) === undefined) {
      problems.push(`reservation ${keyX(k)},${keyY(k)} has an unknown owner tag ${tag as string}`)
      continue
    }
    if (!live[tag as string]) problems.push(`reservation ${keyX(k)},${keyY(k)} names absent ${tag as string}`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------
// D46 ore fields: one faction-owned tile set per faction (no per-tile owner). The helpers keep the type boundary
// explicit so `claimOreField` and its readers do not poke the raw table.

export type OreFieldTiles = Record<number, boolean>

/** Adds a tile to the faction's ore-field claim; returns whether it was new. */
export function claimOreFieldTile(fields: OreFieldTiles, key: number): boolean {
  if (fields[key] === true) return false
  fields[key] = true
  return true
}

export function hasOreFieldTile(fields: OreFieldTiles | undefined, key: number): boolean {
  return fields !== undefined && fields[key] === true
}
