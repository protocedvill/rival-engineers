// Layout planning job (SPEC §5.3): place a set of module instances on the terrain, then route their single-item belt
// connections (D23), with rip-up-and-reroute when routes block each other. A resumable state machine (§5.6): each
// `stepPlan` call does at most `budget` work units (a placement candidate or an A* expansion is one unit; a summed-area
// table tile is 1/2), so the runtime spreads it over ticks. The job is plain data and lives in `storage`; the policy
// is looked up by id each step. Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import { BeltTier } from "./capacity"
import { dirIndex, manhattan, Rect, TerrainView, tkey, Vec } from "./grid"
import { commitRoute, findModule, findPort, LayoutState, newLayout, portOutside, PortRef, portTag, portTile, ripRoute, Route, unmarkModule } from "./layout"
import { commitPlacement, expansionCandidate, newPlacement, PlacementSearch, stepPlacement, tryExpand } from "./placement"
import { LayoutPolicy } from "./policy"
import { newSearch, RouteRequest, Search, searchResult, stepSearch, tileCost } from "./router"
import { ModuleDef } from "../modules/types"

export interface ModuleRequest {
  id: string
  /** Canonical module. */
  def: ModuleDef
  /**
   * With an expand-first policy: satisfy this request by growing a compatible placed module (same generator, recipe
   * and resource) by this many units, if there is room, instead of placing a new one.
   */
  expandUnits?: number
}

export interface ConnectionRequest {
  id: string
  /** Producer (a belt-out port). Absent: the input is fed from outside the layout (a one-tile stub is planned). */
  from?: PortRef
  /** Consumer (a belt-in port). */
  to: PortRef
  /** Planned rate (items/s); default: what the ports' rates allow. */
  rate?: number
}

export interface PlanRequest {
  modules: ModuleRequest[]
  connections: ConnectionRequest[]
  /** Existing production: placement clusters around it. */
  center: Vec
  /** The scanned region the layout must stay in. */
  region: Rect
}

export interface PlanStats {
  /** Calls to stepPlan (ticks, at runtime). */
  steps: number
  work: number
  placeWork: number
  routeWork: number
  expansions: number
  searches: number
  ripups: number
  /** Modules taken out and placed again because a connection could not be routed. */
  replacements: number
  maxStepWork: number
}

export interface PlanJob {
  request: PlanRequest
  tier: BeltTier
  layout: LayoutState
  phase: "place" | "route" | "done" | "failed"
  order: string[]
  placeIdx: number
  placement?: PlacementSearch
  /** Request id → placed module id (an expanded module answers for the request). */
  alias: Record<string, string>
  queue: string[]
  ripCount: Record<string, number>
  current?: { conn: string; search: Search; rip: boolean; avoid: Record<number, boolean>; retries: number }
  failures: Record<string, string>
  /** Expansions done instead of placements: request id → module id and the ports that moved. */
  expanded: Record<string, { module: string; units: number }>
  /** Modules taken out after a connection could not be routed, to be placed again elsewhere (then routing resumes). */
  replaceQueue: string[]
  replaced: Record<string, number>
  /** Old footprints a re-placed module must avoid. */
  avoid: Record<string, Rect[]>
  stats: PlanStats
}

function connectionsOf(req: PlanRequest, id: string): ConnectionRequest[] {
  return req.connections.filter((c) => c.from?.module === id || c.to.module === id)
}

