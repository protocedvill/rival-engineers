import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { Config, getConfig } from "../config"
import { addJob, failJob, getJob, JobSpec } from "../jobs/board"
import { resetMember } from "../jobs/crew"
import { addClearJob, addPlaceJob, clearJobFor, factionForce, factionSurface } from "../jobs/faction"
import { FactionState, JobPayload } from "../jobs/types"
import { curatedModule, generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { BuildParts, EntitySpec, partEntities, partTiles } from "../planner/build-list"
import * as GROW from "../planner/grow"
import { destroyEntity, markDirty, scanChunk, terrainView } from "../planner/terrain"
import { keyX, keyY, Rect, tkey, Vec } from "../planner/grid"
import * as LO from "../planner/layout"
import type { LayoutState, PlacedModule, PlannedPole } from "../planner/layout"
import { preparePlanDelta } from "../planner/plan-delta"
import type { PlanDelta } from "../planner/plan-delta"
import { recordDiagnostic } from "../diagnostic-events"
import * as IDS from "../shared/ids"
import { abandonParts, applyDiff } from "../planner/conflicts"
import { planReroute } from "../planner/reroute"
import { CompareOptions, CompareResult, ConnectionRequest, logisticsFirst, ModuleRequest, PlanEvidence, PlanRequest } from "../planner/plan"
import { sealedInputs } from "../planner/placement"
import { powerRoles } from "../planner/power"
import { claimOreField, claimOwner, foreignEntitiesOn } from "../world/claims"
import { newTerrain } from "../planner/terrain"
import { researchGoal, startResearch } from "./research-queue"
import { newReconcileState, reconcile, ReconcileParams, ReconcileState, recordRemedy, Remedy } from "./reconcile"
import { checkBuild } from "../planner/conflicts"
import { countWork, findEntities } from "../work"
import { registerBuffer } from "../modules/buffers"
import { evictSites, isSitePart, resyncReserved } from "./evict"
import * as FU from "./fuel"
import type { HandoverRecord } from "./handover"
import * as LG from "../planner/logical"
import type { LogicalGraph, LogicalNode } from "../planner/logical"
import * as RT from "../planner/runtime"
import * as ST from "./stage"
import * as MS from "./measure"
import type { MeterState } from "./measure"
import * as DS from "./design"
import type { Design, DesignContext, ModuleKind, DesignEdge, DesignNode, GoalKind, GoalSpec } from "./design"
import { GoalSelectionSpec, GoalSelectionState, selectGoals } from "./goal-selection"
import { nextGoalStatus } from "./goal-lifecycle"
import type { GoalStatus } from "./goal-lifecycle"
import * as REL from "./relocation"
import * as AR from "./adoption-runtime"
import * as EX from "./explore"
export { parseStages } from "./stage"
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
  rounds: number
  lastRound?: number
  /** Clear jobs for trees/rocks found under leftover ghosts, by obstacle position. */
  clearing?: Record<string, IDS.JobId>
  /** Growth goals: the node and units, and their own build (pick up moved entities, then build the new ones). */
  growth?: { node: string; units: number }
  growBuild?: { phase: "clear" | "place" | "done"; clearJobs: IDS.JobId[]; add: EntitySpec[]; ghosts: LuaEntity[]; placeJobs: IDS.JobId[] }
  /** Conflict repairs (M5a.2): reroutes and relocations so far, and a reroute waiting for its pick-ups. */
  repairs?: number
  /** D36 / B2: given up because undergrounds or splitters were worth researching first (planned again after it). */
  deferred?: boolean
  rework?: { clearJobs: IDS.JobId[]; add: EntitySpec[] }
  /** B20: leftover-ghost rounds in a row that placed nothing, and the leftover count of the last round. */
  stuck?: number
  lastLeft?: number
  /** D62: a radar outpost goal: where its radar goes, on which arm, and the strip the crew explores to get there. */
  site?: { x: number; y: number; arm: number; step: number; strip: Rect }
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
  nextGoal: number
  /** Last design (summary for telemetry and stall reports). */
  design?: { cluster1Share?: number; stage: number; nodes: number; edges: number; electricW: number; techs: string[]; errors: string[]; overflow: Record<string, string>; clusters: number; missing: number; grow: number }
  /** Why no goal is being worked on right now. */
  waiting: string[]
  jobKeys: Record<string, number>
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
  /**
   * P36 (b, proposed): items whose new producer could not be placed (`factory-fuel-fallback`): new consumers tap the
   * nearest built producer of it, which grows (stage.ts `fallbackProducers`).
   */
  fallback?: Record<string, boolean>
  /** P36 (a, proposed): steam-block fuel producers replaced because their ore ran low (telemetry). */
  fuelRelocations?: number
  /** D55/P36: roles whose old module is being deconstructed, with the clear jobs a replacement goal waits for. */
  relocation?: Record<string, IDS.JobId[]>
  /** B19: built producers whose routes could not take a tap: new consumers don't share them. */
  noTap?: Record<string, boolean>
  /** D57 (c): ore patches (`patchKey`) a mine found no room on, with the terrain stamp then; skipped until it changes. */
  deadPatches?: Record<string, string>
  /** M6: cluster-1 roles that can't grow far enough → the share of the stage target cluster 1 can still serve. */
  cluster1Caps?: Record<string, number>
  /** M6: failed expansions per role this stage (a grow that keeps failing no longer holds the stage). */
  growFails?: Record<string, number>
  /**
   * B60 provider groups: built providers that cannot expand. The design keeps serving their consumers at the real
   * capacity and assigns the residual to a parallel role; it never relocates them.
   */
  providerShort?: Record<string, boolean>
  /**
   * B61/B60: a shared provider role whose planned site could not reach every consumer. The next design gives each
   * consumer its own parallel provider instead of sharing one infeasible route group.
   */
  providerSplit?: Record<string, boolean>
  /** B61: exact provider→consumer feeds whose route failed; the design reassigns just that consumer. */
  providerNoTap?: Record<string, boolean>
  /**
   * Goalpost 1 (provider handover): providers being retired. Their consumers get a replacement (a parallel role) and
   * the old provider is deconstructed only once that replacement feeds every port it served.
   */
  handover?: Record<string, HandoverRecord>
  /** M5b: measurement state (machines per node, counter ring, edge probes) and the reconciler's state. */
  meter?: MeterState
  reconciler?: ReconcileState
  /**
   * D62: a search for ore past the home zone. `kind` goals wait while an outpost is built (`outpost`) and its radar's
   * nearby square is charted (`scan`), then plan again (`retry`); a plan of that kind ends the search.
   */
  explore?: { resource: string; kind: GoalKind; since: number; phase: "outpost" | "scan" | "retry"; goal?: string; radar?: Vec; scanUntil?: number; outposts: number }
  /** D62: the next arm (N, E, S, W round robin), the outposts built per arm, and their explored strips. */
  arms?: { next: number; steps: number[]; strips: Rect[]; outposts: Vec[] }
  /** P43 (a): chunks the faction's radars scanned (sector scans, and powered outposts' nearby squares), by `tkey`. */
  radarChunks?: Record<number, boolean>
}

