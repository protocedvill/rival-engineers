// Hand-entered vanilla 2.0.77 prototype facts for T1 tests (the game reads them from prototypes at runtime).
// Values checked against base/prototypes (recipe.lua, entities.lua) and an in-game probe.

import { EntityFacts, ProtoFacts, RecipeFacts } from "../src/modules/facts"

function r(name: string, energy: number, ingredients: [string, number][], products: [string, number][], category = "crafting"): RecipeFacts {
  return {
    name,
    energy,
    category,
    ingredients: ingredients.map(([n, a]) => ({ name: n, amount: a })),
    products: products.map(([n, a]) => ({ name: n, amount: a })),
  }
}

const RECIPES: RecipeFacts[] = [
  r("iron-plate", 3.2, [["iron-ore", 1]], [["iron-plate", 1]], "smelting"),
  r("copper-plate", 3.2, [["copper-ore", 1]], [["copper-plate", 1]], "smelting"),
  r("stone-brick", 3.2, [["stone", 2]], [["stone-brick", 1]], "smelting"),
  r("iron-gear-wheel", 0.5, [["iron-plate", 2]], [["iron-gear-wheel", 1]]),
  r("copper-cable", 0.5, [["copper-plate", 1]], [["copper-cable", 2]]),
  r("electronic-circuit", 0.5, [["iron-plate", 1], ["copper-cable", 3]], [["electronic-circuit", 1]]),
  r("automation-science-pack", 5, [["copper-plate", 1], ["iron-gear-wheel", 1]], [["automation-science-pack", 1]]),
  r("logistic-science-pack", 6, [["inserter", 1], ["transport-belt", 1]], [["logistic-science-pack", 1]]),
  r("inserter", 0.5, [["electronic-circuit", 1], ["iron-gear-wheel", 1], ["iron-plate", 1]], [["inserter", 1]]),
  r("transport-belt", 0.5, [["iron-plate", 1], ["iron-gear-wheel", 1]], [["transport-belt", 2]]),
  r("assembling-machine-1", 0.5, [["electronic-circuit", 3], ["iron-gear-wheel", 5], ["iron-plate", 9]], [["assembling-machine-1", 1]]),
  r("stone-furnace", 0.5, [["stone", 5]], [["stone-furnace", 1]]),
  r("small-electric-pole", 0.5, [["wood", 1], ["copper-cable", 2]], [["small-electric-pole", 2]]),
  r("pipe", 0.5, [["iron-plate", 1]], [["pipe", 1]]),
  r("offshore-pump", 0.5, [["electronic-circuit", 2], ["pipe", 1], ["iron-gear-wheel", 1]], [["offshore-pump", 1]]),
  r("boiler", 0.5, [["stone-furnace", 1], ["pipe", 4]], [["boiler", 1]]),
  r("steam-engine", 0.5, [["iron-gear-wheel", 8], ["pipe", 5], ["iron-plate", 10]], [["steam-engine", 1]]),
  r("lab", 2, [["electronic-circuit", 10], ["iron-gear-wheel", 10], ["transport-belt", 4]], [["lab", 1]]),
  r("radar", 0.5, [["electronic-circuit", 5], ["iron-gear-wheel", 5], ["iron-plate", 10]], [["radar", 1]]),
  r("electric-mining-drill", 2, [["electronic-circuit", 3], ["iron-gear-wheel", 5], ["iron-plate", 10]], [["electric-mining-drill", 1]]),
  r("burner-mining-drill", 2, [["iron-gear-wheel", 3], ["stone-furnace", 1], ["iron-plate", 3]], [["burner-mining-drill", 1]]),
  r("fast-transport-belt", 0.5, [["iron-gear-wheel", 5], ["transport-belt", 1]], [["fast-transport-belt", 1]]),
  r("express-transport-belt", 0.5, [["iron-gear-wheel", 10], ["fast-transport-belt", 1]], [["express-transport-belt", 1]]),
  r("burner-inserter", 0.5, [["iron-plate", 1], ["iron-gear-wheel", 1]], [["burner-inserter", 1]]),
  // M7c: the blue chain.
  r("steel-plate", 16, [["iron-plate", 5]], [["steel-plate", 1]], "smelting"),
  r("engine-unit", 10, [["steel-plate", 1], ["iron-gear-wheel", 1], ["pipe", 2]], [["engine-unit", 1]], "advanced-crafting"),
  r("advanced-circuit", 6, [["electronic-circuit", 2], ["plastic-bar", 2], ["copper-cable", 4]], [["advanced-circuit", 1]]),
  r("chemical-science-pack", 24, [["engine-unit", 2], ["advanced-circuit", 3], ["sulfur", 1]], [["chemical-science-pack", 2]]),
  r("assembling-machine-2", 0.5, [["steel-plate", 2], ["electronic-circuit", 3], ["iron-gear-wheel", 5], ["assembling-machine-1", 1]], [["assembling-machine-2", 1]]),
  // M7b: the oil chain (fluids flagged; `box` = the recipe's fluidbox_index).
  { name: "basic-oil-processing", energy: 5, category: "oil-processing", ingredients: [{ name: "crude-oil", amount: 100, fluid: true, box: 2 }], products: [{ name: "petroleum-gas", amount: 45, fluid: true, box: 3 }] },
  { name: "plastic-bar", energy: 1, category: "chemistry", ingredients: [{ name: "coal", amount: 1 }, { name: "petroleum-gas", amount: 20, fluid: true }], products: [{ name: "plastic-bar", amount: 2 }] },
  { name: "sulfur", energy: 1, category: "chemistry", ingredients: [{ name: "water", amount: 30, fluid: true }, { name: "petroleum-gas", amount: 30, fluid: true }], products: [{ name: "sulfur", amount: 2 }] },
  // M7d: advanced oil processing, cracking and lubricant (2.0 recipes; no fluidbox_index: boxes in ingredient order).
  { name: "advanced-oil-processing", energy: 5, category: "oil-processing", ingredients: [{ name: "water", amount: 50, fluid: true }, { name: "crude-oil", amount: 100, fluid: true }], products: [{ name: "heavy-oil", amount: 25, fluid: true }, { name: "light-oil", amount: 45, fluid: true }, { name: "petroleum-gas", amount: 55, fluid: true }] },
  { name: "heavy-oil-cracking", energy: 2, category: "chemistry", ingredients: [{ name: "water", amount: 30, fluid: true }, { name: "heavy-oil", amount: 40, fluid: true }], products: [{ name: "light-oil", amount: 30, fluid: true }] },
  { name: "light-oil-cracking", energy: 2, category: "chemistry", ingredients: [{ name: "water", amount: 30, fluid: true }, { name: "light-oil", amount: 30, fluid: true }], products: [{ name: "petroleum-gas", amount: 20, fluid: true }] },
  { name: "lubricant", energy: 1, category: "chemistry", ingredients: [{ name: "heavy-oil", amount: 10, fluid: true }], products: [{ name: "lubricant", amount: 10, fluid: true }] },
]

