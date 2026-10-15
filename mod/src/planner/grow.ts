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
export function planGrowth(base: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, tier: BeltTier, id: string, units: number): GrowthPlan {
  const layout = cloneLayout(base)
  const m = findModule(layout, id)
  if (m === undefined) return { ok: false, reason: `no module ${id}`, layout: base, remove: [], add: [], rerouted: [] }
  const before = partEntities(layout, { modules: [id], routes: [], poles: [] })
  // Rip every route touching the module: ports may move, and the growth may need the tiles.
  const ripped: string[] = []
  const conns: ConnectionRequest[] = []
  const routeTiles: Record<number, boolean> = {}
  for (const rid of [...layout.routeOrder]) {
    const r = layout.routes[rid]
    if (r === undefined || (r.to.module !== id && r.from?.module !== id)) continue
    if (r.tapOf !== undefined) continue
    for (const k of r.tiles) routeTiles[k] = true
    const old = partEntities(layout, { modules: [], routes: [rid], poles: [] })
    for (const e of old) before.push(e)
    for (const removed of ripRoute(layout, rid)) ripped.push(removed)
    conns.push({ id: r.conn, from: r.from, to: r.to, belt: r.belt })
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
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: rect.x, y: rect.y }, region: { x: rect.x - 96, y: rect.y - 96, w: rect.w + 192, h: rect.h + 192 } }, tier, layout), view, facts, policy)
  if (job.phase !== "done") {
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k}: ${v}`)
    return { ok: false, reason: `reroute failed: ${why.join("; ")}`, layout: base, remove: [], add: [], rerouted: [], job }
  }
  for (const rid of job.layout.routeOrder) if (conns.some((c) => `route:${c.id}` === rid)) job.layout.routes[rid].fixed = true
  const parts: BuildParts = { modules: [id], routes: conns.map((c) => `route:${c.id}`), poles: [] }
  const after = partEntities(job.layout, parts)
  const had: Record<string, boolean> = {}
  for (const e of before) had[key(e)] = true
  const has: Record<string, boolean> = {}
  for (const e of after) has[key(e)] = true
  const remove = before.filter((e) => !has[key(e)])
  const add = after.filter((e) => !had[key(e)])
  return { ok: true, layout: job.layout, remove, add, rerouted: conns.map((c) => c.id), job }
}
