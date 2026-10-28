// Layout planning job (SPEC §5.3): place a set of module instances on the terrain, then route their single-item belt
// connections (D23), with rip-up-and-reroute when routes block each other. A resumable state machine (§5.6): each
// `stepPlan` call does at most `budget` work units (a placement candidate or an A* expansion is one unit; a summed-area
// table tile is 1/2), so the runtime spreads it over ticks. The job is plain data and lives in `storage`; the policy
// is looked up by id each step. Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import { BeltTier, tierByBelt } from "./capacity"
import { releaseLaneReservation, reserveFreeTile } from "./claims"
import { dirIndex, manhattan, Rect, TerrainView, tkey, Vec } from "./grid"
import { mergeGoals } from "./merge"
import type { MergeGoal } from "./merge"
import { commitRoute, fillSoftUnits, findModule, findPort, LayoutState, layoutRevision, newLayout, portApproach, portOutside, PortRef, portTag, portTile, ripRoute, Route, routeDangles, unmarkModule } from "./layout"
import { commitPlacement, expansionCandidate, laneTag, laneWayOut, layoutLaneGround, newPlacement, placementFailureCertificate, PlacementSearch, prepareWholePatchPlacement, stepPlacement, tryExpand, wholePatchCandidate } from "./placement"
import { LayoutPolicy } from "./policy"
import { newPoleJob, PoleJob, stepPoles } from "./power"
import { newSearch, RouteRequest, Search, searchResult, stepSearch, tileCost } from "./router"
import { planTrace, traceEvent, traceRouteFailure } from "./trace"
import { ModuleDef } from "../modules/types"
import { moduleId, routeId } from "../shared/ids"
import type { ConnectionId } from "../shared/ids"

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
}

