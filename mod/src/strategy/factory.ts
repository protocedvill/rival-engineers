import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { Config, getConfig } from "../config"
import { addJob, failJob, getJob, JobSpec } from "../jobs/board"
import { resetMember } from "../jobs/crew"
import { addClearJob, addPlaceJob, factionForce, factionSurface } from "../jobs/faction"
import { FactionState, JobPayload } from "../jobs/types"
import { curatedModule, generatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { BuildParts, EntitySpec, partTiles } from "../planner/build-list"
import { planGrowth } from "../planner/grow"
import { markDirty, terrainView } from "../planner/terrain"
import { buildGraph, FactoryGraph } from "../planner/graph"
import { Rect, tkey, Vec } from "../planner/grid"
import { findModule, LayoutState, newLayout } from "../planner/layout"
import { addEdge, addNode, edgeByRole, LogicalGraph, LogicalNode, newGraph, nodeByRole, nodesOf } from "../planner/logical"
import { ConnectionRequest, ModuleRequest, PlanRequest } from "../planner/plan"
import { powerRoles } from "../planner/power"
import { entryPolicy, getPlannerEntry, removePlan, startBuild, startPlan, tiers } from "../planner/runtime"
import { newTerrain } from "../planner/terrain"
import { Design, design, DesignContext, ModuleKind, DesignEdge, DesignNode, diffDesign, GoalKind, goalsFrom, GoalSpec } from "./design"
import { meanUnitTime, researchGoal, startResearch } from "./research-queue"

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

export type GoalStatus = "planning" | "building" | "done" | "failed"

/** A design node a goal builds, as plain data (the module is regenerated from generator + params). */
export interface GoalNode {
  role: string
  /** Graph node id = module instance id. */
  id: string
  kind: DesignNode["kind"]
  generator: ModuleKind
  params: Record<string, unknown>
  item: string
  need: number
  capacity: number
  inputs: DesignNode["inputs"]
  powerW: number
}

export interface FactoryGoal {
  id: string
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
  /** Growth goals: the node and units, and their own build (pick up moved entities, then build the new ones). */
  growth?: { node: string; units: number }
  growBuild?: { phase: "clear" | "place" | "done"; clearJobs: number[]; add: EntitySpec[]; ghosts: LuaEntity[]; placeJobs: number[] }
}

export interface FactoryState {
  faction: string
  terrain: string
  center: Vec
  layout: LayoutState
  graph: LogicalGraph
  stage: number
  goals: FactoryGoal[]
  nextGoal: number
  /** Last design (summary for telemetry and stall reports). */
  design?: { stage: number; nodes: number; edges: number; electricW: number; techs: string[]; errors: string[]; overflow: Record<string, string>; clusters: number; missing: number; grow: number }
  /** Why no goal is being worked on right now. */
  waiting: string[]
  jobKeys: Record<string, number>
  research: { current?: string; reason?: string; started: Record<string, string> }
  /** Automated science check: research units done since hand-feeding stopped, and what was left in the labs then. */
  verify?: { tick: number; leftover: number; units: number; tech?: string; progress: number; made: number }
  progressSteps: number
  progressTick: number
  lastUpkeep: number
}

declare global {
  interface RivalEngineersStorage {
    factories?: Record<string, FactoryState>
  }
}

const designCache: Record<string, { key: string; design: Design }> = {}

const UPKEEP_INTERVAL = 300
const FUEL_LOW_MINUTES = 2
const FUEL_TOP_MINUTES = 8
const LAB_LOW = 2
const LAB_FEED = 5
const MAX_PLAN_ATTEMPTS = 4
const MAX_BUILD_ROUNDS = 30

// ---------------------------------------------------------------------------------------------------------
// Setup

function parsePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of string.gmatch(value, "([^=,;%s]+)%s*=%s*([^,;%s]+)")) out[k] = v
  return out
}

