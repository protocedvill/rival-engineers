// Debug probe (remote `board_summary`): the board's active jobs grouped by what queued them, to diagnose a backlog
// (M7c.7 observation: ~800 ready, unclaimed fuel jobs around minute 30 of seed 11).

import { getConfig } from "../config"
import { isReady } from "./board"
import { takeable } from "./supply"
import type { FactionState } from "./types"

interface Group {
  jobs: number
  claimed: number
  /** Open, with a dependency not done yet. */
  deps: number
  /** Open, backing off after a failed attempt. */
  backoff: number
  ready: number
  /** Ready jobs whose materials the crew could take now (stockpiles and supply points, less reservations). */
  readyStocked: number
  /** Item counts the ready jobs need. */
  need: Record<string, number>
  /** Oldest job, in game ticks. */
  maxAge: number
  priority: number
  samples: number[]
}

/** The key prefix (`fuel`, `upkeep`, `labfeed`, `feed`...) of each keyed job, by job id. */
function keyPrefixes(faction: FactionState): Record<number, string> {
  const out: Record<number, string> = {}
  const add = (keys: Record<string, number> | undefined): void => {
    for (const [key, id] of pairs(keys ?? {})) out[id] = string.match(key, "^([^:]*)")[0] ?? key
  }
  add(faction.brain?.jobKeys)
  add(storage.factories?.[faction.name]?.jobKeys)
  return out
}

export function boardSummary(faction: FactionState, tick: number): { groups: Record<string, Group>; available: Record<string, number>; crew: number; active: number } {
  const board = faction.board
  const available: Record<string, number> = {}
  for (const h of takeable(faction, getConfig().supplyMinTake)) available[h.item] = (available[h.item] ?? 0) + h.amount
  const prefix = keyPrefixes(faction)
  const groups: Record<string, Group> = {}
  for (const id of board.active) {
    const job = board.jobs[id]
    const p = job.payload as { kind: string; item?: string; recipe?: string; target?: { valid: boolean; name?: string } }
    const target = p.target !== undefined && p.target.valid ? p.target.name : undefined
    const name = `${prefix[id] ?? "-"} ${job.kind}/${p.kind} ${p.item ?? p.recipe ?? ""} ${target ?? ""}`
    const g = (groups[name] ??= { jobs: 0, claimed: 0, deps: 0, backoff: 0, ready: 0, readyStocked: 0, need: {}, maxAge: 0, priority: job.priority, samples: [] })
    g.jobs++
    g.maxAge = math.max(g.maxAge, tick - job.createdTick)
    if (g.samples.length < 3) g.samples.push(id)
    if (job.status === "claimed") g.claimed++
    else if (isReady(board, job, tick)) {
      g.ready++
      let stocked = true
      for (const m of job.materials) {
        g.need[m.item] = (g.need[m.item] ?? 0) + m.count
        if ((available[m.item] ?? 0) < m.count) stocked = false
      }
      if (stocked) g.readyStocked++
    } else if (job.retryAt > tick) g.backoff++
    else g.deps++
  }
  let crew = 0
  for (const id of faction.crew) if (!storage.crew[id].dead) crew++
  return { groups, available, crew, active: board.active.length }
}
