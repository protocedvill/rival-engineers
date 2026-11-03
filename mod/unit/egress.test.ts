// Joint egress of a module's belt ports (planner/egress.ts): tile-disjoint paths out of a box.

import { disjointEgress, newEgress, stepEgress } from "../src/planner/egress"
import { Vec } from "../src/planner/grid"
import { eq, run, test } from "./harness"

/** A grid from rows: "." free, "#" wall an underground can pass under, "M" a module (no underground), else free. */
function ground(rows: string[], hop = 0) {
  const ch = (x: number, y: number): string => {
    const r = rows[y]
    if (r === undefined || x < 0 || x >= r.length) return "."
    return r.substring(x, x + 1)
  }
  return {
    free: (x: number, y: number) => ch(x, y) === "." || ch(x, y) === "s",
    under: hop > 0 ? (x: number, y: number) => ch(x, y) !== "M" : undefined,
    hop,
  }
}

function starts(rows: string[]): Vec[] {
  const out: Vec[] = []
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) if (rows[y].substring(x, x + 1) === "s") out.push({ x, y })
  return out
}

/** The box is the whole drawing: tiles off it are the way out. */
function egress(rows: string[], hop = 0): number {
  return disjointEgress(starts(rows), ground(rows, hop), { x: 0, y: 0, w: rows[0].length, h: rows.length }, [])
}

test("egress: each start in its own corridor leaves; a shared one-tile gap lets one out", () => {
  eq(egress(["#.#.#", "#.#.#", "#s#s#"]), 2)
  eq(egress(["##.##", "#...#", "#s.s#", "#####"]), 1)
  eq(egress(["#..##", "#...#", "#s.s#", "#####"]), 2)
})

test("egress: a start walled in, or no start free, leaves nothing", () => {
  eq(egress(["#####", "#s.s#", "#####"]), 0)
  eq(egress([".....", ".MMM.", "....."].map((r) => r), 0), 0)
})

test("egress: the second path reroutes the first (reverse flow)", () => {
  // The first start (x 4) takes the gap above x 5 first (BFS order); the second (x 6) has no other way out, so the
  // first must be rerouted west along the corridor and out at x 1.
  const rows = [
    "#####.##",
    "#####.##",
    "#...s.s#",
    "#.######",
  ]
  eq(egress(rows), 2)
})

test("egress: undergrounds hop walls but not modules", () => {
  // Two tiles of wall on every side; the way out is three tiles on, within an underground's reach.
  const walls = ["#####", "#####", "##s##", "#####", "#####"]
  eq(egress(walls, 0), 0)
  eq(egress(walls, 4), 1)
  eq(egress(walls, 2), 0, "the span is too short to clear two tiles")
  eq(egress(["MMMMM", "MMMMM", "MMsMM", "MMMMM", "MMMMM"], 4), 0)
})

test("egress: reaching a connection's target counts as out", () => {
  const rows = ["#######", "#s...t#", "#######"]
  const g = ground(rows)
  eq(disjointEgress(starts(rows), g, { x: 0, y: 0, w: 7, h: 3 }, [{ x: 5, y: 1 }]), 1)
  eq(disjointEgress(starts(rows), g, { x: 0, y: 0, w: 7, h: 3 }, []), 0)
})

test("egress: a job stepped a few nodes at a time gives the same answer", () => {
  const rows = ["#####.##", "#####.##", "#...s.s#", "#.######"]
  const job = newEgress(starts(rows), { x: 0, y: 0, w: 8, h: 4 }, [])
  let steps = 0
  while (!job.done) {
    stepEgress(job, ground(rows), 3)
    steps++
  }
  eq(job.paths, 2)
  eq(steps > 5, true, "it took several steps")
})

run("egress")
