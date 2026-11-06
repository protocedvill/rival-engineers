import { LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { curatedIds, curatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { edgeDraw, nodeByRole, rateIn, spareCapacity } from "../planner/logical"
import type { LogicalNode } from "../planner/logical"
import { findModule } from "../planner/layout"
import { tiers } from "../planner/runtime"
import { factionSurface, getFaction } from "../jobs/faction"
import * as OIL from "./oil"
import { maxUnitTime, meanUnitTime, researchGoal } from "./research-queue"
import type { FactoryState } from "./factory"
import * as CS from "./constraints"

// M6 stage helpers (split out of factory.ts, whose main chunk hit Lua's 200-local limit): stage targets, lab sizing per
// stage, the design's curated fallbacks, shared fuel and a second steam block, and the science-throughput sampling that
// checks the v1 bar (SPEC §3).

/** A grow whose expansion failed this many times no longer holds its stage (M6). */
export const GROW_MAX_FAILS = 3

/** D38: role prefix of temporary chest cells. */
export const TEMP_PREFIX = "temp:"

export function isTempRole(role: string): boolean {
  return string.sub(role, 1, TEMP_PREFIX.length) === TEMP_PREFIX
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

/**
 * Seconds per research unit the labs of `stage` are sized for: `factory-research-unit-time` when set, else the stage's
 * entry of `factory-lab-sizing` ("mean" / "max" over the research goal's pack technologies, or seconds; the last entry
 * repeats).
 */
export function labUnitTime(config: Config, stage: number): number {
  if (config.factoryResearchUnitTime > 0) return config.factoryResearchUnitTime
  const parts: string[] = []
  for (const [p] of string.gmatch(config.factoryLabSizing, "[^;%s]+")) parts.push(p)
  const v = parts[math.min(stage, parts.length - 1)] ?? "mean"
  if (v === "max") return maxUnitTime()
  const n = tonumber(v)
  return n !== undefined && n > 0 ? n : meanUnitTime()
}

/**
 * B19 (M6): from stage `factory-shared-providers` on (1-based; 0 = never) and once splitters can be built, providers are
 * shared (design.ts `DesignContext.sharing`): consumers already fed keep their producer; a producer's spare capacity
 * (planned output minus what its edges carry) is offered to new consumers of its item.
 */
/**
 * B65: how much output `node` can add by growing in place: its remaining expansion units at their per-unit rate.
 * Zero when the module has no expansion unit (a fork is then the only way). The chain's own feed is not consulted here;
 * `supplyPass` raises it and `diffDesign` grows or forks it in turn.
 */
function growableInPlace(f: FactoryState, id: string, item: string): number {
  const m = findModule(f.layout, id as never)
  const e = m?.canonical?.expand
  if (e === undefined || e.maxUnits <= 0) return 0
  let per = 0
  for (const r of e.perUnit.rates.outputs) if (r.item === item) per += r.perSecond
  return per * e.maxUnits
}

/**
 * D68 (user, 2026-10-28: "tap first is best as long as there is capacity", for every item): whether built producer `id`
 * can still serve new consumers of `item`: spare full-speed output over its planned draw, or room to grow in place.
 */
export function hasCapacity(f: FactoryState, id: string, item: string): boolean {
  return spareCapacity(f.graph, id) > 1e-6 || growableInPlace(f, id, item) > 0
}

/**
 * What a built provider can still deliver of its item at the current plan. For every other provider this is the plan's
 * `planned` output (B65: an under-fed mine's nameplate is not spare), but a **pumpjack field's feed is its own wells**:
 * its capacity is the real well yield, while `planned` is only what it was sized for. Using `planned` there made a field
 * producing ~210 crude/s look full at its 42/s plan, so the design added another field for demand that did not exist.
 */
export function spareForNode(p: LogicalNode, used: number, potential?: number): number {
  if (p.item === undefined) return 0
  const planned = rateIn(p.planned.outputs, p.item)
  const room = p.generator === "pumpjack-field" ? potential ?? rateIn(p.capacity.outputs, p.item) : planned
  return room - used
}

export function sharing(ctx: { config: Config; force: LuaForce }, f: FactoryState | undefined, stage: number, force = false): { keep: Record<string, string>; spare: Record<string, Record<string, number>>; fallback?: Record<string, string[]>; split?: Record<string, boolean>; blocked?: Record<string, boolean>; draw?: Record<string, number> } | undefined {
  const from = ctx.config.factorySharedProviders
  if (from <= 0 || stage + 1 < from || (!force && !splittersEnabled(ctx.force))) return undefined
  const keep: Record<string, string> = {}
  const spare: Record<string, Record<string, number>> = {}
  const draw: Record<string, number> = {}
  if (f !== undefined) {
    const out: Record<string, number> = {}
    for (const id of f.graph.edgeOrder) {
      const e = f.graph.edges[id]
      if (e.kind !== "belt" || e.from === undefined) continue
      const p = f.graph.nodes[e.from]
      const c = f.graph.nodes[e.to]
      if (p === undefined || c === undefined) continue
      const key = `${e.item}@${c.role}@${e.toPort}`
      keep[key] = p.role
      // Keep the older role-level key for callers that do not distinguish ports. `blocked` below is authoritative:
      // expandShared checks the exact provider→consumer feed after either exact or legacy lookup.
      keep[`${e.item}@${c.role}`] = p.role
      // M7c (user-approved 2026-11-01): a consumer takes what it can, not what was planned: its draw counts at the
      // measured rate when that is higher.
      const used = edgeDraw(e)
      out[p.id] = (out[p.id] ?? 0) + used
      if (used > e.plannedRate) draw[key] = (draw[key] ?? 0) + used
    }
    for (const [id, used] of pairs(out)) {
      const p = f.graph.nodes[id as string]
      if (p.item === undefined || !tappable(f, p.role)) continue
      // B65: spare is what the plan sized this provider to deliver (`planned`), not its nameplate capacity. A 4-wide
      // smelter running on a 0.183/s ore feed looks like it has 1.07/s spare by capacity; tapping that spare starves
      // the new consumer, because the plan never grew the feed (see `supplyGaps`).
      let potential: number | undefined
      if (p.generator === "pumpjack-field" && p.item !== undefined) {
        const faction = getFaction(f.faction)
        const m = findModule(f.layout, (p.alias ?? p.id) as never)
        if (faction !== undefined && m !== undefined) potential = OIL.fieldPotential(factionSurface(faction), faction.force, m, p.item)
      }
      const room = spareForNode(p, used as number, potential)
      // B65: when the plan has no freed capacity, the provider can still take the consumer if it can GROW IN PLACE:
      // the consumer joins its role, the design node's `need` rises to the total, and `diffDesign` asks the built
      // module for expansion units (and, through `supplyPass`, its feed chain for the ore). Forking a whole new chain
      // (mine + smelter + routes) is the fallback for a provider at its expansion ceiling, not the first answer.
      const grow = room > 0 ? 0 : growableInPlace(f, id as string, p.item)
      if (room + grow <= 0) continue
      spare[p.item] ??= {}
      spare[p.item][p.role] = room + grow
    }
  }
  return { keep, spare, fallback: fallbackProducers(f), split: CS.flags(f?.constraints, "providerSplit"), blocked: CS.flags(f?.constraints, "providerNoTap"), draw }
}

/** D69: whether new consumers may tap provider `role` (not marked no-tap or short, not retiring, not running out). */
function tappable(f: FactoryState, role: string): boolean {
  return !CS.has(f.constraints, "noTap", role) && !CS.has(f.constraints, "providerShort", role) && f.retiring?.[role] === undefined && !oreRunsOut(f, role)
}

/** M7c: steps per item/s of over-planned measured draw in the design cache key (agent guess: a quarter item/s). */
const DRAW_KEY_STEPS = 4

/**
 * M7c: the design cache key's part for this session's signals: mines about to run out (`oreRunsOut`, no new taps) and
 * consumers measured drawing more than planned (user-approved 2026-11-01), in quarter item/s steps so measurement noise
 * does not redesign every think.
 */
export function designSignals(f: FactoryState): string {
  const runningOut: string[] = []
  for (const [role] of pairs(f.oreLeft ?? {})) if (oreRunsOut(f, role as string)) runningOut.push(role as string)
  runningOut.sort()
  const draws: string[] = []
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e.kind === "belt" && (e.measuredRate ?? 0) > e.plannedRate) draws.push(`${id}:${math.floor((e.measuredRate! - e.plannedRate) * DRAW_KEY_STEPS)}`)
  }
  return `${runningOut.join(";")}|${draws.join(";")}`
}

/**
 * M7c (seed 11): a mine whose ore at full output lasts less than its `minMinutes`. Full output, not the planned draw:
 * consumers with room take all a mine makes (two 4-furnace columns planned at 0.47/s drew its whole 1/s), so the planned
 * spare was never there and the mine ran out ~40 game-min after the blue line tapped it.
 */
export function oreRunsOut(f: FactoryState, role: string): boolean {
  const o = f.oreLeft?.[role]
  if (o === undefined) return false
  const n = nodeByRole(f.graph, role)
  if (n === undefined || n.item === undefined) return false
  const rate = rateIn(n.capacity.outputs, n.item)
  return rate > 0 && o.amount / rate / 60 < o.minMinutes
}

/**
 * P36 (b, proposed): for each item whose new producer could not be placed (the `fallback` constraint, plus `extra`), the
 * built producers of it new consumers tap instead, nearest the hub first (growable ones before those whose growth keeps
 * failing). Never one that is not tapped again (`noTap`).
 */
export function fallbackProducers(f: FactoryState | undefined, extra: string[] = []): Record<string, string[]> | undefined {
  if (f === undefined) return undefined
  const items = [...CS.keys(f.constraints, "fallback"), ...extra]
  if (items.length === 0) return undefined
  let out: Record<string, string[]> | undefined
  for (const item of items) {
    const list: { role: string; key: number }[] = []
    for (const id of f.graph.nodeOrder) {
      const n = f.graph.nodes[id]
      if (n.item !== item || (n.kind !== "module" && n.kind !== "outpost") || n.lifecycle !== "built" || !tappable(f, n.role)) continue
      if (!hasCapacity(f, id, item)) continue
      const m = findModule(f.layout, id)
      if (m === undefined) continue
      const dx = m.rect.x + m.rect.w / 2 - f.center.x
      const dy = m.rect.y + m.rect.h / 2 - f.center.y
      const blocked = (CS.value(f.constraints, "growFails", n.role) ?? 0) >= GROW_MAX_FAILS ? 1e9 : 0
      list.push({ role: n.role, key: blocked + dx * dx + dy * dy })
    }
    list.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.role < b.role ? -1 : 1))
    if (list.length === 0) continue
    out ??= {}
    out[item] = list.map((x) => x.role)
  }
  return out
}

