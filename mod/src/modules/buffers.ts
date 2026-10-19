import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"
import { getConfig } from "../config"

// D42 / B5: module buffer depots. A module may carry a buffer chest (`ModuleEntity.buffer`): an inserter fills it from
// the module's line and the crew collects from it like a depot. Its usable slots are limited (`module-buffer-slots`)
// so it fills up and stops; it is never a demand in the factory graph or the module's rates (measurement never samples
// chests). Throughput validation (D33) builds it with every slot barred.
//
// Ghosts don't carry a chest's bar, so a buffer ghost is registered by position and the bar is set when the crew builds
// it (script_raised_revive / _built). Everything lives in `storage` (SPEC §5.6).

interface BufferEntry {
  surface: string
  x: number
  y: number
  force: string
  entity?: LuaEntity
}

declare global {
  interface RivalEngineersStorage {
    /** D42 buffer chests by `surface:x,y` (registered as ghosts, entity once built). */
    buffers?: Record<string, BufferEntry>
  }
}

function key(surface: string, p: MapPosition): string {
  return `${surface}:${p.x},${p.y}`
}

/** Bars a buffer chest down to `slots` usable slots (0: every slot barred). */
export function limitBuffer(chest: LuaEntity, slots: number): void {
  const inv = chest.get_inventory(defines.inventory.chest)
  if (inv === undefined || !inv.supports_bar()) return
  inv.set_bar(math.min(inv.length + 1, slots + 1))
}

/** A buffer chest was created as a ghost (or for real: then it is limited at once). */
export function registerBuffer(surface: LuaSurface, force: string, entity: LuaEntity): void {
  storage.buffers ??= {}
  const e: BufferEntry = { surface: surface.name, x: entity.position.x, y: entity.position.y, force }
  if (entity.name !== "entity-ghost") {
    e.entity = entity
    limitBuffer(entity, getConfig().moduleBufferSlots)
  }
  storage.buffers[key(surface.name, entity.position)] = e
}

/** Built-entity events: a registered buffer ghost became its chest. */
export function onBufferBuilt(entity: LuaEntity | undefined): void {
  if (storage.buffers === undefined || entity === undefined || !entity.valid || entity.type !== "container") return
  const e = storage.buffers[key(entity.surface.name, entity.position)]
  if (e === undefined || e.force !== entity.force.name) return
  e.entity = entity
  limitBuffer(entity, getConfig().moduleBufferSlots)
}

/** B32: built buffer chests of a force, in key order (supply points the crew takes from). */
export function bufferChests(force: string): LuaEntity[] {
  const out: LuaEntity[] = []
  const all = storage.buffers
  if (all === undefined) return out
  const keys: string[] = []
  for (const [k, e] of pairs(all)) if (e.force === force && e.entity !== undefined) keys.push(k as string)
  keys.sort()
  for (const k of keys) {
    const chest = all[k].entity!
    if (chest.valid) out.push(chest)
    else delete all[k]
  }
  return out
}

/** Built buffer chests of a force holding `item` (or anything), with amounts: a collect source for the crew. */
export function bufferSources(force: string, item: string | undefined): { entity: LuaEntity; item: string; amount: number }[] {
  const out: { entity: LuaEntity; item: string; amount: number }[] = []
  const all = storage.buffers
  if (all === undefined) return out
  const keys: string[] = []
  for (const [k, e] of pairs(all)) if (e.force === force && e.entity !== undefined) keys.push(k as string)
  keys.sort()
  for (const k of keys) {
    const chest = all[k].entity!
    if (!chest.valid) {
      delete all[k]
      continue
    }
    for (const c of chest.get_inventory(defines.inventory.chest)!.get_contents()) if (item === undefined || c.name === item) out.push({ entity: chest, item: c.name, amount: c.count })
  }
  return out
}
