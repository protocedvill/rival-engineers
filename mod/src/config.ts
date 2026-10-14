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
}

export type ConfigKey = keyof Config

function setting<T extends number | boolean>(name: string): T {
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
