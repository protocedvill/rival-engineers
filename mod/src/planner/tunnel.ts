// Tunnel crossings (user request, 2026-11-03): a route may cross another route's straight belt run. The crossed run's
// three tiles around the crossing become an underground pair (entrance, freed tile, exit), so the new belt goes through
// the freed tile and the crossed route keeps its path. It replaces ripping up the whole crossed route (or giving up on
// a built one) when only one tile is in the way.
//
// The crossing is a straight perpendicular pass of the new route's belt over the freed tile: it enters from one side
// and leaves on the other. Every condition below keeps the rebuilt run exactly as it carried before:
//   - the run is three plain belts in one direction (steps i-1, i, i+1) with a straight feed into the entrance (step
//     i-2: a belt or an underground exit in that direction) and something after the exit (step i+2) to output into;
//     so a port's own tile, a curve, a splitter or an existing underground end is never rebuilt;
//   - no route joins it there (a side-load or merge splitter onto i-2..i+2), nor taps it (a tap's splitter stands on
//     one of its tiles): an underground end changes what a side-load or splitter does. That includes the crossing
//     route's own splitter (`ownSplit`): a tap that crosses its trunk right after splitting off it would put the
//     entrance under its own splitter, which replaces it and cuts the trunk (B172);
//   - none of the five tiles is reserved (a port's tile or lane) or occupied by anything else;
//   - no other underground runs along the run's line over the new span (it could take the new pair's end);
//   - the crossed route is not a pipe, not the crossing route itself, and not one still being built by another goal
//     (its ghosts are already out: `busy`).
// Span 2 (one free tile between the ends) fits every belt tier, so the crossed route's tier never matters.
//
// Pure: no Factorio globals (T1: mod/unit/tunnel.test.ts).

import type { RouteId } from "../shared/ids"
import { releaseRouteTile } from "./claims"
import { DX, DY, tkey } from "./grid"
import { bumpLayout, LayoutState, lineKey, Route, RouteStep, spanConflicts } from "./layout"

/** Where a tunnel may go: the crossed route, the index of the freed step in it, and the run's direction. */
export interface TunnelSite {
  route: RouteId
  i: number
  dir: number
}

/** Tiles other routes join a route at (side-load and merge-splitter targets) or tap it (a tap's splitter tile). */
const joinCache = new WeakMap<LayoutState, { revision: number; routes: number; tiles: Record<number, boolean> }>()
/** Step index by tile, per steps array (a converted route gets a new array, so the cache never goes stale). */
const indexCache = new WeakMap<RouteStep[], Record<number, number>>()

export function joinTiles(state: LayoutState): Record<number, boolean> {
  // Every route change bumps the revision (commitRoute, ripRoute, tunnelRoute); the route count guards the rest.
  const rev = state.revision ?? 0
  const cached = joinCache.get(state)
  if (cached !== undefined && cached.revision === rev && cached.routes === state.routeOrder.length) return cached.tiles
  const tiles: Record<number, boolean> = {}
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    if (r === undefined) continue
    const join = r.merge ?? r.mergeSplitter
    if (join !== undefined) tiles[tkey(join.x, join.y)] = true
    const s0 = r.steps[0]
    if (r.tapOf !== undefined && s0?.kind === "splitter") tiles[tkey(s0.x, s0.y)] = true
  }
  joinCache.set(state, { revision: rev, routes: state.routeOrder.length, tiles })
  return tiles
}

function stepIndex(r: Route, x: number, y: number): number {
  let index = indexCache.get(r.steps)
  if (index === undefined) {
    index = {}
    for (let i = 0; i < r.steps.length; i++) {
      const s = r.steps[i]
      if (s.kind !== "splitter") index[tkey(s.x, s.y)] = i
    }
    indexCache.set(r.steps, index)
  }
  return index[tkey(x, y)] ?? -1
}

function at(s: RouteStep | undefined, x: number, y: number): boolean {
  return s !== undefined && s.x === x && s.y === y
}

