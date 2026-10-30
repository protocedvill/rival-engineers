// D62 (user, 2026-10-21): radar exploration arms. Within the home zone (HOME_SCANS × scan-radius of the hub) plans
// generate and scan chunks themselves; beyond it the planner knows only chunks the faction has charted (radars) and the
// strips its crew explored while laying an arm's pole line. When a mine finds no free patch of its ore, the faction
// builds one radar outpost at a time on the N, E, S, W arms in turn. Pure helpers: no Factorio globals (T1-tested).

import { Rect, tkey, Vec } from "../planner/grid"

/** Home zone radius in scan radii (3 × 128 = 384 tiles): bootstrap exploration (H7) and plan regions stop there. */
export const HOME_SCANS = 3
/** Distance from the hub of an arm's first outpost (tiles). Agent guess the user accepted ("Spacing is fine"). */
export const ARM_FIRST = 400
/** Distance between outposts along an arm (tiles). Agent guess the user accepted. */
export const ARM_SPACING = 200
/** Half width of the strip the crew explores along an arm while it builds (tiles). Agent guess. */
export const ARM_STRIP_HALF = 32
/** After an outpost is built, give up waiting for its nearby scan after this many ticks (5 game-min). Agent guess. */
export const ARM_SCAN_WAIT = 5 * 3600

export const ARM_NAMES = ["N", "E", "S", "W"]
const ARM_DX = [0, 1, 0, -1]
const ARM_DY = [-1, 0, 1, 0]

/** Where outpost `step` (0 = first) of `arm` goes. */
export function armTarget(hub: Vec, arm: number, step: number): Vec {
  const d = ARM_FIRST + ARM_SPACING * step
  return { x: math.floor(hub.x) + ARM_DX[arm] * d, y: math.floor(hub.y) + ARM_DY[arm] * d }
}

/** The strip the crew explores along `arm` out to `target`: from the home zone's edge to just past the target. */
export function armStrip(hub: Vec, arm: number, homeRadius: number, target: Vec): Rect {
  const hx = math.floor(hub.x)
  const hy = math.floor(hub.y)
  const half = ARM_STRIP_HALF
  const far = math.abs(target.x - hx) + math.abs(target.y - hy) + half
  const near = homeRadius - half
  if (ARM_DX[arm] !== 0) {
    const x = ARM_DX[arm] > 0 ? hx + near : hx - far
    return { x, y: hy - half, w: far - near + 1, h: 2 * half + 1 }
  }
  const y = ARM_DY[arm] > 0 ? hy + near : hy - far
  return { x: hx - half, y, w: 2 * half + 1, h: far - near + 1 }
}

/** The home zone: a square, like the plan regions it bounds. */
export function homeRect(hub: Vec, homeRadius: number): Rect {
  const hx = math.floor(hub.x)
  const hy = math.floor(hub.y)
  return { x: hx - homeRadius, y: hy - homeRadius, w: 2 * homeRadius, h: 2 * homeRadius }
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = math.min(a.x, b.x)
  const y = math.min(a.y, b.y)
  return { x, y, w: math.max(a.x + a.w, b.x + b.w) - x, h: math.max(a.y + a.h, b.y + b.h) - y }
}

function chunkTouches(cx: number, cy: number, r: Rect): boolean {
  return cx * 32 < r.x + r.w && r.x < cx * 32 + 32 && cy * 32 < r.y + r.h && r.y < cy * 32 + 32
}

/** What a faction may scan beyond its own home zone (persisted with the plan options). */
export interface KnownGround {
  home: Rect
  explored: Rect[]
  /** P43 (a): chunks the faction's radars scanned (`tkey` of the chunk position). */
  scanned?: Record<number, boolean>
}

/**
 * May the planner scan chunk (cx, cy)? Home zone and explored strips always; elsewhere only chunks the faction's radars
 * scanned, or charted ones (a radar charts nothing for a force with no players: P43).
 */
export function chunkKnown(cx: number, cy: number, known: KnownGround, charted: (this: void, cx: number, cy: number) => boolean): boolean {
  if (chunkTouches(cx, cy, known.home)) return true
  for (const r of known.explored) if (chunkTouches(cx, cy, r)) return true
  if (known.scanned?.[tkey(cx, cy)] === true) return true
  return charted(cx, cy)
}

/** Chunk positions within `r` chunks of the chunk holding `pos` (a radar's nearby square). */
export function chunksAround(pos: Vec, r: number): Vec[] {
  const cx = math.floor(pos.x / 32)
  const cy = math.floor(pos.y / 32)
  const out: Vec[] = []
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) out.push({ x, y })
  return out
}

