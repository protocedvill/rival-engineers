import type { JobId } from "./shared/ids"
import { getConfig } from "./config"
import { rawHoldings, reservedAt, takeable } from "./jobs/supply"
import { boardDiagnostics, DiagnosticCrew, DiagnosticJob, DiagnosticViolation, goalJobInvariants } from "./diagnostics-core"
import { detectChurn, DiagnosticEventBuckets, recentDiagnosticBuckets, ChurnFinding } from "./diagnostic-events"
import { findModule } from "./planner/layout"
import { checkClaimOwners } from "./planner/claims"
import { PlanEvidence, PlanStats } from "./planner/plan"
import { checkWorldClaimOwners, mineClaim, moduleClaim, poleClaim, routeClaim, siteClaim } from "./world/claim-index"

// Read-only causal views and invariant checks. These deliberately do not participate in decisions: telemetry and
// remote probes may call them without changing the simulation. Reason codes are stable so host-side tools do not have
// to parse prose from logs.

export interface DiagnosticGoal {
  id: string
  status: string
  plan?: string
  plannerPhase?: string
  buildPhase?: string
  jobs: number[]
  failures?: Record<string, string>
  evidence?: PlanEvidence[]
  stats?: PlanStats
}

export interface FactionDiagnostics {
  invariants: DiagnosticViolation[]
  jobs: DiagnosticJob[]
  goals: DiagnosticGoal[]
  events: DiagnosticEventBuckets
  churn: ChurnFinding[]
}

function addUnique(into: number[], ids: number[]): void {
  for (const id of ids) if (into.indexOf(id) < 0) into.push(id)
}

function goals(name: string): DiagnosticGoal[] {
  const out: DiagnosticGoal[] = []
  const factory = storage.factories?.[name]
  if (factory === undefined) return out
  for (const goal of factory.goals) {
    if (goal.status === "done" || goal.status === "failed") continue
    const entry = goal.plan !== undefined ? storage.planner?.entries[goal.plan] : undefined
    const jobs: number[] = []
    if (entry?.build !== undefined) {
      addUnique(jobs, entry.build.clearJobs)
      addUnique(jobs, entry.build.placeJobs)
    }
    if (goal.growBuild !== undefined) {
      addUnique(jobs, goal.growBuild.clearJobs)
      addUnique(jobs, goal.growBuild.placeJobs)
    }
    out.push({ id: goal.id, status: goal.status, plan: goal.plan, plannerPhase: entry?.phase, buildPhase: entry?.build?.phase ?? goal.growBuild?.phase, jobs, failures: entry?.job?.failures, evidence: entry?.job?.evidence, stats: entry?.job?.stats })
  }
  return out
}

