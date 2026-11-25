// M7d (D82 b, proposed): the crew's armour and equipment. Pure (no Factorio globals), so T1 tests it.

export interface LoadoutEntry {
  item: string
  /** Fill the grid's remaining room with this item. */
  fill: boolean
  /**
   * `item=N`: carry N of it in the main inventory (construction robots for a personal roboport) once the entry before it
   * is worn.
   */
  carry?: number
  /** The entry before a carry entry, which must be worn first. */
  after?: string
}

/** Parses the `crew-equipment` setting: comma-separated items, `*` after one to fill the grid with it. */
export function parseLoadout(value: string): LoadoutEntry[] {
  const out: LoadoutEntry[] = []
  for (const [raw] of string.gmatch(value, "[^,%s]+")) {
    const [name, n] = string.match(raw, "^(.-)=(%d+)$")
    if (name !== undefined && n !== undefined) {
      out.push({ item: name, fill: false, carry: tonumber(n)!, after: out.length > 0 ? out[out.length - 1].item : undefined })
      continue
    }
    const fill = string.sub(raw, -1) === "*"
    out.push({ item: fill ? string.sub(raw, 1, -2) : raw, fill })
  }
  return out
}

export interface Worn {
  /** The armour worn, if any. */
  armor?: string
  /** Equipment in its grid, counted by item name. */
  grid: Record<string, number>
  /** Grid cells not taken. */
  freeCells: number
  /** Main-inventory counts of the loadout's carry items. */
  carried?: Record<string, number>
}

/** Whether `item` is worn (the armour, or in its grid). */
function wears(worn: Worn, item: string): boolean {
  return worn.armor === item || (worn.grid[item] ?? 0) > 0
}

/** What a member keeps of each carry item, by what it wears now (the rest is deposited). */
export function carryAllowance(loadout: LoadoutEntry[], worn: Worn): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of loadout) if (e.carry !== undefined && (e.after === undefined || wears(worn, e.after))) out[e.item] = e.carry
  return out
}

export interface LoadoutFacts {
  /** Whether the crew can get the item now (its recipe is enabled). */
  enabled: (this: void, item: string) => boolean
  /** "armor", "equipment" (with the cells its shape takes) or undefined for anything else. */
  kind: (this: void, item: string) => "armor" | "equipment" | undefined
  cells: (this: void, item: string) => number
}

/**
 * The next item a crew member should put on, or undefined when it wears what the loadout asks for. The first enabled
 * armour of the loadout is worn; then each equipment item once (or, marked `*`, while it fits), in order, so the big
 * pieces go into the grid before the small ones fill it.
 */
export function nextEquip(loadout: LoadoutEntry[], worn: Worn, facts: LoadoutFacts): string | undefined {
  let armor: string | undefined
  for (const e of loadout) {
    if (facts.kind(e.item) === "armor" && facts.enabled(e.item)) {
      armor = e.item
      break
    }
  }
  if (armor !== undefined && worn.armor !== armor) return armor
  if (worn.armor === undefined) return undefined
  // Room kept for the single pieces not worn yet, researched or not: the filler only takes the rest. In vanilla the
  // personal solar panel is researched before the exoskeleton, and a grid filled with panels had no room left for it.
  let owed = 0
  for (const e of loadout) if (e.carry === undefined && !e.fill && facts.kind(e.item) === "equipment" && (worn.grid[e.item] ?? 0) < 1) owed += facts.cells(e.item)
  for (const e of loadout) {
    if (e.carry !== undefined) {
      if ((e.after === undefined || wears(worn, e.after)) && (worn.carried?.[e.item] ?? 0) < e.carry && facts.enabled(e.item)) return e.item
      continue
    }
    if (facts.kind(e.item) !== "equipment" || !facts.enabled(e.item)) continue
    const have = worn.grid[e.item] ?? 0
    if (!e.fill && have >= 1) continue
    const room = e.fill ? worn.freeCells - owed : worn.freeCells
    if (facts.cells(e.item) <= room) return e.item
  }
  return undefined
}
