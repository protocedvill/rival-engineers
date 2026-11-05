// Layout planning job (SPEC §5.3): place a set of module instances on the terrain, then route their single-item belt
// connections (D23), with rip-up-and-reroute when routes block each other. A resumable state machine (§5.6): each
// `stepPlan` call does at most `budget` work units (a placement candidate or an A* expansion is one unit; a summed-area
// table tile is 1/2), so the runtime spreads it over ticks. The job is plain data and lives in `storage`; the policy
// is looked up by id each step. Pure: no Factorio globals.

import { isPlanFailure, planFailure } from "../shared/plan-failure"
import type { PlanFailure } from "../shared/plan-failure"
import { ProtoFacts } from "../modules/facts"
import { BeltTier, tierByBelt } from "./capacity"
import { claimPoleTile, releaseLaneReservation, reserveFreeTile } from "./claims"
import { dirIndex, DX, DY, FREE, keyX, keyY, manhattan, Rect, TerrainView, tkey, Vec } from "./grid"
import { mergeGoals } from "./merge"
import { tunnelRoute, tunnelSite } from "./tunnel"
import type { MergeGoal } from "./merge"
import { commitRoute, fillSoftUnits, findModule, findPort, LayoutState, PlacedModule, layoutMargins, layoutRevision, newLayout, portOutside, PortRef, portTag, portTile, pumpPoleLine, rerootTap, ripRoute, Route, landsDownstream, pointFeeds, routeDangles, RouteStep, tapTree, unmarkModule } from "./layout"
import { newWholePatchPrep, stepWholePatch, WholePatchPrep } from "./whole-patch"
import { commitPlacement, expansionCandidate, placeFixed, laneTag, laneWayOut, layoutLaneGround, portLaneEnd, newPlacement, placementFailureCertificate, PlacementSearch, stepPlacement, tryExpand, wholePatchCandidate } from "./placement"
import { LayoutPolicy } from "./policy"
import { newPoleJob, PoleJob, stepPoles } from "./power"
import { minTileCost, newSearch, retargetSearch, RouteRequest, Search, searchResult, stepSearch, tileCost, underPassable } from "./router"
import { newPipeSearch, pipeFailureNotes, stepPipeSearch } from "./pipe-router"
import type { PipeCallbacks, PipeSearch, PipeStep } from "./pipe-router"
import { planTrace, traceEvent, traceRouteFailure } from "./trace"
import { ModuleDef, Port } from "../modules/types"
import { moduleId, poleId, routeId } from "../shared/ids"
import type { ConnectionId, PoleId, RouteId } from "../shared/ids"

export interface ModuleRequest {
  id: string
  /** Canonical module. */
  def: ModuleDef
  /** Route-reassignment provider: place an independent module instead of completing another logical provider's mine. */
  newSite?: boolean
  /**
   * With an expand-first policy: satisfy this request by growing a compatible placed module (same generator, recipe
   * and resource) by this many units, if there is room, instead of placing a new one.
   */
  expandUnits?: number
  /**
   * M7b: place exactly here (module origin), or fail: a module generated for one spot of the world (a pumpjack field on
   * its wells). It is never moved by a re-placement.
   */
  at?: Vec
}

export interface ConnectionRequest {
  id: ConnectionId
  /** Producer (a belt-out port). Absent: the input is fed from outside the layout (a one-tile stub is planned). */
  from?: PortRef
  /** Consumer (a belt-in port). */
  to: PortRef
  /** Planned rate (items/s); default: what the ports' rates allow. */
  rate?: number
  /** Belt tier for this connection (D24 upgrade-tier); default: the job's tier. */
  belt?: string
  /**
   * B60 provider groups: another provider already feeds this consumer. Join that route with a side-load instead of
   * routing a second belt into the input port.
   */
  merge?: boolean
  /**
   * M7b: a fluid connection (`pipe-out` → `pipe-in`), routed with pipes by `planner/pipe-router.ts`. The caller reads
   * the entities and limits from the prototypes (the planner stays pure).
   */
  fluid?: { name: string; pipe: string; underground: string; pump: string; maxUnderground: number; extent: number; pole?: string; verifiedFree?: Record<number, boolean> }
}

export interface PlanRequest {
  modules: ModuleRequest[]
  connections: ConnectionRequest[]
  /** Existing production: placement clusters around it. */
  center: Vec
  /** The scanned region the layout must stay in. */
  region: Rect
  /**
   * P44 (b): the force can build splitters. Whole-patch mines then join their drill rows with splitter merges (several
   * rows); without them a whole-patch mine is one row, which fills both lanes of its belt without side-loads.
   */
  splitters?: boolean
  /** Plan a pole network joining every consumer module to a generator module (this pole entity), after routing. */
  poles?: string
  /**
   * D36 / B2: after routing, route the same placement again with what an unresearched technology would allow, and
   * report how much shorter it is (the strategy researches it first when the saving is big enough).
   */
  compare?: CompareOptions
  /** Rectangles no module of this request may overlap (D38: temporary factories keep clear of the core's modules). */
  avoid?: Rect[]
  /** D57 (c): ore patches a mine found no room on before (`patchKey` → terrain stamp); skipped while unchanged. */
  deadPatches?: Record<string, string>
  /** B63: multiply every route window's margin (1 = policy default; 3 for a plan feeding a boxed-in consumer). */
  windowScale?: number
  /**
   * Tunnel crossings: base routes another goal is still building (its ghosts already stand for their current tiles).
   * They may not be crossed by a tunnel, which would rebuild them.
   */
  busyRoutes?: string[]
}

/** What the comparison routes (SPEC D36, backlog B2). */
export interface CompareOptions {
  /** The belt tiers with their real undergrounds (the plan itself has them clamped to none). */
  undergrounds?: { tiers: BeltTier[] }
  /**
   * Point-to-point producers of these items that feed several consumers in this plan: route with one producer per
   * item feeding the others' consumers through splitter taps (D22 splitter-tap), the rest of their supply chain gone.
   */
  splitters?: { items: string[] }
  /** Bound per alternative: this many times the plan's own routing work (at least `minWork`). */
  workFactor: number
  minWork: number
}

export interface CompareResult {
  kind: "undergrounds" | "splitters"
  status: "done" | "failed" | "capped" | "none"
  /** Route length (entities: belts, underground ends, splitters) of the plan's new routes, and of the alternative. */
  base: number
  alt?: number
  /** base − alt (positive: the alternative is shorter). */
  saving?: number
  work: number
  /** Splitters: per item, the consumer modules (request ids) one producer would feed. */
  merged?: Record<string, string[]>
  /** Splitters: producers dropped (request ids). */
  dropped?: string[]
  reason?: string
  /** D36: the plan itself failed to route (no plan without undergrounds): a routed alternative saves infinitely much. */
  baseFailed?: boolean
}

export interface PlanStats {
  /** Calls to stepPlan (ticks, at runtime). */
  steps: number
  work: number
  placeWork: number
  routeWork: number
  /** Placement candidates scored (work counters). */
  candidates: number
  /** D36 / B2: work of the comparison alternatives (also in `work`). */
  compareWork?: number
  expansions: number
  searches: number
  ripups: number
  /** Modules taken out and placed again because a connection could not be routed. */
  replacements: number
  maxStepWork: number
  /** Tunnel crossings made (`tunnel.ts`): other routes' runs turned into underground pairs. */
  tunnels?: number
}

export type PlanEvidence =
  | { kind: "placement"; subject: string; reason: string; candidates: number; rejections: Record<string, { count: number; sample: Vec }> }
  | {
      kind: "route"
      subject: string
      reason: string
      rip: boolean
      windowScale: number
      expansions: number
      /**
       * B57/B63: the seal check ran out at this end: its port, resolved. `edge` says the window boundary cut the flood,
       * i.e. the proof is only "no path *inside this window*".
       */
      sealed?: { side: "start" | "goal"; port: PortRef; edge?: boolean }
    }

export interface PlanJob {
  /** Revision of the base layout this plan copied. Old saved jobs omit it and retain legacy adoption behaviour. */
  sourceRevision?: number
  request: PlanRequest
  tier: BeltTier
  /** Tiers by belt name for per-connection tiers. */
  tiers?: BeltTier[]
  layout: LayoutState
  phase: "place" | "route" | "compare" | "poles" | "done" | "failed"
  /** The pole network phase (request.poles). */
  poleJob?: PoleJob
  /** Ids of what existed in the base layout before this job (to tell new parts from old). */
  baseModules: Record<string, boolean>
  baseRoutes: Record<string, boolean>
  order: string[]
  /** The order was adapted to the policy (D35 near-ore smelting) at the first placement step. */
  ordered?: boolean
  placeIdx: number
  placement?: PlacementSearch
  /** M7: the placed mine's whole-patch plan being prepared (`placement` is done; committed once this is). */
  wholePatch?: WholePatchPrep
  /** Request id → placed module id (an expanded module answers for the request). */
  alias: Record<string, string>
  /** D57 (c): patches this plan's mines found no room on (the strategy remembers them for later plans). */
  deadPatches?: Record<string, string>
  queue: string[]
  ripCount: Record<string, number>
  /**
   * Rip-up loop guard (seed 11 g104): `conn>victim` pairs ripped since the last re-placement. A connection ripping the
   * same route again means the routes are taking turns through a gap too narrow for all of them (four belts ripped
   * each other round after round, ~12M work units a round, until the rip-up limit moved the module).
   */
  ripPairs?: Record<string, boolean>
  /**
   * Window scale each connection last needed (seed 11 g108): a connection routed again after a rip-up or re-placement
   * starts there instead of failing the narrow windows again (a 400-tile coal tap paid ~2M units at window 1 every
   * round before widening). Only a hint: the ladder still widens from it.
   */
  winMemo?: Record<string, number>
  /** With `winMemo`: the connection was found in rip mode there (it starts in rip mode). */
  ripMemo?: Record<string, boolean>
  /**
   * M7 (B, seed 11 g111): merge connections that need no route of their own: a route from the same source port already
   * joins a belt that lands at their port (a trunk above their tap). Connection → that route's connection.
   */
  covered?: Record<string, string>
  /** M7 (B): merge connections put back once behind a sibling from the same source after their goals all failed. */
  deferred?: Record<string, number>
  /** M7: the fluid connection being routed (its search runs over several steps). */
  pipe?: PipeJob
  current?: { conn: string; search: Search; rip: boolean; avoid: Record<number, boolean>; retries: number; winScale?: number; mergeGoals?: NonNullable<RouteRequest["mergeGoals"]>; mergeTry?: number; work?: number }
  failures: Record<string, string>
  /** D69: the same failures, typed (the factory decides from `kind`, never from the text). */
  failed?: Record<string, PlanFailure>
  /** Structured failed attempts. Unlike `failures`, this preserves evidence from retries that later recover. */
  evidence?: PlanEvidence[]
  /** Expansions done instead of placements: request id → module id and the ports that moved. */
  expanded: Record<string, { module: string; units: number }>
  /** B23: a shared whole-patch mine that could not be expanded for the request: request id → reason. */
  wholeFail?: Record<string, string>
  /** B28: comparison branch probe: fail no-path edges the cheap way (the branches cap their work to compare). */
  compareProbe?: boolean
  /** Modules taken out after a connection could not be routed, to be placed again elsewhere (then routing resumes). */
  replaceQueue: string[]
  replaced: Record<string, number>
  /** Old footprints a re-placed module must avoid. */
  avoid: Record<string, Rect[]>
  stats: PlanStats
  /** D36 / B2 comparison (request.compare): alternatives still to route, the running one, and the results. */
  compare?: { queue: CompareResult["kind"][]; current?: { kind: CompareResult["kind"]; job: PlanJob; cap: number; base: number; merged?: Record<string, string[]>; dropped?: string[] }; results: CompareResult[] }
  /** D36: routing failed; the underground comparison still runs (the infinite case), then the plan fails. */
  routingFailed?: boolean
  /**
   * B57: the base's unconnected port lanes that led out when the plan started (port tag, lane end, way out), and the base
   * layout to plan again from if the plan walls one in (`guardLanes`). Undefined until the first step.
   */
  lanes?: { tag: string; module: string; port: string; path: Vec[] }[]
  laneBase?: LayoutState
  /** B57: tiles the plan, planned again, keeps clear for those lanes (reserved `lane:<port>`, dropped when it ends). */
  laneKeep?: number[]
  /** B85: this plan's new modules' port lanes it already re-routed around (once each), and the tiles it keeps clear. */
  newLaneTried?: Record<string, boolean>
  newLaneKeep?: number[]
}

function connectionsOf(req: PlanRequest, id: string): ConnectionRequest[] {
  return req.connections.filter((c) => c.from?.module === id || c.to.module === id)
}

/**
 * Shore sites first (water is rare), then repeatedly the module with the most connections to modules already ordered,
 * mining outposts last: each is placed on the ore nearest to the module it feeds (short ore belts).
 */