/** Fluid boxes of a north-facing refinery and chemical plant (entities.lua): offsets from the centre, direction index. */
const REFINERY_BOXES: EntityFacts["fluidBoxes"] = [
  { production: "input", connections: [{ x: -1, y: 2, dir: 2 }] },
  { production: "input", connections: [{ x: 1, y: 2, dir: 2 }] },
  { production: "output", connections: [{ x: -2, y: -2, dir: 0 }] },
  { production: "output", connections: [{ x: 0, y: -2, dir: 0 }] },
  { production: "output", connections: [{ x: 2, y: -2, dir: 0 }] },
]
const CHEMICAL_BOXES: EntityFacts["fluidBoxes"] = [
  { production: "input", connections: [{ x: -1, y: -1, dir: 0 }] },
  { production: "input", connections: [{ x: 1, y: -1, dir: 0 }] },
  { production: "output", connections: [{ x: -1, y: 1, dir: 2 }] },
  { production: "output", connections: [{ x: 1, y: 1, dir: 2 }] },
]

function e(f: EntityFacts): EntityFacts {
  return f
}

const ENTITIES: EntityFacts[] = [
  e({ name: "stone-furnace", type: "furnace", tileW: 2, tileH: 2, craftingSpeed: 1, craftingCategories: ["smelting"], energyPerTick: 1500, burner: true }),
  e({ name: "assembling-machine-1", type: "assembling-machine", tileW: 3, tileH: 3, craftingSpeed: 0.5, craftingCategories: ["crafting"], energyPerTick: 1250, electric: true }),
  e({ name: "electric-mining-drill", type: "mining-drill", tileW: 3, tileH: 3, miningSpeed: 0.5, miningRadius: 2.49, dropVector: { x: 0, y: -1.85 }, energyPerTick: 1500, electric: true }),
  e({ name: "burner-mining-drill", type: "mining-drill", tileW: 2, tileH: 2, miningSpeed: 0.25, miningRadius: 0.99, dropVector: { x: -0.5, y: -1.3 }, energyPerTick: 2500, burner: true }),
  e({ name: "lab", type: "lab", tileW: 3, tileH: 3, researchSpeed: 1, energyPerTick: 1000, electric: true }),
  e({ name: "radar", type: "radar", tileW: 3, tileH: 3, energyPerTick: 5000, electric: true }),
  e({ name: "small-electric-pole", type: "electric-pole", tileW: 1, tileH: 1, supplyDistance: 2.5, wireReach: 7.5 }),
  e({ name: "inserter", type: "inserter", tileW: 1, tileH: 1, rotationSpeed: 0.014, pickupVector: { x: 0, y: -1 }, dropVectorIns: { x: 0, y: 1.2 }, energyPerTick: 245, electric: true }),
  e({ name: "long-handed-inserter", type: "inserter", tileW: 1, tileH: 1, rotationSpeed: 0.02, pickupVector: { x: 0, y: -2 }, dropVectorIns: { x: 0, y: 2.2 }, energyPerTick: 335, electric: true }),
  e({ name: "burner-inserter", type: "inserter", tileW: 1, tileH: 1, rotationSpeed: 0.013, pickupVector: { x: 0, y: -1 }, dropVectorIns: { x: 0, y: 1.2 }, energyPerTick: 2400, burner: true }),
  e({ name: "transport-belt", type: "transport-belt", tileW: 1, tileH: 1, beltSpeed: 0.03125 }),
  e({ name: "underground-belt", type: "underground-belt", tileW: 1, tileH: 1, beltSpeed: 0.03125, maxUnderground: 5 }),
  e({ name: "splitter", type: "splitter", tileW: 2, tileH: 1, beltSpeed: 0.03125 }),
  e({ name: "fast-transport-belt", type: "transport-belt", tileW: 1, tileH: 1, beltSpeed: 0.0625 }),
  e({ name: "fast-underground-belt", type: "underground-belt", tileW: 1, tileH: 1, beltSpeed: 0.0625, maxUnderground: 7 }),
  e({ name: "fast-splitter", type: "splitter", tileW: 2, tileH: 1, beltSpeed: 0.0625 }),
  e({ name: "express-transport-belt", type: "transport-belt", tileW: 1, tileH: 1, beltSpeed: 0.09375 }),
  e({ name: "express-underground-belt", type: "underground-belt", tileW: 1, tileH: 1, beltSpeed: 0.09375, maxUnderground: 9 }),
  e({ name: "express-splitter", type: "splitter", tileW: 2, tileH: 1, beltSpeed: 0.09375 }),
  e({ name: "iron-chest", type: "container", tileW: 1, tileH: 1 }),
  e({ name: "pipe", type: "pipe", tileW: 1, tileH: 1 }),
  e({ name: "offshore-pump", type: "offshore-pump", tileW: 1, tileH: 1, pumpingPerTick: 20 }),
  e({ name: "boiler", type: "boiler", tileW: 3, tileH: 2, energyPerTick: 30000, burner: true }),
  e({ name: "steam-engine", type: "generator", tileW: 3, tileH: 5, maxPowerPerTick: 15000, fluidPerTick: 0.5 }),
  e({ name: "assembling-machine-2", type: "assembling-machine", tileW: 3, tileH: 3, craftingSpeed: 0.75, craftingCategories: ["advanced-crafting", "basic-crafting", "crafting", "crafting-with-fluid"], energyPerTick: 2500, electric: true }),
  e({ name: "oil-refinery", type: "assembling-machine", tileW: 5, tileH: 5, craftingSpeed: 1, craftingCategories: ["oil-processing"], energyPerTick: 7000, electric: true, fluidBoxes: REFINERY_BOXES }),
  e({ name: "chemical-plant", type: "assembling-machine", tileW: 3, tileH: 3, craftingSpeed: 1, craftingCategories: ["chemistry"], energyPerTick: 3500, electric: true, fluidBoxes: CHEMICAL_BOXES }),
  e({ name: "pipe-to-ground", type: "pipe-to-ground", tileW: 1, tileH: 1, maxPipeUnderground: 10 }),
  e({ name: "pump", type: "pump", tileW: 1, tileH: 2, energyPerTick: 500, electric: true }),
  // Output box positions {{1,-1},{1,-1},{-1,1},{-1,1}} by direction; north: (1, -1) pointing north.
  e({ name: "pumpjack", type: "mining-drill", tileW: 3, tileH: 3, miningSpeed: 1, energyPerTick: 1500, electric: true, fluidBoxes: [{ production: "output", connections: [{ x: 1, y: -1, dir: 0, positions: [{ x: 1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: 1 }] }] }] }),
]

