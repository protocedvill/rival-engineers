// M7d.5 (user decision in-session 2026-11-04: "output chests can be upgraded to passive providers"): once the passive
// provider chest is researched (construction robotics) and the faction has a roboport network, module output chests
// (buffer heads, the mall's and the stock rows' chest-out ports) are passive providers, so construction robots take
// building materials straight from them, as in a player's base. New modules get them in their design; built ones are
// upgraded in place through Factorio's upgrade orders, which the robots carry out (like a player's upgrade planner),
// and the crew brings the chests to the hub's storage. The layout follows once a chest is upgraded.
// B203 (user, in-session 2026-11-12: "for robots we need the depots to actually be storage chests"): the crew's depot
// chests in the network are upgraded to storage chests the same way, so robots build from what the crew stores.

import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { keyTaken } from "../jobs/keys"
import { hasNetwork } from "../jobs/robot-orders"
import { addStockpile } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import { transformPoint } from "../modules/geometry"
import { ModuleEntity } from "../modules/types"
import { PlacedModule } from "../planner/layout"
import * as LG from "../planner/logical"
import { findEntities } from "../work"
import type { ExploreCtx } from "./explore"
import { addKeyed } from "./lab-feed"
import { hubRoboport } from "./robots"
import { isTempRole } from "./stage"

/** Chest entity types a module output chest can be. */
export const CHEST_TYPES = ["container", "logistic-container"]

/** The passive provider chest's name once the faction may use it (recipe enabled, robots on), else undefined. */
export function providerChest(ctx: Pick<ExploreCtx, "config" | "force" | "entities">): string | undefined {
  if (!ctx.config.factoryRobots) return undefined
  const name = ctx.entities["provider-chest"] ?? "passive-provider-chest"
  return ctx.force.recipes[prototypeFacts.recipeForItem(name) ?? name]?.enabled === true ? name : undefined
}

/** The buffer chest new modules get: the passive provider once allowed, else the setting (empty: no buffers). */
export function bufferChest(ctx: Pick<ExploreCtx, "config" | "force" | "entities">): string {
  const set = ctx.config.moduleBuffer
  if (set === "") return set
  return providerChest(ctx) ?? set
}

/** A module's output chests in the layout: its buffer entities, and for a sink (mall, stock row) its chest-out ports. */
function outputChests(m: PlacedModule, sink: boolean): ModuleEntity[] {
  const out: ModuleEntity[] = []
  const ports: Record<string, boolean> = {}
  if (sink) for (const p of m.def.ports) if (p.kind === "chest-out") ports[`${p.pos.x},${p.pos.y}`] = true
  for (const e of m.def.entities) if (e.buffer === true || ports[`${e.x},${e.y}`]) out.push(e)
  return out
}

/** Renames the layout's chest at module-local (x, y) from `from` to `to`, in every copy of the module's entities. */
function renameChest(m: PlacedModule, x: number, y: number, from: string, to: string): void {
  const placed = [m.def.entities]
  if (m.minePlan !== undefined) placed.push(m.minePlan.full.entities)
  for (const list of placed) for (const e of list) if (e.name === from && e.x === x && e.y === y) e.name = to
  // The canonical copy is in its own orientation: find its chest through the module's transform.
  const { w, h } = m.canonical.footprint
  for (const e of m.canonical.entities) {
    if (e.name !== from) continue
    const q = transformPoint(e, w, h, m.transform)
    if (math.abs(q.x - x) < 0.01 && math.abs(q.y - y) < 0.01) e.name = to
  }
  // Growth regenerates the module from its params: new buffer heads are providers too.
  for (const params of [m.def.params, m.canonical.params]) if (params !== undefined && params.buffer === from) params.buffer = to
}

/**
 * The upgrade pass: orders built modules' output chests upgraded to passive providers, follows upgraded ones in the
 * layout, and has the crew bring the chests the orders still wait for to the hub's storage chest. Returns the orders
 * waiting.
 */