function placementOrder(req: PlanRequest): string[] {
  const order: string[] = []
  const done: Record<string, boolean> = {}
  for (const m of req.modules) {
    if (m.def.site === "shore") {
      order.push(m.id)
      done[m.id] = true
    }
  }
  for (const pass of [false, true]) for (;;) {
    let best: string | undefined
    let bestLinks = -1
    for (const m of req.modules) {
      if (done[m.id] || (m.def.site === "resource-patch") !== pass) continue
      let links = 0
      for (const c of connectionsOf(req, m.id)) {
        const other = c.from?.module === m.id ? c.to.module : c.from?.module
        if (other !== undefined && done[other]) links++
      }
      if (links > bestLinks) {
        best = m.id
        bestLinks = links
      }
    }
    if (best === undefined) break
    order.push(best)
    done[best] = true
  }
  return order
}

/** A smelter: a module (not site-anchored) whose main recipe is a smelting recipe. */
function isSmelter(def: ModuleDef, facts: ProtoFacts): boolean {
  return def.site === undefined && def.recipe !== undefined && facts.recipe(def.recipe)?.category === "smelting"
}

/** Connections into smelter `id` from mining outposts carrying one of its recipe's ingredients (its ore). */
function oreFeeds(req: PlanRequest, id: string, facts: ProtoFacts): ConnectionRequest[] {
  const def = req.modules.filter((m) => m.id === id)[0]?.def
  const r = def?.recipe !== undefined ? facts.recipe(def.recipe) : undefined
  if (r === undefined) return []
  const out: ConnectionRequest[] = []
  for (const c of req.connections) {
    if (c.to.module !== id || c.from === undefined) continue
    const src = req.modules.filter((m) => m.id === c.from!.module)[0]
    const port = src?.def.ports.filter((p) => p.id === c.from!.port)[0]
    if (src?.def.site === "resource-patch" && port?.item !== undefined && r.ingredients.some((i) => i.name === port.item)) out.push(c)
  }
  return out
}

/** D35 near-ore: each smelter's ore outposts move right before it, so the smelter is placed next to its ore. */
function nearOreOrder(req: PlanRequest, order: string[], facts: ProtoFacts): string[] {
  const out: string[] = []
  const done: Record<string, boolean> = {}
  for (const id of order) {
    if (done[id]) continue
    const def = req.modules.filter((m) => m.id === id)[0].def
    if (isSmelter(def, facts)) {
      for (const c of oreFeeds(req, id, facts)) {
        if (done[c.from!.module]) continue
        out.push(c.from!.module)
        done[c.from!.module] = true
      }
    }
    out.push(id)
    done[id] = true
  }
  return out
}

/** A copy of a layout that a plan job may change without touching the original (tables copied, defs shared). */
export function cloneLayout(l: LayoutState): LayoutState {
  const copy = <T>(r: Record<number, T>): Record<number, T> => {
    const o: Record<number, T> = {}
    for (const [k, v] of pairs(r)) o[k as number] = v as T
    return o
  }
  const spans: Record<string, LayoutState["spans"][string]> = {}
  for (const [k, list] of pairs(l.spans)) spans[k as string] = [...(list as LayoutState["spans"][string])]
  const routes: Record<string, Route> = {}
  for (const [k, r] of pairs(l.routes)) routes[k as string] = { ...(r as Route) }
  const out: LayoutState = {
    revision: l.revision,
    modules: l.modules.map((m) => ({ ...m, minePlan: m.minePlan !== undefined ? { ...m.minePlan, claim: [...m.minePlan.claim], occupied: [...m.minePlan.occupied] } : undefined })),
    occ: copy(l.occ),
    reserved: copy(l.reserved),
    routeOcc: copy(l.routeOcc),
    corridor: copy(l.corridor),
    soft: l.soft !== undefined ? copy(l.soft) : undefined,
    softUnit: l.softUnit !== undefined ? copy(l.softUnit) : {},
    mine: l.mine !== undefined ? copy(l.mine) : undefined,
    spans,
    routes,
    routeOrder: [...l.routeOrder],
    poles: l.poles !== undefined ? l.poles.map((p) => ({ ...p })) : undefined,
    poleLines: l.poleLines !== undefined ? l.poleLines.map((x) => ({ ...x, poles: [...x.poles] })) : undefined,
    evictedPoles: l.evictedPoles !== undefined ? l.evictedPoles.map((p) => ({ ...p })) : undefined,
  }
  // B52: soft claims marked before growth units were recorded (older saves and captures) get theirs.
  fillSoftUnits(out)
  return out
}

/**
 * A plan job. With `base`, it plans on top of an existing layout (the faction's base so far): a copy of it, where
 * existing modules never move and existing routes are never ripped up; connections may use existing modules' ports.
 */
export function newPlanJob(request: PlanRequest, tier: BeltTier, base?: LayoutState, tiers?: BeltTier[]): PlanJob {
  const layout = base !== undefined ? cloneLayout(base) : newLayout()
  const baseModules: Record<string, boolean> = {}
  const baseRoutes: Record<string, boolean> = {}
  const replaced: Record<string, number> = {}
  for (const m of layout.modules) {
    m.fixed = true
    baseModules[m.id] = true
    replaced[m.id] = math.huge
  }
  for (const id of layout.routeOrder) {
    layout.routes[id].fixed = true
    baseRoutes[id] = true
  }
  return {
    sourceRevision: base !== undefined ? layoutRevision(base) : 0,
    request,
    tier,
    tiers,
    baseModules,
    baseRoutes,
    layout,
    phase: "place",
    order: placementOrder(request),
    placeIdx: 0,
    alias: {},
    queue: [],
    ripCount: {},
    failures: {},
    expanded: {},
    replaceQueue: [],
    replaced,
    avoid: {},
    stats: { steps: 0, work: 0, placeWork: 0, routeWork: 0, candidates: 0, expansions: 0, searches: 0, ripups: 0, replacements: 0, maxStepWork: 0 },
  }
}

function moduleRequest(job: PlanJob, id: string): ModuleRequest {
  for (const m of job.request.modules) if (m.id === id) return m
  error(`unknown module request ${id}`)
}

function placementEvidence(job: PlanJob, id: string, search: PlacementSearch): void {
  job.evidence ??= []
  job.evidence.push({ kind: "placement", subject: id, reason: search.reason ?? "placement failed", candidates: search.candidates, rejections: placementFailureCertificate(search) })
}

function routeEvidence(job: PlanJob, conn: string, search: Search, rip: boolean, windowScale?: number, reason?: string): void {
  job.evidence ??= []
  const sl = search.sealed
  let sealed: { side: "start" | "goal"; port: PortRef; edge?: boolean } | undefined
  if (sl !== undefined) {
    const c = connection(job, conn)
    const ref = sl.side === "goal" ? c.to : c.from
    if (ref !== undefined) sealed = { side: sl.side, port: resolve(job, ref), edge: sl.edge }
  }
  job.evidence.push({ kind: "route", subject: conn, reason: reason ?? search.reason ?? "route failed", rip, windowScale: windowScale ?? 1, expansions: search.expansions, sealed })
}

export function resolve(job: PlanJob, ref: PortRef): PortRef {
  return { module: moduleId(job.alias[ref.module] ?? ref.module), port: ref.port }
}

/** D50: the modules `id` connects to (placed or not): their soft claims don't push it away. */
function partnersOf(job: PlanJob, id: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const c of connectionsOf(job.request, id)) {
    const other = c.from?.module === id ? c.to : c.from
    if (other !== undefined) out[resolve(job, other).module] = true
  }
  return out
}

/** Where each belt port of module `id` should face: the partner port's outside tile, if placed. */
function targetsFor(job: PlanJob, id: string): Record<string, Vec> {
  const out: Record<string, Vec> = {}
  for (const c of connectionsOf(job.request, id)) {
    const mine = c.from?.module === id ? c.from : c.to
    const other = c.from?.module === id ? c.to : c.from
    if (other === undefined) continue
    const r = resolve(job, other)
    const m = findModule(job.layout, r.module)
    const p = m ? findPort(m, r.port) : undefined
    if (m && p) out[mine.port] = portOutside(m, p)
  }
  return out
}

