// M7d.5: the construction-robot network. Kept out of factory.ts (its Lua main chunk is near the 200-local limit); the
// factory passes its context and a hook that starts a roboport goal. Where the next roboport goes is pure logic
// (`robot-grid.ts`, T1-tested).

import { LuaEntity } from "factorio:runtime"
import { addStockpile } from "../jobs/faction"
import { keyTaken } from "../jobs/keys"
import { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import { Vec } from "../planner/grid"
import { findModule } from "../planner/layout"
import * as LG from "../planner/logical"
import type { ExploreCtx } from "./explore"
import { findEntities } from "../work"
import { addKeyed } from "./lab-feed"
import * as RG from "./robot-grid"

/** Storage chests beside the hub roboport (the network's store of building materials; agent guess, proposed). */
export const HUB_CHESTS = 2
/**
 * Half-size of the plan region around a grid cell's point (agent guess, proposed): the roboport module (5×4) lands
 * within about 6 tiles of the point, so neighbours stay within spacing + 12 of each other.
 */
export const CELL_WINDOW = 8
/** Half-size of the hub's plan region around the base centre: the hub only fixes the grid's origin (agent guess). */
export const HUB_WINDOW = 24

export interface RobotsHooks {
  /** What keeps a new goal from starting now (another plan, no power), if anything. */
  busy: (this: void) => string | undefined
  /** Starts a roboport goal: graph role, the point it goes near, the region's half-size, storage chests beside it. */
  start: (this: void, role: string, anchor: Vec, window: number, chests: number) => void
}

/** The context the network's upkeep needs (the factory's). */
export type RobotsCtx = ExploreCtx & { faction: FactionState }

/** The construction robot's name. */
function robotName(ctx: Pick<ExploreCtx, "entities">): string {
  return ctx.entities["construction-robot"] ?? "construction-robot"
}

/** Whether a stock row's module has a roboport head (generators.ts `rowRoboportHead` marks its id). */
function hasRoboportHead(n: LG.LogicalNode): boolean {
  return n.module !== undefined && string.find(n.module, "/roboport=", 1, true)[0] !== undefined
}

/**
 * The hub's graph node: the hub cell's roboport module (`roboport:0,0`), or the construction-robot stock row when its
 * roboport head is the hub (user request in-session 2026-11-04: robots go straight into a roboport).
 */
export function hubNode(ctx: Pick<ExploreCtx, "f" | "entities">): { node: LG.LogicalNode; row: boolean } | undefined {
  const cell = LG.nodeByRole(ctx.f.graph, RG.cellRole({ i: 0, j: 0 }))
  if (cell !== undefined) return { node: cell, row: false }
  const row = LG.nodeByRole(ctx.f.graph, `stock:${robotName(ctx)}`)
  if (row !== undefined && hasRoboportHead(row)) return { node: row, row: true }
  return undefined
}

/**
 * The design's roboport head for the construction-robot stock row (design.ts `robotHub`): once the roboport can be
 * made, a faction with no hub yet gets it in that row. Undefined when the hub exists another way (a roboport module,
 * or a stock row already planned without a head), so a running network keeps its hub.
 */
export function robotHub(ctx: Pick<ExploreCtx, "config" | "force" | "entities">, graph: LG.LogicalGraph | undefined): { robot: string; roboport: string; storageChest: string; storage: number } | undefined {
  if (!ctx.config.factoryRobots || graph === undefined) return undefined
  const roboport = ctx.entities.roboport ?? "roboport"
  if (ctx.force.recipes[prototypeFacts.recipeForItem(roboport) ?? roboport]?.enabled !== true) return undefined
  const robot = robotName(ctx)
  if (ctx.force.recipes[prototypeFacts.recipeForItem(robot) ?? robot]?.enabled !== true) return undefined
  if (LG.nodeByRole(graph, RG.cellRole({ i: 0, j: 0 })) !== undefined) return undefined
  const row = LG.nodeByRole(graph, `stock:${robot}`)
  if (row !== undefined && !hasRoboportHead(row)) return undefined
  return { robot, roboport, storageChest: ctx.entities["storage-chest"] ?? "storage-chest", storage: HUB_CHESTS }
}

/** The built hub roboport of the faction's network and its storage chests, if any. */
export function hubRoboport(ctx: ExploreCtx): { roboport: LuaEntity; chests: LuaEntity[]; row: boolean } | undefined {
  const hub = hubNode(ctx)
  if (hub === undefined || hub.node.lifecycle !== "built") return undefined
  const m = findModule(ctx.f.layout, hub.node.id)
  if (m === undefined) return undefined
  const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
  const roboport = findEntities(ctx.surface, { type: "roboport", force: ctx.force, area, limit: 1 })[0]
  if (roboport === undefined || !roboport.valid) return undefined
  // Storage chests only: the stock row's buffer (a passive provider) is the crew's supply, not a depot.
  const chests = findEntities(ctx.surface, { type: "logistic-container", force: ctx.force, area }).filter((e) => e.valid && e.prototype.logistic_mode === "storage")
  return { roboport, chests, row: hub.row }
}

/**
 * M7d.5: the network's upkeep. The hub's storage chests become the crew's depot (robots build ghosts from what the crew
 * leaves there), and the crew puts construction robots into the hub roboport until the network has
 * `factory-network-robots`.
 */
export function robotsUpkeep(ctx: RobotsCtx, priority: number): void {
  if (!ctx.config.factoryRobots) return
  const hub = hubRoboport(ctx)
  if (hub === undefined) return
  const known: Record<number, boolean> = {}
  for (const s of ctx.faction.stockpiles) if (s.valid && s.unit_number !== undefined) known[s.unit_number] = true
  for (const c of hub.chests) {
    if (c.unit_number === undefined || known[c.unit_number]) continue
    addStockpile(ctx.faction, c)
    log(`[rival-engineers] faction ${ctx.faction.name}: M7d.5 hub storage chest at (${c.position.x}, ${c.position.y}) is now a depot`)
  }
  // The stock row's own inserter fills its roboport with the robots it makes.
  if (hub.row) return
  const robot = robotName(ctx)
  const have = hub.roboport.logistic_network?.all_construction_robots ?? 0
  const want = ctx.config.factoryNetworkRobots - have
  const key = `robots:${hub.roboport.unit_number}`
  if (want <= 0 || keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) return
  const count = math.min(want, prototypes.item[robot]?.stack_size ?? 50)
  addKeyed(ctx, key, { kind: "fuel", pos: hub.roboport.position, materials: [{ item: robot, count }], priority, payload: { kind: "fuel", item: robot, count, target: hub.roboport, partial: true } })
}

/** M7d.5: starts the next roboport goal when the network can grow (one goal at a time). */
export function robotsStep(ctx: ExploreCtx, hooks: RobotsHooks): void {
  const f = ctx.f
  if (!ctx.config.factoryRobots) return
  const roboport = ctx.entities.roboport ?? "roboport"
  if (ctx.force.recipes[prototypeFacts.recipeForItem(roboport) ?? roboport]?.enabled !== true) return
  if (hooks.busy() !== undefined) return
  const failed: Record<string, boolean> = {}
  for (const g of f.goals) {
    if (g.kind !== "robots") continue
    if (g.status === "planning" || g.status === "building") return
    if (g.status !== "failed") continue
    for (const n of g.nodes) {
      const c = RG.parseCellRole(n.role)
      if (c !== undefined) failed[RG.cellKey(c)] = true
    }
  }
  const cells: RG.GridCell[] = []
  for (const n of LG.nodesOf(f.graph)) {
    const c = RG.parseCellRole(n.role)
    if (c !== undefined && !failed[RG.cellKey(c)]) cells.push(c)
  }
  // The hub in the construction-robot stock row: cell 0,0 once the row is built; the design plans it (no hub goal).
  const hub = hubNode(ctx)
  if (hub !== undefined && hub.row) {
    if (hub.node.lifecycle !== "built") {
      ctx.waiting.push(`robots: wait for the hub in the ${hub.node.role} row`)
      return
    }
    cells.push({ i: 0, j: 0 })
  } else if (hub === undefined && robotHub(ctx, f.graph) !== undefined) {
    ctx.waiting.push(`robots: wait for the design to plan the hub in the stock:${robotName(ctx)} row`)
    return
  }
  // The network waits for its roboports to be made (the stock row, design.ts `robotStock`).
  const stock = LG.nodeByRole(f.graph, `stock:${roboport}`)
  if (stock === undefined || stock.lifecycle !== "built") {
    if (cells.length === 0) ctx.waiting.push(`robots: wait for the ${roboport} stock row`)
    return
  }
  let origin: Vec = f.center
  if (cells.length > 0) {
    const m = hub !== undefined ? findModule(f.layout, hub.node.id) : undefined
    if (m === undefined) return
    origin = { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }
    if (hub!.row) {
      // The grid starts at the row's roboport, not the row's centre.
      const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
      const port = findEntities(ctx.surface, { type: "roboport", force: ctx.force, area, limit: 1 })[0]
      if (port === undefined || !port.valid) return
      origin = { x: port.position.x, y: port.position.y }
    }
  }
  const modules: RG.GridRect[] = []
  for (const m of f.layout.modules) modules.push(m.rect)
  const next = RG.nextCell({
    modules,
    cells,
    failed,
    origin,
    spacing: ctx.config.factoryRoboportSpacing,
    constructionRadius: prototypeFacts.entity(roboport)?.constructionRadius ?? 0,
    max: ctx.config.factoryRoboportsMax,
  })
  if (next === undefined) return
  const hubCell = cells.length === 0
  const anchor = hubCell ? f.center : RG.cellPoint(origin, ctx.config.factoryRoboportSpacing, next)
  log(`[rival-engineers] faction ${ctx.faction.name}: M7d.5 roboport goal: cell ${RG.cellKey(next)} near (${anchor.x}, ${anchor.y})${hubCell ? `, the hub with ${HUB_CHESTS} storage chests` : ""}; ${cells.length} roboports so far`)
  hooks.start(RG.cellRole(next), anchor, hubCell ? HUB_WINDOW : CELL_WINDOW, hubCell ? HUB_CHESTS : 0)
}
