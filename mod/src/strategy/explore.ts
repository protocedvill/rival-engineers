// Radars (D56) and exploration past the home zone (D62). Kept out of factory.ts (its Lua main chunk is near the
// 200-local limit); the factory passes its context and a few hooks.

import { LuaEntity, LuaForce, LuaSurface, OnSectorScannedEvent } from "factorio:runtime"
import { Config } from "../config"
import { prototypeFacts } from "../modules/prototype-facts"
import { Rect, tkey, Vec } from "../planner/grid"
import { findModule } from "../planner/layout"
import * as LG from "../planner/logical"
import * as Arms from "./arms"
import type { FactoryGoal, FactoryState } from "./factory"

// The knowledge-failure classifier lives in `shared/` (pure, T1-tested); re-exported here so the factory keeps using
// one namespace and its Lua main chunk does not gain a local (it is close to the 200 limit).
export { exhausted } from "../shared/exhausted"
import { exploreNeed, ExploreNeed, Producer } from "../shared/explore-need"

/** D56: radar goals that may fail before the faction stops trying. */
const RADAR_MAX_FAILED = 2
/** D56: the base radar module's graph role (outposts: "radar:N1", ...). */
export const RADAR_ROLE = "radar"

export interface ExploreCtx {
  faction: { name: string }
  f: FactoryState
  config: Config
  force: LuaForce
  surface: LuaSurface
  tick: number
  entities: Record<string, string>
  waiting: string[]
}

export interface ExploreHooks {
  /** What keeps a new radar goal from starting now (another plan, no power), if anything. */
  busy: (this: void) => string | undefined
  /** Starts a radar goal (graph role, outpost site or none for the base radar); returns its goal id. */
  startRadar: (this: void, role: string, site?: FactoryGoal["site"]) => string
}

/** D62: the home zone's radius (tiles): bootstrap exploration (H7) and plan regions stop there. */
export function homeRadius(ctx: ExploreCtx): number {
  return ctx.config.scanRadius * Arms.HOME_SCANS
}

/** The radar's scan reach (game data): nearby square in chunks, sector scan in tiles from the radar. */
function radarReach(ctx: ExploreCtx): { nearby: number; sector: number } {
  const p = prototypes.entity[ctx.entities.radar ?? "radar"]
  return { nearby: p?.get_max_distance_of_nearby_sector_revealed() ?? 3, sector: ((p?.get_max_distance_of_sector_revealed() ?? 14) + 1) * 32 }
}

function radarRecipe(ctx: ExploreCtx): boolean {
  const radar = ctx.entities.radar ?? "radar"
  return ctx.force.recipes[prototypeFacts.recipeForItem(radar) ?? radar]?.enabled === true
}

/**
 * D62: the plan region of goal `g` (radius `r` around the hub, within the home zone) plus the ground explored past
 * it: an outpost's own arm strip, or for a goal with a mine every outpost's sector-scan reach and every strip.
 */
export function planRegion(ctx: ExploreCtx, g: FactoryGoal, r: number): Rect {
  const f = ctx.f
  const c = f.center
  let region: Rect = { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r }
  if (g.site !== undefined) return Arms.rectUnion(region, g.site.strip)
  if (f.arms === undefined) return region
  let mine = false
  for (const n of g.nodes) if (n.generator === "mining-outpost") mine = true
  if (!mine) return region
  const reach = radarReach(ctx).sector
  region = Arms.rectUnion(region, Arms.homeRect(c, homeRadius(ctx)))
  for (const o of f.arms.outposts) region = Arms.rectUnion(region, { x: o.x - reach, y: o.y - reach, w: 2 * reach, h: 2 * reach })
  for (const s of f.arms.strips) region = Arms.rectUnion(region, s)
  return region
}

/** D62: what goal `g`'s plan may scan: the home zone, every explored strip (its own too), and charted chunks. */
export function knownGround(ctx: ExploreCtx, g: FactoryGoal): Arms.KnownGround {
  const explored = [...(ctx.f.arms?.strips ?? [])]
  if (g.site !== undefined) explored.push(g.site.strip)
  return { home: Arms.homeRect(ctx.f.center, homeRadius(ctx)), explored, scanned: ctx.f.radarChunks }
}

/**
 * P43 (a) (user, 2026-10-21): a radar charts nothing for a force with no players, but its sector scan still runs
 * (nearest chunks first, one per ~33 s at full power) and raises this event: the scanned chunk becomes known ground for
 * its faction's plans (generated and scanned when a plan needs it).
 */
