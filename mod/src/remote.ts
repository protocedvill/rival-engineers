import { LuaEntity, MapPosition } from "factorio:runtime"
import { spawnFaction, SpawnFactionOptions } from "./autospawn"
import { cancel, createController, enqueue, getAction, isIdle } from "./character/controller"
import { ActionSpec } from "./character/types"
import { clearConfigOverrides, Config, ConfigKey, getConfig, setConfigOverride } from "./config"
import { addCrew, addStockpile, createFaction, CreateFactionOptions, destroyFaction, getFaction, planGhosts, PlanGhostsOptions, spawnCrew } from "./jobs/faction"
import { brainReport, startBootstrap } from "./strategy/bootstrap"
import { computeResearchGoal } from "./strategy/research"
import { exportFactoryGraph, factoryReport, getFactory, startFactory } from "./strategy/factory"
import { exportGraph, getPlannerEntry, startPlan, StartPlanOptions } from "./planner/runtime"
import { dumpEntities, writeTelemetry } from "./telemetry"

// Remote interface used by the test harness and tools (SPEC §5.7). Harness code drives the mod only
// through this and settings.

function mustFaction(name: string) {
  const faction = getFaction(name)
  assert(faction, `no faction ${name}`)
  return faction!
}

function factionStats(name: string) {
  const faction = mustFaction(name)
  const board = faction.board
  const byStatus: Record<string, number> = { open: 0, claimed: 0, done: 0, failed: 0 }
  for (let id = 1; id < board.nextId; id++) {
    const job = board.jobs[id]
    if (job !== undefined) byStatus[job.status]++
  }
  const crew = []
  for (const id of faction.crew) {
    const m = storage.crew[id]
    crew.push({ id, dead: m.dead, claims: m.claims.length, stats: m.stats })
  }
  return { force: faction.force, counters: board.counters, jobs: byStatus, crew, brain: brainReport(faction) }
}

export function registerRemoteInterface(): void {
  remote.add_interface("rival-engineers", {
    version: () => script.active_mods["rival-engineers"],
    /** dump_entities(file, center, radius, surface?, water?) */
    dump_entities: (file: string, center: MapPosition, radius: number, surface?: string, water?: boolean) =>
      dumpEntities(file, center, radius, surface !== undefined ? game.surfaces[surface] : undefined, water),

    // Character Controller (M1). M2's Job Board calls the same functions directly.
    create_controller: (character: LuaEntity) => createController(character),
    enqueue: (controllerId: number, spec: ActionSpec) => enqueue(controllerId, spec),
    cancel: (actionId: number) => cancel(actionId),
    is_idle: (controllerId: number) => isIdle(controllerId),
    /** Status, failure reason and stats of an action (kept for the controller's last 64 actions). */
    action: (actionId: number) => {
      const a = getAction(actionId)
      return a && { id: a.id, kind: a.spec.kind, status: a.status, reason: a.reason, detail: a.detail, stats: a.stats, placed: a.placed }
    },

    // Factions and the Job Board (M2).
    /** Creates a faction (its own LuaForce, neutral to everyone) and returns its force name. */
    create_faction: (name: string, options?: CreateFactionOptions) => createFaction(name, options).force,
    destroy_faction: (name: string) => destroyFaction(name),
    spawn_crew: (faction: string, position: MapPosition) => spawnCrew(mustFaction(faction), position).id,
    add_crew: (faction: string, character: LuaEntity) => addCrew(mustFaction(faction), character).id,
    add_stockpile: (faction: string, chest: LuaEntity) => addStockpile(mustFaction(faction), chest),
    /** Turns the faction's ghosts into place (and optional fuel) jobs; returns the number of place jobs. */
    plan_ghosts: (faction: string, options?: PlanGhostsOptions) => planGhosts(mustFaction(faction), options),
    set_faction_paused: (faction: string, paused: boolean) => {
      mustFaction(faction).paused = paused
    },
    /** Board counters, job counts by status, per-crew stats and the brain's report. */
    faction_stats: (faction: string) => factionStats(faction),

    // Burner bootstrap (M3).
    /** Spawns a faction per `spawn-mode` (or at `options.position`) with starter items and the bootstrap brain. */
    spawn_faction: (name: string, options?: SpawnFactionOptions) => spawnFaction(name, options).force,
    /** Starts the bootstrap brain for an existing faction whose crew stands near `base`. */
    start_bootstrap: (name: string, base: MapPosition) => {
      startBootstrap(mustFaction(name), base)
    },
    faction_report: (name: string) => brainReport(mustFaction(name)),
    write_telemetry: () => writeTelemetry(),
    /** The v1 research goal (SPEC §3.2), computed from prototypes. */
    research_goal: () => computeResearchGoal(),

    // Layout planner (M4b).
    /** Starts a layout job (scan, place, route under budget); see planner/runtime.ts StartPlanOptions. */
    start_plan: (options: StartPlanOptions) => startPlan(options).id,
    /** Phase, stats and failures of a layout job. */
    plan_status: (id: string) => {
      const e = getPlannerEntry(id)
      return e && { phase: e.phase, scanTicks: e.scanTicks, planTicks: e.planTicks, stats: e.job?.stats, failures: e.job?.failures, build: e.build?.phase }
    },
    /** Writes the Factory Graph (both layers) of a layout job to script-output/<file>. */
    dump_graph: (id: string, file: string) => {
      const e = getPlannerEntry(id)
      return e !== undefined && exportGraph(e, file)
    },

    // Strategy (M5).
    /** The factory planner's state for a faction: goals, graph summary, design, research, waiting reasons. */
    factory_report: (name: string) => factoryReport(name),
    /** Hands a bootstrapped faction to the factory planner now (normally at the first-electricity milestone). */
    start_factory: (name: string) => {
      if (getFactory(name) === undefined) startFactory(mustFaction(name))
    },
    /** Writes both Factory Graph layers of a faction (physical layout + logical graph) to script-output/<file>. */
    dump_factory_graph: (name: string, file: string) => exportFactoryGraph(name, file),

    // Config (SPEC §5.7): tests and the harness override settings here.
    get_config: () => getConfig(),
    set_config_override: <K extends ConfigKey>(key: K, value: Config[K] | undefined) => setConfigOverride(key, value),
    clear_config_overrides: () => clearConfigOverrides(),
  })
}
