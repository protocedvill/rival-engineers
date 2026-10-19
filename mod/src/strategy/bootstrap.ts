import { BoundingBox, LuaEntity, LuaForce, LuaInventory, LuaSurface, MapPosition } from "factorio:runtime"
import { Config, getConfig } from "../config"
import { addJob, failJob, ItemCount, Job, JobSpec } from "../jobs/board"
import { craftYield, resetMember } from "../jobs/crew"
import { addStockpile, factionForce, factionSurface, tileRect } from "../jobs/faction"
import { FactionState, JobPayload } from "../jobs/types"
import { bestPatch, exploreNow, Patch, positionDistance, scanPatches } from "../world/resources"
import { claimed, claimOreField, otherClaims } from "../world/claims"
import { requiredResources } from "../world/spawn"
import { buildCatalog, expandRecipe, handRecipe } from "./catalog"
import { supplyChests, tempCells } from "./factory-report"
import { bufferChests } from "../modules/buffers"
import { setSupplies, SupplyPoint, supplyStock } from "../jobs/supply"
import { BrainState, Catalog, Goal, Site, SiteKind, SitePart } from "./types"
import { countEntities, findEntities } from "../work"
import { destroyEntity, markDirty } from "../planner/terrain"

// The burner bootstrap (SPEC §5.5, §8 M3): a first, simple strategy layer. Each faction's brain runs every
// `brain-interval-ticks` and turns goals into Job Board jobs; the crew does everything physically.
//
// Documented heuristics (§5.5 allows scripted heuristics for the burner bootstrap):
//  H1 Goal list. A depot chest first, then burner sites interleaved by resource: always the resource whose
//     built/target ratio is lowest (ties in `bootstrap-sites` order). The first-electricity kit comes as soon
//     as every resource has half its target sites (rounded up); the remaining sites follow it.
//     Site kind comes from prototypes: a resource whose product is a fuel gets self-feeding drill pairs, one
//     that smelts gets a drill feeding a furnace, anything else a drill feeding a chest.
//  H2 At most SITE_WINDOW goals are worked on at once, so materials go to the earliest goals first.
//  H3 Everything gathered or crafted goes to the depot; crew empty their pockets there between jobs. Craft jobs
//     take raw materials (the crafting queue makes intermediates).
//  H4 Demand-driven production: the materials of active jobs and the goal's items are the demand. Stock is what the
//     depot, the crew's pockets and the supply points hold (B32: furnace plates and chests of sites, surplus coal in
//     pairs, the factory's output chests, module buffers, within `supply-radius` of the hub): the crew takes from
//     supply points directly when a job needs the item. A shortfall beyond that is met by temporary cells, by
//     hand-crafting, or by hand-mining (ore goes straight into a furnace of its kind). Hand-mining is capped at one
//     job per crew member.
//  H5 Burners are refuelled when they hold less than FUEL_LOW_MINUTES of fuel, up to FUEL_TOP_MINUTES.
//     Outputs are never moved to the depot (B32): a full furnace just pauses its drill until a job takes its plates
//     (collecting everything filled depot after depot with plates nobody needed).
//  H6 Sites go on the patch chosen by distance and size from the hub (the depot), on the patch tiles
//     nearest the depot, facing it, one tile apart, on tiles free of trees and rocks.

const SITE_WINDOW = 2
const FUEL_LOW_MINUTES = 2
const FUEL_TOP_MINUTES = 8
/** Coal kept in each drill of a self-feeding pair when the crew takes its surplus. */
const PAIR_KEEP = 10
/** Coal the depot should hold on top of open fuel jobs. */
const FUEL_BUFFER = 20
const GATHER_CHUNK = 20
/** Most raw items in one craft job (a crew member carries them in one trip). */
const CRAFT_CHUNK_RAW = 60
const PRIORITY = { fuel: 100, place: 90, feed: 55, craft: 50, gather: 20 }
/** H7: when a needed resource has no known patch, explore this much farther, up to EXPLORE_MAX × scan-radius. */
const EXPLORE_STEP = 64
const EXPLORE_MAX = 3
/** D43: a new mining site must hold this many times the depletion lead time of ore, or it would be replaced at once. */
const SITE_MIN_LIFE = 2
const PRIORITY_RETIRE = 60

type CrewJob = Job<JobPayload>

// ---------------------------------------------------------------------------------------------------
// Setup

function parseCounts(value: string): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = []
  for (const [name, count] of string.gmatch(value, "([^=,%s]+)%s*=%s*(%d+)")) out.push({ name, count: tonumber(count)! })
  return out
}

export function siteKindFor(catalog: Catalog, resource: string): SiteKind {
  const product = prototypes.entity[resource]?.mineable_properties.products?.[0]?.name
  if (product === catalog.fuel) return "pair"
  if (product !== undefined && catalog.smelts[product] !== undefined) return "smelt"
  return "chest"
}

/** H1: the goal list from `bootstrap-sites` and `first-electricity-items`. */
export function makeGoals(catalog: Catalog, config: Config): Goal[] {
  const goals: Goal[] = [{ kind: "site", site: "depot" }]
  const targets = parseCounts(config.bootstrapSites)
  const planned: number[] = []
  const wanted: number[] = []
  for (const t of targets) {
    const kind = siteKindFor(catalog, t.name)
    planned.push(0)
    wanted.push(kind === "pair" ? math.ceil(t.count / 2) : t.count)
  }
  const items: Record<string, number> = {}
  for (const it of parseCounts(config.firstElectricityItems)) items[it.name] = it.count
  let kitPlaced = false
  for (;;) {
    if (!kitPlaced) {
      let half = true
      for (let i = 0; i < targets.length; i++) if (planned[i] < math.ceil(wanted[i] / 2)) half = false
      if (half) {
        goals.push({ kind: "items", items, label: "first-electricity-materials" })
        kitPlaced = true
      }
    }
    let pick = -1
    let pickRatio = math.huge
    for (let i = 0; i < targets.length; i++) {
      if (planned[i] >= wanted[i]) continue
      const ratio = planned[i] / wanted[i]
      if (ratio < pickRatio) {
        pick = i
        pickRatio = ratio
      }
    }
    if (pick < 0) break
    planned[pick]++
    goals.push({ kind: "site", site: siteKindFor(catalog, targets[pick].name), resource: targets[pick].name })
  }
  if (!kitPlaced) goals.push({ kind: "items", items, label: "first-electricity-materials" })
  return goals
}

/** Starts the burner bootstrap for a faction whose crew stands at `base`. */
export function startBootstrap(faction: FactionState, base: MapPosition): BrainState {
  const config = getConfig()
  const surface = factionSurface(faction)
  const force = factionForce(faction)
  const resources = requiredResources(config)
  const catalog = buildCatalog(force, resources)
  // Crew don't chart: generate what a player exploring around the base would see, and scan it.
  exploreNow(surface, base, config.scanRadius)
  const brain: BrainState = {
    base: { x: base.x, y: base.y },
    catalog,
    patches: scanPatches(surface, base, config.scanRadius),
    badPatches: {},
    sites: [],
    nextSiteId: 1,
    goals: makeGoals(catalog, config),
    reserved: {},
    jobKeys: {},
    milestones: {},
    progressTick: game.tick,
    progressSteps: 0,
    stalls: [],
    replans: 0,
    waiting: [],
    done: false,
    nextThink: game.tick,
    lastPrune: game.tick,
    steps: 0,
    exploreRadius: config.scanRadius,
  }
  faction.brain = brain
  brain.hub = chooseHub(brain, resources, parseCounts(config.bootstrapSites))
  log(`[rival-engineers] faction ${faction.name}: bootstrap at ${base.x},${base.y}, hub ${brain.hub.x},${brain.hub.y}, ${brain.patches.length} patches, ${brain.goals.length} goals`)
  return brain
}

/** The hub (where the depot goes): the nearest point of each needed patch, weighted by its drill target. */
function chooseHub(brain: BrainState, resources: string[], targets: { name: string; count: number }[]): MapPosition {
  let sx = 0
  let sy = 0
  let sw = 0
  for (const res of resources) {
    const patch = bestPatch(brain.patches, res, brain.base, 8)
    if (!patch) continue
    let w = 1
    for (const t of targets) if (t.name === res) w = math.max(1, t.count)
    sx += math.min(math.max(brain.base.x, patch.x1), patch.x2) * w
    sy += math.min(math.max(brain.base.y, patch.y1), patch.y2) * w
    sw += w
  }
  if (sw === 0) return brain.base
  return { x: sx / sw, y: sy / sw }
}