/** Stages of `factory-targets`: per stage, item → packs per minute. */
export function parseStages(value: string): { item: string; perMinute: number }[][] {
  const stages: { item: string; perMinute: number }[][] = []
  for (const [part] of string.gmatch(value, "[^;]+")) {
    const stage: { item: string; perMinute: number }[] = []
    for (const [item, n] of string.gmatch(part, "([^=,%s]+)%s*=%s*([%d%.]+)")) stage.push({ item, perMinute: tonumber(n)! })
    if (stage.length > 0) stages.push(stage)
  }
  return stages
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
    layout: newLayout(),
    graph: newGraph(),
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
  const d = designNow(ctx)
  advanceGoals(ctx, d)
  research(ctx, d)
  handFeed(ctx)
  if (ctx.tick - f.lastUpkeep >= UPKEEP_INTERVAL) {
    f.lastUpkeep = ctx.tick
    upkeep(ctx)
  }
  milestones(ctx)
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

export function designContext(ctx: { faction: FactionState; force: LuaForce; config: Config; entities: Record<string, string> }): DesignContext {
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
    fuel: brain.catalog.fuel,
    assembler: e.assembler ?? "assembling-machine-1",
    furnace: brain.catalog.furnace,
    electricDrill: e["electric-drill"] ?? "electric-mining-drill",
    burnerDrill: brain.catalog.drill,
    lab: e.lab ?? "lab",
    boiler: e.boiler ?? "boiler",
    engine: e.engine ?? "steam-engine",
    packs,
    researchUnitTime: ctx.config.factoryResearchUnitTime > 0 ? ctx.config.factoryResearchUnitTime : meanUnitTime(),
    tiers: tiers(),
    policy: policyFor(ctx.config),
  }
}

function policyFor(config: Config) {
  // The same policy the planner entries use (config overrides applied).
  return entryPolicy({ request: { modules: [], connections: [], center: { x: 0, y: 0 }, region: { x: 0, y: 0, w: 0, h: 0 } }, policy: config.layoutPolicy } as never)
}

/** The design of the current stage (v1: one pack item per stage drives the lab sink). */
function designNow(ctx: Ctx): Design | undefined {
  const f = ctx.f
  const stages = parseStages(ctx.config.factoryTargets)
  const stage = stages[math.min(f.stage, stages.length - 1)]
  if (stage === undefined || stage.length === 0) return undefined
  const target = stage[0]
  // The design is a pure function of the target, the force's tech and the graph: recompute it only when they change
  // (a session cache: rebuilt after load, same result, so it is deterministic).
  let researchedCount = 0
  for (const [, t] of pairs(ctx.force.technologies)) if (t.researched) researchedCount++
  let built = 0
  for (const n of nodesOf(f.graph)) if (n.lifecycle === "built") built++
  const key = `${ctx.faction.brain!.milestones["automated-science"] !== undefined}|${f.stage}|${target.item}=${target.perMinute}|${researchedCount}|${f.graph.nodeOrder.length}|${built}|${f.goals.length}|${ctx.faction.brain!.patches.length}`
  const cached = designCache[ctx.faction.name]
  if (cached !== undefined && cached.key === key) return cached.design
  // The mall joins the design once science is automated (the crew hand-craft buildings until then).
  const mallId = ctx.config.factoryMall
  const mall = mallId !== "" && ctx.faction.brain!.milestones["automated-science"] !== undefined ? { id: mallId, utilization: ctx.config.factoryMallUtilization } : undefined
  const d = design(designContext(ctx), { item: target.item, perSecond: target.perMinute / 60, mall })
  const diff = diffDesign(d, f.graph, (node) => findModule(f.layout, node)?.canonical)
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
  }
  ;(d as Design & { goals?: GoalSpec[] }).goals = goalsFrom(diff, researchedTechs(ctx.force))
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
    out.push({ role: n.role, id: `n${f.graph.nextId++}`, kind: n.kind, generator: n.generator, params: n.params, item: n.item, need: n.need, capacity: n.capacity, inputs: n.inputs, powerW: n.powerW })
  }
  return out
}

/** Built already (or being built): power, labs. A kind's goal may start once the previous kinds are built. */
function built(f: FactoryState, kind: GoalKind): boolean {
  const g = lastOf(f, kind)
  return g !== undefined && g.status === "done"
}

