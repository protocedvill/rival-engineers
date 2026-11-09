// B176 (m7-fresh4 seeds 11 and 3333): standing spots the pathfinder never reaches. A steam block's engine columns
// leave a one-tile corridor between them with a small pole every five tiles; a character fits beside a pole (0.6
// tiles) and `can_place_entity` says the spot is free, but the pathfinder does not pass there (engine-capabilities
// "B176 finding"). The batch planner picked such a spot, the walk found no path, B111 avoided it for ten minutes, and
// the planner picked it again: 23 times for one spot in one run.
//
// A spot is accepted only if a flood from it over the half-tile grid gets `POCKET_ESCAPE` tiles away, stepping only on
// nodes with a clear square of `POCKET_CLEARANCE` around them (the model matches every probe of the finding). A spot
// without such a square of its own starts from its clear neighbours half a tile away.
//
// Pure: no Factorio globals (T1: mod/unit/pockets.test.ts).

import type { Pos, Rect } from "./board"

/** Half the side of the clear square a node needs to count as walkable for the pathfinder (agent guess, fits the B176
 * finding: a 0.6-tile gap beside a pole is closed, a 1.5-tile corridor between engines is open). */
export const POCKET_CLEARANCE = 0.5

/** How far (tiles, either axis) a flood from a spot must get to count as open ground (agent guess: past a steam block's
 * five-tile pole spacing). */
export const POCKET_ESCAPE = 6

const STEP = 0.5
const EPS = 1e-6

/** Whether the walkable ground around `spot` is a pocket the pathfinder cannot enter (or the spot is not walkable). */
export function inPocket(spot: Pos, blockers: Rect[], clearance = POCKET_CLEARANCE, escape = POCKET_ESCAPE): boolean {
  // Index blockers by the tiles they touch, so each node checks only its neighbourhood.
  const byTile: Record<string, Rect[]> = {}
  for (const r of blockers) {
    for (let x = Math.floor(r.x1); x <= Math.floor(r.x2); x++) {
      for (let y = Math.floor(r.y1); y <= Math.floor(r.y2); y++) {
        const k = `${x},${y}`
        byTile[k] ??= []
        byTile[k].push(r)
      }
    }
  }
  const walkable = (x: number, y: number): boolean => {
    const x1 = x - clearance + EPS
    const x2 = x + clearance - EPS
    const y1 = y - clearance + EPS
    const y2 = y + clearance - EPS
    for (let tx = Math.floor(x1); tx <= Math.floor(x2); tx++) {
      for (let ty = Math.floor(y1); ty <= Math.floor(y2); ty++) {
        for (const r of byTile[`${tx},${ty}`] ?? []) if (r.x1 < x2 && r.x2 > x1 && r.y1 < y2 && r.y2 > y1) return false
      }
    }
    return true
  }
  const limit = escape / STEP
  const seen: Record<string, boolean> = { "0,0": true }
  const queue: [number, number][] = []
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (walkable(spot.x, spot.y)) queue.push([0, 0])
  else {
    // A spot beside a machine on open ground has no clear square of its own, but the character standing there (the
    // caller checked it fits) steps half a tile onto one: the pathfinder reached such spots (engine-capabilities B176).
    for (const [di, dj] of dirs) {
      seen[`${di},${dj}`] = true
      if (walkable(spot.x + di * STEP, spot.y + dj * STEP)) queue.push([di, dj])
    }
  }
  let head = 0
  while (head < queue.length) {
    const [i, j] = queue[head++]
    if (Math.abs(i) >= limit || Math.abs(j) >= limit) return false
    for (const [di, dj] of dirs) {
      const ni = i + di
      const nj = j + dj
      const k = `${ni},${nj}`
      if (seen[k]) continue
      seen[k] = true
      if (walkable(spot.x + ni * STEP, spot.y + nj * STEP)) queue.push([ni, nj])
    }
  }
  return true
}