export function onSectorScanned(e: OnSectorScannedEvent): void {
  const radar = e.radar
  if (!radar.valid) return
  const force = radar.force.name
  for (const name of storage.factionOrder) {
    if (storage.factions[name]?.force !== force) continue
    const f = storage.factories?.[name]
    if (f === undefined) return
    f.radarChunks ??= {}
    f.radarChunks[tkey(e.chunk_position.x, e.chunk_position.y)] = true
    return
  }
}

/** The outpost's radar entity near `pos`, if it is still there. */
function radarAt(ctx: ExploreCtx, pos: Vec): LuaEntity | undefined {
  for (const e of ctx.surface.find_entities_filtered({ area: [[pos.x - 3, pos.y - 3], [pos.x + 3, pos.y + 3]], type: "radar", force: ctx.force })) if (e.valid) return e
  return undefined
}

/**
 * D56 (user, 2026-10-20): once power is built and the radar can be made, one radar module goes up at the base, planned
 * and powered like any module. D62: what it charts past the home zone counts as explored once outposts are needed.
 */
export function baseRadar(ctx: ExploreCtx, hooks: ExploreHooks): void {
  const f = ctx.f
  if (!ctx.config.factoryRadar || hooks.busy() !== undefined || LG.nodeByRole(f.graph, RADAR_ROLE) !== undefined) return
  let failed = 0
  for (const g of f.goals) {
    if (g.kind !== "radar") continue
    if (g.status === "planning" || g.status === "building") return
    if (g.site !== undefined) continue
    if (g.status === "done") return
    if (g.status === "failed") failed++
  }
  if (failed >= RADAR_MAX_FAILED || !radarRecipe(ctx)) return
  log(`[rival-engineers] faction ${ctx.faction.name}: D56 radar goal`)
  hooks.startRadar(RADAR_ROLE)
}

/**
 * D62: goal `g` found no free `ore` patch on known ground: build the next radar outpost before its kind plans again
 * (unless a search is on whose outpost is still being built or scanned: then the failure just waits for it).
 */
export function exploreFor(ctx: ExploreCtx, g: FactoryGoal, ore: string): void {
  const f = ctx.f
  const ex = f.explore
  const need = searchNeed(ctx, ore)
  if (ex === undefined) {
    f.explore = { resource: ore, kind: g.kind, since: ctx.tick, phase: "outpost", outposts: 0, need }
    log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62) since tick ${ctx.tick} (${need}): goal ${g.id} (${g.kind}) found no free ${ore} patch within ${homeRadius(ctx)} tiles or on explored ground; radar outposts N, E, S, W in turn`)
    return
  }
  // An outpost is being built or scanned already: this failure waits for it like the others.
  if (ex.phase !== "retry") return
  ex.resource = ore
  ex.phase = "outpost"
  ex.goal = undefined
  // D70: the search now wants something the factory can't run without: from here it counts as required.
  if (need !== ex.need) {
    ex.need = need
    log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62) since tick ${ctx.tick} (${need}): goal ${g.id} (${g.kind}) now searches for ${ore}`)
  }
  log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62): goal ${g.id} still found no free ${ore} patch after ${ex.outposts} outposts (${math.floor((ctx.tick - ex.since) / 3600)} game-min); next outpost`)
}

/** D70: whether the faction already makes `what` (a built node or bootstrap site): if so the search is extra capacity. */
function searchNeed(ctx: ExploreCtx, what: string): ExploreNeed {
  const producers: Producer[] = []
  for (const n of LG.nodesOf(ctx.f.graph)) producers.push({ item: n.item, built: n.lifecycle === "built" })
  for (const s of storage.factions[ctx.faction.name]?.brain?.sites ?? []) producers.push({ item: s.resource, built: s.status === "built" })
  return exploreNeed(producers, what)
}

/** D62: a plan of the searching kind was adopted: the search is over. */
export function exploreDone(ctx: ExploreCtx, g: FactoryGoal): void {
  const ex = ctx.f.explore
  if (ex === undefined || g.kind !== ex.kind || g.site !== undefined) return
  log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORE (D62) over: goal ${g.id} (${g.kind}) planned after ${ex.outposts} radar outposts, ${math.floor((ctx.tick - ex.since) / 3600)} game-min exploring for ${ex.resource}`)
  ctx.f.explore = undefined
}

