// B157 phase 3: the fluid tiles a pipe of one item may not take. Placement lane checks used to treat a pipe port like a
// belt port: any free tile led out, even one that would join another fluid's line. These helpers give the lane probe the
// router's own mixing rule (B147/B151/B154), without the router's full map (own ports and trunk taps stay allowed).

import { DX, DY, tkey } from "./grid"
import { LayoutState, portOutside } from "./layout"

/** Plain pipe tiles of every fluid route, by tile → fluid name (the same map `PlacementSearch.fluidRoutes` caches). */
export function fluidRouteMap(state: LayoutState): Record<number, string> {
  const out: Record<number, string> = {}
  for (const rid of state.routeOrder) {
    const r = state.routes[rid]
    if (r === undefined || r.fluid === undefined) continue
    for (const k of r.tiles) out[k] = r.fluid.name
  }
  return out
}

/**
 * Tiles a pipe of `item` must not stand on: another fluid's route, and another fluid's pipe port outside tile plus its
 * one-tile moat (a plain pipe joins every neighbour, so a pipe beside it would mix — M7d.5 g198). The port tile itself is
 * inside its module's footprint. A same-item port is not a conflict: the pipe may join it.
 */
export function fluidConflicts(state: LayoutState, item: string, routes: Record<number, string> = fluidRouteMap(state)): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  for (const [k, fluid] of pairs(routes)) if (fluid !== item) out[k as number] = true
  for (const m of state.modules) {
    for (const p of m.def.ports) {
      if ((p.kind !== "pipe-in" && p.kind !== "pipe-out") || p.item === undefined || p.item === item) continue
      const o = portOutside(m, p)
      out[tkey(o.x, o.y)] = true
      for (let d = 0; d < 4; d++) out[tkey(o.x + DX[d], o.y + DY[d])] = true
    }
  }
  return out
}
