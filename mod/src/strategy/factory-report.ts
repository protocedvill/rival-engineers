import { LuaEntity, LuaForce } from "factorio:runtime"
import { getConfig } from "../config"
import { buildGraph, FactoryGraph } from "../planner/graph"
import { Vec } from "../planner/grid"
import { findModule } from "../planner/layout"
import { nodesOf, rateIn, supplyGaps } from "../planner/logical"
import { entryPolicy, tiers } from "../planner/runtime"
import { statusCounts } from "./reconcile"
import { isTempRole } from "./stage"
import { findEntities } from "../work"
import { isBufferAt, registerBuffer } from "../modules/buffers"
import type { FactoryState } from "./factory"
import * as CS from "./constraints"

// Read-only views of a faction's factory (split out of factory.ts, whose main chunk hit Lua's 200-local limit): the
// D38 temporary cells and the mall's chests as supply sources for the bootstrap economy, and the telemetry / graph
// reports (D29).

function getFactory(name: string): FactoryState | undefined {
  return storage.factories?.[name]
}

function researchedTechs(force: LuaForce): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [name, t] of pairs(force.technologies)) if (t.researched) out[name as string] = true
  return out
}

function policyFor() {
  return entryPolicy({ request: { modules: [], connections: [], center: { x: 0, y: 0 }, region: { x: 0, y: 0, w: 0, h: 0 } }, policy: getConfig().layoutPolicy } as never)
}

/** A built temporary cell of `item`: its input and output chests and the assembler, for the economy (bootstrap.ts). */
export interface TempCell {
  node: string
  /** The product the cell makes (its node's item). */
  item: string
  recipe: string
  input: LuaEntity
  output: LuaEntity
  machine?: LuaEntity
  /** Products per second at full speed. */
  rate: number
}

export function tempCells(factionName: string, item?: string): TempCell[] {
  const out: TempCell[] = []
  const f = getFactory(factionName)
  if (f === undefined) return out
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph, "sink")) {
    if (!isTempRole(n.role) || n.lifecycle !== "built" || n.recipe === undefined || n.item === undefined) continue
    const nodeItem = n.item
    const recipe = n.recipe
    if (item !== undefined && nodeItem !== item) continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    let inPos: Vec | undefined
    let outPos: Vec | undefined
    for (const p of m.def.ports) {
      if (p.kind === "chest-in") inPos = p.pos
      if (p.kind === "chest-out") outPos = p.pos
    }
    if (inPos === undefined || outPos === undefined) continue
    const input = findEntities(surface, { type: "container", force: faction.force, position: { x: m.origin.x + inPos.x, y: m.origin.y + inPos.y }, limit: 1 })[0]
    const output = findEntities(surface, { type: "container", force: faction.force, position: { x: m.origin.x + outPos.x, y: m.origin.y + outPos.y }, limit: 1 })[0]
    if (input === undefined || output === undefined) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    const machine = findEntities(surface, { type: "assembling-machine", force: faction.force, area, limit: 1 })[0]
    out.push({ node: n.id, item: nodeItem, recipe, input, output, machine, rate: rateIn(n.capacity.outputs, nodeItem) })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Material supply (B32): the factory's output chests (the mall's and the temporary cells') are supply points the crew
// takes from directly when a job needs their items.

/** Built chest-out port chests of the factory's sink modules (mall, temporary cells), in node order. */
export function supplyChests(factionName: string): { entity: LuaEntity; temp: boolean }[] {
  const out: { entity: LuaEntity; temp: boolean }[] = []
  const f = getFactory(factionName)
  if (f === undefined) return out
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph, "sink")) {
    if (n.lifecycle !== "built") continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    for (const p of m.def.ports) {
      if (p.kind !== "chest-out") continue
      const chest = findEntities(surface, { type: "container", force: faction.force, position: { x: m.origin.x + p.pos.x, y: m.origin.y + p.pos.y }, limit: 1 })[0]
      if (chest !== undefined) out.push({ entity: chest, temp: isTempRole(n.role) })
    }
  }
  return out
}

/**
 * B36: makes sure every built module's buffer chest (D42/D51) is a registered buffer. Modules stamped as ghosts by the
 * planner runtime were never registered before B36 (only growth and conflict ghosts were), so their chests had no slot
 * limit and were no supply points. Cheap: one lookup per buffered module, a search only for unregistered ones.
 */
export function repairBuffers(factionName: string): void {
  const f = getFactory(factionName)
  if (f === undefined) return
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph)) {
    if (n.lifecycle !== "built") continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    for (const e of m.def.entities) {
      if (!e.buffer) continue
      const pos = { x: m.origin.x + e.x, y: m.origin.y + e.y }
      if (isBufferAt(surface.name, pos)) continue
      const chest = findEntities(surface, { type: "container", force: faction.force, position: pos, limit: 1 })[0]
      if (chest !== undefined) registerBuffer(surface, faction.force, chest)
    }
  }
}

/**
 * B36 (proposed, `supply-module-furnaces`, default off): the furnaces of built smelter modules, whose result slots
 * fill up when their output belt backs up. Taking from them may starve the module's belt.
 */