function startRouting(job: PlanJob): void {
  const conns = [...job.request.connections]
  const len = (c: ConnectionRequest): number => {
    if (c.from === undefined) return 0
    const a = resolve(job, c.from)
    const b = resolve(job, c.to)
    const ma = findModule(job.layout, a.module)
    const mb = findModule(job.layout, b.module)
    if (!ma || !mb) return 0
    return manhattan({ x: ma.rect.x, y: ma.rect.y }, { x: mb.rect.x, y: mb.rect.y })
  }
  // Short connections first (they have the fewest alternatives); ids break ties. B75: a provider-group merge goes
  // after every plain connection: it ends on another route's belt, which must be routed first. M7c.8: fluid lines go
  // before belts: a pipe cannot rip up, side-load or pass under a module, and on seed 11 the belts routed first boxed in
  // a remote crude line's last tile.
  conns.sort((a, b) => {
    const fa = a.fluid !== undefined ? 0 : 1
    const fb = b.fluid !== undefined ? 0 : 1
    if (fa !== fb) return fa - fb
    const ma = a.merge === true ? 1 : 0
    const mb = b.merge === true ? 1 : 0
    if (ma !== mb) return ma - mb
    const la = len(a)
    const lb = len(b)
    if (la !== lb) return la - lb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  job.queue = conns.map((c) => c.id)
  job.covered = undefined
  job.deferred = undefined
  job.phase = "route"
}

function connection(job: PlanJob, id: string): ConnectionRequest {
  for (const c of job.request.connections) if (c.id === id) return c
  error(`unknown connection ${id}`)
}

/** Routes already serving the same producer port (splitter taps branch off them). B23: compared against the
 * alias-resolved source — a request aliased onto a whole-patch base mine feeds from the base route's port. */
function sameSource(job: PlanJob, from: PortRef, conn: string): string[] {
  const out: string[] = []
  // B88: never the connection's own route (in the base when it is planned again) or what taps it: committing the new
  // route replaces that route in place and rips its taps, so a tap of them would be left tapping nothing.
  const own: Record<string, boolean> = {}
  for (const id of tapTree(job.layout, [routeId(`route:${conn}`)])) own[id] = true
  for (const id of job.layout.routeOrder) {
    if (own[id]) continue
    // Routes of the base layout belong to earlier requests: compare the route's own source.
    const r = job.layout.routes[id]
    const src = r.tapOf === undefined ? r.from : job.layout.routes[r.tapOf]?.from
    if (src !== undefined && src.module === from.module && src.port === from.port) out.push(id)
  }
  return out
}

/**
 * B79: whether a route other than connection `conn`'s (not a crew-fed stub) already brings items to port `to`. B86: not
 * a dangling one (`routeDangles`): a side-load stub whose trunk was ripped (a growth rerouting the trunk) does not feed the
 * port, and treating it as a feed made the trunk itself a merge onto that stub (vps eecca19 2229258: the steam block's
 * coal route became a 15-step side-load that landed nowhere).
 */
export function portFedByOther(layout: LayoutState, to: PortRef, conn: string): boolean {
  for (const rid of layout.routeOrder) {
    const r = layout.routes[rid]
    if (r === undefined || r.external === true || r.to.module !== to.module || r.to.port !== to.port || routeDangles(layout, rid)) continue
    // B93 (sweep 3e1c4d7 seed 1376111): only the connection's own route (its id) is not a feed. (Route adoption, removed
    // by D76, kept routes under the replacement connection's name with an id of their own; skipping them by name routed
    // the replacement into the port they held.)
    if (rid !== `route:${conn}`) return true
  }
  return false
}

/** M7: a fluid connection being routed: its search (stepped under the plan's budget) and what finishing it needs. */
export interface PipeJob {
  conn: string
  search: PipeSearch
  /** Plain pipes of the same fluid's lines from this source, by tile (B120 tap). */
  trunk: Record<number, string>
  /** Tiles of other fluids (other routes, other pipe ports). */
  fluids: Record<number, boolean>
  /** B149: the line of this fluid already feeding the target port that the route ends beside (its goal), if any. */
  joins?: string
  costReq: RouteRequest
  /** Work so far (only kept while `planTrace.searches` is set). */
  work?: number
}

/** The pipe search's view of the layout and terrain (rebuilt every step: callbacks never go in `storage`). */
function pipeCallbacks(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, pj: PipeJob): PipeCallbacks {
  const f = connection(job, pj.conn).fluid!
  const routeTerrain = pipeTerrain(terrain, f)
  return {
    cost: (x, y) => tileCost(job.layout, routeTerrain, policy, pj.costReq, false, x, y),
    under: (x, y, axis) => underPassable(job.layout, terrain, policy, x, y, "pipe") && pipeSpanAt(job.layout, x, y, axis) === undefined,
    fluidNear: (x, y) => pj.fluids[tkey(x, y)] === true,
  }
}

/**
 * A built source's exit and its immediate neighbours can retain an OWN terrain/claim mark after an entity is gone. The
 * runtime verifies each tile can actually take a pipe before marking it free; layout collisions still apply.
 */
function pipeTerrain(terrain: TerrainView, f: NonNullable<ConnectionRequest["fluid"]>): TerrainView {
  if (f.verifiedFree === undefined) return terrain
  return {
    block: (x, y) => f.verifiedFree?.[tkey(x, y)] === true ? FREE : terrain.block(x, y),
    ore: (x, y) => terrain.ore(x, y),
  }
}

/**
 * M7b: starts routing a fluid connection (`pipe-router.ts`): the search runs under the step budget (`pipeStep`) and is
 * bounded by `PIPE_BUDGET` work units. Returns undefined (and records the failure) when the ports are missing.
 */
function newPipeJob(job: PlanJob, policy: LayoutPolicy, c: ConnectionRequest): PipeJob | undefined {
  const f = c.fluid!
  const fromRef = c.from !== undefined ? resolve(job, c.from) : undefined
  const toRef = resolve(job, c.to)
  const fm = fromRef !== undefined ? findModule(job.layout, fromRef.module) : undefined
  const fp = fm !== undefined && fromRef !== undefined ? findPort(fm, fromRef.port) : undefined
  const tm = findModule(job.layout, toRef.module)
  const tp = tm !== undefined ? findPort(tm, toRef.port) : undefined
  if (fm === undefined || fp === undefined || fp.kind !== "pipe-out" || tm === undefined || tp === undefined || tp.kind !== "pipe-in") {
    fail(job, c.id, `no pipe ports ${fromRef?.module}.${fromRef?.port} → ${toRef.module}.${toRef.port}`)
    return undefined
  }
  const start = portOutside(fm, fp)
  const goal = portOutside(tm, tp)
  const id = `route:${c.id}`
  const own: Record<string, boolean> = { [portTag(fm.id, fp.id)]: true, [portTag(tm.id, tp.id)]: true }
  const costReq = { id, conn: c.id, item: f.name, from: fromRef, to: toRef, goal: { x: goal.x, y: goal.y, dir: 0 }, tier: job.tier, own } as RouteRequest
  // B120: a line of this fluid already leaves the source port (a second consumer of one pumpjack field): tap it. The
  // route starts beside any plain pipe of that line (a pipe joins every neighbouring pipe), not at the port.
  const trunk: Record<number, string> = {}
  const starts: { x: number; y: number; dir: number; run: number }[] = []
  if (fromRef !== undefined) {
    const lines = sameSource(job, fromRef, c.id).filter((rid) => job.layout.routes[rid].fluid?.name === f.name)
    for (const rid of lines) for (const k of job.layout.routes[rid].tiles) trunk[k] = rid
    for (const rid of lines) {
      const route = job.layout.routes[rid]
      // M7c.8: a tap joins the trunk's segment there: it starts with that whole segment's length counted (seed 11: a
      // sulfur tap from beside the field merged 600 tiles into the first segment, which then carried nothing).
      const seg = segmentLengths(route.steps, moduleFluidRun(fm, fp))
      for (let i = 0; i < route.steps.length; i++) {
        const st = route.steps[i]
        if (st.kind !== "pipe") continue
        for (let d = 0; d < 4; d++) {
          const k = tkey(st.x + DX[d], st.y + DY[d])
          if (trunk[k] === undefined) starts.push({ x: st.x + DX[d], y: st.y + DY[d], dir: d, run: seg[i] })
        }
      }
    }
  }
  // Other fluids: other fluid routes' tiles, every other pipe port of a module, and module pipes on its edge.
  const fluids: Record<number, boolean> = {}
  for (const rid of job.layout.routeOrder) {
    const r = job.layout.routes[rid]
    if (r.fluid !== undefined && rid !== id) for (const k of r.tiles) if (trunk[k] === undefined) fluids[k] = true
  }
  for (const m of job.layout.modules) {
    for (const p of m.def.ports) {
      if ((p.kind !== "pipe-in" && p.kind !== "pipe-out") || (m.id === fm.id && p.id === fp.id) || (m.id === tm.id && p.id === tp.id)) continue
      const t = portTile(m, p)
      fluids[tkey(t.x, t.y)] = true
      // M7c.8: and, for another fluid, the tile its own pipe will take outside the port: a pipe beside it would join
      // that line (seed 11: a sulfur chain's water line ran past its crude port's outside tile, two tiles away).
      if (p.item !== f.name) {
        const o = portOutside(m, p)
        const ko = tkey(o.x, o.y)
        if (trunk[ko] === undefined) fluids[ko] = true
      }
    }
  }
  // B147 (seed 11 g154): and every pipe on a module's edge, but the ones in this route's own ports' segments. A plain
  // pipe joins every neighbour: a crude line laid along an oil complex's top edge joined its water manifold, the crude
  // flowed down the new water line, and its last pipe could never be placed (Factorio refuses to mix fluids).
  for (const m of job.layout.modules) {
    const own: Record<number, boolean> = {}
    if (m.id === fm.id) for (const [k] of pairs(portSegment(m, fp).tiles)) own[k] = true
    if (m.id === tm.id) for (const [k] of pairs(portSegment(m, tp).tiles)) own[k] = true
    const { w: mw, h: mh } = m.def.footprint
    for (const e of m.def.entities) {
      if (e.name !== "pipe" && string.find(e.name, "pipe-to-ground", 1, true)[0] === undefined) continue
      const lx = math.floor(e.x)
      const ly = math.floor(e.y)
      if ((lx > 0 && ly > 0 && lx < mw - 1 && ly < mh - 1) || own[tkey(lx, ly)]) continue
      fluids[tkey(m.origin.x + lx, m.origin.y + ly)] = true
    }
  }
  // B149 (seed 11 g198): a line of this fluid from another provider already feeds the target port and holds its outside
  // tile: the route ends beside one of its plain pipes instead (the nearest free tile to the start), and joins it there.
  let goalAt = { x: goal.x, y: goal.y, dir: math.floor(tp.dir / 4) }
  let goalRun = moduleFluidRun(tm, tp)
  let joins: string | undefined
  const fed = feedingLines(job, toRef, f.name, id)
  if (fed.length > 0) {
    let best: { x: number; y: number; dir: number; run: number; line: string; d: number } | undefined
    for (const rid of fed) {
      const route = job.layout.routes[rid]
      const tiles: Record<number, boolean> = {}
      for (const k of route.tiles) tiles[k] = true
      const seg = segmentLengths(route.steps, route.from !== undefined ? fluidRunOf(job, route.from) : 0)
      for (let i = 0; i < route.steps.length; i++) {
        const st = route.steps[i]
        if (st.kind !== "pipe") continue
        for (let d = 0; d < 4; d++) {
          const x = st.x + DX[d]
          const y = st.y + DY[d]
          const k = tkey(x, y)
          if (tiles[k] || fluids[k] || trunk[k] !== undefined || job.layout.occ[k] !== undefined || job.layout.routeOcc[k] !== undefined) continue
          // Its other neighbours must not be another fluid's (the arrival allows only the joined pipe).
          let clear = true
          for (let e = 0; e < 4 && clear; e++) if (e !== opposite4(d) && fluids[tkey(x + DX[e], y + DY[e])]) clear = false
          if (!clear) continue
          const dist = math.abs(x - start.x) + math.abs(y - start.y)
          if (best === undefined || dist < best.d) best = { x, y, dir: opposite4(d), run: seg[i], line: rid, d: dist }
        }
      }
    }
    if (best !== undefined) {
      goalAt = { x: best.x, y: best.y, dir: best.dir }
      goalRun = best.run
      joins = best.line
    }
  }
  const w = policy.router
  const search = newPipeSearch({
    start: { x: start.x, y: start.y, dir: math.floor(fp.dir / 4) },
    starts: starts.length > 0 ? starts : undefined,
    goal: goalAt,
    maxUnderground: f.maxUnderground,
    extent: f.extent - PIPE_EXTENT_MARGIN,
    startRun: starts.length > 0 ? 0 : moduleFluidRun(fm, fp),
    goalRun,
    minCost: minTileCost(policy),
    ugCost: w.pipeUnderground ?? 2,
    pumpCost: w.pump ?? 10,
    budget: PIPE_BUDGET,
    cell: w.coarseCell,
    longRoute: w.longRoute,
    corridorCells: w.corridorCells,
  })
  return { conn: c.id, search, trunk, fluids, costReq, joins }
}

/** B149: lines of fluid `fluid` (not connection `id`'s own, not dangling) that already feed port `to`. */
function feedingLines(job: PlanJob, to: PortRef, fluid: string, id: string): string[] {
  const out: string[] = []
  for (const rid of job.layout.routeOrder) {
    const r = job.layout.routes[rid]
    if (r === undefined || rid === id || r.fluid?.name !== fluid || r.to.module !== to.module || r.to.port !== to.port) continue
    if (!routeDangles(job.layout, rid)) out.push(rid)
  }
  return out
}

/** The in-module run of a route's source port (0 when the module or port is gone). */
function fluidRunOf(job: PlanJob, from: PortRef): number {
  const m = findModule(job.layout, from.module)
  const p = m !== undefined ? findPort(m, from.port) : undefined
  return m !== undefined && p !== undefined ? moduleFluidRun(m, p) : 0
}

/**
 * M7c.8: for each step of a fluid route, the length of the segment (between pumps) it belongs to, the first segment
 * starting with `first` tiles inside the source module; a pipe-to-ground pair counts its span.
 */
function segmentLengths(steps: RouteStep[], first: number): number[] {
  const segOf: number[] = []
  const len: number[] = [first]
  let seg = 0
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]
    if (st.kind === "pump") {
      seg++
      len[seg] = 0
      segOf.push(-1)
      continue
    }
    segOf.push(seg)
    const prev = steps[i - 1]
    len[seg] += st.kind === "pipe-ug-out" && prev !== undefined ? math.abs(st.x - prev.x) + math.abs(st.y - prev.y) : 1
  }
  return segOf.map((s) => (s < 0 ? 0 : len[s]))
}

/**
 * M7c.8: an upper bound on the path a module's fluid takes inside it toward port `p`: the module's pipe tiles that
 * join the port's tile (pipe-to-ground pairs count their span, as the engine does). B146 (seed 11 g154): this counted
 * every pipe of the module, so an oil complex's water port read 221 tiles (crude, gas, oil and lube lines with it) and
 * left 91 of the 312-tile extent for its water line, which no route from the lake could keep. A 2.0 segment is pipes
 * only (a machine's fluid box starts its own), so a port on a machine reads 0. A pipe-to-ground end joins on its
 * open side (its direction) and through its partner (the nearest end behind it facing the other way).
 */
export function moduleFluidRun(m: PlacedModule, p: Port): number {
  return portSegment(m, p).run
}

/** The pipes of module `m` in port `p`'s segment (module-local tile keys) and their run (see `moduleFluidRun`). */
function portSegment(m: PlacedModule, p: Port): { run: number; tiles: Record<number, boolean> } {
  const pipes: Record<number, boolean> = {}
  // Pipe-to-ground ends by tile: their open side (the entity's direction, as the generators place them).
  const ug: Record<number, number> = {}
  for (const e of m.def.entities) {
    const k = tkey(math.floor(e.x), math.floor(e.y))
    if (e.name === "pipe") pipes[k] = true
    else if (string.find(e.name, "pipe-to-ground", 1, true)[0] !== undefined) ug[k] = math.floor((e.dir ?? 0) / 4) % 4
  }
  // An end's partner: the nearest end behind it facing the other way (span: tiles between, both ends included).
  const partner = (x: number, y: number, d: number): { x: number; y: number; span: number } | undefined => {
    for (let k = 1; k <= UG_PARTNER_REACH; k++) {
      const bx = x - DX[d] * k
      const by = y - DY[d] * k
      if (ug[tkey(bx, by)] === opposite4(d)) return { x: bx, y: by, span: k + 1 }
    }
    return undefined
  }
  let n = 0
  const seen: Record<number, boolean> = {}
  // Entries: a tile and the tile it is entered from (undefined for the port's own tile).
  const queue: { x: number; y: number; from?: number }[] = [{ x: math.floor(p.pos.x), y: math.floor(p.pos.y) }]
  while (queue.length > 0) {
    const t = queue.pop()!
    const k = tkey(t.x, t.y)
    if (seen[k]) continue
    const d = ug[k]
    if (d !== undefined) {
      const open = tkey(t.x + DX[d], t.y + DY[d])
      const b = partner(t.x, t.y, d)
      // An end joins above ground on its open side only (or through its partner).
      if (t.from !== undefined && t.from !== open && (b === undefined || t.from !== tkey(b.x, b.y))) continue
      seen[k] = true
      queue.push({ x: t.x + DX[d], y: t.y + DY[d], from: k })
      if (b !== undefined) {
        // Each end counts half the pair's span, as the engine counts the whole span.
        n += b.span / 2
        queue.push({ x: b.x, y: b.y, from: k })
      } else n += 1
      continue
    }
    if (!pipes[k]) continue
    seen[k] = true
    n++
    for (let i = 0; i < 4; i++) queue.push({ x: t.x + DX[i], y: t.y + DY[i], from: k })
  }
  return { run: math.ceil(n), tiles: seen }
}

