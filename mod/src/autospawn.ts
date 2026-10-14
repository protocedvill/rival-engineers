import { MapPosition } from "factorio:runtime"
import { getConfig } from "./config"
import { createFaction } from "./jobs/faction"
import { FactionState } from "./jobs/types"
import { startBootstrap } from "./strategy/bootstrap"
import { findSpawnAutoDistance, findSpawnFixed, findSpawnStartingArea, SpawnChoice, starterItems } from "./world/spawn"

// Faction spawning (SPEC §5.7, D5): where a faction starts, its crew with freeplay starter items, no research,
// and the burner bootstrap brain.

export interface SpawnFactionOptions {
  /** Start exactly here (scenario-defined). Otherwise the `spawn-mode` setting decides. */
  position?: MapPosition
  surface?: string
  crew?: number
}

export function spawnFaction(name: string, options: SpawnFactionOptions = {}): FactionState {
  const config = getConfig()
  const surface = game.surfaces[options.surface ?? 1]
  let choice: SpawnChoice
  if (options.position) choice = { position: options.position, patches: [], checked: 0 }
  else if (config.spawnMode === "fixed-offsets") choice = findSpawnFixed(surface, config, storage.factionOrder.length + 1)
  else {
    const salt = storage.factionOrder.length
    choice = (config.spawnStartingArea ? findSpawnStartingArea(surface, config, salt) : undefined) ?? findSpawnAutoDistance(surface, config, salt)
  }
  const faction = createFaction(name, { position: choice.position, crew: options.crew, surface: surface.name, starterItems: starterItems() })
  startBootstrap(faction, choice.position)
  faction.brain!.spawnNote = choice.note
  log(`[rival-engineers] faction ${name} spawned at ${choice.position.x},${choice.position.y} after checking ${choice.checked} spot(s)${choice.note ? ": " + choice.note : ""}`)
  return faction
}

/** On the first tick of a new map: create `faction-count` factions (never while factorio-test runs). */
export function onAutoSpawnTick(): void {
  if (!storage.autoSpawnPending) return
  storage.autoSpawnPending = false
  const config = getConfig()
  if (!config.autoSpawn || config.spawnMode === "scenario-defined" || script.active_mods["factorio-test"]) return
  for (let i = 1; i <= config.factionCount; i++) spawnFaction(`${i}`)
}
