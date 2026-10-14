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
    scanRadius: setting(Settings.scanRadius),
    brainIntervalTicks: setting(Settings.brainIntervalTicks),
    bootstrapSites: setting(Settings.bootstrapSites),
    firstElectricityItems: setting(Settings.firstElectricityItems),
    stallTicks: setting(Settings.stallTicks),
    telemetryIntervalTicks: setting(Settings.telemetryIntervalTicks),
    frameDumpIntervalTicks: setting(Settings.frameDumpIntervalTicks),
    frameDumpRadius: setting(Settings.frameDumpRadius),
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
