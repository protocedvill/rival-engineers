// Prototype facts the module library needs, behind an interface so the pure code (generators, rates, geometry)
// runs both in-game (`prototype-facts.ts` reads `prototypes`) and in T1 tests (a hand-written vanilla table).

export interface RecipeFacts {
  name: string
  /** Seconds at crafting speed 1. */
  energy: number
  category: string
  /**
   * M7b: `fluid` marks a fluid (piped, never carried by an inserter); `box` is its `fluidbox_index` (1-based among the
   * machine's input or output fluid boxes), when the recipe pins one.
   */
  ingredients: { name: string; amount: number; fluid?: boolean; box?: number }[]
  products: { name: string; amount: number; fluid?: boolean; box?: number }[]
}

/** M7b: one fluid box of a north-facing entity: its kind and the tiles it connects to (offset from the centre). */
export interface FluidBoxFacts {
  production: "input" | "output" | "input-output" | "none"
  /** Each connection: the entity tile it is on (offset from the centre) and the direction it points (index 0..3). */
  connections: { x: number; y: number; dir: number }[]
}

export interface EntityFacts {
  name: string
  type: string
  tileW: number
  tileH: number
  /** Crafting machines. */
  craftingSpeed?: number
  craftingCategories?: string[]
  /** Mining drills. */
  miningSpeed?: number
  /** Half-width of the mining area (2.49 for the electric drill: a 5×5 area). */
  miningRadius?: number
  /** Drop point relative to the centre of a north-facing drill. */
  dropVector?: { x: number; y: number }
  /** Electric poles. */
  supplyDistance?: number
  wireReach?: number
  /** Inserters: rotation speed in revolutions per tick, pickup/drop vectors for a north-facing inserter. */
  rotationSpeed?: number
  pickupVector?: { x: number; y: number }
  dropVectorIns?: { x: number; y: number }
  /** Max energy use in J/tick (burner fuel draw, electric demand). */
  energyPerTick?: number
  electric?: boolean
  burner?: boolean
  /** Labs. */
  researchSpeed?: number
  /** Belts: tiles per tick. */
  beltSpeed?: number
  /** Underground belts: the farthest an exit may be from its entrance (5 for yellow: 4 tiles in between). */
  maxUnderground?: number
  /** Generators (steam engine): max power in J/tick and steam per tick. */
  maxPowerPerTick?: number
  fluidPerTick?: number
  /** Offshore pumps: fluid per tick. */
  pumpingPerTick?: number
  /** M7b: fluid boxes (north-facing), in prototype order. */
  fluidBoxes?: FluidBoxFacts[]
  /** Pipe-to-ground: the farthest an exit may be from its entrance. */
  maxPipeUnderground?: number
}

export interface ProtoFacts {
  recipe(name: string): RecipeFacts | undefined
  entity(name: string): EntityFacts | undefined
  /** Seconds to mine one unit of a resource at mining speed 1. */
  resourceMiningTime(resource: string): number | undefined
  /** The item a resource yields (iron-ore → iron-ore). */
  resourceProduct(resource: string): string | undefined
  /** Joules per item, 0 if not a fuel. */
  fuelValue(item: string): number
  /** The technology that unlocks a recipe, or undefined if it is enabled from the start (or unknown). */
  unlockedBy(recipe: string): string | undefined
  /** The recipe that makes an item (the one named after it when several), for build-cost tech requirements. */
  recipeForItem(item: string): string | undefined
  /** The item that places an entity. */
  itemToPlace(entity: string): string | undefined
}
