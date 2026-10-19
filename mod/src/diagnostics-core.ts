import { Board, Job } from "./jobs/board"

// Pure blocker classification and Job Board invariants. Runtime diagnostics enrich this with Factorio holdings and
// factory/planner links; keeping this half pure makes the causal vocabulary cheap to pin in T1.

export interface DiagnosticViolation {
  code: string
  detail: string
}

export interface DiagnosticJob {
  id: number
  kind: string
  status: string
  blocker: "claimed" | "backoff" | "dependency-missing" | "dependency-open" | "dependency-failed" | "board-ready"
  relatedJob?: number
  detail?: string
  materials?: { item: string; needed: number; raw?: number; takeable?: number; sources?: number }[]
}

export interface DiagnosticCrew {
  claims: number[]
}

function hasClaim(crew: Record<number, DiagnosticCrew>, member: number, job: number): boolean {
  const m: DiagnosticCrew | undefined = crew[member]
  return m !== undefined && m.claims.indexOf(job) >= 0
}

function materials(job: Job<unknown>): string | undefined {
  if (job.materials.length === 0) return undefined
  const out: string[] = []
  for (const item of job.materials) out.push(`${item.count} ${item.item}`)
  return out.join(", ")
}

function diagnoseJob(board: Board<unknown>, job: Job<unknown>, tick: number): DiagnosticJob {
  if (job.status === "claimed") return { id: job.id, kind: job.kind, status: job.status, blocker: "claimed", detail: `crew ${job.claimedBy}` }
  if (job.retryAt > tick) return { id: job.id, kind: job.kind, status: job.status, blocker: "backoff", detail: `until tick ${job.retryAt}${job.reason !== undefined ? `: ${job.reason}` : ""}` }
  for (const dep of job.deps) {
    const d: Job<unknown> | undefined = board.jobs[dep]
    if (d === undefined) return { id: job.id, kind: job.kind, status: job.status, blocker: "dependency-missing", relatedJob: dep }
    if (d.status === "failed") return { id: job.id, kind: job.kind, status: job.status, blocker: "dependency-failed", relatedJob: dep, detail: d.reason }
    if (d.status !== "done") return { id: job.id, kind: job.kind, status: job.status, blocker: "dependency-open", relatedJob: dep, detail: `${d.kind}/${d.status}` }
  }
  const needed: { item: string; needed: number }[] = []
  for (const item of job.materials) needed.push({ item: item.item, needed: item.count })
  return { id: job.id, kind: job.kind, status: job.status, blocker: "board-ready", detail: materials(job), materials: needed }
}

export function boardDiagnostics(board: Board<unknown>, crew: Record<number, DiagnosticCrew>, tick: number, maxJobs = 64): { invariants: DiagnosticViolation[]; jobs: DiagnosticJob[] } {
  const invariants: DiagnosticViolation[] = []
  const jobs: DiagnosticJob[] = []
  for (const id of board.active) {
    const job: Job<unknown> | undefined = board.jobs[id]
    if (job === undefined) {
      invariants.push({ code: "active-job-missing", detail: `active id ${id} has no job` })
      continue
    }
    if (job.status === "done" || job.status === "failed") invariants.push({ code: "terminal-job-active", detail: `job ${id} is ${job.status}` })
    if (job.status === "claimed") {
      if (job.claimedBy === undefined) invariants.push({ code: "claimant-missing", detail: `job ${id} is claimed without claimedBy` })
      else if (crew[job.claimedBy] === undefined) invariants.push({ code: "claimant-unknown", detail: `job ${id} names crew ${job.claimedBy}` })
      else if (!hasClaim(crew, job.claimedBy, id)) invariants.push({ code: "claim-not-reciprocal", detail: `job ${id} names crew ${job.claimedBy}, but the member does not hold it` })
    } else if (job.claimedBy !== undefined) {
      invariants.push({ code: "unclaimed-has-claimant", detail: `job ${id} is ${job.status} but names crew ${job.claimedBy}` })
    }
    for (const dep of job.deps) if (board.jobs[dep] === undefined) invariants.push({ code: "dependency-missing", detail: `job ${id} depends on absent job ${dep}` })
    if (jobs.length < maxJobs && (job.status === "open" || job.status === "claimed")) jobs.push(diagnoseJob(board, job, tick))
  }
  for (const [memberId, member] of pairs(crew)) {
    for (const jobId of member.claims) {
      const job: Job<unknown> | undefined = board.jobs[jobId]
      if (job === undefined) invariants.push({ code: "member-claim-missing", detail: `crew ${memberId} holds absent job ${jobId}` })
      else if (job.status !== "claimed" || job.claimedBy !== memberId) invariants.push({ code: "member-claim-not-reciprocal", detail: `crew ${memberId} holds job ${jobId}, which is ${job.status} by ${job.claimedBy}` })
    }
  }
  return { invariants, jobs }
}
