import { LuaForce, LuaRecipePrototype } from "factorio:runtime"
import { Catalog } from "./types"

// Prototype index for the burner bootstrap (SPEC §5.5: read from prototypes, no hardcoded vanilla names).
// Everything here is derived from prototypes and the force's enabled recipes, so it is rebuilt freely.

/** Recipes producing `item`, by name (prototype data is fixed for a session, so this is safe to memoise). */
const recipesFor: Record<string, string[]> = {}

function recipeNamesProducing(item: string): string[] {
  let names = recipesFor[item]
  if (names === undefined) {
    names = []
    const found = prototypes.get_recipe_filtered([{ filter: "has-product-item", elem_filters: [{ filter: "name", name: item }] }])
    for (const [name] of pairs(found)) names.push(name as string)
    names.sort()
    // Prefer the recipe named after the item.
    const own = names.indexOf(item)
    if (own > 0) {
      names.splice(own, 1)
      names.unshift(item)
    }
    recipesFor[item] = names
  }
  return names
}

function handCategories(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const cats = prototypes.entity["character"]?.crafting_categories
  if (cats) for (const [c] of pairs(cats)) out[c as string] = true
  return out
}

/** The hand-craft recipe for `item` (enabled or not), or undefined if it can't be hand-crafted at all. */
export function handRecipe(force: LuaForce, item: string): { recipe: LuaRecipePrototype; enabled: boolean } | undefined {
  const cats = handCategories()
  let locked: LuaRecipePrototype | undefined
  for (const name of recipeNamesProducing(item)) {
    const recipe = prototypes.recipe[name]
    if (!cats[recipe.category] || recipe.hidden) continue
    // Only plain recipes: item ingredients, the item as a product.
    let plain = true
    for (const ing of recipe.ingredients) if (ing.type !== "item") plain = false
    if (!plain) continue
    if (force.recipes[name].enabled) return { recipe, enabled: true }
    locked ??= recipe
  }
  return locked ? { recipe: locked, enabled: false } : undefined
}

export function productAmount(recipe: LuaRecipePrototype, item: string): number {
  for (const p of recipe.products) if (p.type === "item" && p.name === item) return p.amount ?? p.amount_min ?? 1
  return 1
}

export interface Expansion {
  /** Raw items (no hand recipe) needed. */
  raw: Record<string, number>
  /** Items whose hand recipe exists but is not unlocked yet. */
  locked: string[]
}

/**
 * Expands `count` crafts of `recipe` into raw materials, recursing through hand-craftable ingredients
 * (the crafting queue makes intermediates itself). Raw = no hand recipe (plates, stone, wood, coal).
 */
export function expandRecipe(force: LuaForce, recipe: LuaRecipePrototype, crafts: number, out?: Expansion, depth = 0): Expansion {
  const result = out ?? { raw: {}, locked: [] }
  if (!force.recipes[recipe.name].enabled && result.locked.indexOf(recipe.name) < 0) result.locked.push(recipe.name)
  for (const ing of recipe.ingredients) {
    const need = ing.amount * crafts
    const sub = depth < 8 ? handRecipe(force, ing.name) : undefined
    // A locked recipe is not a way for the character to make the ingredient (Space Age's scrap-recycling is locked
    // and also lists raw items such as coal/stone). Treat it as a raw item; the bootstrap can mine/gather it.
    if (!sub || !sub.enabled) {
      result.raw[ing.name] = (result.raw[ing.name] ?? 0) + need
      continue
    }
    const subCrafts = math.ceil(need / productAmount(sub.recipe, ing.name))
    expandRecipe(force, sub.recipe, subCrafts, result, depth + 1)
  }
  return result
}

/** Total raw item count of one craft (a crude cost for choosing between alternatives). */
function rawCost(force: LuaForce, recipe: LuaRecipePrototype): number {
  const e = expandRecipe(force, recipe, 1)
  let n = 0
  for (const item in e.raw) n += e.raw[item]
  return n + 1000 * e.locked.length
}

