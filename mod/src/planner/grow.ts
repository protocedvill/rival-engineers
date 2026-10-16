// Growing a built module in place (SPEC §5.3 incremental expansion, LayoutPolicy.expansion = expand-first): the
// module gets `k` more units along its `expand` axis (`tryExpand`), the routes of ports that move are ripped and
// routed again, and the result is a diff of world entities: what the crew picks up (moved entities, belts of ripped
// routes) and what it builds (the grown module's new and moved entities, the new routes). Entities that stay where
// they are (same name, position and direction) are neither removed nor rebuilt. Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import { BeltTier } from "./capacity"
import { BuildParts, EntitySpec, partEntities } from "./build-list"
import { FREE, TerrainView, tkey } from "./grid"
import { findModule, LayoutState, ripRoute } from "./layout"
import { cloneLayout, ConnectionRequest, newRoutingJob, PlanJob, runJob } from "./plan"
import { tryExpand } from "./placement"
import { LayoutPolicy } from "./policy"

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

export function planGrowth(base: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, tier: BeltTier, id: string, units: number): GrowthPlan {
  const layout = cloneLayout(base)
  const m = findModule(layout, id)
  if (m === undefined) return { ok: false, reason: `no module ${id}`, layout: base, remove: [], add: [], rerouted: [] }
  const before = partEntities(layout, { modules: [id], routes: [], poles: [] })
  // Rip every route touching the module: ports may move, and the growth may need the tiles.
  const ripped: string[] = []
  const conns: ConnectionRequest[] = []
  let taps = false
  const routeTiles: Record<number, boolean> = {}
  for (const rid of [...layout.routeOrder]) {
    const r = layout.routes[rid]
    if (r === undefined || (r.to.module !== id && r.from?.module !== id)) continue
    if (r.tapOf !== undefined) continue
    // The route and the splitter taps hanging off it (ripRoute rips those too): their entities are picked up, their
    // tiles freed and their connections routed again (seed 11: a tap's belts were left standing, untracked, and the
    // grown coal outpost's drill ghost overlapped them forever).
    for (const gid of tapGroup(layout, rid)) {
      const gr = layout.routes[gid]
      if (gr.tapOf !== undefined) taps = true
      for (const k of gr.tiles) routeTiles[k] = true
      for (const e of partEntities(layout, { modules: [], routes: [gid], poles: [] })) before.push(e)
      conns.push({ id: gr.conn, from: gr.from, to: gr.to, belt: gr.belt })
    }
    for (const removed of ripRoute(layout, rid)) ripped.push(removed)
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
  const r = tryExpand(layout, view, facts, policy, id, units)
  m.fixed = true
  if (!r.ok) return { ok: false, reason: r.reason, layout: base, remove: [], add: [], rerouted: [] }
  // Reroute the ripped connections on the grown layout.
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: rect.x, y: rect.y }, region: { x: rect.x - 96, y: rect.y - 96, w: rect.w + 192, h: rect.h + 192 } }, tier, layout), view, facts, taps ? { ...policy, topology: "splitter-tap" } : policy)
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
  const parts: BuildParts = { modules: [id], routes, poles: [] }
  const after = partEntities(job.layout, parts)
  const had: Record<string, boolean> = {}
  for (const e of before) had[key(e)] = true
  const has: Record<string, boolean> = {}
  for (const e of after) has[key(e)] = true
  const remove = before.filter((e) => !has[key(e)])
  const add = after.filter((e) => !had[key(e)])
  return { ok: true, layout: job.layout, remove, add, rerouted: conns.map((c) => c.id), job }
}
