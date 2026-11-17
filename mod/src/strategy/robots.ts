// M7d.5: the construction-robot network. Kept out of factory.ts (its Lua main chunk is near the 200-local limit); the
// factory passes its context and a hook that starts a roboport goal. Where the next roboport goes is pure logic
// (`robot-grid.ts`, T1-tested).

import { LuaEntity } from "factorio:runtime"
import { addStockpile } from "../jobs/faction"
import { keyTaken } from "../jobs/keys"
import { failJob } from "../jobs/board"
import { takeable } from "../jobs/supply"
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
 * Half-size of the plan region of a new grid roboport (agent guess, proposed). B222 (m7-b219 seed 222): at 8 around a
 * fixed grid point, three cells in a row found no room among belts and poles. The window is now anchored one step from
 * the built neighbour (`RG.stepAnchor`): 18 lets the roboport land 12–48 tiles from it along the step and ±18 across.
 */
export const CELL_WINDOW = 18
/** B222: tiles the window's far edge keeps inside the farthest two roboports can be apart and still link (agent guess). */
export const LINK_MARGIN = 2
/** Half-size of the hub's plan region around the base centre: the hub only fixes the grid's origin (agent guess). */
export const HUB_WINDOW = 24

export interface RobotsHooks {
  /** What keeps a new goal from starting now (another plan, no power), if anything. */
  busy: (this: void) => string | undefined
  /** Starts a roboport goal: graph role, the point it goes near, the region's half-size, storage chests beside it. */
  start: (this: void, role: string, anchor: Vec, window: number, chests: number) => void
  /** A grid roboport module's footprint (no chests), for the B192 room check. */
  footprint: (this: void) => { w: number; h: number }
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
  // The stock row's own inserter fills its roboport from the row's first buffer chest only. B226 (`m7d6-222b` seed 222):
  // the row's second machine had put 14 robots in its own chest that nobody moved, while the network had 10. The crew
  // tops the network up for a row hub too, from wherever robots are in stock.
  // The job asks only for the robots in stock: one sized to the whole shortfall (40 with 14 made) waited for materials
  // for good, and the crew hand-crafted robots for it from the engines the robot row lacked.
  const robot = robotName(ctx)
  const have = hub.roboport.logistic_network?.all_construction_robots ?? 0
  const want = ctx.config.factoryNetworkRobots - have
  const key = `robots:${hub.roboport.unit_number}`
  let inStock = 0
  for (const h of takeable(ctx.faction, ctx.config.supplyMinTake)) if (h.item === robot) inStock += h.amount
  const count = math.min(want, inStock, prototypes.item[robot]?.stack_size ?? 50)
  // An open job asking for more than is in stock (sized before this rule, or the stock was taken since) is replaced.
  const old = ctx.f.jobKeys[key] !== undefined ? ctx.faction.board.jobs[ctx.f.jobKeys[key]] : undefined
  if (old !== undefined && old.status === "open" && old.payload.kind === "fuel" && old.payload.count > math.max(count, 0)) {
    failJob(ctx.faction.board, old.id, "resized", ctx.tick)
  }
  if (count <= 0 || keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) return
  addKeyed(ctx, key, { kind: "fuel", pos: hub.roboport.position, materials: [{ item: robot, count }], priority, payload: { kind: "fuel", item: robot, count, target: hub.roboport, partial: true } })
}

/** M7d.5: starts the next roboport goal when the network can grow (one goal at a time). */
/**
 * M7d.5: grid cells in a row that find no site before the network pauses expansion (the hub still works). A failed cell
 * is never tried again either way. m7-b219 seed 222: at 1, one blocked cell stopped the network at two roboports with
 * two more in a chest and most supply points out of reach (agent value, proposed).
 */
export const MAX_GRID_FAILURES = 3

/** The last "robots:" wait logged per faction (log only: a reload just logs the current one again). */
const lastWait: Record<string, string> = {}

export function robotsStep(ctx: ExploreCtx, hooks: RobotsHooks): void {
  const before = ctx.waiting.length
  robotsStepInner(ctx, hooks)
  let reason = ""
  for (let i = before; i < ctx.waiting.length; i++) if (string.find(ctx.waiting[i], "robots:", 1, true)[0] === 1) reason = ctx.waiting[i]
  const name = ctx.force.name
  if (lastWait[name] !== reason) {
    lastWait[name] = reason
    log(`[rival-engineers] faction ${name}: ${reason === "" ? "robots: no wait" : reason}`)
  }
}

