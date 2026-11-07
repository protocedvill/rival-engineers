import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { keyTaken } from "../jobs/keys"
import { Config, getConfig } from "../config"
import { failJob, getJob } from "../jobs/board"
import { resetMember } from "../jobs/crew"
import { addClearJob, addPlaceJob, clearJobFor, factionForce, factionSurface } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { curatedModule, generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { BuildParts, EntitySpec, partEntities, partTiles } from "../planner/build-list"
import * as GROW from "../planner/grow"
import { destroyEntity, markDirty, newTerrain, scanChunk, terrainView } from "../planner/terrain"
import * as LIFT from "./lifted"
import { DX, DY, keyX, keyY, Rect, tkey, Vec } from "../planner/grid"
import * as LO from "../planner/layout"
import type { LayoutState, PlacedModule, PlannedPole } from "../planner/layout"
import { preparePlanDelta } from "../planner/plan-delta"
import type { PlanDelta } from "../planner/plan-delta"
import { recordDiagnostic } from "../diagnostic-events"
import * as IDS from "../shared/ids"
import { abandonParts, applyDiff, checkBuild, cloggedBelts, obstaclesFor, routeCheck } from "../planner/conflicts"
import { planReroute } from "../planner/reroute"
import { CompareOptions, CompareResult, ConnectionRequest, logisticsFirst, ModuleRequest, PlanEvidence, PlanRequest, portFedByOther } from "../planner/plan"
import { sealedInputs } from "../planner/placement"
import * as PW from "../planner/power"
import { claimOreField, claimOwner, foreignEntitiesOn } from "../world/claims"
import { researchGoal } from "./research-queue"
import { newReconcileState, probeMaxAgeFor, reconcile, ReconcileParams, ReconcileState, recordRemedy, Remedy } from "./reconcile"
import type { RemedyKind } from "./reconcile"
import { countWork, findEntities } from "../work"
import { evictSites, isSitePart, resyncReserved } from "./evict"
import * as FU from "./fuel"
import type { RetireRecord } from "./retire"
import * as CS from "./constraints"
import * as FR from "./failure-rules"
import * as NF from "./node-facts"
import * as LF from "./lab-feed"
import { mark } from "./milestone"
import * as OIL from "./oil"
import * as Arms from "./arms"
import type { PlanFailure } from "../shared/plan-failure"
import * as LG from "../planner/logical"
import type { LogicalGraph, LogicalNode } from "../planner/logical"
import * as RT from "../planner/runtime"
import * as ST from "./stage"
import * as MS from "./measure"
import type { MeterState } from "./measure"
import * as DS from "./design"
import type { Design, DesignContext, ModuleKind, DesignEdge, DesignNode, GoalKind, GoalSpec } from "./design"
import { GoalSelectionSpec, GoalSelectionState, selectGoals } from "./goal-selection"
import * as GLC from "./goal-lifecycle"
import type { GoalStatus } from "./goal-lifecycle"
import * as REL from "./relocation"
import * as AR from "./adoption-runtime"
import * as EX from "./explore"
import * as GH from "./goal-holds"
export type { GoalStatus } from "./goal-lifecycle"

// The M5 strategy layer (SPEC §5.5, §5.8): takes over from the burner bootstrap once the first-electricity materials
// are gathered, and drives the faction toward staged science targets (D27) with the recipe-graph planner.
//
// Each think (every `brain-interval-ticks`, after the bootstrap brain):
//  1. Design: solve the current stage target (labs consuming N packs/min) down to raw resources and select and size
//     modules (design.ts); diff against the faction's logical graph (goal diff); group what is missing into build
//     goals in order: power (steam block and its fuel), labs, production, growth of existing modules.
//  2. Goals: one goal is planned at a time (on top of the faction's layout, so the base stays compact and later plans
//     see earlier ones); any number build at once. A goal waits for the technologies its modules need. A plan places
//     and routes with the M4 machinery, joins every consumer to the steam block with small poles, and is built by the
//     crew through the Job Board (clear jobs, then ghosts and place jobs; burners get a first load of fuel).
//  3. Research (§5.5): techs that unblock goals first, then the research goal; packs are hand-crafted and put into the
//     labs until the pack is automated (`factory-hand-feed-labs`).
//  4. Upkeep: burners the crew must keep fuelled (module `upkeep.fuel`, e.g. the steam block's burner coal drills).
//  5. Milestones, and stall recovery once the bootstrap brain is done (no progress for `stall-ticks`).
//
// Material supply: the bootstrap brain stays the faction's economy. Its demand loop (H4) sees the materials of every
// active job, the factory's place jobs included, and collects, hand-crafts or hand-mines them. The curated mall
// (a later stage goal) feeds that loop from its output chests once built; see docs/reports/M5-report.md.

/** A design node a goal builds, as plain data (the module is regenerated from generator + params). */
export interface GoalNode {
  role: string
  /** Graph node id = module instance id. */
  id: IDS.ModuleId
  kind: DesignNode["kind"]
  generator: ModuleKind
  params: Record<string, unknown>
  item: string
  need: number
  capacity: number
  inputs: DesignNode["inputs"]
  powerW: number
  /** Route-reassignment provider: the planner must choose an independent site. */
  newSite?: boolean
  /** D69: facts the design minted with the role (`node-facts.ts`). */
  homeCluster?: number
  family?: string
  serves?: NF.Serves
}

export interface FactoryGoal {
  id: IDS.GoalId
  kind: GoalKind
  status: GoalStatus
  nodes: GoalNode[]
  edges: DesignEdge[]
  techs: string[]
  /** Planner entry of the current attempt. */
  plan?: string
  attempts: number
  /** Region radius of the current attempt (grows on failure). */
  radius: number
  createdTick: number
  plannedTick?: number
  builtTick?: number
  reason?: string
  /** Place jobs done so far (progress), and rounds of re-planning jobs for leftover ghosts. */
  placed: number
  /** M7c: the last tick `placed` went up (or the goal was planned): a building goal with none for `stall-ticks` is stalled. */
  progressTick?: number
  rounds: number
  lastRound?: number
  /** Clear jobs for trees/rocks found under leftover ghosts, by obstacle position. */
  clearing?: Record<string, IDS.JobId>
  /**
   * M7c.9: leftover ghosts lifted off a tree or rock they cover (a ghost's selection wins over the tree's, so the crew
   * can't mine it: seed 11's pumpjack ghost over tree-08-brown, 10 rounds). Each comes back once its clear job ends.
   */
  lifted?: LIFT.LiftedGhost[]
  /** Growth goals: the node and units, and their own build (pick up moved entities, then build the new ones). */
  growth?: { node: string; units: number }
  /** A growth or repair build: `poles` (D71 b) places the new poles before the old ones in `breakAfter` are picked up. */
  growBuild?: { phase: "poles" | "clear" | "place" | "done"; clearJobs: IDS.JobId[]; add: EntitySpec[]; ghosts: LuaEntity[]; placeJobs: IDS.JobId[]; obstacles?: boolean; poleJobs?: IDS.JobId[]; breakAfter?: LuaEntity[]; priority?: number; failed?: string[]; failedSpecs?: EntitySpec[]; retryAt?: number }
  /** Conflict repairs (M5a.2): reroutes and relocations so far, and a reroute waiting for its pick-ups. */
  repairs?: number
  /** D36 / B2: given up because undergrounds or splitters were worth researching first (planned again after it). */
  deferred?: boolean
  rework?: { clearJobs: IDS.JobId[]; add: EntitySpec[]; obstacles?: boolean }
  /** B20: leftover-ghost rounds in a row that placed nothing, and the leftover count of the last round. */
  stuck?: number
  lastLeft?: number
  /** D62: a radar outpost goal: where its radar goes, on which arm, and the strip the crew explores to get there. */
  site?: { x: number; y: number; arm: number; step: number; strip: Rect }
  /** M7d.5: a roboport goal plans near this point, within `window` tiles of it. */
  anchor?: { x: number; y: number; window: number }
}

export interface FactoryState {
  faction: string
  /** B53: goal kinds whose last goal failed for want of a site, and the tick they may plan again. */
  siteRetry?: Partial<Record<GoalKind, number>>
  terrain: string
  center: Vec
  layout: LayoutState
  graph: LogicalGraph
  stage: number
  goals: FactoryGoal[]
  /** Last failed in-place growth plan by layout node, for diagnostics and the growth overlay. */
  growthDiagnostics?: Record<string, { tick: number; reason: string; units: number }>
  /** B98: node → the node still being built that its last growth plan had to wait for (B52); no replan until it is built. */
  growWaits?: Record<string, string>
  /** B152: the one-time adoption of planned pole ghosts in a save made before the stamp fix (kept for old saves). */
  poleAdoptDone?: boolean
  /** B158: version of the one-time planned-pole adoption (2: also repairs saves whose old flag is already set). */
  poleAdoptVersion?: number
  nextGoal: number
  /** Last design (summary for telemetry and stall reports). */
  design?: { cluster1Share?: number; stage: number; nodes: number; edges: number; electricW: number; techs: string[]; errors: string[]; overflow: Record<string, string>; clusters: number; missing: number; grow: number }
  /** Why no goal is being worked on right now. */
  waiting: string[]
  jobKeys: Record<string, number>
  /** B82: keys whose job failed, with the tick (jobs/keys.ts). */
  failedKeys?: Record<string, number>
  research: { current?: string; reason?: string; started: Record<string, string> }
  /** Automated science check: research units done since hand-feeding stopped, and what was left in the labs then. */
  verify?: { tick: number; leftover: number; units: number; tech?: string; progress: number; made: number }
  progressSteps: number
  progressTick: number
  lastUpkeep: number
  /**
   * A plan adoption that has begun but not committed (the goal is not yet `building`). Persisted so a Lua error
   * part-way is detected on the next tick and the idempotent adoption resumes; cleared at the commit point.
   */
  adoption?: AR.AdoptionIntent
  /**
   * D36: the technology that unlocks undergrounds is a prerequisite of production and mall goals, researched with
   * hand-fed packs like the other unblocking techs: a plan with undergrounds was at least `logistics-underground-min-saving`
   * tiles shorter, or (no plan at all without them) a goal failed every attempt without them.
   */
  needUndergrounds?: string
  /** B2 (D36): the same for splitters (`logistics-splitter-min-saving`); `taps` = which consumers then share a producer. */
  needSplitters?: string
  taps?: Record<string, string[]>
  /** D36 / B2 comparisons so far (telemetry): goal, attempt, decision and one line per alternative. */
  compares?: { goal: string; tick: number; research: boolean; why: string[] }[]
  /** D38: temporary factory cells built so far per product (never rebuilt once retired), and retired cells. */
  temp?: { built: Record<string, number>; retired: number }
  /**
   * M6 (SPEC §3): science packs made and consumed (force item statistics, cumulative) once per game minute, for the
   * sustained-throughput check and the scorecard; `best` = the best window so far (each pack's rate / its target, min).
   */
  science?: { samples: { tick: number; made: Record<string, number>; used: Record<string, number> }[]; best: number; bestTick?: number; rates?: Record<string, number> }
  /** M6: the final stage is built and the research goal done: no planner progress is expected (not a stall). */
  idle?: boolean
  /** D69: what failed plans and growths taught the design (no tap, short providers, no merge, ...; `constraints.ts`). */
  constraints?: CS.ConstraintStore
  /** P36 (a, proposed): steam-block fuel producers replaced because their ore ran low (telemetry). */
  fuelRelocations?: number
  /** D55/P36: roles whose old module is being deconstructed, with the clear jobs a replacement goal waits for. */
  relocation?: Record<string, IDS.JobId[]>
  /** D57 (c): ore patches (`patchKey`) a mine found no room on, with the terrain stamp then; skipped until it changes. */
  deadPatches?: Record<string, string>
  /** B63 diagnostics: orphan claim tiles seen (`orphanEvents` = plans rejected for them), and the last log tick. */
  orphanClaims?: number
  orphanEvents?: number
  orphanLogTick?: number
  /**
   * D76: providers being retired. Their consumers get a replacement (a parallel role of the same family) and the old
   * provider keeps producing until that replacement is built or its drills run dry.
   */
  retiring?: Record<string, RetireRecord>
  /** M5b: measurement state (machines per node, counter ring, edge probes) and the reconciler's state. */
  meter?: MeterState
  reconciler?: ReconcileState
  /**
   * D62: a search for ore past the home zone. `kind` goals wait while an outpost is built (`outpost`) and its radar's
   * nearby square is charted (`scan`), then plan again (`retry`); a plan of that kind ends the search.
   */
  explore?: { resource: string; kind: GoalKind; since: number; phase: "outpost" | "scan" | "retry"; goal?: string; radar?: Vec; scanUntil?: number; outposts: number; need?: "required" | "extra capacity" }
  /**
   * D62: the next arm (N, E, S, W round robin), the outposts built per arm, and their explored strips. M7c.8: `cut`
   * marks arms whose outpost found no pole path from the base (skipped from then on).
   */
  arms?: { next: number; steps: number[]; strips: Rect[]; outposts: Vec[]; cut?: boolean[] }
  /** P43 (a): chunks the faction's radars scanned (sector scans, and powered outposts' nearby squares), by `tkey`. */
  radarChunks?: Record<number, boolean>
  /**
   * M7c: ore left under each built mine's drills (by role, refreshed by the ore check every game-minute) and the fewest
   * minutes of it at full output that still let new consumers tap it.
   */
  oreLeft?: Record<string, { amount: number; minMinutes: number }>
}

/** The only legal status mutation boundary for an existing goal. Constructors set their initial status directly. */
function transitionGoal(g: FactoryGoal, to: GoalStatus): void {
  g.status = GLC.nextGoalStatus(g.status, to, g.id)
}

declare global {
  interface RivalEngineersStorage {
    factories?: Record<string, FactoryState>
  }
}

const designCache: Record<string, { key: string; design: Design }> = {}

const UPKEEP_INTERVAL = 300
/**
 * Priority of refuelling burners the power depends on, and (B111) of every build that restores the power supply: a power
 * goal, or the growth of a steam block or its fuel supply. At the build priority such a build was preempted by the
 * very refuels its shortage caused, for hours (fixed seed 222).
 */
const POWER_JOB_PRIORITY = 100
const FUEL_MINUTES = { low: 2, top: 8 }
const MAX_PLAN_ATTEMPTS = 4
/** D38: tiles temporary cells keep off every existing module (their ports' routes need room). */
const TEMP_CLEARANCE = 6
/** Leftover ghosts get new place jobs at most this often (their jobs failed or were dropped). */
const BUILD_ROUND_TICKS = 1800

// ---------------------------------------------------------------------------------------------------------
// Setup

function parsePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of string.gmatch(value, "([^=,;%s]+)%s*=%s*([^,;%s]+)")) out[k] = v
  return out
}

export function getFactory(name: string): FactoryState | undefined {
  return storage.factories?.[name]
}

function factories(): Record<string, FactoryState> {
  storage.factories ??= {}
  return storage.factories
}

/** The planner takes over a faction (normally when its bootstrap gathered the first-electricity materials). */
export function startFactory(faction: FactionState): FactoryState {
  const brain = faction.brain!
  const hub = brain.hub ?? brain.base
  const center = { x: math.floor(hub.x), y: math.floor(hub.y) }
  const t = newTerrain(`faction:${faction.name}`, faction.surface, faction.force)
  const f: FactoryState = {
    faction: faction.name,
    terrain: t.id,
    center,
    layout: LO.newLayout(),
    graph: LG.newGraph(),
    stage: 0,
    goals: [],
    nextGoal: 1,
    waiting: [],
    jobKeys: {},
    research: { started: {} },
    progressSteps: brain.steps,
    progressTick: game.tick,
    lastUpkeep: 0,
  }
  factories()[faction.name] = f
  mark(faction, "planner-takeover")
  log(`[rival-engineers] faction ${faction.name}: factory planner takes over at tick ${game.tick}, hub ${center.x},${center.y}`)
  return f
}


// ---------------------------------------------------------------------------------------------------------
// Tick

export function onFactoryTick(): void {
  const tick = game.tick
  let config: Config | undefined
  for (const name of storage.factionOrder) {
    const faction = storage.factions[name]
    const brain = faction.brain
    if (brain === undefined || faction.paused) continue
    config ??= getConfig()
    // Same cadence as the bootstrap brain.
    if (tick % config.brainIntervalTicks !== 0 || !config.factoryEnabled) continue
    let f = getFactory(name)
    if (f === undefined) {
      if (brain.milestones["first-electricity-materials"] === undefined) continue
      f = startFactory(faction)
    }
    // B152/B158: a planned pole ghost whose place job was dropped is invisible to `unpoweredModules` (the layout still
    // has the pole) while the world is an island. The source is fixed at the drop (`dropEvictedPoleGhosts`); this is the
    // one-time repair for saves that already carry such ghosts, versioned so a save with the old `poleAdoptDone` runs it
    // once more.
    // Version 2 also repairs saves whose old one-shot flag is already set; bump only for a new repair migration.
    const poleAdopt = f.poleAdoptVersion ?? (f.poleAdoptDone === true ? 1 : 0)
    if (poleAdopt < 2) {
      f.poleAdoptVersion = 2
      f.poleAdoptDone = true
      const adopted = EX.adoptPlannedPoles(factionSurface(faction), faction, f.layout, config.factoryPowerBuildPriority)
      if (adopted > 0) log(`[rival-engineers] faction ${faction.name}: adopted ${adopted} planned pole ghost(s) without a job (one-time migration)`)
    }
    think(faction, f, config)
  }
}

export interface Ctx {
  faction: FactionState
  f: FactoryState
  config: Config
  force: LuaForce
  surface: LuaSurface
  tick: number
  entities: Record<string, string>
  waiting: string[]
}

function think(faction: FactionState, f: FactoryState, config: Config): void {
  AR.reconcile(faction, f)
  // D69: a save from before the constraint store keeps its maps on the state; move them once.
  f.constraints = CS.adoptLegacy(f as never, f.constraints)
  const ctx: Ctx = {
    faction,
    f,
    config,
    force: factionForce(faction),
    surface: factionSurface(faction),
    tick: game.tick,
    entities: parsePairs(config.factoryEntities),
    waiting: [],
  }
  updateGoals(ctx)
  FU.serviceRetiring({ faction, f, config, surface: factionSurface(faction), tick: game.tick })
  if (FU.checkMineOre(ctx, planning(f) !== undefined) === undefined) FU.replaceBurnerOutposts({ ...ctx, electricDrill: ctx.entities["electric-drill"] ?? "electric-mining-drill" }, planning(f) !== undefined)
  measureAndReconcile(ctx)
  const d = designNow(ctx)
  tempFactories(ctx)
  const hooks: EX.ExploreHooks = { busy: () => (planning(f) !== undefined ? "the current plan" : !GLC.everDone(f.goals, "power") ? "power" : undefined), startRadar: (role, site) => startRadar(ctx, role, site) }
  EX.baseRadar(ctx, hooks)
  EX.robotsStep(ctx, {
    busy: hooks.busy,
    start: (role, anchor, window, chests) => {
      const params = { roboport: ctx.entities.roboport ?? "roboport", chests }
      const def = makeModule("roboport", params)
      const node: DesignNode = { role, kind: "sink", generator: "roboport", params, def, item: params.roboport, need: 0, capacity: 0, inputs: [], powerW: LG.rateIn(def.rates.inputs, "electricity"), cluster: 1 }
      startGoal(ctx, { kind: "robots", nodes: [node], edges: [], techs: [] }, undefined, { x: anchor.x, y: anchor.y, window })
    },
  })
  EX.exploreStep(ctx, hooks)
  advanceGoals(ctx, d)
  LF.research(ctx, d)
  LF.handFeed(ctx)
  if (ctx.tick - f.lastUpkeep >= UPKEEP_INTERVAL) {
    f.lastUpkeep = ctx.tick
    upkeep(ctx)
    EX.robotsUpkeep(ctx, ctx.config.factoryBuildPriority)
    EX.upgradeOutputChests(ctx, ctx.config.factoryBuildPriority)
  }
  LF.milestones(ctx)
  ST.sampleScience(ctx, LF.packsAutomated(f), (name) => mark(faction, name))
  f.waiting = ctx.waiting
  checkStall(ctx)
}

// ---------------------------------------------------------------------------------------------------------
// Design

function enabledRecipes(force: LuaForce): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [name, r] of pairs(force.recipes)) if (r.enabled) out[name as string] = true
  return out
}

function researchedTechs(force: LuaForce): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [name, t] of pairs(force.technologies)) if (t.researched) out[name as string] = true
  return out
}

function makeModule(this: void, gen: ModuleKind, params: Record<string, unknown>): ModuleDef {
  if (gen === "curated") return curatedModule(params.id as string)
  return generatedModule(gen, params)
}