// ---------------------------------------------------------------------------------------------------
// Tick

export function onBrainTick(): void {
  const tick = game.tick
  let config: Config | undefined
  for (const name of storage.factionOrder) {
    const faction = storage.factions[name]
    const brain = faction.brain
    if (!brain || faction.paused || tick < brain.nextThink) continue
    config ??= getConfig()
    brain.nextThink = tick + config.brainIntervalTicks
    think(faction, brain, config, tick)
  }
}

interface Ctx {
  faction: FactionState
  brain: BrainState
  config: Config
  tick: number
  surface: LuaSurface
  force: LuaForce
  /** What the depot, the crew's pockets and the supply points hold. */
  stock: Record<string, number>
  /** The depot and the crew's pockets only (ore there is fed into furnaces). */
  depotStock: Record<string, number>
  pending: Record<string, number>
  demand: Record<string, number>
  order: string[]
  /** Ore on its way into furnaces (hand-mined, fed from the depot), by ore. */
  oreInbound: Record<string, number>
  gathers: number
  /** Active gathers from trees (wood), counted apart: they are batched into trips (B3). */
  woodGathers: number
  depot?: LuaEntity
  waiting: string[]
}

function think(faction: FactionState, brain: BrainState, config: Config, tick: number): void {
  const ctx: Ctx = {
    faction,
    brain,
    config,
    tick,
    surface: factionSurface(faction),
    force: factionForce(faction),
    stock: {},
    depotStock: {},
    pending: {},
    demand: {},
    order: [],
    oreInbound: {},
    gathers: 0,
    woodGathers: 0,
    depot: undefined,
    waiting: [],
  }
  if (brain.rescanAt !== undefined && tick >= brain.rescanAt) {
    brain.rescanAt = undefined
    brain.patches = scanPatches(ctx.surface, brain.hub ?? brain.base, brain.exploreRadius)
    brain.badPatches = {}
  }
  updateSites(ctx)
  checkDepletion(ctx)
  ctx.depot = pickDepot(ctx)
  registerSupplies(ctx)
  countStock(ctx)
  advanceGoals(ctx)
  scanJobs(ctx)
  maintain(ctx)
  reconcile(ctx)
  // B18: what the live orders leave of the surplus stocks the temporary cells (requests win; the refills' crew
  // priority is its own setting).
  topUpTempCells(ctx)
  milestones(ctx)
  brain.waiting = ctx.waiting
  checkStall(ctx)
  if (tick - brain.lastPrune >= 3600) {
    brain.lastPrune = tick
    pruneBoard(faction, tick)
  }
}

// ---------------------------------------------------------------------------------------------------
// Sites

function tkey(x: number, y: number): number {
  return (x + 1048576) * 2097152 + (y + 1048576)
}

const UNIT: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }

function rotate(v: { x: number; y: number }, direction: number): { x: number; y: number } {
  let x = v.x
  let y = v.y
  for (let q = 0; q < direction / 4; q++) {
    const nx = -y
    y = x
    x = nx
  }
  return { x, y }
}

function opposite(direction: number): defines.direction {
  return ((direction + 8) % 16) as defines.direction
}

interface PlannedPart {
  entity: string
  item: string
  position: MapPosition
  direction: defines.direction
  burner: boolean
  /** Tiles it covers. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Drills: every covered tile must be the resource. */
  onOre: boolean
}

function partAt(entity: string, item: string, position: MapPosition, direction: defines.direction, onOre: boolean): PlannedPart {
  const proto = prototypes.entity[entity]
  const sideways = direction === defines.direction.east || direction === defines.direction.west
  const w = sideways ? proto.tile_height : proto.tile_width
  const h = sideways ? proto.tile_width : proto.tile_height
  const x1 = math.floor(position.x - w / 2 + 0.01)
  const y1 = math.floor(position.y - h / 2 + 0.01)
  return { entity, item, position, direction, burner: proto.burner_prototype !== undefined, x1, y1, x2: x1 + w, y2: y1 + h, onOre }
}

function dropPoint(catalog: Catalog, center: MapPosition, direction: number): MapPosition {
  // vector_to_place_result reads back as a {x, y} table or an {x, y} array depending on the API path.
  const raw = (prototypes.entity[catalog.drill].vector_to_place_result ?? { x: 0, y: -1.3 }) as unknown as Record<string | number, number>
  const v = { x: raw.x ?? raw[1], y: raw.y ?? raw[2] }
  const r = rotate(v, direction)
  return { x: center.x + r.x, y: center.y + r.y }
}

function inside(p: MapPosition, part: PlannedPart): boolean {
  return p.x > part.x1 && p.x < part.x2 && p.y > part.y1 && p.y < part.y2
}

/** The parts of a site whose (first) drill is centred at `c` facing `direction`. */
function layout(catalog: Catalog, kind: SiteKind, c: MapPosition, direction: defines.direction): PlannedPart[] | undefined {
  const [ux, uy] = UNIT[direction]
  const drill = partAt(catalog.drill, catalog.drillItem, c, direction, true)
  const drop = dropPoint(catalog, c, direction)
  // A 2×2 drill's neighbour of the same size sits 2 tiles over; size it from the prototype.
  const step = prototypes.entity[catalog.drill].tile_width
  let out: PlannedPart
  if (kind === "smelt") {
    const fw = prototypes.entity[catalog.furnace].tile_width
    const off = (step + fw) / 2
    out = partAt(catalog.furnace, catalog.furnaceItem, { x: c.x + ux * off, y: c.y + uy * off }, defines.direction.north, false)
  } else if (kind === "chest") {
    out = partAt(catalog.chest, catalog.chestItem, { x: math.floor(drop.x) + 0.5, y: math.floor(drop.y) + 0.5 }, defines.direction.north, false)
  } else {
    const back = opposite(direction)
    out = partAt(catalog.drill, catalog.drillItem, { x: c.x + ux * step, y: c.y + uy * step }, back, true)
    if (!inside(dropPoint(catalog, out.position, back), drill)) return undefined
  }
  if (!inside(drop, out)) return undefined
  return [drill, out]
}

/** The table-lookup part of `rectFree`: own reservations, ore under a drill, active hand-mining. */
function rectCheap(ctx: Ctx, part: PlannedPart, ore: Record<number, boolean>): boolean {
  for (let x = part.x1; x < part.x2; x++) {
    for (let y = part.y1; y < part.y2; y++) {
      if (ctx.brain.reserved[tkey(x, y)]) return false
      if (part.onOre && !ore[tkey(x, y)]) return false
      if (keyActive(ctx, `res:${x},${y}`)) return false
    }
  }
  return true
}

/** Whether a site part fits: free, unclaimed tiles, and for a drill every tile on `resource` and no other ore in reach. */
function rectFree(ctx: Ctx, part: PlannedPart, ore: Record<number, boolean>, resource: string): boolean {
  const others = otherClaims(ctx.faction.name, ctx.faction.surface)
  for (let x = part.x1; x < part.x2; x++) {
    for (let y = part.y1; y < part.y2; y++) {
      if (ctx.brain.reserved[tkey(x, y)]) return false
      // Another faction's claim (M5a.2): its sites, planned modules and routes.
      if (claimed(others, tkey(x, y))) return false
      if (part.onOre && !ore[tkey(x, y)]) return false
      // Never plan over a tile someone is hand-mining: mining there would deconstruct the ghost.
      if (keyActive(ctx, `res:${x},${y}`)) return false
    }
  }
  // B6: a drill mines every resource in its mining area. A foreign ore would end up in the furnace or chest.
  if (part.onOre && foreignOreIn(ctx, part.entity, part.position, resource)) return false
  return ctx.surface.can_place_entity({
    name: part.entity,
    position: part.position,
    direction: part.direction,
    force: ctx.faction.force,
    build_check_type: defines.build_check_type.manual,
  })
}

/** A drill's mining area (D43, B6): centred on the drill, `mining_drill_radius` each way. */
function miningArea(drill: string, position: MapPosition): BoundingBox {
  const r = prototypes.entity[drill].mining_drill_radius ?? 1
  return { left_top: { x: position.x - r, y: position.y - r }, right_bottom: { x: position.x + r, y: position.y + r } }
}

