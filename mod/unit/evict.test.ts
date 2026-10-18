import { LuaEntity, LuaSurface } from "factorio:runtime"
import { tkey } from "../src/planner/grid"
import { destroyEntity, newTerrain } from "../src/planner/terrain"
import { newLayout } from "../src/planner/layout"
import { FactionState } from "../src/jobs/types"
import { evictSites, evictableTiles, resyncReserved } from "../src/strategy/evict"
import { BrainState, Catalog, Site, SitePart } from "../src/strategy/types"
import { eq, ok, run, test } from "./harness"

// T1: bootstrap site eviction and the reservation resync (M6a.2, seed 222): a depot walled the lab's port in
// (depots were never evictable), and retired sites kept reserving their ground (OWN walls for good).

const G = globalThis as Record<string, unknown>
G.storage = {}
G.log = (): unknown => null
G.prototypes = { entity: { "iron-chest": { tile_width: 1, tile_height: 1 } } }
G.defines = { direction: { east: 2, west: 8 } }

const CATALOG: Catalog = {
  drill: "burner-mining-drill",
  drillItem: "burner-mining-drill",
  furnace: "stone-furnace",
  furnaceItem: "stone-furnace",
  chest: "iron-chest",
  chestItem: "iron-chest",
  fuel: "coal",
  smelts: {},
  oreOf: {},
}

function site(id: number, kind: Site["kind"], status: Site["status"], tiles: number[], built?: LuaEntity): Site {
  const p: SitePart = { entity: "iron-chest", item: "iron-chest", position: { x: 5.5, y: 5.5 }, direction: 0, burner: false }
  if (built !== undefined) p.built = built
  return { id, kind, status, parts: [p], tiles, createdTick: 0 }
}

function brain(sites: Site[]): BrainState {
  const reserved: Record<number, boolean> = {}
  for (const s of sites) for (const k of s.tiles) reserved[k] = true
  return {
    base: { x: 0, y: 0 },
    catalog: CATALOG,
    patches: [],
    badPatches: {},
    sites,
    nextSiteId: 100,
    goals: [],
    reserved,
    jobKeys: {},
    milestones: {},
    progressTick: 0,
    progressSteps: 0,
    stalls: [],
    replans: 0,
    waiting: [],
    done: false,
    nextThink: 0,
    lastPrune: 0,
    steps: 0,
    exploreRadius: 0,
  }
}

test("a built depot's tiles are clearable ground (M6a.2, seed 222: a depot walled the lab's port in)", () => {
  const ev = evictableTiles(brain([site(1, "depot", "built", [tkey(5, 5)]), site(2, "smelt", "built", [tkey(20, 20)])]))
  ok(ev !== undefined && ev[tkey(5, 5)] === true, "depot tile evictable")
  ok(ev !== undefined && ev[tkey(20, 20)] === true, "mining site tile evictable")
})

test("evicting a built depot retires it, releases its tiles, and queues a replacement depot", () => {
  const chest = { valid: true } as LuaEntity
  const depot = site(1, "depot", "built", [tkey(5, 5), tkey(6, 5), tkey(7, 5)], chest)
  const b = brain([depot])
  const faction = { name: "1", surface: "nauvis", force: "rival-1", brain: b } as unknown as FactionState
  const surface = { find_entities_filtered: (): LuaEntity[] => [] } as unknown as LuaSurface
  const out = evictSites(faction, surface, { [tkey(5, 5)]: true }, "test")
  eq(out.length, 1, "the chest is picked up")
  eq(depot.status, "retired", "retired")
  eq(depot.tiles.length, 0, "tiles released")
  eq(b.reserved[tkey(5, 5)], undefined, "reservation dropped")
  eq(b.evicted, 1, "eviction counted")
  const goal = b.goals[0]
  ok(goal !== undefined && goal.kind === "site" && goal.site === "depot", "a replacement depot goal is queued")
})

test("resyncReserved releases retired sites' tiles, keeps failed and active ones (M6a.2, seed 222)", () => {
  const b = brain([
    site(2, "smelt", "retired", [tkey(10, 10), tkey(11, 10)]),
    site(3, "smelt", "failed", [tkey(12, 10)]),
    site(4, "smelt", "built", [tkey(13, 10)]),
  ])
  const faction = { name: "1", brain: b } as unknown as FactionState
  const dropped = resyncReserved(faction, newLayout())
  eq(dropped, 2, "the retired tiles are dropped")
  eq(b.reserved[tkey(10, 10)], undefined, "retired tile released")
  eq(b.reserved[tkey(11, 10)], undefined, "retired tile released")
  ok(b.reserved[tkey(12, 10)] === true, "failed tile kept (bad ground)")
  ok(b.reserved[tkey(13, 10)] === true, "active tile kept")
})

test("destroyEntity marks the destroyed entity's ground for a rescan (M6a.2: a drop raises no terrain event)", () => {
  const t = newTerrain("test", "nauvis", "rival-1")
  // A scanned chunk that says OWN on (5,5).
  t.chunks[tkey(0, 0)] = { block: { [5 * 32 + 5]: 3 }, ore: {}, tick: 0 }
  const fake: { valid: boolean; destroyed?: boolean } = { valid: true }
  const e = {
    valid: true,
    surface: { name: "nauvis" },
    bounding_box: { left_top: { x: 5, y: 5 }, right_bottom: { x: 6, y: 6 } },
    destroy: (): void => {
      fake.destroyed = true
    },
  } as unknown as LuaEntity
  destroyEntity(e)
  ok(fake.destroyed === true, "destroyed")
  eq(t.queue.length, 1, "the chunk is queued for a rescan")
})

run("evict")
