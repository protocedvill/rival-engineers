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
  /**
   * B7: cost factor of a tile next to another route's belt (< 1: routes bundle). Multiplies with `corridorFactor`.
   * Reserved tiles (port outside and approach tiles, P5/P15) stay blocked whatever the bonus.
   */
  bundleFactor?: number
  /**
   * B9 (D48 (4)): extra cost of a tile an expandable module can still grow into (its soft claim), in its next growth
   * unit. B52: was 0.5; a route crossed the steam block's whole growth strip for 7 extra (user: "10 or so").
   */
  softClaim?: number
  /**
   * B52 (user, 2026-10-20: "diminish a bit after every single expansion unit"): the soft-claim cost is multiplied by this
   * for each growth unit farther out. An underground crossing pays only its ends, so the far units must be much cheaper
   * than the near one: on seed 3333's g20 replay 10 / 0.5 crossed unit 5, 10 / 0.55 still unit 1.
   */
  softClaimDecay?: number
  /**
   * Seal check (user, 2026-10-20): before a route search, a relaxed flood from both ends proves "no path" when one end
   * is boxed in, at the cost of that end's enclosed tiles. It gives up (the search runs as before) after this many
   * tiles. 0: off.
   */
  sealCheck?: number
  /** Seal check cap on a retry after "no path" (rip pass, wider windows): 0 runs it to the end. */
  sealRetry?: number
  /**
   * Two-level routing (user, 2026-10-20): a connection whose ends are at least this far apart (Manhattan tiles) is
   * routed over `coarseCell`-tile cells first, then tile by tile inside a corridor of those cells. 0: off.
   */
  longRoute?: number
  /** Cell size (tiles) of the coarse search. */
  coarseCell?: number
  /** Corridor half-width around the coarse path, in cells (the ends get one more). */
  corridorCells?: number
  /** Heuristic weight inside a corridor (weighted A*: the route costs at most this times the corridor's best). */
  corridorWeight?: number
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
  /** D52: penalty per missing fraction of ore coverage of the first growth unit (the mine must be able to expand). */
  growthCoverage?: number
  /** B9 (D48 (4)): per footprint tile in another module's soft claim (the area it can still grow into). */
  softClaim?: number
  /**
   * B26: per footprint tile in the near part (the first `growthBandUnits` units) of another expandable module's growth
   * area, on top of `softClaim` and for partners too: the growth corridor that `tryExpand` needs first stays clear.
   */
  growthBand?: number
  /** B26: how many growth units, next to the module, count as its near band (`growthBand`). */
  growthBandUnits?: number
  /**
   * B26: an expandable non-mining module, per growth unit it could not grow by at this site: `tryExpand`'s checks
   * (terrain, ore, other modules and their corridor, routes, reservations, mine and soft claims) over its own band.
   */
  growthBlocked?: number
  /**
   * B45: a placement must leave every other module's unconnected port lane at least this many reachable tiles (0: off):
   * its footprint and margin ring, and a whole-patch mine's claim, must not wall the lane in.
   */
  portEscape?: number
  /**
   * D57: a new mine ranks the patches it may use by distance; a patch where the faction has no mine yet (a fresh
   * field) counts this many tiles farther.
   */
  newField?: number
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
  /** B37 `poleEvict`: placement/routing cost per pole-line tile taken (the line is evicted and re-poled). */
  obstacles: { trees: "clear" | "avoid"; rocks: "clear" | "avoid"; maxClearCost: number; poleEvict?: number }
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
  /** D52: ore coverage of the first growth unit (0..1) — a mine placed where it can't expand is a dead end. */
  growthCoverage?: number
  /** Footprint tiles in other modules' soft claims (B9). */
  softClaim?: number
  /** B26: footprint tiles in the near band of another module's growth area (partners included). */
  growthBand?: number
  /** B26: growth units this module's own band would refuse (0 = it can grow by every unit it may). */
  growthBlocked?: number
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
    w.coverage * (1 - f.coverage) +
    (w.growthCoverage ?? 0) * (f.growthCoverage !== undefined && f.growthCoverage < 0.3 ? 1 : 0) +
    (w.softClaim ?? 0) * (f.softClaim ?? 0) +
    (w.growthBand ?? 0) * (f.growthBand ?? 0) +
    (w.growthBlocked ?? 0) * (f.growthBlocked ?? 0)
  )
})

/**
 * The compact-cluster score split into its weighted terms (plan dumps, `planner/trace.ts`); they sum to the scorer's
 * value (pinned by a T1 test). Not on the hot path: the scorer above stays allocation-free.
 */