/** Whether a resource other than `resource` lies in the drill's mining area. */
function foreignOreIn(ctx: Ctx, drill: string, position: MapPosition, resource: string): boolean {
  for (const e of findEntities(ctx.surface, { area: miningArea(drill, position), type: "resource" })) if (e.name !== resource) return true
  return false
}

/** Ore of `resource` left in the drill's mining area. */
function oreLeft(surface: LuaSurface, drill: string, position: MapPosition, resource: string): number {
  let n = 0
  for (const e of findEntities(surface, { area: miningArea(drill, position), name: resource })) n += e.amount
  return n
}

/** Ore a drill mines per minute from `resource`. */
function drillRate(drill: string, resource: string): number {
  const speed = prototypes.entity[drill].mining_speed ?? 0.25
  const time = prototypes.entity[resource].mineable_properties.mining_time || 1
  return (speed * 60) / time
}

/** Minutes of ore a planned or built drill has left. */
function drillMinutes(surface: LuaSurface, drill: string, position: MapPosition, resource: string): number {
  return oreLeft(surface, drill, position, resource) / drillRate(drill, resource)
}

function directionsToward(from: MapPosition, to: MapPosition): defines.direction[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dirs: { d: defines.direction; s: number }[] = [
    { d: defines.direction.north, s: -dy },
    { d: defines.direction.east, s: dx },
    { d: defines.direction.south, s: dy },
    { d: defines.direction.west, s: -dx },
  ]
  dirs.sort((a, b) => (a.s !== b.s ? b.s - a.s : a.d - b.d))
  const out: defines.direction[] = []
  for (const e of dirs) out.push(e.d)
  return out
}

function oreTiles(ctx: Ctx, patch: Patch, near: MapPosition, half: number): { set: Record<number, boolean>; tiles: { x: number; y: number; amount: number }[] } {
  const x1 = math.max(patch.x1, near.x - half)
  const y1 = math.max(patch.y1, near.y - half)
  const x2 = math.min(patch.x2, near.x + half)
  const y2 = math.min(patch.y2, near.y + half)
  const set: Record<number, boolean> = {}
  const tiles: { x: number; y: number; amount: number }[] = []
  if (x1 >= x2 || y1 >= y2) return { set, tiles }
  for (const e of findEntities(ctx.surface, { name: patch.name, area: [[x1, y1], [x2, y2]] })) {
    const tx = math.floor(e.position.x)
    const ty = math.floor(e.position.y)
    set[tkey(tx, ty)] = true
    tiles.push({ x: tx, y: ty, amount: e.amount })
  }
  return { set, tiles }
}

/** H6: find a spot for a site of `kind` on `patch`, nearest the hub. */
function findSiteSpot(ctx: Ctx, patch: Patch, kind: SiteKind): PlannedPart[] | undefined {
  const hub = ctx.brain.hub ?? ctx.brain.base
  const near = { x: math.min(math.max(hub.x, patch.x1), patch.x2), y: math.min(math.max(hub.y, patch.y1), patch.y2) }
  for (const half of [12, 32, 96]) {
    const { set, tiles } = oreTiles(ctx, patch, near, half)
    tiles.sort((a, b) => {
      const da = positionDistance(a, hub)
      const db = positionDistance(b, hub)
      return da !== db ? da - db : a.x !== b.x ? a.x - b.x : a.y - b.y
    })
    let checks = 0
    const w = prototypes.entity[ctx.brain.catalog.drill].tile_width
    // B15: a tile far below its share of the ore a drill needs for SITE_MIN_LIFE is worked out: skip it unscanned.
    const r = prototypes.entity[ctx.brain.catalog.drill].mining_drill_radius ?? 1
    const share = (SITE_MIN_LIFE * ctx.config.bootstrapDepletionMinutes * drillRate(ctx.brain.catalog.drill, patch.name)) / math.max(1, (2 * r) * (2 * r))
    for (const t of tiles) {
      if (checks > 600) break
      if (t.amount < share / 4) continue
      // The drill's top-left tile is t, so its centre is t + (w/2, h/2).
      const c = { x: t.x + w / 2, y: t.y + w / 2 }
      for (const d of directionsToward(c, hub)) {
        const parts = layout(ctx.brain.catalog, kind, c, d)
        if (!parts) continue
        // B15: only spots that pass the table lookups count toward the cap (the entity scans are what costs). Near
        // the hub a patch is often all reserved by the factory's modules or worked out: those must not use it up.
        let ok = true
        for (const p of parts) if (!rectCheap(ctx, p, set)) ok = false
        if (!ok) continue
        checks++
        for (const p of parts) if (ok && !rectFree(ctx, p, set, patch.name)) ok = false
        // D43: enough ore under every drill that the site is not replaced right away.
        const minLife = SITE_MIN_LIFE * ctx.config.bootstrapDepletionMinutes
        for (const p of parts) if (ok && p.onOre && minLife > 0 && drillMinutes(ctx.surface, p.entity, p.position, patch.name) < minLife) ok = false
        if (ok) return parts
      }
    }
  }
  return undefined
}

/** A spot for the depot chest near the hub: buildable, not on resources, with room to walk around. */
function findDepotSpot(ctx: Ctx): PlannedPart | undefined {
  const hub = ctx.brain.hub ?? ctx.brain.base
  const cx = math.floor(hub.x)
  const cy = math.floor(hub.y)
  const catalog = ctx.brain.catalog
  for (let r = 0; r <= 24; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (math.max(math.abs(dx), math.abs(dy)) !== r) continue
        const part = partAt(catalog.chest, catalog.chestItem, { x: cx + dx + 0.5, y: cy + dy + 0.5 }, defines.direction.north, false)
        let ok = true
        const others = otherClaims(ctx.faction.name, ctx.faction.surface)
        for (let x = part.x1 - 2; x < part.x2 + 2 && ok; x++) {
          for (let y = part.y1 - 2; y < part.y2 + 2 && ok; y++) if (ctx.brain.reserved[tkey(x, y)] || claimed(others, tkey(x, y))) ok = false
        }
        if (!ok) continue
        if (countEntities(ctx.surface, { type: "resource", area: [[part.x1 - 1, part.y1 - 1], [part.x2 + 1, part.y2 + 1]] }) > 0) continue
        // Free ground around it (no trees, rocks or water within a tile).
        if (countEntities(ctx.surface, { area: [[part.x1 - 1, part.y1 - 1], [part.x2 + 1, part.y2 + 1]], type: ["tree", "simple-entity", "cliff"] }) > 0) continue
        if (!ctx.surface.can_place_entity({ name: part.entity, position: part.position, force: ctx.faction.force, build_check_type: defines.build_check_type.manual })) continue
        if (!ctx.surface.can_place_entity({ name: "character", position: { x: part.position.x + 1.5, y: part.position.y } })) continue
        return part
      }
    }
  }
  return undefined
}

function reserveParts(ctx: Ctx, parts: PlannedPart[], margin: number): number[] {
  const keys: number[] = []
  for (const p of parts) {
    for (let x = p.x1 - margin; x < p.x2 + margin; x++) {
      for (let y = p.y1 - margin; y < p.y2 + margin; y++) {
        const k = tkey(x, y)
        if (!ctx.brain.reserved[k]) {
          ctx.brain.reserved[k] = true
          keys.push(k)
        }
      }
    }
  }
  return keys
}

/** Creates the site's ghosts (the visible plan) and a place job for each. */
function createSite(ctx: Ctx, kind: SiteKind, parts: PlannedPart[], resource?: string, patch?: number): Site | undefined {
  const site: Site = { id: ctx.brain.nextSiteId++, kind, resource, patch, parts: [], tiles: [], status: "planned", createdTick: ctx.tick }
  const ghosts: LuaEntity[] = []
  for (const p of parts) {
    const ghost = ctx.surface.create_entity({ name: "entity-ghost", inner_name: p.entity, position: p.position, direction: p.direction, force: ctx.faction.force })
    if (!ghost) {
      for (const g of ghosts) if (g.valid) destroyEntity(g)
      return undefined
    }
    ghosts.push(ghost)
  }
  site.tiles = reserveParts(ctx, parts, kind === "depot" ? 2 : 1)
  if (resource !== undefined) {
    ctx.brain.oreFields ??= {}
    for (const p of parts) if (p.onOre) claimOreField(ctx.surface, ctx.brain.oreFields, resource, p.x1, p.y1)
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const ghost = ghosts[i]
    const job = addJob(
      ctx.faction.board,
      {
        kind: "place",
        pos: { x: ghost.position.x, y: ghost.position.y },
        footprint: tileRect(ghost.bounding_box),
        materials: [{ item: p.item, count: 1 }],
        priority: PRIORITY.place,
        payload: { kind: "place", item: p.item, entity: p.entity, position: ghost.position, direction: ghost.direction, ghost, ghostKey: ghost.unit_number! },
      },
      ctx.tick,
    )
    ctx.faction.ghostJobs[ghost.unit_number!] = job.id
    const part: SitePart = { entity: p.entity, item: p.item, position: ghost.position, direction: ghost.direction, job: job.id, burner: p.burner }
    site.parts.push(part)
  }
  ctx.brain.sites.push(site)
  return site
}

