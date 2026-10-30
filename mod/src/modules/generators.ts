// Parametric module generators (SPEC §5.4: the default for simple recipes). Deterministic and data-driven:
// recipes, ingredients, machine speeds and belt speeds come from `ProtoFacts`; only the geometry patterns live here.
// Pure: no Factorio globals.
//
// Conventions shared by the row generators (assembler row, red line, circuit block, lab array):
//   row 0      output belt, flowing west; the output port is its west end (0.5, 0.5)
//   row 1      output inserters (facing south: they pick from the machine below)
//   rows 2–4   3×3 machines
//   row 5      input inserters (facing south: they pick from the input belt below)
//   row 6      input belt, flowing west, carrying up to two items (one per lane)
//   row 7      (two inputs) the first input's port, sideloaded onto the left lane
// The east end is the "tail": with two inputs the first enters from the south (left lane) and the second from a
// column coming down from the north edge (right lane). Units repeat eastward and `expand` inserts them before the
// tail. Inserter direction = the side it picks up from (Factorio 2.0).
//
// Every generator also places its own small poles in a periodic pattern (so growing by a unit never moves a pole),
// and the T1 tests check that every powered entity is covered and the poles are connected.

import { finalizeModule, ModuleDraft } from "./build"
import { ProtoFacts, RecipeFacts } from "./facts"
import { inserterCapacity } from "./rates"
import { placePoles } from "./poles"
import { Dir, EAST, ModuleDef, ModuleEntity, NORTH, Port, SOUTH, WEST } from "./types"

export interface CommonParams {
  belt?: string
  inserter?: string
  pole?: string
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) error(`generator: ${what}`)
  return v
}

class Layout {
  entities: ModuleEntity[] = []
  constructor(
    readonly belt: string,
    readonly inserter: string,
    readonly pole: string,
  ) {}
  add(name: string, x: number, y: number, dir?: Dir, extra?: Partial<ModuleEntity>): void {
    const e: ModuleEntity = { name, x, y }
    if (dir !== undefined) e.dir = dir
    if (extra) for (const [k, v] of pairs(extra as Record<string, unknown>)) (e as unknown as Record<string, unknown>)[k as string] = v
    this.entities.push(e)
  }
  beltAt(x: number, y: number, dir: Dir): void {
    this.add(this.belt, x, y, dir)
  }
  ins(x: number, y: number, dir: Dir): void {
    this.add(this.inserter, x, y, dir)
  }
  poleAt(x: number, y: number): void {
    this.add(this.pole, x, y)
  }
}

/** Items per second one belt lane carries. */
export function laneCapacity(facts: ProtoFacts, belt: string): number {
  const speed = facts.entity(belt)?.beltSpeed ?? 0.03125
  return speed * 60 * 4
}

function solidRecipe(facts: ProtoFacts, name: string): RecipeFacts {
  const r = need(facts.recipe(name), `unknown recipe ${name}`)
  return r
}

function mainProduct(r: RecipeFacts): { name: string; amount: number } {
  return need(r.products[0], `recipe ${r.name} has no product`)
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.ceil(v - 1e-9)))
}

function relativeUnit(entities: ModuleEntity[], axis: "x" | "y", origin: number): ModuleEntity[] {
  return entities.map((e) => (axis === "x" ? { ...e, x: e.x - origin } : { ...e, y: e.y - origin }))
}

/** Splits a generated layout into the first unit (for `expand.unit`): entities whose axis coordinate lies in [a, b). */
function sliceUnit(entities: ModuleEntity[], axis: "x" | "y", a: number, b: number): ModuleEntity[] {
  return relativeUnit(
    entities.filter((e) => {
      const c = axis === "x" ? e.x : e.y
      return c >= a && c < b
    }),
    axis,
    a,
  )
}

/**
 * B25: removes the belt tile at (x, y) once the expansion unit has been sliced (the unit keeps it: between units the
 * belt must run on). Row generators use it for the head tile of their input belt: it flows west out of the footprint
 * with nothing picking from it, and would drop its items onto whatever belt runs past the module's west edge.
 */