/**
 * M6: the largest share of the stage target cluster 1 may take, from its modules that can't grow (`cluster1Caps`: role →
 * the share it could still serve when its growth failed for good). Undefined: no cap.
 */
export function cluster1Max(f: FactoryState | undefined): number | undefined {
  let out: number | undefined
  for (const [, v] of pairs(CS.values(f?.constraints, "cluster1Caps") ?? {})) out = math.min(out ?? 1, v)
  return out
}

/**
 * M6/B66: the built steam blocks whose own growth keeps failing, `power` first and then `power#2`, `power#3`... while
 * each of them is capped too, with their capacity (the design's `powerCaps`). Undefined while `power` can still grow.
 */
export function powerCaps(f: FactoryState | undefined): { role: string; capacity: number }[] | undefined {
  if (f === undefined) return undefined
  // M6/B29: this is only for a steam block whose own growth keeps failing. A short fuel producer is a provider-group
  // shortfall (B60): it keeps feeding the existing block and the design adds a parallel coal provider, not a second
  // power block with its own mine.
  const out: { role: string; capacity: number }[] = []
  for (let i = 1; ; i++) {
    const role = i === 1 ? "power" : `power#${i}`
    const n = nodeByRole(f.graph, role)
    if (n === undefined || (CS.value(f.constraints, "growFails", role) ?? 0) < GROW_MAX_FAILS) break
    out.push({ role, capacity: rateIn(n.capacity.outputs, "electricity") })
  }
  return out.length > 0 ? out : undefined
}

