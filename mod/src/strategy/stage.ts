import { LuaForce, LuaSurface } from "factorio:runtime"
import { Config } from "../config"
import { FactionState } from "../jobs/types"
import { curatedIds, curatedModule } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { nodeByRole, rateIn } from "../planner/logical"
import { tiers } from "../planner/runtime"
import { maxUnitTime, meanUnitTime, researchGoal } from "./research-queue"
import type { FactoryState } from "./factory"

// M6 stage helpers (split out of factory.ts, whose main chunk hit Lua's 200-local limit): stage targets, lab sizing per
// stage, the design's curated fallbacks, shared fuel and a second steam block, and the science-throughput sampling that
// checks the v1 bar (SPEC §3).

/** A grow whose expansion failed this many times no longer holds its stage (M6). */
export const GROW_MAX_FAILS = 3

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
 * M6: from stage `factory-shared-fuel` on (1-based; 0 = never) and once splitters can be built, new fuel consumers share
 * one fuel producer per cluster; consumers that have their own keep it.
 */
export function sharedFuel(ctx: { faction: FactionState; force: LuaForce; config: Config }, f: FactoryState | undefined, stage: number): { keep: Record<string, boolean> } | undefined {
  const from = ctx.config.factorySharedFuel
  if (from <= 0 || stage + 1 < from || !splittersEnabled(ctx.force)) return undefined
  const fuel = ctx.faction.brain!.catalog.fuel
  // Consumers fed fuel already (their own producer or an earlier shared one) keep it: a new group never taps a built
  // route.
  const keep: Record<string, boolean> = {}
  if (f !== undefined) {
    for (const id of f.graph.edgeOrder) {
      const e = f.graph.edges[id]
      if (e.kind === "belt" && e.item === fuel && f.graph.nodes[e.to] !== undefined) keep[f.graph.nodes[e.to].role] = true
    }
  }
  return { keep }
}

/** M6: the built steam block's capacity once its growth keeps failing (the design then adds a second one). */
export function powerCap(f: FactoryState | undefined): number | undefined {
  if (f === undefined || (f.growFails?.["power"] ?? 0) < GROW_MAX_FAILS) return undefined
  const n = nodeByRole(f.graph, "power")
  return n !== undefined ? rateIn(n.capacity.outputs, "electricity") : undefined
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

