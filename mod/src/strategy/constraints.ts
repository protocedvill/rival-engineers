// D69 (user decision in-session 2026-10-29, done in M7a): one store for the constraints the factory learns from failed
// plans and growths, instead of a flag map per bug on `FactoryState`. Each kind has a scope that says what its keys name:
//
//   provider  a provider role (`coal>power`, `iron-plate>labs~2`)
//   feed      one provider → consumer port (`feedKey`: `coal>power=>power.in-fuel`)
//   port      a consumer's input port (`portKey`: `iron-plate>labs.in-ore`)
//   item      an item name
//
// Set where a failure is classified, read through `has`/`value`/`table`, and dropped with the role (`dropRole`) when a
// provider leaves the graph. Pure: no Factorio globals (T1: mod/unit/constraints.test.ts).

export const CONSTRAINT_SCOPE = {
  /** B19: a built producer whose routes could not take a tap: new consumers don't share it. */
  noTap: "provider",
  /** B60: a built provider that cannot expand: it serves its consumers at its real capacity, the residual goes parallel. */
  providerShort: "provider",
  /** B61/B60: a shared provider whose planned site could not reach every consumer: one parallel provider per consumer. */
  providerSplit: "provider",
  /** B72: a provider the plan folded into a shared mine whose route then failed: it gets a site of its own. */
  ownSite: "provider",
  /** M6: failed expansions of a provider this stage (a count). */
  growFails: "provider",
  /** M6: the share of the stage target cluster 1 can still serve with this provider capped (a fraction). */
  cluster1Caps: "provider",
  /** B61: an exact provider → consumer feed whose route failed: the design reassigns just that consumer. */
  providerNoTap: "feed",
  /** B71/B80: a consumer port whose route offers no side-load or splitter merge: no demand is split there. */
  noMerge: "port",
  /** B57/B61: a built consumer port proved sealed; while its module waits to relocate, plan no provider for it. */
  noFeed: "port",
  /** B63: a consumer port proved boxed in: plans that feed it use a wider route window. */
  wideJoin: "port",
  /** D68: an item whose new producer could not be placed: new consumers tap a built producer with capacity. */
  fallback: "item",
  /** B184: a steam-block role that found no shore: it is planned inland, fed by a water pump. */
  inlandPower: "provider",
  /** B185: a fuel no new steam-block supply could find: new power comes from solar fields. */
  solarPower: "item",
} as const

export type ConstraintKind = keyof typeof CONSTRAINT_SCOPE
export type ConstraintScope = (typeof CONSTRAINT_SCOPE)[ConstraintKind]

/** Kinds in a fixed order (cache keys, iteration). */
export const CONSTRAINT_KINDS: ConstraintKind[] = ["noTap", "providerShort", "providerSplit", "ownSite", "growFails", "cluster1Caps", "providerNoTap", "noMerge", "noFeed", "wideJoin", "fallback", "inlandPower", "solarPower"]

/** Flag kinds hold `true`; counting kinds (`growFails`, `cluster1Caps`) hold a number. */
export type ConstraintStore = { [K in ConstraintKind]?: Record<string, number | true> }

export function feedKey(from: string, to: string, port: string): string {
  return `${from}=>${to}.${port}`
}

export function portKey(role: string, port: string): string {
  return `${role}.${port}`
}

export function has(s: ConstraintStore | undefined, kind: ConstraintKind, key: string): boolean {
  return s?.[kind]?.[key] !== undefined
}

/** Sets a flag; returns whether it is new. */
export function add(s: ConstraintStore, kind: ConstraintKind, key: string): boolean {
  const t = (s[kind] ??= {})
  if (t[key] !== undefined) return false
  t[key] = true
  return true
}

export function value(s: ConstraintStore | undefined, kind: ConstraintKind, key: string): number | undefined {
  const v = s?.[kind]?.[key]
  return typeof v === "number" ? v : undefined
}

export function setValue(s: ConstraintStore, kind: ConstraintKind, key: string, v: number): void {
  ;(s[kind] ??= {})[key] = v
}

export function remove(s: ConstraintStore | undefined, kind: ConstraintKind, key: string): void {
  const t = s?.[kind]
  if (t !== undefined) delete t[key]
}

/** Forgets every constraint of `kind`. */
export function clear(s: ConstraintStore | undefined, kind: ConstraintKind): void {
  if (s !== undefined) s[kind] = undefined
}

/** The flags of `kind` as a read-only lookup (for the design context), or undefined when there are none. */
export function flags(s: ConstraintStore | undefined, kind: ConstraintKind): Record<string, boolean> | undefined {
  const t = s?.[kind]
  if (t === undefined || next(t)[0] === undefined) return undefined
  return t as Record<string, boolean>
}

/** The counts or fractions of `kind`. */
export function values(s: ConstraintStore | undefined, kind: ConstraintKind): Record<string, number> | undefined {
  return s?.[kind] as Record<string, number> | undefined
}

/** Keys of `kind`, sorted. */
export function keys(s: ConstraintStore | undefined, kind: ConstraintKind): string[] {
  const out: string[] = []
  for (const [k] of pairs(s?.[kind] ?? {})) out.push(k as string)
  table.sort(out)
  return out
}

/**
 * Drops the constraints that name provider `role`: its provider-scoped entries and the feeds it starts. Consumer ports
 * and items are about the consumer or the item, not this provider, and stay.
 */
export function dropRole(s: ConstraintStore | undefined, role: string): void {
  if (s === undefined) return
  for (const kind of CONSTRAINT_KINDS) {
    const t = s[kind]
    if (t === undefined) continue
    const scope = CONSTRAINT_SCOPE[kind]
    if (scope === "provider") delete t[role]
    else if (scope === "feed") {
      const prefix = `${role}=>`
      for (const [k] of pairs(t)) if (string.sub(k as string, 1, prefix.length) === prefix) delete t[k as string]
    } else if (kind === "noFeed") {
      // A relocated consumer's sealed-port mark goes with its role. Other port constraints (noMerge, wideJoin) stay
      // until the same role is replanned, as before.
      const prefix = `${role}.`
      for (const [k] of pairs(t)) if (string.sub(k as string, 1, prefix.length) === prefix) delete t[k as string]
    }
  }
}

/**
 * Moves the per-kind maps a save made before D69 kept on its factory state (`f.noTap`, `f.growFails`, ...) into the
 * store. Returns the store (unchanged when there was nothing to move).
 */
export function adoptLegacy(state: Record<string, unknown>, s: ConstraintStore | undefined): ConstraintStore | undefined {
  for (const kind of CONSTRAINT_KINDS) {
    const old = state[kind] as Record<string, number | true> | undefined
    if (old === undefined) continue
    s ??= {}
    const t = (s[kind] ??= {})
    for (const [k, v] of pairs(old)) t[k as string] = v as number | true
    state[kind] = undefined
  }
  return s
}
