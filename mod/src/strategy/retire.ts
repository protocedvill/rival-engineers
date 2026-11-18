// D76 (user decision in-session 2026-10-30; replaces goalpost 1's verified handover): a provider that must go (a mine
// running out, a burner-drill outpost once electric drills exist, a steam block's fuel running low) is marked retiring.
// The design plans a parallel provider for its consumers (provider-group rule) while the old one keeps producing; it
// is deconstructed once its drills run dry, or once every consumer port it feeds is also fed by a built provider that
// did not feed that port when it began retiring (its replacement). No route survives its module, and there is no time
// limit: a provider whose replacement can never be built keeps producing.
//
// The replacement is judged by the ports, not by the provider family: parallel providers of one family serve different
// consumers (fixed seed 222: `iron-ore>…labs~2` fed the parallel smelter while the family's first mine fed the first
// one), so a new mine of the family is not necessarily this one's replacement.
//
// This is the pure decision boundary, like `relocation.ts` and `providers.ts`: `strategy/fuel.ts` owns the state and
// performs the deconstruction, this module only decides. Pure: no Factorio globals (T1: mod/unit/retire.test.ts).

/** One provider being retired while its replacement is planned and built. */
export interface RetireRecord {
  /** Role being retired (the replacement gets a distinct parallel role). */
  role: string
  /** Graph node id of the retiring provider. */
  node: string
  /** Tick it began retiring. */
  since: number
  /** Why it is retiring (for telemetry and the log). */
  why: string
  /** Built providers that already fed one of its consumer ports when it began retiring (`role@port`): none replaces it. */
  had: string[]
}

/** One belt feed between two graph nodes, as the retirement decision sees it. */
export interface RetireFeed {
  /** The providing node's role. */
  role: string
  /** The consumer port it feeds (`module.port`). */
  port: string
  /** The provider is built (not still being constructed). */
  built: boolean
}

function portsOf(feeds: RetireFeed[], role: string): string[] {
  const out: string[] = []
  for (const f of feeds) if (f.role === role && out.indexOf(f.port) < 0) out.push(f.port)
  return out
}

/** Marks `role` as retiring. Returns false when it already is (the first reason and tick are kept). */
export function beginRetire(records: Record<string, RetireRecord>, role: string, node: string, tick: number, why: string, feeds: RetireFeed[]): boolean {
  if (records[role] !== undefined) return false
  const ports = portsOf(feeds, role)
  const had: string[] = []
  for (const f of feeds) if (f.built && f.role !== role && ports.indexOf(f.port) >= 0) had.push(`${f.role}@${f.port}`)
  records[role] = { role, node, since: tick, why, had }
  return true
}

/**
 * The provider that replaced `r` on its first consumer port, once every port it feeds is fed by a built provider that
 * did not feed that port when it began retiring; `""` when it feeds nothing; undefined while any port waits.
 */
export function replacement(r: RetireRecord, feeds: RetireFeed[]): string | undefined {
  const ports = portsOf(feeds, r.role)
  if (ports.length === 0) return ""
  let first: string | undefined
  for (const port of ports) {
    let by: string | undefined
    for (const f of feeds) if (f.built && f.port === port && f.role !== r.role && r.had.indexOf(`${f.role}@${port}`) < 0) by = by ?? f.role
    if (by === undefined) return undefined
    first = first ?? by
  }
  return first
}

/** Whether the provider goes now: its drills ran dry, or its replacement feeds every consumer port it fed. */
export function shouldRetire(r: RetireRecord, dry: boolean, feeds: RetireFeed[]): boolean {
  return dry || replacement(r, feeds) !== undefined
}

/** Drops records whose role is no longer in the graph; returns whether any remain. */
export function pruneRetiring(records: Record<string, RetireRecord>, roles: string[]): boolean {
  let left = 0
  for (const [role] of pairs(records)) {
    if (roles.indexOf(role as string) < 0) delete records[role as string]
    else left++
  }
  return left > 0
}

// proto/mine-fade (user request in-session 2026-11-18, prototype): a worn mine is not retired whole. It "fades": it keeps
// every drill and its belt, and the design sees its capacity step down as its drills run dry. The B60 short-provider
// path plans one parallel provider (its heir) for the gap and grows that heir at each later step; the old mine is
// deconstructed only once every drill is dry.

/** One mine fading out while its heir takes over its consumers step by step. */
export interface FadeRecord {
  role: string
  node: string
  since: number
  why: string
  /** Its full output (items/s) when it began fading. */
  full: number
  /** Capacity the design gives it now (items/s): `full` times the drill share still mining, rounded down to a step. */
  cap: number
}

/** The last step's capacity: positive (the design keeps the old mine and its consumers' ports), but nearly nothing. */
export const FADE_LAST = 1e-3

/** The capacity a fading mine is planned at, with `live` of its drills (0..1) still mining and steps of `step`. */
export function fadeCap(full: number, live: number, step: number): number {
  if (step <= 0) return full
  const q = math.floor(live / step + 1e-9) * step
  return q > 0 ? full * math.min(1, q) : math.min(full, FADE_LAST)
}