/** Actual output capacity of built provider roles, for the B60 provider-group split. */
export function providerCaps(f: FactoryState | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (f === undefined) return out
  for (const id of f.graph.nodeOrder) {
    const n = f.graph.nodes[id]
    if (n.lifecycle !== "built" || n.item === undefined) continue
    const cap = rateIn(n.capacity.outputs, n.item)
    if (cap > 0) out[n.role] = math.max(out[n.role] ?? 0, cap)
  }
  return out
}

/** M7d.4: the generator of every role in the factory graph (any lifecycle), for `DesignContext.builtGenerators`. */
export function builtGenerators(f: FactoryState | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (f === undefined) return out
  for (const id of f.graph.nodeOrder) {
    const n = f.graph.nodes[id]
    if (n.generator !== undefined) out[n.role] = n.generator
  }
  return out
}

/** B97: the consumer ports (`role.port`) each built provider role feeds over its belt edges. */
export function providerFeeds(f: FactoryState | undefined): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {}
  if (f === undefined) return out
  for (const id of f.graph.edgeOrder) {
    const e = f.graph.edges[id]
    if (e === undefined || e.kind !== "belt" || e.from === undefined || e.to === undefined || e.toPort === undefined) continue
    const from = f.graph.nodes[e.from]
    const to = f.graph.nodes[e.to]
    if (from === undefined || to === undefined || from.lifecycle !== "built") continue
    ;(out[from.role] ??= {})[`${to.role}.${e.toPort}`] = true
  }
  return out
}