/** The only legal status mutation boundary for an existing goal. Constructors set their initial status directly. */
function transitionGoal(g: FactoryGoal, to: GoalStatus): void {
  g.status = nextGoalStatus(g.status, to, g.id)
}

declare global {
  interface RivalEngineersStorage {
    factories?: Record<string, FactoryState>
  }
}

const designCache: Record<string, { key: string; design: Design }> = {}

const UPKEEP_INTERVAL = 300
const FUEL_MINUTES = { low: 2, top: 8 }
const LAB = { low: 2, feed: 5 }
const MAX_PLAN_ATTEMPTS = 4
/** P36 (b): plan attempts a new fuel producer must fail to place before its consumers tap a built one. */
const FUEL_FALLBACK_ATTEMPTS = 2
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

function mark(faction: FactionState, name: string): void {
  const brain = faction.brain
  if (brain === undefined || brain.milestones[name] !== undefined) return
  brain.milestones[name] = game.tick
  log(`[rival-engineers] faction ${faction.name}: milestone ${name} at tick ${game.tick}`)
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
    think(faction, f, config)
  }
}

interface Ctx {
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
  FU.serviceHandovers({ faction, f, config, surface: factionSurface(faction), tick: game.tick })
  if (FU.checkPowerFuel(ctx, planning(f) !== undefined) === undefined) FU.replaceBurnerOutposts({ ...ctx, electricDrill: ctx.entities["electric-drill"] ?? "electric-mining-drill" }, planning(f) !== undefined)
  measureAndReconcile(ctx)
  const d = designNow(ctx)
  tempFactories(ctx)
  const hooks: EX.ExploreHooks = { busy: () => (planning(f) !== undefined ? "the current plan" : !built(f, "power") ? "power" : undefined), startRadar: (role, site) => startRadar(ctx, role, site) }
  EX.baseRadar(ctx, hooks)
  EX.exploreStep(ctx, hooks)
  advanceGoals(ctx, d)
  research(ctx, d)
  handFeed(ctx)
  if (ctx.tick - f.lastUpkeep >= UPKEEP_INTERVAL) {
    f.lastUpkeep = ctx.tick
    upkeep(ctx)
  }
  milestones(ctx)
  ST.sampleScience(ctx, packsAutomated(f), (name) => mark(faction, name))
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
  resources.sort()
  const packs: string[] = []
  for (const [p] of string.gmatch(ctx.config.researchSciencePacks, "[^,%s]+")) packs.push(p)
  const e = ctx.entities
  return {
    facts: prototypeFacts,
    make: makeModule,
    researched,
    enabled: enabledRecipes(ctx.force),
    plannable,
    resources,
    buffer: ctx.config.moduleBuffer,
    fuel: brain.catalog.fuel,
    assembler: e.assembler ?? "assembling-machine-1",
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
    handover: ST.handoverRoles(getFactory(ctx.faction.name)),
    providerShort: ST.providerShort(getFactory(ctx.faction.name)),
    providerCaps: ST.providerCaps(getFactory(ctx.faction.name)),
    powerCap: ST.powerCap(getFactory(ctx.faction.name)),
    cluster1Max: ST.cluster1Max(getFactory(ctx.faction.name)),
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
  let built = 0
  for (const n of LG.nodesOf(f.graph)) if (n.lifecycle === "built") built++
  let taps = 0
  for (const [, list] of pairs(f.taps ?? {})) taps += (list as string[]).length
  let blocked = ""
  for (const [role, n] of pairs(f.growFails ?? {})) if ((n as number) >= ST.GROW_MAX_FAILS) blocked += `${role as string};`
  let noTap = 0
  for (const [,] of pairs(f.noTap ?? {})) noTap++
  let short = ""
  const caps = ST.providerCaps(f)
  for (const [role] of pairs(f.providerShort ?? {})) short += `${role as string}:${string.format("%.6g", caps[role as string] ?? 0)};`
  let split = ""
  for (const [role] of pairs(f.providerSplit ?? {})) split += `${role as string};`
  let providerNoTap = ""
  for (const [key] of pairs(f.providerNoTap ?? {})) providerNoTap += `${key as string};`
  let handover = ""
  for (const [role] of pairs(f.handover ?? {})) handover += `${role as string};`
  const key = `${next(f.fallback ?? {})[0] ?? ""}|${noTap}|${blocked}|${short}|${split}|${providerNoTap}|${handover}|${f.needUndergrounds ?? ""}|${f.needSplitters ?? ""}|${taps}|${ctx.faction.brain!.milestones["automated-science"] !== undefined}|${f.stage}|${targetKey}|${researchedCount}|${f.graph.nodeOrder.length}|${built}|${f.goals.length}|${ctx.faction.brain!.patches.length}`
  const cached = designCache[ctx.faction.name]
  if (cached !== undefined && cached.key === key) return cached.design
  // The mall joins the design once science is automated (the crew hand-craft buildings until then).
  const mallId = ctx.config.factoryMall
  const mall = mallId !== "" && ctx.faction.brain!.milestones["automated-science"] !== undefined ? { id: mallId, utilization: ctx.config.factoryMallUtilization } : undefined
  const dctx = designContext(ctx, stageIndex)
  const d = DS.design(dctx, { item: items[0].item, perSecond: items[0].perSecond, also: items.slice(1), mall })
  const diff = DS.diffDesign(d, f.graph, (node) => LO.findModule(f.layout, node)?.canonical)
  // B60: remember built providers with no expansion unit. The next design keeps their capacity and plans the
  // residual as a parallel provider; it never relocates this one.
  for (const gr of diff.grow) {
    if (gr.units >= 1 || gr.node === undefined) continue
    const node = f.graph.nodes[gr.node]
    if (node === undefined || (node.kind !== "module" && node.kind !== "outpost")) continue
    f.providerShort ??= {}
    if (f.providerShort[gr.role] !== true) {
      f.providerShort[gr.role] = true
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
      for (const n of diff.missing) if (n.kind !== "power" && n.kind !== "labs" && !DS.isPowerRole(n.role)) fresh++
      const saved = diff.missing.length - altDiff.missing.length
      if (fresh > 0 && saved >= ctx.config.logisticsShareMinModules) {
        f.needSplitters = spTech
        log(`[rival-engineers] faction ${ctx.faction.name}: B19 sharing providers saves ${saved} modules: ${spTech} is now a prerequisite of production`)
      }
    }
  }
  const goals = DS.goalsFrom(diff, researched)
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
    out.push({ role: n.role, id: IDS.moduleId(`n${f.graph.nextId++}`), kind: n.kind, generator: n.generator, params: n.params, item: n.item, need: n.need, capacity: n.capacity, inputs: n.inputs, powerW: n.powerW, newSite: n.newSite })
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
  for (const kind of ["power", "labs", "production", "mall", "grow", "repair", "temp", "radar"] as GoalKind[]) {
    active[kind] = activeGoal(f, kind) !== undefined
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
      growth: spec.growth === undefined ? undefined : {
        role: spec.growth.role,
        have: spec.growth.have,
        need: spec.growth.need,
        units: spec.growth.units,
        power: DS.isPowerRole(spec.growth.role),
        failed: f.growFails?.[spec.growth.role] ?? 0,
      },
    })),
    state: {
      active,
      built: completed,
      planning: planning(f) !== undefined,
      powerNodeExists: LG.nodeByRole(f.graph, "power") !== undefined,
      growingPower: DS.isPowerRole(f.graph.nodes[activeGrowth?.growth?.node ?? ""]?.role ?? ""),
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
    if (allBuilt && f.stage + 1 >= stages.length && activeGoal(f, "grow") === undefined && activeGoal(f, "repair") === undefined) f.idle = ST.researchDone(ctx.force)
    if (allBuilt && f.stage + 1 < stages.length) {
      f.stage++
      f.growFails = undefined
      f.providerShort = undefined
      f.providerSplit = undefined
      f.providerNoTap = undefined
      f.cluster1Caps = undefined
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

function startGoal(ctx: Ctx, spec: GoalSpec, site?: FactoryGoal["site"]): boolean {
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
    f.growFails ??= {}
    f.growFails[gr.role] = (f.growFails[gr.role] ?? 0) + 1
    // B60: after its growth attempts are spent, this provider is a fixed-capacity member of its group. The design
    // keeps it and adds a parallel provider for the residual; it is never deconstructed.
    if (f.growFails[gr.role] >= ST.GROW_MAX_FAILS) {
      f.providerShort ??= {}
      if (f.providerShort[gr.role] !== true) {
        f.providerShort[gr.role] = true
        log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} stays at its current capacity; planning a parallel provider`)
      }
    }
    // A cluster-1 module that can't grow caps cluster 1's share (the other clusters make the rest).
    if (f.growFails[gr.role] >= ST.GROW_MAX_FAILS && !DS.isPowerRole(gr.role) && string.find(gr.role, "#", 1, true)[0] === undefined && gr.need > 0) {
      f.cluster1Caps ??= {}
      f.cluster1Caps[gr.role] = math.max(0.05, math.min(1, gr.have / gr.need)) * (f.design?.cluster1Share ?? 1)
      log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} can't grow: production cluster 1 takes at most ${string.format("%.3f", f.cluster1Caps[gr.role])} of the target`)
    }
    log(`[rival-engineers] faction ${ctx.faction.name}: ${gr.role} cannot grow by ${gr.units} units (failure ${f.growFails[gr.role]}): ${plan.reason}`)
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
      ctx.waiting.push(`${gr.role} growth waits for ${other.goal ?? other.id} to finish building (it reroutes ${e.role})`)
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
  for (const e of plan.remove) {
    const found = findEntities(ctx.surface, { name: e.name, position: { x: e.x, y: e.y }, force: ctx.faction.force, limit: 1 })[0]
    if (found !== undefined) clearJobs.push(addClearJob(ctx.faction, found, ctx.config.factoryBuildPriority))
    // B37: an evicted pole line may still be a ghost.
    else for (const gh of findEntities(ctx.surface, { ghost_name: e.name, position: { x: e.x, y: e.y }, force: ctx.faction.force, limit: 1 })) destroyEntity(gh)
  }
  const reserved = ctx.faction.brain!.reserved
  for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) reserved[tkey(x, y)] = true
  claimModuleFields(ctx, m)
  for (const rid of f.layout.routeOrder) if (plan.rerouted.indexOf(f.layout.routes[rid].conn) >= 0) for (const k of f.layout.routes[rid].tiles) reserved[k] = true
  // M6a.2: the tiles the growth gave up (old route tiles, the old footprint's margin) are free again.
  resyncReserved(ctx.faction, f.layout)
  g.growBuild = { phase: "clear", clearJobs, add: plan.add, ghosts: [], placeJobs: [] }
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} grows ${gr.role} by ${gr.units} units: ${plan.remove.length} entities to pick up, ${plan.add.length} to build, rerouted ${plan.rerouted.join(", ")}`)
  return true
}

function updateGrowing(ctx: Ctx, g: FactoryGoal): void {
  const b = g.growBuild!
  const board = ctx.faction.board
  if (b.phase === "clear") {
    for (const id of b.clearJobs) {
      const j = getJob(board, id)
      if (j !== undefined && j.status !== "done" && j.status !== "failed") return
    }
    for (const e of b.add) {
      const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: { x: e.x, y: e.y }, direction: e.dir, force: ctx.faction.force }
      if (e.ioType !== undefined) params.type = e.ioType
      if (e.recipe !== undefined && prototypes.entity[e.name]?.type === "assembling-machine") params.recipe = e.recipe
      const gh = ctx.surface.create_entity(params as never)
      if (gh === undefined) continue
      if (e.buffer) registerBuffer(ctx.surface, ctx.faction.force, gh)
      b.ghosts.push(gh)
      markDirty(ctx.faction.surface, gh.bounding_box.left_top, gh.bounding_box.right_bottom)
      const id = addPlaceJob(ctx.faction, gh, { fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority: ctx.config.factoryBuildPriority })
      if (id !== undefined) b.placeJobs.push(id)
    }
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
  }
  if (open) return
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
        ctx.f.growFails ??= {}
        ctx.f.growFails[node.role] = ST.GROW_MAX_FAILS
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
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} grew ${node?.role} at tick ${ctx.tick}`)
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
  for (const e of g.edges) {
    const from = roleToId(f, g, e.from)
    const to = roleToId(f, g, e.to)
    if (from === undefined || to === undefined) continue
    connections.push({ id: IDS.connectionId(e.role), from: { module: from, port: e.fromPort }, to: { module: to, port: e.toPort }, rate: e.rate, belt: e.belt, merge: e.merge === true })
  }
  // D62: plan regions stay in the home zone, plus the ground explored past it: an outpost's arm strip, or for a goal
  // with a mine every outpost's radar reach and strip.
  const r = math.min(g.radius, EX.homeRadius(ctx))
  const region = EX.planRegion(ctx, g, r)
  // Every goal attempt (and a goal that failed before, retried as a new goal) starts the cluster somewhere else, so a
  // retry is not the same plan again: the hub, then 24 tiles off it in turn (deterministic).
  const tries = g.attempts - 1 + MAX_PLAN_ATTEMPTS * failedBefore(f, g.kind)
  const offsets = [[0, 0], [24, 0], [0, 24], [-24, 0], [0, -24], [24, 24], [-24, -24], [24, -24], [-24, 24]]
  const off = offsets[tries % offsets.length]
  // D62: an outpost's radar goes at its arm target, a little off it on a retry (a cliff or water there).
  const center = g.site !== undefined ? { x: g.site.x + off[0] / 2, y: g.site.y + off[1] / 2 } : { x: f.center.x + off[0], y: f.center.y + off[1] }
  const request: PlanRequest = { modules, connections, center, region, poles: ctx.entities.pole ?? "small-electric-pole" }
  // D57 (c): patches earlier plans' mines found no room on.
  if (f.deadPatches !== undefined) request.deadPatches = { ...f.deadPatches }
  // D38: temporary cells keep TEMP_CLEARANCE tiles off every existing module, so they never box in a port the real
  // factory still has to connect (seed 11: cells next to the labs' pack input made production unroutable).
  if (g.kind === "temp") request.avoid = f.layout.modules.map((m) => ({ x: m.rect.x - TEMP_CLEARANCE, y: m.rect.y - TEMP_CLEARANCE, w: m.rect.w + 2 * TEMP_CLEARANCE, h: m.rect.h + 2 * TEMP_CLEARANCE }))
  const id = `${ctx.faction.name}:${g.id}:${g.attempts}`
  if (RT.getPlannerEntry(id) !== undefined) RT.removePlan(id)
  const maxUnderground = maxUndergroundNow(ctx)
  request.compare = compareOptions(ctx, g, maxUnderground)
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
      for (const other of LG.nodesOf(f.graph)) if (other.item === n.item && !DS.isPowerRole(other.role)) earlier = true
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
    let newNoTap = false
    let newSplit = false
    const roles: Record<string, string> = {}
    for (const n of g.nodes) roles[n.id] = n.role
    for (const [k, v] of pairs(entry.job?.failures ?? {})) {
      const m = string.match(k as string, "^module:(.*)$")[0]
      why.push(`${m !== undefined ? `module ${m} (${roles[m] ?? "?"})` : k}: ${v}`)
      // B60/B61: a new shared provider whose one site cannot reach several consumers. Do not retry the same
      // infeasible route group: mark the role so the next design gives each consumer its own parallel provider.
      for (const e of g.edges) {
        if (e.role !== k) continue
        let outgoing = 0
        for (const other of g.edges) if (other.from === e.from) outgoing++
        if (outgoing < 2) continue
        let provider: string | undefined
        for (const n of g.nodes) if (n.role === e.from) provider = n.id
        if (provider === undefined) continue
        const built = nodeByRoleIn(f, e.from)
        if (built !== undefined && built.lifecycle === "built") continue
        f.providerSplit ??= {}
        if (f.providerSplit[e.from] !== true) {
          f.providerSplit[e.from] = true
          newSplit = true
          log(`[rival-engineers] faction ${ctx.faction.name}: ${e.from} cannot reach every consumer from one site; planning parallel providers per consumer`)
        }
      }
      for (const e of g.edges) {
        if (e.role !== k || nodeByRoleIn(f, e.from) === undefined) continue
        f.providerNoTap ??= {}
        const feed = `${e.from}=>${e.to}.${e.toPort}`
        if (f.providerNoTap[feed] !== true) {
          f.providerNoTap[feed] = true
          newNoTap = true
        }
      }
      // P36 (b): a new fuel producer that found no position twice: new consumers tap a built one instead.
      for (const n of g.nodes) {
        // A route-infeasible provider was explicitly split to escape its old site. Retapping an old provider defeats
        // that remedy and can fail-fast before D62 explores for a genuinely independent patch.
        if (n.id !== m || n.newSite === true || n.item !== ctx.faction.brain!.catalog.fuel || !ctx.config.factoryFuelFallback || g.attempts < FUEL_FALLBACK_ATTEMPTS || f.fallback?.[n.item]) continue
        f.fallback ??= {}
        f.fallback[n.item] = true
        newNoTap = true
        log(`[rival-engineers] faction ${ctx.faction.name}: P36 ${n.role} can't be placed (${v}): new ${n.item} consumers tap a built producer`)
      }
      // B19: a connection from a built producer that failed (its route has no room for a tap): don't tap it again.
      for (const e of g.edges) {
        if (e.role !== k || nodeByRoleIn(f, e.from) === undefined) continue
        f.noTap ??= {}
        if (!f.noTap[e.from]) {
          log(`[rival-engineers] faction ${ctx.faction.name}: ${e.from} is not tapped again (${v})`)
          newNoTap = true
        }
        f.noTap[e.from] = true
      }
    }
    if (contest !== undefined) why.push(contest)
    g.reason = why.join("; ")
    if (newNoTap || newSplit) {
      // Planned again at once without that tap / with one provider per consumer.
      RT.removePlan(entry.id)
      transitionGoal(g, "failed")
      g.deferred = true
      g.reason = `${newSplit ? "replan with parallel providers" : "replan without taps"} for ${g.reason}`
      return
    }
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} plan failed (attempt ${g.attempts}): ${g.reason}`)
    // With frame dumps on (soaks), keep the failed layout for tools/render (--graph over the nearest frame).
    // The plan's input too (for a T1 replay: mod/unit/fixtures).
    if (ctx.config.frameDumpIntervalTicks > 0) {
      const name = `rival-engineers/failed-plans/${ctx.faction.name}/${g.id}-a${g.attempts}-t${ctx.tick}`
      RT.exportGraph(entry, `${name}.graph.json`)
      RT.exportPlanInput(entry, `${name}.input.lua`)
    }
    RT.removePlan(entry.id)
    // B57: a built module's open input proved walled in: no plan can feed it, so it moves and the goal plans again.
    const moved = contest === undefined ? relocateSealed(ctx, g, entry.job?.evidence ?? []) : undefined
    if (moved !== undefined) {
      transitionGoal(g, "failed")
      g.deferred = true
      g.reason = `replan after relocating ${moved}: ${g.reason}`
      return
    }
    // D62: no free patch of an ore anywhere the faction knows: explore past the home zone with a radar outpost (on
    // the last attempt, or at once while a search is on: the region already holds everything explored).
    let [ore] = contest === undefined && g.site === undefined ? string.match(g.reason ?? "", "no free (%S+) patch in the region") : [undefined]
    // A mine can also fail with "no feasible position (N of N patches tried)" when every known patch exists but has no
    // room. That is the same need for farther ground; without this, the factory retries the same patches to fail-fast.
    if (ore === undefined && contest === undefined && g.site === undefined) {
      const failed = EX.failedMineOre(g.reason)
      if (failed !== undefined && prototypes.entity[failed]?.type === "resource") ore = failed
    }
    if (ore !== undefined && (g.attempts >= MAX_PLAN_ATTEMPTS || f.explore !== undefined)) {
      transitionGoal(g, "failed")
      EX.exploreFor(ctx, g, ore)
      return
    }
    if (g.attempts >= MAX_PLAN_ATTEMPTS) {
      transitionGoal(g, "failed")
      // B53 (user, 2026-10-20): no site in the region (e.g. no shore for a steam block) stays true for a while: goals of
      // this kind wait `factory-site-retry-minutes` instead of planning again at once, forever.
      if (string.find(g.reason ?? "", "no %S+ site in the region")[0] !== undefined && ctx.config.factorySiteRetryMinutes > 0) {
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
  }, f.layout)
  if (prepared.status === "rejected") {
    const decision = prepared.code === "stale-base-revision" ? "stale-plan-rejected" : "invalid-plan-delta"
    recordDiagnostic(ctx.faction, { tick: ctx.tick, kind: "planner", goal: g.id, plan: entry.id, decision, reason: prepared.detail })
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
export function dropPlannedPoles(layout: LayoutState, parts: BuildParts | undefined, gone: Record<string, boolean>): number {
  const drop: Record<string, boolean> = {}
  const kept: PlannedPole[] = []
  for (const p of layout.poles ?? []) {
    if (!gone[`${p.name}@${p.x},${p.y}`]) {
      kept.push(p)
      continue
    }
    drop[p.id] = true
    LO.releasePoleTile(layout, tkey(p.x, p.y), p.line)
  }
  const n = (layout.poles?.length ?? 0) - kept.length
  if (n === 0) return 0
  layout.poles = kept
  if (parts !== undefined) parts.poles = parts.poles.filter((id) => !drop[id])
  LO.bumpLayout(layout)
  return n
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
  if (ctx.config.frameDumpIntervalTicks > 0) RT.exportPlanInput(entry, `rival-engineers/plans/${ctx.faction.name}/${g.id}-a${g.attempts}-t${ctx.tick}.input.lua`)
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
  // B37: pole lines the plan's modules and routes took are picked up first (ghosts cancelled); the plan's pole step
  // joined what they powered again. A pole the new lines place at the same spot stays.
  const relaid: Record<string, boolean> = {}
  for (const p of layout.poles ?? []) relaid[`${p.name}@${p.x},${p.y}`] = true
  const queued: Record<number, boolean> = {}
  for (const e of evicted) if (e.valid && e.unit_number !== undefined) queued[e.unit_number] = true
  for (const p of layout.evictedPoles ?? []) {
    if (relaid[`${p.name}@${p.x},${p.y}`]) continue
    const at = { x: p.x + 0.5, y: p.y + 0.5 }
    const built = findEntities(ctx.surface, { name: p.name, position: at, force: ctx.faction.force, limit: 1 })[0]
    if (built !== undefined && !queued[built.unit_number!]) {
      queued[built.unit_number!] = true
      evicted.push(built)
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
    const n = dropPlannedPoles(oe.job.layout, oe.build?.parts, gone)
    if (n > 0) log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} evicts ${n} poles goal ${other.id} has not built yet (B46)`)
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
  const b = entry.build ?? RT.startBuild(entry, { fuel: { item: fuel, count: 5 }, priority: ctx.config.factoryBuildPriority, parts, clear: evicted })
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
    for (const s of add) {
      const px = math.floor(s.x)
      const py = math.floor(s.y)
      for (const e of findEntities(ctx.surface, { type: ["electric-pole", "transport-belt", "underground-belt"], force: ctx.faction.force, area: { left_top: { x: px + 0.05, y: py + 0.05 }, right_bottom: { x: px + 0.95, y: py + 0.95 } }, limit: 4 })) {
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
  transitionGoal(g, "building")
  if (f.adoption === intent) f.adoption = undefined
  g.plannedTick = ctx.tick
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
  const roles = powerRoles(f.layout, prototypeFacts)
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
  // Progress: place jobs done since the last look.
  let done = 0
  for (const id of b.placeJobs) if (getJob(ctx.faction.board, id)?.status === "done") done++
  if (done > g.placed) {
    ctx.faction.brain!.steps += done - g.placed
    g.placed = done
  }
  if (g.rework !== undefined && !rework(ctx, g, b)) return
  if (b.phase !== "done") return
  // Every job finished: ghosts left over (failed jobs, a replan dropping jobs) get new place jobs.
  const left: LuaEntity[] = []
  for (const gh of b.ghosts ?? []) if (gh.valid) left.push(gh)
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

function reroute(ctx: Ctx, g: FactoryGoal, entry: Entry, routes: IDS.RouteId[]): boolean {
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
  const plan = planReroute(f.layout, RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t)), prototypeFacts, RT.entryPolicy(entry), all[0], routes, region)
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
  const d = applyDiff(ctx.surface, ctx.faction, plan.remove, [], { priority: b.priority })
  g.rework = { clearJobs: d.clearJobs, add: plan.add }
  b.ghosts = (b.ghosts ?? []).filter((gh) => gh.valid)
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} rerouted ${routes.join(", ")}: ${plan.remove.length} entities to pick up, ${plan.add.length} to build`)
  rework(ctx, g, b)
  return true
}

/** A reroute's second phase: once its pick-ups are done, its new ghosts and place jobs. Returns whether it is done. */
function rework(ctx: Ctx, g: FactoryGoal, b: NonNullable<Entry["build"]>): boolean {
  const w = g.rework!
  for (const id of w.clearJobs) {
    const j = getJob(ctx.faction.board, id)
    if (j !== undefined && j.status !== "done" && j.status !== "failed") return false
  }
  const d = applyDiff(ctx.surface, ctx.faction, [], w.add, { fuel: b.fuel, priority: b.priority })
  for (const gh of d.ghosts) b.ghosts!.push(gh)
  for (const id of d.placeJobs) b.placeJobs.push(id)
  if (d.failed.length > 0) log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id}: ${d.failed.length} rerouted ghosts could not be created: ${d.failed.slice(0, 4).join("; ")}`)
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
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) gives up its location: ${r.clearJobs.length} built entities to deconstruct, ${r.routes.length} routes dropped; the design plans it again elsewhere`)
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
    // blocks the placement for good: clear it again.
    if (!gh.valid) continue
    const box = gh.bounding_box
    const area = { left_top: { x: box.left_top.x + 0.05, y: box.left_top.y + 0.05 }, right_bottom: { x: box.right_bottom.x - 0.05, y: box.right_bottom.y - 0.05 } }
    for (const e of findEntities(ctx.surface, { area, type: ["tree", "simple-entity"] })) {
      const k = `${e.position.x},${e.position.y}`
      g.clearing ??= {}
      const old = g.clearing[k]
      const j = old !== undefined ? getJob(faction.board, old) : undefined
      if (j !== undefined && j.status !== "done" && j.status !== "failed") continue
      g.clearing[k] = addClearJob(faction, e, b!.priority)
      log(`[rival-engineers] faction ${faction.name}: goal ${g.id}: clearing ${e.name} at ${k} under a leftover ${gh.ghost_name} ghost${j !== undefined ? ` (last clear job ${j.status}: ${j.reason ?? "?"})` : ""}`)
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
    f.reconciler ??= newReconcileState()
    // D49: labs are hand-fed by the crew until a built producer belts their pack in.
    const crewSupplied = (n: LogicalNode, item: string): boolean => {
      if (n.kind !== "labs") return false
      for (const e of LG.edgesInto(f.graph, n.id)) if (e.kind === "belt" && e.item === item && e.from !== undefined && f.graph.nodes[e.from]?.lifecycle === "built") return false
      return true
    }
    const r = reconcile(f.graph, f.reconciler, { tick: ctx.tick, params: reconcileParams(ctx.config), isFuel, crewSupplied })
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
  if (escape <= 0) return undefined
  const view = RT.claimView(ctx.faction.name, ctx.faction.surface, terrainView(t))
  for (const ev of evidence) {
    if (ev.kind !== "route" || ev.sealed === undefined || ev.sealed.side !== "goal") continue
    const id = ev.sealed.port.module
    const n = f.graph.nodes[id]
    if (n === undefined || LO.findModule(f.layout, id) === undefined) continue
    if (sealedInputs(f.layout, view, id, {}, escape).indexOf(ev.sealed.port.port) < 0) continue
    let busy: string | undefined
    for (const o of f.goals) {
      if (o === g || (o.status !== "building" && o.status !== "planning")) continue
      for (const e of o.edges) if (e.from === n.role || e.to === n.role) busy = o.id
    }
    if (busy !== undefined) {
      log(`[rival-engineers] faction ${ctx.faction.name}: B57 ${n.role} (${id}) has its ${ev.sealed.port.port} lane walled in; relocation waits for goal ${busy}`)
      continue
    }
    FU.relocate(ctx, n, `B57 ${n.role}`, `has its ${ev.sealed.port.port} lane walled in (goal ${g.id}: ${ev.subject})`)
    return n.role
  }
  // B61 (2229258): a route can fail from the start side while its goal module's input lane is also sealed. The seal
  // evidence may name the start, so the B57 loop above never sees the real walled-in consumer. Inspect the goal module of
  // every failed route, and relocate that consumer when its own input lane cannot lead out.
  for (const ev of evidence) {
    if (ev.kind !== "route") continue
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
  // Goalpost 1: nothing is deconstructed here. The provider is marked as retiring and the design plans a replacement
  // for its consumers; `serviceHandovers` retires it once that replacement is built and feeds every port.
  FU.beginHandover(ctx, n, `D55 ${n.role}`, `is worked out (${why})`)
  say("handing over: the replacement is connected before deconstruction (D55)")
}

function applyRemedy(ctx: Ctx, r: Remedy): void {
  const f = ctx.f
  const st = f.reconciler!
  const say = (result: string): void => {
    recordRemedy(st, r, ctx.tick, result)
    log(`[rival-engineers] faction ${ctx.faction.name}: reconciler ${r.kind} ${r.node ?? r.edge}: ${r.why} -> ${result}`)
  }
  if (r.kind === "upkeep") {
    f.lastUpkeep = -math.huge
    upkeep(ctx)
    f.lastUpkeep = ctx.tick
    say("upkeep pass")
    return
  }
  // B60 group remedy: a shared trunk at capacity. The provider keeps every consumer it serves; the design caps it at
  // its real capacity and gives the residual demand a parallel role (with merge side-loads), instead of asking this
  // one to grow into a belt that is already full.
  if (r.kind === "parallel") {
    const n = f.graph.nodes[r.node!]
    if (n === undefined) {
      say("cannot split: the node left the graph")
      return
    }
    f.providerShort ??= {}
    if (f.providerShort[n.role] === true) {
      say("group remedy: already split")
      return
    }
    f.providerShort[n.role] = true
    say(`group remedy: ${n.role} keeps its consumers and the rest go to a parallel provider`)
    return
  }
  if (r.kind === "grow") {
    // A plan in flight works on a copy of the layout and replaces it when adopted: normally grow after it. But a
    // depletion (key `deplete:`) must expand now — the worked-out outpost is starving the line — so it is only blocked
    // by a growth of the SAME node (D52: a depleted outpost expands even while other goals plan or grow).
    const busyGrow = activeGoal(f, "grow")
    const blockedByPlan = planning(f) !== undefined && !r.key.startsWith("deplete:")
    if (blockedByPlan || (busyGrow !== undefined && busyGrow.growth?.node === r.node)) return
    const n = f.graph.nodes[r.node!]
    const m = n !== undefined ? LO.findModule(f.layout, n.id) : undefined
    // D55 (user, 2026-10-20): a worked-out mine that can't expand in place (a completed whole-patch mine, or a partial one
    // with no `expand`) first moves to the next free part of its own patch; with nothing better left there, it is given
    // up and planned again elsewhere.
    if (r.key.startsWith("deplete:") && n !== undefined && m !== undefined && (m.minePlan?.complete === true || (m.minePlan !== undefined && m.canonical.expand === undefined))) {
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
    if (n === undefined || m === undefined) {
      say("cannot grow: no expandable module")
      return
    }
    if (m.canonical.expand === undefined) {
      // D55: a depleted mine with neither an in-place `expand` nor a whole-patch plan (a shared mine) is given up and
      // planned again elsewhere. Without this it repeats "cannot grow" every check while its consumers starve
      // (B59, seed 3333: n39, logistic science).
      if (r.key.startsWith("deplete:")) {
        relocateDepleted(ctx, n, ctx.waiting[ctx.waiting.length - 1] ?? "its ore is used up", say)
        return
      }
      say("cannot grow: no expandable module")
      return
    }
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
        if (r.key.startsWith("deplete:")) relocateDepleted(ctx, n, "no ore in its growth area", say)
        else say("cannot grow: no ore in the growth area")
        return
      }
    }
    if (units < 1) { say("cannot grow: at its expansion limit"); return }
    const before = f.goals.length
    const failsBefore = f.growFails?.[n.role] ?? 0
    const ok = startGrow(ctx, { kind: "grow", nodes: [], edges: [], techs: [], growth: { role: n.role, node: n.id, units, need: have, have } })
    // B52: waiting for a goal still building is no attempt (it doesn't use up the remedy's tries).
    if (ok === "wait") return
    say(ok === true && f.goals.length > before ? `goal ${f.goals[f.goals.length - 1].id} grows it by ${units} unit(s)` : `grow failed: ${ctx.waiting[ctx.waiting.length - 1] ?? "?"}`)
    // B52: the remedy's tries (earlier successful growths count) can run out before GROW_MAX_FAILS expansion failures:
    // its last failed try marks the growth blocked, so the design's fallback (a second steam block, other producers)
    // takes over instead of nothing.
    const fails = f.growFails?.[n.role] ?? 0
    if (ok === false && fails > failsBefore && fails < ST.GROW_MAX_FAILS && (st.remedies[r.key]?.count ?? 0) >= ctx.config.reconcileMaxRemedies) {
      f.growFails![n.role] = ST.GROW_MAX_FAILS
      log(`[rival-engineers] faction ${ctx.faction.name}: ${n.role} growth blocked: the reconciler's ${ctx.config.reconcileMaxRemedies} tries are used up (${fails} expansion failures)`)
    }
    return
  }
  // Repair: re-place the missing pieces of the edge's route (belt) or pole lines (power).
  const e = f.graph.edges[r.edge!]
  if (e === undefined) return
  const parts: BuildParts = { modules: [], routes: [], poles: [] }
  if (e.kind === "power") {
    for (const p of f.layout.poles ?? []) if (e.physical.indexOf(p.line) >= 0) parts.poles.push(p.id)
  } else for (const rid of e.physical) if (f.layout.routes[rid] !== undefined) parts.routes.push(IDS.routeId(rid))
  const check = checkBuild(ctx.surface, ctx.faction.force, f.layout, parts)
  if (e.kind === "power") {
    // B47: built modules' own poles carry the network too (a completed mine's poles linked two new modules): missing
    // ones are re-placed like line poles. Never their machines (D49).
    const built: BuildParts = { modules: [], routes: [], poles: [] }
    for (const n of LG.nodesOf(f.graph)) if (n.lifecycle === "built" && LO.findModule(f.layout, n.id) !== undefined) built.modules.push(n.id)
    const own = checkBuild(ctx.surface, ctx.faction.force, f.layout, built, (s) => prototypes.entity[s.name]?.type === "electric-pole")
    for (const s of own.missing) check.missing.push(s)
  }
  if (check.missing.length === 0 && check.misdirected.length === 0 && check.stale.length === 0) {
    say(check.conflicts.length > 0 ? `blocked: ${check.conflicts[0].blocker}` : "nothing missing")
    return
  }
  // B52: a belt facing the wrong way is picked up first, then placed as planned (a ghost on the live one never revives).
  // B56: so are the faction's own stale belt pieces standing where a missing route piece goes.
  const clearJobs: IDS.JobId[] = []
  for (const w of check.misdirected) clearJobs.push(addClearJob(ctx.faction, w.entity, ctx.config.factoryBuildPriority))
  for (const s of check.stale) for (const e of s.entities) if (clearJobFor(ctx.faction, e) === undefined) clearJobs.push(addClearJob(ctx.faction, e, ctx.config.factoryBuildPriority))
  const d = applyDiff(ctx.surface, ctx.faction, [], check.missing, { fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority: ctx.config.factoryBuildPriority })
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
    growBuild: { phase: clearJobs.length > 0 ? "clear" : "place", clearJobs, add: [...check.misdirected.map((w) => w.spec), ...check.stale.map((s) => s.spec)], ghosts: d.ghosts, placeJobs: d.placeJobs },
  }
  f.goals.push(g)
  let turned = check.misdirected.length > 0 ? `, turns ${check.misdirected.length} facing the wrong way (first ${check.misdirected[0].spec.name} at ${check.misdirected[0].spec.x},${check.misdirected[0].spec.y})` : ""
  if (check.stale.length > 0) turned += `, picks up stale belts under ${check.stale.length} (first ${check.stale[0].spec.name} at ${check.stale[0].spec.x},${check.stale[0].spec.y} over ${check.stale[0].entities[0].name})`
  say(`goal ${g.id} re-places ${check.missing.length} entities${turned}${d.failed.length > 0 ? ` (${d.failed.length} ghosts failed)` : ""}`)
}