/** Reads the place jobs of planned sites: built parts, finished sites, failed placements. */
function updateSites(ctx: Ctx): void {
  const board = ctx.faction.board
  for (const site of ctx.brain.sites) {
    if (site.status !== "planned") continue
    let built = 0
    let failed: string | undefined
    for (const part of site.parts) {
      if (part.built && part.built.valid) {
        built++
        continue
      }
      const job = part.job !== undefined ? board.jobs[part.job] : undefined
      if (job === undefined) continue
      if (job.status === "done" && job.payload.kind === "place") {
        part.built = job.payload.built
        if (part.built && part.built.valid) {
          built++
          ctx.brain.steps++
          if (site.kind === "depot") addStockpile(ctx.faction, part.built)
        }
      } else if (job.status === "failed") failed = `${part.entity}: ${job.reason ?? "?"}`
    }
    if (built === site.parts.length) {
      site.status = "built"
      site.builtTick = ctx.tick
    } else if (failed !== undefined) failSite(ctx, site, `placement failed (${failed})`)
  }
}

function failSite(ctx: Ctx, site: Site, why: string): void {
  site.status = "failed"
  for (const part of site.parts) {
    const job = part.job !== undefined ? ctx.faction.board.jobs[part.job] : undefined
    if (job && job.status === "open") failJob(ctx.faction.board, job.id, `site-failed: ${why}`, ctx.tick)
    if (job && job.payload.kind === "place" && job.payload.ghost.valid && !(part.built && part.built.valid)) destroyEntity(job.payload.ghost)
  }
  // Keep the failed spot reserved (it is bad), but count failures per patch.
  if (site.patch !== undefined) {
    let fails = 0
    for (const s of ctx.brain.sites) if (s.patch === site.patch && s.status === "failed") fails++
    if (fails >= 2) ctx.brain.badPatches[site.patch] = true
  }
  for (const goal of ctx.brain.goals) if (goal.kind === "site" && goal.siteId === site.id) goal.siteId = undefined
  log(`[rival-engineers] faction ${ctx.faction.name}: site ${site.id} (${site.kind} ${site.resource ?? ""}) failed: ${why}`)
}

/**
 * D43 / B4: a built mining site whose drill has less than `bootstrap-depletion-minutes` of ore left (or none) gets a
 * replacement goal at the front of the goal list. The old site keeps running until the new one is built, then it is
 * retired (picked up). A pair counts its poorer drill: the two feed each other.
 */
function checkDepletion(ctx: Ctx): void {
  const brain = ctx.brain
  const lead = ctx.config.bootstrapDepletionMinutes
  for (const site of brain.sites) {
    if (site.status !== "built" || site.depleting || site.resource === undefined || site.kind === "depot") continue
    let minutes = math.huge
    for (const part of site.parts) {
      const e = part.built
      if (e && e.valid && e.type === "mining-drill") minutes = math.min(minutes, drillMinutes(ctx.surface, e.name, e.position, site.resource))
    }
    if (minutes === math.huge || (minutes >= lead && minutes > 0)) continue
    site.depleting = true
    let first = 0
    while (first < brain.goals.length && brain.goals[first].done) first++
    brain.goals.splice(first, 0, { kind: "site", site: site.kind, resource: site.resource, replaces: site.id })
    log(string.format("[rival-engineers] faction %s: site %d (%s %s) has %.1f min of ore left: planning a replacement", ctx.faction.name, site.id, site.kind, site.resource, minutes))
  }
}

/** D43: the replacement is built; the old site stops being maintained and its entities are picked up. */
function retireSite(ctx: Ctx, site: Site): void {
  site.status = "retired"
  // Its ground is free again: release the reservation now (the next resyncReserved would anyway; M6a.2, seed 222:
  // retired sites 2/4/14 kept reserving their tiles and read as OWN walls for good). The standing parts are still
  // protected by the terrain scan until the crew picks them up.
  for (const k of site.tiles) delete ctx.brain.reserved[k]
  site.tiles = []
  // Its ore is (nearly) worked out: planners scan that ground again before they count on it (M6a.2, seed 222).
  for (const part of site.parts) markDirty(ctx.faction.surface, { x: part.position.x - 4, y: part.position.y - 4 }, { x: part.position.x + 4, y: part.position.y + 4 })
  log(`[rival-engineers] faction ${ctx.faction.name}: site ${site.id} (${site.kind} ${site.resource ?? ""}) retired`)
}