export function designContext(ctx: { faction: FactionState; force: LuaForce; config: Config; entities: Record<string, string> }, stage = 0, forceSharing = false): DesignContext {
  const brain = ctx.faction.brain!
  const researched = researchedTechs(ctx.force)
  const plannable: Record<string, boolean> = {}
  for (const t of researchGoal()) plannable[t] = true
  const resources: string[] = []
  for (const p of brain.patches) if (resources.indexOf(p.name) < 0) resources.push(p.name)
  // M7c: fluid resources (crude oil) are never bootstrap patches: count them always, so crude demand gets a pumpjack
  // field, whose goal explores for a field when none is known (`OIL.fieldModule`).
  for (const [name, proto] of pairs(prototypes.get_entity_filtered([{ filter: "type", type: "resource" }]))) {
    if (proto.mineable_properties.products?.[0]?.type === "fluid" && resources.indexOf(name as string) < 0) resources.push(name as string)
  }
  resources.sort()
  const packs: string[] = []
  for (const [p] of string.gmatch(ctx.config.researchSciencePacks, "[^,%s]+")) packs.push(p)
  const bufferRows: string[] = []
  for (const [p] of string.gmatch(ctx.config.moduleBufferRows, "[^,%s]+")) bufferRows.push(p)
  const e = ctx.entities
  return {
    facts: prototypeFacts,
    make: makeModule,
    researched,
    enabled: enabledRecipes(ctx.force),
    plannable,
    resources,
    // M7d.5: passive providers once researched (robots build from them).
    buffer: EX.bufferChest(ctx),
    robotHub: EX.robotHub(ctx, getFactory(ctx.faction.name)?.graph),
    bufferRows,
    fuel: brain.catalog.fuel,
    assembler: e.assembler ?? "assembling-machine-1",
    assemblers: [e.assembler ?? "assembling-machine-1", e["assembler-2"] ?? "assembling-machine-2"],
    rowInputs: ctx.config.factoryRowInputs,
    furnace: brain.catalog.furnace,
    electricDrill: e["electric-drill"] ?? "electric-mining-drill",
    burnerDrill: brain.catalog.drill,
    lab: e.lab ?? "lab",
    boiler: e.boiler ?? "boiler",
    engine: e.engine ?? "steam-engine",
    packs,
    researchUnitTime: ST.labUnitTime(ctx.config, stage),
    tiers: RT.tiers(),
    policy: policyFor(ctx.config),
    taps: getFactory(ctx.faction.name)?.taps,
    curated: ST.curatedProducers(),
    sharing: ST.sharing(ctx, getFactory(ctx.faction.name), stage, forceSharing),
    retiring: ST.retiringRoles(getFactory(ctx.faction.name)),
    providerShort: CS.flags(getFactory(ctx.faction.name)?.constraints, "providerShort"),
    noMerge: CS.flags(getFactory(ctx.faction.name)?.constraints, "noMerge"),
    minTopUp: ctx.config.factoryMinTopUp,
    ownSite: CS.flags(getFactory(ctx.faction.name)?.constraints, "ownSite"),
    providerCaps: ST.providerCaps(getFactory(ctx.faction.name)),
    builtGenerators: ST.builtGenerators(getFactory(ctx.faction.name)),
    providerFeeds: ST.providerFeeds(getFactory(ctx.faction.name)),
    powerCaps: ST.powerCaps(getFactory(ctx.faction.name)),
    cluster1Max: ST.cluster1Max(getFactory(ctx.faction.name)),
    noFeed: CS.flags(getFactory(ctx.faction.name)?.constraints, "noFeed"),
    maxSmelters: stage >= 0 && ST.firstLateStage(ctx.config) >= 0 && stage >= ST.firstLateStage(ctx.config),
  }
}

function policyFor(config: Config) {
  // The same policy the planner entries use (config overrides applied).
  return RT.entryPolicy({ request: { modules: [], connections: [], center: { x: 0, y: 0 }, region: { x: 0, y: 0, w: 0, h: 0 } }, policy: config.layoutPolicy } as never)
}

/** The design of the current stage: the labs consume every pack of the stage target (times the design margin). */
function designNow(ctx: Ctx): Design | undefined {
  const f = ctx.f
  const stages = ST.parseStages(ctx.config.factoryTargets)
  const stageIndex = math.min(f.stage, stages.length - 1)
  const stage = stages[stageIndex]
  if (stage === undefined || stage.length === 0) return undefined
  const margin = ctx.config.factoryDesignMargin
  const items = stage.map((t) => ({ item: t.item, perSecond: (t.perMinute / 60) * margin }))
  const targetKey = items.map((t) => `${t.item}=${string.format("%.6g", t.perSecond)}`).join(",")
  // The design is a pure function of the target, the force's tech and the graph: recompute it only when they change
  // (a session cache: rebuilt after load, same result, so it is deterministic).
  let researchedCount = 0
  for (const [, t] of pairs(ctx.force.technologies)) if (t.researched) researchedCount++
  let taps = 0
  for (const [, list] of pairs(f.taps ?? {})) taps += (list as string[]).length
  const c = f.constraints
  let blocked = ""
  for (const role of CS.keys(c, "growFails")) if ((CS.value(c, "growFails", role) ?? 0) >= ST.GROW_MAX_FAILS) blocked += `${role};`
  const caps = ST.providerCaps(f)
  let short = ""
  for (const role of CS.keys(c, "providerShort")) short += `${role}:${string.format("%.6g", caps[role] ?? 0)};`
  let retiring = ""
  for (const [role] of pairs(f.retiring ?? {})) retiring += `${role as string};`
  const flagKey = ["fallback", "noTap", "providerSplit", "providerNoTap", "noMerge", "noFeed", "ownSite"].map((k) => CS.keys(c, k as CS.ConstraintKind).join(";")).join("|")
  const key = `${flagKey}|${blocked}|${short}|${retiring}|${ST.designSignals(f)}|${f.needUndergrounds ?? ""}|${f.needSplitters ?? ""}|${taps}|${ctx.faction.brain!.milestones["automated-science"] !== undefined}|${f.stage}|${targetKey}|${researchedCount}|${LG.designGraphKey(f.graph)}|${f.goals.length}|${ctx.faction.brain!.patches.length}`
  const cached = designCache[ctx.faction.name]
  if (cached !== undefined && cached.key === key) return cached.design
  // The mall joins the design once science is automated (the crew hand-craft buildings until then).
  const mallId = ctx.config.factoryMall
  const mall = mallId !== "" && ctx.faction.brain!.milestones["automated-science"] !== undefined ? { id: mallId, utilization: ctx.config.factoryMallUtilization } : undefined
  const dctx = designContext(ctx, stageIndex)
  // M7d.5 (D77): construction robots and roboports are stocked once their technology is researched.
  const stock = DS.robotStock((t) => ctx.force.technologies[t]?.researched === true, (r) => ctx.force.recipes[r]?.enabled === true)
  const d = DS.design(dctx, { item: items[0].item, perSecond: items[0].perSecond, also: items.slice(1), mall, stock })
  const diff = DS.diffDesign(d, f.graph, (node) => LO.findModule(f.layout, node)?.canonical)
  // B60: remember built providers with no expansion unit. The next design keeps their capacity and plans the
  // residual as a parallel provider; it never relocates this one.
  for (const gr of diff.grow) {
    if (gr.units >= 1 || gr.node === undefined) continue
    const node = f.graph.nodes[gr.node]
    if (node === undefined || (node.kind !== "module" && node.kind !== "outpost")) continue
    if (CS.add((f.constraints ??= {}), "providerShort", gr.role)) {
      log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} is an unexpandable provider (${string.format("%.3g", gr.have)}/${string.format("%.3g", gr.need)}); keeping it and planning a parallel provider`)
    }
  }
  f.design = {
    stage: f.stage,
    nodes: d.nodes.length,
    edges: d.edges.length,
    electricW: d.electricW,
    techs: d.techs,
    errors: d.errors,
    overflow: d.overflow,
    clusters: d.clusters,
    missing: diff.missing.length,
    grow: diff.grow.length,
    cluster1Share: DS.clusterFraction(dctx, 1, d.clusters),
  }
  const researched = researchedTechs(ctx.force)
  // B19 (like D36): splitters first when sharing providers saves at least `logistics-share-min-modules` modules.
  const spTech = unresearchedTech(ctx, "splitter")
  if (f.needSplitters === undefined && spTech !== undefined && ctx.config.logisticsShareMinModules > 0) {
    const sc = designContext(ctx, stageIndex, true)
    if (sc.sharing !== undefined) {
      const alt = DS.design(sc, { item: items[0].item, perSecond: items[0].perSecond, also: items.slice(1), mall })
      const altDiff = DS.diffDesign(alt, f.graph, (node) => LO.findModule(f.layout, node)?.canonical)
      let fresh = 0
      for (const n of diff.missing) if (n.kind !== "power" && n.kind !== "labs" && NF.nodeServes(n) !== "power") fresh++
      const saved = diff.missing.length - altDiff.missing.length
      if (fresh > 0 && saved >= ctx.config.logisticsShareMinModules) {
        f.needSplitters = spTech
        log(`[rival-engineers] faction ${ctx.faction.name}: B19 sharing providers saves ${saved} modules: ${spTech} is now a prerequisite of production`)
      }
    }
  }
  // M7c: a technology no lab can research yet: an unresearched trigger technology, or one behind such a trigger.
  const triggerMemo: Record<string, boolean> = {}
  const waitsOnTrigger = (tech: string): boolean => {
    const known = triggerMemo[tech]
    if (known !== undefined) return known
    triggerMemo[tech] = false
    const t = ctx.force.technologies[tech]
    let blocked = t !== undefined && !t.researched && t.prototype.research_trigger !== undefined
    if (t !== undefined && !t.researched && !blocked) for (const [pre] of pairs(t.prerequisites)) if (waitsOnTrigger(pre as string)) blocked = true
    triggerMemo[tech] = blocked
    return blocked
  }
  // M7d.5 (user, 2026-11-07): once the design contains a cell, split a production goal by dependency layer, so no
  // plan carries the whole blue/robot chain (the 15-module g202 plan).
  const splitProduction = d.nodes.some((n) => n.generator === "engine-cell" || n.generator === "robot-cell")
  const goals = DS.goalsFrom(diff, researched, waitsOnTrigger, splitProduction)
  for (const tech of [f.needUndergrounds, f.needSplitters]) {
    if (tech === undefined || researched[tech]) continue
    if (d.techs.indexOf(tech) < 0) d.techs = [...d.techs, tech]
    for (const spec of goals) if ((spec.kind === "production" || spec.kind === "mall") && spec.techs.indexOf(tech) < 0) spec.techs.push(tech)
    f.design.techs = d.techs
  }
  ;(d as Design & { goals?: GoalSpec[] }).goals = goals
  designCache[ctx.faction.name] = { key, design: d }
  return d
}

// ---------------------------------------------------------------------------------------------------------
// Goals

function activeGoal(f: FactoryState, kind: GoalKind): FactoryGoal | undefined {
  for (const g of f.goals) if (g.kind === kind && (g.status === "planning" || g.status === "building")) return g
  return undefined
}

function planning(f: FactoryState): FactoryGoal | undefined {
  for (const g of f.goals) if (g.status === "planning") return g
  return undefined
}

function lastOf(f: FactoryState, kind: GoalKind): FactoryGoal | undefined {
  let out: FactoryGoal | undefined
  for (const g of f.goals) if (g.kind === kind) out = g
  return out
}

function goalNodes(g: GoalSpec, f: FactoryState): GoalNode[] {
  const out: GoalNode[] = []
  for (const n of g.nodes) {
    out.push({ role: n.role, id: IDS.moduleId(`n${f.graph.nextId++}`), kind: n.kind, generator: n.generator, params: n.params, item: n.item, need: n.need, capacity: n.capacity, inputs: n.inputs, powerW: n.powerW, newSite: n.newSite, homeCluster: n.homeCluster, family: n.family, serves: n.serves })
  }
  return out
}

/** Built already (or being built): power, labs. A kind's goal may start once the previous kinds are built. */
function built(f: FactoryState, kind: GoalKind): boolean {
  const g = lastOf(f, kind)
  return g !== undefined && g.status === "done"
}

export interface FactoryGoalSelectionSnapshot {
  version: 1
  faction: string
  stage: number
  specs: GoalSelectionSpec[]
  state: GoalSelectionState
}

/**
 * Plain-data input to the goal scheduler. Capture this through the remote interface when a live game chooses the
 * wrong next goal, then paste it into a T1 fixture: replay does not need the save or any Factorio object.
 */
function selectionSnapshot(faction: string, f: FactoryState, specs: GoalSpec[], researched: Record<string, boolean>): FactoryGoalSelectionSnapshot {
  const active: Partial<Record<GoalKind, boolean>> = {}
  const completed: Partial<Record<GoalKind, boolean>> = {}
  // M7c: a stalled building goal still holds its kind's lock here. Released, it let the next blue cluster plan a second
  // copy of the stalled chain (seed 11, two oil modules on one field). Its feeders pass by `feedsBuilding`; the
  // growth waits (B52/B98, `startGrow`) skip it.
  for (const kind of ["power", "labs", "production", "mall", "grow", "repair", "temp", "radar", "robots"] as GoalKind[]) {
    active[kind] = f.goals.some((g) => g.kind === kind && (g.status === "planning" || g.status === "building"))
    completed[kind] = built(f, kind)
  }
  const activeGrowth = activeGoal(f, "grow")
  return {
    version: 1,
    faction,
    stage: f.stage,
    specs: specs.map((spec) => ({
      kind: spec.kind,
      cluster: spec.cluster,
      techs: spec.techs,
      feedsBuilding: spec.kind === "production" ? GH.feedsBuilding(f, spec) : undefined,
      growth: spec.growth === undefined ? undefined : {
        role: spec.growth.role,
        have: spec.growth.have,
        need: spec.growth.need,
        units: spec.growth.units,
        power: NF.servesPower(f.graph.nodes[spec.growth.node], spec.growth.role),
        failed: CS.value(f.constraints, "growFails", spec.growth.role) ?? 0,
      },
    })),
    state: {
      active,
      built: completed,
      planning: planning(f) !== undefined,
      powerNodeExists: LG.nodeByRole(f.graph, "power") !== undefined,
      growingPower: activeGrowth?.growth !== undefined && NF.servesPower(f.graph.nodes[activeGrowth.growth.node], ""),
      researched,
      growMaxFails: ST.GROW_MAX_FAILS,
    },
  }
}

/** Latest live scheduler input, for turning a Factorio-only failure into a cheap deterministic replay. */
export function factoryGoalSelectionSnapshot(name: string): FactoryGoalSelectionSnapshot | undefined {
  const faction = storage.factions[name]
  const f = storage.factories?.[name]
  const design = designCache[name]?.design as (Design & { goals?: GoalSpec[] }) | undefined
  if (faction === undefined || f === undefined || design === undefined) return undefined
  return selectionSnapshot(name, f, design.goals ?? [], researchedTechs(factionForce(faction)))
}

/**
 * Debug probe (remote `design_debug`): the latest design's edges whose role contains `filter`, and the goals built from
 * it (kind, node roles, edge roles, growth), as plain data.
 */
export function factoryDesignDebug(name: string, filter = ""): unknown {
  const design = designCache[name]?.design as (Design & { goals?: GoalSpec[] }) | undefined
  if (design === undefined) return undefined
  const has = (r: string): boolean => filter === "" || string.find(r, filter, 1, true)[0] !== undefined
  return {
    edges: design.edges.filter((e) => has(e.role)).map((e) => ({ role: e.role, item: e.item, from: e.from, to: e.to, toPort: e.toPort, rate: e.rate })),
    nodes: design.nodes.filter((n) => has(n.role)).map((n) => ({ role: n.role, kind: n.kind, generator: n.generator, need: n.need, capacity: n.capacity })),
    goals: (design.goals ?? []).map((g) => ({
      kind: g.kind,
      cluster: g.cluster,
      nodes: g.nodes.filter((n) => has(n.role)).map((n) => n.role),
      edges: g.edges.filter((e) => has(e.role)).map((e) => e.role),
      growth: g.growth !== undefined ? { role: g.growth.role, units: g.growth.units, need: g.growth.need, have: g.growth.have } : undefined,
    })),
  }
}

/** Debug probe: the live graph's edges whose role or item contains `filter`, with their last measurement. */
export function factoryEdgeDebug(name: string, filter = ""): unknown {
  const f = storage.factories?.[name]
  if (f === undefined) return undefined
  const has = (r: string): boolean => filter === "" || string.find(r, filter, 1, true)[0] !== undefined
  const out: unknown[] = []
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e === undefined || e.kind !== "belt" || !(has(e.role) || has(e.item))) continue
    out.push({ id, item: e.item, planned: e.plannedRate, measured: e.measuredRate, tick: e.measuredTick, full: e.measuredFull, capacity: e.capacityRate })
  }
  return { probe: f.meter?.probe?.edge, probes: f.meter?.probes, edges: out }
}

/** Debug probe (M7c.8): the build check of an edge's routes (what a repair would find). */
export function factoryCheckDebug(name: string, edgeFilter: string): unknown {
  const f = storage.factories?.[name]
  const faction = storage.factions?.[name]
  if (f === undefined || faction === undefined) return undefined
  const out: unknown[] = []
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e === undefined || e.kind !== "belt" || string.find(e.role, edgeFilter, 1, true)[0] === undefined) continue
    const parts: BuildParts = { modules: [], routes: [], poles: [] }
    for (const rid of e.physical) if (f.layout.routes[rid] !== undefined) parts.routes.push(IDS.routeId(rid))
    const c = checkBuild(game.get_surface(faction.surface)!, faction.force, f.layout, parts)
    const at = (s: EntitySpec): string => `${s.name}@${s.x},${s.y}:${s.dir ?? 0}`
    // B132: what the repair's B83 check would decide (all pieces can stand while a route's steps do not reach the port).
    const to = LG.connectModule(f.graph, e.to, (mid: string) => LO.findModule(f.layout, mid) !== undefined) ?? e.to
    const land = e.toPort !== undefined ? LO.routesLand(f.layout, e.physical, { module: to, port: e.toPort }) : undefined
    out.push({ edge: id, physical: e.physical, land, missing: c.missing.map((s) => at(s)), misdirected: c.misdirected.map((m) => at(m.spec)), stale: c.stale.map((m) => at(m.spec)), intruders: c.intruders.length, conflicts: c.conflicts.length })
  }
  return out
}

/** Debug probe (M7c.8): the layout routes with a step on tile (x, y), or whose item contains `item`: ends and ports. */
export function factoryRouteDebug(name: string, x?: number, y?: number, item?: string): unknown {
  const f = storage.factories?.[name]
  if (f === undefined) return undefined
  const out: unknown[] = []
  for (const [id, r] of pairs(f.layout.routes)) {
    let hit = item !== undefined && string.find(r.item, item, 1, true)[0] !== undefined
    if (!hit && x !== undefined && y !== undefined) for (const st of r.steps) if (st.x === x && st.y === y) hit = true
    if (!hit) continue
    const first = r.steps[0]
    const last = r.steps[r.steps.length - 1]
    const portAt = (ref: LO.PortRef | undefined): unknown => {
      if (ref === undefined) return undefined
      const m = LO.findModule(f.layout, ref.module)
      const p = m !== undefined ? LO.findPort(m, ref.port) : undefined
      return m !== undefined && p !== undefined ? { module: ref.module, port: ref.port, tile: LO.portTile(m, p), outside: LO.portOutside(m, p) } : { module: ref.module, port: ref.port, missing: true }
    }
    out.push({ id, item: r.item, conn: r.conn, from: portAt(r.from), to: portAt(r.to), steps: r.steps.length, first, last, tapOf: r.tapOf, fixed: (r as { fixed?: boolean }).fixed, all: r.steps.length <= 400 ? r.steps.map((st) => `${st.kind}@${st.x},${st.y}:${st.dir}`).join(" ") : undefined })
  }
  return out
}

/**
 * Debug probe (B156): the layout claims on and around a tile and the modules whose rect covers it. A fixed-spot
 * placement failure says `occupied at x,y` (or `reserved`, `routed`, `mine-claimed`); no entity need stand there,
 * because these are planner claims. Used to explain why a generated field/module cannot go where its plan put it.
 */
export function factoryClaimDebug(name: string, x: number, y: number, radius = 3): unknown {
  const f = storage.factories?.[name]
  if (f === undefined) return undefined
  const layout = f.layout
  const covering: unknown[] = []
  for (const m of layout.modules) {
    const r = m.rect
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      covering.push({ id: m.id, generator: m.canonical.generator, rect: r, wells: m.canonical.params?.wells })
    }
  }
  const claims: unknown[] = []
  const indexes: { index: "occ" | "reserved" | "routeOcc" | "mine"; map: Record<number, string> | undefined }[] = [
    { index: "occ", map: layout.occ },
    { index: "reserved", map: layout.reserved },
    { index: "routeOcc", map: layout.routeOcc },
    { index: "mine", map: layout.mine },
  ]
  for (const { index, map } of indexes) {
    for (const [k, tag] of pairs(map ?? {})) {
      const cx = keyX(k as number)
      const cy = keyY(k as number)
      if (math.abs(cx - x) > radius || math.abs(cy - y) > radius) continue
      claims.push({ index, x: cx, y: cy, owner: tag })
    }
  }
  return { at: { x, y }, covering, claims }
}

function advanceGoals(ctx: Ctx, d: Design | undefined): void {
  const f = ctx.f
  if (d === undefined) {
    ctx.waiting.push("no stage target")
    return
  }
  const specs = (d as Design & { goals?: GoalSpec[] }).goals ?? []
  if (d.errors.length > 0) ctx.waiting.push(`design: ${d.errors.join("; ")}`)
  const snapshot = selectionSnapshot(ctx.faction.name, f, specs, researchedTechs(ctx.force))
  const selection = selectGoals(snapshot.specs, snapshot.state)
  for (const reason of selection.waiting) ctx.waiting.push(reason)
  f.idle = false
  if (selection.pending === 0) {
    // The stage is fully planned: once everything is built, move to the next stage.
    let allBuilt = true
    for (const n of LG.nodesOf(f.graph)) if (n.lifecycle !== "built") allBuilt = false
    const stages = ST.parseStages(ctx.config.factoryTargets)
    // B64: with the debug/soak infinite sink on, research is never finished: the labs still want packs, so the
    // factory must keep growing and repairing to sustain them (otherwise it idles and the sink only drains stockpiles).
    if (allBuilt && f.stage + 1 >= stages.length && activeGoal(f, "grow") === undefined && activeGoal(f, "repair") === undefined) f.idle = ST.researchDone(ctx.force) && !ctx.config.debugInfiniteResearch
    if (allBuilt && f.stage + 1 < stages.length) {
      f.stage++
      for (const k of ["growFails", "providerShort", "providerSplit", "providerNoTap", "cluster1Caps"]) CS.clear(f.constraints, k as CS.ConstraintKind)
      mark(ctx.faction, `stage-${f.stage + 1}`)
      log(`[rival-engineers] faction ${ctx.faction.name}: stage ${f.stage + 1} of ${stages.length}`)
    }
    return
  }
  for (const decision of selection.decisions) {
    if (decision.waiting !== undefined) ctx.waiting.push(decision.waiting)
    if (decision.action === "skip") continue
    const spec = specs[decision.index]
    const retry = f.siteRetry?.[spec.kind]
    if (retry !== undefined) {
      if (ctx.tick < retry) {
        ctx.waiting.push(`${spec.kind}: paused, no site found (B53); planning again at tick ${retry}`)
        continue
      }
      f.siteRetry![spec.kind] = undefined
      log(`[rival-engineers] faction ${ctx.faction.name}: SITE RETRY PAUSE (B53) over: planning ${spec.kind} goals again`)
    }
    const held = EX.exploreHolds(ctx, spec.kind)
    if (held !== undefined) {
      ctx.waiting.push(held)
      continue
    }
    if (spec.kind === "grow") {
      if (startGrow(ctx, spec) === true) return
      continue
    }
    if (startGoal(ctx, spec)) return
  }
}

function startGoal(ctx: Ctx, spec: GoalSpec, site?: FactoryGoal["site"], anchor?: FactoryGoal["anchor"]): boolean {
  const f = ctx.f
  // D55/P36: don't plan a replacement while the old module's clear jobs are still on the board. Its footprint is still
  // `OWN` in the terrain view, so the only free part of the patch would fail placement and the goal would burn every
  // attempt in a few game-seconds (seed 3333: coal>power, 266 entities, 8 plan failures in a row).
  if (f.relocation !== undefined && !REL.pruneRelocations(f.relocation, ctx.faction.board.active)) f.relocation = undefined
  const roles: string[] = []
  for (const n of spec.nodes) roles.push(n.role)
  const held = REL.pendingRelocation(f.relocation, roles, ctx.faction.board.active)
  if (held !== undefined) {
    ctx.waiting.push(`${held}: waits for its old module to be deconstructed`)
    return false
  }
  const g: FactoryGoal = {
    id: IDS.goalId(`g${f.nextGoal++}`),
    kind: spec.kind,
    status: "planning",
    nodes: goalNodes(spec, f),
    edges: spec.edges,
    techs: spec.techs,
    attempts: 0,
    radius: ctx.config.factoryRegionRadius,
    createdTick: ctx.tick,
    placed: 0,
    rounds: 0,
    site,
    anchor,
  }
  f.goals.push(g)
  planGoal(ctx, g)
  return true
}

/**
 * Expand-first (LayoutPolicy.expansion): grow a built module that falls short of its design rate by whole units of its
 * `expand` axis. The moved entities and the belts of its rerouted ports are picked up, then the new entities built.
 * When it can't grow (no room, at its cap), the shortfall stays visible as a waiting reason (D24: a new producer
 * cluster is the remedy, M5b/M6).
 */
function startGrow(ctx: Ctx, spec: GoalSpec): boolean | "wait" {
  const f = ctx.f
  const gr = spec.growth!
  const node = f.graph.nodes[gr.node]
  if (gr.units < 1 || node === undefined || node.lifecycle !== "built") {
    ctx.waiting.push(`${gr.role} short (${string.format("%.3g", gr.have)}/${string.format("%.3g", gr.need)}): cannot expand`)
    return false
  }
  // B98 (seed 2034469): a growth plan can take a minute of game time to compute (a whole-patch mine's move); one that
  // had to wait for a goal still building is not planned again until that goal is done.
  const blocker = f.growWaits?.[gr.node]
  if (blocker !== undefined) {
    if (f.graph.nodes[blocker]?.lifecycle === "building" && !GH.nodeGoalStalled(f, ctx.tick, ctx.config.stallTicks, blocker)) {
      ctx.waiting.push(`${gr.role} growth waits for ${f.graph.nodes[blocker].goal ?? blocker} to finish building`)
      return "wait"
    }
    delete f.growWaits![gr.node]
  }
  const t = storage.terrains?.[f.terrain]
  if (t === undefined) return false
  // M6a.2 (seed 222): ore under a mining module's growth may be worked out since the last scan: look again.
  const gm = LO.findModule(f.layout, gr.node)
  if (gm?.canonical.anchor?.resource !== undefined) {
    const ga = LO.growthArea(gm) ?? gm.rect
    for (let cx = math.floor(math.min(gm.rect.x, ga.x) / 32); cx <= math.floor((math.max(gm.rect.x + gm.rect.w, ga.x + ga.w) + 2) / 32); cx++) {
      for (let cy = math.floor(math.min(gm.rect.y, ga.y) / 32); cy <= math.floor((math.max(gm.rect.y + gm.rect.h, ga.y + ga.h) + 2) / 32); cy++) if (ctx.surface.is_chunk_generated({ x: cx, y: cy })) scanChunk(t, ctx.surface, cx, cy)
    }
  }
  const policy = policyFor(ctx.config)
  // B58 follow-up / 7718665: growth must obey the same underground cap as a normal plan. Before `logistics` that is 1
  // (no undergrounds); otherwise a growth can ghost underground belts with no craftable recipe and deadlock research.
  const tier = GROW.limitUnderground(RT.tiers()[0], maxUndergroundNow(ctx))
  const plan = GROW.planGrowth(f.layout, RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t), false), prototypeFacts, policy, tier, gr.node, gr.units, ctx.entities.pole ?? "small-electric-pole", `poles:g${f.nextGoal}:`, gr.reclaim === true)
  if (!plan.ok) {
    f.growthDiagnostics ??= {}
    f.growthDiagnostics[gr.node] = { tick: ctx.tick, reason: plan.reason ?? "unknown", units: gr.units }
    recordDiagnostic(ctx.faction, { tick: ctx.tick, kind: "planner", decision: "growth-rejected", reason: plan.reason, data: { node: gr.node, role: gr.role, units: gr.units } })
    ctx.waiting.push(`${gr.role} short: expansion failed (${plan.reason})`)
    // D55: a re-claim that finds no better part of the patch is no growth failure (the mine is relocated instead).
    if (gr.reclaim === true) return false
    const c = (f.constraints ??= {})
    const fails = (CS.value(c, "growFails", gr.role) ?? 0) + 1
    CS.setValue(c, "growFails", gr.role, fails)
    // B60: after its growth attempts are spent, this provider is a fixed-capacity member of its group. The design
    // keeps it and adds a parallel provider for the residual; it is never deconstructed.
    if (fails >= ST.GROW_MAX_FAILS) {
      if (CS.add(c, "providerShort", gr.role)) {
        log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} stays at its current capacity; planning a parallel provider`)
      }
    }
    // A cluster-1 module that can't grow caps cluster 1's share (the other clusters make the rest).
    const grown = f.graph.nodes[gr.node]
    if (fails >= ST.GROW_MAX_FAILS && grown !== undefined && NF.nodeServes(grown) !== "power" && NF.nodeHomeCluster(grown) === 1 && !NF.nodeParallel(grown) && gr.need > 0) {
      const cap = math.max(0.05, math.min(1, gr.have / gr.need)) * (f.design?.cluster1Share ?? 1)
      CS.setValue(c, "cluster1Caps", gr.role, cap)
      log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} can't grow: production cluster 1 takes at most ${string.format("%.3f", cap)} of the target`)
    }
    log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} cannot grow by ${gr.units} units (failure ${fails}): ${plan.reason}`)
    return false
  }
  // B52 (seed 3333): a growth that reroutes a connection still being built (its producer or consumer under
  // construction) leaves that goal placing its old copy of the route. Wait for it; no growth failure.
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.kind !== "belt" || plan.rerouted.indexOf(e.role) < 0) continue
    for (const end of [e.from, e.to]) {
      const other = end !== undefined && end !== gr.node ? f.graph.nodes[end] : undefined
      if (other === undefined || other.lifecycle !== "building") continue
      // M7c: a stalled goal places nothing, so the growth does not wait for it (it may be what the goal waits for).
      if (GH.nodeGoalStalled(f, ctx.tick, ctx.config.stallTicks, other.id)) continue
      ctx.waiting.push(`${gr.role} growth waits for ${other.goal ?? other.id} to finish building (it reroutes ${e.role})`)
      f.growWaits ??= {}
      f.growWaits[gr.node] = other.id
      return "wait"
    }
  }
  const g: FactoryGoal = {
    id: IDS.goalId(`g${f.nextGoal++}`),
    kind: "grow",
    status: "building",
    nodes: [],
    edges: [],
    techs: [],
    attempts: 1,
    radius: 0,
    createdTick: ctx.tick,
    plannedTick: ctx.tick,
    placed: 0,
    rounds: 0,
    growth: { node: gr.node, units: gr.units },
  }
  f.goals.push(g)
  f.layout = plan.layout
  // B37: the evicted poles are in `plan.remove`; the new lines join the power edges.
  f.layout.evictedPoles = undefined
  powerEdges(f)
  const m = LO.findModule(f.layout, gr.node)!
  node.capacity = { inputs: m.canonical.rates.inputs, outputs: m.canonical.rates.outputs }
  // B52: a power node's supply grows with it (graph power balance, measured load).
  if (node.kind === "power") node.powerW = LG.rateIn(node.capacity.outputs, "electricity")
  node.module = m.canonical.id
  node.lifecycle = "building"
  node.goal = g.id
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.kind !== "belt" || plan.rerouted.indexOf(e.role) < 0) continue
    // Its new route (a splitter tap: its root's too).
    const physical: string[] = []
    for (const rid of f.layout.routeOrder) {
      const r = f.layout.routes[rid]
      if (r.conn !== e.role) continue
      if (r.tapOf !== undefined) physical.push(r.tapOf)
      physical.push(rid)
    }
    e.physical = physical.length > 0 ? physical : [`route:${e.role}`]
  }
  const clearJobs: IDS.JobId[] = []
  const taken: Record<number, boolean> = {}
  for (const e of plan.add) {
    const p = prototypes.entity[e.name]
    const sideways = e.dir === defines.direction.east || e.dir === defines.direction.west
    const w = p !== undefined ? (sideways ? p.tile_height : p.tile_width) : 1
    const h = p !== undefined ? (sideways ? p.tile_width : p.tile_height) : 1
    const x1 = math.floor(e.x - w / 2 + 0.01)
    const y1 = math.floor(e.y - h / 2 + 0.01)
    for (let x = x1; x < x1 + w; x++) for (let y = y1; y < y1 + h; y++) taken[tkey(x, y)] = true
  }
  for (const e of evictSites(ctx.faction, ctx.surface, taken, `goal ${g.id} (grow ${gr.role})`)) clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
  // D71 (b): old poles are picked up once the growth's new poles stand (make before break).
  const breakAfter: LuaEntity[] = []
  for (const e of plan.remove) {
    const found = findEntities(ctx.surface, { name: e.name, position: { x: e.x, y: e.y }, force: ctx.faction.force, limit: 1 })[0]
    if (found !== undefined && found.type === "electric-pole") breakAfter.push(found)
    else if (found !== undefined) clearJobs.push(addClearJob(ctx.faction, found, ctx.config.factoryBuildPriority))
    // B37: an evicted pole line may still be a ghost.
    else for (const gh of findEntities(ctx.surface, { ghost_name: e.name, position: { x: e.x, y: e.y }, force: ctx.faction.force, limit: 1 })) destroyEntity(gh)
  }
  const reserved = ctx.faction.brain!.reserved
  for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) reserved[tkey(x, y)] = true
  claimModuleFields(ctx, m)
  for (const rid of f.layout.routeOrder) if (plan.rerouted.indexOf(f.layout.routes[rid].conn) >= 0) for (const k of f.layout.routes[rid].tiles) reserved[k] = true
  // M6a.2: the tiles the growth gave up (old route tiles, the old footprint's margin) are free again.
  resyncReserved(ctx.faction, f.layout)
  const priority = NF.servesPower(node, gr.role) ? POWER_JOB_PRIORITY : ctx.config.factoryBuildPriority
  const poleJobs = breakAfter.length > 0 ? RT.placeReplacementPoles(ctx.surface, ctx.faction, plan.add, clearJobs, { fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority }) : []
  if (poleJobs.length === 0) for (const e of breakAfter) clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
  g.growBuild = { phase: poleJobs.length > 0 ? "poles" : "clear", clearJobs, add: plan.add, ghosts: [], placeJobs: [], poleJobs, breakAfter: poleJobs.length > 0 ? breakAfter : undefined, priority }
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} grows ${gr.role} by ${gr.units} units: ${plan.remove.length} entities to pick up, ${plan.add.length} to build, rerouted ${plan.rerouted.join(", ")}`)
  return true
}