/**
 * D76: provider roles being retired. Their consumers need a replacement planned under a distinct parallel role, and
 * their spare capacity must not be offered to new consumers (the provider is going away).
 */
export function retiringRoles(f: FactoryState | undefined): Record<string, boolean> | undefined {
  let out: Record<string, boolean> | undefined
  for (const [role] of pairs(f?.retiring ?? {})) {
    out ??= {}
    out[role as string] = true
  }
  return out
}

function splittersEnabled(force: LuaForce): boolean {
  const sp = tiers()[0]?.splitter
  const r = sp !== undefined ? (prototypeFacts.recipeForItem(sp) ?? sp) : undefined
  return r !== undefined && force.recipes[r]?.enabled === true
}

/** Curated modules by the item they make (their recipe's product on a belt-out port): the design's fallback (M6 green). */
export function curatedProducers(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of curatedIds()) {
    const def = curatedModule(id)
    if (def.recipe === undefined) continue
    for (const p of def.ports) if (p.kind === "belt-out" && p.item !== undefined && out[p.item] === undefined) out[p.item] = id
  }
  return out
}


// Science throughput (SPEC §3)

const SCIENCE_SAMPLE_TICKS = 3600
/** Samples kept (game minutes): an 8-hour run plus margin. */
const SCIENCE_MAX_SAMPLES = 600

export function researchDone(force: LuaForce): boolean {
  for (const t of researchGoal()) if (!force.technologies[t]?.researched) return false
  return true
}

/** Once per game minute: packs made and used, the `automated:<pack>`, `science-sustained`, `research-goal-done` and `v1-done` milestones. */
export function sampleScience(ctx: { f: FactoryState; faction: FactionState; force: LuaForce; surface: LuaSurface; tick: number; config: Config }, automated: Record<string, boolean>, mark: (this: void, name: string) => void): void {
  const f = ctx.f
  const brain = ctx.faction.brain!
  if (brain.milestones["research-goal-done"] === undefined && researchDone(ctx.force)) mark("research-goal-done")
  f.science ??= { samples: [], best: 0 }
  const sc = f.science
  const last = sc.samples[sc.samples.length - 1]
  if (last !== undefined && ctx.tick - last.tick < SCIENCE_SAMPLE_TICKS) return
  const stages = parseStages(ctx.config.factoryTargets)
  const target = stages[stages.length - 1] ?? []
  const stats = ctx.force.get_item_production_statistics(ctx.surface)
  const made: Record<string, number> = {}
  const used: Record<string, number> = {}
  for (const t of target) {
    made[t.item] = stats.get_input_count(t.item)
    used[t.item] = stats.get_output_count(t.item)
  }
  sc.samples.push({ tick: ctx.tick, made, used })
  if (sc.samples.length > SCIENCE_MAX_SAMPLES) sc.samples.shift()
  // Automated packs beyond the first (green): its producer is built and the labs used some.
  for (const t of target) if (brain.milestones[`automated:${t.item}`] === undefined && automated[t.item] && used[t.item] >= 10) mark(`automated:${t.item}`)
  // Sustained: every pack over the window at its target rate.
  const window = ctx.config.factorySustainMinutes
  const n = sc.samples.length
  if (n <= window || target.length === 0) return
  const then = sc.samples[n - 1 - window]
  const minutes = (ctx.tick - then.tick) / 3600
  let worst = math.huge
  const rates: Record<string, number> = {}
  for (const t of target) {
    const r = (used[t.item] - (then.used[t.item] ?? 0)) / minutes
    rates[t.item] = r
    worst = math.min(worst, r / t.perMinute)
  }
  sc.rates = rates
  if (worst > sc.best) {
    sc.best = worst
    sc.bestTick = ctx.tick
  }
  if (worst >= 1 && brain.milestones["science-sustained"] === undefined) {
    mark("science-sustained")
    log(`[rival-engineers] faction ${ctx.faction.name}: science sustained over ${window} min: ${target.map((t) => `${t.item} ${string.format("%.1f", rates[t.item])}/min`).join(", ")}`)
  }
  if (brain.milestones["science-sustained"] !== undefined && brain.milestones["research-goal-done"] !== undefined) mark("v1-done")
}