function advanceGoals(ctx: Ctx, d: Design | undefined): void {
  const f = ctx.f
  if (d === undefined) {
    ctx.waiting.push("no stage target")
    return
  }
  const specs = (d as Design & { goals?: GoalSpec[] }).goals ?? []
  if (d.errors.length > 0) ctx.waiting.push(`design: ${d.errors.join("; ")}`)
  if (specs.length === 0) {
    // The stage is fully planned: once everything is built, move to the next stage.
    let allBuilt = true
    for (const n of nodesOf(f.graph)) if (n.lifecycle !== "built") allBuilt = false
    const stages = parseStages(ctx.config.factoryTargets)
    if (allBuilt && f.stage + 1 < stages.length) {
      f.stage++
      log(`[rival-engineers] faction ${ctx.faction.name}: stage ${f.stage + 1} of ${stages.length}`)
    }
    return
  }
  if (planning(f) !== undefined) return
  for (const spec of specs) {
    if (activeGoal(f, spec.kind) !== undefined) continue
    // Order: power, labs, then production (it needs research the labs do), then growth.
    if (spec.kind === "labs" && !built(f, "power") && activeGoal(f, "power") === undefined && nodeByRole(f.graph, "power") === undefined) {
      ctx.waiting.push("labs wait for power")
      continue
    }
    if (spec.kind === "production" || spec.kind === "grow" || spec.kind === "mall") {
      const blocked: string[] = []
      const before: GoalKind[] = spec.kind === "production" ? ["power", "labs"] : ["power", "labs", "production"]
      for (const k of before) if (activeGoal(f, k) !== undefined) blocked.push(k)
      if (blocked.length > 0) {
        ctx.waiting.push(`${spec.kind} waits for ${blocked.join(", ")}`)
        continue
      }
      const researched = researchedTechs(ctx.force)
      const missing = spec.techs.filter((t) => !researched[t])
      if (missing.length > 0) {
        ctx.waiting.push(`${spec.kind} waits for research: ${missing.join(", ")}`)
        continue
      }
    }
    if (spec.kind === "grow") {
      if (startGrow(ctx, spec)) return
      continue
    }
    startGoal(ctx, spec)
    return
  }
}

function startGoal(ctx: Ctx, spec: GoalSpec): void {
  const f = ctx.f
  const g: FactoryGoal = {
    id: `g${f.nextGoal++}`,
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
  }
  f.goals.push(g)
  planGoal(ctx, g)
}

/**
 * Expand-first (LayoutPolicy.expansion): grow a built module that falls short of its design rate by whole units of its
 * `expand` axis. The moved entities and the belts of its rerouted ports are picked up, then the new entities built.
 * When it can't grow (no room, at its cap), the shortfall stays visible as a waiting reason (D24: a new producer
 * cluster is the remedy, M5b/M6).
 */
