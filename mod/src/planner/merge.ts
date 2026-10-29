// Provider-group merge candidates (B60): where a second producer can join an existing route to the same consumer.
//
// Two forms: a **splitter merge** beside a straight trunk tile, and a **side-load** into the trunk belt. P44 (user,
// 2026-10-28): a side-load puts everything on one lane, so splitter merges come first, and a side-load is offered only
// when what the consumer port takes fits one lane with margin (`sideLoadLaneShare`).
//
// Pure: no Factorio globals (T1: mod/unit/merge.test.ts).

import { ccw, cw, DX, DY, manhattan, tkey } from "./grid"
import { findModule, LayoutState, portRate, routeDangles } from "./layout"

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
export function mergeGoals(layout: LayoutState, to: { module: string; port: string }, from: { module: string; port: string } | undefined, lane?: { capacity: number; share: number }): MergeGoal[] {
  const fm = from !== undefined ? findModule(layout, from.module) : undefined
  const fx = fm !== undefined ? fm.rect.x + fm.rect.w / 2 : 0
  const fy = fm !== undefined ? fm.rect.y + fm.rect.h / 2 : 0
  const near = (x: number, y: number): number => manhattan({ x, y }, { x: fx, y: fy })
  const sideLoad: { goal: MergeGoal; cost: number }[] = []
  const splitter: { goal: MergeGoal; cost: number }[] = []
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    if (r === undefined || r.to.module !== to.module || r.to.port !== to.port) continue
    // B86: only a route that brings items to the port is a trunk to join (not a stub onto a ripped trunk).
    if (routeDangles(layout, id)) continue
    let heading = r.tapOf === undefined && r.startDir !== undefined ? r.startDir : -1
    for (let i = 0; i < r.steps.length; i++) {
      const st = r.steps[i]
      const incoming = heading
      heading = st.dir
      if (st.kind !== "belt") continue
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
  // TSTL compiles `__TS__ArraySort` to call `compareFn(nil, a, b)`, so the comparator must take a `self`
  // parameter: only an inline arrow gets one. A named function passed here sees `a` as nil.
  sideLoad.sort((a, b) => byCost(a, b))
  splitter.sort((a, b) => byCost(a, b))
  const out: MergeGoal[] = []
  // Each candidate costs a full search: try the nearest few, then let the ordinary rip/re-place retries take over.
  const sides = (): void => {
    for (const c of spread(sideLoad, MAX_SIDE_LOADS)) out.push(c.goal)
  }
  const splits = (): void => {
    for (const c of spread(splitter, MAX_SPLITTERS)) out.push(c.goal)
  }
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