/**
 * B101 (sweep 628fa29 seed 7718665): before placing `w.add`, trees and rocks in their way are cleared, once (a tree from
 * the next tile reached into a repair's belt tile and its ghost never revived). Returns whether it queued clear jobs.
 */
function clearObstacles(ctx: Ctx, w: { clearJobs: IDS.JobId[]; add: EntitySpec[]; obstacles?: boolean }): boolean {
  if (w.obstacles === true) return false
  w.obstacles = true
  let queued = false
  for (const o of obstaclesFor(ctx.surface, w.add)) {
    w.clearJobs.push((clearJobFor(ctx.faction, o) as IDS.JobId | undefined) ?? addClearJob(ctx.faction, o, ctx.config.factoryBuildPriority))
    queued = true
  }
  return queued
}

function updateGrowing(ctx: Ctx, g: FactoryGoal): void {
  const b = g.growBuild!
  const board = ctx.faction.board
  if (b.phase === "poles") {
    for (const id of b.poleJobs ?? []) {
      const j = getJob(board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    for (const e of b.breakAfter ?? []) if (e.valid && clearJobFor(ctx.faction, e) === undefined) b.clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
    b.breakAfter = undefined
    b.phase = "clear"
    return
  }
  if (b.phase === "clear") {
    for (const id of b.clearJobs) {
      const j = getJob(board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    if (b.retryAt !== undefined && ctx.tick < b.retryAt) return
    if (clearObstacles(ctx, b)) return
    const d = applyDiff(ctx.surface, ctx.faction, [], b.add, { fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority: b.priority ?? ctx.config.factoryBuildPriority }, ctx.f.layout)
    for (const gh of d.ghosts) b.ghosts.push(gh)
    for (const id of d.placeJobs) b.placeJobs.push(id)
    // B99: say so (a clear job that failed leaves its entity standing, and the goal ends with nothing placed).
    // B138 (random seed 1212121): two route belts could not be ghosted, but the growth still reported "grew" because
    // the failed specs were only logged. Retry them with backoff; after `build-stuck-rounds`, abandon the growth like a
    // stuck ghost instead of silently finishing with a hole.
    b.failed = d.failed
    b.failedSpecs = d.failedSpecs
    if (d.failed.length > 0) {
      // B144: a blocker a retry cannot clear rejects this growth at once (same cleanup as the stuck-round exit below).
      const hard = EX.hardGhostFailure(ctx.surface, ctx.faction, ctx.f.layout, d.failedSpecs ?? [])
      if (hard !== undefined) {
        EX.recordBadBuild(ctx.faction, g.nodes.map((n) => n.role), hard.tiles, ctx.tick, `grow: ${hard.reason}`)
        for (const gh of b.ghosts) if (gh.valid) destroyEntity(gh)
        b.phase = "done"
        transitionGoal(g, "failed")
        const node = ctx.f.graph.nodes[g.growth?.node ?? ""]
        if (node !== undefined) {
          node.lifecycle = "built"
          node.builtTick = ctx.tick
        }
        // A repair goal reuses `growBuild` without `growth` (rerouteInPlace): only a real growth has a node to cap.
        const gn = g.growth?.node
        if (gn !== undefined) CS.setValue((ctx.f.constraints ??= {}), "growFails", gn, ST.GROW_MAX_FAILS)
        log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} growth blocked: ${hard.reason}`)
        return
      }
      g.rounds++
      g.lastRound = ctx.tick
      g.reason = `${d.failed.length} ghosts could not be created (round ${g.rounds}): ${d.failed.slice(0, 4).join("; ")}`
      log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} cannot place ${d.failed.length}: ${d.failed.slice(0, 4).join("; ")}`)
      b.retryAt = ctx.tick + BUILD_ROUND_TICKS
      if (stuckRound(ctx, g, d.failed.length)) {
        for (const gh of b.ghosts) if (gh.valid) destroyEntity(gh)
        b.phase = "done"
        transitionGoal(g, "failed")
        const node = ctx.f.graph.nodes[g.growth?.node ?? ""]
        if (node !== undefined) {
          node.lifecycle = "built"
          node.builtTick = ctx.tick
          CS.setValue((ctx.f.constraints ??= {}), "growFails", node.role, ST.GROW_MAX_FAILS)
        }
      }
      return
    }
    b.retryAt = undefined
    b.failedSpecs = undefined
    b.phase = "place"
    return
  }
  let done = 0
  let open = false
  for (const id of b.placeJobs) {
    const j = getJob(board, id)
    if (j?.status === "done") done++
    else if (j !== undefined && j.status !== "failed") open = true
  }
  if (done > g.placed) {
    ctx.faction.brain!.steps += done - g.placed
    g.placed = done
    g.progressTick = ctx.tick
  }
  if (open) return
  if (LIFT.restoreLifted(g, ctx.faction, b.ghosts, () => RT.layoutEntityKeys(ctx.f.layout))) return
  const left = b.ghosts.filter((gh) => gh.valid)
  if (left.length > 0) {
    if (ctx.tick - (g.lastRound ?? 0) < BUILD_ROUND_TICKS) return
    g.lastRound = ctx.tick
    g.rounds++
    g.reason = `${left.length} ghosts left (round ${g.rounds}): ${failureReasons(ctx, b.placeJobs)}`
    if (stuckRound(ctx, g, left.length)) {
      // B20: a growth that keeps failing to place is abandoned: its leftover ghosts go, the module counts as built with
      // what stands, and it is not grown again this stage.
      for (const gh of left) if (gh.valid) destroyEntity(gh)
      b.phase = "done"
      transitionGoal(g, "failed")
      const node = ctx.f.graph.nodes[g.growth?.node ?? ""]
      if (node !== undefined) {
        node.lifecycle = "built"
        node.builtTick = ctx.tick
        CS.setValue((ctx.f.constraints ??= {}), "growFails", node.role, ST.GROW_MAX_FAILS)
      }
      return
    }
    const fake = { placeJobs: [] as IDS.JobId[], fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority: ctx.config.factoryBuildPriority, phase: "place" }
    replanGhosts(ctx, g, fake as never, left, ctx.f.layout)
    b.placeJobs = fake.placeJobs
    return
  }
  b.phase = "done"
  transitionGoal(g, "done")
  g.builtTick = ctx.tick
  if (g.growth === undefined) {
    // A reconciler repair: its pieces are back.
    mark(ctx.faction, `${g.kind}-built`)
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) done at tick ${ctx.tick} (${g.placed} placements)`)
    return
  }
  const node = ctx.f.graph.nodes[g.growth.node]
  if (node !== undefined) {
    node.lifecycle = "built"
    node.builtTick = ctx.tick
  }
  mark(ctx.faction, "grow-built")
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} grew ${node?.role ?? `${g.growth.node} (no longer in the graph)`} at tick ${ctx.tick}`)
}

function roleToId(f: FactoryState, g: FactoryGoal, role: string): IDS.ModuleId | undefined {
  for (const n of g.nodes) if (n.role === role) return n.id
  return LG.nodeByRole(f.graph, role)?.id
}

function nodeByRoleIn(f: FactoryState, role: string) {
  return LG.nodeByRole(f.graph, role)
}

function failedBefore(f: FactoryState, kind: GoalKind): number {
  let n = 0
  for (const g of f.goals) if (g.kind === kind && g.status === "failed" && !g.deferred) n++
  return n
}

function planGoal(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  g.attempts++
  const modules: ModuleRequest[] = []
  for (const n of g.nodes) modules.push({ id: n.id, def: makeModule(n.generator, n.params), newSite: n.newSite })
  const connections: ConnectionRequest[] = []
  // B78: a node folded into another module (a shared mine) connects through that module's ports. New nodes of this
  // goal are not in the layout yet: they keep their own ids.
  const inLayout = (id: string): boolean => LO.findModule(f.layout, id) !== undefined || g.nodes.some((n) => n.id === id)
  for (const e of g.edges) {
    const fromNode = roleToId(f, g, e.from)
    const toNode = roleToId(f, g, e.to)
    const from = fromNode !== undefined ? LG.connectModule(f.graph, fromNode, inLayout) ?? fromNode : undefined
    const to = toNode !== undefined ? LG.connectModule(f.graph, toNode, inLayout) ?? toNode : undefined
    if (from === undefined || to === undefined) continue
    connections.push({ id: IDS.connectionId(e.role), from: { module: from, port: e.fromPort }, to: { module: to, port: e.toPort }, rate: e.rate, belt: e.belt, merge: e.merge === true, fluid: OIL.fluidConnection(e.item, ctx.entities.pole ?? "small-electric-pole") })
  }
  // D62: plan regions stay in the home zone, plus the ground explored past it: an outpost's arm strip, or for a goal
  // with a mine every outpost's radar reach and strip.
  // A mine's candidate patches are cheap to enumerate (no placement scan), so a mine goal always searches all known
  // ground: the radius ladder only exists to bound the expensive scan, and spending attempts to widen it three times
  // before looking at a patch that was already known just costs plans (1376111: "1 of 1 patches tried", four times).
  const mine = modules.some((m) => m.def.site === "resource-patch" || m.def.generator === "pumpjack-field")
  const r = mine ? EX.homeRadius(ctx) : math.min(g.radius, EX.homeRadius(ctx))
  let region = EX.planRegion(ctx, g, r)
  // M7d.5: a roboport stays near its grid point, or the network's logistic areas stop touching.
  if (g.anchor !== undefined) region = { x: math.floor(g.anchor.x - g.anchor.window), y: math.floor(g.anchor.y - g.anchor.window), w: 2 * g.anchor.window, h: 2 * g.anchor.window }
  // B120: a blue-chain goal can connect to an oil field placed by an earlier goal far outside the home zone.
  // Scan the known ground between that source and the new consumers so its pipe route does not see UNKNOWN.
  for (const c of connections) {
    if (c.fluid === undefined || c.from === undefined) continue
    const source = LO.findModule(f.layout, c.from.module)
    if (source !== undefined) {
      region = Arms.rectUnion(region, source.rect)
      const port = LO.findPort(source, c.from.port)
      if (port !== undefined) {
        const outside = LO.portOutside(source, port)
        // A source built many goals ago may have a stale terrain chunk (a removed ghost is still OWN there).
        // Rescan its exit before routing from it; the live surface is authoritative for this tile.
        markDirty(ctx.surface.name, { x: outside.x - 1, y: outside.y - 1 }, { x: outside.x + 2, y: outside.y + 2 })
        const verifiedFree: Record<number, boolean> = {}
        for (let d = -1; d < 4; d++) {
          const x = outside.x + (d < 0 ? 0 : DX[d])
          const y = outside.y + (d < 0 ? 0 : DY[d])
          if (ctx.surface.can_place_entity({ name: c.fluid.pipe, position: { x: x + 0.5, y: y + 0.5 }, force: ctx.faction.force })) verifiedFree[tkey(x, y)] = true
        }
        c.fluid.verifiedFree = verifiedFree
      }
    }
  }
  // Every goal attempt (and a goal that failed before, retried as a new goal) starts the cluster somewhere else, so a
  // retry is not the same plan again: the hub, then 24 tiles off it in turn (deterministic).
  const tries = g.attempts - 1 + MAX_PLAN_ATTEMPTS * failedBefore(f, g.kind)
  const offsets = [[0, 0], [24, 0], [0, 24], [-24, 0], [0, -24], [24, 24], [-24, -24], [24, -24], [-24, 24]]
  const off = offsets[tries % offsets.length]
  // D62: an outpost's radar goes at its arm target, a little off it on a retry (a cliff or water there).
  const center = g.anchor !== undefined ? { x: g.anchor.x, y: g.anchor.y } : g.site !== undefined ? { x: g.site.x + off[0] / 2, y: g.site.y + off[1] / 2 } : { x: f.center.x + off[0], y: f.center.y + off[1] }
  // M7c: a pumpjack field is generated from a real field and placed on it; with none known, the goal explores for one.
  // M7c.8: wells of the layout's fields (planned too) and of this goal's earlier fields are taken.
  const takenWells = OIL.moduleWells(f.layout.modules.map((x) => x.canonical))
  const moduleRects = f.layout.modules.map((x) => x.rect)
  // B156: a fixed field box must not cover a tile the layout already claims. `layField` shrank only away from module
  // rects, so a field could still cover a port reservation, a route or another module's interaction tile, and
  // `placeFixed` then failed the whole plan at the first one ("occupied at x,y"). Match `placementClaimConflict`:
  // poles give way, every other claim is hard.
  function claimed(this: void, x: number, y: number): boolean {
    const k = tkey(x, y)
    const occ = f.layout.occ[k]
    if (occ !== undefined && !LO.isPoleTag(occ)) return true
    if (f.layout.reserved[k] !== undefined || f.layout.routeOcc[k] !== undefined) return true
    return f.layout.mine !== undefined && f.layout.mine[k] !== undefined
  }
  // A goal with two crude providers must not lay its second field over the first field's box: only the wells were
  // taken, so both boxes landed on the same patch and the second module failed at its fixed spot (B156).
  const fieldBoxes: Rect[] = []
  for (const m of modules) {
    if (m.def.generator !== "pumpjack-field") continue
    const n = g.nodes.find((x) => x.id === m.id)!
    const resource = (n.params.resource as string | undefined) ?? "crude-oil"
    const field = OIL.fieldModule(ctx.surface, region, EX.chunkKnownFor(ctx, g), center, resource, n.need, (n.params.pumpjack as string | undefined) ?? "pumpjack", (params) => makeModule("pumpjack-field", params), takenWells, [...moduleRects, ...fieldBoxes], claimed)
    if (field === undefined) {
      transitionGoal(g, "failed")
      g.deferred = true
      g.reason = `exploring for ${resource}: no ${resource} field within the plan region`
      EX.exploreFor(ctx, g, resource)
      return
    }
    m.def = field.def
    m.at = field.at
    OIL.moduleWells([field.def], takenWells)
    fieldBoxes.push({ x: field.at.x, y: field.at.y, w: field.def.footprint.w, h: field.def.footprint.h })
    EX.knowRect(f, { x: field.at.x, y: field.at.y, w: field.def.footprint.w, h: field.def.footprint.h })
  }
  const request: PlanRequest = { modules, connections, center, region, poles: ctx.entities.pole ?? "small-electric-pole" }
  // B63: a consumer whose input port boxed a plan in gets a wider window for this whole plan (see wideJoin).
  for (const e of g.edges) if (CS.has(f.constraints, "wideJoin", CS.portKey(e.to, e.toPort))) request.windowScale = 3
  // D57 (c): patches earlier plans' mines found no room on.
  if (f.deadPatches !== undefined) request.deadPatches = { ...f.deadPatches }
  // Tunnel crossings may not rebuild routes other goals are still building (their ghosts are out already): a plan's
  // build parts, and the routes a growth, reroute or repair rebuilds (its entities' owners). Inline: factory.lua is at
  // its main-chunk local limit.
  const busy: Record<string, boolean> = {}
  for (const o of f.goals) {
    if (o === g || o.status !== "building") continue
    const other = o.plan !== undefined ? RT.getPlannerEntry(o.plan) : undefined
    for (const rid of other?.build?.parts?.routes ?? []) busy[rid] = true
    for (const e of [...(o.growBuild?.add ?? []), ...(o.rework?.add ?? []), ...(other?.build?.extraAdd ?? [])]) {
      if (e.owner !== undefined && string.sub(e.owner, 1, 6) === "route:") busy[e.owner] = true
    }
  }
  request.busyRoutes = []
  for (const [id] of pairs(busy)) request.busyRoutes.push(id as string)
  request.busyRoutes.sort()
  // D38: temporary cells keep TEMP_CLEARANCE tiles off every existing module, so they never box in a port the real
  // factory still has to connect (seed 11: cells next to the labs' pack input made production unroutable).
  if (g.kind === "temp") request.avoid = f.layout.modules.map((m) => ({ x: m.rect.x - TEMP_CLEARANCE, y: m.rect.y - TEMP_CLEARANCE, w: m.rect.w + 2 * TEMP_CLEARANCE, h: m.rect.h + 2 * TEMP_CLEARANCE }))
  // B144: a role whose plan failed on a blocker a retry cannot clear starts its next attempt away from that tile.
  const bad = EX.badBuildRects(ctx.faction, g.nodes.map((n) => n.role), ctx.tick)
  if (bad.length > 0) request.avoid = [...(request.avoid ?? []), ...bad]
  const id = `${ctx.faction.name}:${g.id}:${g.attempts}`
  if (RT.getPlannerEntry(id) !== undefined) RT.removePlan(id)
  const maxUnderground = maxUndergroundNow(ctx)
  request.compare = compareOptions(ctx, g, maxUnderground)
  // P44 (b): whole-patch mines join several drill rows only with splitters.
  request.splitters = unresearchedTech(ctx, "splitter") === undefined
  // Splitter taps: recorded B2 taps, or a shared fuel producer (M6) feeding several consumers.
  let sharedProducer = false
  const fromCount: Record<string, number> = {}
  for (const e of g.edges) fromCount[e.from] = (fromCount[e.from] ?? 0) + 1
  for (const [, n] of pairs(fromCount)) if ((n as number) > 1) sharedProducer = true
  // B19: a new consumer of a built producer taps its route.
  for (const e of g.edges) {
    const p = LG.nodeByRole(f.graph, e.from)
    if (p === undefined) continue
    for (const id of f.graph.edgeOrder) if (f.graph.edges[id].kind === "belt" && f.graph.edges[id].from === p.id) sharedProducer = true
  }
  // B84: or a connection whose source port already starts a route in the layout, whatever node owns that route (a mine
  // another role was folded into, B78): point-to-point cannot start a second route there (vps-b77/eecca19 2229258:
  // 8 failures "port n6.out already feeds a route").
  if (!sharedProducer) for (const c of connections) if (c.from !== undefined && LO.portFeedsRoute(f.layout, c.from)) sharedProducer = true
  const topology = (f.taps !== undefined && next(f.taps)[0] !== undefined) || sharedProducer ? "splitter-tap" : undefined
  RT.startPlan({ id, surface: ctx.faction.surface, force: ctx.faction.force, faction: ctx.faction.name, request, terrain: f.terrain, baseFaction: ctx.faction.name, maxUnderground, topology, known: EX.knownGround(ctx, g) })
  g.plan = id
  transitionGoal(g, "planning")
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) attempt ${g.attempts}: ${g.nodes.length} modules, ${connections.length} connections, region radius ${r}`)
}

/** The technology that unlocks a belt tier's underground (`what` = "underground") or splitter, if not researched yet. */
function unresearchedTech(ctx: Ctx, what: "underground" | "splitter"): string | undefined {
  const entity = RT.tiers()[0]?.[what]
  if (entity === undefined) return undefined
  const tech = prototypeFacts.unlockedBy(prototypeFacts.recipeForItem(entity) ?? entity)
  return tech !== undefined && !ctx.force.technologies[tech]?.researched ? tech : undefined
}

/**
 * D36 / B2: what to compare a production or mall plan against while the technology that unlocks undergrounds
 * (splitters) is not researched and not already decided: the same placement routed with undergrounds; and, for items
 * this goal makes in several point-to-point producers (and no earlier goal makes, except the power node's fuel), one
 * producer feeding the others' consumers through splitter taps.
 */
function compareOptions(ctx: Ctx, g: FactoryGoal, maxUnderground: number | undefined): CompareOptions | undefined {
  const f = ctx.f
  const c = ctx.config
  if (g.kind !== "production" && g.kind !== "mall") return undefined
  const opts: CompareOptions = { workFactor: c.plannerCompareWorkFactor, minWork: c.plannerCompareMinWork }
  if (c.logisticsUndergroundMinSaving > 0 && maxUnderground !== undefined && f.needUndergrounds === undefined && unresearchedTech(ctx, "underground") !== undefined) {
    opts.undergrounds = { tiers: RT.tiers() }
  }
  if (c.logisticsSplitterCompare && c.logisticsSplitterMinSaving > 0 && f.needSplitters === undefined && policyFor(c).topology !== "splitter-tap" && unresearchedTech(ctx, "splitter") !== undefined) {
    const count: Record<string, number> = {}
    for (const n of g.nodes) count[n.item] = (count[n.item] ?? 0) + 1
    const items: string[] = []
    for (const n of g.nodes) {
      if (count[n.item] < 2 || items.indexOf(n.item) >= 0) continue
      let earlier = false
      for (const other of LG.nodesOf(f.graph)) if (other.item === n.item && NF.nodeServes(other) !== "power") earlier = true
      if (!earlier) items.push(n.item)
    }
    if (items.length > 0) opts.splitters = { items }
  }
  return opts.undergrounds !== undefined || opts.splitters !== undefined ? opts : undefined
}

/** Undergrounds only once they can be crafted (`logistics`): 1 (none) before. */
function maxUndergroundNow(ctx: Ctx): number | undefined {
  const ug = RT.tiers()[0]?.underground
  const ugRecipe = ug !== undefined ? (prototypeFacts.recipeForItem(ug) ?? ug) : undefined
  return ugRecipe !== undefined && ctx.force.recipes[ugRecipe]?.enabled ? undefined : 1
}

function updateGoals(ctx: Ctx): void {
  const f = ctx.f
  for (const g of f.goals) {
    if (g.status === "planning") updatePlanning(ctx, g)
    else if (g.status === "building" && g.growBuild !== undefined) updateGrowing(ctx, g)
    else if (g.status === "building") updateBuilding(ctx, g)
  }
}

function updatePlanning(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  const entry = g.plan !== undefined ? RT.getPlannerEntry(g.plan) : undefined
  if (entry === undefined) {
    transitionGoal(g, "failed")
    g.reason = "plan lost"
    return
  }
  if (entry.phase === "scan" || entry.phase === "plan") return
  for (const [k, v] of pairs(entry.job?.deadPatches ?? {})) {
    f.deadPatches ??= {}
    f.deadPatches[k as string] = v as string
  }
  // Planned against a terrain scan: another faction (or a player) may have claimed or built on its ground since.
  const contest = entry.phase === "done" ? contested(ctx, entry) : undefined
  // D36: a finished plan, or one that failed to route without undergrounds but routes with them (infinitely shorter).
  if ((entry.phase === "done" || entry.phase === "failed") && contest === undefined && deferForLogistics(ctx, g, entry)) return
  if (entry.phase === "failed" || contest !== undefined) {
    const why: string[] = []
    const roles: Record<string, string> = {}
    for (const n of g.nodes) roles[n.id] = n.role
    // D69: typed failures (old saved jobs carry text only: "other").
    const failures: { key: string; failure: PlanFailure }[] = []
    for (const [k, v] of pairs(entry.job?.failures ?? {})) {
      const m = string.match(k as string, "^module:(.*)$")[0]
      why.push(`${m !== undefined ? `module ${m} (${roles[m] ?? "?"})` : k}: ${v}`)
      failures.push({ key: k as string, failure: entry.job?.failed?.[k as string] ?? { kind: "other", reason: v as string } })
    }
    const learned = FR.learnFromFailure({
      failures,
      edges: g.edges.map((e) => ({ role: e.role, from: e.from, to: e.to, toPort: e.toPort })),
      nodes: g.nodes.map((n) => ({ id: n.id, role: n.role, item: n.item })),
      provider: (role) => {
        const n = nodeByRoleIn(f, role)
        return n === undefined ? undefined : n.lifecycle === "built" ? "built" : "planned"
      },
      portFed: (to, port, conn) => {
        const id = roleToId(f, g, to)
        return id !== undefined && portFedByOther(f.layout, { module: id, port }, conn)
      },
      aliasOf: (id) => entry.job?.alias[id],
      fallbackFor: (item) => ctx.config.factoryFuelFallback && (ST.fallbackProducers(f, [item])?.[item]?.length ?? 0) > 0,
    })
    const added: FR.Replan[] = []
    for (const l of learned) {
      if (!CS.add((f.constraints ??= {}), l.kind, l.key)) continue
      added.push(l.replan)
      if (l.say !== undefined) log(`[rival-engineers] faction ${ctx.faction.name}: ${l.say}`)
    }
    if (contest !== undefined) why.push(contest)
    g.reason = why.join("; ")
    const replan = FR.strongestReplan(added)
    if (replan !== undefined) {
      // Planned again at once without that tap / with one provider per consumer / without that merge.
      RT.removePlan(entry.id)
      transitionGoal(g, "failed")
      g.deferred = true
      g.reason = `replan ${replan === "a mine of its own" ? "with a mine of its own" : replan === "parallel providers" ? "with parallel providers" : replan} for ${g.reason}`
      return
    }
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} plan failed (attempt ${g.attempts}): ${g.reason}`)
    // With frame dumps on (soaks), keep the failed layout for tools/render (--graph over the nearest frame).
    // The plan's input too (for a T1 replay: mod/unit/fixtures).
    if (ctx.config.frameDumpIntervalTicks > 0) {
      const name = `rival-engineers/failed-plans/${ctx.faction.name}/${g.id}-a${g.attempts}-t${ctx.tick}`
      RT.exportGraph(entry, `${name}.graph.json`)
      // Region radius 384 plans (a far mine or a late cluster) are 768 tiles across: export those up to 800 tiles a side
      // too, or a failure there leaves nothing to replay (B85 and 1376111 needed capture runs). M7c: 3,000, so a plan
      // reaching a remote oil field (~900 tiles from the hub on seed 11) is captured with the base.
      RT.exportPlanInput(entry, `${name}.input.lua`, 3000)
    }
    RT.removePlan(entry.id)
    // B57/B61: a sealed consumer port is authoritative even while relocation waits. Mark it now, so the next design
    // plans no provider for a port that cannot receive one.
    for (const { port, subject } of LO.sealedGoalPorts(f.layout, entry.job?.evidence ?? [])) {
      const n = f.graph.nodes[port.module]
      if (n === undefined) continue
      if (CS.add((f.constraints ??= {}), "noFeed", CS.portKey(n.role, port.port))) log(`[rival-engineers] faction ${ctx.faction.name}: ${n.role} has its ${port.port} port sealed (goal ${g.id}: ${subject}); its input stays unplanned until the module moves`)
    }
    // B63: a consumer's own input port was proved boxed in (or the window cut it). Re-plan this goal with a wider route
    // window first: the blockage was built by the plan's other routes under the narrow window, so widening a single
    // connection rescues nothing while the wider plan routes (seed 1376111: 265k work, vs 50k spent failing).
    if (contest === undefined) {
      let widened = false
      for (const ev of entry.job?.evidence ?? []) {
        // B157: a pipe failure carries the same evidence shape, but `wideJoin` only widens a belt window; the pipe
        // retry works inside its own plan, so do not queue a no-op constraint (and a misleading log).
        if (ev.kind !== "route" || ev.mode === "pipe" || ev.sealed === undefined || ev.sealed.side !== "goal") continue
        const n = f.graph.nodes[ev.sealed.port.module]
        if (n === undefined) continue
        if (!CS.add((f.constraints ??= {}), "wideJoin", CS.portKey(n.role, ev.sealed.port.port))) continue
        widened = true
        log(`[rival-engineers] faction ${ctx.faction.name}: ${n.role} has its ${ev.sealed.port.port} port boxed in (goal ${g.id}); its plans will use a wider route window`)
      }
      if (widened) {
        transitionGoal(g, "failed")
        g.deferred = true
        g.reason = `replan with a wider route window: ${g.reason}`
        return
      }
    }
    // B57: a built module's open input proved walled in: no plan can feed it, so it moves and the goal plans again.
    const moved = contest === undefined ? relocateSealed(ctx, g, entry.job?.evidence ?? []) : undefined
    if (moved !== undefined) {
      transitionGoal(g, "failed")
      g.deferred = true
      g.reason = `replan after relocating ${moved}: ${g.reason}`
      return
    }
    // A plan can prove that the faction's *known* ground is exhausted (no free ore patch in the region, every known
    // patch full, no site for this kind). Retrying cannot help; only more world or a different place can. That is a
    // knowledge failure, not a design failure, so it acts on the FIRST attempt rather than burning MAX_PLAN_ATTEMPTS
    // plans on the search-radius ladder (seed 1376111 died one attempt short of its first exploration), it keeps the
    // goal (`deferred`, attempts intact) instead of replacing it with a freshly minted id, and it pauses its kind (or
    // the ore search) so one exhausted site cannot become a run of failures on new goals.
    const gone = contest === undefined && g.site === undefined ? EX.exhausted(failures.map((x) => x.failure)) : undefined
    if (gone !== undefined) {
      transitionGoal(g, "failed")
      g.deferred = true
      if (gone.kind === "site") {
        // B53 (user, 2026-10-20): no site in the region (e.g. no shore for a steam block) stays true for a while.
        if (ctx.config.factorySiteRetryMinutes > 0) {
          f.siteRetry ??= {}
          f.siteRetry[g.kind] = ctx.tick + ctx.config.factorySiteRetryMinutes * 3600
          log(`[rival-engineers] faction ${ctx.faction.name}: SITE RETRY PAUSE (B53): ${g.kind} goal ${g.id} found no ${gone.what} site (${g.reason}); no ${g.kind} goal plans for ${ctx.config.factorySiteRetryMinutes} game-min, until tick ${f.siteRetry[g.kind]} (setting factory-site-retry-minutes)`)
        }
        g.reason = `paused: ${g.reason}`
        return
      }
      g.reason = `exploring for ${gone.what}: ${g.reason}`
      EX.exploreFor(ctx, g, gone.what)
      return
    }
    // M7c.8: a radar outpost whose pole line can't reach the base (seed 11: lakes 90-300 tiles wide across the E and S
    // arms) fails the same way on every attempt: the region radius doesn't bound the pole search. It fails at once, so
    // the exploration tries the next arm instead of spending 4 plans per arm (8 failed plans in a row stopped the soak).
    if (g.attempts >= MAX_PLAN_ATTEMPTS || FR.retryCannotHelp(g.site !== undefined || g.kind === "power", failures)) {
      transitionGoal(g, "failed")
      // B53 (user, 2026-10-20): no site in the region (e.g. no shore for a steam block) stays true for a while: goals of
      // this kind wait `factory-site-retry-minutes` instead of planning again at once, forever.
      if (failures.some((x) => x.failure.kind === "no-site") && ctx.config.factorySiteRetryMinutes > 0) {
        f.siteRetry ??= {}
        f.siteRetry[g.kind] = ctx.tick + ctx.config.factorySiteRetryMinutes * 3600
        log(`[rival-engineers] faction ${ctx.faction.name}: SITE RETRY PAUSE (B53): ${g.kind} goal ${g.id} failed all ${g.attempts} plans (${g.reason}; region radius up to ${g.radius}); no ${g.kind} goal plans for ${ctx.config.factorySiteRetryMinutes} game-min, until tick ${f.siteRetry[g.kind]} (setting factory-site-retry-minutes)`)
      }
      // Planned without undergrounds and boxed in: research them before the next try (see needUndergrounds).
      const ug = RT.tiers()[0]?.underground
      const tech = ug !== undefined ? prototypeFacts.unlockedBy(prototypeFacts.recipeForItem(ug) ?? ug) : undefined
      if ((g.kind === "production" || g.kind === "mall") && f.needUndergrounds === undefined && tech !== undefined && !ctx.force.technologies[tech]?.researched && entry.maxUnderground !== undefined) {
        f.needUndergrounds = tech
        log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} failed ${g.attempts} plans without undergrounds: ${tech} is now a prerequisite of production`)
      }
      return
    }
    // A contested plan retries in the same region: the terrain now shows the claim.
    if (contest === undefined) g.radius = math.floor(g.radius * 1.5)
    planGoal(ctx, g)
    return
  }
  const prepared = preparePlanDelta({
    sourceRevision: entry.job!.sourceRevision,
    layout: entry.job!.layout,
    baseModules: entry.job!.baseModules,
    baseRoutes: entry.job!.baseRoutes,
    addedPoles: entry.job!.poleJob?.added,
    expanded: entry.job!.expanded,
    covered: entry.job!.covered,
  }, f.layout)
  if (prepared.status === "rejected") {
    const decision = prepared.code === "stale-base-revision" ? "stale-plan-rejected" : "invalid-plan-delta"
    recordDiagnostic(ctx.faction, { tick: ctx.tick, kind: "planner", goal: g.id, plan: entry.id, decision, reason: prepared.detail })
    if (prepared.code === "invalid-layout-claims") reportOrphanClaims(ctx, g, prepared.problems)
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} discards plan ${entry.id} (${prepared.code}): ${prepared.detail}`)
    RT.removePlan(entry.id)
    g.plan = undefined
    g.reason = `${prepared.code}: ${prepared.detail}`
    if (prepared.code === "stale-base-revision") g.attempts-- // A concurrent logical change is not a failed planning attempt.
    else if (g.attempts >= MAX_PLAN_ATTEMPTS) {
      transitionGoal(g, "failed")
      return
    }
    planGoal(ctx, g)
    return
  }
  adoptPlan(ctx, g, prepared.delta)
}

