import { LuaSurface, MapPosition } from "factorio:runtime"
import { spawnFaction } from "../autospawn"
import { clearConfigOverrides, getConfig } from "../config"
import { destroyFaction } from "../jobs/faction"
import { exploreNow, positionDistance } from "../world/resources"
import { hasWater, repairStartingLake } from "../world/spawn"
import { fieldModule, moduleWells } from "../strategy/oil"
import { generatedModule } from "../modules/library"
import { ModuleDef } from "../modules/types"
import type { Rect } from "../planner/grid"
import { at, createLab } from "./lab"

// M5a.2: every faction spawned with a starting area (D32) has water near its spawn, like a player's starting lake.

function newSurface(name: string, seed: number, startingPoints?: MapPosition[]): LuaSurface {
  const existing: LuaSurface | undefined = game.surfaces[name]
  if (existing !== undefined) game.delete_surface(existing)
  const settings: Record<string, unknown> = { seed, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } }
  if (startingPoints) settings.starting_points = startingPoints
  return game.create_surface(name, settings as never)
}

function addStartingPoint(surface: LuaSurface, p: MapPosition): void {
  const mgs = surface.map_gen_settings as unknown as { starting_points?: MapPosition[] }
  mgs.starting_points = [...(mgs.starting_points ?? []), p]
  surface.map_gen_settings = mgs as never
}

describe("starting water", () => {
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("a starting lake whose tiles were generated before its starting point is repainted from the noise", () => {
    const config = getConfig()
    const r = config.spawnWaterRadius
    const p = { x: 336, y: 139 }
    // Correctly generated (point registered first): the repair changes nothing.
    const good = newSurface("water-good", 3709422084, [{ x: 0, y: 0 }, p])
    exploreNow(good, p, r)
    assert(hasWater(good, p, r), "a correctly generated starting area has its lake")
    assert(repairStartingLake(good, p, r, config.spawnLakeRepairMinTiles) === 0, "no repair on a correct starting area")
    // Stale (tiles generated first, as for chunks the engine queued around the origin at game start).
    const stale = newSurface("water-stale", 3709422084)
    exploreNow(stale, p, r)
    const before = stale.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    addStartingPoint(stale, p)
    const repaired = repairStartingLake(stale, p, r, config.spawnLakeRepairMinTiles)
    const after = stale.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    const want = good.count_tiles_filtered({ position: p, radius: r, collision_mask: "water_tile" })
    log(`[water] stale: ${before} water tiles before, ${repaired} repainted, ${after} after; correct generation has ${want}`)
    assert(repaired >= config.spawnLakeRepairMinTiles, `repaired ${repaired} tiles`)
    assert(after >= want * 0.95, `${after} water tiles after the repair, correct generation has ${want}`)
    // Nothing stands in the new water.
    const inWater = stale.find_entities_filtered({ position: p, radius: r, type: ["tree", "simple-entity", "resource"] })
    let wet = 0
    for (const e of inWater) if (stale.get_tile(e.position.x, e.position.y).collides_with("water_tile")) wet++
    assert(wet === 0, `${wet} trees, rocks or ore entities stand in water`)
  })

  test("factions spawned on a new map, next to chunks queued at game start, have water near their spawn", () => {
    const surface = newSurface("water-spawn", 3709422084)
    // Like a new game: the engine queues chunks around the origin and generates them in the background.
    surface.request_to_generate_chunks({ x: 0, y: 0 }, 11)
    after_ticks(3, () => {
      const config = getConfig()
      const a = spawnFaction("water-a", { surface: surface.name })
      const b = spawnFaction("water-b", { surface: surface.name })
      for (const f of [a, b]) {
        const base = f.brain!.base
        assert(hasWater(surface, base, config.spawnWaterRadius), `${f.name} at ${base.x},${base.y} has water within ${config.spawnWaterRadius} tiles (${f.brain!.spawnNote ?? ""})`)
        log(`[water] ${f.name} at ${base.x},${base.y}: ${f.brain!.spawnNote ?? "no note"}`)
      }
      assert(positionDistance(a.brain!.base, b.brain!.base) >= config.spawnMinDistance, "factions apart")
    })
  })
})

/** Wells in a pumpjack field module's params (`encodeWells`: `x,y,perSecond;…`). */
function wellCount(f: { def: ModuleDef } | undefined): number {
  if (f === undefined) return 0
  const [, n] = string.gsub(f.def.params!.wells as string, "[^;]+", "")
  return n
}