// ---------------------------------------------------------------------------------------------------------
// Research and hand-fed labs

function packsAutomated(f: FactoryState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const n of LG.nodesOf(f.graph)) if (n.lifecycle === "built" && n.kind === "module" && n.item !== undefined && edgesToLabs(f, n.id)) out[n.item] = true
  return out
}

function edgesToLabs(f: FactoryState, node: string): boolean {
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.from === node && f.graph.nodes[e.to]?.kind === "labs") return true
  }
  return false
}

function labsBuilt(f: FactoryState): LogicalNode[] {
  return LG.nodesOf(f.graph, "labs").filter((n) => n.lifecycle === "built")
}

/** Packs the labs get: automated ones, plus hand-fed (craftable) ones while hand-feeding is on. */
function packsAvailable(ctx: Ctx): Record<string, boolean> {
  const out = packsAutomated(ctx.f)
  if (ctx.config.factoryHandFeedLabs && labsBuilt(ctx.f).length > 0) {
    for (const [p] of string.gmatch(ctx.config.researchSciencePacks, "[^,%s]+")) {
      const r = ctx.force.recipes[prototypeFacts.recipeForItem(p) ?? p]
      if (r !== undefined && r.enabled) out[p] = true
    }
  }
  return out
}

function research(ctx: Ctx, d: Design | undefined): void {
  const f = ctx.f
  const cur = ctx.force.current_research
  f.research.current = cur?.name
  if (cur !== undefined) return
  if (labsBuilt(f).length === 0) return
  const wanted = d?.techs ?? []
  const pick = startResearch(ctx.force, wanted, packsAvailable(ctx), packsAutomated(f), ctx.config.debugInfiniteResearch)
  if (pick !== undefined) {
    f.research.current = pick.tech
    f.research.reason = pick.reason
    f.research.started[pick.tech] ??= `${ctx.tick}: ${pick.reason}`
    log(`[rival-engineers] faction ${ctx.faction.name}: research ${pick.tech} (${pick.reason})`)
  } else ctx.waiting.push("no researchable technology")
}