const RESOURCES: Record<string, { time: number; product: string }> = {
  "iron-ore": { time: 1, product: "iron-ore" },
  "copper-ore": { time: 1, product: "copper-ore" },
  coal: { time: 1, product: "coal" },
  stone: { time: 1, product: "stone" },
  "crude-oil": { time: 1, product: "crude-oil" },
}

const UNLOCKS: Record<string, string> = {
  "assembling-machine-1": "automation",
  "long-handed-inserter": "automation",
  "electronic-circuit": "electronics",
  "logistic-science-pack": "logistic-science-pack",
  lab: "automation-science-pack",
  "offshore-pump": "steam-power",
  boiler: "steam-power",
  "steam-engine": "steam-power",
  pipe: "steam-power",
  "small-electric-pole": "electronics",
  "electric-mining-drill": "electronics",
  "fast-transport-belt": "logistics-2",
  "express-transport-belt": "logistics-3",
}

export const vanillaFacts: ProtoFacts = {
  recipe: (name) => {
    for (const x of RECIPES) if (x.name === name) return x
    return undefined
  },
  entity: (name) => {
    for (const x of ENTITIES) if (x.name === name) return x
    return undefined
  },
  resourceMiningTime: (res) => RESOURCES[res]?.time,
  resourceProduct: (res) => RESOURCES[res]?.product,
  fuelValue: (item) => (item === "coal" ? 4e6 : item === "wood" ? 2e6 : 0),
  unlockedBy: (recipe) => UNLOCKS[recipe],
  recipeForItem: (item) => {
    for (const x of RECIPES) if (x.name === item) return item
    return undefined
  },
  itemToPlace: (entity) => entity,
  isFluid: (name) => name === "crude-oil" || name === "water" || name === "petroleum-gas" || name === "steam",
}
