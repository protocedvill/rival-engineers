// Research and hand-fed labs (split out of `factory.ts`, M7a: its compiled chunk was at Lua's local-variable limit).
// Picks the next technology for the faction's labs and, until a pack is automated, has the crew hand-craft it and put
// it into the labs.

import { LuaEntity } from "factorio:runtime"
import { keyTaken } from "../jobs/keys"
import { addJob, failJob, JobSpec } from "../jobs/board"
import { JobPayload } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import * as LO from "../planner/layout"
import * as LG from "../planner/logical"
import type { LogicalNode } from "../planner/logical"
import { findEntities } from "../work"
import type { Design } from "./design"
import type { Ctx, FactoryState } from "./factory"
import { startResearch } from "./research-queue"
import { mark } from "./milestone"

/** Hand-fed labs: a feed job when a lab holds fewer than `low` of a pack; each job brings `feed`. */
const LAB = { low: 2, feed: 5 }

export function packsAutomated(f: FactoryState): Record<string, boolean> {
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

export function labsBuilt(f: FactoryState): LogicalNode[] {
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

export function research(ctx: Ctx, d: Design | undefined): void {
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

export function labEntities(ctx: Ctx, node: LogicalNode): LuaEntity[] {
  const m = LO.findModule(ctx.f.layout, node.id)
  if (m === undefined) return []
  return findEntities(ctx.surface, { type: "lab", force: ctx.faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
}

export function addKeyed(ctx: Pick<Ctx, "faction" | "f" | "tick">, key: string, spec: JobSpec<JobPayload>): void {
  const job = addJob(ctx.faction.board, spec, ctx.tick)
  ctx.f.jobKeys[key] = job.id
}

/** Until a pack is automated, the crew hand-craft it and put it into the labs (the bootstrap crafts the materials). */
export function handFeed(ctx: Ctx): void {
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
        if (inv.get_item_count(ing.name) >= LAB.low || keyTaken(ctx.f, ctx.faction.board.jobs, key, ctx.tick)) continue
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
// Milestones: first power and automated science

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

export function milestones(ctx: Ctx): void {
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