/**
 * The cheapest item placing an entity of `type` that matches `ok`, by raw cost of its enabled hand recipe.
 */
function cheapestPlaceable(force: LuaForce, type: string, ok: (this: void, name: string) => boolean): { entity: string; item: string } | undefined {
  let best: { entity: string; item: string } | undefined
  let bestCost = math.huge
  const entities = prototypes.get_entity_filtered([{ filter: "type", type: type as never }])
  const names: string[] = []
  for (const [name] of pairs(entities)) names.push(name as string)
  names.sort()
  for (const name of names) {
    if (!ok(name)) continue
    const items = prototypes.entity[name].items_to_place_this
    const item = items?.[0]?.name
    if (!item) continue
    const hr = handRecipe(force, item)
    if (!hr || !hr.enabled) continue
    const cost = rawCost(force, hr.recipe)
    if (cost < bestCost) {
      best = { entity: name, item }
      bestCost = cost
    }
  }
  return best
}

function burnerOnly(this: void, name: string): boolean {
  const proto = prototypes.entity[name]
  return proto.burner_prototype !== undefined
}

/**
 * Builds the bootstrap catalog for a force: the cheapest burner drill, burner furnace and chest it can
 * hand-craft now, the fuel (a resource product with a fuel value) and which ores smelt into what.
 */
export function buildCatalog(force: LuaForce, resources: string[]): Catalog {
  const drill = cheapestPlaceable(force, "mining-drill", burnerOnly)
  const furnace = cheapestPlaceable(force, "furnace", burnerOnly)
  const chest = cheapestPlaceable(force, "container", (name) => (prototypes.entity[name].get_inventory_size(defines.inventory.chest) ?? 0) >= 8)
  assert(drill && furnace && chest, "bootstrap catalog: no burner drill, burner furnace or chest is hand-craftable")
  let fuel: string | undefined
  const smelts: Record<string, string> = {}
  const oreOf: Record<string, string> = {}
  const furnaceCats = prototypes.entity[furnace!.entity].crafting_categories ?? {}
  // The fuel: the first resource (configured ones first, then any, by name) whose product burns.
  const allResources: string[] = []
  for (const [name] of pairs(prototypes.get_entity_filtered([{ filter: "type", type: "resource" }]))) allResources.push(name as string)
  allResources.sort()
  for (const res of [...resources, ...allResources]) {
    const item = prototypes.entity[res]?.mineable_properties.products?.[0]?.name
    if (item !== undefined && prototypes.item[item] !== undefined && prototypes.item[item].fuel_value > 0) {
      fuel = item
      break
    }
  }
  for (const res of resources) {
    const products = prototypes.entity[res]?.mineable_properties.products
    const item = products?.[0]?.name
    if (!item) continue
    // A furnace recipe with this single ingredient (e.g. iron-ore → iron-plate).
    const recipes = prototypes.get_recipe_filtered([{ filter: "has-ingredient-item", elem_filters: [{ filter: "name", name: item }] }])
    const names: string[] = []
    for (const [name] of pairs(recipes)) names.push(name as string)
    names.sort()
    for (const name of names) {
      const r = recipes[name]
      if (!furnaceCats[r.category] || r.ingredients.length !== 1 || r.products.length !== 1) continue
      const plate = r.products[0].name
      // Skip recipes that turn the resource into a building material (stone → brick): only smelt what the
      // bootstrap's recipes actually consume as plates is the brain's business; take the first match.
      if (prototypes.item[plate]?.place_as_tile_result !== undefined) continue
      smelts[item] = plate
      oreOf[plate] = item
      break
    }
  }
  assert(fuel, "bootstrap catalog: no resource yields a fuel")
  return {
    drill: drill!.entity,
    drillItem: drill!.item,
    furnace: furnace!.entity,
    furnaceItem: furnace!.item,
    chest: chest!.entity,
    chestItem: chest!.item,
    fuel: fuel!,
    smelts,
    oreOf,
  }
}
