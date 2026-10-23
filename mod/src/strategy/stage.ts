import { LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { curatedIds, curatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { nodeByRole, rateIn } from "../planner/logical"
import { findModule } from "../planner/layout"
import { tiers } from "../planner/runtime"
import { maxUnitTime, meanUnitTime, researchGoal } from "./research-queue"
import type { FactoryState } from "./factory"

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
export function sharing(ctx: { config: Config; force: LuaForce }, f: FactoryState | undefined, stage: number, force = false): { keep: Record<string, string>; spare: Record<string, Record<string, number>>; fallback?: Record<string, string[]> } | undefined {
  const from = ctx.config.factorySharedProviders
  if (from <= 0 || stage + 1 < from || (!force && !splittersEnabled(ctx.force))) return undefined
  const keep: Record<string, string> = {}
  const spare: Record<string, Record<string, number>> = {}
  if (f !== undefined) {
    const out: Record<string, number> = {}
    for (const id of f.graph.edgeOrder) {
      const e = f.graph.edges[id]
      if (e.kind !== "belt" || e.from === undefined) continue
      const p = f.graph.nodes[e.from]
      const c = f.graph.nodes[e.to]
      if (p === undefined || c === undefined) continue
      keep[`${e.item}@${c.role}`] = p.role
      out[p.id] = (out[p.id] ?? 0) + e.plannedRate
    }
    for (const [id, used] of pairs(out)) {
      const p = f.graph.nodes[id as string]
      if (p.item === undefined || f.noTap?.[p.role] || f.providerShort?.[p.role]) continue
      const room = rateIn(p.capacity.outputs, p.item) - (used as number)
      if (room <= 0) continue
      spare[p.item] ??= {}
      spare[p.item][p.role] = room
    }
  }
  return { keep, spare, fallback: fallbackProducers(f) }
}

/**
 * P36 (b, proposed): for each item whose new producer could not be placed (`FactoryState.fallback`), the built producers
 * of it new consumers tap instead, nearest the hub first (growable ones before those whose growth keeps failing). Never
 * one that is not tapped again (`noTap`).
 */
export function fallbackProducers(f: FactoryState | undefined): Record<string, string[]> | undefined {
  if (f?.fallback === undefined) return undefined
  let out: Record<string, string[]> | undefined
  for (const [item] of pairs(f.fallback)) {
    const list: { role: string; key: number }[] = []
    for (const id of f.graph.nodeOrder) {
      const n = f.graph.nodes[id]
      if (n.item !== item || n.kind !== "module" || n.lifecycle !== "built" || f.noTap?.[n.role] || f.providerShort?.[n.role]) continue
      const m = findModule(f.layout, id)
      if (m === undefined) continue
      const dx = m.rect.x + m.rect.w / 2 - f.center.x
      const dy = m.rect.y + m.rect.h / 2 - f.center.y
      const blocked = (f.growFails?.[n.role] ?? 0) >= GROW_MAX_FAILS ? 1e9 : 0
      list.push({ role: n.role, key: blocked + dx * dx + dy * dy })
    }
    list.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.role < b.role ? -1 : 1))
    if (list.length === 0) continue
    out ??= {}
    out[item as string] = list.map((x) => x.role)
  }
  return out
}

/** M6: the built steam block's capacity once its growth keeps failing (the design then adds a second one). */
/**
 * M6: the largest share of the stage target cluster 1 may take, from its modules that can't grow (`cluster1Caps`: role →
 * the share it could still serve when its growth failed for good). Undefined: no cap.
 */
export function cluster1Max(f: FactoryState | undefined): number | undefined {
  let out: number | undefined
  for (const [, v] of pairs(f?.cluster1Caps ?? {})) out = math.min(out ?? 1, v as number)
  return out
}

export function powerCap(f: FactoryState | undefined): number | undefined {
  if (f === undefined) return undefined
  // M6/B29: this is only for a steam block whose own growth keeps failing. A short fuel producer is a provider-group
  // shortfall (B60): it keeps feeding the existing block and the design adds a parallel coal provider, not a second
  // power block with its own mine.
  let failed = false
  for (const [role, n] of pairs(f.growFails ?? {})) {
    const r = role as string
    if ((string.match(r, "^power#?%d*$")[0] !== undefined) && (n as number) >= GROW_MAX_FAILS) failed = true
  }
  if (!failed) return undefined
  const n = nodeByRole(f.graph, "power")
  return n !== undefined ? rateIn(n.capacity.outputs, "electricity") : undefined
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

/** B60: roles the design must not grow or tap for new consumers. */
export function providerShort(f: FactoryState | undefined): Record<string, boolean> | undefined {
  return f?.providerShort
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

