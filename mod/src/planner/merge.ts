// Provider-group merge candidates (B60): where a second producer can join an existing route to the same consumer.
//
// Two forms: a **splitter merge** beside a straight trunk tile, and a **side-load** into the trunk belt. P44 (user,
// 2026-10-28): a side-load puts everything on one lane, so splitter merges come first, and a side-load is offered only
// when what the consumer port takes fits one lane with margin (`sideLoadLaneShare`).
//
// Pure: no Factorio globals (T1: mod/unit/merge.test.ts).

import { ccw, cw, DX, DY, manhattan, tkey } from "./grid"
import { findModule, LayoutState, portRate, Route, routeDangles } from "./layout"
import { joinTiles } from "./tunnel"

/** One place a second route can join an existing route to the same consumer. */
export interface MergeGoal {
  x: number
  y: number
  dir: number
  /** Side-load: which side of the trunk belt the new route arrives from. */
  side?: "left" | "right"
  /** Splitter merge: the second splitter tile, beside the trunk, which this route occupies. */
  x2?: number
  y2?: number
}

const MAX_SIDE_LOADS = 12
const MAX_SPLITTERS = 12
/** M7: how many splitter taps up a trunk tree `mergeGoals` looks for merge points. */
const MAX_TAP_DEPTH = 8

function free(layout: LayoutState, x: number, y: number): boolean {
  const k = tkey(x, y)
  // B92: nor a whole-patch mine's claim (sweep 922c77c 1264816: a merge splitter took the tile of a mine's future pole,
  // the pole's ghost never revived, and the lab cluster it linked to the plant stayed unpowered for 300 game-min).
  return layout.occ[k] === undefined && layout.routeOcc[k] === undefined && layout.reserved[k] === undefined && layout.mine?.[k] === undefined
}

/**
 * B94: at most `max` of `sorted` (nearest first): the nearest half, then the rest evenly over the remainder, so the
 * candidates span the whole trunk (sweep 3e1c4d7 seed 1376111: the 12 nearest of 174 all lay on the trunk's tail in a
 * pocket by the consumer, each sealed, while its head was open: every replacement plan "no path").
 */
function spread<T>(sorted: T[], max: number): T[] {
  if (sorted.length <= max) return sorted
  const near = math.floor(max / 2)
  const out = sorted.slice(0, near)
  const rest = sorted.length - near
  const far = max - near
  for (let i = 0; i < far; i++) out.push(sorted[near + math.floor(((i + 1) * rest) / (far + 1))])
  return out
}

function byCost(a: { cost: number; goal: MergeGoal }, b: { cost: number; goal: MergeGoal }): number {
  return a.cost !== b.cost ? a.cost - b.cost : a.goal.x !== b.goal.x ? a.goal.x - b.goal.x : a.goal.y !== b.goal.y ? a.goal.y - b.goal.y : a.goal.dir - b.goal.dir
}

/**
 * Merge points on the existing routes to `to`, nearest `from` first. With `lane` (P44: one lane's capacity, items/s, and
 * the share of it a side-load may carry): splitter merges first, side-loads only when the consumer port's rate is at most
 * that share. Without it: side-loads first, as before.
 *
 * A splitter merge needs the trunk belt to run straight through (it enters and leaves the splitter straight) and the
 * splitter's far output lane to stay empty, so that lane backs up and every item goes into the trunk.
 */