export interface PlanRequest {
  modules: ModuleRequest[]
  connections: ConnectionRequest[]
  /** Existing production: placement clusters around it. */
  center: Vec
  /** The scanned region the layout must stay in. */
  region: Rect
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
  /** Request id → placed module id (an expanded module answers for the request). */
  alias: Record<string, string>
  /** D57 (c): patches this plan's mines found no room on (the strategy remembers them for later plans). */
  deadPatches?: Record<string, string>
  queue: string[]
  ripCount: Record<string, number>
  current?: { conn: string; search: Search; rip: boolean; avoid: Record<number, boolean>; retries: number; winScale?: number; mergeGoals?: NonNullable<RouteRequest["mergeGoals"]>; mergeTry?: number }
  failures: Record<string, string>
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
  // after every plain connection: it ends on another route's belt, which must be routed first.
  conns.sort((a, b) => {
    const ma = a.merge === true ? 1 : 0
    const mb = b.merge === true ? 1 : 0
    if (ma !== mb) return ma - mb
    const la = len(a)
    const lb = len(b)
    if (la !== lb) return la - lb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  job.queue = conns.map((c) => c.id)
  job.phase = "route"
}

function connection(job: PlanJob, id: string): ConnectionRequest {
  for (const c of job.request.connections) if (c.id === id) return c
  error(`unknown connection ${id}`)
}

/** Routes already serving the same producer port (splitter taps branch off them). B23: compared against the
 * alias-resolved source — a request aliased onto a whole-patch base mine feeds from the base route's port. */
function sameSource(job: PlanJob, from: PortRef): string[] {
  const out: string[] = []
  for (const id of job.layout.routeOrder) {
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
    if (r !== undefined && r.conn !== conn && r.external !== true && r.to.module === to.module && r.to.port === to.port && !routeDangles(layout, rid)) return true
  }
  return false
}

function routeRequest(job: PlanJob, c: ConnectionRequest, policy: LayoutPolicy, avoid: Record<number, boolean>, winScale?: number): RouteRequest | string {
  const to = resolve(job, c.to)
  const tm = findModule(job.layout, to.module)
  const tp = tm ? findPort(tm, to.port) : undefined
  if (!tm || !tp || tp.kind !== "belt-in") return `no belt-in port ${to.module}.${to.port}`
  const goalTile = portTile(tm, tp)
  const own: Record<string, boolean> = { [portTag(tm.id, tp.id)]: true, [laneTag(portTag(tm.id, tp.id))]: true }
  const req: RouteRequest = {
    id: `route:${c.id}`,
    conn: c.id,
    item: tp.item ?? "",
    to,
    goal: { x: goalTile.x, y: goalTile.y, dir: dirIndex(tp.dir), side: tp.side },
    tier: (c.belt !== undefined && job.tiers !== undefined ? tierByBelt(job.tiers, c.belt) : undefined) ?? job.tier,
    own,
    avoid,
    windowMargin: winScale,
  }
  if (c.from !== undefined) {
    const from = resolve(job, c.from)
    const fm = findModule(job.layout, from.module)
    const fp = fm ? findPort(fm, from.port) : undefined
    if (!fm || !fp || fp.kind !== "belt-out") return `no belt-out port ${from.module}.${from.port}`
    if (fp.item !== undefined && tp.item !== undefined && fp.item !== tp.item) return `item mismatch ${fp.item} → ${tp.item}`
    req.from = from
    own[portTag(fm.id, fp.id)] = true
    own[laneTag(portTag(fm.id, fp.id))] = true
    const taps = sameSource(job, from)
    if (taps.length > 0) {
      if (policy.topology !== "splitter-tap") return `port ${from.module}.${from.port} already feeds a route (point-to-point topology; use splitter-tap)`
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
    const goals = mergeGoals(job.layout, to, c.from)
    if (goals.length === 0) return `no merge target for ${to.module}.${to.port}`
    req.mergeGoals = goals
    applyMergeGoal(req, goals[0])
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

function replaceStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  const id = moduleId(job.replaceQueue[0])
  if (job.placement === undefined) {
    const mreq = moduleRequest(job, id)
    job.placement = newPlacement({ id, def: mreq.def, targets: targetsFor(job, id), center: job.request.center, region: job.request.region, avoid: [...(job.avoid[id] ?? []), ...(job.request.avoid ?? [])], softExempt: partnersOf(job, id), dead: job.request.deadPatches })
  }
  const s = job.placement
  const c0 = s.candidates ?? 0
  const used = stepPlacement(s, job.layout, terrain, policy, budget)
  keepDeadPatches(job, s)
  job.stats.placeWork += used
  job.stats.candidates = (job.stats.candidates ?? 0) + (s.candidates ?? 0) - c0
  if (s.phase === "done" || s.phase === "failed") {
    if (s.phase === "done") {
      prepareWholePatchPlacement(s.result!, terrain, facts, s.req.region, policy, job.layout)
      commitPlacement(job.layout, s.result!, facts, policy)
    }
    else {
      placementEvidence(job, id, s)
      job.failures[`module:${id}`] = `re-placement: ${s.reason ?? "failed"}`
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
    if (m === undefined || m.fixed || m.canonical.site !== undefined || (job.replaced[mid] ?? 0) >= 2) continue
    for (const rid of [...job.layout.routeOrder]) {
      const r = job.layout.routes[rid]
      if (r === undefined || (r.to.module !== mid && r.from?.module !== mid)) continue
      for (const removed of ripRoute(job.layout, rid)) {
        const conn = removed.substring("route:".length)
        if (job.queue.indexOf(conn) < 0) job.queue.push(conn)
      }
    }
    unmarkModule(job.layout, m, facts)
    job.layout.modules = job.layout.modules.filter((x) => x.id !== mid)
    job.replaced[mid] = (job.replaced[mid] ?? 0) + 1
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
  const c0 = s.candidates ?? 0
  const used = stepPlacement(s, job.layout, terrain, policy, budget)
  keepDeadPatches(job, s)
  job.stats.placeWork += used
  job.stats.candidates = (job.stats.candidates ?? 0) + (s.candidates ?? 0) - c0
  if (s.phase === "done") {
    delete (job.wholeFail ?? {})[id]
    prepareWholePatchPlacement(s.result!, terrain, facts, s.req.region, policy, job.layout)
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
      job.failures[`module:${id}`] = wf !== undefined ? `${s.reason ?? "placement failed"} (shared mine ${wf})` : (s.reason ?? "placement failed")
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
      const a = portApproach(m, p)
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
    // The path runs from its far end back to the lane end.
    const end = lane.path[lane.path.length - 1]
    const m = findModule(job.layout, lane.module)
    const p = m !== undefined ? findPort(m, lane.port) : undefined
    if (m === undefined || p === undefined) continue
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
  job.alias = {}
  job.queue = []
  job.ripCount = {}
  job.current = undefined
  job.failures = {}
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
  job.evidence ??= []
  job.evidence.push({ kind: "route", subject: sealed.map((l) => l.tag).join(","), reason: "B57: walled in an open port lane; planned again keeping it clear", rip: false, windowScale: 1, expansions: 0 })
  return true
}

function routeStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  if (job.current === undefined) {
    const id = job.queue.shift()
    if (id === undefined) {
      let failed = false
      for (const [k] of pairs(job.failures)) if (k !== undefined) failed = true
      // D36: a plan that can't route without undergrounds still tries the same placement with them (the infinite case).
      if (failed) job.phase = job.request.compare?.undergrounds !== undefined && job.routingFailed === undefined ? "compare" : "failed"
      else if (guardLanes(job, terrain, policy)) return 1
      else job.phase = job.request.compare !== undefined ? "compare" : job.request.poles !== undefined ? "poles" : "done"
      if (failed) job.routingFailed = true
      return 0
    }
    const c = connection(job, id)
    const req = routeRequest(job, c, policy, {})
    if (typeof req === "string") {
      job.failures[id] = req
      traceRouteFailure(job.layout, terrain, policy, id, req, job.compareProbe ? "compare" : "plan")
      return 1
    }
    if (c.from === undefined) {
      const stub = externalStub(job, terrain, policy, c, req)
      if (typeof stub === "string") {
        job.failures[id] = stub
        traceRouteFailure(job.layout, terrain, policy, id, stub, job.compareProbe ? "compare" : "plan")
      } else commitRoute(job.layout, stub)
      return 1
    }
    job.current = { conn: id, search: newSearch(job.layout, terrain, policy, req, false), rip: false, avoid: {}, retries: 0, mergeGoals: req.mergeGoals, mergeTry: 0 }
    job.stats.searches++
  }
  const cur = job.current
  const used = stepSearch(cur.search, job.layout, terrain, policy, budget)
  job.stats.routeWork += used
  job.stats.expansions += used
  const st = cur.search.status
  if (st === "running") return used
  const c = connection(job, cur.conn)
  const restart = (rip: boolean, retry = false): void => {
    const req = routeRequest(job, c, policy, cur.avoid, cur.winScale)
    if (typeof req === "string") {
      job.failures[cur.conn] = req
      traceRouteFailure(job.layout, terrain, policy, cur.conn, req, job.compareProbe ? "compare" : "plan")
      job.current = undefined
      return
    }
    cur.rip = rip
    cur.search = newSearch(job.layout, terrain, policy, req, rip, retry)
    job.stats.searches++
  }
  if (st === "failed") {
    routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale)
    // B60: the nearest merge point may be inside the built factory. Try the other free sides of the existing route
    // before the general rip/widen retries (a new coal mine can approach a different part of the same trunk).
    if (cur.mergeGoals !== undefined && (cur.mergeTry ?? 0) + 1 < cur.mergeGoals.length) {
      cur.mergeTry = (cur.mergeTry ?? 0) + 1
      const req = routeRequest(job, c, policy, cur.avoid, cur.winScale)
      if (typeof req !== "string" && req.mergeGoals !== undefined) {
        applyMergeGoal(req, cur.mergeGoals[cur.mergeTry])
        cur.rip = false
        cur.search = newSearch(job.layout, terrain, policy, req, false, true)
        job.stats.searches++
        return used
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
      if (typeof req !== "string") {
        cur.search = newSearch(job.layout, terrain, policy, req, false, true)
        job.stats.searches++
        return used
      }
    }
    if (!cur.rip) restart(true, cur.search.reason === "no path")
    else {
      const reason = cur.search.reason ?? "no path"
      // Traced before tryReplace changes the layout; a re-placement only retries the connection.
      const t = traceRouteFailure(job.layout, terrain, policy, cur.conn, reason, job.compareProbe ? "compare" : "plan", cur.search)
      if (!tryReplace(job, c, facts, policy, cur.search)) job.failures[cur.conn] = reason
      else if (t !== undefined) t.reason = `${reason} (a module is placed again, then the connection retried)`
      job.current = undefined
    }
    return used
  }
  const res = searchResult(cur.search, job.layout, policy)
  if (res.selfCross !== undefined) {
    routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `route crosses itself at ${res.selfCross}`)
    if (cur.retries < 3) {
      cur.retries++
      cur.avoid[res.selfCross] = true
      restart(cur.rip)
    } else {
      job.failures[cur.conn] = "route crosses itself"
      traceRouteFailure(job.layout, terrain, policy, cur.conn, "route crosses itself", job.compareProbe ? "compare" : "plan")
      job.current = undefined
    }
    return used
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
      restart(cur.rip)
    } else {
      job.failures[cur.conn] = "splitter tap would rip its own route"
      traceRouteFailure(job.layout, terrain, policy, cur.conn, job.failures[cur.conn], job.compareProbe ? "compare" : "plan")
      job.current = undefined
    }
    return used
  }
  for (const v of res.victims) {
    const vr = job.layout.routes[v]
    if (vr === undefined) continue
    const n = job.ripCount[vr.conn] ?? 0
    if (n >= policy.router.maxRipups) {
      routeEvidence(job, cur.conn, cur.search, cur.rip, cur.winScale, `blocked by ${vr.conn} after ${n} ripups`)
      if (!tryReplace(job, c, facts, policy)) {
        job.failures[cur.conn] = `blocked by ${vr.conn} (ripped ${n} times already)`
        traceRouteFailure(job.layout, terrain, policy, cur.conn, job.failures[cur.conn], job.compareProbe ? "compare" : "plan")
      }
      job.current = undefined
      return used
    }
  }
  for (const v of res.victims) {
    for (const removed of ripRoute(job.layout, routeId(v))) {
      const conn = removed.substring("route:".length)
      job.ripCount[conn] = (job.ripCount[conn] ?? 0) + 1
      job.stats.ripups++
      if (job.queue.indexOf(conn) < 0) job.queue.push(conn)
    }
  }
  commitRoute(job.layout, route)
  job.current = undefined
  return used
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
      job.failures[`power:${owner}`] = why as string
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
