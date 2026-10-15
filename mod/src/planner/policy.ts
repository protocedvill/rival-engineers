// LayoutPolicy (SPEC §5.3): how a faction lays out its base at a given stage. Policies are data plus small
// registered strategy functions (packing scorers), selected per faction through config (§5.7: `layout-policy`,
// `auto` by default), so new ones can be added without touching the planner and A/B-tested in soak runs.
// Pure: no Factorio globals.

export interface LayoutContext {
  /** Technologies researched by the faction. */
  researched?: Record<string, boolean>
  /** Placed modules so far. */
  modules?: number
  /** Fraction of the planning region that is free land (0..1). */
  freeSpace?: number
}

export type OverflowAction = "upgrade-tier" | "parallel-route" | "new-producer-cluster"

export interface RouterWeights {
  /** Extra cost of a turn (belt tiles cost 1). */
  turn: number
  /** Cost of an underground pair (two entities: ~17 plates of material vs 1.5 per belt tile). */
  underground: number
  /** Cost of a splitter tap. */
  splitter: number
  /** Extra cost per tree or rock to clear (when the policy clears them). */
  clearTree: number
  clearRock: number
  /** Extra cost of a belt on ore (it blocks future mining there). */
  oreTile: number
  /** Cost factor of a tile in a reserved corridor (< 1: routes prefer corridors). */
  corridorFactor: number
  /** Extra cost of passing through another route's tile in rip-up mode. */
  rip: number
  /** Times a connection may be ripped up before routing gives up on it. */
  maxRipups: number
  /** Search window margin around a connection's endpoints (tiles). */
  margin: number
  /** Undergrounds may pass under module footprints. */
  underModules: boolean
}

export interface PlacementWeights {
  /** Per tile of distance from the cluster centre. */
  center: number
  /** Per tile from a belt port to where its connection comes from. */
  port: number
  /** A port facing away from its connection. */
  facing: number
  /** Per clear-cost unit of trees and rocks in the footprint. */
  clear: number
  /** Bonus per module tile within the preferred corridor of the footprint (compact clustering). */
  adjacent: number
  /** Extra bonus per module tile at exactly the preferred corridor width. */
  exactGap: number
  /** Mining modules: penalty per missing fraction of ore coverage. */
  coverage: number
}

export interface LayoutPolicy {
  id: string
  /** Suitability for the stage/terrain/tech (highest wins under `auto`). */
  applies(this: void, ctx: LayoutContext): number
  /** Tiles between modules: `min` is enforced, `preferred` is what packing aims for (and reserves as corridor). */
  corridor: { min: number; preferred: number }
  moduleSelection: { preferGenerated: boolean; variants?: string[] }
  /** Packing strategy: a registered scorer (`registerPacking`). */
  packing: string
  expansion: "expand-first" | "new-module-first"
  obstacles: { trees: "clear" | "avoid"; rocks: "clear" | "avoid"; maxClearCost: number }
  /** D22: how one producer feeds several consumers. */
  topology: "point-to-point" | "splitter-tap"
  /**
   * D35: where smelters go. compact-core: with the rest of the factory (their ore outposts are placed after them, on
   * the ore nearest them; ore is belted in). near-ore: the ore outpost first (on the ore nearest the cluster centre),
   * the smelter next to it (plates are belted in). A/B-tested in M6.
   */
  smelting: "compact-core" | "near-ore"
  /** Never put a non-mining module on ore (routes over ore pay `router.oreTile`). */
  protectOre: boolean
  /** Mining modules: each drill's mining area must be at least this fraction ore of the module's resource. */
  minOreCoverage: number
  /** Placement search radii tried in turn around the target point. */
  searchRadii: number[]
  /** D25: plan edges up to this fraction of nominal capacity. */
  utilization: number
  /** D24: remedies tried in order when an edge overflows; most parallel routes before a new cluster. */
  overflow: { order: OverflowAction[]; maxParallel: number }
  /** D27: corridors and space sized for this multiple of the current target. */
  headroom: number
  router: RouterWeights
  placement: PlacementWeights
}

/** Packing scorer: extra score for a candidate (lower is better), from its precomputed features. */
export interface CandidateFeatures {
  /** Manhattan distance from the footprint centre to the cluster centre. */
  centerDist: number
  /** Sum of port-to-target distances and the number of ports facing away. */
  portDist: number
  facingAway: number
  clearCost: number
  /** Module tiles within the preferred corridor, and at exactly the preferred width. */
  adjacent: number
  exactGap: number
  /** Mining modules: ore coverage of the mining areas (0..1). */
  coverage: number
}