/**
 * D36 / B2: a finished plan that compared itself with undergrounds / splitter taps. When an alternative is shorter by
 * at least the setting, the goal is given up (deferred, not a failure) and the technology becomes a prerequisite of
 * production and mall goals; the next design plans the same goal again once it is researched (with splitter taps for
 * the recorded consumers). Returns true when deferred.
 */
function deferForLogistics(ctx: Ctx, g: FactoryGoal, entry: NonNullable<ReturnType<typeof RT.getPlannerEntry>>): boolean {
  const results: CompareResult[] = entry.job?.compare?.results ?? []
  if (results.length === 0) return false
  const f = ctx.f
  const d = logisticsFirst(results, ctx.config.logisticsUndergroundMinSaving, ctx.config.logisticsSplitterMinSaving)
  const research = d.undergrounds || d.splitters
  f.compares ??= []
  f.compares.push({ goal: `${g.id}-a${g.attempts}`, tick: ctx.tick, research, why: d.why })
  if (f.compares.length > 20) f.compares.shift()
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} logistics comparison: ${d.why.join("; ")}${research ? "" : ": build the plan as it is"}`)
  if (!research) return false
  const ugTech = d.undergrounds ? unresearchedTech(ctx, "underground") : undefined
  const spTech = d.splitters ? unresearchedTech(ctx, "splitter") : undefined
  if (ugTech !== undefined) f.needUndergrounds = ugTech
  if (spTech !== undefined) {
    f.needSplitters = spTech
    const roles: Record<string, string> = {}
    for (const n of g.nodes) roles[n.id] = n.role
    f.taps ??= {}
    for (const [item, consumers] of pairs(d.taps)) {
      const list = f.taps[item as string] ?? []
      for (const id of consumers as string[]) {
        const role = roles[id]
        if (role !== undefined && list.indexOf(role) < 0) list.push(role)
      }
      f.taps[item as string] = list
    }
  }
  if (ctx.config.frameDumpIntervalTicks > 0) RT.exportPlanInput(entry, `rival-engineers/plans/${ctx.faction.name}/${g.id}-a${g.attempts}-t${ctx.tick}-deferred.input.lua`)
  RT.removePlan(entry.id)
  transitionGoal(g, "failed")
  g.deferred = true
  g.reason = `research first: ${[ugTech, spTech].filter((t) => t !== undefined).join(", ")} (${d.why.join("; ")})`
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} deferred: ${g.reason}`)
  return true
}

