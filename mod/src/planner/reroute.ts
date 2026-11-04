// Rerouting blocked routes (M5a.2): some routes of a layout can't be (fully) built because something the faction
// doesn't own took their ground. They are ripped and routed again around it; every other route and module stays put.
// The result is a diff of world entities, like a growth (grow.ts): what the crew picks up (belts of the old route
// that the new one doesn't reuse) and what it builds. Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import type { RouteId } from "../shared/ids"
import { BuildParts, bystanderDiff, entityDiff, EntitySpec, partEntities } from "./build-list"
import { BeltTier } from "./capacity"
import { isPoleTag } from "./claim-tags"
import { FOREIGN, FREE, OWN, Rect, TerrainView, tkey } from "./grid"
import { dependentRoutes, LayoutState, ripRoute } from "./layout"
import { cloneLayout, ConnectionRequest, newRoutingJob, runJob } from "./plan"
import { LayoutPolicy } from "./policy"

export interface ReroutePlan {
  ok: boolean
  reason?: string
  layout: LayoutState
  /** World entities to pick up (old route pieces not reused) and to build. */
  remove: EntitySpec[]
  add: EntitySpec[]
  /** Route ids of the new layout that replace the ripped ones (build parts). */
  routes: RouteId[]
}

/**
 * Plans new routes for `routeIds` of `base` (and the splitter taps hanging off them) inside `region`. `terrain` is the
 * faction's view (its built entities and ghosts are OWN, other forces' FOREIGN): the ripped routes' own tiles count as
 * free, so a reroute can reuse every piece not in the way; a foreign entity on them still blocks.
 */
/**
 * `avoid`: tiles the new routes must not use (M7: a build's ghosts there could never be placed, though the terrain scan
 * reads them as free).
 */
export function planReroute(base: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, tier: BeltTier, routeIds: RouteId[], region: Rect, avoid?: Record<number, boolean>): ReroutePlan {
  const layout = cloneLayout(base)
  const before: EntitySpec[] = []
  const conns: ConnectionRequest[] = []
  const freed: Record<number, boolean> = {}
  const seen: Record<string, boolean> = {}
  for (const id of routeIds) {
    if (layout.routes[id] === undefined) continue
    // The route and what depends on it (B88/B91: its taps at any depth, as `ripRoute` takes them, and the provider-group
    // joins onto its belt): their entities and tiles before they are ripped.
    const group: RouteId[] = dependentRoutes(layout, [id])
    for (const rid of group) {
      if (seen[rid]) continue
      seen[rid] = true
      const r = layout.routes[rid]
      for (const k of r.tiles) freed[k] = true
      for (const e of partEntities(layout, { modules: [], routes: [rid], poles: [] })) before.push(e)
      // B75: a provider-group merge is routed as one again (side-load or splitter onto the trunk), not as a second
      // belt into the port that the trunk then blocks (vps-b72 4410923: the steam block never grew).
      conns.push({ id: r.conn, from: r.from, to: r.to, belt: r.belt, merge: r.merge !== undefined || r.mergeSplitter !== undefined || undefined })
    }
    for (const rid of group) ripRoute(layout, rid)
  }
  if (conns.length === 0) return { ok: false, reason: "no route to reroute", layout: base, remove: [], add: [], routes: [] }
  for (const rid of layout.routeOrder) layout.routes[rid].fixed = true
  const view: TerrainView = {
    block: (x, y) => {
      const k = tkey(x, y)
      // M7c.8 (fixes-360 seed 11, minute 630): a reroute never evicts or re-lays pole lines, so their poles stay solid
      // here. The claim view reads them as free (B37, for plans that re-lay them): an in-place coal reroute ran over
      // main-line poles, a later repair picked the pole up as "not in the layout" and the whole base lost power.
      if (isPoleTag(layout.occ[k])) return OWN
      if (avoid?.[k] === true) return FOREIGN
      const b = terrain.block(x, y)
      return freed[k] && b === OWN ? FREE : b
    },
    ore: (x, y) => terrain.ore(x, y),
  }
  const job = runJob(newRoutingJob({ modules: [], connections: conns, center: { x: region.x + region.w / 2, y: region.y + region.h / 2 }, region }, tier, layout), view, facts, policy)
  if (job.phase !== "done") {
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k}: ${v}`)
    return { ok: false, reason: `reroute failed: ${why.join("; ")}`, layout: base, remove: [], add: [], routes: [] }
  }
  const routes: RouteId[] = []
  const wanted: Record<string, boolean> = {}
  for (const c of conns) wanted[c.id] = true
  for (const rid of job.layout.routeOrder) {
    const r = job.layout.routes[rid]
    if (wanted[r.conn] && !r.fixed) routes.push(rid)
  }
  for (const rid of routes) job.layout.routes[rid].fixed = true
  const parts: BuildParts = { modules: [], routes, poles: [] }
  const after = partEntities(job.layout, parts)
  const d = entityDiff(before, after)
  const changed: Record<string, boolean> = {}
  for (const [rid] of pairs(seen)) changed[rid as string] = true
  for (const rid of routes) changed[rid] = true
  const by = bystanderDiff(base, job.layout, changed)
  return { ok: true, layout: job.layout, remove: [...d.remove, ...by.remove], add: [...d.add, ...by.add], routes }
}