function pickDepot(ctx: Ctx): LuaEntity | undefined {
  let best: LuaEntity | undefined
  let bestFree = -1
  for (const chest of ctx.faction.stockpiles) {
    if (!chest.valid) continue
    const free = chest.get_inventory(defines.inventory.chest)!.count_empty_stacks()
    if (free > bestFree) {
      best = chest
      bestFree = free
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------------
// Goals

function goalLabel(goal: Goal): string {
  return goal.kind === "site" ? `site:${goal.site}${goal.resource ? ":" + goal.resource : ""}` : goal.label
}

function siteById(brain: BrainState, id: number | undefined): Site | undefined {
  if (id === undefined) return undefined
  for (const s of brain.sites) if (s.id === id) return s
  return undefined
}

function advanceGoals(ctx: Ctx): void {
  const brain = ctx.brain
  // Depot full: add another depot goal in front of the rest.
  if (ctx.depot) {
    let room = 0
    for (const chest of ctx.faction.stockpiles) if (chest.valid) room += chest.get_inventory(defines.inventory.chest)!.count_empty_stacks()
    let depotPending = false
    for (const g of brain.goals) if (!g.done && g.kind === "site" && g.site === "depot") depotPending = true
    if (room < 3 && !depotPending) {
      let first = 0
      while (first < brain.goals.length && brain.goals[first].done) first++
      brain.goals.splice(first, 0, { kind: "site", site: "depot" })
    }
  }
  let active = 0
  for (const goal of brain.goals) {
    if (goal.done) continue
    if (active >= SITE_WINDOW) break
    active++
    if (goal.kind === "site") {
      let site = siteById(brain, goal.siteId)
      if (site && site.status === "built") {
        completeGoal(ctx, goal)
        const old = siteById(brain, goal.replaces)
        if (old !== undefined && old.status === "built") retireSite(ctx, old)
        active--
        continue
      }
      if (!site || site.status === "failed") {
        site = planSite(ctx, goal)
        goal.siteId = site?.id
        if (!site) ctx.waiting.push(`no spot for ${goalLabel(goal)}`)
      }
    } else {
      let ok = true
      for (const item in goal.items) if ((ctx.stock[item] ?? 0) < goal.items[item]) ok = false
      if (ok) {
        completeGoal(ctx, goal)
        active--
      }
    }
  }
  if (!brain.done) {
    let all = true
    for (const goal of brain.goals) if (!goal.done) all = false
    if (all) {
      brain.done = true
      brain.doneTick = ctx.tick
      log(`[rival-engineers] faction ${ctx.faction.name}: bootstrap done at tick ${ctx.tick}`)
    }
  }
}

function completeGoal(ctx: Ctx, goal: Goal): void {
  goal.done = true
  goal.doneTick = ctx.tick
  ctx.brain.steps++
  if (goal.kind === "items") ctx.brain.milestones[goal.label] ??= ctx.tick
}

function planSite(ctx: Ctx, goal: Extract<Goal, { kind: "site" }>): Site | undefined {
  if (goal.site === "depot") {
    const spot = findDepotSpot(ctx)
    return spot ? createSite(ctx, "depot", [spot]) : undefined
  }
  const resource = goal.resource!
  for (let attempt = 0; attempt < 6; attempt++) {
    const patch = bestPatch(ctx.brain.patches, resource, ctx.brain.hub ?? ctx.brain.base, 8, ctx.brain.badPatches)
    if (!patch) {
      exploreFarther(ctx, resource)
      return undefined
    }
    const parts = findSiteSpot(ctx, patch, goal.site)
    if (parts) return createSite(ctx, goal.site, parts, resource, patch.id)
    ctx.brain.badPatches[patch.id] = true
  }
  return undefined
}

/** H7: no usable patch of `resource` is known: explore a ring farther out, like a player going to look. */
function exploreFarther(ctx: Ctx, resource: string): void {
  const brain = ctx.brain
  if (brain.rescanAt !== undefined) {
    ctx.waiting.push(`exploring for ${resource}`)
    return
  }
  if (brain.exploreRadius >= ctx.config.scanRadius * EXPLORE_MAX) {
    ctx.waiting.push(`no ${resource} within ${brain.exploreRadius} tiles`)
    return
  }
  brain.exploreRadius += EXPLORE_STEP
  // Generated synchronously (one hitch per step) so the rescan never sees half-generated chunks.
  exploreNow(ctx.surface, brain.hub ?? brain.base, brain.exploreRadius)
  brain.rescanAt = ctx.tick + 1
  ctx.waiting.push(`exploring for ${resource}`)
  log(`[rival-engineers] faction ${ctx.faction.name}: no ${resource} known, exploring to ${brain.exploreRadius} tiles`)
}

// ---------------------------------------------------------------------------------------------------
// Stock and demand

function addInv(into: Record<string, number>, inv: LuaInventory | undefined): void {
  if (!inv) return
  for (const e of inv.get_contents()) into[e.name] = (into[e.name] ?? 0) + e.count
}

function countStock(ctx: Ctx): void {
  for (const chest of ctx.faction.stockpiles) if (chest.valid) addInv(ctx.stock, chest.get_inventory(defines.inventory.chest) ?? undefined)
  for (const id of ctx.faction.crew) {
    const m = storage.crew[id]
    if (m.dead || !m.character.valid) continue
    if (ctx.depot) {
      addInv(ctx.stock, m.character.get_main_inventory() ?? undefined)
      continue
    }
    // Without a depot, items in different pockets can't be pooled: count what the best-stocked member has.
    const own: Record<string, number> = {}
    addInv(own, m.character.get_main_inventory() ?? undefined)
    for (const item in own) ctx.stock[item] = math.max(ctx.stock[item] ?? 0, own[item])
  }
  for (const item in ctx.stock) ctx.depotStock[item] = ctx.stock[item]
  // B32: what the supply points hold is stock too: the crew takes it from there when a job needs it.
  const supply = supplyStock(ctx.faction, ctx.config.supplyMinTake)
  for (const item in supply) ctx.stock[item] = (ctx.stock[item] ?? 0) + supply[item]
}

function addDemand(ctx: Ctx, item: string, count: number): void {
  if (count <= 0) return
  if (ctx.demand[item] === undefined) {
    ctx.demand[item] = 0
    ctx.order.push(item)
  }
  ctx.demand[item] += count
}

function addPending(ctx: Ctx, item: string, count: number): void {
  ctx.pending[item] = (ctx.pending[item] ?? 0) + count
}

/** Demand and pending output from every active job. */
function scanJobs(ctx: Ctx): void {
  const board = ctx.faction.board
  for (const id of board.active) {
    const job = board.jobs[id]
    const p = job.payload
    switch (p.kind) {
      case "craft":
        if (p.item) addPending(ctx, p.item, p.count * craftYield(p.recipe, p.item))
        break
      case "gather":
        if (p.deliverTo && p.deliverTo.valid && p.deliverTo.type === "furnace") ctx.oreInbound[p.item] = (ctx.oreInbound[p.item] ?? 0) + p.count
        else addPending(ctx, p.item, p.count)
        if (p.target.valid && p.target.type === "tree") ctx.woodGathers++
        else ctx.gathers++
        break
      case "transfer":
        addPending(ctx, p.item, p.count)
        break
      case "fuel":
        if (p.item !== ctx.brain.catalog.fuel) ctx.oreInbound[p.item] = (ctx.oreInbound[p.item] ?? 0) + p.count
        break
    }
    if (p.kind === "haul" || p.kind === "deposit" || p.kind === "transfer") continue
    for (const m of job.materials) addDemand(ctx, m.item, m.count)
  }
}

function keyActive(ctx: Ctx, key: string): boolean {
  const id = ctx.brain.jobKeys[key]
  if (id === undefined) return false
  const job = ctx.faction.board.jobs[id]
  if (job !== undefined && (job.status === "open" || job.status === "claimed")) return true
  delete ctx.brain.jobKeys[key]
  return false
}

function addKeyed(ctx: Ctx, key: string, spec: JobSpec<JobPayload>): CrewJob {
  const job = addJob(ctx.faction.board, spec, ctx.tick)
  ctx.brain.jobKeys[key] = job.id
  return job
}

// ---------------------------------------------------------------------------------------------------
// Maintenance (H5)

function fuelCount(ctx: Ctx, entity: LuaEntity, minutes: number): number {
  const fuelValue = prototypes.item[ctx.brain.catalog.fuel].fuel_value
  const perTick = entity.prototype.get_max_energy_usage() ?? 0
  return math.max(1, math.ceil((minutes * 3600 * perTick) / fuelValue))
}

function maintain(ctx: Ctx): void {
  const fuel = ctx.brain.catalog.fuel
  for (const site of ctx.brain.sites) {
    if (site.status === "retired") {
      // D43: pick up what is left of a replaced site (re-added after a replan dropped the jobs).
      for (const part of site.parts) {
        const e = part.built
        if (!e || !e.valid) continue
        const key = `retire:${e.unit_number}`
        if (!keyActive(ctx, key)) addKeyed(ctx, key, { kind: "clear", pos: e.position, priority: PRIORITY_RETIRE, payload: { kind: "clear", target: e } })
      }
      continue
    }
    if (site.status === "failed") continue
    for (const part of site.parts) {
      const e = part.built
      if (!e || !e.valid || !part.burner) continue
      const key = `fuel:${e.unit_number}`
      const have = e.get_fuel_inventory()?.get_item_count(fuel) ?? 0
      // Pair drills fuel each other: they only need a first load.
      const low = site.kind === "pair" ? 1 : fuelCount(ctx, e, FUEL_LOW_MINUTES)
      if (have >= low || keyActive(ctx, key)) continue
      const top = site.kind === "pair" ? 5 : fuelCount(ctx, e, FUEL_TOP_MINUTES)
      const count = math.min(top - have, prototypes.item[fuel].stack_size)
      addKeyed(ctx, key, {
        kind: "fuel",
        pos: e.position,
        materials: [{ item: fuel, count }],
        priority: PRIORITY.fuel,
        payload: { kind: "fuel", item: fuel, count, target: e, partial: true },
      })
      addDemand(ctx, fuel, count)
    }
  }
  if (ctx.brain.sites.length > 0) addDemand(ctx, fuel, FUEL_BUFFER)
  if (!ctx.depot) return
  // Ore sitting in the depot (leftovers of hand-mining) goes into furnaces of its kind.
  const catalog = ctx.brain.catalog
  for (const ore in catalog.smelts) {
    const inDepot = ctx.depotStock[ore] ?? 0
    if (inDepot <= 0) continue
    for (const furnace of furnacesFor(ctx, ore)) {
      const key = `feed:${furnace.unit_number}`
      if (keyActive(ctx, key)) continue
      const room = sourceRoom(furnace, ore)
      if (room < 5) continue
      const count = math.min(room, inDepot)
      addKeyed(ctx, key, {
        kind: "fuel",
        pos: furnace.position,
        materials: [{ item: ore, count }],
        priority: PRIORITY.feed,
        payload: { kind: "fuel", item: ore, count, target: furnace, partial: true },
      })
      addDemand(ctx, ore, count)
      ctx.oreInbound[ore] = (ctx.oreInbound[ore] ?? 0) + count
      break
    }
  }
}

/** Built furnaces of smelt sites on the resource yielding `ore`, emptiest source first. */
function furnacesFor(ctx: Ctx, ore: string): LuaEntity[] {
  const out: { e: LuaEntity; n: number }[] = []
  for (const site of ctx.brain.sites) {
    if (site.kind !== "smelt" || site.status === "failed" || site.status === "retired" || !site.resource) continue
    if (prototypes.entity[site.resource].mineable_properties.products?.[0]?.name !== ore) continue
    for (const part of site.parts) {
      const e = part.built
      if (e && e.valid && e.type === "furnace") out.push({ e, n: e.get_inventory(defines.inventory.furnace_source)!.get_item_count(ore) })
    }
  }
  out.sort((a, b) => (a.n !== b.n ? a.n - b.n : a.e.unit_number! - b.e.unit_number!))
  const list: LuaEntity[] = []
  for (const o of out) list.push(o.e)
  return list
}

function sourceRoom(furnace: LuaEntity, ore: string): number {
  const inv = furnace.get_inventory(defines.inventory.furnace_source)!
  const stack = prototypes.item[ore].stack_size
  for (const e of inv.get_contents()) if (e.name !== ore) return 0
  return stack - inv.get_item_count(ore)
}

/**
 * B32: the supply points the crew may take from when a job needs an item (`jobs/supply.ts`), registered every think:
 * the factory's chest-out ports (mall and temporary cells), module buffer chests, then the bootstrap sites' furnace
 * outputs, chest-site chests and pair drills' surplus coal. Only those within `supply-radius` of the hub (0 = any).
 * Stockpiles are not listed (the crew counts them anyway). Replaces B17's collect transfers to the depot.
 */
function registerSupplies(ctx: Ctx): void {
  const points: SupplyPoint[] = []
  const seen: Record<number, boolean> = {}
  for (const chest of ctx.faction.stockpiles) if (chest.valid) seen[chest.unit_number!] = true
  const hub = ctx.brain.hub ?? ctx.brain.base
  const radius = ctx.config.supplyRadius
  const add = (entity: LuaEntity, inventory: defines.inventory, item?: string, keep?: number): void => {
    if (!entity.valid || entity.unit_number === undefined || seen[entity.unit_number]) return
    if (radius > 0 && positionDistance(entity.position, hub) > radius) return
    seen[entity.unit_number] = true
    points.push({ entity, inventory, item, keep })
  }
  for (const chest of supplyChests(ctx.faction.name)) add(chest, defines.inventory.chest)
  for (const chest of bufferChests(ctx.faction.force)) add(chest, defines.inventory.chest)
  const fuel = ctx.brain.catalog.fuel
  for (const site of ctx.brain.sites) {
    if (site.status === "failed" || site.status === "retired") continue
    for (const part of site.parts) {
      const e = part.built
      if (!e || !e.valid) continue
      if (site.kind === "smelt" && e.type === "furnace") add(e, defines.inventory.furnace_result)
      else if (site.kind === "chest" && e.type === "container") add(e, defines.inventory.chest)
      else if (site.kind === "pair" && e.type === "mining-drill") add(e, defines.inventory.fuel, fuel, PAIR_KEEP)
    }
  }
  setSupplies(ctx.faction, points)
}

// ---------------------------------------------------------------------------------------------------
// Reconcile (H4)

function reconcile(ctx: Ctx): void {
  // Item goals among the active window are demand too.
  let active = 0
  for (const goal of ctx.brain.goals) {
    if (goal.done) continue
    if (active++ >= SITE_WINDOW) break
    if (goal.kind === "items") {
      const names: string[] = []
      for (const item in goal.items) names.push(item)
      names.sort()
      for (const item of names) addDemand(ctx, item, goal.items[item])
    }
  }
  // The order grows while we go: a craft adds its raw materials.
  for (let i = 0; i < ctx.order.length; i++) {
    const item = ctx.order[i]
    const short = ctx.demand[item] - (ctx.stock[item] ?? 0) - (ctx.pending[item] ?? 0)
    if (short > 0) produce(ctx, item, short)
  }
}

function produce(ctx: Ctx, item: string, short: number): void {
  // 1. B32: what the supply points hold is already in the stock (the crew takes it from there). 1b. D38: a temporary factory makes it: count what it will make within the wait, feed it what it lacks.
  short = feedTempCells(ctx, item, short)
  if (short <= 0) return
  // 2. Hand-craft.
  const hr = handRecipe(ctx.force, item)
  if (hr) {
    if (!hr.enabled) {
      ctx.waiting.push(`recipe ${hr.recipe.name} locked`)
      return
    }
    craft(ctx, item, hr.recipe.name, short)
    return
  }
  // 3. Smelt: plates come from furnaces; hand-mine ore into them if what is on its way is not enough.
  const catalog = ctx.brain.catalog
  const ore = catalog.oreOf[item]
  if (ore !== undefined) {
    let inbound = ctx.oreInbound[ore] ?? 0
    for (const f of furnacesFor(ctx, ore)) inbound += f.get_inventory(defines.inventory.furnace_source)!.get_item_count(ore)
    inbound += ctx.depotStock[ore] ?? 0
    const need = short - inbound
    if (need <= 0) return
    const furnaces = furnacesFor(ctx, ore)
    const into = furnaces.length > 0 ? furnaces[0] : ctx.depot
    if (furnaces.length === 0) ctx.waiting.push(`no furnace for ${ore}`)
    gather(ctx, ore, need, into)
    return
  }
  // 4. Hand-mine a resource or cut trees.
  gather(ctx, item, short, ctx.depot)
}

/**
 * D38: temporary factory cells making `item` (strategy/factory.ts). What a cell holds (input chest and machine) and what
 * the crew is bringing it will come out: the economy counts up to `bootstrap-factory-wait-seconds` of the cell's output as
 * on its way. A cell is fed from the depot's **surplus** only (ingredients in stock beyond what the active jobs need),
 * so the economy never waits on a chain of cells (belts on gears on plates): what the cells can't cover from stock now
 * is hand-crafted. Returns what is still short.
 */
function feedTempCells(ctx: Ctx, item: string, short: number): number {
  const cells = tempCells(ctx.faction.name, item)
  if (cells.length === 0) return short
  const wait = ctx.config.bootstrapFactoryWaitSeconds
  for (const cell of cells) {
    if (short <= 0) break
    const m = cell.machine
    // A cell without power makes nothing: don't wait for it.
    if (m === undefined || !m.valid || m.status === defines.entity_status.no_power || m.to_be_deconstructed()) continue
    const recipe = prototypes.recipe[cell.recipe]
    const per = craftYield(cell.recipe, item)
    const cap = math.max(per, math.floor(cell.rate * wait))
    const inv = m.get_inventory(defines.inventory.crafter_input)
    const have: Record<string, number> = {}
    let queued = math.huge
    let coming = math.huge
    let feeding = false
    for (const ing of recipe.ingredients) {
      const n = cell.input.get_item_count(ing.name) + (inv?.get_item_count(ing.name) ?? 0)
      let inflight = 0
      const key = `tempfeed:${cell.input.unit_number}:${ing.name}`
      if (keyActive(ctx, key)) {
        feeding = true
        const job = ctx.faction.board.jobs[ctx.brain.jobKeys[key]]
        if (job.payload.kind === "fuel") inflight = job.payload.count
      }
      have[ing.name] = n
      queued = math.min(queued, math.floor(n / ing.amount))
      coming = math.min(coming, math.floor((n + inflight) / ing.amount))
    }
    if (queued === math.huge) continue
    // What it holds and what the crew is bringing it (fed from surplus, so it is in stock) will come out.
    short -= math.min(coming * per, cap)
    if (short <= 0 || feeding) continue
    // Fill it up to `cap` of output from the depot's surplus.
    let crafts = math.floor((cap - queued * per) / per)
    for (const ing of recipe.ingredients) {
      const surplus = (ctx.stock[ing.name] ?? 0) - (ctx.demand[ing.name] ?? 0)
      crafts = math.min(crafts, math.floor((surplus + have[ing.name] - queued * ing.amount) / ing.amount))
    }
    if (crafts < 1) continue
    short -= crafts * per
    for (const ing of recipe.ingredients) {
      const add = (queued + crafts) * ing.amount - have[ing.name]
      if (add <= 0) continue
      addKeyed(ctx, `tempfeed:${cell.input.unit_number}:${ing.name}`, {
        kind: "fuel",
        pos: cell.input.position,
        materials: [{ item: ing.name, count: add }],
        priority: PRIORITY.feed,
        payload: { kind: "fuel", item: ing.name, count: add, target: cell.input, partial: true },
      })
      addDemand(ctx, ing.name, add)
    }
  }
  return short
}

/**
 * B18: keep temporary cells stocked **proactively** (every think): top each built cell's input chest up to the same
 * buffer the on-demand feed uses (`bootstrap-factory-wait-seconds` of output), from the depot's surplus, so the
 * cell's output chest builds a buffer that serves any later request without waiting for one. Each ingredient is one
 * keyed job - the same `tempfeed:` keys the on-demand feed uses, so the two never double-book; the configured
 * priority decides how the refills compete with other work (0 = never stock proactively). What the cell holds and
 * what a refill is already bringing counts, so a buffer arrives in chunks across thinks without over-reserving.
 */
function topUpTempCells(ctx: Ctx): void {
  const priority = ctx.config.bootstrapTempCellFeedPriority
  if (priority <= 0) return
  const cells = tempCells(ctx.faction.name)
  if (cells.length === 0) return
  const wait = ctx.config.bootstrapFactoryWaitSeconds
  for (const cell of cells) {
    const m = cell.machine
    // A cell without power makes nothing: don't stock what won't run.
    if (m === undefined || !m.valid || m.status === defines.entity_status.no_power || m.to_be_deconstructed()) continue
    const recipe = prototypes.recipe[cell.recipe]
    const per = craftYield(cell.recipe, cell.item)
    const cap = math.max(per, math.floor(cell.rate * wait))
    const inv = m.get_inventory(defines.inventory.crafter_input)
    for (const ing of recipe.ingredients) {
      const have = cell.input.get_item_count(ing.name) + (inv?.get_item_count(ing.name) ?? 0)
      let inflight = 0
      const key = `tempfeed:${cell.input.unit_number}:${ing.name}`
      if (keyActive(ctx, key)) {
        const job = ctx.faction.board.jobs[ctx.brain.jobKeys[key]!]
        if (job.payload.kind === "fuel") inflight = job.payload.count
      }
      const add = math.max(0, math.min(cap * ing.amount - have - inflight, (ctx.stock[ing.name] ?? 0) - (ctx.demand[ing.name] ?? 0)))
      if (add <= 0) continue
      addKeyed(ctx, key, {
        kind: "fuel",
        pos: cell.input.position,
        materials: [{ item: ing.name, count: add }],
        priority,
        payload: { kind: "fuel", item: ing.name, count: add, target: cell.input, partial: true },
      })
      addDemand(ctx, ing.name, add)
    }
  }
}

function craft(ctx: Ctx, item: string, recipeName: string, short: number): void {
  const recipe = prototypes.recipe[recipeName]
  const per = craftYield(recipeName, item)
  let crafts = math.ceil(short / per)
  const one = expandRecipe(ctx.force, recipe, 1)
  if (one.locked.length > 0) {
    ctx.waiting.push(`recipe ${one.locked[0]} locked`)
    return
  }
  let rawPer = 0
  for (const r in one.raw) rawPer += one.raw[r]
  // A job is claimed only with all its materials: size chunks to what the stock holds of each raw item (at least one
  // craft), or one big job on a scarce item (30 wood for small poles) would never start.
  let affordable = math.huge
  for (const r in one.raw) affordable = math.min(affordable, math.floor(math.max(0, ctx.stock[r] ?? 0) / one.raw[r]))
  const chunk = math.max(1, math.min(math.floor(CRAFT_CHUNK_RAW / math.max(1, rawPer)), affordable))
  while (crafts > 0) {
    const n = math.min(chunk, crafts)
    crafts -= n
    const exp = expandRecipe(ctx.force, recipe, n)
    const materials: ItemCount[] = []
    const names: string[] = []
    for (const r in exp.raw) names.push(r)
    names.sort()
    for (const r of names) materials.push({ item: r, count: exp.raw[r] })
    addJob(
      ctx.faction.board,
      {
        kind: "craft",
        pos: ctx.depot?.position ?? ctx.brain.hub ?? ctx.brain.base,
        materials,
        priority: PRIORITY.craft,
        payload: { kind: "craft", recipe: recipeName, count: n, item, deliverTo: ctx.depot },
      },
      ctx.tick,
    )
    addPending(ctx, item, n * per)
    for (const m of materials) addDemand(ctx, m.item, m.count)
  }
}

/** The tree nearest `near` that no active job targets. */
function freeTree(ctx: Ctx, near: MapPosition): LuaEntity | undefined {
  for (const radius of [32, 96, ctx.brain.exploreRadius]) {
    const tree = nearestFreeTree(ctx, near, radius)
    if (tree) return tree
  }
  return undefined
}

function nearestFreeTree(ctx: Ctx, near: MapPosition, radius: number): LuaEntity | undefined {
  const trees = findEntities(ctx.surface, { type: "tree", position: near, radius })
  let best: LuaEntity | undefined
  let bestD = 0
  for (const t of trees) {
    const k = `tree:${math.floor(t.position.x * 4)},${math.floor(t.position.y * 4)}`
    if (keyActive(ctx, k)) continue
    const d = positionDistance(t.position, near)
    if (best === undefined || d < bestD) {
      best = t
      bestD = d
    }
  }
  return best
}

/** A resource entity of `name` near `near`, off reserved tiles, holding at least `count`. */
function freeResource(ctx: Ctx, name: string, near: MapPosition, count: number): LuaEntity | undefined {
  const patch = bestPatch(ctx.brain.patches, name, near, 1)
  if (!patch) return undefined
  const p = { x: math.min(math.max(near.x, patch.x1), patch.x2), y: math.min(math.max(near.y, patch.y1), patch.y2) }
  const others = otherClaims(ctx.faction.name, ctx.faction.surface)
  for (const radius of [10, 24, 64]) {
    const found = findEntities(ctx.surface, { name, position: p, radius })
    let best: LuaEntity | undefined
    let bestD = 0
    for (const e of found) {
      if (e.amount < count) continue
      if (ctx.brain.reserved[tkey(math.floor(e.position.x), math.floor(e.position.y))]) continue
      // D46: never in another faction's field (nor on its claimed ground).
      if (others.length > 0 && claimed(others, tkey(math.floor(e.position.x), math.floor(e.position.y)))) continue
      const k = `res:${math.floor(e.position.x)},${math.floor(e.position.y)}`
      if (keyActive(ctx, k)) continue
      const d = positionDistance(e.position, near)
      if (best === undefined || d < bestD) {
        best = e
        bestD = d
      }
    }
    if (best) return best
  }
  return undefined
}

function gather(ctx: Ctx, item: string, short: number, into: LuaEntity | undefined): void {
  const cap = ctx.faction.crew.length
  // Which resource gives this item?
  let resource: string | undefined
  for (const p of ctx.brain.patches) {
    if (p.product === item) {
      resource = p.name
      break
    }
  }
  const isWood = resource === undefined && treeProduct() === item
  if (resource === undefined && !isWood) {
    ctx.waiting.push(`no source for ${item}`)
    return
  }
  const near = into?.position ?? ctx.brain.hub ?? ctx.brain.base
  // Wood: enough tree jobs for every member's trip (B3); ore gathers feed furnaces one job per member.
  const woodCap = cap * ctx.config.tripMaxJobs
  while (short > 0 && (isWood ? ctx.woodGathers < woodCap : ctx.gathers < cap)) {
    let target: LuaEntity | undefined
    let count: number
    let key: string
    if (isWood) {
      target = freeTree(ctx, near)
      if (!target) {
        exploreFarther(ctx, "trees")
        return
      }
      count = treeYield(target)
      key = `tree:${math.floor(target.position.x * 4)},${math.floor(target.position.y * 4)}`
    } else {
      count = math.min(GATHER_CHUNK, short)
      if (into && into.type === "furnace") count = math.min(count, math.max(1, sourceRoom(into, item) - (ctx.oreInbound[item] ?? 0)))
      target = freeResource(ctx, resource!, near, count)
      if (!target) {
        ctx.waiting.push(`no free ${resource} to mine`)
        return
      }
      key = `res:${math.floor(target.position.x)},${math.floor(target.position.y)}`
    }
    addKeyed(ctx, key, {
      kind: "gather",
      pos: target.position,
      priority: PRIORITY.gather,
      payload: { kind: "gather", item, count, target, deliverTo: into },
    })
    if (isWood) ctx.woodGathers++
    else ctx.gathers++
    short -= count
    if (into && into.type === "furnace") ctx.oreInbound[item] = (ctx.oreInbound[item] ?? 0) + count
    else addPending(ctx, item, count)
  }
}

let woodItem: string | undefined
function treeProduct(): string | undefined {
  if (woodItem === undefined) {
    const trees = prototypes.get_entity_filtered([{ filter: "type", type: "tree" }])
    const names: string[] = []
    for (const [name] of pairs(trees)) names.push(name as string)
    names.sort()
    for (const name of names) {
      const p = trees[name].mineable_properties.products?.[0]
      if (p && p.type === "item") {
        woodItem = p.name
        break
      }
    }
  }
  return woodItem
}

function treeYield(tree: LuaEntity): number {
  const p = tree.prototype.mineable_properties.products?.[0]
  return p ? (p.amount ?? p.amount_max ?? 1) : 1
}

// ---------------------------------------------------------------------------------------------------
// Milestones and stalls

function mark(ctx: Ctx, name: string): void {
  if (ctx.brain.milestones[name] === undefined) {
    ctx.brain.milestones[name] = ctx.tick
    log(`[rival-engineers] faction ${ctx.faction.name}: milestone ${name} at tick ${ctx.tick}`)
  }
}

function milestones(ctx: Ctx): void {
  const resources = requiredResources(ctx.config)
  let all = true
  for (const res of resources) {
    const name = `burner-mining:${res}`
    if (ctx.brain.milestones[name] === undefined) {
      for (const site of ctx.brain.sites) {
        if (site.resource !== res || site.status !== "built") continue
        for (const part of site.parts) {
          const e = part.built
          if (e && e.valid && e.type === "mining-drill" && e.status === defines.entity_status.working) mark(ctx, name)
        }
      }
    }
    if (ctx.brain.milestones[name] === undefined) all = false
  }
  for (const site of ctx.brain.sites) {
    if (site.kind !== "smelt" || site.status !== "built" || !site.resource) continue
    if (ctx.brain.milestones[`smelting:${site.resource}`] !== undefined) continue
    for (const part of site.parts) {
      const e = part.built
      if (e && e.valid && e.type === "furnace" && e.products_finished > 0) mark(ctx, `smelting:${site.resource}`)
    }
  }
  if (all && resources.length > 0) mark(ctx, "self-sustaining")
}

/** Records a finished research for brain factions (on_research_finished). */
export function onResearchFinished(force: LuaForce, tech: string): void {
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    if (f.brain && f.force === force.name) f.brain.milestones[`research:${tech}`] ??= game.tick
  }
}

function describeStall(ctx: Ctx): string {
  const parts: string[] = []
  for (const goal of ctx.brain.goals) {
    if (!goal.done) {
      parts.push(`goal ${goalLabel(goal)}`)
      break
    }
  }
  if (ctx.waiting.length > 0) parts.push(`waiting: ${ctx.waiting.join("; ")}`)
  const reasons: Record<string, number> = {}
  const board = ctx.faction.board
  for (const e of board.claimLog) {
    if (e.tick < ctx.brain.progressTick || (e.event !== "fail" && e.event !== "release") || !e.reason) continue
    reasons[e.reason] = (reasons[e.reason] ?? 0) + 1
  }
  const rs: string[] = []
  for (const r in reasons) rs.push(`${r} ×${reasons[r]}`)
  rs.sort()
  if (rs.length > 0) parts.push(`failures: ${rs.join(", ")}`)
  let open = 0
  let claimed = 0
  for (const id of board.active) {
    if (board.jobs[id].status === "open") open++
    else claimed++
  }
  parts.push(`jobs open ${open} claimed ${claimed}`)
  return parts.join(" | ")
}

function checkStall(ctx: Ctx): void {
  const brain = ctx.brain
  if (brain.steps > brain.progressSteps) {
    brain.progressSteps = brain.steps
    brain.progressTick = ctx.tick
    const last = brain.stalls[brain.stalls.length - 1]
    if (last && last.recoveredTick === undefined) last.recoveredTick = ctx.tick
    return
  }
  if (brain.done || ctx.tick - brain.progressTick < ctx.config.stallTicks) return
  const reason = describeStall(ctx)
  let goal: string | undefined
  for (const g of brain.goals) {
    if (!g.done) {
      goal = goalLabel(g)
      break
    }
  }
  brain.stalls.push({ tick: ctx.tick, idleFor: ctx.tick - brain.progressTick, reason, goal })
  log(`[rival-engineers] faction ${ctx.faction.name}: STALL at tick ${ctx.tick} (no progress for ${ctx.tick - brain.progressTick} ticks): ${reason}`)
  replan(ctx)
}

/**
 * Recovery (SPEC §3): drop every job, take back unbuilt site ghosts, rescan the surroundings and plan again
 * from what exists. Built sites and the depot stay.
 */
export function replan(ctx: Ctx): void {
  const { faction, brain } = ctx
  for (const id of faction.crew) {
    const m = storage.crew[id]
    if (!m.dead) resetMember(faction, m, ctx.tick)
  }
  for (const id of [...faction.board.active]) failJob(faction.board, id, "replan", ctx.tick)
  for (const site of brain.sites) {
    if (site.status !== "planned") continue
    let builtAny = false
    for (const part of site.parts) if (part.built && part.built.valid) builtAny = true
    if (builtAny) {
      // Keep what is built; replan the rest of the site in place.
      for (const part of site.parts) {
        if (part.built && part.built.valid) continue
        part.job = undefined
        const ghost = findEntities(ctx.surface, { type: "entity-ghost", position: part.position, force: faction.force, limit: 1 })[0]
        if (ghost) {
          const job = addJob(
            faction.board,
            {
              kind: "place",
              pos: ghost.position,
              footprint: tileRect(ghost.bounding_box),
              materials: [{ item: part.item, count: 1 }],
              priority: PRIORITY.place,
              payload: { kind: "place", item: part.item, entity: part.entity, position: ghost.position, direction: ghost.direction, ghost, ghostKey: ghost.unit_number! },
            },
            ctx.tick,
          )
          part.job = job.id
        } else site.status = "failed"
      }
      continue
    }
    site.status = "failed"
    for (const part of site.parts) {
      const ghost = findEntities(ctx.surface, { type: "entity-ghost", position: part.position, force: faction.force, limit: 1 })[0]
      if (ghost) destroyEntity(ghost)
    }
    for (const k of site.tiles) delete brain.reserved[k]
  }
  for (const goal of brain.goals) {
    if (goal.kind !== "site" || goal.done) continue
    const site = siteById(brain, goal.siteId)
    if (!site || site.status === "failed") goal.siteId = undefined
  }
  faction.ghostJobs = {}
  brain.jobKeys = {}
  exploreNow(ctx.surface, brain.hub ?? brain.base, brain.exploreRadius)
  brain.patches = scanPatches(ctx.surface, brain.hub ?? brain.base, brain.exploreRadius)
  brain.badPatches = {}
  brain.replans++
  brain.progressTick = ctx.tick
}

/** Forgets finished jobs no active job depends on (keeps storage bounded over long runs). */
function pruneBoard(faction: FactionState, tick: number): void {
  const board = faction.board
  const needed: Record<number, boolean> = {}
  for (const id of board.active) for (const dep of board.jobs[id].deps) needed[dep] = true
  for (const [idx, job] of pairs(board.jobs)) {
    const id = idx as number
    if (job.status !== "done" && job.status !== "failed") continue
    if (needed[id] || (job.finishedTick ?? tick) > tick - 1800) continue
    delete board.jobs[id]
  }
}

/** Telemetry view of a brain (also on the remote interface). */
export function brainReport(faction: FactionState) {
  const brain = faction.brain
  if (!brain) return undefined
  let current: string | undefined
  let goalsDone = 0
  for (const g of brain.goals) {
    if (g.done) goalsDone++
    else current ??= goalLabel(g)
  }
  const sites: Record<string, number> = {}
  for (const s of brain.sites) {
    if (s.status !== "built") continue
    const k = `${s.kind}${s.resource ? ":" + s.resource : ""}`
    sites[k] = (sites[k] ?? 0) + 1
  }
  const timeline: { goal: string; done?: number }[] = []
  for (const g of brain.goals) timeline.push({ goal: goalLabel(g), done: g.doneTick })
  return {
    timeline,
    base: brain.base,
    hub: brain.hub,
    done: brain.done,
    doneTick: brain.doneTick,
    goals: brain.goals.length,
    goalsDone,
    current,
    sites,
    milestones: brain.milestones,
    stalls: brain.stalls,
    replans: brain.replans,
    waiting: brain.waiting,
    steps: brain.steps,
  }
}
