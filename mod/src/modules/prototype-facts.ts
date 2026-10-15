// ProtoFacts read from the game's prototypes (SPEC §5.5: no hardcoded vanilla data). Prototypes are fixed for a
// session, so the lookups are memoised in module-level tables; nothing here is game state (§5.6).

import { LuaEntityPrototype } from "factorio:runtime"
import { EntityFacts, ProtoFacts, RecipeFacts } from "./facts"

function vec(v: unknown): { x: number; y: number } | undefined {
  if (v === undefined || v === null) return undefined
  const t = v as Record<string | number, number>
  // Prototype vectors read back as arrays ({0, -1}) or as {x, y}.
  const x = t.x ?? t[1]
  const y = t.y ?? t[2]
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function tryCall<T>(f: () => T): T | undefined {
  const [ok, v] = pcall(f)
  return ok ? v : undefined
}

const entityCache: Record<string, EntityFacts | false> = {}
const recipeCache: Record<string, RecipeFacts | false> = {}
let unlocks: Record<string, string> | undefined
const recipeForItemCache: Record<string, string | false> = {}

function entityFacts(p: LuaEntityPrototype): EntityFacts {
  const f: EntityFacts = {
    name: p.name,
    type: p.type,
    tileW: p.tile_width,
    tileH: p.tile_height,
    electric: p.electric_energy_source_prototype !== undefined,
    burner: p.burner_prototype !== undefined,
  }
  const t = p.type
  if (t === "assembling-machine" || t === "furnace") {
    f.craftingSpeed = p.get_crafting_speed()
    const cats: string[] = []
    if (p.crafting_categories) for (const [c] of pairs(p.crafting_categories)) cats.push(c as string)
    cats.sort()
    f.craftingCategories = cats
  }
  if (t === "mining-drill") {
    f.miningSpeed = p.mining_speed
    f.miningRadius = p.mining_drill_radius
    f.dropVector = vec(p.vector_to_place_result)
  }
  if (t === "electric-pole") {
    f.supplyDistance = p.get_supply_area_distance()
    f.wireReach = p.get_max_wire_distance()
  }
  if (t === "inserter") {
    f.rotationSpeed = p.get_inserter_rotation_speed()
    f.pickupVector = vec(p.inserter_pickup_position)
    f.dropVectorIns = vec(p.inserter_drop_position)
  }
  if (t === "lab") f.researchSpeed = p.get_researching_speed()
  if (t === "transport-belt" || t === "underground-belt" || t === "splitter") f.beltSpeed = p.belt_speed
  if (t === "underground-belt") f.maxUnderground = p.max_underground_distance
  if (t === "generator") {
    f.maxPowerPerTick = tryCall(() => p.get_max_power_output())
    f.fluidPerTick = tryCall(() => p.get_fluid_usage_per_tick())
  }
  if (t === "offshore-pump") f.pumpingPerTick = tryCall(() => p.get_pumping_speed())
  if (t !== "generator" && t !== "offshore-pump") f.energyPerTick = tryCall(() => p.get_max_energy_usage())
  return f
}

function buildUnlocks(): Record<string, string> {
  const out: Record<string, string> = {}
  const names: string[] = []
  for (const [name] of pairs(prototypes.technology)) names.push(name as string)
  names.sort()
  for (const name of names) {
    const tech = prototypes.technology[name]
    for (const effect of tech.effects) {
      if (effect.type === "unlock-recipe" && out[effect.recipe] === undefined) out[effect.recipe] = name
    }
  }
  return out
}

export const prototypeFacts: ProtoFacts = {
  recipe(name: string): RecipeFacts | undefined {
    let c = recipeCache[name]
    if (c === undefined) {
      const r = prototypes.recipe[name]
      if (r === undefined) c = false
      else {
        const ingredients: { name: string; amount: number }[] = []
        for (const i of r.ingredients) if (i.type === "item") ingredients.push({ name: i.name, amount: i.amount })
        const products: { name: string; amount: number }[] = []
        for (const p of r.products) if (p.type === "item") products.push({ name: p.name, amount: p.amount ?? ((p.amount_min ?? 1) + (p.amount_max ?? 1)) / 2 })
        c = { name, energy: r.energy, category: r.category, ingredients, products }
      }
      recipeCache[name] = c
    }
    return c === false ? undefined : c
  },
  entity(name: string): EntityFacts | undefined {
    let c = entityCache[name]
    if (c === undefined) {
      const p = prototypes.entity[name]
      c = p === undefined ? false : entityFacts(p)
      entityCache[name] = c
    }
    return c === false ? undefined : c
  },
  resourceMiningTime(resource: string): number | undefined {
    return prototypes.entity[resource]?.mineable_properties.mining_time
  },
  resourceProduct(resource: string): string | undefined {
    const products = prototypes.entity[resource]?.mineable_properties.products
    return products !== undefined && products.length > 0 ? products[0].name : undefined
  },
  fuelValue(item: string): number {
    return prototypes.item[item]?.fuel_value ?? 0
  },
  unlockedBy(recipe: string): string | undefined {
    const r = prototypes.recipe[recipe]
    if (r === undefined || r.enabled) return undefined
    unlocks ??= buildUnlocks()
    return unlocks[recipe]
  },
  recipeForItem(item: string): string | undefined {
    let c = recipeForItemCache[item]
    if (c === undefined) {
      const names: string[] = []
      const found = prototypes.get_recipe_filtered([{ filter: "has-product-item", elem_filters: [{ filter: "name", name: item }] }])
      for (const [name] of pairs(found)) names.push(name as string)
      names.sort()
      c = names.indexOf(item) >= 0 ? item : (names[0] ?? false)
      recipeForItemCache[item] = c
    }
    return c === false ? undefined : c
  },
  itemToPlace(entity: string): string | undefined {
    const items = prototypes.entity[entity]?.items_to_place_this
    return items !== undefined && items.length > 0 ? items[0].name : undefined
  },
}
