import { LuaEntity, MapPosition } from "factorio:runtime"
import { spawnFaction, SpawnFactionOptions } from "./autospawn"
import { cancel, createController, enqueue, getAction, isIdle } from "./character/controller"
import { ActionSpec } from "./character/types"
import { clearConfigOverrides, Config, ConfigKey, getConfig, setConfigOverride } from "./config"
import { addCrew, addStockpile, createFaction, CreateFactionOptions, destroyFaction, getFaction, planGhosts, PlanGhostsOptions, spawnCrew } from "./jobs/faction"
import { brainReport, startBootstrap } from "./strategy/bootstrap"
import { computeResearchGoal } from "./strategy/research"
import { factoryGoalSelectionSnapshot, getFactory, startFactory } from "./strategy/factory"
import { exportFactoryGraph, factoryReport } from "./strategy/factory-report"
import { claimView, entryPolicy, exportGraph, getPlannerEntry, startPlan, StartPlanOptions, tiers } from "./planner/runtime"
import { tkey } from "./planner/grid"
import { planGrowth } from "./planner/grow"
import { prototypeFacts } from "./modules/prototype-facts"
import { getTerrain, terrainView } from "./planner/terrain"
import { dumpEntities, writeTelemetry } from "./telemetry"
import { factionDiagnostics } from "./diagnostics"

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
    /** Debug probes: each crew member's position, claims (job kind and position) and running action. */
    crew_debug: () => {
      const out: unknown[] = []
      for (const [id, m] of pairs(storage.crew)) {
        const ctrl = storage.controllers[m.controller]
        const cur = ctrl?.queue[0] !== undefined ? getAction(ctrl.queue[0]) : undefined
        const claims: string[] = []
        for (const j of m.claims) {
          const job = storage.factions[m.faction]?.board.jobs[j]
          if (job !== undefined) claims.push(`${j}:${job.payload.kind}@${math.floor(job.pos.x)},${math.floor(job.pos.y)}`)
        }
        out.push({ id, dead: m.dead, pos: m.character.valid ? m.character.position : undefined, claims, actions: m.actions.length, running: cur && { kind: cur.spec.kind, status: cur.status, phase: (cur as unknown as { phase?: string }).phase, reason: cur.reason } })
      }
      return out
    },
    /** Debug probe: the board's recent claim/done/fail/release events, newest last (bounded by CLAIM_LOG_KEPT). */
    board_events: (name: string) => {
      const events = mustFaction(name).board.claimLog
      return events.map((e) => ({ ...e }))
    },
    /** Debug probe (B54): the board's active jobs whose item or recipe contains `item`, with priority, deps and claim. */
    job_debug: (name: string, item: string) => {
      const board = mustFaction(name).board
      const out: unknown[] = []
      for (const id of board.active) {
        const j = board.jobs[id]
        const p = j.payload as { item?: string; recipe?: string }
        const what = p.item ?? p.recipe ?? ""
        if (string.find(what, item, 1, true)[0] === undefined) continue
        const deps = j.deps.map((d) => `${d}:${board.jobs[d]?.payload.kind ?? "?"}:${board.jobs[d]?.status ?? "gone"}`)
        out.push({ id, kind: j.payload.kind, what, status: j.status, priority: j.priority, deps, claimedBy: j.claimedBy, attempts: j.attempts, reason: j.reason, pos: j.pos })
      }
      return out
    },
    /** Cross-layer goal → planner → build → Job Board links plus stable blocker codes and invariant violations. */
    diagnostics: (name: string) => factionDiagnostics(name),
    /** Plain-data input to the next-goal policy; capture a live failure and replay it in a T1 test. */
    goal_selection_snapshot: (name: string) => factoryGoalSelectionSnapshot(name),
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
    /**
     * Debug probe (M6a.2): the faction's reserved tiles, its bootstrap sites (with per-site tile lists), and for the
     * queried tiles the split between terrain, reservation (and which site owns it) and layout presence.
     */
    reserved_debug: (name: string, tiles?: { x: number; y: number }[]) => {
      const faction = mustFaction(name)
      const brain = faction.brain
      if (brain === undefined) return undefined
      const owner: Record<number, number> = {}
      for (const s of brain.sites) for (const k of s.tiles) owner[k] = s.id
      const siteList = brain.sites.map((s) => ({ id: s.id, kind: s.kind, resource: s.resource, status: s.status, depleting: s.depleting, tiles: s.tiles.length }))
      let reservedCount = 0
      for (const [k] of pairs(brain.reserved)) if (brain.reserved[k as number]) reservedCount++
      let terrainId: string | undefined
      for (const [id, t] of pairs(storage.terrains ?? {})) if (t.force === faction.force) { terrainId = id; break }
      const view = terrainId !== undefined ? terrainView(getTerrain(terrainId)!) : undefined
      const layout = storage.factories?.[faction.name]?.layout
      let routeOccCount = 0
      if (layout !== undefined) for (const [k] of pairs(layout.routeOcc)) if (layout.routeOcc[k] !== undefined) routeOccCount++
      const detail = (tiles ?? []).map((p) => {
        const k = tkey(p.x, p.y)
        let inLayout: string | false = false
        if (layout !== undefined) {
          if (layout.occ[k] !== undefined) inLayout = "occ:" + layout.occ[k]
          else if (layout.routeOcc[k] !== undefined) inLayout = "route:" + layout.routeOcc[k]
          else if (layout.reserved[k] !== undefined) inLayout = "reserved:" + layout.reserved[k]
          else if (layout.mine !== undefined && layout.mine[k] !== undefined) inLayout = "mine:" + layout.mine[k]
        }
        return {
          x: p.x,
          y: p.y,
          terrain: view?.block(p.x, p.y),
          reserved: brain.reserved[k] === true,
          site: owner[k],
          inLayout,
        }
      })
      return { sites: siteList, reservedCount, terrain: terrainId, routeOccCount, routeCount: layout?.routeOrder?.length, detail }
    },

    /** Debug probe (M6a.2): replays startGrow's planGrowth for a module and reports which route owns a tile. */
    growth_debug: (name: string, module: string, units: number, x: number, y: number) => {
      const faction = storage.factions?.[name]
      const f = storage.factories?.[name]
      const t = f !== undefined ? storage.terrains?.[f.terrain] : undefined
      if (faction === undefined || f === undefined || t === undefined) return undefined
      const base = f.layout
      const k = tkey(x, y)
      const touching: { id: string; to: string; from: string | null; tapOf: string | null; hasTile: boolean }[] = []
      for (const rid of base.routeOrder) {
        const r = base.routes[rid]
        if (r === undefined) continue
        touching.push({ id: rid, to: r.to.module, from: r.from?.module ?? null, tapOf: r.tapOf ?? null, hasTile: r.tiles.indexOf(k) >= 0 })
      }
      const policy = entryPolicy({ request: { modules: [], connections: [], center: { x: 0, y: 0 }, region: { x: 0, y: 0, w: 0, h: 0 } }, policy: getConfig().layoutPolicy } as never)
      const plan = planGrowth(base, claimView(faction.name, faction.surface, terrainView(t), false), prototypeFacts, policy, tiers()[0], module, units)
      const after = plan.ok ? plan.layout : base
      const ownerBefore = base.routeOcc[k]
      const ownerAfter = after.routeOcc[k]
      return { ok: plan.ok, reason: plan.reason, ownerBefore, ownerAfter, module, touching }
    },

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