export type PackingScorer = (this: void, f: CandidateFeatures, policy: LayoutPolicy) => number

const packings: Record<string, PackingScorer> = {}
const policies: Record<string, LayoutPolicy> = {}
const policyOrder: string[] = []

export function registerPacking(name: string, scorer: PackingScorer): void {
  packings[name] = scorer
}

export function packingScorer(name: string): PackingScorer {
  const s = packings[name]
  if (s === undefined) error(`unknown packing strategy ${name}`)
  return s
}

export function registerPolicy(p: LayoutPolicy): void {
  if (policies[p.id] === undefined) policyOrder.push(p.id)
  policies[p.id] = p
}

export function getPolicy(id: string): LayoutPolicy | undefined {
  return policies[id]
}

export function policyIds(): string[] {
  return [...policyOrder]
}

/** Compact cluster: close to the centre and to the module's connections, hugging neighbours at the preferred gap. */
registerPacking("compact-cluster", (f, p) => {
  const w = p.placement
  return (
    w.center * f.centerDist +
    w.port * f.portDist +
    w.facing * f.facingAway +
    w.clear * f.clearCost -
    w.adjacent * f.adjacent -
    w.exactGap * f.exactGap +
    w.coverage * (1 - f.coverage)
  )
})

/** The v1 early-game policy (SPEC §5.3): compact cluster, 1–2-tile corridors, expand-first, clear trees and rocks. */
export const EARLY_COMPACT: LayoutPolicy = {
  id: "early-compact",
  applies: (ctx) => ((ctx.modules ?? 0) < 40 ? 1 : 0.1),
  corridor: { min: 1, preferred: 2 },
  moduleSelection: { preferGenerated: true },
  packing: "compact-cluster",
  expansion: "expand-first",
  obstacles: { trees: "clear", rocks: "clear", maxClearCost: 400 },
  topology: "point-to-point",
  smelting: "compact-core",
  protectOre: true,
  minOreCoverage: 0.6,
  searchRadii: [24, 48, 96],
  utilization: 0.99,
  overflow: { order: ["upgrade-tier", "parallel-route", "new-producer-cluster"], maxParallel: 2 },
  headroom: 2,
  router: {
    turn: 0.5,
    underground: 8,
    splitter: 4,
    clearTree: 2,
    clearRock: 4,
    oreTile: 3,
    corridorFactor: 0.9,
    rip: 25,
    maxRipups: 3,
    margin: 24,
    underModules: false,
  },
  placement: { center: 1, port: 1.5, facing: 12, clear: 0.5, adjacent: 0.4, exactGap: 0.2, coverage: 80 },
}
registerPolicy(EARLY_COMPACT)

/** Config overrides a faction may apply to its policy (SPEC §5.7). Absent/0/"" = keep the policy's value. */
export interface PolicyOverrides {
  corridorMin?: number
  corridorPreferred?: number
  topology?: string
  utilization?: number
  smelting?: string
}

/**
 * The policy for a faction: `id` names one ("auto" or empty: the registered policy with the highest `applies`),
 * then config overrides apply to a copy.
 */
export function selectPolicy(id: string | undefined, ctx: LayoutContext, overrides: PolicyOverrides = {}): LayoutPolicy {
  let chosen: LayoutPolicy | undefined
  if (id !== undefined && id !== "" && id !== "auto") {
    chosen = policies[id]
    if (chosen === undefined) error(`unknown layout policy ${id}`)
  } else {
    let best = -math.huge
    for (const pid of policyOrder) {
      const s = policies[pid].applies(ctx)
      if (s > best) {
        best = s
        chosen = policies[pid]
      }
    }
  }
  if (chosen === undefined) error("no layout policy registered")
  const p: LayoutPolicy = { ...chosen, corridor: { ...chosen.corridor } }
  if (overrides.corridorMin !== undefined && overrides.corridorMin > 0) p.corridor.min = overrides.corridorMin
  if (overrides.corridorPreferred !== undefined && overrides.corridorPreferred > 0) p.corridor.preferred = overrides.corridorPreferred
  if (p.corridor.preferred < p.corridor.min) p.corridor.preferred = p.corridor.min
  if (overrides.topology === "point-to-point" || overrides.topology === "splitter-tap") p.topology = overrides.topology
  if (overrides.utilization !== undefined && overrides.utilization > 0) p.utilization = overrides.utilization
  if (overrides.smelting === "compact-core" || overrides.smelting === "near-ore") p.smelting = overrides.smelting
  return p
}