export function upgradeOutputChests(ctx: ExploreCtx & { faction: FactionState }, priority: number): number {
  const depots = upgradeDepots(ctx, priority)
  const provider = providerChest(ctx)
  if (provider === undefined || !hasNetwork(ctx.faction, ctx.surface.name)) return depots
  const f = ctx.f
  let waiting = 0
  for (const n of LG.nodesOf(f.graph)) {
    if (n.lifecycle !== "built" || isTempRole(n.role)) continue
    const m = f.layout.modules.find((x) => x.id === n.id)
    if (m === undefined) continue
    for (const e of outputChests(m, n.kind === "sink")) {
      const pos = { x: m.origin.x + e.x, y: m.origin.y + e.y }
      const chest: LuaEntity | undefined = findEntities(ctx.surface, { type: CHEST_TYPES, force: ctx.force, position: pos, limit: 1 })[0]
      if (chest === undefined || !chest.valid) continue
      if (chest.name === provider) {
        if (e.name !== provider) {
          renameChest(m, e.x, e.y, e.name, provider)
          log(`[rival-engineers] faction ${ctx.faction.name}: M7d.5 output chest of ${n.role} at (${pos.x}, ${pos.y}) is a ${provider} now`)
        }
        continue
      }
      if (!chest.to_be_upgraded()) chest.order_upgrade({ target: provider, force: ctx.force })
      waiting++
    }
  }
  if (waiting > 0) stockHub(ctx, provider, waiting, priority)
  return waiting + depots
}

/** B203: the depot upgrade pass once the storage chest is researched (`orderDepotUpgrades`), with the chests it needs. */
function upgradeDepots(ctx: ExploreCtx & { faction: FactionState }, priority: number): number {
  if (!ctx.config.factoryRobots) return 0
  const store = ctx.entities["storage-chest"] ?? "storage-chest"
  if (ctx.force.recipes[prototypeFacts.recipeForItem(store) ?? store]?.enabled !== true) return 0
  const waiting = orderDepotUpgrades(ctx.faction, ctx.surface, ctx.force, store)
  if (waiting > 0) stockHub(ctx, store, waiting, priority)
  return waiting
}

/**
 * B203: orders the faction's depot chests inside a logistic network upgraded to `store`, and registers each finished
 * one as a stockpile. Robots keep a chest's contents when they upgrade it. Returns the orders waiting.
 */
export function orderDepotUpgrades(faction: FactionState, surface: LuaSurface, force: LuaForce, store: string): number {
  const pending = (faction.depotUpgrades ??= [])
  for (let i = pending.length - 1; i >= 0; i--) {
    const chest = findEntities(surface, { type: CHEST_TYPES, force, position: pending[i], limit: 1 })[0]
    if (chest !== undefined && chest.valid && chest.to_be_upgraded()) continue
    // Upgraded, or gone (mined, cancelled): either way the order is over.
    if (chest !== undefined && chest.valid && chest.name === store && faction.stockpiles.indexOf(chest) < 0) {
      addStockpile(faction, chest)
      log(`[rival-engineers] faction ${faction.name}: B203 depot chest at (${chest.position.x}, ${chest.position.y}) is a ${store} now`)
    }
    pending.splice(i, 1)
  }
  let waiting = 0
  for (const chest of faction.stockpiles) {
    if (!chest.valid || chest.name === store || chest.surface.name !== surface.name) continue
    if (force.find_logistic_network_by_position(chest.position, surface) === undefined) continue
    if (!chest.to_be_upgraded()) {
      chest.order_upgrade({ target: store, force })
      if (!chest.to_be_upgraded()) continue
      pending.push({ x: chest.position.x, y: chest.position.y })
    }
    waiting++
  }
  return waiting
}

/** The crew brings `count` chests of `item` to the hub's first storage chest, for the robots' upgrades. */
function stockHub(ctx: ExploreCtx & { faction: FactionState }, item: string, count: number, priority: number): void {
  const store = hubRoboport(ctx)?.chests[0]
  if (store === undefined || !store.valid) return
  const want = count - store.get_item_count(item)
  const key = `upgrade-chests:${item}:${store.unit_number}`
  if (want <= 0 || keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) return
  const n = math.min(want, prototypes.item[item]?.stack_size ?? 50)
  addKeyed(ctx, key, { kind: "fuel", pos: store.position, materials: [{ item, count: n }], priority, payload: { kind: "fuel", item, count: n, target: store, partial: true } })
}
