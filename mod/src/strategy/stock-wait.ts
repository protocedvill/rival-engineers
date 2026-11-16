// M7d.6 (generated mall widened, user in-session 2026-11-16): when the crew waits for a stock row instead of
// hand-crafting. Pure: T1 `stock-wait`.
import { ProtoFacts } from "../modules/facts"

/** Deepest intermediate chain followed (a guard against recipe loops; vanilla building chains are 3-4 deep). */
const MAX_DEPTH = 8

/**
 * Seconds one character spends hand-crafting `count` of `item`, its hand-craftable intermediates included (as if none
 * were in stock: an upper bound). Ingredients it cannot hand-craft (plates, steel, fluids' products) cost nothing here:
 * they are supplied. `undefined`: the item itself cannot be hand-crafted.
 */
export function handCraftSeconds(facts: ProtoFacts, item: string, count: number): number | undefined {
  const hand = facts.handCategories?.() ?? { crafting: true }
  const visit = (name: string, n: number, depth: number, top: boolean): number | undefined => {
    const rn = facts.recipeForItem(name)
    const r = rn !== undefined ? facts.recipe(rn) : undefined
    if (r === undefined || !hand[r.category] || r.ingredients.some((i) => i.fluid === true) || depth > MAX_DEPTH) return top ? undefined : 0
    let per = 0
    for (const p of r.products) if (p.name === name) per += p.amount
    if (per <= 0) return top ? undefined : 0
    const crafts = math.ceil(n / per)
    let seconds = crafts * r.energy
    for (const i of r.ingredients) seconds += visit(i.name, crafts * i.amount, depth + 1, false) ?? 0
    return seconds
  }
  return visit(item, count, 0, true)
}

/**
 * Whether the crew waits for a generated stock row to make `short` more of its item rather than hand-crafting them:
 * only while the row is not starved or without power or fuel, and makes them sooner than one character would by hand.
 * `rowPerSecond`: the row's planned output rate. An item the crew cannot hand-craft is always waited for.
 */
export function waitForStockRow(handSeconds: number | undefined, short: number, rowPerSecond: number, status: string): boolean {
  if (handSeconds === undefined) return true
  if (status === "starved" || status === "unpowered" || status === "unfuelled") return false
  if (rowPerSecond <= 0) return false
  return short / rowPerSecond <= handSeconds
}