/** The new parts of a finished plan on ground another faction claimed or something foreign stands on, if any. */
function contested(ctx: Ctx, entry: NonNullable<ReturnType<typeof RT.getPlannerEntry>>): string | undefined {
  const job = entry.job!
  const parts: BuildParts = { modules: [], routes: [], poles: [] }
  for (const m of job.layout.modules) if (!job.baseModules[m.id]) parts.modules.push(m.id)
  for (const id of job.layout.routeOrder) if (!job.baseRoutes[id]) parts.routes.push(id)
  for (const id of job.poleJob?.added ?? []) parts.poles.push(id)
  const keys = partTiles(job.layout, parts)
  const claims: Record<string, number> = {}
  let n = 0
  for (const k of keys) {
    const owner = claimOwner(ctx.faction.name, ctx.faction.surface, k)
    if (owner === undefined) continue
    claims[owner] = (claims[owner] ?? 0) + 1
    n++
  }
  const foreign = foreignEntitiesOn(ctx.surface, ctx.faction.force, keys)
  if (n === 0 && foreign.length === 0) return undefined
  const who: string[] = []
  for (const name of storage.factionOrder) if (claims[name] !== undefined) who.push(`${claims[name]} tiles claimed by faction ${name}`)
  if (foreign.length > 0) who.push(`${foreign.length} foreign entities (${foreign[0].name} of ${foreign[0].force.name} at ${foreign[0].position.x},${foreign[0].position.y})`)
  return `contested: ${who.join(", ")}`
}

/** B46: removes the poles at `gone` (`name@x,y`) from a building goal's own layout and parts; returns how many. */
export function dropPlannedPoles(layout: LayoutState, parts: BuildParts | undefined, gone: Record<string, boolean>): PlannedPole[] {
  const drop: Record<string, boolean> = {}
  const kept: PlannedPole[] = []
  const dropped: PlannedPole[] = []
  for (const p of layout.poles ?? []) {
    if (!gone[`${p.name}@${p.x},${p.y}`]) {
      kept.push(p)
      continue
    }
    drop[p.id] = true
    dropped.push(p)
    LO.releasePoleTile(layout, tkey(p.x, p.y), p.line)
  }
  if (dropped.length === 0) return dropped
  layout.poles = kept
  if (parts !== undefined) parts.poles = parts.poles.filter((id) => !drop[id])
  // B158: a line must not keep the id of a pole that no longer exists (`checkLayoutIndexes`: "names missing pole").
  if (layout.poleLines !== undefined) {
    const lines: typeof layout.poleLines = []
    for (const line of layout.poleLines) {
      const poles = line.poles.filter((id) => drop[id] !== true)
      if (poles.length > 0) lines.push({ ...line, poles })
    }
    layout.poleLines = lines
  }
  LO.bumpLayout(layout)
  return dropped
}

/**
 * A validated plan delta becomes the faction's layout; its new parts become graph nodes and edges and are built.
 *
 * The phases run in this fixed order. Everything before `f.layout = layout` is pure or diagnostic; after that the
 * function creates Factorio entities and jobs, which cannot be rolled back. The delta is already prepared and
 * validated (revision, indexes, claim owners, logical and claim evidence) by `updatePlanning`, so no decision is made
 * here that the prepared evidence does not already carry:
 *   1. explore bookkeeping and the plan-input frame dump (reads only);
 *   2. swap the persistent layout and add the logical nodes, belt edges and power edges from the delta;
 *   3. pick up bootstrap sites and pole lines the plan's ground evicts (world effects);
 *   4. reserve the taken ground for the bootstrap and claim the new mines' ore fields;
 *   5. start the build job from the delta's physical parts, then add the completed mines' entities.
 * The record in `f.adoption` (adoption-intent.ts) marks the phases. A Lua error part-way leaves it persisted; the next
 * tick sees the goal still planning and re-runs adoption, whose phases are made safe to repeat (idempotent graph adds,
 * evictions and reservations; `entry.build` is reused; completed-mine entities are deduped). The record is cleared at
 * the commit point (the goal becoming `building`).
 */
function adoptPlan(ctx: Ctx, g: FactoryGoal, delta: PlanDelta): void {
  const f = ctx.f
  const entry = RT.getPlannerEntry(g.plan!)!
  const job = entry.job!
  const layout = delta.layout
  const intent = AR.begin(ctx.faction, f, g, entry.id, ctx.tick)
  EX.exploreDone(ctx, g)
  // With frame dumps on (soaks), every adopted plan's input too (before its layout becomes the base): plan-replay
  // fixtures for planner changes (D36 / B2).
  if (ctx.config.frameDumpIntervalTicks > 0) RT.exportPlanInput(entry, `rival-engineers/plans/${ctx.faction.name}/${g.id}-a${g.attempts}-t${ctx.tick}.input.lua`, 3000)
  f.layout = layout
  const parts = delta.add
  for (const n of g.nodes) {
    const m = LO.findModule(layout, n.id)
    const def = m?.canonical ?? makeModule(n.generator, n.params)
    const util = n.capacity > 0 ? math.min(1, n.need / n.capacity) : 1
    const node: LogicalNode = {
      id: n.id,
      role: n.role,
      kind: n.kind,
      module: def.id,
      alias: m === undefined && job.alias[n.id] !== undefined ? IDS.moduleId(job.alias[n.id]) : undefined,
      generator: n.generator,
      recipe: def.recipe,
      item: n.item,
      capacity: { inputs: def.rates.inputs, outputs: def.rates.outputs },
      planned: {
        inputs: n.inputs.map((p) => ({ item: p.item, perSecond: p.rate })),
        outputs: [{ item: n.item, perSecond: n.kind === "labs" ? n.need : math.min(n.need, n.capacity) }],
      },
      powerW: n.kind === "power" ? n.capacity : n.powerW * util,
      lifecycle: "building",
      status: "unknown",
      goal: g.id,
      createdTick: ctx.tick,
      homeCluster: n.homeCluster,
      family: n.family,
      serves: n.serves,
    }
    LG.addNode(f.graph, node)
  }
  for (const e of g.edges) {
    const from = roleToId(f, g, e.from)
    const to = roleToId(f, g, e.to)
    if (from === undefined || to === undefined) continue
    const physical = [...(delta.logical.routesByConn[e.role] ?? [])]
    LG.addEdge(f.graph, { id: `e:${e.role}`, role: e.role, kind: "belt", item: e.item, from, fromPort: e.fromPort, to, toPort: e.toPort, plannedRate: e.rate, headroomRate: e.headroomRate, physical, belt: e.belt, overflow: e.decision.action !== "none" ? e.decision.action : undefined })
  }
  powerEdges(f, delta.logical.poleLines)
  AR.advance(intent, "state")
  // B15 / D51: bootstrap mining sites on the plan's ground make way (picked up first, rebuilt elsewhere).
  // B23 / D52: a whole-patch mine's claim covers its unbuilt footprint too; a site standing on it would block the
  // mine's completion (m6a2-b21l, seed 222: the mall's iron line found the patch full of retired sites). The delta
  // prepared the new parts' tiles and those claims together.
  const taken: Record<number, boolean> = {}
  for (const k of delta.claims.takenTiles) taken[k] = true
  const evicted = evictSites(ctx.faction, ctx.surface, taken, `goal ${g.id} (${g.kind})`)
  // B37: pole lines the plan's modules and routes took are picked up (ghosts cancelled at once); the plan's pole step
  // joined what they powered again. A pole the new lines place at the same spot stays.
  const relaid: Record<string, boolean> = {}
  for (const p of layout.poles ?? []) relaid[`${p.name}@${p.x},${p.y}`] = true
  const queued: Record<number, boolean> = {}
  for (const e of evicted) if (e.valid && e.unit_number !== undefined) queued[e.unit_number] = true
  // D71 (b): built evicted poles are picked up once the plan's new poles stand (make before break, `RT.startBuild`).
  const breakAfter: LuaEntity[] = []
  for (const p of layout.evictedPoles ?? []) {
    if (relaid[`${p.name}@${p.x},${p.y}`]) continue
    const at = { x: p.x + 0.5, y: p.y + 0.5 }
    const built = findEntities(ctx.surface, { name: p.name, position: at, force: ctx.faction.force, limit: 1 })[0]
    if (built !== undefined && !queued[built.unit_number!]) {
      queued[built.unit_number!] = true
      breakAfter.push(built)
    }
    for (const gh of findEntities(ctx.surface, { ghost_name: p.name, position: at, force: ctx.faction.force, limit: 1 })) destroyEntity(gh)
  }
  // B46: a goal still building may have planned some of these poles. Its own copy of its plan drops them, so it neither
  // ghosts them once its clearing is done nor re-places them in a leftover round (seed 11: g10's route evicted the
  // mall's pole line while the mall was still clearing; the mall then ghosted a pole onto g10's built belt).
  const gone: Record<string, boolean> = {}
  for (const p of layout.evictedPoles ?? []) if (!relaid[`${p.name}@${p.x},${p.y}`]) gone[`${p.name}@${p.x},${p.y}`] = true
  for (const other of f.goals) {
    if (other === g || other.status !== "building" || other.plan === undefined) continue
    const oe = RT.getPlannerEntry(other.plan)
    if (oe?.job === undefined) continue
    const dropped = dropPlannedPoles(oe.job.layout, oe.build?.parts, gone)
    if (dropped.length > 0) {
      const ghosts = EX.dropEvictedPoleGhosts(ctx.surface, ctx.faction, dropped, oe.build?.placeJobs)
      log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} evicts ${dropped.length} poles goal ${other.id} has not built yet (B46)${ghosts > 0 ? ` (removes ${ghosts} ghost(s))` : ""}`)
    }
  }
  if ((layout.evictedPoles?.length ?? 0) > 0) log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} evicts ${layout.evictedPoles!.length} poles (B37)`)
  f.layout.evictedPoles = undefined
  AR.advance(intent, "world")
  // The bootstrap keeps its sites and hand-mining off the planned tiles.
  const reserved = ctx.faction.brain!.reserved
  for (const k of partTiles(layout, parts)) reserved[k] = true
  for (const id of parts.modules) {
    const m = LO.findModule(layout, id)!
    for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) reserved[tkey(x, y)] = true
    claimModuleFields(ctx, m)
  }
  resyncReserved(ctx.faction, layout)
  AR.advance(intent, "build")
  const fuel = ctx.faction.brain!.catalog.fuel
  // A resumed adoption reuses the build job this plan already started instead of duplicating its clear targets.
  const b = entry.build ?? RT.startBuild(entry, { fuel: { item: fuel, count: 5 }, priority: g.kind === "power" ? POWER_JOB_PRIORITY : ctx.config.factoryBuildPriority, parts, clear: evicted, breakAfter })
  // B23: a request that completed a built whole-patch mine (wholePatchCandidate): the mine is a base module, so its
  // new entities are not in `parts`. Build them the growth way: evict and clear what stands on the new ground, then
  // ghost and place (`stepBuild` stamps `extraAdd` once the clear is done). The out port of a completed mine is the
  // partial mine's, so no routes move. A resumed adoption skips entities it already queued in `extraAdd`.
  const alreadyAdded: Record<string, boolean> = {}
  for (const s of b.extraAdd ?? []) alreadyAdded[`${s.name}@${s.x},${s.y}`] = true
  for (const completion of delta.mineCompletions) {
    const add: EntitySpec[] = []
    for (const s of completion.entities) {
      if (alreadyAdded[`${s.name}@${s.x},${s.y}`]) continue
      const found = findEntities(ctx.surface, { name: s.name, position: { x: s.x, y: s.y }, force: ctx.faction.force, limit: 1 })
      if (found.length > 0) continue
      add.push(s)
    }
    if (add.length === 0) continue
    const mineTaken: Record<number, boolean> = {}
    for (const s of add) mineTaken[tkey(math.floor(s.x), math.floor(s.y))] = true
    for (const e of evictSites(ctx.faction, ctx.surface, mineTaken, `goal ${g.id} (${g.kind}) mine completion`)) AR.queueClear(ctx.faction, b, e, ctx.config.factoryBuildPriority)
    for (const e of RT.obstaclesUnder(ctx.surface, layout, { modules: [completion.module], routes: [], poles: [] })) AR.queueClear(ctx.faction, b, e, ctx.config.factoryBuildPriority)
    // B25: the completion's new entities replace the faction's own earlier structures on their tiles (pole lines
    // and routes placed before the mine's claim): pick them up first, then ghost. The reconcile layer turns the
    // broken edge into a repair goal.
    // B66 (5387208): the entity's whole footprint, not its centre tile: a completed drill's outer rows kept a later
    // route's belts and its ghost could never be placed.
    for (const s of add) {
      const p = prototypes.entity[s.name]
      const side = s.dir === defines.direction.east || s.dir === defines.direction.west
      const w = p !== undefined ? (side ? p.tile_height : p.tile_width) : 1
      const h = p !== undefined ? (side ? p.tile_width : p.tile_height) : 1
      const r = { x: math.floor(s.x - w / 2 + 0.01), y: math.floor(s.y - h / 2 + 0.01), w, h }
      for (const e of findEntities(ctx.surface, { type: ["electric-pole", "transport-belt", "underground-belt"], force: ctx.faction.force, area: { left_top: { x: r.x + 0.05, y: r.y + 0.05 }, right_bottom: { x: r.x + r.w - 0.05, y: r.y + r.h - 0.05 } } })) {
        // B37: an evicted pole is already queued.
        if (e.unit_number !== undefined && queued[e.unit_number]) continue
        if (e.unit_number !== undefined) queued[e.unit_number] = true
        AR.queueClear(ctx.faction, b, e, ctx.config.factoryBuildPriority)
      }
    }
    // B47: one plan can complete several shared mines; each one's entities join the list (seed 3333: g14 completed n6
    // and n18, n18's list replaced n6's, and n6's poles, the only link to two new modules, were never built).
    b.extraAdd = [...(b.extraAdd ?? []), ...add]
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} completes the shared mine ${completion.module}: ${add.length} entities to build`)
  }
  // Tunnel crossings (`planner/tunnel.ts`): a built route this plan's belts cross is rebuilt on those tiles the
  // mine-completion way. Its old belts there are picked up first (the clear phase), then its underground ends are
  // ghosted with the plan's own parts (`extraAdd`), so the crossing belt and the pair go up together.
  for (const rw of delta.reworked) {
    let cleared = 0
    for (const s of rw.remove) {
      for (const e of findEntities(ctx.surface, { name: s.name, position: { x: s.x, y: s.y }, force: ctx.faction.force, limit: 1 })) {
        if (e.unit_number !== undefined && queued[e.unit_number]) continue
        if (e.unit_number !== undefined) queued[e.unit_number] = true
        AR.queueClear(ctx.faction, b, e, ctx.config.factoryBuildPriority)
        cleared++
      }
    }
    const add = rw.add.filter((s) => !alreadyAdded[`${s.name}@${s.x},${s.y}`])
    for (const s of add) alreadyAdded[`${s.name}@${s.x},${s.y}`] = true
    b.extraAdd = [...(b.extraAdd ?? []), ...add]
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} tunnels under ${rw.route}: ${cleared} belts to pick up, ${add.length} underground ends to build`)
  }
  transitionGoal(g, "building")
  if (f.adoption === intent) f.adoption = undefined
  g.plannedTick = ctx.tick
  g.progressTick = ctx.tick
  const s = job.stats
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) planned in ${entry.scanTicks + entry.planTicks} ticks (work ${s.work}, ${s.searches} searches, ${s.ripups} rip-ups): ${parts.modules.length} modules, ${parts.routes.length} routes, ${parts.poles.length} poles`)
  ctx.faction.brain!.steps++
  mark(ctx.faction, `${g.kind}-planned`)
}

/** Power edges: the power node to every consumer node, physical = the pole lines that joined it. */
/** D46: a mining module's ore fields (under its drills' mining areas) become the faction's. */
function claimModuleFields(ctx: Ctx, m: PlacedModule): void {
  const resource = m.def.anchor?.resource
  const areas = m.def.anchor?.miningAreas
  if (resource === undefined || areas === undefined) return
  const brain = ctx.faction.brain!
  brain.oreFields ??= {}
  for (const a of areas) {
    const area = { left_top: { x: m.origin.x + a.x, y: m.origin.y + a.y }, right_bottom: { x: m.origin.x + a.x + a.w, y: m.origin.y + a.y + a.h } }
    for (const e of findEntities(ctx.surface, { name: resource, area })) {
      claimOreField(ctx.surface, brain.oreFields, resource, math.floor(e.position.x), math.floor(e.position.y))
    }
  }
}

function powerEdges(f: FactoryState, poleLines?: { id: string; to: string; from: string }[]): void {
  const power = LG.nodesOf(f.graph, "power")[0]
  if (power === undefined) return
  const roles = PW.powerRoles(f.layout, prototypeFacts)
  for (const id of roles.consumers) {
    const n = f.graph.nodes[id]
    if (n === undefined) continue
    const role = `power=>${n.role}`
    const lines: string[] = []
    for (const l of poleLines ?? f.layout.poleLines ?? []) if (l.to === id) lines.push(l.id)
    // B37: evicted lines are gone from the layout and new lines may have joined the consumer: keep `physical` current.
    const existing = LG.edgeByRole(f.graph, role)
    if (existing !== undefined) {
      existing.physical = lines
      continue
    }
    LG.addEdge(f.graph, { id: `e:${role}`, role, kind: "power", item: "electricity", from: power.id, to: id, plannedRate: n.powerW, physical: lines })
  }
}

function updateBuilding(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  const entry = g.plan !== undefined ? RT.getPlannerEntry(g.plan) : undefined
  const b = entry?.build
  if (entry === undefined || b === undefined) {
    transitionGoal(g, "failed")
    g.reason = "build lost"
    return
  }
  // B144: a ghost blocked by terrain, a foreign entity, a module or an overlap in the plan's own add list cannot be
  // stamped by retrying. Record where and give up the location at once, before any place job exists, instead of
  // building most of the plan and then relocating it.
  if (b.hard !== undefined) {
    EX.recordBadBuild(ctx.faction, g.nodes.map((n) => n.role), b.badTiles ?? [], ctx.tick, b.hard)
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} build blocked: ${b.hard}`)
    relocateGoal(ctx, g, entry, `build blocked: ${b.hard}`)
    return
  }
  // Progress: place jobs done since the last look.
  let done = 0
  for (const id of b.placeJobs) if (getJob(ctx.faction.board, id)?.status === "done") done++
  if (done > g.placed) {
    ctx.faction.brain!.steps += done - g.placed
    g.placed = done
    g.progressTick = ctx.tick
  }
  // B135 (seed 11, minute 330): a plan's modules become built only when the whole plan finishes. The blue line's steel
  // smelter stood and ran, but the pumpjack in the same plan waited for steel from it: a circular wait. Mark a module
  // built as soon as all its own entities stand, on every think; the reconciler can then feed it and its output is a
  // supply point (B134). Only in the place phase: before it the plan's ghosts are not stamped yet (`b.ghosts` unset), and
  // "no ghost left" would mark every module of a plan still clearing (or retrying a failed stamp, B138) as built.
  if (b.phase === "place" && b.ghosts !== undefined) {
    const layout = entry.job?.layout
    if (layout !== undefined) {
      for (const gn of g.nodes) {
        const node = f.graph.nodes[gn.id]
        if (node === undefined || node.lifecycle === "built") continue
        const m = LO.findModule(layout, gn.id)
        if (m === undefined) continue
        const own: { x: number; y: number }[] = []
        for (const e of m.def.entities) own.push({ x: m.origin.x + e.x, y: m.origin.y + e.y })
        if (!GLC.modulePlaced(own, b.ghosts)) continue
        node.lifecycle = "built"
        node.builtTick = ctx.tick
      }
    }
  }
  if (g.rework !== undefined && !rework(ctx, g, b)) return
  // B138: the plan is still in its clear phase because a ghost could not be created. Count the retry rounds and give up
  // the location after `build-stuck-rounds` instead of leaving the goal building forever.
  if (b.phase === "clear" && (b.failed?.length ?? 0) > 0) {
    // B142: when every failed ghost is a route piece, reroute those routes around the failing tiles (B123) instead of
    // abandoning the whole plan. Seed 1212121 g111 had 281 blocked route pieces and was relocated twice for them.
    const specs = b.failedSpecs ?? []
    if (specs.length > 0) {
      const layout = entry.job?.layout
      let onlyRoutes = layout !== undefined
      const routes: IDS.RouteId[] = []
      const tiles: Record<number, boolean> = {}
      for (const s of specs) {
        if (layout === undefined || layout.routes[s.owner] === undefined) {
          onlyRoutes = false
          break
        }
        const rid = IDS.routeId(s.owner)
        if (routes.indexOf(rid) < 0) routes.push(rid)
        tiles[tkey(math.floor(s.x), math.floor(s.y))] = true
      }
      if (onlyRoutes && routes.length > 0 && reroute(ctx, g, entry, routes, tiles)) {
        g.stuck = 0
        b.failed.length = 0
        b.failedSpecs = undefined
        b.retryAt = undefined
        return
      }
    }
    if (ctx.tick - (g.lastRound ?? 0) < BUILD_ROUND_TICKS) return
    g.lastRound = ctx.tick
    g.rounds++
    g.reason = `${b.failed.length} ghosts could not be created (round ${g.rounds}): ${b.failed.slice(0, 4).join("; ")}`
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} ${g.reason}`)
    if (stuckRound(ctx, g, b.failed.length)) relocateGoal(ctx, g, entry, `build stuck: ${g.reason}`)
    return
  }
  if (b.phase !== "done") return
  // Every job finished: ghosts left over (failed jobs, a replan dropping jobs) get new place jobs.
  if (LIFT.restoreLifted(g, ctx.faction, (b.ghosts ??= []), () => RT.layoutEntityKeys(entry.job?.layout ?? ctx.f.layout))) return
  const left: LuaEntity[] = []
  for (const gh of b.ghosts) if (gh.valid) left.push(gh)
  if (left.length > 0 && ctx.tick - (g.lastRound ?? 0) < BUILD_ROUND_TICKS) return
  // Before a retry round and before calling the build done: is any part blocked by something the faction doesn't own?
  if (resolveConflicts(ctx, g, entry)) {
    g.lastRound = ctx.tick
    return
  }
  if (left.length > 0) {
    // Retry the leftovers every BUILD_ROUND_TICKS, saying why. B20: after `build-stuck-rounds` rounds in a row that
    // placed nothing, the goal gives up its location (as a conflict repair would) so the design plans it elsewhere.
    g.lastRound = ctx.tick
    g.rounds++
    g.reason = `${left.length} ghosts left (round ${g.rounds}): ${failureReasons(ctx, b.placeJobs)}`
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} ${g.reason}`)
    if (stuckRound(ctx, g, left.length) && (g.repairs ?? 0) < ctx.config.conflictMaxRepairs && planning(ctx.f) === undefined) {
      g.repairs = (g.repairs ?? 0) + 1
      // M7 (seed 11 g113, user request in-session 2026-11-04): ghosts that are all route pieces only reroute those routes
      // around their tiles; the goal gave up 5653 built entities for one underground belt that could not be placed.
      const stuckRoutes: IDS.RouteId[] = []
      const stuckTiles: Record<number, boolean> = {}
      let onlyRoutes = true
      for (const gh of left) {
        const k = tkey(math.floor(gh.position.x), math.floor(gh.position.y))
        const rid = ctx.f.layout.routeOcc[k]
        if (rid === undefined || ctx.f.layout.routes[rid] === undefined) onlyRoutes = false
        else if (stuckRoutes.indexOf(rid) < 0) stuckRoutes.push(rid)
        stuckTiles[k] = true
      }
      if (onlyRoutes && stuckRoutes.length > 0 && reroute(ctx, g, entry, stuckRoutes, stuckTiles)) {
        g.stuck = 0
        return
      }
      relocateGoal(ctx, g, entry, `build stuck: ${g.reason}`)
      return
    }
    replanGhosts(ctx, g, b, left, entry.job?.layout ?? ctx.f.layout)
    return
  }
  transitionGoal(g, "done")
  g.builtTick = ctx.tick
  for (const n of g.nodes) {
    const node = f.graph.nodes[n.id]
    if (node !== undefined) {
      node.lifecycle = "built"
      node.builtTick = ctx.tick
    }
  }
  RT.removePlan(entry.id)
  ctx.faction.brain!.steps++
  mark(ctx.faction, `${g.kind}-built`)
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) built at tick ${ctx.tick} (${g.placed} placements, ${g.rounds} extra rounds)`)
}

// ---------------------------------------------------------------------------------------------------------
// Conflicts (M5a.2): parts of a build blocked by something the faction doesn't own

type Entry = NonNullable<ReturnType<typeof RT.getPlannerEntry>>

/**
 * Checks a goal's build against the world (planner/conflicts.ts). Blocked routes are rerouted around the blocker (the
 * old pieces the new route doesn't reuse are picked up first); a blocked module or pole gives up the goal's location:
 * its built entities are deconstructed, its parts leave the layout and its nodes the graph, and the goal fails so the
 * design starts it again elsewhere. At most `conflict-max-repairs` repairs per goal. Returns whether it acted.
 */
function resolveConflicts(ctx: Ctx, g: FactoryGoal, entry: Entry): boolean {
  const b = entry.build!
  if (b.parts === undefined) return false
  const check = checkBuild(ctx.surface, ctx.faction.force, ctx.f.layout, b.parts)
  if (check.conflicts.length === 0) return false
  const what = check.conflicts.map((c) => `${c.kind} ${c.id} at ${c.at.x},${c.at.y} blocked by ${c.blocker}`).join("; ")
  if ((g.repairs ?? 0) >= ctx.config.conflictMaxRepairs) {
    g.reason = `conflict, no repairs left: ${what}`
    return false
  }
  // A plan in progress works on a copy of the layout and replaces it when adopted: repair after it.
  if (planning(ctx.f) !== undefined) {
    g.reason = `conflict, waiting for the current plan: ${what}`
    return true
  }
  g.repairs = (g.repairs ?? 0) + 1
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} conflict (repair ${g.repairs}): ${what}`)
  const routes: IDS.RouteId[] = []
  let relocate = false
  for (const c of check.conflicts) {
    if (c.kind === "route") routes.push(IDS.routeId(c.id))
    else relocate = true
  }
  if (!relocate && reroute(ctx, g, entry, routes)) return true
  relocateGoal(ctx, g, entry, what)
  return true
}