export function moduleFurnaces(factionName: string): LuaEntity[] {
  const out: LuaEntity[] = []
  const f = getFactory(factionName)
  if (f === undefined) return out
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph)) {
    // B134: a module inside a plan still being built can already run (the blue line's steel smelter). Its output must
    // be a supply point, or the same plan's pumpjack craft waits for steel that the smelter has made.
    if (n.lifecycle !== "built" && n.lifecycle !== "building") continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    let any = false
    for (const e of m.def.entities) if (prototypes.entity[e.name]?.type === "furnace") any = true
    if (!any) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    for (const e of findEntities(surface, { type: "furnace", force: faction.force, area })) out.push(e)
  }
  return out
}

/**
 * M7c.8: the assemblers of built factory modules (the crew may take a product the economy has no other source for from
 * their output slots; `bootstrap.ts` registers them).
 */
export function moduleAssemblers(factionName: string): LuaEntity[] {
  const out: LuaEntity[] = []
  const f = getFactory(factionName)
  if (f === undefined) return out
  const faction = storage.factions[factionName]
  const surface = game.surfaces[faction.surface]
  for (const n of nodesOf(f.graph)) {
    // B134: same as moduleFurnaces: a building module's output can already be the only source of a needed item.
    if (n.lifecycle !== "built" && n.lifecycle !== "building") continue
    const m = findModule(f.layout, n.id)
    if (m === undefined) continue
    let any = false
    for (const e of m.def.entities) if (prototypes.entity[e.name]?.type === "assembling-machine") any = true
    if (!any) continue
    const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
    for (const e of findEntities(surface, { type: "assembling-machine", force: faction.force, area })) out.push(e)
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
    goals: f.goals.map((g) => ({ id: g.id, kind: g.kind, status: g.deferred ? "deferred" : g.status, modules: g.nodes.length, flows: g.edges.length, attempts: g.attempts, placed: g.placed, rounds: g.rounds, created: g.createdTick, planned: g.plannedTick, built: g.builtTick, reason: g.reason })),
    nodes,
    edges: f.graph.edgeOrder.length,
    design: f.design,
    research: f.research,
    waiting: f.waiting,
    verify: f.verify,
    reconciler: reconcilerReport(f),
    logistics: { undergrounds: f.needUndergrounds, splitters: f.needSplitters, taps: f.taps, compares: f.compares },
    science: f.science,
    // B65: providers whose consumers asked for more than their plan delivers (fictional capacity). The number the
    // over-subscription bug hid for 270 game-min; a non-zero list is the first thing to read in a slow seed.
    supply: supplyReport(f),
    idle: f.idle,
    growFails: CS.values(f.constraints, "growFails"),
  }
}

/** B65: the worst over-subscribed providers (top 5), with the gap in the item's unit per second. */
function supplyReport(f: FactoryState) {
  const gaps = supplyGaps(f.graph)
  if (gaps.length === 0) return undefined
  gaps.sort((a, b) => (b.committed - b.planned) - (a.committed - a.planned))
  const top: Record<string, { planned: number; committed: number }> = {}
  for (const g of gaps.slice(0, 5)) top[g.role] = { planned: g.planned, committed: g.committed }
  return { count: gaps.length, worst: top }
}

/** M5b telemetry: statuses, root causes of nodes that are not ok, remedies so far, probes. */
function reconcilerReport(f: FactoryState) {
  const st = f.reconciler
  if (st === undefined) return undefined
  const causes: string[] = []
  for (const id of f.graph.nodeOrder) {
    const n = f.graph.nodes[id]
    if (n.cause !== undefined) causes.push(`${n.id} ${n.role} ${n.status}: ${n.cause.kind}${n.cause.id !== undefined ? ` ${n.cause.id}` : ""} ${n.cause.what} (${n.cause.why})`)
  }
  const remedies: Record<string, number> = {}
  for (const [, r] of pairs(st.remedies)) remedies[r.kind] = (remedies[r.kind] ?? 0) + r.count
  return { evaluations: st.evaluations, statuses: statusCounts(f.graph), changes: st.changes, causes, remedies, log: st.log, probes: f.meter?.probes ?? 0 }
}

/** Both graph layers for tools/render and the soak report (D29): the physical layer of the faction's layout plus the logical graph. */
export function factoryGraph(name: string): FactoryGraph | undefined {
  const f = getFactory(name)
  if (f === undefined) return undefined
  const faction = storage.factions[name]
  const force = game.forces[faction.force]
  const researched = force !== undefined ? researchedTechs(force) : {}
  const policy = policyFor()
  const g = buildGraph(f.layout, policy, { tiers: tiers(), researched })
  g.faction = name
  g.tick = game.tick
  const out = g as FactoryGraph & { nodes?: unknown; flows?: unknown; poles?: unknown }
  out.logical = { nodes: nodesOf(f.graph).map((n) => ({ ...n, recipe: n.recipe })) as never, edges: f.graph.edgeOrder.map((id) => f.graph.edges[id]) as never }
  out.poles = f.layout.poles ?? []
  return g
}

export function exportFactoryGraph(name: string, file: string, forPlayer?: number): boolean {
  const g = factoryGraph(name)
  if (g === undefined) return false
  helpers.write_file(file, helpers.table_to_json(g as never), false, forPlayer)
  return true
}
