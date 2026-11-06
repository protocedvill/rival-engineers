// Shared seal proof (B156/B157). A bounded reverse flood from the goal over a transport's **real** moves, without
// costs: if it runs out before reaching a start state, the goal's pocket is enclosed. The transport supplies the moves
// (plain pipe with its neighbour rule, pipe-to-ground spans, pumps; belt turns, undergrounds, tunnels), so the engine is
// transport-agnostic and a proof means "no route under these mechanics", not "no route over free tiles".
//
// Pure: terrain, claims and other fluids come in as callbacks (T1: mod/unit/pipe-router.test.ts).

export interface SealProof {
  side: "start" | "goal"
  /** Tiles of the enclosed side the flood reached before running out. */
  tiles: number
  /** B28/B63: the flood hit a window/cap boundary, so this is not a proof. */
  edge: boolean
}

export interface SealOutcome {
  /** The enclosed side, when the flood ran out before meeting the other side. */
  proof?: SealProof
  /** States the flood visited (work). */
  visited: number
  /** True when the cap was hit before the pocket ran out: no conclusion. */
  inconclusive: boolean
}

export interface SealTransport {
  /** Encoded states on the goal side. Each must already pass the transport's own arrival rule. */
  goals: number[]
  /** Reverse moves: emit every predecessor state of `state` under the transport's real, cost-free moves. */
  before: (this: void, state: number, emit: (this: void, prev: number) => void) => void
  /** Whether a state is one of the start side's actual seed states (the provider port or a tap start). */
  start: (this: void, state: number) => boolean
  /** Whether the flood left the search's window; an edge-cut proof is not enclosure. */
  edge?: (this: void) => boolean
  /** Most states to expand; 0 disables the proof. */
  cap: number
}

/**
 * Reverse flood from `goals` over `before`. The transport's encoding must keep the tile in the high bits
 * (`floor(state / 4)`), as both routers' `(tile, heading)` codes do.
 */
export function proveSealFromGoal(t: SealTransport): SealOutcome {
  const cap = t.cap
  if (cap <= 0) return { visited: 0, inconclusive: false }
  if (t.goals.length === 0) return { proof: { side: "goal", tiles: 0, edge: false }, visited: 0, inconclusive: false }
  const seen: Record<number, boolean> = {}
  const queue: number[] = []
  const push = (state: number): void => {
    if (seen[state] === true) return
    seen[state] = true
    queue.push(state)
  }
  for (const g of t.goals) push(g)
  const tiles: Record<number, boolean> = {}
  let visited = 0
  while (visited < queue.length) {
    if (visited >= cap) return { visited, inconclusive: true }
    const state = queue[visited]
    visited++
    if (t.start(state)) return { visited, inconclusive: false }
    tiles[math.floor(state / 4)] = true
    t.before(state, push)
  }
  let n = 0
  for (const [,] of pairs(tiles)) n++
  return { proof: { side: "goal", tiles: n, edge: t.edge !== undefined && t.edge() }, visited, inconclusive: false }
}