/** A compact explanation of the faction's cross-layer state, safe to call from telemetry or a remote probe. */
export function factionDiagnostics(name: string, maxJobs = 64): FactionDiagnostics | undefined {
  const faction = storage.factions[name]
  if (faction === undefined) return undefined
  const board = faction.board
  const crew: Record<number, DiagnosticCrew> = {}
  for (const memberId of faction.crew) {
    const member = storage.crew[memberId]
    if (member === undefined) {
      crew[memberId] = { claims: [] }
    } else crew[memberId] = { claims: member.claims }
  }
  const diagnosed = boardDiagnostics(board, crew, game.tick, maxJobs)
  const config = getConfig()
  const raw: Record<string, { amount: number; sources: number; detail: { unit: number; depot: boolean; raw: number; reserved: number; takeable: number; excluded?: string }[] }> = {}
  for (const holding of rawHoldings(faction)) {
    const item = (raw[holding.item] ??= { amount: 0, sources: 0, detail: [] })
    item.amount += holding.amount
    item.sources++
    const reserved = reservedAt(faction, holding.entity, holding.item)
    const available = math.max(0, holding.amount - reserved)
    const excluded = available <= 0 ? "reserved" : !holding.depot && available < config.supplyMinTake ? `below minimum ${config.supplyMinTake}` : undefined
    item.detail.push({ unit: holding.entity.unit_number ?? -1, depot: holding.depot, raw: holding.amount, reserved, takeable: excluded === undefined ? available : 0, excluded })
  }
  const available: Record<string, number> = {}
  for (const holding of takeable(faction, config.supplyMinTake)) available[holding.item] = (available[holding.item] ?? 0) + holding.amount
  for (const job of diagnosed.jobs) {
    if (job.materials === undefined) continue
    for (const item of job.materials) {
      item.raw = raw[item.item]?.amount ?? 0
      item.sources = raw[item.item]?.sources ?? 0
      item.takeable = available[item.item] ?? 0
      item.sourceDetail = raw[item.item]?.detail ?? []
    }
  }
  for (const memberId of faction.crew) if (storage.crew[memberId] === undefined) diagnosed.invariants.push({ code: "crew-member-missing", detail: `faction lists absent crew ${memberId}` })
  for (const point of faction.supplies ?? []) if (!point.entity.valid) diagnosed.invariants.push({ code: "supply-entity-invalid", detail: `registered supply entity is invalid` })
  const factory = storage.factories?.[name]
  if (factory !== undefined) {
    for (const goal of factory.goals) {
      const entry = goal.plan !== undefined ? storage.planner?.entries[goal.plan] : undefined
      if ((goal.status === "planning" || (goal.status === "building" && goal.growBuild === undefined)) && goal.plan !== undefined && entry === undefined) diagnosed.invariants.push({ code: "goal-plan-missing", detail: `goal ${goal.id} references absent plan ${goal.plan}` })
      if (entry?.faction !== undefined && entry.faction !== name) diagnosed.invariants.push({ code: "goal-plan-faction", detail: `goal ${goal.id} plan ${entry.id} belongs to ${entry.faction}` })
      const jobs: number[] = [...(entry?.build?.clearJobs ?? []), ...(entry?.build?.placeJobs ?? []), ...(goal.growBuild?.clearJobs ?? []), ...(goal.growBuild?.placeJobs ?? [])]
      for (const v of goalJobInvariants([{ id: goal.id, status: goal.status, jobs }], (id) => faction.board.jobs[id as JobId] !== undefined)) diagnosed.invariants.push(v)
    }
    for (const [, node] of pairs(factory.graph.nodes)) if ((node.lifecycle === "building" || node.lifecycle === "built") && node.module !== undefined && findModule(factory.layout, node.id) === undefined) diagnosed.invariants.push({ code: "logical-module-missing", detail: `node ${node.id} (${node.role}) is ${node.lifecycle} without layout module` })
  }
  // World claims: every tagged reservation must name a live site, module, route, pole or mine. Untagged tiles are
  // compatible old-save entries and stay unreported; one-sided owner entries are always a bug.
  const brain = faction.brain
  if (brain !== undefined) {
    const live: Record<string, boolean> = {}
    for (const site of brain.sites) if (site.status !== "retired") live[siteClaim(site.id)] = true
    const layout = factory?.layout
    if (layout !== undefined) {
      for (const m of layout.modules) live[moduleClaim(m.id)] = true
      for (const id of layout.routeOrder) live[routeClaim(id)] = true
      for (const p of layout.poles ?? []) live[poleClaim(p.id)] = true
      for (const [, owner] of pairs(layout.mine ?? {})) live[mineClaim(owner as string)] = true
      for (const problem of checkClaimOwners(layout)) diagnosed.invariants.push({ code: "layout-claim", detail: problem })
    }
    for (const problem of checkWorldClaimOwners(brain, live)) diagnosed.invariants.push({ code: "world-claim", detail: problem })
  }
  let preemptions = 0
  let preemptTaken = 0
  for (const memberId of faction.crew) {
    const member = storage.crew[memberId]
    preemptions += member?.stats.preemptions ?? 0
    preemptTaken += member?.stats.preemptTaken ?? 0
  }
  let planFailures = 0
  let planSuccesses = 0
  for (const goal of factory?.goals ?? []) {
    if (goal.status === "failed") planFailures += goal.attempts
    else if (goal.status === "done") planSuccesses++
  }
  const churn = detectChurn({ claims: faction.board.counters.claims, releases: faction.board.counters.releases, completions: faction.board.counters.completions, preemptions, preemptTaken, planFailures, planSuccesses })
  return { invariants: diagnosed.invariants, jobs: diagnosed.jobs, goals: goals(name), events: recentDiagnosticBuckets(faction), churn }
}