function reroute(ctx: Ctx, g: FactoryGoal, entry: Entry, routes: IDS.RouteId[], avoid?: Record<number, boolean>): boolean {
  const f = ctx.f
  const b = entry.build!
  const t = storage.terrains?.[f.terrain]
  if (t === undefined) return false
  // The blocker may be newer than the terrain scan: rescan the chunks of the blocked routes now.
  const chunks: Record<string, boolean> = {}
  for (const rid of routes) {
    for (const k of f.layout.routes[rid]?.tiles ?? []) {
      const cx = math.floor(keyX(k) / 32)
      const cy = math.floor(keyY(k) / 32)
      const ck = `${cx},${cy}`
      if (chunks[ck] || !ctx.surface.is_chunk_generated({ x: cx, y: cy })) continue
      chunks[ck] = true
      scanChunk(t, ctx.surface, cx, cy)
    }
  }
  let all = RT.tiers()
  const maxUg = maxUndergroundNow(ctx)
  if (maxUg !== undefined) all = all.map((x) => ({ ...x, maxUnderground: math.min(x.maxUnderground, maxUg) }))
  const region: Rect = { x: f.center.x - g.radius, y: f.center.y - g.radius, w: 2 * g.radius, h: 2 * g.radius }
  const plan = planReroute(f.layout, RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t)), prototypeFacts, RT.entryPolicy(entry), all[0], routes, region, avoid)
  if (!plan.ok) {
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id}: ${plan.reason}`)
    return false
  }
  f.layout = plan.layout
  entry.job!.layout = plan.layout
  // Build parts: the ripped routes (and their taps) are replaced by the new ones.
  const gone: Record<string, boolean> = {}
  for (const rid of b.parts!.routes) if (plan.layout.routes[rid] === undefined) gone[rid] = true
  const kept = b.parts!.routes.filter((rid) => !gone[rid])
  for (const rid of plan.routes) if (kept.indexOf(rid) < 0) kept.push(rid)
  b.parts!.routes = kept
  const reserved = ctx.faction.brain!.reserved
  for (const k of partTiles(plan.layout, { modules: [], routes: plan.routes, poles: [] })) reserved[k] = true
  resyncReserved(ctx.faction, plan.layout)
  // Graph edges: their physical routes.
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.kind !== "belt") continue
    const physical: string[] = []
    for (const rid of plan.layout.routeOrder) {
      const r = plan.layout.routes[rid]
      if (r.conn !== e.role) continue
      if (r.tapOf !== undefined) physical.push(r.tapOf)
      physical.push(rid)
    }
    if (physical.length > 0) e.physical = physical
  }
  // Old pieces first (picked up by the crew, items kept), then the new ghosts: a ghost can't go where a belt stands.
  const d = applyDiff(ctx.surface, ctx.faction, plan.remove, [], { priority: b.priority }, f.layout)
  g.rework = { clearJobs: d.clearJobs, add: plan.add }
  b.ghosts = (b.ghosts ?? []).filter((gh) => gh.valid)
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} rerouted ${routes.join(", ")}: ${plan.remove.length} entities to pick up, ${plan.add.length} to build`)
  rework(ctx, g, b)
  return true
}

/** A reroute's second phase: once its pick-ups are done, its new ghosts and place jobs. Returns whether it is done. */
export function rework(ctx: Ctx, g: FactoryGoal, b: NonNullable<Entry["build"]>): boolean {
  const w = g.rework!
  if (b.retryAt !== undefined && ctx.tick < b.retryAt) return false
  for (const id of w.clearJobs) {
    const j = getJob(ctx.faction.board, id)
    if (j !== undefined && j.status !== "done" && j.status !== "failed") return false
  }
  if (clearObstacles(ctx, w)) return false
  const d = applyDiff(ctx.surface, ctx.faction, [], w.add, { fuel: b.fuel, priority: b.priority }, ctx.f.layout)
  for (const gh of d.ghosts) b.ghosts!.push(gh)
  for (const id of d.placeJobs) b.placeJobs.push(id)
  if (d.failed.length > 0) {
    // B152: `applyDiff` is two-phase, so a partial add created ghosts but no jobs. Keep the add list and retry; the
    // old path cleared `g.rework` and moved on, leaving every successful ghost jobless (the splitter at 350,-41.5).
    g.reason = `${d.failed.length} rerouted ghosts could not be created: ${d.failed.slice(0, 4).join("; ")}`
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id}: ${g.reason}`)
    b.retryAt = ctx.tick + BUILD_ROUND_TICKS
    if (!stuckRound(ctx, g, d.failed.length)) return false
    // Persistent blocker: give the successful ghosts their jobs anyway rather than leaving them orphans; the failed
    // piece stays missing and the reconciler can repair its edge.
    for (const gh of d.ghosts) {
      const id = addPlaceJob(ctx.faction, gh, { fuel: b.fuel, priority: b.priority })
      if (id !== undefined) b.placeJobs.push(id)
    }
  }
  b.retryAt = undefined
  g.rework = undefined
  b.phase = "place"
  return true
}

/** Gives up a goal's location: deconstructs what it built, drops its parts and nodes; the design starts it again. */
function relocateGoal(ctx: Ctx, g: FactoryGoal, entry: Entry, what: string): void {
  const f = ctx.f
  const b = entry.build!
  const r = abandonParts(ctx.surface, ctx.faction, f.layout, b.parts!, b.priority)
  // D55/P36: its roles' replacement goals wait for the same clear jobs (the old footprint is still `OWN`).
  if (r.clearJobs.length > 0) {
    f.relocation ??= {}
    for (const n of g.nodes) f.relocation[n.role] = r.clearJobs
  }
  const reserved = ctx.faction.brain!.reserved
  for (const k of r.tiles) delete reserved[k]
  for (const id of b.parts!.modules) {
    // Module margins were reserved with the module (adoptPlan).
    const m = LO.findModule(entry.job!.layout, id)
    if (m !== undefined) for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) delete reserved[tkey(x, y)]
  }
  resyncReserved(ctx.faction, f.layout)
  for (const n of g.nodes) LG.removeNode(f.graph, n.id)
  for (const e of g.edges) LG.removeEdge(f.graph, `e:${e.role}`)
  transitionGoal(g, "failed")
  g.reason = `relocating: ${what}`
  RT.removePlan(entry.id)
  const kept = r.keptPoles > 0 ? `, ${r.keptPoles} pole(s) kept as a power bridge` : ""
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) gives up its location: ${r.clearJobs.length} built entities to deconstruct, ${r.routes.length} routes dropped${kept}; the design plans it again elsewhere`)
}

/**
 * B63 diagnostics: a plan was discarded because the layout carries claims whose owner module is gone. Counting is O(1)
 * per event; the summary (kinds, the owner ids that leaked and their counts) is built and logged at most once a game
 * minute per faction, so a claim loop cannot flood the log or cost anything on the hot path.
 */
function reportOrphanClaims(ctx: Ctx, g: FactoryGoal, problems: string[]): void {
  const f = ctx.f
  f.orphanClaims = (f.orphanClaims ?? 0) + problems.length
  f.orphanEvents = (f.orphanEvents ?? 0) + 1
  // Once a game minute per faction (60 s).
  if (ctx.tick - (f.orphanLogTick ?? -3600) < 3600) return
  f.orphanLogTick = ctx.tick
  const kinds: Record<string, number> = {}
  const owners: Record<string, number> = {}
  const order: string[] = []
  for (const p of problems) {
    const [kind] = string.match(p, "names missing (%S+)")
    if (kind !== undefined) kinds[kind] = (kinds[kind] ?? 0) + 1
    const [owner] = string.match(p, "names missing %S+ (%S+)$")
    if (owner === undefined) continue
    if (owners[owner] === undefined) order.push(owner)
    owners[owner] = (owners[owner] ?? 0) + 1
  }
  let kk = ""
  for (const k in kinds) kk += `${k}:${kinds[k]} `
  let oo = ""
  let n = 0
  for (const o of order) {
    if (n++ >= 4) break
    oo += `${o}x${owners[o]} `
  }
  const detail = `${problems.length} tile(s), kinds ${kk.trim()}, owners ${oo.trim()}`
  log(`[rival-engineers] faction ${ctx.faction.name}: ORPHAN CLAIMS in plan ${g.id}: ${detail} (running total ${f.orphanClaims} tiles in ${f.orphanEvents} plan(s); first ${problems[0] ?? ""})`)
  recordDiagnostic(ctx.faction, { tick: ctx.tick, kind: "planner", goal: g.id, decision: "orphan-claims", reason: detail })
}

/**
 * B20: counts leftover-ghost rounds that placed nothing; true (and a BUILD STUCK log line) once `build-stuck-rounds` are
 * reached (0 = never escalate).
 */
function stuckRound(ctx: Ctx, g: FactoryGoal, left: number): boolean {
  const r = DS.stuckRounds(g.stuck, g.lastLeft, left, ctx.config.buildStuckRounds)
  g.stuck = r.stuck
  g.lastLeft = left
  if (!r.escalate) return false
  log(`[rival-engineers] faction ${ctx.faction.name}: BUILD STUCK goal ${g.id} (${g.kind}): ${ctx.config.buildStuckRounds} rounds placed nothing: ${g.reason}`)
  return true
}

function failureReasons(ctx: Ctx, ids: number[]): string {
  const count: Record<string, number> = {}
  for (const id of ids) {
    const j = getJob(ctx.faction.board, id)
    if (j === undefined || j.status !== "failed") continue
    const p = j.payload as { item?: string }
    const k = `${p.item ?? j.kind} at ${math.floor(j.pos.x)},${math.floor(j.pos.y)}: ${j.reason ?? "?"}`
    count[k] = (count[k] ?? 0) + 1
  }
  const out: string[] = []
  for (const [k, n] of pairs(count)) if (out.length < 4) out.push(`${k as string} ×${n}`)
  return out.join("; ")
}

/** Re-places leftover ghosts, after clearing what blocks them; `layout` is what the build realizes. */
function replanGhosts(ctx: Ctx, g: FactoryGoal, b: NonNullable<ReturnType<typeof RT.getPlannerEntry>>["build"], left: LuaEntity[], layout: LayoutState): void {
  const faction = ctx.faction
  b!.placeJobs = []
  // B15: a bootstrap site built after the plan's terrain scan may stand under a leftover ghost: evict it.
  const under: Record<number, boolean> = {}
  for (const gh of left) {
    if (!gh.valid) continue
    const box = gh.bounding_box
    for (let x = math.floor(box.left_top.x + 0.05); x < math.ceil(box.right_bottom.x - 0.05); x++) for (let y = math.floor(box.left_top.y + 0.05); y < math.ceil(box.right_bottom.y - 0.05); y++) under[tkey(x, y)] = true
  }
  // B21/D52: a whole-patch mine is materialized after its small seed placement, so its internal collector can reveal
  // a collision with a D38 temporary cell on already-depleted ore. The accepted permanent plan wins: retire only the
  // temporary cells actually under leftover ghosts. `modulesOnTiles` cannot rely on `occ`, because the mine's later
  // exact claim may already own those keys.
  for (const m of LO.modulesOnTiles(ctx.f.layout, under)) {
    const n = ctx.f.graph.nodes[m.id]
    if (n !== undefined && n.lifecycle === "built" && ST.isTempRole(n.role)) retireTemp(ctx, n)
  }
  for (const e of evictSites(faction, ctx.surface, under, `goal ${g.id}'s leftover ghosts`)) addClearJob(faction, e, b!.priority)
  for (const gh of left) {
    // A tree or rock under a leftover ghost (its clear job failed, or it overlaps the footprint only at the box edge)
    // blocks the placement for good: clear it again. B101: the ghost's whole box (any overlap blocks; seed 7718665's
    // tree reached ~0.05 into a belt's box and was missed by a 0.05 inset).
    if (!gh.valid) continue
    const area = gh.bounding_box
    for (const e of findEntities(ctx.surface, { area, type: ["tree", "simple-entity"] })) {
      const k = `${e.position.x},${e.position.y}`
      g.clearing ??= {}
      const old = g.clearing[k]
      const j = old !== undefined ? getJob(faction.board, old) : undefined
      if (j !== undefined && j.status !== "done" && j.status !== "failed") continue
      const job = addClearJob(faction, e, b!.priority)
      g.clearing[k] = job
      log(`[rival-engineers] faction ${faction.name}: goal ${g.id}: clearing ${e.name} at ${k} under a leftover ${gh.ghost_name} ghost${j !== undefined ? ` (last clear job ${j.status}: ${j.reason ?? "?"})` : ""}`)
      // M7c.9: cleared once already and still there: the ghost may cover it (the crew refuse to mine a selected
      // ghost). Lift the ghost until this clear job ends, as a player would cancel it, mine, and place it again.
      if (old !== undefined && gh.valid) {
        const l = LIFT.liftGhost(gh, job)
        ;(g.lifted ??= []).push(l)
        log(`[rival-engineers] faction ${faction.name}: goal ${g.id}: lifted the ${l.name} ghost at ${l.position.x},${l.position.y} until what it covers is cleared`)
      }
    }
  }
  // B42: one of the faction's own entities the layout no longer plans (an obsolete route piece put back) blocks a
  // leftover ghost for good: pick it up. Stockpiles and bootstrap sites (evicted above) stay, and an entity already
  // being cleared is not cleared twice.
  let planned: Record<string, boolean> | undefined
  for (const gh of left) {
    if (!gh.valid) continue
    if (planned === undefined) {
      // A plan's layout copied the base when it was planned: what the faction's layout gained since is planned too.
      planned = RT.layoutEntityKeys(layout)
      if (layout !== ctx.f.layout) for (const [k] of pairs(RT.layoutEntityKeys(ctx.f.layout))) planned[k as string] = true
    }
    for (const e of RT.strayUnder(ctx.surface, faction.force, planned, gh)) {
      if (faction.stockpiles.indexOf(e) >= 0 || isSitePart(faction.brain, e) || clearJobFor(faction, e) !== undefined) continue
      addClearJob(faction, e, b!.priority)
      log(`[rival-engineers] faction ${faction.name}: goal ${g.id}: picking up ${e.name} at ${e.position.x},${e.position.y} under a leftover ${gh.ghost_name} ghost (not in the layout)`)
    }
  }
  for (const gh of left) {
    if (!gh.valid) continue
    const key = gh.unit_number!
    const old = faction.ghostJobs[key]
    if (old !== undefined) {
      const j = getJob(faction.board, old)
      if (j === undefined || j.status === "failed" || j.status === "done") delete faction.ghostJobs[key]
    }
    const id = addPlaceJob(faction, gh, { fuel: b!.fuel, priority: b!.priority })
    if (id !== undefined) b!.placeJobs.push(id)
    else if (faction.ghostJobs[key] !== undefined) b!.placeJobs.push(faction.ghostJobs[key])
  }
  b!.phase = "place"
}