function dropBelt(entities: ModuleEntity[], belt: string, x: number, y: number): ModuleEntity[] {
  const out = entities.filter((e) => !(e.name === belt && e.x === x && e.y === y))
  if (out.length !== entities.length - 1) error(`generator: no ${belt} at ${x},${y} to drop`)
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Smelter column

export interface SmelterParams extends CommonParams {
  /** Smelting recipe (iron-plate, copper-plate, stone-brick). */
  recipe: string
  /** Furnace count, a multiple of 4 (units of two furnace pairs). */
  furnaces: number
  furnace?: string
  fuel?: string
  /**
   * D42 / B5: a buffer depot, the chest entity to use ("" or absent: none). An inserter at the head takes plates off the
   * west output belt into this chest, which the crew collects from (its slots are limited at build time). Electric
   * inserters only (a burner buffer inserter would need fuel).
   */
  buffer?: string
}

/**
 * Two mirrored furnace rows around one input belt. Ore and fuel enter on separate single-item ports at the south
 * edge and merge onto the two lanes of the central belt (fuel left, ore right); each output belt runs north and
 * both sideload onto the output port belt at the north edge. Width 11, height 4 + furnaces.
 */
export function smelterColumn(facts: ProtoFacts, p: SmelterParams): ModuleDef {
  const furnace = p.furnace ?? "stone-furnace"
  const fuel = p.fuel ?? "coal"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  if (p.furnaces < 4 || p.furnaces % 4 !== 0) error(`smelter-column: furnaces must be a positive multiple of 4, got ${p.furnaces}`)
  const recipe = solidRecipe(facts, p.recipe)
  if (recipe.ingredients.length !== 1) error(`smelter-column: ${p.recipe} must have one ingredient`)
  const ore = recipe.ingredients[0]
  const plate = mainProduct(recipe)
  const electric = facts.entity(L.inserter)?.electric === true
  const units = p.furnaces / 4
  const H = 4 * units + 4
  const yt = 2 + 4 * units
  // Head: output collector (row 0) and the gap row (row 1).
  for (let x = 0; x <= 4; x++) L.beltAt(x + 0.5, 0.5, EAST)
  L.beltAt(5.5, 0.5, NORTH)
  for (let x = 6; x <= 10; x++) L.beltAt(x + 0.5, 0.5, WEST)
  L.beltAt(0.5, 1.5, NORTH)
  L.beltAt(10.5, 1.5, NORTH)
  // D42 buffer: in the gap row, an inserter picking from the west output belt (it faces west: the side it picks from)
  // drops into a chest east of it. Powered by the first unit's west pole (1.5, 3.5).
  const buffer = electric && p.buffer !== undefined && p.buffer !== "" ? p.buffer : undefined
  if (buffer !== undefined) {
    L.ins(1.5, 1.5, WEST)
    L.add(buffer, 2.5, 1.5, undefined, { buffer: true })
  }
  for (let u = 0; u < units; u++) {
    const y0 = 2 + 4 * u
    for (const j of [0, 2]) {
      const yy = y0 + j
      L.add(furnace, 3, yy + 1, undefined, { recipe: p.recipe })
      L.add(furnace, 8, yy + 1, undefined, { recipe: p.recipe })
      L.ins(4.5, yy + 0.5, EAST)
      L.ins(6.5, yy + 0.5, WEST)
      L.ins(1.5, yy + 0.5, EAST)
      L.ins(9.5, yy + 0.5, WEST)
      for (const dy of [0.5, 1.5]) {
        L.beltAt(0.5, yy + dy, NORTH)
        L.beltAt(5.5, yy + dy, NORTH)
        L.beltAt(10.5, yy + dy, NORTH)
      }
    }
    if (electric) {
      L.poleAt(1.5, y0 + 1.5)
      L.poleAt(4.5, y0 + 1.5)
      L.poleAt(9.5, y0 + 1.5)
    }
  }
  // Tail: fuel (left lane) and ore (right lane) merge onto the central belt.
  L.beltAt(4.5, yt + 0.5, EAST)
  L.beltAt(5.5, yt + 0.5, NORTH)
  L.beltAt(6.5, yt + 0.5, WEST)
  L.beltAt(4.5, yt + 1.5, NORTH)
  L.beltAt(6.5, yt + 1.5, NORTH)
  const ports: Port[] = [
    { id: "out", kind: "belt-out", pos: { x: 5.5, y: 0.5 }, dir: NORTH, item: plate.name },
    { id: "in-fuel", kind: "belt-in", pos: { x: 4.5, y: H - 0.5 }, dir: NORTH, item: fuel },
    { id: "in-ore", kind: "belt-in", pos: { x: 6.5, y: H - 0.5 }, dir: NORTH, item: ore.name },
  ]
  if (electric) ports.push({ id: "power", kind: "power", pos: { x: 4.5, y: 3.5 }, dir: NORTH })
  const speed = facts.entity(furnace)?.craftingSpeed ?? 1
  const orePerFurnace = (speed / recipe.energy) * ore.amount
  const maxFurnaces = Math.floor(laneCapacity(facts, L.belt) / orePerFurnace + 1e-9)
  const draft: ModuleDraft = {
    id: `smelter-column/${p.recipe}/${p.furnaces}/${L.belt}/${L.inserter}${buffer !== undefined ? `/buffer=${buffer}` : ""}`,
    source: "generated",
    generator: "smelter-column",
    provenance: "generator smelter-column (Rival Engineers)",
    description: `${p.furnaces} ${furnace} smelting ${p.recipe}, ore and ${fuel} merged on one belt`,
    footprint: { w: 11, h: H },
    entities: L.entities,
    ports,
    recipe: p.recipe,
    rotatable: true,
    mirrorable: true,
    params: { furnaces: p.furnaces, recipe: p.recipe, belt: L.belt, inserter: L.inserter, fuel, buffer: buffer ?? "" },
    expand: {
      unit: { footprint: { w: 11, h: 4 }, entities: sliceUnit(L.entities, "y", 2, 6) },
      axis: "y",
      insertAt: yt,
      maxUnits: Math.max(0, Math.floor(maxFurnaces / 4) - units),
    },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Mining outpost

export interface MiningParams extends CommonParams {
  resource: string
  /** Drill rows per side; electric drills: a multiple of 2 (units of two rows). */
  rows: number
  /** 1 (drills west of the belt only) or 2. */
  sides?: number
  drill?: string
}

/**
 * Drills on one or both sides of a belt flowing north to the output port at the north edge. Electric drills (3×3)
 * come in units of two rows with a small pole on each outer side; burner drills (2×2) need no poles and are fuelled
 * by the crew (upkeep). `site = resource-patch`; `anchor.miningAreas` are the drills' mining areas.
 */
export function miningOutpost(facts: ProtoFacts, p: MiningParams): ModuleDef {
  const drill = p.drill ?? "electric-mining-drill"
  const sides = p.sides ?? 2
  const df = need(facts.entity(drill), `unknown drill ${drill}`)
  const product = need(facts.resourceProduct(p.resource), `unknown resource ${p.resource}`)
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const big = df.tileW === 3
  const ports: Port[] = []
  let W: number
  let H: number
  let unitH: number
  let units: number
  let beltX: number
  if (big) {
    if (p.rows < 2 || p.rows % 2 !== 0) error(`mining-outpost: rows must be a positive multiple of 2 for ${drill}, got ${p.rows}`)
    units = p.rows / 2
    unitH = 6
    W = sides === 2 ? 9 : 5
    beltX = 4.5
    H = 1 + unitH * units
    L.beltAt(beltX, 0.5, NORTH)
    L.poleAt(2.5, 0.5)
    if (sides === 2) L.poleAt(6.5, 0.5)
    for (let u = 0; u < units; u++) {
      const y0 = 1 + unitH * u
      for (const dy of [1.5, 4.5]) {
        L.add(drill, 2.5, y0 + dy, EAST, { mines: p.resource })
        if (sides === 2) L.add(drill, 6.5, y0 + dy, WEST, { mines: p.resource })
      }
      for (let dy = 0; dy < unitH; dy++) L.beltAt(beltX, y0 + dy + 0.5, NORTH)
      L.poleAt(0.5, y0 + 2.5)
      if (sides === 2) L.poleAt(8.5, y0 + 2.5)
    }
    ports.push({ id: "power", kind: "power", pos: { x: 2.5, y: 0.5 }, dir: NORTH })
  } else {
    if (p.rows < 1) error(`mining-outpost: rows must be ≥ 1`)
    units = p.rows
    unitH = df.tileH
    W = sides === 2 ? 2 * df.tileW + 1 : df.tileW + 1
    beltX = df.tileW + 0.5
    H = 1 + unitH * units
    L.beltAt(beltX, 0.5, NORTH)
    for (let u = 0; u < units; u++) {
      const y0 = 1 + unitH * u
      L.add(drill, df.tileW / 2, y0 + unitH / 2, EAST, { mines: p.resource })
      if (sides === 2) L.add(drill, beltX + 0.5 + df.tileW / 2, y0 + unitH / 2, WEST, { mines: p.resource })
      for (let dy = 0; dy < unitH; dy++) L.beltAt(beltX, y0 + dy + 0.5, NORTH)
    }
  }
  ports.unshift({ id: "out", kind: "belt-out", pos: { x: beltX, y: 0.5 }, dir: NORTH, item: product })
  const time = facts.resourceMiningTime(p.resource) ?? 1
  const perDrill = (df.miningSpeed ?? 0.5) / time
  const drillsPerUnitPerSide = big ? 2 : 1
  const maxUnits = Math.floor(laneCapacity(facts, L.belt) / (perDrill * drillsPerUnitPerSide) + 1e-9)
  const draft: ModuleDraft = {
    id: `mining-outpost/${p.resource}/${p.rows}x${sides}/${drill}/${L.belt}`,
    source: "generated",
    generator: "mining-outpost",
    provenance: "generator mining-outpost (Rival Engineers)",
    description: `${p.rows * sides} ${drill} on ${p.resource} onto one belt`,
    footprint: { w: W, h: H },
    entities: L.entities,
    ports,
    rotatable: true,
    mirrorable: true,
    site: "resource-patch",
    anchor: { resource: p.resource },
    params: { resource: p.resource, rows: p.rows, sides, drill, belt: L.belt },
    expand: {
      unit: { footprint: { w: W, h: unitH }, entities: sliceUnit(L.entities, "y", 1, 1 + unitH) },
      axis: "y",
      insertAt: H,
      maxUnits: Math.max(0, maxUnits - units),
    },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Steam block

export interface SteamParams extends CommonParams {
  boilers: number
  fuel?: string
  pump?: string
  boiler?: string
  engine?: string
  pipe?: string
}

/**
 * Offshore pump at the west end (water to its west, outside the footprint: `site = shore`), a row of boilers fed
 * coal by burner inserters from a belt along the south edge, two steam engines stacked north of each boiler. A
 * 1-tile column after each boiler holds the water pipe and the poles. Width 2 + 4 × boilers, height 14.
 */
export function steamBlock(facts: ProtoFacts, p: SteamParams): ModuleDef {
  const fuel = p.fuel ?? "coal"
  const boiler = p.boiler ?? "boiler"
  const engine = p.engine ?? "steam-engine"
  const pipe = p.pipe ?? "pipe"
  const pump = p.pump ?? "offshore-pump"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "burner-inserter", p.pole ?? "small-electric-pole")
  if (p.boilers < 1) error("steam-block: boilers must be ≥ 1")
  const B = p.boilers
  const W = 2 + 4 * B
  const H = 14
  L.add(pump, 0.5, 11.5, WEST)
  for (let i = 0; i < B; i++) {
    const x0 = 1 + 4 * i
    const g = x0 + 3
    L.add(boiler, x0 + 1.5, 11, NORTH)
    L.add(engine, x0 + 1.5, 7.5, NORTH)
    L.add(engine, x0 + 1.5, 2.5, NORTH)
    L.add(pipe, g + 0.5, 11.5)
    L.poleAt(g + 0.5, 2.5)
    L.poleAt(g + 0.5, 7.5)
    L.ins(x0 + 1.5, 12.5, SOUTH)
    for (let x = x0; x < x0 + 4; x++) L.beltAt(x + 0.5, 13.5, WEST)
  }
  L.beltAt(W - 0.5, 13.5, WEST)
  // Boiler: water + steam per tick at full power, so pump capacity caps the boiler count.
  const pf = facts.entity(pump)
  const ef = facts.entity(engine)
  const bf = facts.entity(boiler)
  const steamPerBoiler = ef?.fluidPerTick && ef.maxPowerPerTick ? ((bf?.energyPerTick ?? 0) * ef.fluidPerTick) / ef.maxPowerPerTick : 1
  const maxBoilers = Math.floor((pf?.pumpingPerTick ?? 20) / Math.max(1e-9, steamPerBoiler) + 1e-9)
  const draft: ModuleDraft = {
    id: `steam-block/${B}/${L.inserter}`,
    source: "generated",
    generator: "steam-block",
    provenance: "generator steam-block (Rival Engineers)",
    description: `offshore pump, ${B} boilers, ${2 * B} steam engines`,
    footprint: { w: W, h: H },
    entities: L.entities,
    ports: [
      { id: "in-fuel", kind: "belt-in", pos: { x: W - 0.5, y: 13.5 }, dir: WEST, item: fuel },
      { id: "power", kind: "power", pos: { x: 4.5, y: 7.5 }, dir: NORTH },
    ],
    rotatable: true,
    mirrorable: true,
    site: "shore",
    // The pump faces west: it needs water on the 2×3 tiles west of it (checked in-game by the validation lab).
    anchor: { water: [{ x: -2, y: 10, w: 2, h: 3 }] },
    params: { boilers: B, fuel, inserter: L.inserter },
    expand: {
      unit: { footprint: { w: 4, h: H }, entities: sliceUnit(L.entities, "x", 1, 5) },
      axis: "x",
      insertAt: W - 1,
      maxUnits: Math.max(0, maxBoilers - B),
    },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Row helpers

/** Tail for a row module with one or two inputs: returns ports; `xt` is the tail's first column. */
function rowTail(L: Layout, xt: number, inputs: string[], inRow: number, top = 0): Port[] {
  if (inputs.length === 1) {
    L.beltAt(xt + 0.5, inRow + 0.5, WEST)
    return [{ id: `in-${inputs[0]}`, kind: "belt-in", pos: { x: xt + 0.5, y: inRow + 0.5 }, dir: WEST, item: inputs[0] }]
  }
  // Two inputs: the merge tile at (xt, inRow) flows west with nothing behind it; the first input sideloads from
  // the south (left lane of a west-flowing belt), the second from the north (right lane).
  L.beltAt(xt + 0.5, inRow + 0.5, WEST)
  L.beltAt(xt + 0.5, inRow + 1.5, NORTH)
  for (let y = top; y < inRow; y++) L.beltAt(xt + 0.5, y + 0.5, SOUTH)
  return [
    { id: `in-${inputs[0]}`, kind: "belt-in", pos: { x: xt + 0.5, y: inRow + 1.5 }, dir: NORTH, item: inputs[0] },
    { id: `in-${inputs[1]}`, kind: "belt-in", pos: { x: xt + 0.5, y: top + 0.5 }, dir: SOUTH, item: inputs[1] },
  ]
}

function inserterCaps(facts: ProtoFacts, inserter: string): { belt: number; machine: number } {
  const f = need(facts.entity(inserter), `unknown inserter ${inserter}`)
  return { belt: inserterCapacity(f, 1, true), machine: inserterCapacity(f, 1, false) }
}

function machineSpeed(facts: ProtoFacts, machine: string): number {
  return need(facts.entity(machine)?.craftingSpeed, `${machine} is not a crafting machine`)
}

/** D51 / B14: columns a row module's buffer head adds at its west end. */
const ROW_BUFFER_W = 2

/**
 * D51 / B14: a buffer depot at the head (west end) of a row module (output belt on row 0 flowing west to its port):
 * every entity and port moves ROW_BUFFER_W columns east, the output belt runs on to the new port at (0.5, 0.5), and an
 * inserter at (1.5, 1.5) picks plates (items) off that belt (it faces north: the side it picks from) into a chest at
 * (1.5, 2.5). A pole at (0.5, 1.5) powers it and reaches the module's own poles. Returns the buffer chest, if added.
 */
function rowBufferHead(facts: ProtoFacts, L: Layout, ports: Port[], buffer: string | undefined): boolean {
  if (buffer === undefined || buffer === "" || facts.entity(L.inserter)?.electric !== true) return false
  for (const e of L.entities) e.x += ROW_BUFFER_W
  for (const p of ports) p.pos = { x: p.pos.x + ROW_BUFFER_W, y: p.pos.y }
  L.beltAt(0.5, 0.5, WEST)
  L.beltAt(1.5, 0.5, WEST)
  L.ins(1.5, 1.5, NORTH)
  L.add(buffer, 1.5, 2.5, undefined, { buffer: true })
  L.poleAt(0.5, 1.5)
  for (const p of ports) if (p.kind === "belt-out" || p.kind === "power") {
    if (p.kind === "belt-out") p.pos = { x: 0.5, y: 0.5 }
    else p.pos = { x: 0.5, y: 1.5 }
  }
  return true
}

// ---------------------------------------------------------------------------------------------------------
// Generic assembler row

export interface AssemblerRowParams extends CommonParams {
  recipe: string
  /** Assembler count, even (units of two). */
  count: number
  machine?: string
  /** D51 / B14: buffer depot chest at the head ("" or absent: none). */
  buffer?: string
  /** M7c: the long-handed inserter that feeds a third ingredient from its own belt. */
  longInserter?: string
}

/**
 * N assemblers in a row between an output belt (north) and an input belt (south) carrying up to two solid
 * ingredients, one per lane. Inserters per machine (1–2 each side) are sized from the recipe's rates. M7c: a third
 * ingredient (the one used most per craft) comes on a belt of its own one row further south, through a long-handed
 * inserter beside each machine's input inserter; it enters from below at the tail and curves west, so it touches
 * neither the two-lane belt nor that belt's merge column.
 */
export function assemblerRow(facts: ProtoFacts, p: AssemblerRowParams): ModuleDef {
  const machine = p.machine ?? "assembling-machine-1"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const recipe = solidRecipe(facts, p.recipe)
  if (recipe.ingredients.length < 1 || recipe.ingredients.length > 3) error(`assembler-row: ${p.recipe} needs 1–3 ingredients`)
  if (recipe.ingredients.some((i) => i.fluid === true)) error(`assembler-row: ${p.recipe} takes a fluid`)
  if (p.count < 2 || p.count % 2 !== 0) error(`assembler-row: count must be a positive even number, got ${p.count}`)
  const product = mainProduct(recipe)
  const crafts = machineSpeed(facts, machine) / recipe.energy
  let perCraftIn = 0
  for (const i of recipe.ingredients) perCraftIn += i.amount
  const caps = inserterCaps(facts, L.inserter)
  const three = recipe.ingredients.length === 3
  // Three ingredients: the one used most per craft rides its own belt (row 7), the other two share the lanes of row 6.
  const sorted = [...recipe.ingredients].sort((a, b) => (a.amount !== b.amount ? a.amount - b.amount : a.name < b.name ? -1 : 1))
  const third = three ? sorted[2] : undefined
  const nIn = three ? 1 : clampInt((crafts * perCraftIn) / caps.belt, 1, 2)
  const nOut = clampInt((crafts * product.amount) / caps.machine, 1, 2)
  const inputs = (three ? sorted.slice(0, 2) : recipe.ingredients).map((i) => i.name)
  const long = p.longInserter ?? "long-handed-inserter"
  const units = p.count / 2
  const xt = 6 * units
  for (let u = 0; u < units; u++) {
    const ux = 6 * u
    for (const j of [0, 1]) {
      const x0 = ux + 3 * j
      L.add(machine, x0 + 1.5, 3.5, undefined, { recipe: p.recipe })
      for (let k = 0; k < nOut; k++) L.ins(x0 + 1.5 + k, 1.5, SOUTH)
      for (let k = 0; k < nIn; k++) L.ins(x0 + 1.5 + k, 5.5, SOUTH)
      if (three) L.add(long, x0 + 2.5, 5.5, SOUTH)
      for (let dx = 0; dx < 3; dx++) {
        L.beltAt(x0 + dx + 0.5, 0.5, WEST)
        L.beltAt(x0 + dx + 0.5, 6.5, WEST)
        if (three) L.beltAt(x0 + dx + 0.5, 7.5, WEST)
      }
    }
    L.poleAt(ux + 0.5, 1.5)
    L.poleAt(ux + 0.5, 5.5)
  }
  // Tail column xt: poles for the last machine, belts; with two inputs a merge column at xt + 1.
  L.poleAt(xt + 0.5, 1.5)
  L.poleAt(xt + 0.5, 5.5)
  L.beltAt(xt + 0.5, 0.5, WEST)
  let ports: Port[]
  let W: number
  if (inputs.length === 1) {
    ports = rowTail(L, xt, inputs, 6)
    W = xt + 1
  } else {
    L.beltAt(xt + 0.5, 6.5, WEST)
    ports = rowTail(L, xt + 1, inputs, 6)
    W = xt + 2
  }
  if (third !== undefined) {
    // Row 7: the third ingredient enters from below at the tail column and curves west under the machines.
    L.beltAt(xt + 0.5, 7.5, WEST)
    L.beltAt(xt + 0.5, 8.5, NORTH)
    ports.push({ id: `in-${third.name}`, kind: "belt-in", pos: { x: xt + 0.5, y: 8.5 }, dir: NORTH, item: third.name })
    // The lanes' first input entered at row 7, now inside the footprint: it starts one tile lower, on the edge (its
    // outside tile was inside the module, so no route could reach it: first M7 soak, engines "no path").
    L.beltAt(xt + 1.5, 8.5, NORTH)
    for (const port of ports) if (port.kind === "belt-in" && port.item === inputs[0]) port.pos = { x: xt + 1.5, y: 8.5 }
  }
  ports.unshift({ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST, item: product.name })
  ports.push({ id: "power", kind: "power", pos: { x: 0.5, y: 1.5 }, dir: NORTH })
  const buffered = rowBufferHead(facts, L, ports, p.buffer)
  const head = buffered ? ROW_BUFFER_W : 0
  W += head
  const H = three ? 9 : inputs.length === 1 ? 7 : 8
  // Growth cap: each input lane (two inputs) or the whole belt (one input), and the output belt.
  const lane = laneCapacity(facts, L.belt)
  let maxMachines = (2 * lane) / (crafts * product.amount)
  for (const i of recipe.ingredients) maxMachines = Math.min(maxMachines, (inputs.length === 1 || i === third ? 2 * lane : lane) / (crafts * i.amount))
  const draft: ModuleDraft = {
    id: `assembler-row/${p.recipe}/${p.count}/${machine}/${L.belt}/${L.inserter}${buffered ? `/buffer=${p.buffer}` : ""}`,
    source: "generated",
    generator: "assembler-row",
    provenance: "generator assembler-row (Rival Engineers)",
    description: `${p.count} ${machine} making ${p.recipe}`,
    footprint: { w: W, h: H },
    entities: L.entities,
    ports,
    recipe: p.recipe,
    rotatable: true,
    mirrorable: true,
    params: { recipe: p.recipe, count: p.count, machine, belt: L.belt, inserter: L.inserter, buffer: buffered ? p.buffer! : "" },
    expand: {
      unit: { footprint: { w: 6, h: H }, entities: sliceUnit(L.entities, "x", head, head + 6) },
      axis: "x",
      insertAt: xt + head,
      maxUnits: Math.max(0, Math.floor(maxMachines / 2 + 1e-9) - units),
    },
  }
  // B25: the input belt ends at the first machine's inserters (a buffer head already moved it off the edge).
  if (!buffered) draft.entities = dropBelt(draft.entities, L.belt, 0.5, 6.5)
  if (!buffered && three) draft.entities = dropBelt(draft.entities, L.belt, 0.5, 7.5)
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Red line: direct insertion of an intermediate (gears) into the product (red science)

export interface RedLineParams extends CommonParams {
  /** Product recipe (automation-science-pack). Exactly one of its ingredients must be craftable in the machine. */
  recipe?: string
  /** Units of [product, intermediate, product]. */
  units: number
  machine?: string
}

/**
 * Units of three assemblers: product – intermediate – product, the middle one (gears) feeding both neighbours by
 * direct insertion. The input belt carries the intermediate's ingredient and the product's other ingredient.
 */
export function redLine(facts: ProtoFacts, p: RedLineParams): ModuleDef {
  const machine = p.machine ?? "assembling-machine-1"
  const recipeName = p.recipe ?? "automation-science-pack"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const recipe = solidRecipe(facts, recipeName)
  if (p.units < 1) error("red-line: units must be ≥ 1")
  const product = mainProduct(recipe)
  let mid: RecipeFacts | undefined
  let other: string | undefined
  for (const ing of recipe.ingredients) {
    const r = facts.recipe(facts.recipeForItem(ing.name) ?? ing.name)
    if (mid === undefined && r !== undefined && r.category === recipe.category && r.ingredients.length === 1) mid = r
    else other = ing.name
  }
  const midRecipe = need(mid, `red-line: ${recipeName} has no single-ingredient intermediate`)
  const inputs = [midRecipe.ingredients[0].name, need(other, `red-line: ${recipeName} needs a second ingredient`)]
  const xt = 12 * p.units
  for (let u = 0; u < p.units; u++) {
    const ux = 12 * u
    L.add(machine, ux + 1.5, 3.5, undefined, { recipe: recipeName })
    L.add(machine, ux + 5.5, 3.5, undefined, { recipe: midRecipe.name })
    L.add(machine, ux + 9.5, 3.5, undefined, { recipe: recipeName })
    L.ins(ux + 3.5, 2.5, EAST)
    L.ins(ux + 7.5, 2.5, WEST)
    L.ins(ux + 1.5, 1.5, SOUTH)
    L.ins(ux + 9.5, 1.5, SOUTH)
    L.ins(ux + 1.5, 5.5, SOUTH)
    L.ins(ux + 5.5, 5.5, SOUTH)
    L.ins(ux + 9.5, 5.5, SOUTH)
    L.poleAt(ux + 3.5, 3.5)
    L.poleAt(ux + 7.5, 3.5)
    L.poleAt(ux + 11.5, 3.5)
    for (let dx = 0; dx < 12; dx++) {
      L.beltAt(ux + dx + 0.5, 0.5, WEST)
      L.beltAt(ux + dx + 0.5, 6.5, WEST)
    }
  }
  const ports = rowTail(L, xt, inputs, 6)
  ports.unshift({ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST, item: product.name })
  ports.push({ id: "power", kind: "power", pos: { x: 3.5, y: 3.5 }, dir: NORTH })
  const draft: ModuleDraft = {
    id: `red-line/${recipeName}/${p.units}/${machine}/${L.belt}/${L.inserter}`,
    source: "generated",
    generator: "red-line",
    provenance: "generator red-line (Rival Engineers)",
    description: `${2 * p.units} ${machine} making ${recipeName}, ${p.units} making ${midRecipe.name} by direct insertion`,
    footprint: { w: xt + 1, h: 8 },
    entities: L.entities,
    ports,
    recipe: recipeName,
    rotatable: true,
    mirrorable: true,
    params: { recipe: recipeName, units: p.units, machine, belt: L.belt, inserter: L.inserter },
    expand: {
      unit: { footprint: { w: 12, h: 8 }, entities: sliceUnit(L.entities, "x", 0, 12) },
      axis: "x",
      insertAt: xt,
      maxUnits: Math.max(0, 10 - p.units),
    },
  }
  // B25: the input belt ends at the first machine's inserters.
  draft.entities = dropBelt(draft.entities, L.belt, 0.5, 6.5)
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Circuit block: 3 cable : 2 circuit by direct insertion

export interface CircuitBlockParams extends CommonParams {
  units: number
  machine?: string
  /** Product (electronic-circuit) and the intermediate it takes (copper-cable). */
  recipe?: string
  intermediate?: string
  /** D51 / B14: buffer depot chest at the head ("" or absent: none). */
  buffer?: string
}

/**
 * Units of five assemblers C K C K C (C = cable, K = circuit): every circuit assembler takes cable from both
 * neighbours through two inserters each; the middle cable assembler feeds both. Copper and iron arrive on one belt.
 */
export function circuitBlock(facts: ProtoFacts, p: CircuitBlockParams): ModuleDef {
  const machine = p.machine ?? "assembling-machine-1"
  const recipeName = p.recipe ?? "electronic-circuit"
  const midName = p.intermediate ?? "copper-cable"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const recipe = solidRecipe(facts, recipeName)
  const mid = solidRecipe(facts, midName)
  if (p.units < 1) error("circuit-block: units must be ≥ 1")
  const product = mainProduct(recipe)
  let other: string | undefined
  for (const ing of recipe.ingredients) if (ing.name !== mainProduct(mid).name) other = ing.name
  if (mid.ingredients.length !== 1) error(`circuit-block: ${midName} must have one ingredient`)
  const inputs = [mid.ingredients[0].name, need(other, `circuit-block: ${recipeName} needs another ingredient`)]
  const xt = 20 * p.units
  for (let u = 0; u < p.units; u++) {
    const ux = 20 * u
    const kinds: [number, string][] = [
      [0, midName],
      [4, recipeName],
      [8, midName],
      [12, recipeName],
      [16, midName],
    ]
    for (const [x0, r] of kinds) {
      L.add(machine, ux + x0 + 1.5, 3.5, undefined, { recipe: r })
      L.ins(ux + x0 + 1.5, 5.5, SOUTH)
      L.ins(ux + x0 + 2.5, 5.5, SOUTH)
      if (r === recipeName) {
        L.ins(ux + x0 + 1.5, 1.5, SOUTH)
        L.ins(ux + x0 + 2.5, 1.5, SOUTH)
      }
    }
    // Gaps: inserters pick up from the cable assembler beside them.
    const gaps: [number, Dir][] = [
      [3, WEST],
      [7, EAST],
      [11, WEST],
      [15, EAST],
    ]
    for (const [g, d] of gaps) {
      L.ins(ux + g + 0.5, 2.5, d)
      L.ins(ux + g + 0.5, 4.5, d)
      L.poleAt(ux + g + 0.5, 3.5)
    }
    L.poleAt(ux + 19.5, 3.5)
    for (let dx = 0; dx < 20; dx++) {
      L.beltAt(ux + dx + 0.5, 0.5, WEST)
      L.beltAt(ux + dx + 0.5, 6.5, WEST)
    }
  }
  const ports = rowTail(L, xt, inputs, 6)
  ports.unshift({ id: "out", kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST, item: product.name })
  ports.push({ id: "power", kind: "power", pos: { x: 3.5, y: 3.5 }, dir: NORTH })
  const buffered = rowBufferHead(facts, L, ports, p.buffer)
  const head = buffered ? ROW_BUFFER_W : 0
  const lane = laneCapacity(facts, L.belt)
  const draft: ModuleDraft = {
    id: `circuit-block/${recipeName}/${p.units}/${machine}/${L.belt}/${L.inserter}${buffered ? `/buffer=${p.buffer}` : ""}`,
    source: "generated",
    generator: "circuit-block",
    provenance: "generator circuit-block (Rival Engineers)",
    description: `${3 * p.units} ${midName} : ${2 * p.units} ${recipeName} assemblers, direct insertion`,
    footprint: { w: xt + 1 + head, h: 8 },
    entities: L.entities,
    ports,
    recipe: recipeName,
    rotatable: true,
    mirrorable: true,
    params: { recipe: recipeName, intermediate: midName, units: p.units, machine, belt: L.belt, inserter: L.inserter, buffer: buffered ? p.buffer! : "" },
    expand: {
      unit: { footprint: { w: 20, h: 8 }, entities: sliceUnit(L.entities, "x", head, head + 20) },
      axis: "x",
      insertAt: xt + head,
      // Copper is the limiting lane: 3 cable assemblers × their ingredient rate per unit.
      maxUnits: Math.max(0, Math.floor(lane / ((3 * machineSpeed(facts, machine)) / mid.energy) + 1e-9) - p.units),
    },
  }
  // B25: the input belt ends at the first machine's inserters (a buffer head already moved it off the edge).
  if (!buffered) draft.entities = dropBelt(draft.entities, L.belt, 0.5, 6.5)
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Lab array

export interface LabArrayParams extends CommonParams {
  /** Labs, even: each belt-fed lab passes packs on to the next through an inserter. */
  labs: number
  /** One or two science packs (one per lane); M7c: a third on a belt of its own along the top. */
  packs: string[]
  /** Seconds per research unit used for the declared rates (the technology being researched decides). */
  unitTime?: number
  lab?: string
}

/**
 * Pairs of labs in a row: the first is fed from the pack belt, the second from the first (lab-to-lab inserter). M7c: a
 * third pack runs on a belt along the top (port at the west edge, flowing east), fed into each pair's first lab by a
 * regular inserter, and everything else moves two rows down; no long-handed inserter, so the array needs nothing
 * researched after `electronics` (a lab array is built before `automation`).
 */
export function labArray(facts: ProtoFacts, p: LabArrayParams): ModuleDef {
  const lab = p.lab ?? "lab"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  if (p.labs < 2 || p.labs % 2 !== 0) error(`lab-array: labs must be a positive even number, got ${p.labs}`)
  if (p.packs.length < 1 || p.packs.length > 3) error("lab-array: one to three packs")
  const three = p.packs.length === 3
  const lanes = three ? p.packs.slice(0, 2) : p.packs
  const dy = three ? 2 : 0
  const units = p.labs / 2
  const xt = 8 * units
  for (let u = 0; u < units; u++) {
    const ux = 8 * u
    L.add(lab, ux + 1.5, dy + 1.5)
    L.add(lab, ux + 5.5, dy + 1.5)
    L.ins(ux + 3.5, dy + 0.5, WEST)
    L.ins(ux + 1.5, dy + 3.5, SOUTH)
    L.poleAt(ux + 3.5, dy + 2.5)
    L.poleAt(ux + 7.5, dy + 2.5)
    for (let dx = 0; dx < 8; dx++) L.beltAt(ux + dx + 0.5, dy + 4.5, WEST)
    if (three) {
      // The third pack: the top belt, an inserter picking from it (it faces north: the side it picks from), a pole.
      L.ins(ux + 1.5, 1.5, NORTH)
      L.poleAt(ux + 3.5, 1.5)
    }
  }
  const ports = rowTail(L, xt, lanes, dy + 4, dy)
  if (three) {
    // One more column east: the top belt flows west from its port on the east edge (row 0), and the lanes' second input
    // enters on that edge at row dy and curves south into the tail column (nothing behind it, so a curve).
    for (let x = 0; x <= xt + 1; x++) L.beltAt(x + 0.5, 0.5, WEST)
    ports.push({ id: `in-${p.packs[2]}`, kind: "belt-in", pos: { x: xt + 1.5, y: 0.5 }, dir: WEST, item: p.packs[2] })
    L.beltAt(xt + 1.5, dy + 0.5, WEST)
    for (const port of ports) if (port.item === lanes[1] && port.kind === "belt-in") {
      port.pos = { x: xt + 1.5, y: dy + 0.5 }
      port.dir = WEST
    }
  }
  ports.push({ id: "power", kind: "power", pos: { x: 3.5, y: dy + 2.5 }, dir: NORTH })
  const unitTime = p.unitTime ?? 30
  const H = dy + (lanes.length === 2 ? 6 : 5)
  const draft: ModuleDraft = {
    id: `lab-array/${p.labs}/${p.packs.join("+")}/${L.belt}/${L.inserter}`,
    source: "generated",
    generator: "lab-array",
    provenance: "generator lab-array (Rival Engineers)",
    description: `${p.labs} labs, ${p.packs.join(" + ")}`,
    footprint: { w: three ? xt + 2 : xt + 1, h: H },
    entities: L.entities,
    ports,
    rotatable: true,
    mirrorable: true,
    params: { labs: p.labs, packs: p.packs.join(","), unitTime, belt: L.belt, inserter: L.inserter },
    expand: {
      unit: { footprint: { w: 8, h: H }, entities: sliceUnit(L.entities, "x", 0, 8) },
      axis: "x",
      insertAt: xt,
      maxUnits: Math.max(0, 10 - units),
    },
  }
  // B25: the pack belt ends at the first lab's inserter.
  draft.entities = dropBelt(draft.entities, L.belt, 0.5, dy + 4.5)
  if (three) draft.entities = dropBelt(draft.entities, L.belt, 0.5, 0.5)
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Chest cell (D38 temporary bootstrap factory)

export interface ChestCellParams extends CommonParams {
  recipe: string
  machine?: string
  chest?: string
}

/**
 * D38: a temporary factory the crew feeds by hand: input chest → inserter → assembler → inserter → output chest, in a
 * row (width 7, height 3), two small poles on the north edge. The crew fills the input chest (`chest-in` ports, one per
 * ingredient, same chest) and empties the output chest (`chest-out`). No belts: it needs no routing, only power.
 */
export function chestCell(facts: ProtoFacts, p: ChestCellParams): ModuleDef {
  const machine = p.machine ?? "assembling-machine-1"
  const chest = p.chest ?? "iron-chest"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const recipe = solidRecipe(facts, p.recipe)
  const product = mainProduct(recipe)
  L.add(chest, 0.5, 1.5)
  // Inserters face west: they pick from the west and drop east.
  L.ins(1.5, 1.5, WEST)
  L.add(machine, 3.5, 1.5, undefined, { recipe: p.recipe })
  L.ins(5.5, 1.5, WEST)
  L.add(chest, 6.5, 1.5)
  const electric = facts.entity(L.inserter)?.electric === true || facts.entity(machine)?.electric === true
  if (electric) {
    L.poleAt(1.5, 0.5)
    L.poleAt(5.5, 0.5)
  }
  const ports: Port[] = []
  for (const ing of recipe.ingredients) ports.push({ id: `in-${ing.name}`, kind: "chest-in", pos: { x: 0.5, y: 1.5 }, dir: WEST, item: ing.name })
  ports.push({ id: `chest-${product.name}`, kind: "chest-out", pos: { x: 6.5, y: 1.5 }, dir: EAST, item: product.name })
  if (electric) ports.push({ id: "power", kind: "power", pos: { x: 1.5, y: 0.5 }, dir: NORTH })
  const draft: ModuleDraft = {
    id: `chest-cell/${p.recipe}/${machine}/${chest}/${L.inserter}`,
    source: "generated",
    generator: "chest-cell",
    provenance: "generator chest-cell (Rival Engineers)",
    description: `temporary ${machine} making ${p.recipe} from a chest the crew fills (D38)`,
    footprint: { w: 7, h: 3 },
    entities: L.entities,
    ports,
    recipe: p.recipe,
    rotatable: true,
    mirrorable: true,
    params: { recipe: p.recipe, machine, chest, inserter: L.inserter },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Radar (D56: placed for realism; plans never depend on what it charts)

export interface RadarParams extends CommonParams {
  radar?: string
}

/** D56: one radar (3×3) with a small pole beside it: a 4×3 powered module, no belts. */
export function radarCell(facts: ProtoFacts, p: RadarParams): ModuleDef {
  const radar = p.radar ?? "radar"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  L.add(radar, 1.5, 1.5)
  L.poleAt(3.5, 1.5)
  const draft: ModuleDraft = {
    id: `radar/${radar}/${L.pole}`,
    source: "generated",
    generator: "radar",
    provenance: "generator radar (Rival Engineers)",
    description: `one ${radar} (D56)`,
    footprint: { w: 4, h: 3 },
    entities: L.entities,
    ports: [{ id: "power", kind: "power", pos: { x: 3.5, y: 1.5 }, dir: EAST }],
    rotatable: true,
    mirrorable: true,
    params: { radar },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Registry

// ---------------------------------------------------------------------------------------------------------
// Fluid chain (M7b)

export interface FluidChainParams extends CommonParams {
  /** The chemistry recipe whose product leaves on a belt (plastic-bar, sulfur, ...). */
  recipe: string
  /** The refinery recipe making its piped intermediate from a piped raw fluid (default basic-oil-processing). */
  source?: string
  chemPlants: number
  refineries: number
  refinery?: string
  chemPlant?: string
  pipe?: string
  pipeToGround?: string
  longInserter?: string
}

/** The tile a fluid box connects to, for an entity centred on `cx`,`cy` (tile centre) facing `facing` (0 or 2). */
function boxTile(facts: ProtoFacts, entity: string, production: "input" | "output", nth: number, cx: number, cy: number, facing: number): { x: number; y: number } {
  const boxes = need(facts.entity(entity)?.fluidBoxes, `${entity} has no fluid boxes`).filter((b) => b.production === production)
  const c = need(boxes[nth - 1]?.connections[0], `${entity} has no ${production} fluid box ${nth}`)
  const sign = facing === 2 ? -1 : 1
  const d = (c.dir + facing) % 4
  const dx = [0, 1, 0, -1][d]
  const dy = [-1, 0, 1, 0][d]
  return { x: math.floor(cx) + sign * c.x + dx, y: math.floor(cy) + sign * c.y + dy }
}

/**
 * Refineries turn a piped raw fluid (crude oil) into an intermediate (petroleum gas) that chemical plants above them
 * turn into a solid product on a belt. Rows, top to bottom: product belt (west, port at x = 0), solid-input belt (east,
 * port at x = 0), inserters (one feeding, one long-handed taking out per plant), chemical plants facing south, their
 * intermediate risers, the intermediate manifold, the refineries' risers, refineries facing north, raw-fluid risers, the
 * raw-fluid manifold (`pipe-in` port at x = 0); with a second fluid (sulfur's water) pipe-to-ground pairs run from each
 * plant's other box under everything to a manifold at the bottom (`pipe-in`). Only risers touch a machine's box, so the
 * boxes a recipe does not use touch no pipe and two fluids never meet.
 */
export function fluidChain(facts: ProtoFacts, p: FluidChainParams): ModuleDef {
  const refinery = p.refinery ?? "oil-refinery"
  const chem = p.chemPlant ?? "chemical-plant"
  const pipe = p.pipe ?? "pipe"
  const ptg = p.pipeToGround ?? "pipe-to-ground"
  const long = p.longInserter ?? "long-handed-inserter"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  const recipe = solidRecipe(facts, p.recipe)
  const source = solidRecipe(facts, p.source ?? "basic-oil-processing")
  const product = need(recipe.products.find((x) => x.fluid !== true), `${p.recipe} makes no solid product`)
  const mid = need(source.products.find((x) => x.fluid === true && recipe.ingredients.some((i) => i.name === x.name)), `${source.name} makes no fluid ${p.recipe} uses`)
  const raw = need(source.ingredients.find((x) => x.fluid === true), `${source.name} takes no fluid`)
  const fluidsIn = recipe.ingredients.filter((i) => i.fluid === true)
  const solidsIn = recipe.ingredients.filter((i) => i.fluid !== true)
  const other = fluidsIn.find((i) => i.name !== mid.name)
  if (solidsIn.length > 1 || fluidsIn.length > 2) error(`fluid-chain: ${p.recipe} needs at most one solid and two fluids`)
  const C = math.max(1, p.chemPlants)
  const R = math.max(1, p.refineries)
  const W = 1 + math.max(5 * R, 3 * C)
  const H = other !== undefined ? 18 : 16
  // Fluid boxes in recipe order (no fluidbox_index: the machine takes them in ingredient order).
  const midBox = mid.box ?? 1
  const midIn = fluidsIn.findIndex((i) => i.name === mid.name) + 1
  const otherIn = other !== undefined ? fluidsIn.findIndex((i) => i.name === other.name) + 1 : 0
  const rawBox = raw.box ?? 1
  // Product and solid-input belts.
  for (let x = 0; x < W; x++) L.beltAt(x + 0.5, 0.5, WEST)
  // The solid input runs east to the last plant's inserter (it ends inside the footprint).
  if (solidsIn.length > 0) for (let x = 0; x <= 1 + 3 * (math.max(1, p.chemPlants) - 1); x++) L.beltAt(x + 0.5, 1.5, EAST)
  // Chemical plants, facing south: their inputs point down to row 6.
  for (let j = 0; j < C; j++) {
    const c0 = 1 + 3 * j
    L.add(chem, c0 + 1.5, 4.5, SOUTH, { recipe: recipe.name })
    if (solidsIn.length > 0) L.ins(c0 + 0.5, 2.5, NORTH)
    L.add(long, c0 + 2.5, 2.5, SOUTH)
    L.poleAt(c0 + 1.5, 2.5)
    const m = boxTile(facts, chem, "input", midIn, c0 + 1.5, 4.5, 2)
    L.add(pipe, m.x + 0.5, m.y + 0.5)
    if (otherIn > 0) {
      // The other fluid comes up from the bottom manifold on a pipe-to-ground pair.
      const o = boxTile(facts, chem, "input", otherIn, c0 + 1.5, 4.5, 2)
      L.add(ptg, o.x + 0.5, o.y + 0.5, NORTH)
      L.add(ptg, o.x + 0.5, H - 1.5, SOUTH)
    }
  }
  // Intermediate manifold (row 7) and the refineries below it, facing north.
  for (let x = 0; x < W; x++) L.add(pipe, x + 0.5, 7.5)
  for (let i = 0; i < R; i++) {
    const x0 = 1 + 5 * i
    L.add(refinery, x0 + 2.5, 11.5, NORTH, { recipe: source.name })
    const up = boxTile(facts, refinery, "output", midBox, x0 + 2.5, 11.5, 0)
    L.add(pipe, up.x + 0.5, up.y + 0.5)
    const down = boxTile(facts, refinery, "input", rawBox, x0 + 2.5, 11.5, 0)
    L.add(pipe, down.x + 0.5, down.y + 0.5)
    L.poleAt(x0 + 1.5, 8.5)
  }
  // Raw-fluid manifold (row 15) and the other fluid's (row 17).
  for (let x = 0; x < W; x++) L.add(pipe, x + 0.5, 15.5)
  if (other !== undefined) for (let x = 0; x < W; x++) L.add(pipe, x + 0.5, 17.5)
  const ports: Port[] = [
    { id: `out-${product.name}`, kind: "belt-out", pos: { x: 0.5, y: 0.5 }, dir: WEST, item: product.name },
    { id: `in-${raw.name}`, kind: "pipe-in", pos: { x: 0.5, y: 15.5 }, dir: EAST, item: raw.name },
    { id: "power", kind: "power", pos: { x: 2.5, y: 2.5 }, dir: NORTH },
  ]
  if (solidsIn.length > 0) ports.push({ id: `in-${solidsIn[0].name}`, kind: "belt-in", pos: { x: 0.5, y: 1.5 }, dir: EAST, item: solidsIn[0].name })
  if (other !== undefined) ports.push({ id: `in-${other.name}`, kind: "pipe-in", pos: { x: 0.5, y: 17.5 }, dir: EAST, item: other.name })
  const draft: ModuleDraft = {
    id: `fluid-chain/${p.recipe}/${C}/${R}`,
    source: "generated",
    generator: "fluid-chain",
    provenance: "generator fluid-chain (Rival Engineers)",
    description: `${R} ${refinery} (${source.name}) under ${C} ${chem} (${p.recipe})`,
    footprint: { w: W, h: H },
    entities: L.entities,
    ports,
    rotatable: true,
    mirrorable: false,
    params: { recipe: p.recipe, source: source.name, chemPlants: C, refineries: R },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Water pump (M7b)

export interface WaterPumpParams extends CommonParams {
  pump?: string
  pipe?: string
}

/**
 * An offshore pump on a shore (water west of the footprint, `site = shore` like the steam block) and the pipe its
 * output connects to, which is the `pipe-out` port (flowing east). The pump faces west: its output is on its east side.
 */
export function waterPump(facts: ProtoFacts, p: WaterPumpParams): ModuleDef {
  const pump = p.pump ?? "offshore-pump"
  const pipe = p.pipe ?? "pipe"
  const L = new Layout(p.belt ?? "transport-belt", p.inserter ?? "inserter", p.pole ?? "small-electric-pole")
  L.add(pump, 0.5, 0.5, WEST)
  L.add(pipe, 1.5, 0.5)
  const draft: ModuleDraft = {
    id: `water-pump/${pump}`,
    source: "generated",
    generator: "water-pump",
    provenance: "generator water-pump (Rival Engineers)",
    description: `${pump} and its output pipe`,
    footprint: { w: 2, h: 1 },
    entities: L.entities,
    ports: [{ id: "out-water", kind: "pipe-out", pos: { x: 1.5, y: 0.5 }, dir: EAST, item: "water" }],
    rotatable: true,
    mirrorable: false,
    site: "shore",
    anchor: { water: [{ x: -2, y: -1, w: 2, h: 3 }] },
    params: { pump },
  }
  return finalizeModule(draft, facts)
}

// ---------------------------------------------------------------------------------------------------------
// Pumpjack field (M7b)

export interface PumpjackFieldParams extends CommonParams {
  /**
   * The wells: tile of each (the pumpjack is centred on it) and its crude per second; any origin. Module params hold
   * them encoded (`x,y,perSecond;…`, `encodeWells`) so the module can be generated again from its params.
   */
  wells: { x: number; y: number; perSecond: number }[] | string
  resource?: string
  pumpjack?: string
  pipe?: string
  /**
   * B119: tiles in the field's box nothing can stand on (cliffs, water), in the wells' coordinates, encoded `x,y;…`.
   * Pipes and poles go around them; a well whose output cannot reach the port is left out.
   */
  obstacles?: string
}

/**
 * A pumpjack on every well of a field, all facing north, and plain pipes joining their outputs to one `pipe-out`
 * port on the east edge (only one fluid here, so pipes may touch anything). Poles from `placePoles`. The footprint is
 * the pumpjacks' box plus a margin of `PUMPJACK_FIELD_MARGIN` tiles for pipes and poles.
 */
export function pumpjackField(facts: ProtoFacts, p: PumpjackFieldParams): ModuleDef {
  const pumpjack = p.pumpjack ?? "pumpjack"
  const pipe = p.pipe ?? "pipe"
  const resource = p.resource ?? "crude-oil"
  const wells = typeof p.wells === "string" ? decodeWells(p.wells) : p.wells
  if (wells.length === 0) error("pumpjack-field: no wells")
  const M = PUMPJACK_FIELD_MARGIN
  let minX = math.huge
  let minY = math.huge
  let maxX = -math.huge
  let maxY = -math.huge
  for (const w of wells) {
    minX = math.min(minX, w.x)
    minY = math.min(minY, w.y)
    maxX = math.max(maxX, w.x)
    maxY = math.max(maxY, w.y)
  }
  // Module-local tile of each well: the pumpjack (3×3) covers it ±1; M tiles of room around.
  const ox = minX - 1 - M
  const oy = minY - 1 - M
  const W = maxX - minX + 3 + 2 * M
  const H = maxY - minY + 3 + 2 * M
  const blocked: Record<string, boolean> = {}
  const entities: ModuleEntity[] = []
  const outs: { x: number; y: number }[] = []
  const box = need(facts.entity(pumpjack)?.fluidBoxes?.find((b) => b.production === "output"), `${pumpjack} has no output fluid box`)
  const c = box.connections[0]
  if (p.obstacles !== undefined) for (const [x, y] of string.gmatch(p.obstacles, "(-?%d+),(-?%d+)")) blocked[`${tonumber(x)! - ox},${tonumber(y)! - oy}`] = true
  for (const w of wells) {
    const x = w.x - ox
    const y = w.y - oy
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked[`${x + dx},${y + dy}`] = true
    outs.push({ x: x + c.x + [0, 1, 0, -1][c.dir], y: y + c.y + [-1, 0, 1, 0][c.dir] })
  }
  // The port: the east edge, on the row of the first output; the collector grows from it to each output in turn.
  // B119: the first such row whose edge tile is free (a cliff may stand there).
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && !blocked[`${x},${y}`]
  const portRow = outs.find((o) => inside(W - 1, o.y))
  if (portRow === undefined) error("pumpjack-field: no free edge tile on a well output's row")
  const port = { x: W - 1, y: portRow.y }
  const pipes: Record<string, boolean> = { [`${port.x},${port.y}`]: true }
  const kept: typeof wells = []
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i]
    const w = wells[i]
    if (pipes[`${o.x},${o.y}`]) {
      kept.push(w)
      continue
    }
    // BFS from the output to the nearest collector tile.
    const prev: Record<string, string> = {}
    const queue: { x: number; y: number }[] = [o]
    prev[`${o.x},${o.y}`] = ""
    let hit: string | undefined
    while (queue.length > 0 && hit === undefined) {
      const t = queue.shift()!
      for (let d = 0; d < 4; d++) {
        const nx = t.x + [0, 1, 0, -1][d]
        const ny = t.y + [-1, 0, 1, 0][d]
        const k = `${nx},${ny}`
        if (prev[k] !== undefined || !inside(nx, ny)) continue
        prev[k] = `${t.x},${t.y}`
        if (pipes[k]) {
          hit = k
          break
        }
        queue.push({ x: nx, y: ny })
      }
    }
    // B119: a well walled off by cliffs or water is left out.
    if (hit === undefined) continue
    kept.push(w)
    for (let k: string = prev[hit]; k !== ""; k = prev[k]) pipes[k] = true
  }
  for (const w of kept) entities.push({ name: pumpjack, x: w.x - ox + 0.5, y: w.y - oy + 0.5, dir: NORTH, mines: resource, perSecond: w.perSecond })
  for (const [k] of pairs(pipes)) {
    const [xs, ys] = string.match(k as string, "^(-?%d+),(-?%d+)$")
    entities.push({ name: pipe, x: tonumber(xs)! + 0.5, y: tonumber(ys)! + 0.5 })
    blocked[k as string] = true
  }
  if (kept.length === 0) error("pumpjack-field: no well output reaches the port")
  const poles = placePoles({ w: W, h: H }, entities, facts, p.pole ?? "small-electric-pole", blocked)
  const first = poles[0]
  for (const pole of poles) entities.push(pole)
  let total = 0
  for (const w of kept) total += w.perSecond
  const draft: ModuleDraft = {
    id: `pumpjack-field/${encodeWells(kept)}`,
    source: "generated",
    generator: "pumpjack-field",
    provenance: "generator pumpjack-field (Rival Engineers)",
    description: `${kept.length} ${pumpjack} on ${resource}, ${string.format("%.1f", total)}/s`,
    footprint: { w: W, h: H },
    entities,
    ports: [
      { id: `out-${resource}`, kind: "pipe-out", pos: { x: port.x + 0.5, y: port.y + 0.5 }, dir: EAST, item: resource },
      { id: "power", kind: "power", pos: { x: first?.x ?? 0.5, y: first?.y ?? 0.5 }, dir: NORTH },
    ],
    rotatable: false,
    mirrorable: false,
    // Generated for one field: the planner places it exactly there (`ModuleRequest.at`), not by a site search.
    anchor: { resource },
    params: p.obstacles !== undefined ? { wells: encodeWells(wells), resource, obstacles: p.obstacles } : { wells: encodeWells(wells), resource },
  }
  return finalizeModule(draft, facts)
}

export function encodeWells(wells: { x: number; y: number; perSecond: number }[]): string {
  return wells.map((w) => string.format("%d,%d,%g", w.x, w.y, w.perSecond)).join(";")
}

function decodeWells(s: string): { x: number; y: number; perSecond: number }[] {
  const out: { x: number; y: number; perSecond: number }[] = []
  for (const [x, y, r] of string.gmatch(s, "(-?%d+),(-?%d+),([%d%.e%-]+)")) out.push({ x: tonumber(x)!, y: tonumber(y)!, perSecond: tonumber(r)! })
  return out
}

/** Tiles of room around a pumpjack field's pumpjacks for its pipes and poles (agent guess). */
const PUMPJACK_FIELD_MARGIN = 2

export type GeneratorName = "smelter-column" | "mining-outpost" | "steam-block" | "assembler-row" | "red-line" | "circuit-block" | "lab-array" | "chest-cell" | "radar" | "fluid-chain" | "water-pump" | "pumpjack-field"

/** Runs a generator by name with loosely typed params (remote interface, data-driven callers). */
export function generate(facts: ProtoFacts, name: GeneratorName, params: Record<string, unknown>): ModuleDef {
  const P = params as never
  if (name === "smelter-column") return smelterColumn(facts, P)
  if (name === "mining-outpost") return miningOutpost(facts, P)
  if (name === "steam-block") return steamBlock(facts, P)
  if (name === "assembler-row") return assemblerRow(facts, P)
  if (name === "red-line") return redLine(facts, P)
  if (name === "circuit-block") return circuitBlock(facts, P)
  if (name === "lab-array") return labArray(facts, P)
  if (name === "chest-cell") return chestCell(facts, P)
  if (name === "radar") return radarCell(facts, P)
  if (name === "fluid-chain") return fluidChain(facts, P)
  if (name === "water-pump") return waterPump(facts, P)
  if (name === "pumpjack-field") return pumpjackField(facts, P)
  return error(`unknown generator ${name}`)
}

export const GENERATORS: GeneratorName[] = ["smelter-column", "mining-outpost", "steam-block", "assembler-row", "red-line", "circuit-block", "lab-array", "chest-cell", "radar", "fluid-chain", "water-pump", "pumpjack-field"]