export function placementTerms(f: CandidateFeatures, p: LayoutPolicy): Record<string, number> {
  const w = p.placement
  return {
    center: w.center * f.centerDist,
    port: w.port * f.portDist,
    facing: w.facing * f.facingAway,
    clear: w.clear * f.clearCost,
    adjacent: -w.adjacent * f.adjacent,
    exactGap: -w.exactGap * f.exactGap,
    coverage: w.coverage * (1 - f.coverage),
    growthCoverage: (w.growthCoverage ?? 0) * (f.growthCoverage !== undefined && f.growthCoverage < 0.3 ? 1 : 0),
    softClaim: (w.softClaim ?? 0) * (f.softClaim ?? 0),
  }
}

/** The v1 early-game policy (SPEC §5.3): compact cluster, 1–2-tile corridors, expand-first, clear trees and rocks. */
export const EARLY_COMPACT: LayoutPolicy = {
  id: "early-compact",
  applies: (ctx) => ((ctx.modules ?? 0) < 40 ? 1 : 0.1),
  corridor: { min: 1, preferred: 2 },
  moduleSelection: { preferGenerated: true },
  packing: "compact-cluster",
  expansion: "expand-first",
  obstacles: { trees: "clear", rocks: "clear", maxClearCost: 400, poleEvict: 0.5 },
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
    bundleFactor: 0.9,
    softClaim: 10,
    softClaimDecay: 0.5,
    sealCheck: 2000,
    sealRetry: 0,
    longRoute: 128,
    coarseCell: 8,
    corridorCells: 1,
    corridorWeight: 1.5,
  },
  placement: { center: 1, port: 1.5, facing: 12, clear: 0.5, adjacent: 0.4, exactGap: 0.2, coverage: 80, growthCoverage: 40, softClaim: 0.5, growthBand: 4, growthBandUnits: 2, growthBlocked: 3, portEscape: 8, newField: 50 },
}
registerPolicy(EARLY_COMPACT)

/** Config overrides a faction may apply to its policy (SPEC §5.7). Absent/0/"" = keep the policy's value. */
export interface PolicyOverrides {
  corridorMin?: number
  corridorPreferred?: number
  topology?: string
  utilization?: number
  smelting?: string
  /** D50: soft-claim and bundling weights (settings; absent or negative = keep the policy's value). */
  placementSoftClaim?: number
  routerSoftClaim?: number
  routerSoftClaimDecay?: number
  routerBundleFactor?: number
  /** B26: near growth band weight, its depth in units, and the per-unit cost of a blocked own band (negative = keep). */
  placementGrowthBand?: number
  placementGrowthBandUnits?: number
  placementGrowthBlocked?: number
  /** B37: cost per pole-line tile a placement or route takes (negative = keep). */
  poleEvict?: number
  /** D57: extra tiles a new mine pays for a fresh field (negative = keep). */
  placementNewField?: number
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
  if (overrides.placementSoftClaim !== undefined && overrides.placementSoftClaim >= 0) p.placement = { ...p.placement, softClaim: overrides.placementSoftClaim }
  if (overrides.placementGrowthBand !== undefined && overrides.placementGrowthBand >= 0) p.placement = { ...p.placement, growthBand: overrides.placementGrowthBand }
  if (overrides.placementGrowthBandUnits !== undefined && overrides.placementGrowthBandUnits >= 0) p.placement = { ...p.placement, growthBandUnits: overrides.placementGrowthBandUnits }
  if (overrides.placementGrowthBlocked !== undefined && overrides.placementGrowthBlocked >= 0) p.placement = { ...p.placement, growthBlocked: overrides.placementGrowthBlocked }
  if (overrides.placementNewField !== undefined && overrides.placementNewField >= 0) p.placement = { ...p.placement, newField: overrides.placementNewField }
  if (overrides.poleEvict !== undefined && overrides.poleEvict >= 0) p.obstacles = { ...p.obstacles, poleEvict: overrides.poleEvict }
  if (overrides.routerSoftClaim !== undefined && overrides.routerSoftClaim >= 0) p.router = { ...p.router, softClaim: overrides.routerSoftClaim }
  if (overrides.routerSoftClaimDecay !== undefined && overrides.routerSoftClaimDecay >= 0) p.router = { ...p.router, softClaimDecay: overrides.routerSoftClaimDecay }
  if (overrides.routerBundleFactor !== undefined && overrides.routerBundleFactor > 0) p.router = { ...p.router, bundleFactor: overrides.routerBundleFactor }
  return p
}