// ---------------------------------------------------------------------------------------------------------
// Measurement and reconciler (M5b, SPEC §5.8 D26): measure.ts samples, reconcile.ts classifies and finds root causes,
// here remedies become goals: grow an undersized producer (expand-first, like a design growth), repair a broken route
// or pole line (its missing pieces re-placed), refuel a crew-fuelled burner (upkeep now).

/** Fixed reconciler thresholds (docs/reports/M5-report.md "Magic numbers"); the rest are settings. */
const RECONCILE_BAD_SHARE = 0.5
const RECONCILE_MIN_ACTIVE = 0.1
const RECONCILE_BUSY_SHARE = 0.85
const RECONCILE_EDGE_FULL = 0.9
const RECONCILE_PORT_FULL = 0.5
const RECONCILE_ARRIVED_SHARE = 0.75

export function reconcileParams(config: Config): ReconcileParams {
  return {
    warmupTicks: config.reconcileWarmupTicks,
    confirm: config.reconcileConfirm,
    shortfall: config.reconcileShortfall,
    badShare: RECONCILE_BAD_SHARE,
    minActive: RECONCILE_MIN_ACTIVE,
    busyShare: RECONCILE_BUSY_SHARE,
    edgeFull: RECONCILE_EDGE_FULL,
    portFull: RECONCILE_PORT_FULL,
    arrivedShare: RECONCILE_ARRIVED_SHARE,
    probeTicks: config.measureProbeTicks,
    // An edge measurement is fresh for one node window.
    probeMaxAge: config.measureIntervalTicks * config.measureWindowSamples,
    maxRemedies: config.reconcileMaxRemedies,
    cooldownTicks: config.reconcileCooldownTicks,
  }
}

function isFuel(this: void, item: string): boolean {
  return prototypeFacts.fuelValue(item) > 0
}

function measureAndReconcile(ctx: Ctx): void {
  const f = ctx.f
  f.meter ??= MS.newMeter()
  const meter = f.meter
  if (ctx.tick - meter.lastSample >= ctx.config.measureIntervalTicks) {
    meter.lastSample = ctx.tick
    MS.sampleNodes(meter, f.graph, f.layout, ctx.surface, ctx.faction.force, ctx.tick, ctx.config.measureWindowSamples)
    // B125: built merge splitters get their filter and trunk-side priority (the crew sets them like a player would).
    const tuned = RT.tuneMergeSplitters(ctx.surface, ctx.faction.force, f.layout)
    if (tuned > 0) log(`[rival-engineers] faction ${ctx.faction.name}: ${tuned} merge splitter(s) set to their item, trunk side first (B125)`)
    f.reconciler ??= newReconcileState()
    // D49: labs are hand-fed by the crew until a built producer belts their pack in.
    const crewSupplied = (n: LogicalNode, item: string): boolean => {
      if (n.kind !== "labs") return false
      for (const e of LG.edgesInto(f.graph, n.id)) if (e.kind === "belt" && e.item === item && e.from !== undefined && f.graph.nodes[e.from]?.lifecycle === "built") return false
      return true
    }
    const retiring = (n: LogicalNode): boolean => f.retiring?.[n.role]?.node === n.id
    const params = reconcileParams(ctx.config)
    params.probeMaxAge = probeMaxAgeFor(params.probeMaxAge, ctx.config.measureProbeTicks, ctx.config.brainIntervalTicks, MS.probeableCount(f.graph))
    const r = reconcile(f.graph, f.reconciler, { tick: ctx.tick, params, isFuel, crewSupplied, retiring })
    countWork("reconcilerEvaluations", f.graph.nodeOrder.length)
    MS.requestProbes(meter, r.probe)
    if (ctx.config.reconcileRemedies) for (const rem of r.remedies) applyRemedy(ctx, rem)
  }
  if (meter.probe === undefined) MS.startProbe(meter, f.graph, f.layout, ctx.surface, ctx.tick, ctx.config.measureProbeTicks)
}

/** Every tick: the running edge probes sample when due (cheap when none is due). */
export function onFactoryMeterTick(): void {
  const all = storage.factories
  if (all === undefined) return
  const tick = game.tick
  for (const name of storage.factionOrder) {
    const f = all[name]
    if (f?.meter?.probe !== undefined) MS.probeTick(f.meter, f.graph, tick)
  }
}

/** For tests: one measurement + reconcile pass (and the goal updates remedies need) outside the brain's cadence. */
export function reconcileNow(faction: FactionState, f: FactoryState, config: Config = getConfig()): void {
  const ctx: Ctx = { faction, f, config, force: factionForce(faction), surface: factionSurface(faction), tick: game.tick, entities: parsePairs(config.factoryEntities), waiting: [] }
  updateGoals(ctx)
  f.meter ??= MS.newMeter()
  f.meter.lastSample = -math.huge
  measureAndReconcile(ctx)
  if (ctx.waiting.length > 0) f.waiting = ctx.waiting
}

/** For tests (B98): one `startGrow` outside the reconciler. */
export function growNow(faction: FactionState, f: FactoryState, growth: NonNullable<GoalSpec["growth"]>): boolean | "wait" {
  const ctx: Ctx = { faction, f, config: getConfig(), force: factionForce(faction), surface: factionSurface(faction), tick: game.tick, entities: parsePairs(getConfig().factoryEntities), waiting: [] }
  const r = startGrow(ctx, { kind: "grow", nodes: [], edges: [], techs: [], growth })
  f.waiting = ctx.waiting
  return r
}

/**
 * B57 (seed 555555): the plan's seal check proved the goal end of a connection walled in, and that end is a built
 * module's unconnected input (the labs' green-science input in a pocket). No plan can feed it there: relocate the module
 * (as P36 / B51: deconstructed, out of the layout and graph; the design plans it again). Checked again on the faction's
 * own layout first (the failed plan's own modules may be what walled it in), and not while another goal builds a
 * connection to or from it. Returns the relocated role.
 */
function relocateSealed(ctx: Ctx, g: FactoryGoal, evidence: PlanEvidence[]): string | undefined {
  const f = ctx.f
  const t = storage.terrains?.[f.terrain]
  if (t === undefined) return undefined
  const escape = policyFor(ctx.config).placement.portEscape ?? 0
  const view = RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t))
  // B63: trust the router's proof. It names the *consumer's own input port* in every measured join failure
  // (3891760 n1.in-fuel, 1376111 n8.in-ore, 6752307 n23.in-iron-plate). The old second opinion here (`sealedInputs`,
  // a 32-tile lane-escape check) disagreed in all three and vetoed the only cheap remedy. A flood that hit the window
  // edge (`edge`) is not enclosure: the wider-window replan above answers that first.
  for (const { port, subject } of LO.sealedGoalPorts(f.layout, evidence)) {
    const id = port.module
    const n = f.graph.nodes[id]
    if (n === undefined) continue
    let busy: string | undefined
    for (const o of f.goals) {
      if (o === g || (o.status !== "building" && o.status !== "planning")) continue
      for (const e of o.edges) if (e.from === n.role || e.to === n.role) busy = o.id
    }
    if (busy !== undefined) {
      log(`[rival-engineers] faction ${ctx.faction.name}: B57 ${n.role} (${id}) has its ${port.port} lane walled in; relocation waits for goal ${busy}`)
      continue
    }
    FU.relocate(ctx, n, `B57 ${n.role}`, `has its ${port.port} lane walled in (goal ${g.id}: ${subject})`)
    return n.role
  }
  // B61 (2229258): a route can fail from the start side while its goal module's input lane is also sealed. The seal
  // evidence may name the start, so the B57 loop above never sees the real walled-in consumer. Inspect the goal module of
  // every failed route, and relocate that consumer when its own input lane cannot lead out.
  if (escape <= 0) return undefined
  for (const ev of evidence) {
    if (ev.kind !== "route" || ev.sealed?.edge === true) continue
    const [role] = string.match(ev.subject, "=>([^%.]+)%.")
    if (role === undefined) continue
    let n: LogicalNode | undefined
    for (const x of g.nodes) if (x.role === role) n = f.graph.nodes[x.id]
    if (n === undefined || LO.findModule(f.layout, n.id) === undefined) continue
    if (sealedInputs(f.layout, view, n.id, {}, escape).length === 0) continue
    let busy: string | undefined
    for (const o of f.goals) {
      if (o === g || (o.status !== "building" && o.status !== "planning")) continue
      for (const e of o.edges) if (e.from === n.role || e.to === n.role) busy = o.id
    }
    if (busy !== undefined) {
      log(`[rival-engineers] faction ${ctx.faction.name}: B61 ${n.role} (${n.id}) has a sealed input lane; relocation waits for goal ${busy}`)
      continue
    }
    FU.relocate(ctx, n, `B61 ${n.role}`, `has a sealed input lane (goal ${g.id}: ${ev.subject})`)
    return n.role
  }
  return undefined
}

/**
 * D55: gives up a worked-out mine (P36's relocation: deconstructed, out of the layout and graph); the design plans its
 * producer again on fresh ore. Not while a plan works on a copy of the layout, nor while a goal builds a connection from it.
 */
function relocateDepleted(ctx: Ctx, n: LogicalNode, why: string, say: (this: void, result: string) => void): void {
  // D76: nothing is deconstructed here. The provider is marked as retiring and the design plans a replacement for its
  // consumers; `serviceRetiring` deconstructs it once that replacement is built or its drills run dry.
  FU.beginRetire(ctx, n, `D55 ${n.role}`, `is worked out (${why})`)
  say("retiring: it keeps producing until its replacement is built (D55, D76)")
}

type RemedySay = (this: void, result: string) => void

/** D69: one handler per remedy kind (was one ~270-line function branching on the kind and on the key's prefix). */
const REMEDIES: Record<RemedyKind, (this: void, ctx: Ctx, r: Remedy, say: RemedySay) => void> = {
  upkeep: (ctx, _r, say) => {
    const f = ctx.f
    f.lastUpkeep = -math.huge
    upkeep(ctx)
    f.lastUpkeep = ctx.tick
    say("upkeep pass")
  },
  // B60 group remedy: a shared trunk at capacity. The provider keeps every consumer it serves; the design caps it at
  // its real capacity and gives the residual demand a parallel role (with merge side-loads), instead of asking this
  // one to grow into a belt that is already full.
  parallel: (ctx, r, say) => {
    const f = ctx.f
    const n = f.graph.nodes[r.node!]
    if (n === undefined) {
      say("cannot split: the node left the graph")
      return
    }
    if (!CS.add((f.constraints ??= {}), "providerShort", n.role)) {
      say("group remedy: already split")
      return
    }
    say(`group remedy: ${n.role} keeps its consumers and the rest go to a parallel provider`)
  },
  grow: (ctx, r, say) => {
    const f = ctx.f
    // A plan in flight works on a copy of the layout and replaces it when adopted: grow after it.
    const busyGrow = activeGoal(f, "grow")
    if (planning(f) !== undefined || (busyGrow !== undefined && busyGrow.growth?.node === r.node)) return
    const n = f.graph.nodes[r.node!]
    const m = n !== undefined ? LO.findModule(f.layout, n.id) : undefined
    if (n === undefined || m === undefined || m.canonical.expand === undefined) {
      say("cannot grow: no expandable module")
      return
    }
    growNode(ctx, r, say, n, false)
  },
  // A worked-out outpost must expand now (it is starving the line), so only a growth of the SAME node blocks it (D52:
  // a depleted outpost expands even while other goals plan or grow).
  deplete: (ctx, r, say) => {
    const f = ctx.f
    const busyGrow = activeGoal(f, "grow")
    if (busyGrow !== undefined && busyGrow.growth?.node === r.node) return
    const n = f.graph.nodes[r.node!]
    const m = n !== undefined ? LO.findModule(f.layout, n.id) : undefined
    if (n === undefined || m === undefined) {
      say("cannot grow: no expandable module")
      return
    }
    // D55 (user, 2026-10-20): a worked-out mine that can't expand in place (a completed whole-patch mine, or a partial one
    // with no `expand`) first moves to the next free part of its own patch; with nothing better left there, it retires
    // and is planned again elsewhere.
    if (m.minePlan?.complete === true || (m.minePlan !== undefined && m.canonical.expand === undefined)) {
      const before = f.goals.length
      const moved = startGrow(ctx, { kind: "grow", nodes: [], edges: [], techs: [], growth: { role: n.role, node: n.id, units: 1, need: 0, have: 0, reclaim: true } })
      // B52: it reroutes a connection still being built: try again later.
      if (moved === "wait") return
      if (moved === true && f.goals.length > before) {
        say(`goal ${f.goals[f.goals.length - 1].id} moves it to the next part of its patch (D55)`)
        return
      }
      relocateDepleted(ctx, n, ctx.waiting[ctx.waiting.length - 1] ?? "its patch is used up", say)
      return
    }
    // D55: a depleted mine with neither an in-place `expand` nor a whole-patch plan (a shared mine) retires and is
    // planned again elsewhere. Without this it repeats "cannot grow" every check while its consumers starve (B59, seed
    // 3333: n39, logistic science).
    if (m.canonical.expand === undefined) {
      relocateDepleted(ctx, n, ctx.waiting[ctx.waiting.length - 1] ?? "its ore is used up", say)
      return
    }
    growNode(ctx, r, say, n, true)
  },
  // Repair: re-place the missing pieces of the edge's route (belt) or pole lines (power).
  repair: (ctx, r, say) => {
    const f = ctx.f
    /**
     * B88: routes `routes` (and every route tapping them) again in place, to their ports as they are now, as a repair goal:
     * the old pieces the new routes don't reuse are picked up first, then the new ones placed. The graph keeps its edges;
     * their physical routes follow. Returns false when no reroute was found.
     */
    const rerouteInPlace = (routes: IDS.RouteId[], why: string): boolean => {
      const t = storage.terrains?.[f.terrain]
      if (t === undefined || routes.length === 0) return false
      const tree = LO.dependentRoutes(f.layout, routes)
      let all = RT.tiers()
      const maxUg = maxUndergroundNow(ctx)
      if (maxUg !== undefined) all = all.map((x) => ({ ...x, maxUnderground: math.min(x.maxUnderground, maxUg) }))
      // The whole factory, with the router's detour room around it.
      const base = policyFor(ctx.config)
      const policy = tree.length > routes.length ? { ...base, topology: "splitter-tap" as const } : base
      let x1 = math.huge
      let y1 = math.huge
      let x2 = -math.huge
      let y2 = -math.huge
      for (const m of f.layout.modules) {
        x1 = math.min(x1, m.rect.x); y1 = math.min(y1, m.rect.y)
        x2 = math.max(x2, m.rect.x + m.rect.w); y2 = math.max(y2, m.rect.y + m.rect.h)
      }
      for (const rid of f.layout.routeOrder) {
        for (const k of f.layout.routes[rid].tiles) {
          x1 = math.min(x1, keyX(k)); y1 = math.min(y1, keyY(k))
          x2 = math.max(x2, keyX(k) + 1); y2 = math.max(y2, keyY(k) + 1)
        }
      }
      const pad = policy.router.margin
      const region: Rect = { x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad }
      const plan = planReroute(f.layout, RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t)), prototypeFacts, policy, all[0], tree, region)
      if (!plan.ok) {
        log(`[rival-engineers] faction ${ctx.faction.name}: B88 reroute of ${tree.join(", ")} failed: ${plan.reason}`)
        return false
      }
      f.layout = plan.layout
      const reserved = ctx.faction.brain!.reserved
      for (const k of partTiles(plan.layout, { modules: [], routes: plan.routes, poles: [] })) reserved[k] = true
      resyncReserved(ctx.faction, plan.layout)
      for (const id of f.graph.edgeOrder) {
        const e = f.graph.edges[id]
        if (e.kind !== "belt") continue
        const physical: string[] = []
        for (const rid of plan.layout.routeOrder) {
          const r = plan.layout.routes[rid]
          if (r.conn !== e.role) continue
          if (r.tapOf !== undefined) physical.push(r.tapOf)
          physical.push(rid)
        }
        if (physical.length > 0) e.physical = physical
      }
      // Old pieces first (picked up, items kept), then the new ones: a ghost can't go where a belt stands.
      const d = applyDiff(ctx.surface, ctx.faction, plan.remove, [], { priority: ctx.config.factoryBuildPriority }, f.layout)
      const g: FactoryGoal = {
        id: IDS.goalId(`g${f.nextGoal++}`),
        kind: "repair",
        status: "building",
        nodes: [],
        edges: [],
        techs: [],
        attempts: 1,
        radius: 0,
        createdTick: ctx.tick,
        plannedTick: ctx.tick,
        placed: 0,
        rounds: 0,
        reason: why,
        growBuild: { phase: d.clearJobs.length > 0 ? "clear" : "place", clearJobs: d.clearJobs, add: plan.add, ghosts: [], placeJobs: [] },
      }
      f.goals.push(g)
      say(`its routes do not reach their port in the layout: goal ${g.id} reroutes ${tree.length} routes in place (${plan.remove.length} entities to pick up, ${plan.add.length} to build) (B83, B88)`)
      return true
    }
    // B140: several feeds share one consumer port. Reroute the whole merge tree once instead of repairing each feed
    // into "nothing missing".
    if (r.key.indexOf("shared:") === 0) {
      const rep = r.edge !== undefined ? f.graph.edges[r.edge] : undefined
      if (rep === undefined) return
      if (planning(f) !== undefined) {
        say("the shared port reroutes after the current plan")
        return
      }
      const routes: IDS.RouteId[] = []
      for (const id of f.graph.edgeOrder) {
        const o = f.graph.edges[id]
        if (o === undefined || o.kind !== "belt" || o.to !== rep.to || o.toPort !== rep.toPort || o.item !== rep.item) continue
        for (const rid of o.physical) if (f.layout.routes[rid] !== undefined && routes.indexOf(IDS.routeId(rid)) < 0) routes.push(IDS.routeId(rid))
      }
      if (rerouteInPlace(routes, r.why)) return
      say("could not reroute the shared port")
      return
    }
    const e = f.graph.edges[r.edge!]
    if (e === undefined) return
    const parts: BuildParts = { modules: [], routes: [], poles: [] }
    if (e.kind === "power") {
      for (const p of f.layout.poles ?? []) if (e.physical.indexOf(p.line) >= 0) parts.poles.push(p.id)
    } else {
      for (const rid of e.physical) if (f.layout.routes[rid] !== undefined) parts.routes.push(IDS.routeId(rid))
      // M7c.8: a fluid route's pump poles are part of it (plan deltas before the fix never built them).
      for (const p of f.layout.poles ?? []) if (e.physical.some((rid) => p.line === LO.pumpPoleLine(rid))) parts.poles.push(p.id)
    }
    // M7c.8: with the splitters other routes stand on its tiles (`routeCheck`).
    let only: ((this: void, s: EntitySpec) => boolean) | undefined
    if (e.kind === "belt") {
      const rc = routeCheck(f.layout, parts.routes)
      parts.routes = rc.routes
      only = rc.only
    }
    const check = checkBuild(ctx.surface, ctx.faction.force, f.layout, parts, only, ctx.faction)
    let clogged: { spec: EntitySpec; entity: LuaEntity }[] = []
    if (e.kind === "power") {
      // B47: built modules' own poles carry the network too (a completed mine's poles linked two new modules): missing
      // ones are re-placed like line poles. Never their machines (D49).
      const built: BuildParts = { modules: [], routes: [], poles: [] }
      for (const n of LG.nodesOf(f.graph)) if (n.lifecycle === "built" && LO.findModule(f.layout, n.id) !== undefined) built.modules.push(n.id)
      const own = checkBuild(ctx.surface, ctx.faction.force, f.layout, built, (s) => prototypes.entity[s.name]?.type === "electric-pole", ctx.faction)
      for (const s of own.missing) check.missing.push(s)
      for (const s of own.orphans) check.orphans.push(s)
    }
    if (check.missing.length === 0 && check.misdirected.length === 0 && check.stale.length === 0 && check.intruders.length === 0) {
      // B83: every entity stands, but the edge's routes do not bring items to the consumer's port in the layout (a
      // side-load stub onto a trunk that is gone). Its own routes are dropped (belts picked up) with the edge, and the
      // design plans the connection again.
      if (e.kind === "belt" && check.conflicts.length === 0 && e.toPort !== undefined) {
        const inLayout = (id: string): boolean => LO.findModule(f.layout, id) !== undefined
        const to = LG.connectModule(f.graph, e.to, inLayout) ?? e.to
        if (!LO.routesLand(f.layout, e.physical, { module: to, port: e.toPort })) {
          const own: IDS.RouteId[] = []
          for (const rid of e.physical) {
            const r = f.layout.routes[rid]
            if (r !== undefined && r.conn === e.role) own.push(IDS.routeId(rid))
          }
          // B88 (soak vps-b85-r1264816): the routes are routed again in place, with the taps hanging off them, to the
          // ports as they are now (the edges stay: the design need not plan anything again; dropping them left the power
          // plant crew-fuelled for 400 game-min). A plan in progress works on a copy of the layout: wait for it.
          if (planning(f) !== undefined) {
            say(`its routes do not reach ${e.to}.${e.toPort} in the layout: rerouted after the current plan (B83)`)
            return
          }
          if (rerouteInPlace(own, r.why)) return
          // The reroute failed. A kept tapped route still bore the connection's id, and planned again the new route
          // replaced it in place (ripping its taps) while tapping one of them: an orphan tap. Its taps go with it, and
          // their edges are planned again too.
          const tree = LO.tapTree(f.layout, own)
          const inTree: Record<string, boolean> = {}
          for (const rid of tree) inTree[rid] = true
          const edges: string[] = [e.id]
          for (const id of f.graph.edgeOrder) {
            const o = f.graph.edges[id]
            if (o === undefined || o.id === e.id || o.kind !== "belt") continue
            if (o.physical.some((rid) => inTree[rid] && f.layout.routes[rid]?.conn === o.role)) edges.push(o.id)
          }
          const dropped = abandonParts(ctx.surface, ctx.faction, f.layout, { modules: [], routes: tree, poles: [] }, ctx.config.factoryBuildPriority)
          for (const id of edges) LG.removeEdge(f.graph, id)
          resyncReserved(ctx.faction, f.layout)
          say(`its routes do not reach ${e.to}.${e.toPort} in the layout: ${tree.length} routes dropped (${dropped.clearJobs.length} entities to pick up), the design plans ${edges.length === 1 ? "the connection" : `${edges.length} connections`} again (B83, B88)`)
          return
        }
      }
      // B67: with every planned pole standing, say whether the plan itself leaves the consumer off the network (a layout
      // gap, e.g. a growth that moved its poles) or the plan joins it and the game disagrees.
      const off = e.kind === "power" && e.to !== undefined && PW.unpoweredModules(f.layout, prototypeFacts).indexOf(e.to) >= 0
      // B107: every piece stands, but another input fills both lanes of the consumer's belts past this port: they are
      // picked up (emptied) and placed again. B124: so are its belts and the edge's route belts that hold a foreign item.
      if (e.kind === "belt" && check.conflicts.length === 0 && e.toPort !== undefined) {
        const inLayout = (id: string): boolean => LO.findModule(f.layout, id) !== undefined
        clogged = cloggedBelts(ctx.surface, ctx.faction.force, f.layout, LG.connectModule(f.graph, e.to, inLayout) ?? e.to, e.toPort, e.physical.map((rid) => IDS.routeId(rid)))
      }
      if (clogged.length === 0) {
        say(check.conflicts.length > 0 ? `blocked: ${check.conflicts[0].blocker}` : e.kind === "power" ? `nothing missing (${off ? "the layout's poles do not reach it" : "the layout's poles reach it"})` : "nothing missing")
        return
      }
    }
    // B52: a belt facing the wrong way is picked up first, then placed as planned (a ghost on the live one never revives).
    // B56: so are the faction's own stale belt pieces standing where a missing route piece goes.
    const clearJobs: IDS.JobId[] = []
    for (const w of check.misdirected) clearJobs.push(addClearJob(ctx.faction, w.entity, ctx.config.factoryBuildPriority))
    for (const s of check.stale) for (const e of s.entities) if (clearJobFor(ctx.faction, e) === undefined) clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
    for (const e of check.intruders) if (clearJobFor(ctx.faction, e) === undefined) clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
    for (const c of clogged) if (clearJobFor(ctx.faction, c.entity) === undefined) clearJobs.push(addClearJob(ctx.faction, c.entity, ctx.config.factoryBuildPriority))
    const g: FactoryGoal = {
      id: IDS.goalId(`g${f.nextGoal++}`),
      kind: "repair",
      status: "building",
      nodes: [],
      edges: [],
      techs: [],
      attempts: 1,
      radius: 0,
      createdTick: ctx.tick,
      plannedTick: ctx.tick,
      placed: 0,
      rounds: 0,
      reason: r.why,
      // B101: the missing pieces too go through the clear phase (trees in their way are cleared before their ghosts).
      growBuild: { phase: "clear", clearJobs, add: [...check.misdirected.map((w) => w.spec), ...check.stale.map((s) => s.spec), ...check.missing, ...clogged.map((c) => c.spec)], ghosts: [], placeJobs: [] },
    }
    f.goals.push(g)
    let turned = check.misdirected.length > 0 ? `, turns ${check.misdirected.length} facing the wrong way (first ${check.misdirected[0].spec.name} at ${check.misdirected[0].spec.x},${check.misdirected[0].spec.y})` : ""
    if (check.stale.length > 0) turned += `, picks up stale belts under ${check.stale.length} (first ${check.stale[0].spec.name} at ${check.stale[0].spec.x},${check.stale[0].spec.y} over ${check.stale[0].entities[0].name})`
    if (check.intruders.length > 0) turned += `, picks up ${check.intruders.length} underground(s) inside its underground spans (first at ${check.intruders[0].position.x},${check.intruders[0].position.y}) (B95)`
    if (clogged.length > 0) turned += `, empties ${clogged.length} belt(s) of ${clogged[0].spec.owner} holding a foreign item or another input on both lanes (first at ${clogged[0].spec.x},${clogged[0].spec.y}) (B107, B124)`
    if (check.orphans.length > 0) turned += `, ${check.orphans.length} of them ghosts no job builds (first ${check.orphans[0].name} at ${check.orphans[0].x},${check.orphans[0].y})`
    say(`goal ${g.id} re-places ${check.missing.length} entities${turned}`)
  },
}

