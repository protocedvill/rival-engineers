import { LuaEntity, LuaSurface } from "factorio:runtime"
import { FactionState } from "../jobs/types"
import { tkey } from "../planner/grid"
import { factoryReserveTiles } from "../planner/build-list"
import { LayoutState } from "../planner/layout"
import { findEntities } from "../work"
import { destroyEntity } from "../planner/terrain"
import { BrainState, Site, SitePart } from "./types"

// B15 / D51 (3): bootstrap mining sites may stand on ore the factory will need (a production outpost's patch). The
// factory's plans see their tiles as clearable ground (like trees) and, when a plan or a growth takes that ground, the
// sites under it are evicted: a built site is retired (the crew picks it up, D43's mechanism) and a planned one dropped;
// either way the bootstrap gets a replacement goal and builds it elsewhere. M6a.2 (seed 222): the depot is evicted too
// (see `evictable`) — an extra depot built over a factory port's approach tiles walled the port in for good.
//
// Imports no strategy module: factory.ts and planner/runtime.ts use it, bootstrap.ts imports factory.ts.

/** Tile keys (planner/grid tkey) a part's footprint covers. */
function footprint(part: SitePart): number[] {
  const proto = prototypes.entity[part.entity]
  const sideways = part.direction === defines.direction.east || part.direction === defines.direction.west
  const w = sideways ? proto.tile_height : proto.tile_width
  const h = sideways ? proto.tile_width : proto.tile_height
  const x1 = math.floor(part.position.x - w / 2 + 0.01)
  const y1 = math.floor(part.position.y - h / 2 + 0.01)
  const out: number[] = []
  for (let x = x1; x < x1 + w; x++) for (let y = y1; y < y1 + h; y++) out.push(tkey(x, y))
  return out
}

function evictable(site: Site): boolean {
  // M6a.2 (seed 222): the depot is evicted too — an extra depot built over a factory port's approach tiles read as
  // unevictable OWN ground and walled the port in for good (the lab's in-logistic port); the bootstrap rebuilds the
  // depot near the hub.
  return site.status === "planned" || site.status === "built"
}

/** Tiles of the faction's evictable bootstrap sites (footprints and their margins): the planner's clearable ground. */
export function evictableTiles(brain: BrainState | undefined): Record<number, boolean> | undefined {
  if (brain === undefined) return undefined
  let out: Record<number, boolean> | undefined
  for (const site of brain.sites) {
    if (!evictable(site)) continue
    out ??= {}
    for (const k of site.tiles) out[k] = true
  }
  return out
}

/**
 * Evicts the faction's bootstrap mining sites whose footprint meets `keys`. Returns the built entities to clear (the
 * caller's build clears them before its ghosts; the bootstrap's own retire jobs may race it harmlessly).
 */
export function evictSites(faction: FactionState, surface: LuaSurface, keys: Record<number, boolean>, why: string): LuaEntity[] {
  const brain = faction.brain
  const out: LuaEntity[] = []
  if (brain === undefined) return out
  for (const site of brain.sites) {
    if (!evictable(site)) continue
    let hit = false
    for (const part of site.parts) for (const k of footprint(part)) if (keys[k]) hit = true
    if (!hit) continue
    const wasBuilt = site.status === "built"
    if (wasBuilt) {
      site.status = "retired"
      for (const part of site.parts) if (part.built !== undefined && part.built.valid) out.push(part.built)
    } else {
      site.status = "failed"
      for (const part of site.parts) {
        const ghost = findEntities(surface, { type: "entity-ghost", position: part.position, force: faction.force, limit: 1 })[0]
        if (ghost !== undefined) destroyEntity(ghost)
      }
    }
    // Its tiles are the factory's now (the caller reserves what it builds).
    for (const k of site.tiles) delete brain.reserved[k]
    site.tiles = []
    // A replacement elsewhere, at the front of the goals (the site's own goal, if still open, is planned again).
    let open = false
    for (const g of brain.goals) if (g.kind === "site" && !g.done && g.siteId === site.id) {
      g.siteId = undefined
      open = true
    }
    // A depleting site already has its replacement goal (D43).
    if (!open && site.depleting !== true) {
      let first = 0
      while (first < brain.goals.length && brain.goals[first].done) first++
      brain.goals.splice(first, 0, { kind: "site", site: site.kind, resource: site.resource })
    }
    brain.evicted = (brain.evicted ?? 0) + 1
    log(`[rival-engineers] faction ${faction.name}: bootstrap site ${site.id} (${site.kind} ${site.resource ?? ""}, ${wasBuilt ? "built" : "planned"}) evicted by ${why}`)
  }
  return out
}

/** B42: `e` is a built part of one of the faction's live bootstrap sites (their own logic and eviction handle it). */
export function isSitePart(brain: BrainState | undefined, e: LuaEntity): boolean {
  if (brain === undefined) return false
  for (const site of brain.sites) {
    if (site.status === "retired" || site.status === "failed") continue
    for (const part of site.parts) if (part.built !== undefined && part.built.valid && part.built === e) return true
  }
  return false
}

/**
 * M6a.2: the faction's reserved tiles = its bootstrap sites' tiles plus what the factory layout holds
 * (`factoryReserveTiles`). Called after a change that may give up ground (a growth, a reroute, a relocation): stale
 * reservations read as the faction's own entities to every later plan and can wall in a port for good.
 */
export function resyncReserved(faction: FactionState, layout: LayoutState): number {
  const brain = faction.brain
  if (brain === undefined) return 0
  const keep: Record<number, boolean> = {}
  for (const site of brain.sites) {
    // M6a.2 (seed 222): a retired site has been picked up, its ground is free again — its tiles read as OWN walls
    // for good otherwise (sites 2/4/14 walled the lab's port approach). Failed sites keep their spot (bad ground).
    if (site.status === "retired") continue
    for (const k of site.tiles) keep[k] = true
  }
  for (const k of factoryReserveTiles(layout)) keep[k] = true
  let dropped = 0
  for (const [k] of pairs(brain.reserved)) {
    if (keep[k as number]) continue
    delete brain.reserved[k as number]
    dropped++
  }
  for (const k of factoryReserveTiles(layout)) brain.reserved[k] = true
  return dropped
}