export function mergeGoals(layout: LayoutState, to: { module: string; port: string }, from: { module: string; port: string } | undefined, lane?: { capacity: number; share: number }, score?: (this: void, x: number, y: number) => number): MergeGoal[] {
  const fm = from !== undefined ? findModule(layout, from.module) : undefined
  const fx = fm !== undefined ? fm.rect.x + fm.rect.w / 2 : 0
  const fy = fm !== undefined ? fm.rect.y + fm.rect.h / 2 : 0
  const near = (x: number, y: number): number => manhattan({ x, y }, { x: fx, y: fy })
  const sideLoad: { goal: MergeGoal; cost: number }[] = []
  const splitter: { goal: MergeGoal; cost: number }[] = []
  // Tiles another route already joins (a tap's splitter, a side-load, a merge splitter): no merge there. B174 (soak
  // m7-fresh4 seed 222, g94-g110): only taps counted, so two merge splitters took one trunk tile from either side, the
  // build was rejected before stamping, and every goal after it planned the same overlap again.
  const splitAt = joinTiles(layout)
  // B122 (seed 11 g78, in game): routes that merge into another route (side-load or splitter), by the trunk tile they
  // join. Their belts carry items into that trunk, so a merge onto one of them lands wherever the trunk does.
  const feeders: Record<number, Route[]> = {}
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    const join = r?.merge ?? r?.mergeSplitter
    if (r === undefined || join === undefined) continue
    const k = tkey(join.x, join.y)
    feeders[k] ??= []
    feeders[k].push(r)
  }
  const fed: Record<string, boolean> = {}
  const consider = (r: Route, end: number): void => {
    // A feeder joining this route above `end` carries items past it: its whole belt is a merge point too (B122: three
    // replacement mines for one sealed fuel tree each needed their own way into the base; the second and third can
    // join the first's belt outside it).
    for (let i = 0; i < end; i++) {
      for (const f of feeders[tkey(r.steps[i].x, r.steps[i].y)] ?? []) {
        if (f.id === r.id || fed[f.id] || routeDangles(layout, f.id)) continue
        fed[f.id] = true
        consider(f, f.steps.length)
      }
    }
    let heading = r.tapOf === undefined && r.startDir !== undefined ? r.startDir : -1
    for (let i = 0; i < end; i++) {
      const st = r.steps[i]
      const incoming = heading
      heading = st.dir
      if (st.kind !== "belt" || splitAt[tkey(st.x, st.y)]) continue
      const next = r.steps[i + 1]
      const straight = next !== undefined && next.x === st.x + DX[st.dir] && next.y === st.y + DY[st.dir] && st.dir === incoming
      for (const side of ["left", "right"] as ("left" | "right")[]) {
        const h = side === "left" ? cw(st.dir) : ccw(st.dir)
        const x = st.x - DX[h]
        const y = st.y - DY[h]
        if (!free(layout, x, y)) continue
        sideLoad.push({ goal: { x: st.x, y: st.y, dir: st.dir, side }, cost: near(x, y) })
        if (!straight) continue
        const back = tkey(x + DX[st.dir], y + DY[st.dir])
        if (layout.routeOcc[back] !== undefined || layout.occ[back] !== undefined || layout.mine?.[back] !== undefined) continue
        splitter.push({ goal: { x: st.x, y: st.y, dir: st.dir, x2: x, y2: y }, cost: near(x, y) })
      }
    }
  }
  const seen: Record<string, boolean> = {}
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    if (r === undefined || r.to.module !== to.module || r.to.port !== to.port) continue
    // B86: only a route that brings items to the port is a trunk to join (not a stub onto a ripped trunk).
    if (routeDangles(layout, id)) continue
    consider(r, r.steps.length)
    // M7 (seed 11 g78): a splitter tap's trunk carries its items too, upstream of the tap's splitter. The fuel taps of a
    // retiring coal mine ran 10 tiles between two 24-furnace columns, sealed in by the base, while their trunk's head was
    // open (B94's pocket, a whole tap long): every replacement merge failed "no path". Join the trunk above the tap too.
    let tap: Route = r
    for (let depth = 0; depth < MAX_TAP_DEPTH && tap.tapOf !== undefined && !seen[tap.tapOf]; depth++) {
      seen[tap.tapOf] = true
      const trunk = layout.routes[tap.tapOf]
      const s0 = tap.steps[0]
      if (trunk === undefined || s0 === undefined || routeDangles(layout, trunk.id)) break
      let at = -1
      for (let i = 0; i < trunk.steps.length && at < 0; i++) if (trunk.steps[i].x === s0.x && trunk.steps[i].y === s0.y) at = i
      if (at < 0) break
      consider(trunk, at)
      tap = trunk
    }
  }
  // TSTL compiles `__TS__ArraySort` to call `compareFn(nil, a, b)`, so the comparator must take a `self`
  // parameter: only an inline arrow gets one. A named function passed here sees `a` as nil.
  sideLoad.sort((a, b) => byCost(a, b))
  splitter.sort((a, b) => byCost(a, b))
  const out: MergeGoal[] = []
  // Each candidate costs a full search: try the nearest few, then let the ordinary rip/re-place retries take over.
  // M7 (B): with `score` (how many other ports a join there also feeds), the scoring points come first, best first, in up
  // to half the slots; the rest are spread as before.
  const pick = (list: { goal: MergeGoal; cost: number }[], max: number): void => {
    if (score === undefined) {
      for (const c of spread(list, max)) out.push(c.goal)
      return
    }
    const top: { goal: MergeGoal; cost: number; n: number }[] = []
    const rest: { goal: MergeGoal; cost: number }[] = []
    for (const c of list) {
      const n = score(c.goal.x, c.goal.y)
      if (n > 0) top.push({ goal: c.goal, cost: c.cost, n })
      else rest.push(c)
    }
    top.sort((a, b) => (a.n !== b.n ? b.n - a.n : byCost(a, b)))
    const k = math.min(top.length, math.floor(max / 2))
    for (let i = 0; i < k; i++) out.push(top[i].goal)
    for (const c of spread(rest, max - k)) out.push(c.goal)
  }
  const sides = (): void => pick(sideLoad, MAX_SIDE_LOADS)
  const splits = (): void => pick(splitter, MAX_SPLITTERS)
  if (lane === undefined) {
    sides()
    splits()
    return out
  }
  splits()
  // Unknown demand counts as too much for one lane.
  const demand = portRate(layout, to, false)
  if (demand !== undefined && demand <= lane.share * lane.capacity) sides()
  return out
}
