// Provider handover (provider-group refactor, goalpost 1): "a provider is never deconstructed before a replacement can
// serve its obligations". A retiring provider (worked-out mine, burner-drill outpost, fuel supply running low) keeps its
// module and its routes until a replacement feeds every consumer port it served; only then is it deconstructed.
//
// This is the pure decision boundary, like `relocation.ts` and `providers.ts`: `strategy/factory.ts` owns the state and
// performs the deconstruction, this module only decides. Pure: no Factorio globals (T1: mod/unit/handover.test.ts).

/** One provider being retired while its replacement is planned, built and connected. */
export interface HandoverRecord {
  /** Role being retired (the replacement gets a distinct parallel role). */
  role: string
  /** Graph node id of the retiring provider. */
  node: string
  /** Tick the handover started. */
  since: number
  /** Why it is retiring (a provider failure reason, for telemetry and the log). */
  why: string
}

/** One belt feed between two graph nodes, as the handover decision sees it. */
export interface HandoverFeed {
  role: string
  node: string
  toModule: string
  toPort: string
  /** The feeding node is built, not still being constructed. */
  built: boolean
}

export type HandoverVerdict = "complete" | "waiting" | "stalled"

/** Marks `role` as retiring. Returns false when it already is (the first reason and tick are kept). */
export function beginHandover(records: Record<string, HandoverRecord>, role: string, node: string, tick: number, why: string): boolean {
  if (records[role] !== undefined) return false
  records[role] = { role, node, since: tick, why }
  return true
}

/** The distinct consumer ports `role` feeds, as `module.port` keys in feed order. */
export function servedPorts(feeds: HandoverFeed[], role: string): string[] {
  const out: string[] = []
  for (const f of feeds) {
    if (f.role !== role) continue
    const p = `${f.toModule}.${f.toPort}`
    if (out.indexOf(p) < 0) out.push(p)
  }
  return out
}

/**
 * Whether the retirement may proceed.
 *
 * `complete`: every consumer port the retiring role fed is fed by another **built** provider (or it fed nothing).
 * `waiting`: at least one port has no built replacement yet, and the handover is younger than `maxMinutes`.
 * `stalled`: the same, but the handover has waited `maxMinutes` game-minutes: the caller retires the provider anyway so
 * a replacement that can never be built (no ore left anywhere) cannot starve the consumers forever.
 */
export function handoverVerdict(r: HandoverRecord, feeds: HandoverFeed[], tick: number, maxMinutes: number): HandoverVerdict {
  const ports = servedPorts(feeds, r.role)
  if (ports.length === 0) return "complete"
  for (const port of ports) {
    let covered = false
    for (const f of feeds) {
      if (!f.built || f.role === r.role) continue
      if (`${f.toModule}.${f.toPort}` !== port) continue
      covered = true
      break
    }
    if (!covered) return tick - r.since >= maxMinutes * 3600 ? "stalled" : "waiting"
  }
  return "complete"
}

/** Drops records whose role is no longer in the graph; returns whether any remain. */
export function pruneHandovers(records: Record<string, HandoverRecord>, roles: string[]): boolean {
  let left = 0
  for (const [role] of pairs(records)) {
    if (roles.indexOf(role as string) < 0) delete records[role as string]
    else left++
  }
  return left > 0
}
