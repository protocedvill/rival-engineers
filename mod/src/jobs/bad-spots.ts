// B111 (fixed seed 222, `m7a-fixed222-1e01f8b`): standing spots the crew could not walk to. The batch planner picks the
// spot nearest the member that reaches every job; when the pathfinder finds no way there (a one-tile corridor between
// steam-engine rows, closed by poles), the job failed at the spot and the next plan picked the same spot, for hours.
// A spot whose walk found no path is avoided for a while, so the planner picks the next spot within reach.
//
// Pure: no Factorio globals (T1: mod/unit/bad-spots.test.ts).

import type { Pos, Rect } from "./board"

/** How long a spot the pathfinder could not reach is avoided (agent guess: long enough to move on, short enough that a
 * cleared obstacle is tried again). */
export const BAD_SPOT_TICKS = 10 * 3600

/**
 * How far around an unreachable spot the planner stays away (agent guess). The next spot nearest the member is usually
 * a tile over, in the same pocket (fixed seed 222: a four-tile stretch of corridor between two poles).
 */
export const BAD_SPOT_RADIUS = 2.5

function key(p: Pos): string {
  return `${math.floor(p.x * 2) / 2},${math.floor(p.y * 2) / 2}`
}

/** Remembers that the walk to `p` found no path at `tick`. */
export function recordBadSpot(spots: Record<string, number>, p: Pos, tick: number): void {
  spots[key(p)] = tick + BAD_SPOT_TICKS
}

/** The spots still avoided at `tick`, as rects for `chooseStandingSpot`; expired ones are dropped. */
export function badSpotRects(spots: Record<string, number> | undefined, tick: number): Rect[] {
  const out: Rect[] = []
  if (spots === undefined) return out
  for (const [k, until] of pairs(spots)) {
    if (until <= tick) {
      delete spots[k as string]
      continue
    }
    const [xs, ys] = string.match(k as string, "^(-?[%d%.]+),(-?[%d%.]+)$")
    const x = tonumber(xs)!
    const y = tonumber(ys)!
    out.push({ x1: x - BAD_SPOT_RADIUS, y1: y - BAD_SPOT_RADIUS, x2: x + BAD_SPOT_RADIUS, y2: y + BAD_SPOT_RADIUS })
  }
  return out
}
