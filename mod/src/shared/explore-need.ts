/**
 * D70 (user decision in-session, 2026-10-30): exploration (D62) for extra capacity never fails a soak; only a search for
 * something the factory can't run without starts the fail-fast clock. A search is for extra capacity when the faction
 * already has a working producer of what it looks for (a built factory node or bootstrap site making that item), and
 * required otherwise. Two factions, seed 3333: a third power block's coal was searched for from 142 min and never
 * found, while the faction met the science bar at 213 and reached v1-done at 252.
 *
 * Pure (no game types) so the rule is T1-tested.
 */
export type ExploreNeed = "required" | "extra capacity"

export interface Producer {
  item?: string
  built: boolean
}

export function exploreNeed(producers: readonly Producer[], what: string): ExploreNeed {
  for (const p of producers) if (p.built && p.item === what) return "extra capacity"
  return "required"
}