function robotsStepInner(ctx: ExploreCtx, hooks: RobotsHooks): void {
  const f = ctx.f
  if (!ctx.config.factoryRobots) return
  const roboport = ctx.entities.roboport ?? "roboport"
  if (ctx.force.recipes[prototypeFacts.recipeForItem(roboport) ?? roboport]?.enabled !== true) return
  const busy = hooks.busy()
  if (busy !== undefined) {
    ctx.waiting.push(`robots: wait for ${busy}`)
    return
  }
  const failed: Record<string, boolean> = {}
  // Failed cells since the last roboport goal that was built.
  let failedCells = 0
  // B226 (user in-session 2026-11-17): several roboports build at once (one plan at a time, `hooks.busy`).
  let building = 0
  for (const g of f.goals) {
    if (g.kind !== "robots") continue
    if (g.status === "planning") {
      ctx.waiting.push("robots: a roboport is planning")
      return
    }
    if (g.status === "building") {
      building++
      continue
    }
    if (g.status !== "failed") {
      failedCells = 0
      continue
    }
    for (const n of g.nodes) {
      const c = RG.parseCellRole(n.role)
      if (c !== undefined && failed[RG.cellKey(c)] !== true) {
        failed[RG.cellKey(c)] = true
        failedCells++
      }
    }
  }
  if (building >= ctx.config.factoryRoboportGoals) {
    ctx.waiting.push(`robots: ${building} roboports building`)
    return
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
  // The hub already gives the network a working radius. Optional grid cells in a dense base can have no site; stop
  // spending plans on them after a couple of failures instead of tripping the soak fail-fast.
  // B192 (`m7-b186` seed 222, min 327): after the hub row's cell joins `cells`; checked before it, a network of just
  // the row's hub never paused and two blocked cells in a row (8 plans) stopped the soak.
  if (cells.length > 0 && failedCells >= MAX_GRID_FAILURES) {
    ctx.waiting.push(`robots: network grid paused after ${failedCells} cells with no site`)
    return
  }
  // The network waits for its roboports to be made (the stock row, design.ts `robotStock`).
  const stock = LG.nodeByRole(f.graph, `stock:${roboport}`)
  if (stock === undefined || stock.lifecycle !== "built") {
    ctx.waiting.push(`robots: wait for the ${roboport} stock row (${stock?.lifecycle ?? "not planned"})`)
    return
  }
  let origin: Vec = f.center
  if (cells.length > 0) {
    const m = hub !== undefined ? findModule(f.layout, hub.node.id) : undefined
    if (m === undefined) {
      ctx.waiting.push("robots: the hub has no module")
      return
    }
    origin = { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }
    if (hub!.row) {
      // The grid starts at the row's roboport, not the row's centre.
      const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
      const port = findEntities(ctx.surface, { type: "roboport", force: ctx.force, area, limit: 1 })[0]
      if (port === undefined || !port.valid) {
        ctx.waiting.push("robots: no roboport in the hub row")
        return
      }
      origin = { x: port.position.x, y: port.position.y }
    }
  }
  // B222: where each cell's roboport really stands (its plan picked a spot in a window), the hub's at the origin.
  const placed: Record<string, Vec> = {}
  for (const c of cells) {
    if (c.i === 0 && c.j === 0) {
      placed[RG.cellKey(c)] = origin
      continue
    }
    const node = LG.nodeByRole(f.graph, RG.cellRole(c))
    const m = node !== undefined ? findModule(f.layout, node.id) : undefined
    if (m === undefined) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    const port = findEntities(ctx.surface, { type: "roboport", force: ctx.force, area, limit: 1 })[0]
    placed[RG.cellKey(c)] = port !== undefined && port.valid ? { x: port.position.x, y: port.position.y } : { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }
  }
  const logisticRadius = prototypeFacts.entity(roboport)?.logisticRadius ?? 0
  const spacing = ctx.config.factoryRoboportSpacing
  const pointOf = (c: RG.GridCell): Vec => {
    const have = placed[RG.cellKey(c)]
    if (have !== undefined) return have
    // A candidate: one step from a built neighbour (the first in a fixed order, so the choice is deterministic).
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const from = placed[RG.cellKey({ i: c.i - di, j: c.j - dj })]
      if (from !== undefined) return RG.stepAnchor(from, di, dj, logisticRadius, CELL_WINDOW, LINK_MARGIN)
    }
    return RG.cellPoint(origin, spacing, c)
  }
  const modules: RG.GridRect[] = []
  for (const m of f.layout.modules) modules.push(m.rect)
  // The supply points robots fetch from: the faction's passive providers (module outputs, the mall).
  const supplies: Vec[] = []
  const provider = ctx.entities["provider-chest"] ?? "passive-provider-chest"
  for (const e of findEntities(ctx.surface, { name: provider, force: ctx.force })) if (e.valid) supplies.push({ x: e.position.x, y: e.position.y })
  const next = RG.nextCell({
    modules,
    cells,
    failed,
    origin,
    spacing: ctx.config.factoryRoboportSpacing,
    constructionRadius: prototypeFacts.entity(roboport)?.constructionRadius ?? 0,
    logisticRadius,
    supplies,
    pointOf,
    max: ctx.config.factoryRoboportsMax,
    room: cells.length > 0 ? { ...hooks.footprint(), window: CELL_WINDOW } : undefined,
  })
  if (next === undefined) {
    ctx.waiting.push(`robots: no next cell (${cells.length} roboports)`)
    return
  }
  const hubCell = cells.length === 0
  const anchor = hubCell ? f.center : pointOf(next)
  log(`[rival-engineers] faction ${ctx.faction.name}: M7d.5 roboport goal: cell ${RG.cellKey(next)} near (${anchor.x}, ${anchor.y})${hubCell ? `, the hub with ${HUB_CHESTS} storage chests` : ""}; ${cells.length} roboports so far`)
  hooks.start(RG.cellRole(next), anchor, hubCell ? HUB_WINDOW : CELL_WINDOW, hubCell ? HUB_CHESTS : 0)
}