/** Site modules first, then repeatedly the one with the most connections to modules already ordered. */
function placementOrder(req: PlanRequest): string[] {
  const order: string[] = []
  const done: Record<string, boolean> = {}
  for (const m of req.modules) {
    if (m.def.site !== undefined) {
      order.push(m.id)
      done[m.id] = true
    }
  }
  for (;;) {
    let best: string | undefined
    let bestLinks = -1
    for (const m of req.modules) {
      if (done[m.id]) continue
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

export function newPlanJob(request: PlanRequest, tier: BeltTier): PlanJob {
  return {
    request,
    tier,
    layout: newLayout(),
    phase: "place",
    order: placementOrder(request),
    placeIdx: 0,
    alias: {},
    queue: [],
    ripCount: {},
    failures: {},
    expanded: {},
    replaceQueue: [],
    replaced: {},
    avoid: {},
    stats: { steps: 0, work: 0, placeWork: 0, routeWork: 0, expansions: 0, searches: 0, ripups: 0, replacements: 0, maxStepWork: 0 },
  }
}

function moduleRequest(job: PlanJob, id: string): ModuleRequest {
  for (const m of job.request.modules) if (m.id === id) return m
  error(`unknown module request ${id}`)
}

export function resolve(job: PlanJob, ref: PortRef): PortRef {
  return { module: job.alias[ref.module] ?? ref.module, port: ref.port }
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
  // Short connections first (they have the fewest alternatives); ids break ties.
  conns.sort((a, b) => {
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

/** Routes already serving the same producer port (splitter taps branch off them). */
function sameSource(job: PlanJob, c: ConnectionRequest): string[] {
  const out: string[] = []
  if (c.from === undefined) return out
  for (const id of job.layout.routeOrder) {
    const r = job.layout.routes[id]
    const other = connection(job, r.conn)
    if (other.from !== undefined && other.from.module === c.from.module && other.from.port === c.from.port) out.push(id)
  }
  return out
}

function routeRequest(job: PlanJob, c: ConnectionRequest, policy: LayoutPolicy, avoid: Record<number, boolean>): RouteRequest | string {
  const to = resolve(job, c.to)
  const tm = findModule(job.layout, to.module)
  const tp = tm ? findPort(tm, to.port) : undefined
  if (!tm || !tp || tp.kind !== "belt-in") return `no belt-in port ${to.module}.${to.port}`
  const goalTile = portTile(tm, tp)
  const own: Record<string, boolean> = { [portTag(tm.id, tp.id)]: true }
  const req: RouteRequest = {
    id: `route:${c.id}`,
    conn: c.id,
    item: tp.item ?? "",
    to,
    goal: { x: goalTile.x, y: goalTile.y, dir: dirIndex(tp.dir), side: tp.side },
    tier: job.tier,
    own,
    avoid,
  }
  if (c.from !== undefined) {
    const from = resolve(job, c.from)
    const fm = findModule(job.layout, from.module)
    const fp = fm ? findPort(fm, from.port) : undefined
    if (!fm || !fp || fp.kind !== "belt-out") return `no belt-out port ${from.module}.${from.port}`
    if (fp.item !== undefined && tp.item !== undefined && fp.item !== tp.item) return `item mismatch ${fp.item} → ${tp.item}`
    req.from = from
    own[portTag(fm.id, fp.id)] = true
    const taps = sameSource(job, c)
    if (taps.length > 0) {
      if (policy.topology !== "splitter-tap") return `port ${from.module}.${from.port} already feeds a route (point-to-point topology; use splitter-tap)`
      req.taps = taps
    } else {
      const o = portOutside(fm, fp)
      req.start = { x: o.x, y: o.y, dir: dirIndex(fp.dir) }
    }
  }
  return req
}

/** An external input: a one-tile belt stub on the port's outside tile, fed from outside the layout. */
function externalStub(job: PlanJob, terrain: TerrainView, policy: LayoutPolicy, c: ConnectionRequest, req: RouteRequest): Route | string {
  const tm = findModule(job.layout, req.to.module)!
  const tp = findPort(tm, req.to.port)!
  const o = portOutside(tm, tp)
  if (tileCost(job.layout, terrain, policy, req, false, o.x, o.y) < 0) return `external input ${req.to.module}.${req.to.port}: outside tile blocked`
  const dir = dirIndex(tp.dir)
  return {
    id: req.id,
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
  const id = job.replaceQueue[0]
  if (job.placement === undefined) {
    const mreq = moduleRequest(job, id)
    job.placement = newPlacement({ id, def: mreq.def, targets: targetsFor(job, id), center: job.request.center, region: job.request.region, avoid: job.avoid[id] })
  }
  const s = job.placement
  const used = stepPlacement(s, job.layout, terrain, policy, budget)
  job.stats.placeWork += used
  if (s.phase === "done" || s.phase === "failed") {
    if (s.phase === "done") commitPlacement(job.layout, s.result!, facts, policy)
    else job.failures[`module:${id}`] = `re-placement: ${s.reason ?? "failed"}`
    job.placement = undefined
    job.replaceQueue.shift()
    if (job.replaceQueue.length === 0) job.phase = "route"
  }
  return used
}

/**
 * A connection that rip-up could not route: take out one of its modules (the consumer first; never a site-anchored,
 * built or expanded one, at most twice each) with every route touching it, and place it again away from its old
 * footprint. Returns false if no module can move.
 */
function tryReplace(job: PlanJob, c: ConnectionRequest, facts: ProtoFacts): boolean {
  const ids = [c.to.module]
  if (c.from !== undefined) ids.push(c.from.module)
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
    job.avoid[mid] = [...(job.avoid[mid] ?? []), m.rect]
    job.replaceQueue.push(mid)
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
  const id = job.order[job.placeIdx]
  const mreq = moduleRequest(job, id)
  if (job.placement === undefined) {
    // Expand-first: grow a compatible module when there is room.
    if (mreq.expandUnits !== undefined && policy.expansion === "expand-first") {
      const cand = expansionCandidate(job.layout, mreq.def, mreq.expandUnits)
      if (cand !== undefined) {
        const r = tryExpand(job.layout, terrain, facts, policy, cand.id, mreq.expandUnits)
        if (r.ok) {
          job.alias[id] = cand.id
          job.expanded[id] = { module: cand.id, units: mreq.expandUnits }
          job.placeIdx++
          return 1
        }
      }
    }
    job.placement = newPlacement({ id, def: mreq.def, targets: targetsFor(job, id), center: job.request.center, region: job.request.region })
  }
  const s = job.placement
  const used = stepPlacement(s, job.layout, terrain, policy, budget)
  job.stats.placeWork += used
  if (s.phase === "done") {
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
      job.failures[`module:${id}`] = s.reason ?? "placement failed"
      job.phase = "failed"
    }
    job.placement = undefined
    job.placeIdx++
  }
  return used
}

function routeStep(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): number {
  if (job.current === undefined) {
    const id = job.queue.shift()
    if (id === undefined) {
      let failed = false
      for (const [k] of pairs(job.failures)) if (k !== undefined) failed = true
      job.phase = failed ? "failed" : "done"
      return 0
    }
    const c = connection(job, id)
    const req = routeRequest(job, c, policy, {})
    if (typeof req === "string") {
      job.failures[id] = req
      return 1
    }
    if (c.from === undefined) {
      const stub = externalStub(job, terrain, policy, c, req)
      if (typeof stub === "string") job.failures[id] = stub
      else commitRoute(job.layout, stub)
      return 1
    }
    job.current = { conn: id, search: newSearch(job.layout, terrain, policy, req, false), rip: false, avoid: {}, retries: 0 }
    job.stats.searches++
  }
  const cur = job.current
  const used = stepSearch(cur.search, job.layout, terrain, policy, budget)
  job.stats.routeWork += used
  job.stats.expansions += used
  const st = cur.search.status
  if (st === "running") return used
  const c = connection(job, cur.conn)
  const restart = (rip: boolean): void => {
    const req = routeRequest(job, c, policy, cur.avoid)
    if (typeof req === "string") {
      job.failures[cur.conn] = req
      job.current = undefined
      return
    }
    cur.rip = rip
    cur.search = newSearch(job.layout, terrain, policy, req, rip)
    job.stats.searches++
  }
  if (st === "failed") {
    if (!cur.rip) restart(true)
    else {
      if (!tryReplace(job, c, facts)) job.failures[cur.conn] = cur.search.reason ?? "no path"
      job.current = undefined
    }
    return used
  }
  const res = searchResult(cur.search, job.layout, policy)
  if (res.selfCross !== undefined) {
    if (cur.retries < 3) {
      cur.retries++
      cur.avoid[res.selfCross] = true
      restart(cur.rip)
    } else {
      job.failures[cur.conn] = "route crosses itself"
      job.current = undefined
    }
    return used
  }
  const route = res.route!
  for (const v of res.victims) {
    const vr = job.layout.routes[v]
    if (vr === undefined) continue
    const n = job.ripCount[vr.conn] ?? 0
    if (n >= policy.router.maxRipups) {
      if (!tryReplace(job, c, facts)) job.failures[cur.conn] = `blocked by ${vr.conn} (ripped ${n} times already)`
      job.current = undefined
      return used
    }
  }
  for (const v of res.victims) {
    for (const removed of ripRoute(job.layout, v)) {
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

/** Advances the job by about `budget` work units. Returns true when it has finished (done or failed). */
export function stepPlan(job: PlanJob, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): boolean {
  let used = 0
  while (used < budget && (job.phase === "place" || job.phase === "route")) {
    const before = used
    if (job.phase === "place") used += placeStep(job, terrain, facts, policy, budget - used)
    else used += routeStep(job, terrain, facts, policy, budget - used)
    if (used === before) used += 0.01
  }
  job.stats.steps++
  job.stats.work += used
  job.stats.maxStepWork = math.max(job.stats.maxStepWork, used)
  return job.phase === "done" || job.phase === "failed"
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
