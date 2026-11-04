import { LuaEntity } from "factorio:runtime"
import { FactionState } from "./types"

// B32: supply points. When a crew member needs an item for a job (craft, place, fuel, research feed...), its haul
// takes it straight from wherever the faction holds it: the depot (stockpiles) and the supply points the brain
// registers every think (furnace and chest outputs of bootstrap sites, pair-drill surplus coal, the factory's
// chest-out ports — mall and temporary cells — and module buffer chests). Nothing shuffles stacks to the depot first.
//
// A leaf module (no strategy imports): the crew and the brain both read it. Takes are reserved per source
// (`FactionState.reservedAt`), so two members never count the same stack.

/** One place the crew may take from: an inventory of an own entity, optionally one item only, keeping some back. */
export interface SupplyPoint {
  entity: LuaEntity
  inventory: defines.inventory
  /** Only this item (a pair drill's fuel). */
  item?: string
  /** Left in place (a pair drill keeps coal to feed its partner). */
  keep?: number
  /** B36: what kind of source it is, for the per-source take counters (`CrewStats.takes`). */
  kind: SupplyKind
}

/** B36: source kinds for telemetry. `depot`: a stockpile. */
/**
 * `module-out` (M7c.8): a production module's assembler output, registered only for products the crew has no other
 * source for; it counts at any amount (its slot holds a few at most, often fewer than `minTake`). `stock-out` (M7d.5): a
 * stock row's chest (roboports, robots), also at any amount (seed 11: the hub's roboport place job could not take the
 * one roboport made so far, "below minimum 5", and hand-crafted one from 90 plastic).
 */
export type SupplyKind = "depot" | "chest-out" | "temp-out" | "buffer" | "furnace" | "chest-site" | "pair" | "module-furnace" | "module-out" | "stock-out"


/** What one source holds of one item, after what it keeps back. `depot`: a stockpile (no minimum take). */
export interface Holding {
  entity: LuaEntity
  item: string
  amount: number
  depot: boolean
  kind: SupplyKind
}

/** Replaces the faction's supply points (the brain, every think). */
export function setSupplies(faction: FactionState, points: SupplyPoint[]): void {
  faction.supplies = points
  delete cache[faction.name]
}

// Per-tick cache of raw holdings for the crew: idle members plan every tick and each plan reads every source. Only
// valid within one tick (the controller, which moves items, steps after the crew), so it never outlives a save.
const cache: Record<string, { tick: number; list: Holding[] }> = {}

function addInventory(out: Holding[], entity: LuaEntity, inv: defines.inventory, kind: SupplyKind, only?: string, keep?: number): void {
  const inventory = entity.get_inventory(inv)
  if (inventory === undefined || inventory === null) return
  for (const c of inventory.get_contents()) {
    if (only !== undefined && c.name !== only) continue
    const amount = c.count - (keep ?? 0)
    if (amount > 0) out.push({ entity, item: c.name, amount, depot: kind === "depot", kind })
  }
}

/**
 * Everything the faction holds where the crew may take it: stockpiles first, then the supply points in registration
 * order (deterministic). Live counts, before reservations.
 */
export function rawHoldings(faction: FactionState): Holding[] {
  const out: Holding[] = []
  for (const chest of faction.stockpiles) if (chest.valid) addInventory(out, chest, defines.inventory.chest, "depot")
  for (const p of faction.supplies ?? []) if (p.entity.valid) addInventory(out, p.entity, p.inventory, p.kind, p.item, p.keep)
  return out
}

function cachedHoldings(faction: FactionState): Holding[] {
  const tick = game.tick
  const c = cache[faction.name]
  if (c !== undefined && c.tick === tick) return c.list
  const list = rawHoldings(faction)
  cache[faction.name] = { tick, list }
  return list
}

/** Reserved for takes already on their way from this source. */
export function reservedAt(faction: FactionState, entity: LuaEntity, item: string): number {
  const r = faction.reservedAt?.[entity.unit_number ?? -1]
  return r?.[item] ?? 0
}

/**
 * What the crew can still take: each source's holding minus its reservations. A supply point holding less than
 * `minTake` of an item is not worth the walk and does not count (stockpiles always do). The brain counts the same
 * sources (`supplyStock`), so it never hand-sources what a supply point holds.
 */
export function takeable(faction: FactionState, minTake: number): Holding[] {
  const out: Holding[] = []
  for (const h of cachedHoldings(faction)) {
    if (!h.entity.valid) continue
    const amount = h.amount - reservedAt(faction, h.entity, h.item)
    if (amount <= 0 || (!h.depot && h.kind !== "module-out" && h.kind !== "stock-out" && amount < minTake)) continue
    out.push({ entity: h.entity, item: h.item, amount, depot: h.depot, kind: h.kind })
  }
  return out
}

/** The brain's view: items at the supply points (not the stockpiles), above the minimum take. */
export function supplyStock(faction: FactionState, minTake: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of faction.supplies ?? []) {
    if (!p.entity.valid) continue
    const list: Holding[] = []
    addInventory(list, p.entity, p.inventory, p.kind, p.item, p.keep)
    for (const h of list) if (h.amount >= minTake || h.kind === "module-out" || h.kind === "stock-out") out[h.item] = (out[h.item] ?? 0) + h.amount
  }
  return out
}

/** Reserves `count` `item` at `entity` for a take on its way. */
export function reserveAt(faction: FactionState, entity: LuaEntity, item: string, count: number): void {
  const id = entity.unit_number
  if (id === undefined) return
  faction.reservedAt ??= {}
  const r = (faction.reservedAt[id] ??= {})
  r[item] = (r[item] ?? 0) + count
}

/** Gives back a reservation made with `reserveAt` (by unit number: the entity may be gone). */
export function unreserveAt(faction: FactionState, id: number, item: string, count: number): void {
  const r = faction.reservedAt?.[id]
  if (r === undefined) return
  const left = (r[item] ?? 0) - count
  if (left > 0) r[item] = left
  else delete r[item]
  const [first] = next(r)
  if (first === undefined) delete faction.reservedAt![id]
}
