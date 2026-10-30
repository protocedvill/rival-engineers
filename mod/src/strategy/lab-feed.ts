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