/** How far behind a pipe-to-ground end its partner may be (vanilla pipe-to-ground reach is 10 tiles between). */
const UG_PARTNER_REACH = 11

function opposite4(d: number): number {
  return (d + 2) % 4
}

/** Steps the running fluid connection (`job.pipe`); commits its route or records the failure when the search ends. */
function pipeStep(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const pj = job.pipe!
  const s = pj.search
  const used = stepPipeSearch(s, pipeCallbacks(job, terrain, policy, pj), budget)
  job.stats.routeWork += used
  job.stats.expansions += used
  if (planTrace.searches !== undefined) {
    pj.work = (pj.work ?? 0) + used
    if (s.status !== "running") planTrace.searches(`pipe ${pj.conn} ${s.status} work=${math.floor(pj.work)}`)
  }
  if (s.status === "running") return used
  job.pipe = undefined
  const c = connection(job, pj.conn)
  const f = c.fluid!
  if (s.status === "failed") {
    const st = s.p.start
    const routeTerrain = pipeTerrain(terrain, f)
    const k = tkey(st.x, st.y)
    const g = s.p.goal
    fail(job, c.id, `no pipe path (${s.reason ?? "unknown"}, ${s.work} expansions; start ${st.x},${st.y} raw block ${terrain.block(st.x, st.y)} routed block ${routeTerrain.block(st.x, st.y)} cost ${tileCost(job.layout, routeTerrain, policy, pj.costReq, false, st.x, st.y)} occ ${job.layout.occ[k] ?? "-"} reserve ${job.layout.reserved[k] ?? "-"}, goal ${g.x},${g.y}, taps ${s.p.starts?.length ?? 0}; ${pipeFailureNotes(s, pipeCallbacks(job, terrain, policy, pj))})`)
    return used
  }
  const r = s.result!
  const id = pj.costReq.id
  const first = r.steps[0]
  let tapOf: string | undefined
  if (s.p.starts !== undefined && first !== undefined) for (let d = 0; d < 4 && tapOf === undefined; d++) tapOf = pj.trunk[tkey(first.x + DX[d], first.y + DY[d])]
  const route = pipeRoute(id, c, f, r.steps, r.cost)
  if (tapOf !== undefined) route.tapOf = routeId(tapOf)
  if (pj.joins !== undefined) route.joins = routeId(pj.joins)
  commitRoute(job.layout, route)
  // Each pump needs power: a pole on a free tile beside it, as a pole line the pole step joins to the network.
  const poles: PoleId[] = []
  const line = pumpPoleLine(id)
  for (let i = 0; i < r.steps.length; i++) {
    const st = r.steps[i]
    if (st.kind !== "pump") continue
    const spot = pumpPoleSpot(job.layout, terrain, policy, pj.costReq, st)
    if (spot === undefined) {
      fail(job, c.id, `no room for a pole beside the pump at ${st.x},${st.y}`)
      return used
    }
    const pid = poleId(`${line}:${i}`)
    job.layout.poles = [...(job.layout.poles ?? []), { id: pid, name: f.pole ?? "small-electric-pole", x: spot.x, y: spot.y, line }]
    claimPoleTile(job.layout, tkey(spot.x, spot.y), line)
    poles.push(pid)
  }
  if (poles.length > 0) job.layout.poleLines = [...(job.layout.poleLines ?? []), { id: line, to: moduleId(id), from: "pump", poles }]
  return used
}

/** A free tile beside a pump (either of its two tiles) for its pole. */
function pumpPoleSpot(layout: LayoutState, terrain: TerrainView, policy: LayoutPolicy, req: RouteRequest, st: PipeStep): Vec | undefined {
  const side = [(st.dir + 1) % 4, (st.dir + 3) % 4]
  for (let along = 0; along < 2; along++) {
    for (const d of side) {
      const x = st.x + DX[st.dir] * along + DX[d]
      const y = st.y + DY[st.dir] * along + DY[d]
      const k = tkey(x, y)
      if (layout.occ[k] !== undefined || layout.routeOcc[k] !== undefined) continue
      if (tileCost(layout, terrain, policy, req, false, x, y) >= 0) return { x, y }
    }
  }
  return undefined
}

/**
 * M7c.8: tiles kept free of each fluid segment's extent. Seed 11: a segment the router made 320 tiles long (pump to
 * pump) carried nothing; the engine counts a little more than the router's path (the pumps' own tiles at least). 8: an
 * agent guess, at most one extra pump on a long line.
 */
const PIPE_EXTENT_MARGIN = 8

/** Expansions one fluid route may take (agent guess; a 600-tile line needs a few thousand). */
const PIPE_BUDGET = 200000

/** The line key of pipe-to-ground spans (apart from belt undergrounds: the two never connect). */
function pipeLine(x: number, y: number, axis: number): string {
  return `p${axis === 1 ? `h${y}` : `v${x}`}`
}

/** The fluid route whose pipe-to-ground span on `axis` covers (x, y), if any. */
function pipeSpanAt(layout: LayoutState, x: number, y: number, axis: number): string | undefined {
  const c = axis === 1 ? x : y
  for (const sp of layout.spans[pipeLine(x, y, axis)] ?? []) if (sp.a <= c && c <= sp.b) return sp.route
  return undefined
}

function pipeRoute(id: string, c: ConnectionRequest, f: NonNullable<ConnectionRequest["fluid"]>, steps: PipeStep[], cost: number): Route {
  const out: RouteStep[] = []
  const tiles: number[] = []
  const spans: Route["spans"] = []
  let ugs = 0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const kind = s.kind === "ug-in" ? "pipe-ug-in" : s.kind === "ug-out" ? "pipe-ug-out" : s.kind
    out.push({ kind, x: s.x, y: s.y, dir: s.dir })
    tiles.push(tkey(s.x, s.y))
    if (s.kind === "pump") tiles.push(tkey(s.x + DX[s.dir], s.y + DY[s.dir]))
    if (s.kind === "ug-in") {
      const e = steps[i + 1]
      const axis = s.dir % 2
      spans.push({ line: pipeLine(s.x, s.y, axis), span: { a: axis === 1 ? math.min(s.x, e.x) : math.min(s.y, e.y), b: axis === 1 ? math.max(s.x, e.x) : math.max(s.y, e.y), route: id } })
      ugs++
    }
  }
  return {
    id: routeId(id),
    conn: c.id,
    item: f.name,
    from: c.from,
    to: c.to,
    steps: out,
    tiles,
    spans,
    belt: "",
    underground: "",
    splitter: "",
    length: steps.length,
    undergrounds: ugs,
    cost,
    ripped: 0,
    fluid: { name: f.name, pipe: f.pipe, underground: f.underground, pump: f.pump, maxUnderground: f.maxUnderground, extent: f.extent, pole: f.pole },
  }
}

/** Tunnel crossings for this job's searches (`tunnel.ts`): the policy's cost, and the base routes others still build. */
function tunnelOption(job: PlanJob, policy: LayoutPolicy, maxUnderground: number): RouteRequest["tunnel"] {
  const cost = policy.router.tunnel ?? 0
  // Span 2: the crossed run needs undergrounds of at least that reach (none before their technology).
  if (cost <= 0 || maxUnderground < 2) return undefined
  const busy: Record<string, boolean> = {}
  for (const id of job.request.busyRoutes ?? []) busy[id] = true
  return { cost, busy }
}

/** Records a failure of `key` (a connection, `module:<id>` or `power:<owner>`): its text and, D69, its kind. */
function fail(job: PlanJob, key: string, failure: PlanFailure | string): void {
  const f = typeof failure === "string" ? planFailure("other", failure) : failure
  job.failures[key] = f.reason
  ;(job.failed ??= {})[key] = f
}

function routeRequest(job: PlanJob, c: ConnectionRequest, policy: LayoutPolicy, avoid: Record<number, boolean>, winScale?: number): RouteRequest | PlanFailure {
  const to = resolve(job, c.to)
  const tm = findModule(job.layout, to.module)
  const tp = tm ? findPort(tm, to.port) : undefined
  if (!tm || !tp || tp.kind !== "belt-in") return planFailure("other", `no belt-in port ${to.module}.${to.port}`)
  const goalTile = portTile(tm, tp)
  const own: Record<string, boolean> = { [portTag(tm.id, tp.id)]: true, [laneTag(portTag(tm.id, tp.id))]: true }
  const tier = (c.belt !== undefined && job.tiers !== undefined ? tierByBelt(job.tiers, c.belt) : undefined) ?? job.tier
  const req: RouteRequest = {
    id: `route:${c.id}`,
    conn: c.id,
    item: tp.item ?? "",
    to,
    goal: { x: goalTile.x, y: goalTile.y, dir: dirIndex(tp.dir), side: tp.side },
    tier,
    own,
    avoid,
    windowMargin: winScale,
    tunnel: tunnelOption(job, policy, tier.maxUnderground),
  }
  if (c.from !== undefined) {
    const from = resolve(job, c.from)
    const fm = findModule(job.layout, from.module)
    const fp = fm ? findPort(fm, from.port) : undefined
    if (!fm || !fp || fp.kind !== "belt-out") return planFailure("other", `no belt-out port ${from.module}.${from.port}`)
    if (fp.item !== undefined && tp.item !== undefined && fp.item !== tp.item) return planFailure("other", `item mismatch ${fp.item} → ${tp.item}`)
    req.from = from
    own[portTag(fm.id, fp.id)] = true
    own[laneTag(portTag(fm.id, fp.id))] = true
    const taps = sameSource(job, from, c.id)
    if (taps.length > 0) {
      if (policy.topology !== "splitter-tap") return planFailure("other", `port ${from.module}.${from.port} already feeds a route (point-to-point topology; use splitter-tap)`)
      req.taps = taps
    } else {
      const o = portOutside(fm, fp)
      req.start = { x: o.x, y: o.y, dir: dirIndex(fp.dir) }
    }
  }
  // B79: a port tile takes one belt. A plain connection into a port another route already ends at can never route
  // there (every plan "no path": vps-b78-r2034469, a parallel smelter given whole consumers its short sibling still
  // feeds); it joins that route like a provider-group merge (B60).
  if (c.merge === true || portFedByOther(job.layout, to, c.id)) {
    const share = policy.router.sideLoadLaneShare
    const goals = mergeGoals(job.layout, to, c.from, share !== undefined ? { capacity: req.tier.laneCapacity, share } : undefined, siblingScore(job, c))
    if (goals.length > 0) {
      req.mergeGoals = goals
      applyMergeGoal(req, goals[0])
    } else if (portFedByOther(job.layout, to, c.id)) return planFailure("no-merge-target", `no merge target for ${to.module}.${to.port}`)
    // B89 (vps-b88b-r1264816-m60): a merge whose trunk is gone (ripped, or never landing) has nothing to join; the port
    // is free, so it routes there itself (the B88 in-place reroute of power's coal trunk failed "no merge target").
  }
  return req
}

/**
 * Points the request at merge goal `g`: a side-load ends on the trunk belt from the requested side, a splitter merge
 * ends on the tile beside the trunk, parallel to it, and appends the splitter.
 */
function applyMergeGoal(req: RouteRequest, g: MergeGoal): void {
  if (g.x2 !== undefined && g.y2 !== undefined) {
    req.merge = false
    req.mergeSplitter = { x: g.x, y: g.y, dir: g.dir, x2: g.x2, y2: g.y2 }
    req.goal = { x: g.x2, y: g.y2, dir: g.dir }
    return
  }
  req.merge = true
  req.mergeSplitter = undefined
  req.goal = { x: g.x, y: g.y, dir: g.dir, side: g.side ?? "left" }
}

/** An external input: a one-tile belt stub on the port's outside tile, fed from outside the layout. */
function externalStub(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, c: ConnectionRequest, req: RouteRequest): Route | string {
  const tm = findModule(job.layout, req.to.module)!
  const tp = findPort(tm, req.to.port)!
  const o = portOutside(tm, tp)
  if (tileCost(job.layout, terrain, policy, req, false, o.x, o.y) < 0) return `external input ${req.to.module}.${req.to.port}: outside tile blocked`
  const dir = dirIndex(tp.dir)
  return {
    id: routeId(req.id),
    conn: c.id,
    item: req.item,
    to: req.to,
    steps: [{ kind: "belt", x: o.x, y: o.y, dir }],
    startDir: dir,
    tiles: [tkey(o.x, o.y)],
    spans: [],
    belt: job.tier.belt,
    underground: job.tier.underground,
    splitter: job.tier.splitter,
    length: 1,
    undergrounds: 0,
    cost: 1,
    external: true,
    ripped: 0,
  }
}