describe("oil fields", () => {
  test("M7c.8: wells that already carry a pumpjack are no field for a new crude provider", () => {
    // Seed 11, minute 720–747: a second crude provider was placed on the only known field (already fully taken) for 8
    // plans in a row; with its wells taken, the goal explores for another field instead.
    const lab = createLab(24)
    const s = lab.surface
    const wells = [at(lab, -6.5, 0.5), at(lab, 0.5, 0.5), at(lab, 7.5, 0.5)]
    for (const w of wells) s.create_entity({ name: "crude-oil", position: w, amount: 300000 })
    const region = { x: math.floor(lab.origin.x) - 24, y: math.floor(lab.origin.y) - 24, w: 48, h: 48 }
    const find = () => fieldModule(s, region, () => true, lab.origin, "crude-oil", 1, "pumpjack", (params) => generatedModule("pumpjack-field", params))
    assert(wellCount(find()) === 3, `a field of three wells (${wellCount(find())})`)
    s.create_entity({ name: "pumpjack", position: wells[0], force: "player" })
    assert(wellCount(find()) === 2, `a built pumpjack's well is left out (${wellCount(find())})`)
    s.create_entity({ name: "entity-ghost", inner_name: "pumpjack", position: wells[1], force: "player" })
    assert(wellCount(find()) === 1, `a ghost's well too (${wellCount(find())})`)
    s.create_entity({ name: "pumpjack", position: wells[2], force: "player" })
    assert(find() === undefined, "no free well: no field")
  })

  test("M7c.8: wells of a planned field (not built yet) are taken too", () => {
    // Seed 11, minute 947: a goal with two crude providers picked the same free field for both (g164/g165, "no room at
    // its fixed spot", 8 plans): only pumpjacks on the ground counted as taken.
    const lab = createLab(24)
    const s = lab.surface
    for (const w of [at(lab, -6.5, 0.5), at(lab, 0.5, 0.5)]) s.create_entity({ name: "crude-oil", position: w, amount: 300000 })
    const region = { x: math.floor(lab.origin.x) - 24, y: math.floor(lab.origin.y) - 24, w: 48, h: 48 }
    const taken: Record<string, boolean> = {}
    const find = () => fieldModule(s, region, () => true, lab.origin, "crude-oil", 1, "pumpjack", (params) => generatedModule("pumpjack-field", params), taken)
    const first = find()
    assert(wellCount(first) === 2, `a field of two wells (${wellCount(first)})`)
    moduleWells([first!.def], taken)
    assert(find() === undefined, "its wells are taken by the planned field: no second field there")
  })

  test("M7c.9: wells next to a structure in the field's box are left out until the box is clear", () => {
    // Seed 11, minute 995: a second crude provider's field box took in the poles and pumpjack of a one-well field next
    // to it ("no room at its fixed spot: structure at -442,-169", 8 plans in a row).
    const lab = createLab(24)
    const s = lab.surface
    for (const w of [at(lab, 0.5, 0.5), at(lab, 0.5, 6.5)]) s.create_entity({ name: "crude-oil", position: w, amount: 300000 })
    const region = { x: math.floor(lab.origin.x) - 24, y: math.floor(lab.origin.y) - 24, w: 48, h: 48 }
    const find = (avoid?: Rect[]) => fieldModule(s, region, () => true, lab.origin, "crude-oil", 1, "pumpjack", (params) => generatedModule("pumpjack-field", params), undefined, avoid)
    assert(wellCount(find()) === 2, `a field of two wells (${wellCount(find())})`)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    // A planned module over the box's south edge: the south well goes.
    const south = find([{ x: ox - 6, y: oy + 9, w: 4, h: 4 }])
    assert(wellCount(south) === 1 && south!.at.y + south!.def.footprint.h <= oy + 9, `the box ends above the module (${wellCount(south)} wells)`)
    // A pole (another force's structure counts too) at the box's south-east corner.
    const pole = s.create_entity({ name: "small-electric-pole", position: at(lab, 3.5, 9.5), force: "player" })!
    const f = find()
    assert(wellCount(f) === 1, `the well next to the pole is left out (${wellCount(f)})`)
    assert(f!.at.y + f!.def.footprint.h <= oy + 9, "the box ends above the pole")
    pole.destroy()
  })
})