function labEntities(ctx: Ctx, node: LogicalNode): LuaEntity[] {
  const m = LO.findModule(ctx.f.layout, node.id)
  if (m === undefined) return []
  return findEntities(ctx.surface, { type: "lab", force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
}

function keyActive(ctx: Pick<Ctx, "faction" | "f">, key: string): boolean {
  const id = ctx.f.jobKeys[key]
  if (id === undefined) return false
  const job = ctx.faction.board.jobs[id]
  if (job !== undefined && (job.status === "open" || job.status === "claimed")) return true
  delete ctx.f.jobKeys[key]
  return false
}

function addKeyed(ctx: Pick<Ctx, "faction" | "f" | "tick">, key: string, spec: JobSpec<JobPayload>): void {
  const job = addJob(ctx.faction.board, spec, ctx.tick)
  ctx.f.jobKeys[key] = job.id
}

/** Until a pack is automated, the crew hand-craft it and put it into the labs (the bootstrap crafts the materials). */
function handFeed(ctx: Ctx): void {
  const f = ctx.f
  const cur = ctx.force.current_research
  const automated = packsAutomated(f)
  // Hand-feeding serves research that unblocks the factory's goals (the research goal waits for automated packs).
  const on = ctx.config.factoryHandFeedLabs && cur !== undefined && (f.research.reason ?? "").startsWith("unblocks")
  for (const node of labsBuilt(f)) {
    for (const lab of labEntities(ctx, node)) {
      const inv = lab.get_inventory(defines.inventory.lab_input)
      if (inv === undefined) continue
      for (const ing of cur?.research_unit_ingredients ?? []) {
        const key = `labfeed:${lab.unit_number}:${ing.name}`
        if (!on || automated[ing.name]) {
          // Automated now: drop open hand-feeding jobs.
          const id = f.jobKeys[key]
          const job = id !== undefined ? ctx.faction.board.jobs[id] : undefined
          if (job !== undefined && job.status === "open") failJob(ctx.faction.board, id!, "automated", ctx.tick)
          continue
        }
        if (inv.get_item_count(ing.name) >= LAB.low || keyActive(ctx, key)) continue
        addKeyed(ctx, key, {
          kind: "fuel",
          pos: lab.position,
          materials: [{ item: ing.name, count: LAB.feed }],
          priority: 95,
          payload: { kind: "fuel", item: ing.name, count: LAB.feed, target: lab, partial: true },
        })
      }
    }
  }
}


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
  if (packsAutomated(f)[item]) return true
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
  if (!built(f, "power")) return
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
    jobs = applyDiff(ctx.surface, ctx.faction, own, [], { priority: ctx.config.factoryBuildPriority }).clearJobs.length
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
      if (have >= low || keyActive(ctx, key)) continue
      const top = math.max(low + 1, math.ceil((FUEL_MINUTES.top * 3600 * perTick) / fuelValue))
      const count = math.min(top - have, prototypes.item[fuel].stack_size)
      addKeyed(ctx, key, { kind: "fuel", pos: e.position, materials: [{ item: fuel, count }], priority: 100, payload: { kind: "fuel", item: fuel, count, target: e, partial: true } })
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
    if (keyActive(ctx, key)) continue
    addKeyed(ctx, key, { kind: "fuel", pos: e.position, materials: [{ item: fuel, count }], priority: 100, payload: { kind: "fuel", item: fuel, count, target: e, partial: true } })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Milestones

function moduleEntities(ctx: Ctx, node: LogicalNode, type: string): LuaEntity[] {
  const m = LO.findModule(ctx.f.layout, node.id)
  if (m === undefined) return []
  return findEntities(ctx.surface, { type, force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
}

/** Research units done: progress of the current technology plus whole technologies finished since the last look. */
function researchUnits(ctx: Ctx, v: NonNullable<FactoryState["verify"]>): void {
  const cur = ctx.force.current_research
  const name = cur?.name
  const progress = ctx.force.research_progress
  if (name !== v.tech) {
    if (v.tech !== undefined) {
      const prev = ctx.force.technologies[v.tech]
      if (prev !== undefined && prev.researched) v.units += (1 - v.progress) * prev.research_unit_count
    }
    v.tech = name
    v.progress = progress
    return
  }
  if (cur !== undefined && progress > v.progress) {
    v.units += (progress - v.progress) * cur.research_unit_count
    v.progress = progress
  }
}

function milestones(ctx: Ctx): void {
  const f = ctx.f
  const faction = ctx.faction
  const brain = faction.brain!
  // First power: a lab or other machine of a built node draws energy.
  if (brain.milestones["first-power"] === undefined) {
    for (const node of labsBuilt(f)) for (const lab of labEntities(ctx, node)) if (lab.energy > 0) mark(faction, "first-power")
  }
  // Automated science: after hand-feeding stopped (the pack's producer is built), the labs did more research units
  // than the packs left in them, while the producer made packs.
  const automated = packsAutomated(f)
  let producer: LogicalNode | undefined
  for (const n of LG.nodesOf(f.graph)) if (n.lifecycle === "built" && n.kind === "module" && n.item !== undefined && automated[n.item]) producer = n
  if (producer === undefined || brain.milestones["automated-science"] !== undefined) return
  if (f.verify === undefined) {
    let leftover = 0
    for (const node of labsBuilt(f)) for (const lab of labEntities(ctx, node)) leftover += lab.get_inventory(defines.inventory.lab_input)?.get_item_count(producer.item!) ?? 0
    f.verify = { tick: ctx.tick, leftover, units: 0, tech: ctx.force.current_research?.name, progress: ctx.force.research_progress, made: 0 }
    log(`[rival-engineers] faction ${faction.name}: ${producer.item} automated (node ${producer.id}); verifying with ${leftover} hand-fed packs left in the labs`)
    return
  }
  const v = f.verify
  researchUnits(ctx, v)
  let made = 0
  for (const a of moduleEntities(ctx, producer, "assembling-machine")) if (a.get_recipe()[0]?.name === producer.recipe) made += a.products_finished
  v.made = made
  if (v.units > v.leftover + 5 && made >= 10) {
    mark(faction, "automated-science")
    mark(faction, `automated:${producer.item}`)
    if (producer.item === "automation-science-pack") mark(faction, "automated-red-science")
  }
}

// ---------------------------------------------------------------------------------------------------------
// Stalls (SPEC §3: no planner progress for stall-ticks). Before the bootstrap is done its own check runs.

function checkStall(ctx: Ctx): void {
  const f = ctx.f
  const brain = ctx.faction.brain!
  // Research progress counts as progress (the plan is waiting on it).
  const units = ctx.force.research_progress + (ctx.force.current_research !== undefined ? 0 : 1)
  const key = brain.steps * 1000 + math.floor(units * 100)
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