/** Steps a module's placement search (none once it is done: its whole-patch plan may still be preparing). */
function searchPlacement(job: PlanJob, s: PlacementSearch, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  if (s.phase === "done") return 0
  const c0 = s.candidates ?? 0
  const used = stepPlacement(s, job.layout, terrain, policy, budget)
  keepDeadPatches(job, s)
  job.stats.placeWork += used
  job.stats.candidates = (job.stats.candidates ?? 0) + (s.candidates ?? 0) - c0
  return used
}

/**
 * M7: a placed mine's whole-patch plan (`stepWholePatch`), prepared under the step's budget before the module is
 * committed (`job.wholePatch` is cleared once it is ready). Work counts as placement work.
 */
function wholePatchStep(job: PlanJob, s: PlacementSearch, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  const p = (job.wholePatch ??= newWholePatchPrep())
  let used = 0
  if (budget > 0 || p.stage === "done") {
    used = stepWholePatch(p, s.result!, { terrain, facts, region: s.req.region, policy, state: job.layout, splitters: job.request.splitters === true }, budget)
    job.stats.placeWork += used
  }
  if (p.stage === "done") job.wholePatch = undefined
  return used
}

function replaceStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  const id = moduleId(job.replaceQueue[0])
  if (job.placement === undefined) {
    const mreq = moduleRequest(job, id)
    job.placement = newPlacement({ id, def: mreq.def, targets: targetsFor(job, id), center: job.request.center, region: job.request.region, avoid: [...(job.avoid[id] ?? []), ...(job.request.avoid ?? [])], softExempt: partnersOf(job, id), dead: job.request.deadPatches })
  }
  const s = job.placement
  let used = searchPlacement(job, s, terrain, policy, budget)
  if (s.phase === "done") {
    used += wholePatchStep(job, s, terrain, facts, policy, budget - used)
    if (job.wholePatch !== undefined) return used
  }
  if (s.phase === "done" || s.phase === "failed") {
    if (s.phase === "done") commitPlacement(job.layout, s.result!, facts, policy)
    else {
      placementEvidence(job, id, s)
      fail(job, `module:${id}`, { kind: s.failure?.kind ?? "other", reason: `re-placement: ${s.reason ?? "failed"}`, what: s.failure?.what })
      if (planTrace.sink !== undefined) traceEvent(`module ${id}: re-placement failed: ${s.reason ?? "failed"}`)
    }
    job.placement = undefined
    job.replaceQueue.shift()
    if (job.replaceQueue.length === 0) job.phase = "route"
  }
  return used
}

/**
 * B28: the ground a re-placed module must leave. The old footprint alone is not enough: a candidate just beside it can
 * sit in the same pocket, so the failed feed repeats. Pad by the route margin, which is the distance at which a
 * detour would have been found if one existed.
 */
export function replacementAvoid(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, w: rect.w + 2 * margin, h: rect.h + 2 * margin }
}

/**
 * A connection that rip-up could not route: take out one of its modules (the consumer first, or the producer when the
 * seal check proved the start walled in; never a site-anchored, built or expanded one, at most twice each) with every
 * route touching it, and place it again away from its old footprint. Returns false if no module can move.
 */
function tryReplace(job: PlanJob, c: ConnectionRequest, facts: ProtoFacts, policy: LayoutPolicy, search?: Search): boolean {
  const ids = [c.to.module]
  if (c.from !== undefined) ids.push(c.from.module)
  // B57 (seed 11): the seal check proved the start walled in: moving the consumer can't help, move the producer first.
  if (search?.sealed !== undefined && !search.sealed.edge && search.sealed.side === "start" && c.from !== undefined) ids.reverse()
  for (const mid of ids) {
    if (job.alias[mid] !== undefined) continue
    const m = findModule(job.layout, mid)
    // A module on a site (a mine on its patch, a steam block on its shore) keeps its place, unless the router proved its
    // own port walled in (B106, 5387208: a new copper mine placed in a pocket of trees and built ground; every attempt
    // put it back there and the plan failed 8 times): then it is placed again away from that spot like any module.
    const provenSealed = search?.sealed !== undefined && !search.sealed.edge && (search.sealed.side === "start" ? c.from?.module : c.to.module) === mid
    if (m === undefined || m.fixed || (m.canonical.site !== undefined && !provenSealed) || (job.replaced[mid] ?? 0) >= 2) continue
    if (job.request.modules.some((r) => r.id === mid && r.at !== undefined)) continue
    for (const rid of [...job.layout.routeOrder]) {
      const r = job.layout.routes[rid]
      if (r === undefined || (r.to.module !== mid && r.from?.module !== mid)) continue
      for (const removed of rerootOrRip(job.layout, rid, mid)) {
        const conn = removed.substring("route:".length)
        if (job.queue.indexOf(conn) < 0) job.queue.push(conn)
      }
    }
    unmarkModule(job.layout, m, facts)
    job.layout.modules = job.layout.modules.filter((x) => x.id !== mid)
    job.replaced[mid] = (job.replaced[mid] ?? 0) + 1
    // New geometry: earlier rip-ups say nothing about loops around the new spot.
    job.ripPairs = undefined
    // B28: only a sealed end needs the wider exclusion. Ordinary congestion keeps the old, tight rectangle: padding
    // every replacement by the route margin pushed a dense comparison plan into failure (seed3333-production-ok).
    const pad = search?.sealed !== undefined ? policy.router.margin : 0
    job.avoid[mid] = [...(job.avoid[mid] ?? []), replacementAvoid(m.rect, pad)]
    job.replaceQueue.push(mid)
    if (planTrace.sink !== undefined) traceEvent(`module ${mid}: taken out to be placed again (connection ${c.id} unroutable; old rect ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h})`)
    if (job.queue.indexOf(c.id) < 0) job.queue.push(c.id)
    job.stats.replacements++
    job.phase = "place"
    return true
  }
  return false
}

/**
 * Takes out route `rid` for module `mid` moving. A trunk whose consumer moves (its source stays) keeps its longest tap
 * that does not touch `mid` (`rerootTap`); otherwise it goes with all its taps (`ripRoute`).
 */
function rerootOrRip(layout: LayoutState, rid: RouteId, mid: string): RouteId[] {
  const r = layout.routes[rid]
  if (r !== undefined && r.from !== undefined && r.from.module !== mid) {
    const at: Record<number, number> = {}
    for (let i = 0; i < r.steps.length; i++) at[tkey(r.steps[i].x, r.steps[i].y)] = i
    let best: RouteId | undefined
    let bestLen = 0
    for (const id of layout.routeOrder) {
      const t = layout.routes[id]
      const s0 = t.steps[0]
      if (t.tapOf !== rid || t.to.module === mid || s0?.kind !== "splitter") continue
      const i = at[tkey(s0.x, s0.y)]
      if (i === undefined || i + t.length <= bestLen) continue
      best = id
      bestLen = i + t.length
    }
    if (best !== undefined) {
      const removed = rerootTap(layout, rid, best)
      if (removed !== undefined) {
        if (planTrace.sink !== undefined) traceEvent(`route ${best}: keeps its belt and ${rid}'s first part (that route's consumer ${mid} moves)`)
        return removed
      }
    }
  }
  return ripRoute(layout, rid)
}

function placeStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  if (job.replaceQueue.length > 0) return replaceStep(job, terrain, facts, policy, budget)
  if (job.placeIdx >= job.order.length) {
    startRouting(job)
    return 0
  }
  if (!job.ordered) {
    job.ordered = true
    if (policy.smelting === "near-ore") job.order = nearOreOrder(job.request, job.order, facts)
  }
  const id = moduleId(job.order[job.placeIdx])
  const mreq = moduleRequest(job, id)
  // M7b: a module generated for one spot goes exactly there, or the plan fails.
  if (mreq.at !== undefined) {
    const m = placeFixed(job.layout, terrain, policy, id, mreq.def, mreq.at, facts)
    if (typeof m === "string") {
      fail(job, `module:${id}`, planFailure("no-position", `no room at its fixed spot: ${m}`))
      job.phase = "failed"
    } else {
      commitPlacement(job.layout, m, facts, policy)
      job.placeIdx++
    }
    return 1
  }
  if (job.placement === undefined) {
    // D52: a second request on the same field completes and shares the already planned 2D mine instead of trying to
    // squeeze another independent strip into its reserved footprint. B23: a built (fixed) mine that is not complete
    // yet counts too; the plan's adoption builds its completion.
    // B33: only a splitter-tap plan can share the mine's one output; a point-to-point request places its own mine on
    // the part of the field no other mine claims.
    const whole = policy.topology === "splitter-tap" && mreq.newSite !== true ? wholePatchCandidate(job.layout, mreq.def) : undefined
    if (whole !== undefined) {
      const r = tryExpand(job.layout, terrain, facts, policy, whole.id, 1)
      if (r.ok) {
        if (planTrace.sink !== undefined) traceEvent(`module ${id}: completes the shared whole-patch mine ${whole.id}`)
        delete (job.wholeFail ?? {})[id]
        job.alias[id] = whole.id
        job.expanded[id] = { module: whole.id, units: 1 }
        job.placeIdx++
        return 1
      }
      // B23: remember why, so the module's failure names the shared mine instead of the misleading new placement.
      job.wholeFail ??= {}
      job.wholeFail[id] = `${whole.id}: ${r.reason ?? "expansion failed"}`
      if (planTrace.sink !== undefined) traceEvent(`module ${id}: shared mine ${job.wholeFail[id]}`)
    }
    // Expand-first: grow a compatible module when there is room.
    if (mreq.expandUnits !== undefined && policy.expansion === "expand-first") {
      const cand = expansionCandidate(job.layout, mreq.def, mreq.expandUnits)
      if (cand !== undefined) {
        const r = tryExpand(job.layout, terrain, facts, policy, cand.id, mreq.expandUnits)
        if (planTrace.sink !== undefined) traceEvent(`module ${id}: expand ${cand.id} by ${mreq.expandUnits}: ${r.ok ? "ok" : r.reason ?? "failed"}`)
        if (r.ok) {
          job.alias[id] = cand.id
          job.expanded[id] = { module: cand.id, units: mreq.expandUnits }
          job.placeIdx++
          return 1
        }
      }
    }
    const targets = targetsFor(job, id)
    // A mining outpost looks for ore nearest the module it feeds.
    let center = job.request.center
    if (mreq.def.site === "resource-patch") for (const [, t] of pairs(targets)) center = { x: (t as Vec).x, y: (t as Vec).y }
    // D35 near-ore: a smelter clusters around its (already placed) ore outpost's port instead of the cluster centre.
    if (policy.smelting === "near-ore" && isSmelter(mreq.def, facts)) {
      for (const c of oreFeeds(job.request, id, facts)) {
        const t = targets[c.to.port]
        if (t !== undefined) center = { x: t.x, y: t.y }
      }
    }
    job.placement = newPlacement({ id, def: mreq.def, targets, center, region: job.request.region, avoid: job.request.avoid, softExempt: partnersOf(job, id), dead: job.request.deadPatches })
  }
  const s = job.placement
  let used = searchPlacement(job, s, terrain, policy, budget)
  if (s.phase === "done") {
    used += wholePatchStep(job, s, terrain, facts, policy, budget - used)
    if (job.wholePatch !== undefined) return used
    delete (job.wholeFail ?? {})[id]
    commitPlacement(job.layout, s.result!, facts, policy)
    job.placement = undefined
    job.placeIdx++
  } else if (s.phase === "failed") {
    // New-module-first policies still try to grow before giving up.
    let grown = false
    if (mreq.expandUnits !== undefined && policy.expansion !== "expand-first") {
      const cand = expansionCandidate(job.layout, mreq.def, mreq.expandUnits)
      if (cand !== undefined && tryExpand(job.layout, terrain, facts, policy, cand.id, mreq.expandUnits).ok) {
        job.alias[id] = cand.id
        job.expanded[id] = { module: cand.id, units: mreq.expandUnits }
        grown = true
      }
    }
    if (!grown) {
      placementEvidence(job, id, s)
      // B23: a request that wanted the shared mine says so in its failure.
      const wf = job.wholeFail?.[id]
      const reason = wf !== undefined ? `${s.reason ?? "placement failed"} (shared mine ${wf})` : (s.reason ?? "placement failed")
      fail(job, `module:${id}`, { kind: s.failure?.kind ?? "other", reason, what: s.failure?.what })
      if (planTrace.sink !== undefined) traceEvent(`module ${id}: ${job.failures[`module:${id}`]}`)
      job.phase = "failed"
    }
    job.placement = undefined
    job.placeIdx++
  }
  return used
}

