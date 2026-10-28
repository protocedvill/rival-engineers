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
  materials?: { item: string; needed: number; raw?: number; takeable?: number; sources?: number; sourceDetail?: { unit: number; depot: boolean; raw: number; reserved: number; takeable: number; excluded?: string }[] }[]
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
  // Dependency cycles can never become ready. Report each cycle once at its lowest job id.
  const visiting: Record<number, boolean> = {}
  const visited: Record<number, boolean> = {}
  const cycleKeys: Record<string, boolean> = {}
  const path: number[] = []
  const walk = (id: number): void => {
    if (visiting[id]) {
      const at = path.indexOf(id)
      const cycle = path.slice(at).concat(id)
      const body = cycle.slice(0, cycle.length - 1)
      let lowestAt = 0
      for (let i = 1; i < body.length; i++) if (body[i] < body[lowestAt]) lowestAt = i
      const normalized = body.slice(lowestAt).concat(body.slice(0, lowestAt))
      normalized.push(normalized[0])
      const key = normalized.join(":")
      if (!cycleKeys[key]) {
        cycleKeys[key] = true
        invariants.push({ code: "dependency-cycle", detail: normalized.join(" -> ") })
      }
      return
    }
    if (visited[id]) return
    const job = board.jobs[id]
    if (job === undefined) return
    visiting[id] = true
    path.push(id)
    for (const dep of job.deps) walk(dep)
    path.pop()
    delete visiting[id]
    visited[id] = true
  }
  for (const id of board.active) walk(id)
  return { invariants, jobs }
}

/**
 * `build-job-missing`: an active goal's build references a job that is no longer on the board. Only planning or
 * building goals count: a finished build's jobs leave the board when they complete, and a done or failed goal keeps
 * their ids (every long run reported hundreds of these from done goals).
 */
export function goalJobInvariants(goals: { id: string; status: string; jobs: number[] }[], onBoard: (id: number) => boolean): DiagnosticViolation[] {
  const out: DiagnosticViolation[] = []
  for (const goal of goals) {
    if (goal.status !== "planning" && goal.status !== "building") continue
    for (const id of goal.jobs) if (!onBoard(id)) out.push({ code: "build-job-missing", detail: `goal ${goal.id} references absent job ${id}` })
  }
  return out
}
