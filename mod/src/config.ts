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
  /** Telemetry writes done.json (the soak harness stops) once every faction reached this milestone. */
  soakDoneMilestone: string
  /** Curated mall built once science is automated (material supply for buildings); "" = none. */
  factoryMall: string
  /** The mall's input flows are planned at this fraction of its full-speed rates. */
  factoryMallUtilization: number
  /** Sandbox scenario (live review): keep biters. Off: no enemy bases, peaceful. */
  sandboxEnemies: boolean
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
    soakDoneMilestone: setting(Settings.soakDoneMilestone),
    factoryMall: setting(Settings.factoryMall),
    factoryMallUtilization: setting(Settings.factoryMallUtilization),
    sandboxEnemies: setting(Settings.sandboxEnemies),
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