/**
 * Whether a belt heading `d` may cross the tile (x, y) by a tunnel through the route on it (see the file comment).
 * `self` is the crossing route's id; `busy` lists routes that may not be rebuilt; `ownSplit` is the tile key of the
 * crossing route's own tap splitter, not committed yet.
 */
export function tunnelSite(state: LayoutState, x: number, y: number, d: number, self: string, busy?: Record<string, boolean>, ownSplit?: number): TunnelSite | undefined {
  const id = state.routeOcc[tkey(x, y)]
  if (id === undefined || id === self || busy?.[id]) return undefined
  const r = state.routes[id]
  if (r === undefined || r.fluid !== undefined || r.external) return undefined
  const i = stepIndex(r, x, y)
  if (i < 2 || i + 2 > r.steps.length - 1) return undefined
  const D = r.steps[i].dir
  if (D % 2 === d % 2) return undefined
  // The run: steps i-2..i+1 straight in direction D, contiguous; i-1..i+1 plain belts; i-2 a belt or an underground exit.
  for (let j = i - 2; j <= i + 1; j++) {
    const s = r.steps[j]
    if (s.dir !== D || !at(s, x + DX[D] * (j - i), y + DY[D] * (j - i))) return undefined
    if (j >= i - 1 && s.kind !== "belt") return undefined
    if (j === i - 2 && s.kind !== "belt" && s.kind !== "ug-out") return undefined
  }
  if (r.blocker !== undefined && math.abs(r.blocker.x - x) + math.abs(r.blocker.y - y) <= 2) return undefined
  const joins = joinTiles(state)
  for (let j = -2; j <= 2; j++) {
    const k = tkey(x + DX[D] * j, y + DY[D] * j)
    if (joins[k] || k === ownSplit) return undefined
    if (math.abs(j) <= 1 && (state.reserved[k] !== undefined || state.occ[k] !== undefined)) return undefined
  }
  const line = lineKey(x, y, D)
  const lo = D % 2 === 1 ? x - 1 : y - 1
  if (spanConflicts(state, line, lo, lo + 2).length > 0) return undefined
  return { route: id, i, dir: D }
}

/**
 * Turns the crossed run around (x, y) into an underground pair and frees (x, y). Re-checks the site first (`d` is the
 * crossing belt's heading); returns false, changing nothing, if it no longer holds. The route is replaced by a new
 * object (plans share route objects with the faction's layout until adoption).
 */
export function tunnelRoute(state: LayoutState, x: number, y: number, d: number, self: string, busy?: Record<string, boolean>, ownSplit?: number): RouteId | undefined {
  const site = tunnelSite(state, x, y, d, self, busy, ownSplit)
  if (site === undefined) return undefined
  const r = state.routes[site.route]
  const { i, dir } = site
  const a = r.steps[i - 1]
  const b = r.steps[i + 1]
  const steps: RouteStep[] = [...r.steps.slice(0, i - 1), { kind: "ug-in", x: a.x, y: a.y, dir }, { kind: "ug-out", x: b.x, y: b.y, dir }, ...r.steps.slice(i + 2)]
  const k = tkey(x, y)
  const line = lineKey(x, y, dir)
  const lo = dir % 2 === 1 ? x - 1 : y - 1
  const span = { a: lo, b: lo + 2, route: r.id }
  const next: Route = {
    ...r,
    steps,
    tiles: r.tiles.filter((t) => t !== k),
    spans: [...r.spans, { line, span }],
    length: r.length - 1,
    undergrounds: r.undergrounds + 1,
    tunnels: [...(r.tunnels ?? []), { x, y }],
  }
  state.routes[r.id] = next
  releaseRouteTile(state, k, r.id)
  const list = state.spans[line]
  if (list === undefined) state.spans[line] = [span]
  else list.push(span)
  bumpLayout(state)
  return r.id
}
