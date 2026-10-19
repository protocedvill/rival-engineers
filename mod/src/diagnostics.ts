import { getConfig } from "./config"
import { rawHoldings, takeable } from "./jobs/supply"
import { boardDiagnostics, DiagnosticCrew, DiagnosticJob, DiagnosticViolation } from "./diagnostics-core"

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
}

export interface FactionDiagnostics {
  invariants: DiagnosticViolation[]
  jobs: DiagnosticJob[]
  goals: DiagnosticGoal[]
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
    out.push({ id: goal.id, status: goal.status, plan: goal.plan, plannerPhase: entry?.phase, buildPhase: entry?.build?.phase ?? goal.growBuild?.phase, jobs })
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
  const raw: Record<string, { amount: number; sources: number }> = {}
  for (const holding of rawHoldings(faction)) {
    const item = (raw[holding.item] ??= { amount: 0, sources: 0 })
    item.amount += holding.amount
    item.sources++
  }
  const available: Record<string, number> = {}
  for (const holding of takeable(faction, getConfig().supplyMinTake)) available[holding.item] = (available[holding.item] ?? 0) + holding.amount
  for (const job of diagnosed.jobs) {
    if (job.materials === undefined) continue
    for (const item of job.materials) {
      item.raw = raw[item.item]?.amount ?? 0
      item.sources = raw[item.item]?.sources ?? 0
      item.takeable = available[item.item] ?? 0
    }
  }
  for (const memberId of faction.crew) if (storage.crew[memberId] === undefined) diagnosed.invariants.push({ code: "crew-member-missing", detail: `faction lists absent crew ${memberId}` })
  return { invariants: diagnosed.invariants, jobs: diagnosed.jobs, goals: goals(name) }
}
