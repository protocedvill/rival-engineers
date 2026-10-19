import { Settings } from "./shared/setting-names"

// The one typed config module (SPEC §5.7). Runtime code reads settings only through `getConfig()`.
// Tests and the harness can override any value via `setConfigOverride` (also exposed on the remote
// interface). Overrides live in `storage`, so they are deterministic and survive save/load.

export interface Config {
  factionCount: number
  crewSize: number
  /** Per-tick budget: the most character controllers stepped in one tick. */
  controllerStepsPerTick: number
  /** Ticks without getting closer to the next waypoint before a walk counts as stuck. */
  stuckTicks: number
  /** Re-paths a walk may do before it fails. */
  maxRepaths: number
  /** Ticks without progress before mining, crafting or pick-up fails. */
  actionStallTicks: number
  debugTeleportWhenStuck: boolean
  debugInstantCraft: boolean
  /** Debug only: multiplies build, reach and resource reach. 1 = player parity. */
  debugReachMultiplier: number
  /** Attempts before a failing job is marked failed (Job Board). */
  jobMaxAttempts: number
  /** Back-off before a released job may be claimed again; doubles with each failed attempt. */
  jobRetryTicks: number
  /** Most jobs one crew member claims as one locality batch. */
  batchMaxJobs: number
  /** Ticks a job waits after a transient failure (e.g. a character standing in the way). */
  jobBlockedRetryTicks: number
  /** Hand speed: ticks a crew member takes to place one entity once in reach (SPEC §5.7). */
  placeDelayTicks: number
  /** Hand speed for belts (transport-belt type), which players drag. */
  beltPlaceDelayTicks: number
  /** Science packs of the research goal (§3.2), comma-separated item names. */
  researchSciencePacks: string
  /** Items, entities or fluids the research goal may not need (trigger technologies), comma-separated. */
  researchExcludedTriggers: string
  /** Create `factionCount` factions on a new map (never while factorio-test is running). */
  autoSpawn: boolean
  spawnMode: string
  /** auto-distance: minimum distance from players' spawn and from other factions. */
  spawnMinDistance: number
  /** auto-distance: starting resources must lie within this radius of a spawn. */
  spawnResourceRadius: number
  /** fixed-offsets: "x,y;x,y;..." offsets from the player spawn, one per faction. */
  spawnFixedOffsets: string
  /**
   * auto-distance: give each faction a map-gen starting area (MapGenSettings.starting_points, as the PvP
   * scenario does for teams) at a not-yet-generated spot, so it gets starting resources like a player.
   */
  spawnStartingArea: boolean
  /** Starting area: a spawn needs water within this radius (0 = no check); the starting-lake repair works in it. */
  spawnWaterRadius: number
  /** Starting area: repaint the starting lake when the spawn's tiles were generated before its starting point. */
  spawnLakeRepair: boolean
  /** Starting area: repair only when at least this many tiles the elevation noise makes water are land. */
  spawnLakeRepairMinTiles: number
  /** Chunks within this radius of the base are generated (like a player exploring) and scanned for resources. */
  scanRadius: number
  /** The strategy layer re-evaluates each faction every this many ticks. */
  brainIntervalTicks: number
  /** Bootstrap target: burner drills per resource, "resource=count,...". */
  bootstrapSites: string
  /** The first-electricity kit the bootstrap ends with, "item=count,...". */
  firstElectricityItems: string
  /** No planner progress for this long is a stall (SPEC §3: 15 game-minutes). */
  stallTicks: number
  /** Telemetry JSON written every this many ticks (0 = off). */
  telemetryIntervalTicks: number
  /** Entity frame dumps every this many ticks (0 = off), for tools/render. */
  frameDumpIntervalTicks: number
  frameDumpRadius: number
  /** LayoutPolicy id per faction, or "auto" (highest `applies`) (SPEC §5.3, §5.7). */
  layoutPolicy: string
  /** Corridor widths between modules (0 = the policy's own). */
  layoutCorridorMin: number
  layoutCorridorPreferred: number
  /** "policy" (the policy's own), "point-to-point" or "splitter-tap" (D22). */
  layoutTopology: string
  /** D25: edges are planned up to this fraction of nominal belt capacity. */
  beltUtilization: number
  /** Planner budget: work units per tick (one placement candidate or one A* expansion each). */
  plannerWorkPerTick: number
  /** Terrain model budget: chunks scanned per tick. */
  terrainChunksPerTick: number
  /** M5 strategy layer: takes over from the burner bootstrap once the first-electricity materials are gathered. */
  factoryEnabled: boolean
  /** Staged targets (D27): packs per minute the labs consume, "item=n,...;item=n,..." (stages separated by ";"). */
  factoryTargets: string
  /** The base region (around the hub) plans place modules in; grown when a plan fails. */
  factoryRegionRadius: number
  /** Entities the factory designs with, "role=entity,...": assembler, electric-drill, lab, boiler, engine, pole. */
  factoryEntities: string
  /** Seconds per research unit the labs are sized for (0: the mean over the research goal's pack technologies). */
  factoryResearchUnitTime: number
  /** Hand-craft science packs into the labs until science is automated. */
  factoryHandFeedLabs: boolean
  /** Job priority of the factory's builds (bootstrap: place 90, craft 50, gather 20). */
  factoryBuildPriority: number
  /** Conflicts (M5a.2): reroutes or relocations per goal before its leftover ghosts are just retried. */
  conflictMaxRepairs: number
  /** Telemetry writes done.json (the soak harness stops) once every faction reached this milestone. */
  soakDoneMilestone: string
  /** Curated mall built once science is automated (material supply for buildings); "" = none. */
  factoryMall: string
  /** The mall's input flows are planned at this fraction of its full-speed rates. */
  factoryMallUtilization: number
  /** Sandbox scenario (live review): keep biters. Off: no enemy bases, peaceful. */
  sandboxEnemies: boolean
  /** B3: most clear / wood-gather jobs one crew member chains into one trip before returning to the depot (1 = no batching). */
  tripMaxJobs: number
  /** B3: every job of a trip lies within this many tiles of its first job. */
  tripRadius: number
  /** B3: a trip stops when its products would fill more than this fraction of the free inventory slots. */
  tripInventoryFill: number
  /** D43 / B4: a bootstrap mining site with less than this many minutes of ore left is replaced on remaining ore. */
  bootstrapDepletionMinutes: number
  /** D35: "compact-core" or "near-ore" smelting for the layout policy; "" = the policy's own choice. */
  layoutSmelting: string
  /** M5b measurement: node samples every this many ticks; the sliding window holds this many samples. */
  measureIntervalTicks: number
  measureWindowSamples: number
  /** M5b measurement: ticks one edge flow probe runs. */
  measureProbeTicks: number
  /** M5b reconciler: act on root causes (off: classify and report only). */
  reconcileRemedies: boolean
  /** M5b reconciler: a node is classified only this long after it and its feeders were built. */
  reconcileWarmupTicks: number
  /** M5b reconciler: evaluations a new status must hold before a node's status changes. */
  reconcileConfirm: number
  /** M5b reconciler: output below planned x (1 - this) is a deficit. */
  reconcileShortfall: number
  /** M5b reconciler: ticks between two remedies for the same root cause, and remedies per root cause. */
  reconcileCooldownTicks: number
  reconcileMaxRemedies: number
  /**
   * D36: research the technology that unlocks undergrounds before a production/mall plan when routing that plan with
   * undergrounds is at least this many tiles shorter (0 = off; a plan that fails without them always researches it).
   */
  logisticsUndergroundMinSaving: number
  /** B2 (D36): the same for splitters: one producer feeding several consumers through splitter taps vs separate belts. */
  logisticsSplitterMinSaving: number
  /** D36 / B2: each comparison may use at most this many times the plan's own routing work (bounded extra work). */
  plannerCompareWorkFactor: number
  /** D50 / B9: placement cost per footprint tile on another module's growth area (policy placement.softClaim). */
  plannerPlacementSoftClaim: number
  /** D50 / B9: router cost per tile on another module's growth area (policy router.softClaim). */
  plannerRouterSoftClaim: number
  /** B26: placement cost per footprint tile on the near part of another module's growth area (policy placement.growthBand). */
  plannerPlacementGrowthBand: number
  /** B26: growth units next to a module that count as its near band (policy placement.growthBandUnits). */
  plannerPlacementGrowthBandUnits: number
  /** B26: placement cost per growth unit an expandable module's own band would refuse (policy placement.growthBlocked). */
  plannerPlacementGrowthBlocked: number
  /** D50 / B7: cost factor of a route tile next to another route's belt (policy router.bundleFactor). */
  plannerRouterBundleFactor: number
  /** D36 / B2: least planner work a comparison may use (tiny plans have tiny routing work). */
  plannerCompareMinWork: number
  /** D50 / B2: run the splitter-tap comparison at all (default off). */
  logisticsSplitterCompare: boolean
  /** D42 / B5: chest entity of module buffer depots (smelter columns); "" = none. */
  moduleBuffer: string
  /** D42 / B5: usable slots of a buffer chest (the rest are barred). */
  moduleBufferSlots: number
  /** D38: temporary chest-fed assembler cells per product (item=count, empty = none). */
  bootstrapFactories: string
  /** D38: seconds of a temporary factory's output the economy waits for before hand-crafting the rest. */
  bootstrapFactoryWaitSeconds: number
  /** B18: priority of the crew jobs that keep temporary cells stocked proactively (0 = never stock). */
  bootstrapTempCellFeedPriority: number
  /** D38: craft jobs a member queues in the background of a batch (0 = craft standing). */
  crewBackgroundCrafts: number
  /** M6: the design plans every stage target times this (headroom so the measured rate reaches the target). */
  factoryDesignMargin: number
  /** M6: per stage (";"), the unit time labs are sized for: "mean" / "max" over the research goal, or seconds. */
  factoryLabSizing: string
  /** M6 (SPEC §3): game minutes the last stage's science rate must hold to count as sustained. */
  factorySustainMinutes: number
  /** M6: from this stage on (1-based, 0 = never), new fuel consumers share one fuel producer per cluster (splitter taps). */
  factorySharedProviders: number
  /** B19: research splitters before production when sharing providers saves at least this many modules (0 = never). */
  logisticsShareMinModules: number
  /** B20: leftover-ghost rounds (30 s apart) placing nothing before a build gives up its location (0 = never). */
  buildStuckRounds: number
  /** P36 (a): a steam block's fuel producer with less than this many minutes of ore left is replaced (0 = never). */
  factoryPowerFuelMinutes: number
  /** P36 (b): when a new fuel producer can't be placed, new consumers tap the nearest built one (which grows). */
  factoryFuelFallback: boolean
  /** B31: a refuel preempts a busy member's batch only when its running target has less than this many seconds of fuel (0 = never). */
  preemptFuelSeconds: number
  /** B32: supply points (furnace outputs, chests, buffers, the mall) farther than this from the hub are not taken from (0 = any distance). */
  supplyRadius: number
  /** B32: a supply point holding fewer of an item than this is not worth the walk (stockpiles always count). */
  supplyMinTake: number
}