/** B57: the base's unconnected belt ports whose lane leads `portEscape` steps out, with that way out. */
function openLanes(layout: LayoutState, terrain: TerrainView, need: number): { tag: string; module: string; port: string; path: Vec[] }[] {
  const out: { tag: string; module: string; port: string; path: Vec[] }[] = []
  for (const m of layout.modules) {
    for (const p of m.def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
      const o = portOutside(m, p)
      if (layout.routeOcc[tkey(o.x, o.y)] !== undefined) continue
      const tag = portTag(m.id, p.id)
      const a = portLaneEnd(m, p)
      if (layout.reserved[tkey(a.x, a.y)] !== tag) continue
      const g = layoutLaneGround(layout, terrain, tag)
      const path = laneWayOut(a, g.free, need, g.hop)
      if (path !== undefined) out.push({ tag, module: m.id, port: p.id, path })
    }
  }
  return out
}

/**
 * B57 (seed 555555): a plan must not wall in an unconnected port lane of the base that led out before it (the labs'
 * green-science input, walled in by a red-science plan's modules and routes; every green plan then failed on "no
 * path"). Placement checks its modules (B45), but routes are only known now. When the routed plan seals such a lane,
 * it is planned again, once, from the base with each sealed lane's way out reserved (`lane:<port>`: only routes to that
 * port may use it; undergrounds pass under it). Returns true when it restarts.
 */
function guardLanes(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy): boolean {
  const need = policy.placement.portEscape ?? 0
  if (need <= 0 || job.lanes === undefined || job.laneBase === undefined || job.laneKeep !== undefined) return false
  const sealed: { tag: string; path: Vec[] }[] = []
  for (const lane of job.lanes) {
    const m = findModule(job.layout, lane.module)
    const p = m !== undefined ? findPort(m, lane.port) : undefined
    if (m === undefined || p === undefined) continue
    const end = portLaneEnd(m, p)
    // Fed by this plan: no longer an open lane.
    const o = portOutside(m, p)
    if (job.layout.routeOcc[tkey(o.x, o.y)] !== undefined) continue
    const g = layoutLaneGround(job.layout, terrain, lane.tag)
    if (laneWayOut(end, g.free, need, g.hop) === undefined) sealed.push(lane)
  }
  if (sealed.length === 0) return false
  const stats = job.stats
  const evidence = job.evidence
  const dead = job.deadPatches
  const fresh = newPlanJob(job.request, job.tier, job.laneBase, job.tiers)
  const keep: number[] = []
  for (const lane of sealed) {
    for (const t of lane.path) {
      const k = tkey(t.x, t.y)
      if (reserveFreeTile(fresh.layout, k, laneTag(lane.tag))) keep.push(k)
    }
  }
  if (planTrace.sink !== undefined) traceEvent(`B57: the plan walls in ${sealed.map((l) => l.tag).join(", ")}: planned again with ${keep.length} lane tiles kept clear`)
  job.layout = fresh.layout
  job.phase = "place"
  job.poleJob = undefined
  job.order = fresh.order
  job.ordered = undefined
  job.placeIdx = 0
  job.placement = undefined
  job.wholePatch = undefined
  job.alias = {}
  job.queue = []
  job.ripCount = {}
  job.ripPairs = undefined
  job.current = undefined
  job.pipe = undefined
  job.failures = {}
  job.failed = undefined
  job.expanded = {}
  job.wholeFail = undefined
  job.replaceQueue = []
  job.replaced = fresh.replaced
  job.avoid = {}
  job.compare = undefined
  job.routingFailed = undefined
  job.stats = stats
  job.evidence = evidence
  job.deadPatches = dead
  job.laneKeep = keep
  job.newLaneTried = undefined
  job.newLaneKeep = undefined
  job.evidence ??= []
  job.evidence.push({ kind: "route", subject: sealed.map((l) => l.tag).join(","), reason: "B57: walled in an open port lane; planned again keeping it clear", rip: false, windowScale: 1, expansions: 0 })
  return true
}

/**
 * B85 (soak vps-b83-r5480563, goal g27): a plan must not wall in an unconnected port lane of a module it places itself
 * (lab cluster 3's red assembler output, whose labs come in a later goal: the same plan's copper routes ran up its only
 * way out and under its mouth, and every later route to it found no path). B57 plans again from the base, which can't keep a lane of a module the
 * new plan may put elsewhere. Here the module stays: when its lane no longer leads out but would with this plan's own
 * routes lifted, those routes are ripped, the way out is kept clear (`lane:<port>`), and they are routed again. Once per
 * lane. Returns true when routing continues.
 */
function guardNewLanes(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy): boolean {
  const need = policy.placement.portEscape ?? 0
  if (need <= 0 || job.compareProbe === true) return false
  const layout = job.layout
  const tried = (job.newLaneTried ??= {})
  const ripped: string[] = []
  const tags: string[] = []
  for (const m of layout.modules) {
    if (m.fixed === true) continue
    for (const p of m.def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
      const o = portOutside(m, p)
      if (layout.routeOcc[tkey(o.x, o.y)] !== undefined) continue
      const tag = portTag(m.id, p.id)
      if (tried[tag] === true) continue
      const a = portLaneEnd(m, p)
      const g = layoutLaneGround(layout, terrain, tag)
      if (laneWayOut(a, g.free, need, g.hop) !== undefined) continue
      const margins = layoutMargins(layout)
      // The plan's own (unbuilt) routes lifted: the tiles they hold would be ground again.
      const lifted = (x: number, y: number): boolean => {
        if (g.free(x, y)) return true
        const k = tkey(x, y)
        const r = layout.routeOcc[k]
        if (r === undefined || layout.routes[r]?.fixed === true) return false
        const occ = layout.occ[k]
        if (occ !== undefined && string.sub(occ, 1, 2) === "m:") return false
        const res = layout.reserved[k]
        if (res === tag || res === laneTag(tag)) return true
        return res === undefined && !margins[k]
      }
      tried[tag] = true
      const path = laneWayOut(a, lifted, need, g.hop)
      if (path === undefined) continue
      const victims: RouteId[] = []
      for (const t of path) {
        const r = layout.routeOcc[tkey(t.x, t.y)]
        if (r !== undefined && victims.indexOf(r) < 0) victims.push(r)
      }
      for (const v of victims) {
        for (const removed of ripRoute(layout, v)) {
          const conn = removed.substring("route:".length)
          job.stats.ripups++
          if (ripped.indexOf(conn) < 0) ripped.push(conn)
          if (job.queue.indexOf(conn) < 0) job.queue.push(conn)
        }
      }
      const keep = (job.newLaneKeep ??= [])
      for (const t of path) {
        const k = tkey(t.x, t.y)
        if (layout.routeOcc[k] === undefined && reserveFreeTile(layout, k, laneTag(tag))) keep.push(k)
      }
      tags.push(tag)
    }
  }
  if (ripped.length === 0) return false
  if (planTrace.sink !== undefined) traceEvent(`B85: the plan walls in its own ${tags.join(", ")}: re-routing ${ripped.join(", ")} around the lane`)
  job.evidence ??= []
  job.evidence.push({ kind: "route", subject: tags.join(","), reason: `B85: walled in a new module's open port lane; re-routing ${ripped.join(", ")}`, rip: true, windowScale: 1, expansions: 0 })
  return true
}

function routeStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  if (job.pipe !== undefined) return pipeStep(job, terrain, policy, budget)
  if (job.current === undefined) {
    const used = startConnection(job, terrain, policy, budget)
    // A new belt search runs in the same call; anything else (a pipe, a stub, a failure, the end) is done.
    if (job.current === undefined) return used
  }
  const cur = job.current
  const used = stepSearch(cur.search, job.layout, terrain, policy, budget)
  job.stats.routeWork += used
  job.stats.expansions += used
  const st = cur.search.status
  if (planTrace.searches !== undefined) {
    cur.work = (cur.work ?? 0) + used
    if (st !== "running") {
      planTrace.searches(`belt ${cur.conn} ${st} rip=${cur.rip} win=${cur.winScale ?? 1} work=${math.floor(cur.work)} ${cur.search.reason ?? ""} seal=${cur.search.sealSteps ?? "-"}${cur.search.sealFull === true ? "F" : ""}${cur.search.sealed !== undefined ? `:${cur.search.sealed.side}${cur.search.sealed.edge ? "/edge" : ""}` : ""}${cur.search.widened === true ? " widened" : ""}${cur.search.coarse !== undefined || cur.search.corridor !== undefined ? " corridor" : ""} box=${cur.search.w}x${cur.search.h} merge=${cur.mergeTry ?? 0}/${cur.mergeGoals?.length ?? 0}`)
      cur.work = 0
    }
  }
  if (st === "running") return used
  if (st === "failed") searchFailed(job, terrain, facts, policy, cur)
  else searchFound(job, terrain, facts, policy, cur)
  return used
}

type CurrentRoute = NonNullable<PlanJob["current"]>

/**
 * The next queued connection: its search (`job.current`, stepped by the caller), a pipe search, an external stub, or a
 * recorded failure. With the queue empty, routing ends: the lane guards, then the next phase.
 */
function startConnection(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const id = job.queue.shift()
  if (id === undefined) return endRouting(job, terrain, policy)
  const c = connection(job, id)
  if (c.fluid !== undefined) {
    job.pipe = newPipeJob(job, policy, c)
    if (job.pipe === undefined) return 1
    return pipeStep(job, terrain, policy, budget)
  }
  const via = coveredBy(job, c)
  if (via !== undefined) {
    ;(job.covered ??= {})[id] = via
    if (planTrace.searches !== undefined) planTrace.searches(`belt ${id} covered by ${via}`)
    return 1
  }
  const winScale = job.winMemo?.[id]
  const req = routeRequest(job, c, policy, {}, winScale)
  if (isPlanFailure(req)) {
    fail(job, id, req)
    traceRouteFailure(job.layout, terrain, policy, id, req.reason, job.compareProbe ? "compare" : "plan")
    return 1
  }
  if (c.from === undefined) {
    const stub = externalStub(job, terrain, policy, c, req)
    if (typeof stub === "string") {
      fail(job, id, stub)
      traceRouteFailure(job.layout, terrain, policy, id, stub, job.compareProbe ? "compare" : "plan")
    } else commitRoute(job.layout, stub)
    return 1
  }
  // A connection that last needed rip mode starts in it (g91a2: two belts found only by rip searches at window 3 each
  // failed a ~420k non-rip search there first, every round).
  const rip = job.winMemo?.[id] !== undefined && job.ripMemo?.[id] === true
  job.current = { conn: id, search: newSearch(job.layout, terrain, policy, req, rip), rip, avoid: {}, retries: 0, winScale, mergeGoals: req.mergeGoals, mergeTry: 0 }
  job.stats.searches++
  return 0
}

/**
 * M7 (B, user request in-session 2026-11-03; seed 11 g111): the connection (a merge) of a route from the same source port
 * that already lands at `c`'s port: its join sits on a trunk above `c`'s tap, so `c`'s items arrive without a belt of
 * its own. A heir mine of a retiring coal mine joined its tap tree once for one smelter; each other smelter's merge
 * searched a 200×585 window for its own way into a sealed fuel line.
 */
function coveredBy(job: PlanJob, c: ConnectionRequest): string | undefined {
  if (c.merge !== true || c.from === undefined || c.fluid !== undefined) return undefined
  const to = resolve(job, c.to)
  for (const rid of sameSource(job, resolve(job, c.from), c.id)) {
    const r = job.layout.routes[rid as RouteId]
    if (r !== undefined && !routeDangles(job.layout, rid) && landsDownstream(job.layout, rid, to)) return r.conn
  }
  return undefined
}

/**
 * M7 (B, user request in-session 2026-11-03): scores a merge goal by how many sibling merges (same source, not routed or
 * covered yet) a join there would feed too (`mergeGoals` puts such points first; P44's splitters-first order holds per
 * kind). One heir mine of a retiring coal mine then joins its tap tree above every smelter it replaces, and the others
 * are covered (seed 11 g111: the tree's root ran 27 tiles from the old mine, its first tap 3 tiles in).
 */
function siblingScore(job: PlanJob, c: ConnectionRequest): ((this: void, x: number, y: number) => number) | undefined {
  if (c.merge !== true || c.from === undefined) return undefined
  const from = resolve(job, c.from)
  const ports: PortRef[] = []
  for (const o of job.request.connections) {
    if (o.id === c.id || o.merge !== true || o.from === undefined || job.covered?.[o.id] !== undefined) continue
    if (job.layout.routes[routeId(`route:${o.id}`)] !== undefined) continue
    const f = resolve(job, o.from)
    if (f.module === from.module && f.port === from.port) ports.push(resolve(job, o.to))
  }
  if (ports.length === 0) return undefined
  const layout = job.layout
  return (x, y) => {
    let n = 0
    for (const p of ports) if (pointFeeds(layout, x, y, p)) n++
    return n
  }
}