function startGrow(ctx: Ctx, spec: GoalSpec): boolean {
  const f = ctx.f
  const gr = spec.growth!
  const node = f.graph.nodes[gr.node]
  if (gr.units < 1 || node === undefined || node.lifecycle !== "built") {
    ctx.waiting.push(`${gr.role} short (${string.format("%.3g", gr.have)}/${string.format("%.3g", gr.need)}): cannot expand`)
    return false
  }
  const t = storage.terrains?.[f.terrain]
  if (t === undefined) return false
  const policy = policyFor(ctx.config)
  const tier = tiers()[0]
  const plan = planGrowth(f.layout, terrainView(t), prototypeFacts, policy, tier, gr.node, gr.units)
  if (!plan.ok) {
    ctx.waiting.push(`${gr.role} short: expansion failed (${plan.reason})`)
    return false
  }
  const g: FactoryGoal = {
    id: `g${f.nextGoal++}`,
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
  const m = findModule(f.layout, gr.node)!
  node.capacity = { inputs: m.canonical.rates.inputs, outputs: m.canonical.rates.outputs }
  node.module = m.canonical.id
  node.lifecycle = "building"
  node.goal = g.id
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.kind === "belt" && plan.rerouted.indexOf(e.role) >= 0) e.physical = [`route:${e.role}`]
  }
  const clearJobs: number[] = []
  for (const e of plan.remove) {
    const found = ctx.surface.find_entities_filtered({ name: e.name, position: { x: e.x, y: e.y }, force: ctx.faction.force, limit: 1 })[0]
    if (found !== undefined) clearJobs.push(addClearJob(ctx.faction, found, ctx.config.factoryBuildPriority))
  }
  const reserved = ctx.faction.brain!.reserved
  for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) reserved[tkey(x, y)] = true
  for (const c of plan.rerouted) for (const k of f.layout.routes[`route:${c}`]?.tiles ?? []) reserved[k] = true
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
    if (g.rounds++ >= MAX_BUILD_ROUNDS) {
      g.status = "failed"
      g.reason = `${left.length} ghosts left`
      return
    }
    const fake = { placeJobs: [] as number[], fuel: { item: ctx.faction.brain!.catalog.fuel, count: 5 }, priority: ctx.config.factoryBuildPriority, phase: "place" }
    replanGhosts(ctx, fake as never, left)
    b.placeJobs = fake.placeJobs
    return
  }
  b.phase = "done"
  g.status = "done"
  g.builtTick = ctx.tick
  const node = ctx.f.graph.nodes[g.growth!.node]
  if (node !== undefined) node.lifecycle = "built"
  mark(ctx.faction, "grow-built")
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} grew ${node?.role} at tick ${ctx.tick}`)
}

function roleToId(f: FactoryState, g: FactoryGoal, role: string): string | undefined {
  for (const n of g.nodes) if (n.role === role) return n.id
  return nodeByRole(f.graph, role)?.id
}

function failedBefore(f: FactoryState, kind: GoalKind): number {
  let n = 0
  for (const g of f.goals) if (g.kind === kind && g.status === "failed") n++
  return n
}

function planGoal(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  g.attempts++
  const modules: ModuleRequest[] = []
  for (const n of g.nodes) modules.push({ id: n.id, def: makeModule(n.generator, n.params) })
  const connections: ConnectionRequest[] = []
  for (const e of g.edges) {
    const from = roleToId(f, g, e.from)
    const to = roleToId(f, g, e.to)
    if (from === undefined || to === undefined) continue
    connections.push({ id: e.role, from: { module: from, port: e.fromPort }, to: { module: to, port: e.toPort }, rate: e.rate, belt: e.belt })
  }
  const r = g.radius
  const region: Rect = { x: f.center.x - r, y: f.center.y - r, w: 2 * r, h: 2 * r }
  // Every goal attempt (and a goal that failed before, retried as a new goal) starts the cluster somewhere else, so a
  // retry is not the same plan again: the hub, then 24 tiles off it in turn (deterministic).
  const tries = g.attempts - 1 + MAX_PLAN_ATTEMPTS * failedBefore(f, g.kind)
  const offsets = [[0, 0], [24, 0], [0, 24], [-24, 0], [0, -24], [24, 24], [-24, -24], [24, -24], [-24, 24]]
  const off = offsets[tries % offsets.length]
  const center = { x: f.center.x + off[0], y: f.center.y + off[1] }
  const request: PlanRequest = { modules, connections, center, region, poles: ctx.entities.pole ?? "small-electric-pole" }
  const id = `${ctx.faction.name}:${g.id}:${g.attempts}`
  if (getPlannerEntry(id) !== undefined) removePlan(id)
  // Undergrounds only once they can be crafted (`logistics`).
  const ug = tiers()[0]?.underground
  const ugRecipe = ug !== undefined ? (prototypeFacts.recipeForItem(ug) ?? ug) : undefined
  const maxUnderground = ugRecipe !== undefined && ctx.force.recipes[ugRecipe]?.enabled ? undefined : 1
  startPlan({ id, surface: ctx.faction.surface, force: ctx.faction.force, faction: ctx.faction.name, request, terrain: f.terrain, baseFaction: ctx.faction.name, maxUnderground })
  g.plan = id
  g.status = "planning"
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) attempt ${g.attempts}: ${g.nodes.length} modules, ${connections.length} connections, region radius ${r}`)
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
  const entry = g.plan !== undefined ? getPlannerEntry(g.plan) : undefined
  if (entry === undefined) {
    g.status = "failed"
    g.reason = "plan lost"
    return
  }
  if (entry.phase === "scan" || entry.phase === "plan") return
  if (entry.phase === "failed") {
    const why: string[] = []
    const roles: Record<string, string> = {}
    for (const n of g.nodes) roles[n.id] = n.role
    for (const [k, v] of pairs(entry.job?.failures ?? {})) {
      const m = string.match(k as string, "^module:(.*)$")[0]
      why.push(`${m !== undefined ? `module ${m} (${roles[m] ?? "?"})` : k}: ${v}`)
    }
    g.reason = why.join("; ")
    log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} plan failed (attempt ${g.attempts}): ${g.reason}`)
    removePlan(entry.id)
    if (g.attempts >= MAX_PLAN_ATTEMPTS) {
      g.status = "failed"
      return
    }
    g.radius = math.floor(g.radius * 1.5)
    planGoal(ctx, g)
    return
  }
  adoptPlan(ctx, g)
}

/** A finished plan becomes the faction's layout; its new parts become graph nodes and edges and are built. */
function adoptPlan(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  const entry = getPlannerEntry(g.plan!)!
  const job = entry.job!
  f.layout = job.layout
  const parts: BuildParts = { modules: [], routes: [], poles: [] }
  for (const m of job.layout.modules) if (!job.baseModules[m.id]) parts.modules.push(m.id)
  for (const id of job.layout.routeOrder) if (!job.baseRoutes[id]) parts.routes.push(id)
  for (const id of job.poleJob?.added ?? []) parts.poles.push(id)
  for (const n of g.nodes) {
    const m = findModule(job.layout, n.id)
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
    addNode(f.graph, node)
  }
  for (const e of g.edges) {
    const from = roleToId(f, g, e.from)
    const to = roleToId(f, g, e.to)
    if (from === undefined || to === undefined) continue
    const physical: string[] = []
    for (const rid of job.layout.routeOrder) {
      const r = job.layout.routes[rid]
      if (r.conn === e.role) {
        if (r.tapOf !== undefined) physical.push(r.tapOf)
        physical.push(rid)
      }
    }
    addEdge(f.graph, { id: `e:${e.role}`, role: e.role, kind: "belt", item: e.item, from, fromPort: e.fromPort, to, toPort: e.toPort, plannedRate: e.rate, headroomRate: e.headroomRate, physical, belt: e.belt, overflow: e.decision.action !== "none" ? e.decision.action : undefined })
  }
  powerEdges(f)
  // The bootstrap keeps its sites and hand-mining off the planned tiles.
  const reserved = ctx.faction.brain!.reserved
  for (const k of partTiles(job.layout, parts)) reserved[k] = true
  for (const id of parts.modules) {
    const m = findModule(job.layout, id)!
    for (let x = m.rect.x - 1; x <= m.rect.x + m.rect.w; x++) for (let y = m.rect.y - 1; y <= m.rect.y + m.rect.h; y++) reserved[tkey(x, y)] = true
  }
  const fuel = ctx.faction.brain!.catalog.fuel
  startBuild(entry, { fuel: { item: fuel, count: 5 }, priority: ctx.config.factoryBuildPriority, parts })
  g.status = "building"
  g.plannedTick = ctx.tick
  const s = job.stats
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) planned in ${entry.scanTicks + entry.planTicks} ticks (work ${s.work}, ${s.searches} searches, ${s.ripups} rip-ups): ${parts.modules.length} modules, ${parts.routes.length} routes, ${parts.poles.length} poles`)
  ctx.faction.brain!.steps++
  mark(ctx.faction, `${g.kind}-planned`)
}

