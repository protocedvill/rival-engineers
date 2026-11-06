// Shared seal proof (B156 phase 1). A bounded flood over a transport's own moves, without costs: a side that runs out
// before it meets the other proves its pocket sealed. The belt router has had this since B45/B57; the pipe router only
// reported `search exhausted` / `budget exhausted`, and "budget exhausted" says nothing about enclosure (a large but
// reachable search looks the same). Pipes can now prove a sealed goal and feed the same evidence the belt remedies use.
//
// Pure: terrain, claims and other fluids come in as callbacks (T1: mod/unit/pipe-router.test.ts).

import { DX, DY, keyX, keyY, tkey, Vec } from "./grid"

export interface SealProof {
  side: "start" | "goal"
  /** Tiles of the enclosed side the flood reached before running out. */
  tiles: number
  /** B28/B63: the flood was cut short (a cap or a window), so this is not a proof. */
  edge: boolean
}

export interface SealMode {
  /** A tile a pipe/belt may stand on. */
  pass: (this: void, x: number, y: number) => boolean
  /** A plain move to a 4-neighbour, under the transport's own connection rule (pipes: never beside another fluid). */
  step: (this: void, x: number, y: number, nx: number, ny: number) => boolean
  /** An underground / pipe-to-ground move from (x, y) along axis (0 N/S, 1 E/W) by k >= 2; the exit is passable. */
  span: (this: void, x: number, y: number, axis: number, k: number) => boolean
  /** Farthest a `span` move reaches (the transport's underground distance). */
  maxSpan: number
  /** Tiles on the other side (a provider's port outside, a tap's start); reaching any one means "not sealed". */
  starts: Vec[]
  /** Most tiles to expand; 0 disables the proof. */
  cap: number
}

export interface SealOutcome {
  /** The enclosed side, when the flood ran out before meeting the other side. */
  proof?: SealProof
  /** Tiles the flood visited (work). */
  visited: number
  /** True when the cap was hit before the pocket ran out: no conclusion. */
  inconclusive: boolean
}

/**
 * Floods the goal's pocket over `mode` and proves it sealed when the flood runs out without reaching `starts`/`trunk`.
 * The flood deliberately over-approximates the transport's moves (plain neighbours and spans, ignoring costs and
 * headings), so it may fail to prove a seal but never invents one. That is the safe direction: a false "sealed" moves a
 * working module, a missed one only leaves the old failure.
 */
export function proveSealAt(mode: SealMode, goal: Vec): SealOutcome {
  const cap = mode.cap
  if (cap <= 0) return { visited: 0, inconclusive: false }
  if (mode.starts.length === 0) return { visited: 0, inconclusive: true }
  if (!mode.pass(goal.x, goal.y)) return { proof: { side: "goal", tiles: 0, edge: false }, visited: 0, inconclusive: false }
  // If no start tile is placeable, the other end is the sealed one: never blame the goal for a blocked provider.
  let openStart = false
  const other: Record<number, boolean> = {}
  for (const s of mode.starts) {
    other[tkey(s.x, s.y)] = true
    if (mode.pass(s.x, s.y)) openStart = true
  }
  if (!openStart) return { proof: { side: "start", tiles: 0, edge: false }, visited: 0, inconclusive: false }
  const seen: Record<number, boolean> = {}
  const queue: number[] = []
  const push = (x: number, y: number): void => {
    const k = tkey(x, y)
    if (seen[k] === true) return
    seen[k] = true
    queue.push(k)
  }
  push(goal.x, goal.y)
  let visited = 0
  while (visited < queue.length) {
    if (visited >= cap) return { visited, inconclusive: true }
    const k = queue[visited]
    visited++
    if (other[k] === true) return { visited, inconclusive: false }
    const x = keyX(k)
    const y = keyY(k)
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]
      const ny = y + DY[d]
      if (!mode.pass(nx, ny) || !mode.step(x, y, nx, ny)) continue
      push(nx, ny)
    }
    for (let axis = 0; axis < 2; axis++) {
      const dx = axis === 1 ? 1 : 0
      const dy = axis === 0 ? 1 : 0
      for (let n = 2; n <= mode.maxSpan; n++) {
        if (!mode.span(x, y, axis, n)) continue
        push(x + dx * n, y + dy * n)
      }
    }
  }
  return { proof: { side: "goal", tiles: visited, edge: false }, visited, inconclusive: false }
}
