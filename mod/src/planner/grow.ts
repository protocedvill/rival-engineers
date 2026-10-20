// Growing a built module in place (SPEC §5.3 incremental expansion, LayoutPolicy.expansion = expand-first): the
// module gets `k` more units along its `expand` axis (`tryExpand`), the routes of ports that move are ripped and
// routed again, and the result is a diff of world entities: what the crew picks up (moved entities, belts of ripped
// routes) and what it builds (the grown module's new and moved entities, the new routes). Entities that stay where
// they are (same name, position and direction) are neither removed nor rebuilt. Pure: no Factorio globals.

import { expandMoves } from "../modules/build"
import { ProtoFacts } from "../modules/facts"
import { BeltTier } from "./capacity"
import { BuildParts, EntitySpec, partEntities } from "./build-list"
import { FREE, TerrainView, tkey } from "./grid"
import { findModule, LayoutState, ripRoute } from "./layout"
import { cloneLayout, ConnectionRequest, newRoutingJob, PlanJob, runJob } from "./plan"
import { HEAD_GROWTH_OPENS_BELT, tryExpand } from "./placement"
import { LayoutPolicy } from "./policy"
import { polesNow, unpoweredModules } from "./power"

export interface GrowthPlan {
  ok: boolean
  reason?: string
  layout: LayoutState
  /** World entities to pick up and to build. */
  remove: EntitySpec[]
  add: EntitySpec[]
  /** Connections (route conn ids) that were rerouted. */
  rerouted: string[]
  job?: PlanJob
}

function key(e: EntitySpec): string {
  return string.format("%s@%g,%g:%g:%s", e.name, e.x, e.y, e.dir, e.ioType ?? "")
}

/**
 * Plans growing module `id` of `base` by `units`. The terrain is the faction's (it shows the module and its routes as
 * built): the module's footprint and the tiles of its ripped routes count as free for the growth and the reroute.
 */
/** A route and, depth first, every splitter tap hanging off it (the route first: a tap is routed onto its root). */
function tapGroup(layout: LayoutState, rid: string): string[] {
  const out = [rid]
  for (const other of layout.routeOrder) if (layout.routes[other]?.tapOf === rid) for (const t of tapGroup(layout, other)) out.push(t)
  return out
}

