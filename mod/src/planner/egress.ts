// Joint egress of a module's belt ports (seed 11 g104, m7c-cont3): placement checked each port's lane on its own, so a
// spot whose four belts all had to pass one gap three belts wide was accepted; the plan then spent ~48M work units with
// its new belts ripping each other up in a cycle (sulfur ripped engine units, which ripped the pack output, ...) until
// the module moved, twice. Here: how many belts can leave the module's surroundings *at the same time*, no two sharing
// a tile: a max-flow with unit tile capacities from the ports' lane starts to any free tile outside a box around the
// module (or to within a tile of a connection's target). Undergrounds hop straight over tiles they may pass under, as
// the lane checks allow.
//
// Unit tile capacities mean a tile carries at most one path, so the flow is kept as one predecessor and one successor
// per tile (no edge table). The job is plain data (it lives in a planner job in `storage`) and runs in budgeted steps;
// the ground functions are passed to each step. Pure: no Factorio globals (T1: mod/unit/egress.test.ts).

import { DX, DY, keyX, keyY, Rect, rectContains, tkey, Vec } from "./grid"

export interface EgressGround {
  /** A belt may be laid on the tile. */
  free: (this: void, x: number, y: number) => boolean
  /** An underground may pass under the tile. */
  under?: (this: void, x: number, y: number) => boolean
  /** Longest underground span (tiles from entrance to exit). */
  hop: number
}

export interface EgressJob {
  starts: number[]
  box: Rect
  /** Tiles within one of a connection's target (a path reaching one is out). */
  near: Record<number, boolean>
  /** The flow: the tile a path enters each tile from (SOURCE at a start) and leaves it to (SINK at its end). */
  pred: Record<number, number | undefined>
  succ: Record<number, number | undefined>
  used: Record<number, boolean>
  /** `free` answers so far (the ground does not change while a placement search runs). */
  freeCache: Record<number, boolean>
  /** The augmenting search in progress: BFS over (tile, side) nodes, id = 2·key + side (0 entering, 1 leaving). */
  bfs?: { parent: Record<number, number>; queue: number[]; qi: number }
  paths: number
  done: boolean
}

const SOURCE = -1
const SINK = -2

export function newEgress(starts: Vec[], box: Rect, targets: Vec[]): EgressJob {
  const near: Record<number, boolean> = {}
  for (const t of targets) {
    near[tkey(t.x, t.y)] = true
    for (let d = 0; d < 4; d++) near[tkey(t.x + DX[d], t.y + DY[d])] = true
  }
  return { starts: starts.map((s) => tkey(s.x, s.y)), box, near, pred: {}, succ: {}, used: {}, freeCache: {}, paths: 0, done: starts.length === 0 }
}

/** Runs the job for about `budget` nodes (at least one augmenting step); returns the nodes searched. */
export function stepEgress(job: EgressJob, g: EgressGround, budget: number): number {
  const { pred, succ, used } = job
  const isFree = (k: number): boolean => {
    let f = job.freeCache[k]
    if (f === undefined) {
      f = g.free(keyX(k), keyY(k))
      job.freeCache[k] = f
    }
    return f
  }
  const isSink = (k: number): boolean => job.near[k] === true || !rectContains(job.box, keyX(k), keyY(k))
  /** Tiles a belt on `k` can go to next: its free neighbours, and underground exits over a blocked neighbour. */
  const nexts = (k: number): number[] => {
    const x = keyX(k)
    const y = keyY(k)
    const out: number[] = []
    for (let d = 0; d < 4; d++) {
      const nk = tkey(x + DX[d], y + DY[d])
      if (isFree(nk)) {
        out.push(nk)
        continue
      }
      if (g.under === undefined) continue
      for (let n = 2; n <= g.hop; n++) {
        if (!g.under(x + DX[d] * (n - 1), y + DY[d] * (n - 1))) break
        const ek = tkey(x + DX[d] * n, y + DY[d] * n)
        if (isFree(ek)) {
          out.push(ek)
          break
        }
      }
    }
    return out
  }

  let n = 0
  while (!job.done && n < budget) {
    if (job.bfs === undefined) {
      const parent: Record<number, number> = {}
      const queue: number[] = []
      for (const k of job.starts) {
        if (pred[k] === SOURCE || !isFree(k) || parent[2 * k] !== undefined) continue
        parent[2 * k] = SOURCE
        queue.push(2 * k)
      }
      job.bfs = { parent, queue, qi: 0 }
    }
    const b = job.bfs
    const parent = b.parent
    let found: number | undefined
    while (b.qi < b.queue.length && n < budget) {
      const id = b.queue[b.qi]
      b.qi++
      n++
      const k = math.floor(id / 2)
      if (id % 2 === 0) {
        // Entering k: through it (if it carries no path), or back along the path that enters it.
        const p = pred[k]
        if (!used[k]) visit(b, id, 2 * k + 1)
        else if (p !== undefined && p !== SOURCE) visit(b, id, 2 * p + 1)
      } else {
        // Leaving k: to the way out, or back through k (it carries a path), or on to a next tile (not along k's path).
        if (isSink(k) && succ[k] === undefined) {
          found = id
          break
        }
        if (used[k]) visit(b, id, 2 * k)
        if (isSink(k)) continue
        for (const nk of nexts(k)) if (succ[k] !== nk) visit(b, id, 2 * nk)
      }
    }
    if (found === undefined) {
      // Out of budget mid-search (resume next step), or no augmenting path left (the flow is maximal).
      if (b.qi >= b.queue.length) {
        job.bfs = undefined
        job.done = true
      }
      break
    }
    augment(job, parent, found)
    job.bfs = undefined
    job.paths++
    if (job.paths >= job.starts.length) job.done = true
  }
  return n
}

function visit(b: NonNullable<EgressJob["bfs"]>, from: number, to: number): void {
  if (b.parent[to] !== undefined) return
  b.parent[to] = from
  b.queue.push(to)
}

/** Applies the augmenting path ending at node `found` (walked back through `parent`), source to sink. */
function augment(job: EgressJob, parent: Record<number, number>, found: number): void {
  const { pred, succ, used } = job
  const steps: number[] = [found]
  let at = found
  while (parent[at] !== SOURCE) {
    at = parent[at]
    steps.push(at)
  }
  steps.reverse()
  pred[math.floor(steps[0] / 2)] = SOURCE
  for (let i = 0; i + 1 < steps.length; i++) {
    const a = steps[i]
    const b = steps[i + 1]
    const ka = math.floor(a / 2)
    const kb = math.floor(b / 2)
    if (ka === kb) used[ka] = a % 2 === 0
    else if (a % 2 === 1) {
      // Forward: ka → kb.
      succ[ka] = kb
      pred[kb] = ka
    } else {
      // Backward: undo kb → ka (a later forward step may already have given ka a new predecessor).
      if (succ[kb] === ka) succ[kb] = undefined
      if (pred[ka] === kb) pred[ka] = undefined
    }
  }
  succ[math.floor(found / 2)] = SINK
}

/** The whole job in one call (tests and small checks): how many tile-disjoint paths lead out. */
export function disjointEgress(starts: Vec[], g: EgressGround, box: Rect, targets: Vec[], work?: { n: number }): number {
  const job = newEgress(starts, box, targets)
  while (!job.done) {
    const used = stepEgress(job, g, 1e9)
    if (work !== undefined) work.n += used
  }
  return job.paths
}