/** Power edges: the power node to every consumer node, physical = the pole lines that joined it. */
function powerEdges(f: FactoryState): void {
  const power = nodesOf(f.graph, "power")[0]
  if (power === undefined) return
  const roles = powerRoles(f.layout, prototypeFacts)
  for (const id of roles.consumers) {
    const n = f.graph.nodes[id]
    if (n === undefined) continue
    const role = `power=>${n.role}`
    if (edgeByRole(f.graph, role) !== undefined) continue
    const lines: string[] = []
    for (const l of f.layout.poleLines ?? []) if (l.to === id) lines.push(l.id)
    addEdge(f.graph, { id: `e:${role}`, role, kind: "power", item: "electricity", from: power.id, to: id, plannedRate: n.powerW, physical: lines })
  }
}

function updateBuilding(ctx: Ctx, g: FactoryGoal): void {
  const f = ctx.f
  const entry = g.plan !== undefined ? getPlannerEntry(g.plan) : undefined
  const b = entry?.build
  if (entry === undefined || b === undefined) {
    g.status = "failed"
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
  if (b.phase !== "done") return
  // Every job finished: ghosts left over (failed jobs, a replan dropping jobs) get new place jobs.
  const left: LuaEntity[] = []
  for (const gh of b.ghosts ?? []) if (gh.valid) left.push(gh)
  if (left.length > 0) {
    if (g.rounds >= MAX_BUILD_ROUNDS) {
      g.status = "failed"
      g.reason = `${left.length} ghosts left after ${g.rounds} rounds`
      return
    }
    g.rounds++
    replanGhosts(ctx, b, left)
    return
  }
  g.status = "done"
  g.builtTick = ctx.tick
  for (const n of g.nodes) {
    const node = f.graph.nodes[n.id]
    if (node !== undefined) {
      node.lifecycle = "built"
      node.builtTick = ctx.tick
    }
  }
  removePlan(entry.id)
  ctx.faction.brain!.steps++
  mark(ctx.faction, `${g.kind}-built`)
  log(`[rival-engineers] faction ${ctx.faction.name}: goal ${g.id} (${g.kind}) built at tick ${ctx.tick} (${g.placed} placements, ${g.rounds} extra rounds)`)
}

function replanGhosts(ctx: Ctx, b: NonNullable<ReturnType<typeof getPlannerEntry>>["build"], left: LuaEntity[]): void {
  const faction = ctx.faction
  b!.placeJobs = []
  for (const gh of left) {
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
// Research and hand-fed labs

function packsAutomated(f: FactoryState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const n of nodesOf(f.graph)) if (n.lifecycle === "built" && n.kind === "module" && n.item !== undefined && edgesToLabs(f, n.id)) out[n.item] = true
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
  return nodesOf(f.graph, "labs").filter((n) => n.lifecycle === "built")
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
  const pick = startResearch(ctx.force, wanted, packsAvailable(ctx), packsAutomated(f))
  if (pick !== undefined) {
    f.research.current = pick.tech
    f.research.reason = pick.reason
    f.research.started[pick.tech] ??= `${ctx.tick}: ${pick.reason}`
    log(`[rival-engineers] faction ${ctx.faction.name}: research ${pick.tech} (${pick.reason})`)
  } else ctx.waiting.push("no researchable technology")
}

function labEntities(ctx: Ctx, node: LogicalNode): LuaEntity[] {
  const m = findModule(ctx.f.layout, node.id)
  if (m === undefined) return []
  return ctx.surface.find_entities_filtered({ type: "lab", force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
}

function keyActive(ctx: Ctx, key: string): boolean {
  const id = ctx.f.jobKeys[key]
  if (id === undefined) return false
  const job = ctx.faction.board.jobs[id]
  if (job !== undefined && (job.status === "open" || job.status === "claimed")) return true
  delete ctx.f.jobKeys[key]
  return false
}

function addKeyed(ctx: Ctx, key: string, spec: JobSpec<JobPayload>): void {
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
        if (inv.get_item_count(ing.name) >= LAB_LOW || keyActive(ctx, key)) continue
        addKeyed(ctx, key, {
          kind: "fuel",
          pos: lab.position,
          materials: [{ item: ing.name, count: LAB_FEED }],
          priority: 95,
          payload: { kind: "fuel", item: ing.name, count: LAB_FEED, target: lab, partial: true },
        })
      }
    }
  }
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
    if (n.lifecycle !== "built") continue
    const m = findModule(f.layout, id)
    const names = m?.canonical.upkeep?.fuel.map((x) => x.name) ?? []
    if (m === undefined || names.length === 0) continue
    const found = ctx.surface.find_entities_filtered({ name: names, force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
    for (const e of found) {
      const inv = e.get_fuel_inventory()
      if (inv === undefined) continue
      const perTick = e.prototype.get_max_energy_usage() ?? 0
      const low = math.max(1, math.ceil((FUEL_LOW_MINUTES * 3600 * perTick) / fuelValue))
      const have = inv.get_item_count(fuel)
      const key = `upkeep:${e.unit_number}`
      if (have >= low || keyActive(ctx, key)) continue
      const top = math.max(low + 1, math.ceil((FUEL_TOP_MINUTES * 3600 * perTick) / fuelValue))
      const count = math.min(top - have, prototypes.item[fuel].stack_size)
      addKeyed(ctx, key, { kind: "fuel", pos: e.position, materials: [{ item: fuel, count }], priority: 100, payload: { kind: "fuel", item: fuel, count, target: e, partial: true } })
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Milestones

function moduleEntities(ctx: Ctx, node: LogicalNode, type: string): LuaEntity[] {
  const m = findModule(ctx.f.layout, node.id)
  if (m === undefined) return []
  return ctx.surface.find_entities_filtered({ type, force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
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
  for (const n of nodesOf(f.graph)) if (n.lifecycle === "built" && n.kind === "module" && n.item !== undefined && automated[n.item]) producer = n
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
    const b = g.plan !== undefined ? getPlannerEntry(g.plan)?.build : undefined
    if (b === undefined) continue
    const left: LuaEntity[] = []
    for (const gh of b.ghosts ?? []) if (gh.valid) left.push(gh)
    if (left.length > 0) replanGhosts(ctx, b, left)
  }
  faction.brain!.replans++
}

// ---------------------------------------------------------------------------------------------------------
// Material supply: the mall's output chests are a source for the bootstrap economy (H4 collect before hand-craft).

/** Built mall chests holding `item` (or anything, if undefined), with amounts. */
export function mallSources(factionName: string, item: string | undefined): { entity: LuaEntity; item: string; amount: number }[] {
  const out: { entity: LuaEntity; item: string; amount: number }[] = []
  const f = getFactory(factionName)
  if (f === undefined) return out
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph, "sink")) {
    if (n.lifecycle !== "built") continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    for (const p of m.def.ports) {
      if (p.kind !== "chest-out" || (item !== undefined && p.item !== item)) continue
      const chest = surface.find_entities_filtered({ type: "container", force: faction.force, position: { x: m.origin.x + p.pos.x, y: m.origin.y + p.pos.y }, limit: 1 })[0]
      if (chest === undefined) continue
      for (const c of chest.get_inventory(defines.inventory.chest)!.get_contents()) if (item === undefined || c.name === item) out.push({ entity: chest, item: c.name, amount: c.count })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Reports

export function factoryReport(name: string) {
  const f = getFactory(name)
  if (f === undefined) return undefined
  const nodes: Record<string, number> = {}
  for (const n of nodesOf(f.graph)) nodes[n.lifecycle] = (nodes[n.lifecycle] ?? 0) + 1
  return {
    stage: f.stage,
    goals: f.goals.map((g) => ({ id: g.id, kind: g.kind, status: g.status, modules: g.nodes.length, flows: g.edges.length, attempts: g.attempts, placed: g.placed, rounds: g.rounds, created: g.createdTick, planned: g.plannedTick, built: g.builtTick, reason: g.reason })),
    nodes,
    edges: f.graph.edgeOrder.length,
    design: f.design,
    research: f.research,
    waiting: f.waiting,
    verify: f.verify,
  }
}

/** Both graph layers for tools/render and the soak report (D29): the physical layer of the faction's layout plus the logical graph. */
export function factoryGraph(name: string): FactoryGraph | undefined {
  const f = getFactory(name)
  if (f === undefined) return undefined
  const faction = storage.factions[name]
  const force = game.forces[faction.force]
  const researched = force !== undefined ? researchedTechs(force) : {}
  const policy = policyFor(getConfig())
  const g = buildGraph(f.layout, policy, { tiers: tiers(), researched })
  g.faction = name
  g.tick = game.tick
  const out = g as FactoryGraph & { nodes?: unknown; flows?: unknown; poles?: unknown }
  out.logical = { nodes: nodesOf(f.graph).map((n) => ({ ...n, recipe: n.recipe })) as never, edges: f.graph.edgeOrder.map((id) => f.graph.edges[id]) as never }
  out.poles = f.layout.poles ?? []
  return g
}

export function exportFactoryGraph(name: string, file: string): boolean {
  const g = factoryGraph(name)
  if (g === undefined) return false
  helpers.write_file(file, helpers.table_to_json(g as never), false)
  return true
}