export function planGrowth(base: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, tier: BeltTier, id: string, units: number, pole = "small-electric-pole", polePrefix = "poles:grow:", reclaim = false): GrowthPlan {
  const layout = cloneLayout(base)
  const m = findModule(layout, id)
  if (m === undefined) return { ok: false, reason: `no module ${id}`, layout: base, remove: [], add: [], rerouted: [] }
  const before = partEntities(layout, { modules: [id], routes: [], poles: [] })
  // Rip every route touching the module: ports may move, and the growth may need the tiles.
  const ripped: string[] = []
  const conns: ConnectionRequest[] = []
  let taps = false
  const routeTiles: Record<number, boolean> = {}
  const roots: Record<string, boolean> = {}
  for (const rid of [...layout.routeOrder]) {
    const r = layout.routes[rid]
    if (r === undefined || (r.to.module !== id && r.from?.module !== id)) continue
    // M6a.2 (seed 222): the touching route may itself be a tap of its group (n1's fuel route was the deepest tap of
    // the coal line): rip the group's root so the whole chain is freed and rerouted, not just the root's own taps.
    let root = rid
    while (layout.routes[root]?.tapOf !== undefined) root = layout.routes[root]!.tapOf!
    if (roots[root]) continue
    roots[root] = true
    // The route and the splitter taps hanging off it (ripRoute rips those too): their entities are picked up, their
    // tiles freed and their connections routed again (seed 11: a tap's belts were left standing, untracked, and the
    // grown coal outpost's drill ghost overlapped them forever).
    for (const gid of tapGroup(layout, root)) {
      const gr = layout.routes[gid]
      if (gr.tapOf !== undefined) taps = true
      for (const k of gr.tiles) routeTiles[k] = true
      for (const e of partEntities(layout, { modules: [], routes: [gid], poles: [] })) before.push(e)
      conns.push({ id: gr.conn, from: gr.from, to: gr.to, belt: gr.belt })
    }
    for (const removed of ripRoute(layout, root)) ripped.push(removed)
  }
  // Every other route stays put.
  for (const rid of layout.routeOrder) layout.routes[rid].fixed = true
  const rect = { ...m.rect }
  const view: TerrainView = {
    block: (x, y) => {
      if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) return FREE
      if (routeTiles[tkey(x, y)]) return FREE
      return terrain.block(x, y)
    },
    ore: (x, y) => terrain.ore(x, y),
  }
  m.fixed = false
  // Preserve the original minimum-movement end first, then try the opposite end. A failed tryExpand commits nothing,
  // so a mine on the edge of an irregular patch can safely grow back toward the ore (D52/OutpostPlanner).
  // D55: a worked-out whole-patch mine moves to the next free part of its patch instead of growing.
  let r = tryExpand(layout, view, facts, policy, id, units, "auto", reclaim)
  if (!r.ok && !reclaim) {
    const moves = expandMoves(m.canonical, units)
    const other = moves.originShift.x !== 0 || moves.originShift.y !== 0 ? "tail" : "head"
    const first = r
    r = tryExpand(layout, view, facts, policy, id, units, other)
    // B25: a module that can't grow at its head at all says why its usual end failed.
    if (!r.ok && r.reason === HEAD_GROWTH_OPENS_BELT) r = first
  }
  m.fixed = true
  if (!r.ok) return { ok: false, reason: r.reason, layout: base, remove: [], add: [], rerouted: [] }
  // Reroute the ripped connections on the grown layout. The region must reach every module a rerouted connection
  // touches: a tap group's routes feed the modules far from the growth (seed 222: the coal taps feed the smelter
  // columns west of the grown steam block).
  let rx = rect.x
  let ry = rect.y
  let rw = rect.w
  let rh = rect.h
  for (const c of conns) {
    for (const p of [c.from, c.to]) {
      const mm = p !== undefined ? findModule(layout, p.module) : undefined
      if (mm === undefined) continue
      const x1 = math.min(rx, mm.rect.x)
      const y1 = math.min(ry, mm.rect.y)
      const x2 = math.max(rx + rw, mm.rect.x + mm.rect.w)
      const y2 = math.max(ry + rh, mm.rect.y + mm.rect.h)
      rx = x1
      ry = y1
      rw = x2 - x1
      rh = y2 - y1
    }
  }
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: rect.x, y: rect.y }, region: { x: rx - 96, y: ry - 96, w: rw + 192, h: rh + 192 } }, tier, layout), view, facts, taps ? { ...policy, topology: "splitter-tap" } : policy)
  if (job.phase !== "done") {
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k}: ${v}`)
    return { ok: false, reason: `reroute failed: ${why.join("; ")}`, layout: base, remove: [], add: [], rerouted: [], job }
  }
  const wanted: Record<string, boolean> = {}
  for (const c of conns) wanted[c.id] = true
  const routes: string[] = []
  for (const rid of job.layout.routeOrder) {
    const rr = job.layout.routes[rid]
    if (wanted[rr.conn] && !rr.fixed) routes.push(rid)
  }
  for (const rid of routes) job.layout.routes[rid].fixed = true
  // B37: pole lines the growth or its reroutes took are gone (`evictPoleLines`): pick their poles up and join what
  // they powered again with new lines. A module that was powered and can't be joined again fails the growth.
  const evicted = (job.layout.evictedPoles ?? []).slice(base.evictedPoles?.length ?? 0)
  let newPoles: string[] = []
  if (evicted.length > 0) {
    const was: Record<string, boolean> = {}
    for (const u of unpoweredModules(base, facts)) was[u] = true
    const pj = polesNow(job.layout, view, facts, policy, polePrefix, pole)
    for (const u of unpoweredModules(job.layout, facts)) {
      if (!was[u]) return { ok: false, reason: `re-pole failed: ${u} ${pj.failures[u] ?? "stays unpowered"}`, layout: base, remove: [], add: [], rerouted: [], job }
    }
    newPoles = pj.added
  }
  const parts: BuildParts = { modules: [id], routes, poles: newPoles }
  const after = partEntities(job.layout, parts)
  const had: Record<string, boolean> = {}
  for (const e of before) had[key(e)] = true
  const has: Record<string, boolean> = {}
  for (const e of after) has[key(e)] = true
  const remove = before.filter((e) => !has[key(e)])
  let add = after.filter((e) => !had[key(e)])
  // An evicted pole the new lines place again where it stands stays (neither picked up nor rebuilt).
  const added: Record<string, boolean> = {}
  for (const e of add) added[key(e)] = true
  const kept: Record<string, boolean> = {}
  for (const p of evicted) {
    const e: EntitySpec = { name: p.name, x: p.x + 0.5, y: p.y + 0.5, dir: 0, owner: p.line }
    if (added[key(e)]) kept[key(e)] = true
    else remove.push(e)
  }
  add = add.filter((e) => !kept[key(e)])
  return { ok: true, layout: job.layout, remove, add, rerouted: conns.map((c) => c.id), job }
}

/**
 * D52/B21: the most units `id` can still grow by, right now (0 = none): the largest k such that the grown drills
 * still sit on ore (and the tiles stay free). The patch is usually smaller than the belt limit, so a full-size
 * expansion lands off-ore; grow only as far as the ore runs. Same route rip-up as `planGrowth` (ports may move and
 * the growth may need those tiles), but no routing: the result is only a count, on a throwaway clone.
 */
export function maxExpandable(base: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, id: string): number {
  const layout = cloneLayout(base)
  const m = findModule(layout, id)
  if (m === undefined) return 0
  if (m.minePlan !== undefined) {
    if (m.minePlan.complete) return 0
    return tryExpand(layout, terrain, facts, policy, id, 1).ok ? 1 : 0
  }
  const spec = m.canonical.expand
  if (spec === undefined || spec.maxUnits < 1) return 0
  const routeTiles: Record<number, boolean> = {}
  const roots: Record<string, boolean> = {}
  for (const rid of [...layout.routeOrder]) {
    const r = layout.routes[rid]
    if (r === undefined || (r.to.module !== id && r.from?.module !== id)) continue
    let root = rid
    while (layout.routes[root]?.tapOf !== undefined) root = layout.routes[root]!.tapOf!
    if (roots[root]) continue
    roots[root] = true
    for (const gid of tapGroup(layout, root)) for (const k of layout.routes[gid]!.tiles) routeTiles[k] = true
    for (const removed of ripRoute(layout, root)) void removed
  }
  const rect = { ...m.rect }
  const view: TerrainView = {
    block: (x, y) => {
      if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) return FREE
      if (routeTiles[tkey(x, y)]) return FREE
      return terrain.block(x, y)
    },
    ore: (x, y) => terrain.ore(x, y),
  }
  // Try the original minimum-movement end first, then the opposite. This keeps established layouts exact while still
  // allowing a mine on the edge of an irregular patch to grow back toward the ore.
  for (let k = spec.maxUnits; k >= 1; k--) {
    const moves = expandMoves(m.canonical, k)
    const other = moves.originShift.x !== 0 || moves.originShift.y !== 0 ? "tail" : "head"
    if (tryExpand(layout, view, facts, policy, id, k, "auto").ok) return k
    if (tryExpand(layout, view, facts, policy, id, k, other).ok) return k
  }
  return 0
}