/** Grows a node's module by what its ore (outposts) or one unit allows; `depleted`: it is a worked-out outpost (D55). */
function growNode(ctx: Ctx, r: Remedy, say: RemedySay, n: LogicalNode, depleted: boolean): void {
  const f = ctx.f
  const st = f.reconciler!
  const have = LG.rateIn(n.capacity.outputs, n.item ?? "")
  // D52/B21: a mining outpost expands in place over the rest of its patch; other modules grow by one unit at a time.
  // The patch is usually smaller than the belt limit, so grow only as far as the ore runs (a full-size expansion
  // would land the far drills off-ore and fail outright).
  const t = storage.terrains?.[f.terrain]
  let units = 1
  if (n.kind === "outpost" && t !== undefined) {
    units = GROW.maxExpandable(f.layout, RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t), false), prototypeFacts, policyFor(ctx.config), n.id)
    // D55: nothing left to expand over: the mine is planned again elsewhere.
    if (units < 1) {
      if (depleted) relocateDepleted(ctx, n, "no ore in its growth area", say)
      else say("cannot grow: no ore in the growth area")
      return
    }
  }
  if (units < 1) { say("cannot grow: at its expansion limit"); return }
  const before = f.goals.length
  const failsBefore = CS.value(f.constraints, "growFails", n.role) ?? 0
  const ok = startGrow(ctx, { kind: "grow", nodes: [], edges: [], techs: [], growth: { role: n.role, node: n.id, units, need: have, have } })
  // B52: waiting for a goal still building is no attempt (it doesn't use up the remedy's tries).
  if (ok === "wait") return
  say(ok === true && f.goals.length > before ? `goal ${f.goals[f.goals.length - 1].id} grows it by ${units} unit(s)` : `grow failed: ${ctx.waiting[ctx.waiting.length - 1] ?? "?"}`)
  // B52: the remedy's tries (earlier successful growths count) can run out before GROW_MAX_FAILS expansion failures:
  // its last failed try marks the growth blocked, so the design's fallback (a second steam block, other producers)
  // takes over instead of nothing.
  const fails = CS.value(f.constraints, "growFails", n.role) ?? 0
  if (ok === false && fails > failsBefore && fails < ST.GROW_MAX_FAILS && (st.remedies[r.key]?.count ?? 0) >= ctx.config.reconcileMaxRemedies) {
    CS.setValue((f.constraints ??= {}), "growFails", n.role, ST.GROW_MAX_FAILS)
    log(`[rival-engineers] faction ${ctx.faction.name}: ${n.role} growth blocked: the reconciler's ${ctx.config.reconcileMaxRemedies} tries are used up (${fails} expansion failures)`)
  }
}

function applyRemedy(ctx: Ctx, r: Remedy): void {
  const st = ctx.f.reconciler!
  REMEDIES[r.kind](ctx, r, (result) => {
    recordRemedy(st, r, ctx.tick, result)
    log(`[rival-engineers] faction ${ctx.faction.name}: reconciler ${r.kind} ${r.node ?? r.edge}: ${r.why} -> ${result}`)
  })
}

// ---------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------
// D38: temporary factories. Once assemblers can be built and the steam block stands, the faction builds small
// chest-fed assembler cells (generator chest-cell) for the products in `bootstrap-factories` (gears, belts, red packs
// while the labs are hand-fed). The crew fills their input chests and empties their output chests through the bootstrap
// economy (bootstrap.ts `produce`: collect, then feed the cell, then hand-craft what the cell can't make in time). A
// cell is deconstructed once the real factory covers its product: the mall's chest for buildings and intermediates,
// automated science for packs. Its small poles stay (later pole lines may run through them).

/** A temp goal that failed this many plans is not tried again. */
const TEMP_MAX_FAILED = 2


function parseCounts(value: string): { item: string; count: number }[] {
  const out: { item: string; count: number }[] = []
  for (const [item, n] of string.gmatch(value, "([^=,%s]+)%s*=%s*(%d+)")) out.push({ item, count: tonumber(n)! })
  return out
}

/** Whether the real factory makes `item` now: a built mall chest of it, or (packs) automated science. */
function tempCovered(f: FactoryState, item: string): boolean {
  if (LF.packsAutomated(f)[item]) return true
  for (const n of LG.nodesOf(f.graph, "sink")) {
    if (n.lifecycle !== "built" || ST.isTempRole(n.role)) continue
    const m = LO.findModule(f.layout, n.id)
    if (m === undefined) continue
    for (const p of m.def.ports) if (p.kind === "chest-out" && p.item === item) return true
  }
  return false
}

function tempFactories(ctx: Ctx): void {
  const f = ctx.f
  const want = parseCounts(ctx.config.bootstrapFactories)
  if (want.length === 0) return
  f.temp ??= { built: {}, retired: 0 }
  // Retire the cells whose product the real factory covers now.
  for (const n of LG.nodesOf(f.graph, "sink")) if (ST.isTempRole(n.role) && n.lifecycle === "built" && tempCovered(f, n.item!)) retireTemp(ctx, n)
  if (planning(f) !== undefined || activeGoal(f, "temp") !== undefined) return
  if (!GLC.everDone(f.goals, "power")) return
  let failed = 0
  for (const g of f.goals) if (g.kind === "temp" && g.status === "failed") failed++
  if (failed >= TEMP_MAX_FAILED) return
  const machine = ctx.entities.assembler ?? "assembling-machine-1"
  const machineRecipe = ctx.force.recipes[prototypeFacts.recipeForItem(machine) ?? machine]
  if (machineRecipe === undefined || !machineRecipe.enabled) return
  const chest = ctx.entities.chest ?? "iron-chest"
  const nodes: DesignNode[] = []
  for (const w of want) {
    if (tempCovered(f, w.item)) continue
    const recipe = prototypeFacts.recipeForItem(w.item)
    if (recipe === undefined || !ctx.force.recipes[recipe]?.enabled) continue
    for (let k = (f.temp.built[w.item] ?? 0) + 1; k <= w.count; k++) {
      const params = { recipe, machine, chest }
      const def = makeModule("chest-cell", params)
      const cap = LG.rateIn(def.rates.outputs, w.item)
      const inputs = def.rates.inputs.filter((r) => r.item !== "electricity").map((r) => ({ item: r.item, rate: r.perSecond, port: `in-${r.item}` }))
      nodes.push({ role: `${ST.TEMP_PREFIX}${w.item}#${k}`, kind: "sink", generator: "chest-cell", params, def, item: w.item, need: cap, capacity: cap, inputs: inputs as never, powerW: LG.rateIn(def.rates.inputs, "electricity"), cluster: 1 })
    }
  }
  if (nodes.length === 0) return
  for (const n of nodes) {
    const item = n.item
    f.temp.built[item] = (f.temp.built[item] ?? 0) + 1
  }
  log(`[rival-engineers] faction ${ctx.faction.name}: D38 temporary factories: ${nodes.map((n) => n.role).join(", ")}`)
  startGoal(ctx, { kind: "temp", nodes, edges: [], techs: [] })
}

/** D56 / D62: starts a radar goal (the base radar, or an outpost at `site`); returns its id. */
function startRadar(ctx: Ctx, role: string, site?: FactoryGoal["site"]): string {
  const radar = ctx.entities.radar ?? "radar"
  const params = { radar }
  const def = makeModule("radar", params)
  const node: DesignNode = { role, kind: "sink", generator: "radar", params, def, item: radar, need: 0, capacity: 0, inputs: [], powerW: LG.rateIn(def.rates.inputs, "electricity"), cluster: 1 }
  startGoal(ctx, { kind: "radar", nodes: [node], edges: [], techs: [] }, site)
  return `g${ctx.f.nextGoal - 1}`
}

/** Deconstructs a temporary cell (its small poles stay) and drops its node; its layout footprint stays reserved. */
function retireTemp(ctx: Ctx, n: LogicalNode): void {
  const f = ctx.f
  const m = LO.findModule(f.layout, n.id)
  let jobs = 0
  if (m !== undefined) {
    // Exact specs matter when a permanent whole-patch mine overlaps this disposable cell: clearing the rectangle
    // would also destroy the mine's waiting belt ghosts, making the build look complete with a gap in its collector.
    const own = partEntities(f.layout, { modules: [m.id], routes: [], poles: [] }).filter((e) => prototypeFacts.entity(e.name)?.type !== "electric-pole")
    jobs = applyDiff(ctx.surface, ctx.faction, own, [], { priority: ctx.config.factoryBuildPriority }, f.layout).clearJobs.length
  }
  LG.removeNode(f.graph, n.id)
  f.temp!.retired++
  mark(ctx.faction, "temp-retired")
  log(`[rival-engineers] faction ${ctx.faction.name}: D38 temporary factory ${n.role} retired (the factory covers ${n.item}): ${jobs} entities to deconstruct`)
}

// ---------------------------------------------------------------------------------------------------------
// Upkeep: burners the crew keep fuelled (module upkeep.fuel, e.g. burner drills feeding the steam block)

function upkeep(ctx: Ctx): void {
  const f = ctx.f
  const fuel = ctx.faction.brain!.catalog.fuel
  const fuelValue = prototypes.item[fuel]?.fuel_value ?? 0
  if (fuelValue <= 0) return
  for (const id of f.graph.nodeOrder) {
    const n = f.graph.nodes[id]
    // D54: a steam block's boilers are hand-fed whatever feeds them, also while it grows: before electric drills it
    // has no coal belt at all, and later an outage stops the electric coal mine that would refuel it.
    if (n.kind === "power" && n.lifecycle !== "planned") refuelBoilers(ctx, id, fuel)
    if (n.lifecycle !== "built") continue
    const m = LO.findModule(f.layout, id)
    const names = m?.canonical.upkeep?.fuel.map((x) => x.name) ?? []
    if (m === undefined || names.length === 0) continue
    const found = findEntities(ctx.surface, { name: names, force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
    for (const e of found) {
      const inv = e.get_fuel_inventory()
      if (inv === undefined) continue
      const perTick = e.prototype.get_max_energy_usage() ?? 0
      const low = math.max(1, math.ceil((FUEL_MINUTES.low * 3600 * perTick) / fuelValue))
      const have = inv.get_item_count(fuel)
      const key = `upkeep:${e.unit_number}`
      if (have >= low || keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) continue
      const top = math.max(low + 1, math.ceil((FUEL_MINUTES.top * 3600 * perTick) / fuelValue))
      const count = math.min(top - have, prototypes.item[fuel].stack_size)
      LF.addKeyed(ctx, key, { kind: "fuel", pos: e.position, materials: [{ item: fuel, count }], priority: POWER_JOB_PRIORITY, payload: { kind: "fuel", item: fuel, count, target: e, partial: true } })
    }
  }
}

/** D54 (user, 2026-10-19): a boiler whose fuel slot is empty gets a whole stack of fuel by hand. */
export function refuelBoilers(ctx: Pick<Ctx, "faction" | "f" | "surface" | "tick" | "entities">, id: string, fuel: string): void {
  const m = LO.findModule(ctx.f.layout, id)
  if (m === undefined) return
  const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
  const count = prototypes.item[fuel].stack_size
  for (const e of findEntities(ctx.surface, { name: ctx.entities.boiler ?? "boiler", force: ctx.faction.force, area })) {
    const inv = e.get_fuel_inventory()
    if (inv === undefined || inv.get_item_count(fuel) > 0) continue
    const key = `upkeep:${e.unit_number}`
    if (keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) continue
    LF.addKeyed(ctx, key, { kind: "fuel", pos: e.position, materials: [{ item: fuel, count }], priority: POWER_JOB_PRIORITY, payload: { kind: "fuel", item: fuel, count, target: e, partial: true } })
  }
}

// ---------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------
// Stalls (SPEC §3: no planner progress for stall-ticks). Before the bootstrap is done its own check runs.

function checkStall(ctx: Ctx): void {
  const f = ctx.f
  const brain = ctx.faction.brain!
  // Research progress counts as progress (the plan is waiting on it).
  const units = ctx.force.research_progress + (ctx.force.current_research !== undefined ? 0 : 1)
  // Planner work counts too. A chain plan can legitimately run past `stallTicks` (the 26-module g207 robot chain took
  // >15 game-min in a benchmark): while it plans, nothing is placed and `brain.steps` does not move, so the old key read
  // a working planner as a stall, reset the crew and fail-fasted the run on the second one.
  let planWork = 0
  for (const g of f.goals) {
    if (g.status !== "planning" && g.status !== "building") continue
    const entry = g.plan !== undefined ? RT.getPlannerEntry(g.plan) : undefined
    planWork += entry?.job?.stats.work ?? 0
  }
  const key = brain.steps * 1000 + math.floor(units * 100) + math.floor(planWork)
  if (key !== f.progressSteps) {
    f.progressSteps = key
    f.progressTick = ctx.tick
    const last = brain.stalls[brain.stalls.length - 1]
    if (last !== undefined && last.recoveredTick === undefined && brain.done) last.recoveredTick = ctx.tick
    return
  }
  // Nothing left to do by design (final stage built, research goal done): idle, not stalled.
  if (f.idle) f.progressTick = ctx.tick
  if (!brain.done || ctx.tick - f.progressTick < ctx.config.stallTicks) return
  const goals: string[] = []
  for (const g of f.goals) if (g.status === "planning" || g.status === "building") goals.push(`${g.id} ${g.kind} ${g.status} (placed ${g.placed})`)
  const reason = `factory: ${goals.join(", ") || "no active goal"}; waiting: ${f.waiting.join("; ") || brain.waiting.join("; ") || "-"}`
  brain.stalls.push({ tick: ctx.tick, idleFor: ctx.tick - f.progressTick, reason, goal: goals[0] })
  log(`[rival-engineers] faction ${ctx.faction.name}: STALL at tick ${ctx.tick}: ${reason}`)
  recover(ctx)
  f.progressTick = ctx.tick
}

/** Recovery: drop the crew's current work and every non-build job, and re-plan place jobs for leftover ghosts. */
function recover(ctx: Ctx): void {
  const faction = ctx.faction
  for (const id of faction.crew) {
    const m = storage.crew[id]
    if (!m.dead) resetMember(faction, m, ctx.tick)
  }
  for (const id of [...faction.board.active]) {
    const j = faction.board.jobs[id]
    if (j.payload.kind !== "place") failJob(faction.board, id, "replan", ctx.tick)
  }
  ctx.f.jobKeys = {}
  faction.brain!.jobKeys = {}
  for (const g of ctx.f.goals) {
    if (g.status !== "building") continue
    const entry = g.plan !== undefined ? RT.getPlannerEntry(g.plan) : undefined
    const b = entry?.build
    if (b === undefined) continue
    const left: LuaEntity[] = []
    for (const gh of b.ghosts ?? []) if (gh.valid) left.push(gh)
    if (left.length > 0) replanGhosts(ctx, g, b, left, entry!.job?.layout ?? ctx.f.layout)
  }
  faction.brain!.replans++
}