/** D62: goals of this kind wait while the search builds or scans an outpost (a reason for the waiting list). */
export function exploreHolds(ctx: ExploreCtx, kind: string): string | undefined {
  const ex = ctx.f.explore
  if (ex === undefined || kind !== ex.kind || ex.phase === "retry") return undefined
  return `${kind}: exploring for ${ex.resource} (D62, ${ex.phase})`
}

/**
 * D62 (user, 2026-10-21): the exploration search. Builds one radar outpost (a radar and a pole line from the base, on
 * the next arm), waits for its nearby square to be charted, then lets the blocked goal kind plan again.
 */
export function exploreStep(ctx: ExploreCtx, hooks: ExploreHooks): void {
  const f = ctx.f
  const ex = f.explore
  if (ex === undefined || ex.phase === "retry") return
  if (ex.phase === "scan") {
    // P43 (a): a powered outpost radar's nearby square counts as explored at once (the engine's nearby scan, which
    // charts nothing for a player-less force); its sector scans add farther chunks over time (onSectorScanned).
    const pos = ex.radar!
    const radar = radarAt(ctx, pos)
    const powered = radar !== undefined && radar.energy > 0
    if (!powered && ctx.tick < ex.scanUntil!) {
      ctx.waiting.push(`exploring for ${ex.resource} (D62): the outpost radar at ${pos.x},${pos.y} has no power yet`)
      return
    }
    if (powered) {
      f.radarChunks ??= {}
      for (const c of Arms.chunksAround(radar!.position, radarReach(ctx).nearby)) f.radarChunks[tkey(c.x, c.y)] = true
    }
    log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62): outpost radar at ${pos.x},${pos.y} ${powered ? "powered: its nearby square is explored" : radar === undefined ? "not found (gave up waiting)" : "still unpowered (gave up waiting)"}; ${ex.kind} goals plan again`)
    ex.phase = "retry"
    return
  }
  if (ex.goal !== undefined) {
    let g: FactoryGoal | undefined
    for (const x of f.goals) if (x.id === ex.goal) g = x
    if (g === undefined || g.status === "failed") {
      log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62): outpost goal ${ex.goal} failed (${g?.reason ?? "gone"}); trying the next arm`)
      ex.goal = undefined
      return
    }
    if (g.status !== "done") {
      ctx.waiting.push(`exploring for ${ex.resource} (D62): outpost goal ${g.id} ${g.status}`)
      return
    }
    const m = findModule(f.layout, g.nodes[0].id)
    const radar: Vec = m !== undefined ? { x: m.rect.x + 1, y: m.rect.y + 1 } : { x: g.site!.x, y: g.site!.y }
    f.arms!.outposts.push(radar)
    ex.radar = radar
    ex.scanUntil = ctx.tick + Arms.ARM_SCAN_WAIT
    ex.phase = "scan"
    ex.goal = undefined
    return
  }
  const busy = hooks.busy()
  if (busy !== undefined) {
    ctx.waiting.push(`exploring for ${ex.resource} (D62): outpost waits for ${busy}`)
    return
  }
  if (!radarRecipe(ctx)) {
    ctx.waiting.push(`exploring for ${ex.resource} (D62): no ${ctx.entities.radar ?? "radar"} recipe`)
    return
  }
  f.arms ??= { next: 0, steps: [0, 0, 0, 0], strips: [], outposts: [] }
  const arms = f.arms
  const arm = arms.next
  const step = arms.steps[arm]
  arms.next = (arm + 1) % 4
  arms.steps[arm] = step + 1
  const target = Arms.armTarget(f.center, arm, step)
  const strip = Arms.armStrip(f.center, arm, homeRadius(ctx), target)
  // The crew explores the strip as it builds there (the user: "The player should just explore the terrain while building it").
  arms.strips.push(strip)
  const role = `${RADAR_ROLE}:${Arms.ARM_NAMES[arm]}${step + 1}`
  ex.outposts++
  log(`[rival-engineers] faction ${ctx.faction.name}: EXPLORING (D62): radar outpost ${role} at ${target.x},${target.y} (arm ${Arms.ARM_NAMES[arm]}, outpost ${step + 1}) for ${ex.resource}`)
  ex.goal = hooks.startRadar(role, { x: target.x, y: target.y, arm, step, strip })
}