/** M7 (B): a queued merge connection from the same source as `c` (it may join a trunk above `c`'s port). */
function siblingQueued(job: PlanJob, c: ConnectionRequest): boolean {
  if (c.from === undefined) return false
  const from = resolve(job, c.from)
  for (const id of job.queue) {
    const o = connection(job, id)
    if (o.merge !== true || o.from === undefined) continue
    const f = resolve(job, o.from)
    if (f.module === from.module && f.port === from.port) return true
  }
  return false
}

/** Every connection routed or failed: guard the lanes (B57, B85), then compare, poles, done or failed. */
function endRouting(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy): number {
  // M7 (B): a covering route ripped or re-routed since: its covered connections route again (twice at most each).
  for (const [id] of pairs(job.covered ?? {})) {
    const c = connection(job, id as string)
    if (coveredBy(job, c) !== undefined) continue
    delete job.covered![id as string]
    const n = (job.deferred ??= {})[id as string] ?? 0
    if (n >= 2) {
      fail(job, id as string, "no path (its covering route is gone)")
      continue
    }
    job.deferred[id as string] = n + 1
    job.queue.push(id as string)
  }
  if (job.queue.length > 0) return 1
  let failed = false
  for (const [k] of pairs(job.failures)) if (k !== undefined) failed = true
  // D36: a plan that can't route without undergrounds still tries the same placement with them (the infinite case).
  if (failed) job.phase = job.request.compare?.undergrounds !== undefined && job.routingFailed === undefined ? "compare" : "failed"
  else if (guardLanes(job, terrain, policy)) return 1
  else if (guardNewLanes(job, terrain, policy)) return 1
  else job.phase = job.request.compare !== undefined ? "compare" : job.request.poles !== undefined ? "poles" : "done"
  if (failed) job.routingFailed = true
  return 0
}

/** Searches the current connection again (`rip` mode, `retry` after "no path"), or fails it if its request can't be made. */
function restartRoute(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, cur: CurrentRoute, rip: boolean, retry = false): void {
  const c = connection(job, cur.conn)
  const req = routeRequest(job, c, policy, cur.avoid, cur.winScale)
  if (isPlanFailure(req)) {
    fail(job, cur.conn, req)
    traceRouteFailure(job.layout, terrain, policy, cur.conn, req.reason, job.compareProbe ? "compare" : "plan")
    job.current = undefined
    return
  }
  cur.rip = rip
  cur.search = newSearch(job.layout, terrain, policy, req, rip, retry)
  job.stats.searches++
}

/** Gives up on the current connection with `reason` (traced). */
function failRoute(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, cur: CurrentRoute, reason: string): void {
  fail(job, cur.conn, reason)
  traceRouteFailure(job.layout, terrain, policy, cur.conn, job.failures[cur.conn], job.compareProbe ? "compare" : "plan")
  job.current = undefined
}

/** The current connection's search found no path: other merge goals (B60), a wider window (B28), rip mode, re-placement. */
function searchFailed(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, cur: CurrentRoute): void {
  const c = connection(job, cur.conn)
  routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale)
  // B60: the nearest merge point may be inside the built factory. Try the other free sides of the existing route
  // before the general rip/widen retries (a new coal mine can approach a different part of the same trunk).
  if (cur.mergeGoals !== undefined && (cur.mergeTry ?? 0) + 1 < cur.mergeGoals.length) {
    cur.mergeTry = (cur.mergeTry ?? 0) + 1
    // Seed 11 g111: a search that ran to the end already knows every route from the producer; the next goal reuses it.
    if (!cur.rip && policy.router.mergeReuse === true) {
      applyMergeGoal(cur.search.req, cur.mergeGoals[cur.mergeTry])
      if (retargetSearch(cur.search)) {
        job.stats.searches++
        return
      }
    }
    const req = routeRequest(job, c, policy, cur.avoid, cur.winScale)
    if (!isPlanFailure(req) && req.mergeGoals !== undefined) {
      applyMergeGoal(req, cur.mergeGoals[cur.mergeTry])
      cur.rip = false
      cur.search = newSearch(job.layout, terrain, policy, req, false, true)
      job.stats.searches++
      return
    }
  }
  // B28: the window is endpoints ± margin; dense infrastructure (or a mine's D52 claim) between them can wall
  // the direct band off, while a detour just past it exists. The rip retries come first (they stay cheap), and
  // only after the rip pass fails too does the window widen (×3, then ×9): region retries widen placement, never
  // these route windows. Comparison branches probe cheap: their work is capped against the real plan's.
  // Seal check: an end boxed in well inside the window stays boxed in a wider one (only rip mode can open it).
  const sealedInside = cur.search.sealed !== undefined && !cur.search.sealed.edge
  if (cur.search.reason === "no path" && !job.compareProbe && cur.rip && (cur.winScale ?? 1) < 9 && !sealedInside) {
    cur.winScale = (cur.winScale ?? 1) * 3
    cur.rip = false
    const req = routeRequest(job, c, policy, {}, cur.winScale)
    if (!isPlanFailure(req)) {
      cur.search = newSearch(job.layout, terrain, policy, req, false, true)
      job.stats.searches++
      return
    }
  }
  // M7 (B): every merge goal failed, and a sibling from the same source is still queued: it may join a trunk above this
  // port, which then covers this one. Try that first (once), before rip mode.
  if (!cur.rip && c.merge === true && (job.deferred?.[cur.conn] ?? 0) === 0 && siblingQueued(job, c)) {
    ;(job.deferred ??= {})[cur.conn] = 1
    job.queue.push(cur.conn)
    job.current = undefined
    return
  }
  if (!cur.rip) restartRoute(job, terrain, policy, cur, true, cur.search.reason === "no path")
  else {
    const reason = cur.search.reason ?? "no path"
    // Traced before tryReplace changes the layout; a re-placement only retries the connection.
    const t = traceRouteFailure(job.layout, terrain, policy, cur.conn, reason, job.compareProbe ? "compare" : "plan", cur.search)
    if (!tryReplace(job, c, facts, policy, cur.search)) fail(job, cur.conn, reason)
    else if (t !== undefined) t.reason = `${reason} (a module is placed again, then the connection retried)`
    job.current = undefined
  }
}

/** The current connection's search found a route: checked (self-crossing, B58, rip-up limit), then committed. */
function searchFound(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, cur: CurrentRoute): void {
  const c = connection(job, cur.conn)
  const res = searchResult(cur.search, job.layout, policy)
  if (res.selfCross !== undefined) {
    routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `route crosses itself at ${res.selfCross}`)
    if (cur.retries < 3) {
      cur.retries++
      cur.avoid[res.selfCross] = true
      restartRoute(job, terrain, policy, cur, cur.rip)
    } else {
      fail(job, cur.conn, "route crosses itself")
      traceRouteFailure(job.layout, terrain, policy, cur.conn, "route crosses itself", job.compareProbe ? "compare" : "plan")
      job.current = undefined
    }
    return
  }
  const route = res.route!
  // B58: a splitter tap that would rip up its own trunk is not a valid branch. The tap search saw the old trunk,
  // chose a splitter on it and then used a tile of that trunk, so the trunk was ripped; the tap is committed, the
  // trunk re-routes (without ripping the not-yet-existing tap), and its new underground span can cover the splitter's
  // input. Retry with the old trunk and this tap path avoided; another tap spot on the same trunk is safe.
  const trunk = route.tapOf
  if (trunk !== undefined && res.victims.indexOf(trunk) >= 0) {
    routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, "splitter tap would rip its own route")
    if (cur.retries < 3) {
      cur.retries++
      for (const k of route.tiles) cur.avoid[k] = true
      restartRoute(job, terrain, policy, cur, cur.rip)
    } else failRoute(job, terrain, policy, cur, "splitter tap would rip its own route")
    return
  }
  // Tunnel crossings: every crossed run must still allow its tunnel, and two on one route need 3 steps between them
  // (each rebuilds steps i-2..i+2). Checked before anything changes; a bad one is avoided on a retry.
  const bad = badTunnel(job.layout, res.tunnels ?? [], route.id, cur.search.req.tunnel?.busy)
  if (bad !== undefined) {
    routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `tunnel at ${keyX(bad)},${keyY(bad)} no longer possible`)
    if (cur.retries < 3) {
      cur.retries++
      cur.avoid[bad] = true
      restartRoute(job, terrain, policy, cur, cur.rip)
    } else failRoute(job, terrain, policy, cur, "tunnel crossing not possible")
    return
  }
  for (const v of res.victims) {
    const vr = job.layout.routes[v]
    if (vr === undefined) continue
    const n = job.ripCount[vr.conn] ?? 0
    // A loop moves a module now; if none can move, ripping goes on up to the limit as before.
    if ((policy.router.ripLoop ?? 0) > 0 && n < policy.router.maxRipups && job.ripPairs?.[`${cur.conn}>${vr.conn}`] === true) {
      routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `rip-up loop: ripped ${vr.conn} for this connection before`)
      if (tryReplace(job, c, facts, policy)) {
        job.current = undefined
        return
      }
      continue
    }
    if (n >= policy.router.maxRipups) {
      routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `blocked by ${vr.conn} after ${n} ripups`)
      if (!tryReplace(job, c, facts, policy)) {
        fail(job, cur.conn, `blocked by ${vr.conn} (ripped ${n} times already)`)
        traceRouteFailure(job.layout, terrain, policy, cur.conn, job.failures[cur.conn], job.compareProbe ? "compare" : "plan")
      }
      job.current = undefined
      return
    }
  }
  for (const v of res.victims) {
    const vr = job.layout.routes[v]
    if (vr !== undefined) (job.ripPairs ??= {})[`${cur.conn}>${vr.conn}`] = true
  }
  if (planTrace.searches !== undefined && res.victims.length > 0) planTrace.searches(`  rips ${res.victims.join(" ")}`)
  for (const v of res.victims) {
    for (const removed of ripRoute(job.layout, routeId(v))) {
      const conn = removed.substring("route:".length)
      job.ripCount[conn] = (job.ripCount[conn] ?? 0) + 1
      job.stats.ripups++
      if (job.queue.indexOf(conn) < 0) job.queue.push(conn)
    }
  }
  // The crossed runs become underground pairs, freeing the tiles this route takes (a ripped run needs none).
  for (const t of res.tunnels ?? []) {
    const on = job.layout.routeOcc[tkey(t.x, t.y)]
    if (on !== undefined && tunnelRoute(job.layout, t.x, t.y, t.dir, route.id, cur.search.req.tunnel?.busy) === undefined) {
      fail(job, cur.conn, `tunnel at ${t.x},${t.y} failed after its check`)
      job.current = undefined
      return
    }
  }
  if ((res.tunnels?.length ?? 0) > 0) job.stats.tunnels = (job.stats.tunnels ?? 0) + res.tunnels!.length
  commitRoute(job.layout, route)
  if ((cur.winScale ?? 1) > 1 && !job.compareProbe) {
    ;(job.winMemo ??= {})[cur.conn] = cur.winScale!
    ;(job.ripMemo ??= {})[cur.conn] = cur.rip
  }
  job.current = undefined
}

