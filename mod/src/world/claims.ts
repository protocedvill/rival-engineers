import { LuaEntity, LuaSurface } from "factorio:runtime"
import { keyX, keyY, tkey } from "../planner/grid"

// Ground claims between factions (M5a.2). A faction's `brain.reserved` tiles are its claim on the ground: bootstrap
// sites and their margins, and every adopted plan's tiles (modules with a 1-tile margin, routes, poles), built or not.
// Other factions treat them as foreign structures: their planner (factionView), bootstrap site placement and plan
// adoption never use a tile another faction on the same surface claimed. First come, first served, like players.

/** The reserved-tile sets of every other faction on `surface`, in faction order (deterministic). */
export function otherClaims(faction: string, surface: string): Record<number, boolean>[] {
  const out: Record<number, boolean>[] = []
  for (const name of storage.factionOrder) {
    if (name === faction) continue
    const f = storage.factions[name]
    if (f === undefined || f.surface !== surface) continue
    const r = f.brain?.reserved
    if (r !== undefined) out.push(r)
  }
  return out
}

/** Whether any of `claims` contains tile key `k`. */
export function claimed(claims: Record<number, boolean>[], k: number): boolean {
  for (const c of claims) if (c[k]) return true
  return false
}

/** The other faction (name) whose claim contains tile key `k`, if any. */
export function claimOwner(faction: string, surface: string, k: number): string | undefined {
  for (const name of storage.factionOrder) {
    if (name === faction) continue
    const f = storage.factions[name]
    if (f !== undefined && f.surface === surface && f.brain?.reserved[k]) return name
  }
  return undefined
}

const NOT_STRUCTURES: Record<string, boolean> = { character: true, "character-corpse": true, corpse: true, "item-entity": true, projectile: true }

/**
 * Entities of another (non-neutral) force on tile key `keys`, including ghosts: other factions' and players'
 * structures. Trees, rocks, cliffs and ore are neutral; characters and corpses don't count.
 */
export function foreignEntitiesOn(surface: LuaSurface, force: string, keys: number[]): LuaEntity[] {
  if (keys.length === 0) return []
  const want: Record<number, boolean> = {}
  let x1 = math.huge
  let y1 = math.huge
  let x2 = -math.huge
  let y2 = -math.huge
  for (const k of keys) {
    want[k] = true
    const x = keyX(k)
    const y = keyY(k)
    x1 = math.min(x1, x)
    y1 = math.min(y1, y)
    x2 = math.max(x2, x + 1)
    y2 = math.max(y2, y + 1)
  }
  const out: LuaEntity[] = []
  for (const e of surface.find_entities_filtered({ area: { left_top: { x: x1, y: y1 }, right_bottom: { x: x2, y: y2 } } })) {
    if (!e.valid || NOT_STRUCTURES[e.type]) continue
    const f = e.force.name
    if (f === force || f === "neutral") continue
    if (entityOnKeys(e, want)) out.push(e)
  }
  return out
}

/** Whether an entity's box covers any tile in `keys`. */
export function entityOnKeys(e: LuaEntity, keys: Record<number, boolean>): boolean {
  const box = e.bounding_box
  const bx1 = math.floor(box.left_top.x + 0.01)
  const by1 = math.floor(box.left_top.y + 0.01)
  const bx2 = math.max(math.ceil(box.right_bottom.x - 0.01), bx1 + 1)
  const by2 = math.max(math.ceil(box.right_bottom.y - 0.01), by1 + 1)
  for (let x = bx1; x < bx2; x++) for (let y = by1; y < by2; y++) if (keys[tkey(x, y)]) return true
  return false
}