export type ConfigKey = keyof Config

function setting<T extends number | boolean | string>(name: string): T {
  return settings.global[name].value as T
}

export function getConfig(): Config {
  const config: Config = {
    factionCount: setting(Settings.factionCount),
    crewSize: setting(Settings.crewSize),
    controllerStepsPerTick: setting(Settings.controllerStepsPerTick),
    stuckTicks: setting(Settings.stuckTicks),
    maxRepaths: setting(Settings.maxRepaths),
    actionStallTicks: setting(Settings.actionStallTicks),
    debugTeleportWhenStuck: setting(Settings.debugTeleportWhenStuck),
    debugInstantCraft: setting(Settings.debugInstantCraft),
    debugReachMultiplier: setting(Settings.debugReachMultiplier),
    jobMaxAttempts: setting(Settings.jobMaxAttempts),
    jobRetryTicks: setting(Settings.jobRetryTicks),
    batchMaxJobs: setting(Settings.batchMaxJobs),
    jobBlockedRetryTicks: setting(Settings.jobBlockedRetryTicks),
    placeDelayTicks: setting(Settings.placeDelayTicks),
    beltPlaceDelayTicks: setting(Settings.beltPlaceDelayTicks),
    researchSciencePacks: setting(Settings.researchSciencePacks),
    researchExcludedTriggers: setting(Settings.researchExcludedTriggers),
    autoSpawn: setting(Settings.autoSpawn),
    spawnMode: setting(Settings.spawnMode),
    spawnMinDistance: setting(Settings.spawnMinDistance),
    spawnResourceRadius: setting(Settings.spawnResourceRadius),
    spawnFixedOffsets: setting(Settings.spawnFixedOffsets),
    spawnStartingArea: setting(Settings.spawnStartingArea),
    spawnWaterRadius: setting(Settings.spawnWaterRadius),
    spawnLakeRepair: setting(Settings.spawnLakeRepair),
    spawnLakeRepairMinTiles: setting(Settings.spawnLakeRepairMinTiles),
    scanRadius: setting(Settings.scanRadius),
    brainIntervalTicks: setting(Settings.brainIntervalTicks),
    bootstrapSites: setting(Settings.bootstrapSites),
    firstElectricityItems: setting(Settings.firstElectricityItems),
    stallTicks: setting(Settings.stallTicks),
    telemetryIntervalTicks: setting(Settings.telemetryIntervalTicks),
    frameDumpIntervalTicks: setting(Settings.frameDumpIntervalTicks),
    frameDumpRadius: setting(Settings.frameDumpRadius),
    layoutPolicy: setting(Settings.layoutPolicy),
    layoutCorridorMin: setting(Settings.layoutCorridorMin),
    layoutCorridorPreferred: setting(Settings.layoutCorridorPreferred),
    layoutTopology: setting(Settings.layoutTopology),
    beltUtilization: setting(Settings.beltUtilization),
    plannerWorkPerTick: setting(Settings.plannerWorkPerTick),
    terrainChunksPerTick: setting(Settings.terrainChunksPerTick),
    factoryEnabled: setting(Settings.factoryEnabled),
    factoryTargets: setting(Settings.factoryTargets),
    factoryRegionRadius: setting(Settings.factoryRegionRadius),
    factoryEntities: setting(Settings.factoryEntities),
    factoryResearchUnitTime: setting(Settings.factoryResearchUnitTime),
    factoryHandFeedLabs: setting(Settings.factoryHandFeedLabs),
    factoryBuildPriority: setting(Settings.factoryBuildPriority),
    conflictMaxRepairs: setting(Settings.conflictMaxRepairs),
    soakDoneMilestone: setting(Settings.soakDoneMilestone),
    factoryMall: setting(Settings.factoryMall),
    factoryMallUtilization: setting(Settings.factoryMallUtilization),
    sandboxEnemies: setting(Settings.sandboxEnemies),
    tripMaxJobs: setting(Settings.tripMaxJobs),
    tripRadius: setting(Settings.tripRadius),
    tripInventoryFill: setting(Settings.tripInventoryFill),
    bootstrapDepletionMinutes: setting(Settings.bootstrapDepletionMinutes),
    layoutSmelting: setting(Settings.layoutSmelting),
    measureIntervalTicks: setting(Settings.measureIntervalTicks),
    measureWindowSamples: setting(Settings.measureWindowSamples),
    measureProbeTicks: setting(Settings.measureProbeTicks),
    reconcileRemedies: setting(Settings.reconcileRemedies),
    reconcileWarmupTicks: setting(Settings.reconcileWarmupTicks),
    reconcileConfirm: setting(Settings.reconcileConfirm),
    reconcileShortfall: setting(Settings.reconcileShortfall),
    reconcileCooldownTicks: setting(Settings.reconcileCooldownTicks),
    reconcileMaxRemedies: setting(Settings.reconcileMaxRemedies),
    logisticsUndergroundMinSaving: setting(Settings.logisticsUndergroundMinSaving),
    logisticsSplitterMinSaving: setting(Settings.logisticsSplitterMinSaving),
    plannerCompareWorkFactor: setting(Settings.plannerCompareWorkFactor),
    plannerPlacementSoftClaim: setting(Settings.plannerPlacementSoftClaim),
    plannerRouterSoftClaim: setting(Settings.plannerRouterSoftClaim),
    plannerRouterBundleFactor: setting(Settings.plannerRouterBundleFactor),
    plannerPlacementGrowthBand: setting(Settings.plannerPlacementGrowthBand),
    plannerPlacementGrowthBandUnits: setting(Settings.plannerPlacementGrowthBandUnits),
    plannerPlacementGrowthBlocked: setting(Settings.plannerPlacementGrowthBlocked),
    plannerCompareMinWork: setting(Settings.plannerCompareMinWork),
    logisticsSplitterCompare: setting(Settings.logisticsSplitterCompare),
    moduleBuffer: setting(Settings.moduleBuffer),
    moduleBufferSlots: setting(Settings.moduleBufferSlots),
    bootstrapFactories: setting(Settings.bootstrapFactories),
    bootstrapFactoryWaitSeconds: setting(Settings.bootstrapFactoryWaitSeconds),
    bootstrapTempCellFeedPriority: setting(Settings.bootstrapTempCellFeedPriority),
    crewBackgroundCrafts: setting(Settings.crewBackgroundCrafts),
    factoryDesignMargin: setting(Settings.factoryDesignMargin),
    factoryLabSizing: setting(Settings.factoryLabSizing),
    factorySustainMinutes: setting(Settings.factorySustainMinutes),
    factorySharedProviders: setting(Settings.factorySharedProviders),
    logisticsShareMinModules: setting(Settings.logisticsShareMinModules),
    buildStuckRounds: setting(Settings.buildStuckRounds),
    factoryPowerFuelMinutes: setting(Settings.factoryPowerFuelMinutes),
    factoryFuelFallback: setting(Settings.factoryFuelFallback),
    preemptFuelSeconds: setting(Settings.preemptFuelSeconds),
    supplyRadius: setting(Settings.supplyRadius),
    supplyMinTake: setting(Settings.supplyMinTake),
  }
  const target = config as unknown as Record<string, unknown>
  const overrides = storage.configOverrides as Record<string, unknown>
  for (const key in overrides) target[key] = overrides[key]
  return config
}

export function setConfigOverride<K extends ConfigKey>(key: K, value: Config[K] | undefined): void {
  storage.configOverrides[key] = value as never
}

export function clearConfigOverrides(): void {
  storage.configOverrides = {}
}