/** The first tunnel of `tunnels` that cannot be made (see `searchFound`), as a tile key; undefined when all can. */
function badTunnel(layout: LayoutState, tunnels: { x: number; y: number; dir: number }[], self: string, busy?: Record<string, boolean>): number | undefined {
  const seen: Record<string, number[]> = {}
  for (const t of tunnels) {
    const site = tunnelSite(layout, t.x, t.y, t.dir, self, busy)
    if (site === undefined) return tkey(t.x, t.y)
    const list = (seen[site.route] ??= [])
    for (const i of list) if (math.abs(i - site.i) < 3) return tkey(t.x, t.y)
    list.push(site.i)
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// D36 / B2 comparison: the same placement routed again with undergrounds, or with splitter taps instead of one
// producer per consumer. Bounded: each alternative is a routing-only job on a copy of the layout (no placement, which is
// ~90% of a plan's work), capped at `workFactor` × the plan's routing work. A capped or failed alternative is no
// evidence (the strategy then keeps the plan).

/** Total length of the routes a plan added (belts + underground ends, + 1 per splitter tap). */
export function newRouteLength(layout: LayoutState, baseRoutes: Record<string, boolean>): number {
  let n = 0
  for (const id of layout.routeOrder) {
    if (baseRoutes[id]) continue
    const r = layout.routes[id]
    n += r.length + (r.tapOf !== undefined ? 1 : 0)
  }
  return n
}

/** A copy of the plan's layout without the routes it added (the alternative routes them again). */
function unroutedCopy(job: PlanJob): LayoutState {
  const l = cloneLayout(job.layout)
  for (const id of [...l.routeOrder]) if (!job.baseRoutes[id] && l.routes[id] !== undefined) ripRoute(l, id)
  return l
}

function portItem(job: PlanJob, ref: PortRef): string | undefined {
  const m = findModule(job.layout, resolve(job, ref).module)
  return m !== undefined ? findPort(m, ref.port)?.item : undefined
}

/** D57 (c): the patches a placement found no room on, for the strategy to remember. */
function keepDeadPatches(job: PlanJob, s: PlacementSearch): void {
  for (const [k, v] of pairs(s.deadFound ?? {})) {
    job.deadPatches ??= {}
    job.deadPatches[k as string] = v as string
  }
}

/** A routing-only job over `layout` for `request` (aliases of expanded requests carried over). */
function altJob(job: PlanJob, request: PlanRequest, tier: BeltTier, tiers: BeltTier[] | undefined, layout: LayoutState): PlanJob {
  // Not `{ ...request, compare: undefined }`: TSTL drops undefined fields from object literals, so the spread keeps them.
  const r: PlanRequest = { ...request }
  r.compare = undefined
  r.poles = undefined
  const alt = newRoutingJob(r, tier, layout)
  alt.tiers = tiers
  // B28: comparison branches stay cheap: the loop-capped branches measure work against each other, so the widened
  // no-path retries (a real plan's last resort) are off here and the branches fail fast like before.
  alt.compareProbe = true
  for (const [k, v] of pairs(job.alias)) alt.alias[k as string] = v as string
  alt.baseRoutes = job.baseRoutes
  return alt
}

/**
 * Splitter alternative: per candidate item, the new producers feeding this plan's consumers of it are merged into the
 * one nearest to all those consumers; the others and everything that only feeds them (their supply chain) are dropped,
 * and their consumers are fed from the kept producer through splitter taps. Undefined when no item has two producers.
 */
interface SplitterAlt {
  request: PlanRequest
  layout: LayoutState
  merged: Record<string, string[]>
  dropped: string[]
}

function splitterAlt(job: PlanJob, items: string[], facts: ProtoFacts): SplitterAlt | undefined {
  const req = job.request
  const isNew = (id: string): boolean => job.alias[id] === undefined && !job.baseModules[id] && findModule(job.layout, id) !== undefined
  const groups: Record<string, ConnectionRequest[]> = {}
  const order: string[] = []
  for (const c of req.connections) {
    if (c.from === undefined || !isNew(c.from.module)) continue
    const item = portItem(job, c.to)
    if (item === undefined || items.indexOf(item) < 0) continue
    if (groups[item] === undefined) {
      groups[item] = []
      order.push(item)
    }
    groups[item].push(c)
  }
  const dropped: Record<string, boolean> = {}
  const rewire: Record<string, PortRef> = {}
  const merged: Record<string, string[]> = {}
  for (const item of order) {
    const g = groups[item]
    const producers: string[] = []
    for (const c of g) if (producers.indexOf(c.from!.module) < 0) producers.push(c.from!.module)
    if (producers.length < 2) continue
    // Keep the producer whose out port is nearest to all the group's consumers (first in request order on ties).
    let keep: ConnectionRequest | undefined
    let best = math.huge
    for (const c of g) {
      const pm = findModule(job.layout, c.from!.module)!
      const o = portOutside(pm, findPort(pm, c.from!.port)!)
      let d = 0
      for (const other of g) {
        const cm = findModule(job.layout, resolve(job, other.to).module)!
        const ct = portTile(cm, findPort(cm, other.to.port)!)
        d += math.abs(o.x - ct.x) + math.abs(o.y - ct.y)
      }
      if (d < best) {
        best = d
        keep = c
      }
    }
    merged[item] = []
    for (const c of g) {
      merged[item].push(c.to.module)
      if (c.from!.module === keep!.from!.module) continue
      dropped[c.from!.module] = true
      rewire[c.id] = keep!.from!
    }
  }
  if (order.filter((i) => merged[i] !== undefined).length === 0) return undefined
  // Supply chains of dropped producers: new modules all of whose consumers are dropped.
  for (let changed = true; changed; ) {
    changed = false
    for (const m of req.modules) {
      if (dropped[m.id] || !isNew(m.id)) continue
      let outs = 0
      let toDropped = 0
      for (const c of req.connections) {
        if (c.from?.module !== m.id) continue
        outs++
        if (dropped[c.to.module]) toDropped++
      }
      if (outs > 0 && outs === toDropped) {
        dropped[m.id] = true
        changed = true
      }
    }
  }
  const connections: ConnectionRequest[] = []
  for (const c of req.connections) {
    if (dropped[c.to.module]) continue
    if (rewire[c.id] !== undefined) connections.push({ ...c, from: rewire[c.id] })
    else if (c.from === undefined || !dropped[c.from.module]) connections.push(c)
  }
  const layout = unroutedCopy(job)
  const droppedIds: string[] = []
  for (const m of req.modules) {
    if (!dropped[m.id]) continue
    droppedIds.push(m.id)
    const pm = findModule(layout, m.id)
    if (pm !== undefined) {
      unmarkModule(layout, pm, facts)
      layout.modules = layout.modules.filter((x) => x.id !== m.id)
    }
  }
  return { request: { ...req, modules: req.modules.filter((m) => !dropped[m.id]), connections }, layout, merged, dropped: droppedIds }
}

function compareStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  const opts = job.request.compare!
  if (job.compare === undefined) {
    const queue: CompareResult["kind"][] = []
    if (opts.undergrounds !== undefined) queue.push("undergrounds")
    if (opts.splitters !== undefined && opts.splitters.items.length > 0 && job.routingFailed !== true) queue.push("splitters")
    job.compare = { queue, results: [] }
  }
  const cmp = job.compare
  if (cmp.current === undefined) {
    const kind = cmp.queue.shift()
    if (kind === undefined) {
      job.phase = job.routingFailed === true ? "failed" : job.request.poles !== undefined ? "poles" : "done"
      return 0
    }
    const base = newRouteLength(job.layout, job.baseRoutes)
    const cap = math.max(opts.minWork, opts.workFactor * job.stats.routeWork)
    if (kind === "undergrounds") {
      const tiers = opts.undergrounds!.tiers
      const tier = tierByBelt(tiers, job.tier.belt) ?? tiers[0]
      cmp.current = { kind, job: altJob(job, job.request, tier, tiers, unroutedCopy(job)), cap, base }
    } else {
      const s = splitterAlt(job, opts.splitters!.items, facts)
      if (s === undefined) {
        cmp.results.push({ kind, status: "none", base, work: 0, reason: "no item has two producers in this plan" })
        return 1
      }
      cmp.current = { kind, job: altJob(job, s.request, job.tier, job.tiers, s.layout), cap, base, merged: s.merged, dropped: s.dropped }
    }
    return 1
  }
  const cur = cmp.current
  const altPolicy: LayoutPolicy = cur.kind === "splitters" ? { ...policy, topology: "splitter-tap" } : policy
  const e0 = cur.job.stats.expansions
  const w0 = cur.job.stats.work
  stepPlan(cur.job, terrain, facts, altPolicy, budget)
  const used = cur.job.stats.work - w0
  job.stats.expansions += cur.job.stats.expansions - e0
  job.stats.compareWork = (job.stats.compareWork ?? 0) + used
  const done = cur.job.phase === "done" || cur.job.phase === "failed"
  if (!done && cur.job.stats.work < cur.cap) return used
  const r: CompareResult = { kind: cur.kind, status: "capped", base: cur.base, work: cur.job.stats.work, merged: cur.merged, dropped: cur.dropped }
  if (cur.job.phase === "done") {
    r.status = "done"
    r.alt = newRouteLength(cur.job.layout, job.baseRoutes)
    r.saving = r.base - r.alt
    if (job.routingFailed === true) {
      r.baseFailed = true
      r.saving = math.huge
    }
  } else if (cur.job.phase === "failed") {
    r.status = "failed"
    const why: string[] = []
    for (const [k, v] of pairs(cur.job.failures)) why.push(`${k as string}: ${v as string}`)
    r.reason = why.join("; ")
  } else r.reason = `capped at ${cur.cap} work units (${cur.job.phase}, ${cur.job.stats.work})`
  cmp.results.push(r)
  cmp.current = undefined
  return used
}

export interface LogisticsDecision {
  /** Research the technology first (and plan again afterwards). */
  undergrounds: boolean
  splitters: boolean
  /** Splitters: per item, the consumer modules one producer feeds through taps (request ids). */
  taps: Record<string, string[]>
  /** One line per alternative, for logs and telemetry. */
  why: string[]
}

/**
 * D36 / B2: research what unlocks undergrounds (splitters) before building this plan when the alternative is at least
 * `minUnderground` (`minSplitter`) tiles shorter. 0 turns a rule off. Capped, failed or missing alternatives are no
 * evidence (keep the plan).
 */
export function logisticsFirst(results: CompareResult[], minUnderground: number, minSplitter: number): LogisticsDecision {
  const d: LogisticsDecision = { undergrounds: false, splitters: false, taps: {}, why: [] }
  for (const r of results) {
    const min = r.kind === "undergrounds" ? minUnderground : minSplitter
    const hit = r.status === "done" && min > 0 && r.saving !== undefined && r.saving >= min
    const done = r.baseFailed === true ? ` (no plan without them) → ${r.alt} tiles` : ` ${r.base} → ${r.alt} tiles (saves ${r.saving}, threshold ${min})`
    d.why.push(`${r.kind}: ${r.status}${r.status === "done" ? done : r.reason !== undefined ? ` (${r.reason})` : ""}, work ${math.floor(r.work)}${hit ? ": research first" : ""}`)
    if (!hit) continue
    if (r.kind === "undergrounds") d.undergrounds = true
    else {
      d.splitters = true
      for (const [item, consumers] of pairs(r.merged ?? {})) d.taps[item as string] = [...(consumers as string[])]
    }
  }
  return d
}

/** The pole network phase: joins every consumer module to a generator module. Unreachable modules are failures. */
function poleStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  job.poleJob ??= newPoleJob(`poles:${job.stats.steps}:`, job.request.poles!, facts)
  const before = job.poleJob.work
  if (stepPoles(job.poleJob, job.layout, terrain, facts, policy, budget)) {
    let failed = false
    for (const [owner, why] of pairs(job.poleJob.failures)) {
      fail(job, `power:${owner}`, why as string)
      failed = true
    }
    job.phase = failed ? "failed" : "done"
  }
  return job.poleJob.work - before
}

/** Advances the job by about `budget` work units. Returns true when it has finished (done or failed). */
export function stepPlan(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): boolean {
  let used = 0
  // B57: the base's open lanes, before the plan changes anything (comparison branches route on a copy: not theirs).
  if (job.lanes === undefined && job.phase === "place" && job.placeIdx === 0 && job.compareProbe !== true) {
    const need = policy.placement.portEscape ?? 0
    job.lanes = need > 0 && job.layout.modules.length > 0 ? openLanes(job.layout, terrain, need) : []
    if (job.lanes.length > 0) job.laneBase = cloneLayout(job.layout)
    used += job.lanes.length
  }
  while (used < budget && (job.phase === "place" || job.phase === "route" || job.phase === "compare" || job.phase === "poles")) {
    const before = used
    if (job.phase === "place") used += placeStep(job, terrain, facts, policy, budget - used)
    else if (job.phase === "route") used += routeStep(job, terrain, facts, policy, budget - used)
    else if (job.phase === "compare") used += compareStep(job, terrain, facts, policy, budget - used)
    else used += poleStep(job, terrain, facts, policy, budget - used)
    if (used === before) used += 0.01
  }
  job.stats.steps++
  job.stats.work += used
  job.stats.maxStepWork = math.max(job.stats.maxStepWork, used)
  const finished = job.phase === "done" || job.phase === "failed"
  if (finished && job.laneBase !== undefined) {
    // B57: the lane reservations only bind this plan; the base copy is no longer needed.
    for (const k of job.laneKeep ?? []) releaseLaneReservation(job.layout, k)
    job.laneBase = undefined
  }
  if (finished && job.newLaneKeep !== undefined) {
    for (const k of job.newLaneKeep) releaseLaneReservation(job.layout, k)
    job.newLaneKeep = undefined
  }
  return finished
}

/** Runs a plan to completion (tests, tools). */
export function planNow(request: PlanRequest, tier: BeltTier, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget = 1000): PlanJob {
  const job = newPlanJob(request, tier)
  while (!stepPlan(job, terrain, facts, policy, budget)) {
    // budgeted steps, as at runtime
  }
  return job
}

/**
 * A job that only routes: the modules are already in `layout` (placed earlier or by hand). `queue` limits which
 * connections are routed now (default: all, shortest first); the others may still be ripped up and rerouted.
 */
export function newRoutingJob(request: PlanRequest, tier: BeltTier, layout: LayoutState, queue?: string[]): PlanJob {
  const job = newPlanJob(request, tier)
  job.layout = layout
  job.placeIdx = job.order.length
  // Modules that already exist never move.
  for (const m of layout.modules) job.replaced[m.id] = math.huge
  startRouting(job)
  if (queue !== undefined) job.queue = [...queue]
  return job
}

export function runJob(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget = 1000): PlanJob {
  while (!stepPlan(job, terrain, facts, policy, budget)) {
    // budgeted steps, as at runtime
  }
  return job
}
