// Edge capacity math and the D24 overflow decision (SPEC §5.8). Pure: no Factorio globals.
//
// A belt edge carries one item (D23) on up to two lanes: capacity = lanes × lane capacity of its tier (yellow 7.5/s per
// lane, 15/s per belt; red 30; blue 45). It is planned up to `utilization` (D25, default 99%) of that. Its endpoints
// can be the binding limit instead: the producer's port rate (inserter-limited, from the module's rate engine) and
// the consumer's intake.

import { ProtoFacts } from "../modules/facts"
import { OverflowAction } from "./policy"

export interface BeltTier {
  belt: string
  underground: string
  splitter: string
  /** Items/s per lane. */
  laneCapacity: number
  /** Farthest exit offset of an underground pair. */
  maxUnderground: number
  /** Technology that unlocks the belt (undefined: available from the start). */
  tech?: string
}

export const DEFAULT_TIER_NAMES: { belt: string; underground: string; splitter: string }[] = [
  { belt: "transport-belt", underground: "underground-belt", splitter: "splitter" },
  { belt: "fast-transport-belt", underground: "fast-underground-belt", splitter: "fast-splitter" },
  { belt: "express-transport-belt", underground: "express-underground-belt", splitter: "express-splitter" },
]

/** Belt tiers from prototypes, slowest first (tiers whose belt is unknown are skipped). */
export function beltTiers(facts: ProtoFacts, names = DEFAULT_TIER_NAMES): BeltTier[] {
  const out: BeltTier[] = []
  for (const n of names) {
    const b = facts.entity(n.belt)
    if (b === undefined || b.beltSpeed === undefined) continue
    out.push({
      belt: n.belt,
      underground: n.underground,
      splitter: n.splitter,
      laneCapacity: b.beltSpeed * 60 * 4,
      maxUnderground: facts.entity(n.underground)?.maxUnderground ?? 5,
      tech: facts.unlockedBy(facts.recipeForItem(n.belt) ?? n.belt),
    })
  }
  out.sort((a, b) => a.laneCapacity - b.laneCapacity)
  return out
}

export function tierByBelt(tiers: BeltTier[], belt: string): BeltTier | undefined {
  for (const t of tiers) if (t.belt === belt) return t
  return undefined
}

/** Tiers the faction can build: no tech needed, or the tech is researched. */
export function availableTiers(tiers: BeltTier[], researched: Record<string, boolean>): BeltTier[] {
  return tiers.filter((t) => t.tech === undefined || researched[t.tech] === true)
}

export interface CapacityCheck {
  /** Nominal items/s of the belt (lanes × lane capacity). */
  capacity: number
  /** capacity × utilization (D25). */
  usable: number
  planned: number
  /** planned / capacity. */
  utilization: number
  /** What limits the edge below the planned rate, if anything. */
  limitedBy?: "belt" | "producer" | "consumer"
  ok: boolean
}

export interface EdgeLimits {
  tier: BeltTier
  /** Lanes the producer fills (2 unless the port says otherwise). */
  lanes: number
  /** D25 cap (0..1]. */
  utilization: number
  /** The producer port's rate (items/s) and the consumer port's intake, if known. */
  producerMax?: number
  consumerMax?: number
}

const EPS = 1e-9

export function checkEdge(planned: number, e: EdgeLimits): CapacityCheck {
  const capacity = e.tier.laneCapacity * e.lanes
  const usable = capacity * e.utilization
  let limitedBy: CapacityCheck["limitedBy"]
  if (e.producerMax !== undefined && planned > e.producerMax + EPS) limitedBy = "producer"
  else if (e.consumerMax !== undefined && planned > e.consumerMax + EPS) limitedBy = "consumer"
  else if (planned > usable + EPS) limitedBy = "belt"
  return { capacity, usable, planned, utilization: capacity > 0 ? planned / capacity : math.huge, limitedBy, ok: limitedBy === undefined }
}

export type OverflowDecision =
  | { action: "none" }
  | { action: "upgrade-tier"; belt: string; usable: number }
  | { action: "parallel-route"; routes: number; usableEach: number }
  | { action: "new-producer-cluster"; reason: string }

export interface OverflowInput {
  /** Planned demand on the edge, items/s. */
  demand: number
  edge: EdgeLimits
  /** Tiers the faction can build now (availableTiers). */
  available: BeltTier[]
  order: OverflowAction[]
  maxParallel: number
}

/**
 * D24: what to do when demand exceeds what the edge can carry. Tries the policy's remedies in order:
 * - `upgrade-tier`: the slowest available faster tier whose usable capacity covers the demand;
 * - `parallel-route`: n = ⌈demand / usable⌉ routes of the current tier, if n ≤ maxParallel;
 * - `new-producer-cluster`: build another producer cluster sized for growth.
 * An edge limited by its producer port (or consumer intake) is not a belt problem: only a new cluster helps.
 * In v1 the planner only emits the decision; M5 acts on it.
 */
export function decideOverflow(input: OverflowInput): OverflowDecision {
  const check = checkEdge(input.demand, input.edge)
  if (check.ok) return { action: "none" }
  if (check.limitedBy === "producer") return { action: "new-producer-cluster", reason: `producer port limited (${input.edge.producerMax}/s < ${input.demand}/s)` }
  if (check.limitedBy === "consumer") return { action: "new-producer-cluster", reason: `consumer intake limited (${input.edge.consumerMax}/s < ${input.demand}/s)` }
  for (const action of input.order) {
    if (action === "upgrade-tier") {
      for (const t of input.available) {
        if (t.laneCapacity <= input.edge.tier.laneCapacity) continue
        const usable = t.laneCapacity * input.edge.lanes * input.edge.utilization
        if (usable + EPS >= input.demand) return { action: "upgrade-tier", belt: t.belt, usable }
      }
    } else if (action === "parallel-route") {
      const n = math.ceil(input.demand / check.usable - EPS)
      if (n <= input.maxParallel) return { action: "parallel-route", routes: n, usableEach: check.usable }
    } else if (action === "new-producer-cluster") {
      return { action: "new-producer-cluster", reason: `belt over capacity (${input.demand}/s > ${check.usable}/s usable)` }
    }
  }
  return { action: "new-producer-cluster", reason: "no remedy in the policy applies" }
}
