import { LuaEntity, LuaSurface, MapPosition } from "factorio:runtime"
import { spawnFaction } from "../autospawn"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import { createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { Site } from "../strategy/types"
import { startBootstrap } from "../strategy/bootstrap"
import { bestPatch, positionDistance, scanPatches } from "../world/resources"
import { requiredResources } from "../world/spawn"
import { at, createLab, Lab } from "./lab"
import { evictSites } from "../strategy/evict"
import { claimView } from "../planner/runtime"
import { FREE, tkey, TREE } from "../planner/grid"
import { getPlannerEntry, removePlan, startBuild, startPlan } from "../planner/runtime"
import { allParts, partTiles } from "../planner/build-list"
import { generatedModule } from "../modules/library"
import { addStockpile } from "../jobs/faction"

// M3 (SPEC §8): the burner bootstrap's pieces. The full bootstrap runs in the T3 soak (tools/harness), not here.
// Debug parity toggles stay off.

function ore(lab: Lab, name: string, x0: number, y0: number, w: number, h: number, amount = 5000): void {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) lab.surface.create_entity({ name, position: at(lab, x + 0.5, y + 0.5), amount })
  }
}

function clearOre(lab: Lab, name: string): void {
  for (const e of lab.surface.find_entities_filtered({ name, area: [at(lab, -lab.radius, -lab.radius), at(lab, lab.radius, lab.radius)] })) e.destroy()
}

let seq = 0
function labFaction(lab: Lab, tag: string, items: Record<string, number>, dx = 0, dy = 8): FactionState {
  const faction = createFaction(`m3-${tag}-${++seq}`, { position: at(lab, dx, dy), crew: 2, starterItems: items })
  startBootstrap(faction, at(lab, dx, dy))
  return faction
}

/** Runs `check` every tick until it returns true (then `done()`), or fails after `timeout` ticks. */
function until(timeout: number, check: () => boolean): void {
  async(timeout)
  on_tick(() => {
    if (check()) done()
  })
}

function realSurface(name: string, seed: number): LuaSurface {
  const existing = game.surfaces[name]
  if (existing) return existing
  // Default Nauvis-like generation with no enemy bases (D6).
  return game.create_surface(name, { seed, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
}

describe("burner bootstrap", () => {
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    const config = getConfig()
    assert(!config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1, "debug parity toggles must be off")
    // Lab tests: keep scans inside the lab, so other tests' ore never counts.
    setConfigOverride("scanRadius", 40)
  })

  test("resource scan clusters patches and picks them by distance and size", () => {
    const lab = createLab(40)
    ore(lab, "iron-ore", 20, -5, 10, 10) // big iron, 20 tiles east
    ore(lab, "iron-ore", 6, 0, 2, 2) // tiny iron, close
    ore(lab, "iron-ore", -30, -30, 6, 6) // medium iron, far
    ore(lab, "copper-ore", -10, 10, 5, 4)
    ore(lab, "copper-ore", -10, 17, 5, 4) // 3-tile gap: a separate patch
    const patches = scanPatches(lab.surface, lab.origin, 40)
    const byName: Record<string, number[]> = {}
    let amount = 0
    for (const p of patches) {
      byName[p.name] ??= []
      byName[p.name].push(p.tiles)
      if (p.name === "iron-ore" && p.tiles === 100) amount = p.amount
    }
    assert(byName["iron-ore"].join(",") === "100,36,4", `iron patches ${byName["iron-ore"].join(",")}`)
    assert(byName["copper-ore"].join(",") === "20,20", `copper patches ${byName["copper-ore"].join(",")}`)
    assert(amount === 100 * 5000, `amount ${amount}`)
    // Too small patches are skipped; among the rest, nearer wins unless the other is much bigger.
    const best = bestPatch(patches, "iron-ore", lab.origin, 8)!
    assert(best.tiles === 100, `best iron patch has ${best.tiles} tiles`)
    const nearFar = bestPatch(patches, "iron-ore", at(lab, -30, -30), 8)!
    assert(nearFar.tiles === 36, "from the far corner, the medium patch next to it wins")
  })

  test("spawn placement: two factions get valid, distant spots with starting resources", () => {
    const surface = realSurface("m3-spawn", 4242)
    const config = getConfig()
    const a = spawnFaction("m3-spawn-a", { surface: surface.name })
    const b = spawnFaction("m3-spawn-b", { surface: surface.name })
    const origin = game.forces.player.get_spawn_position(surface)
    const required = requiredResources(config)
    for (const f of [a, b]) {
      const base = f.brain!.base
      assert(positionDistance(base, origin) >= config.spawnMinDistance, `${f.name} is ${positionDistance(base, origin)} from the player spawn`)
      assert(surface.can_place_entity({ name: "character", position: base }) || surface.find_non_colliding_position("character", base, 2, 0.5), `${f.name} stands on land`)
      const patches = scanPatches(surface, base, config.spawnResourceRadius)
      for (const res of required) assert(bestPatch(patches, res, base, 8) !== undefined, `${f.name} has ${res} within ${config.spawnResourceRadius} tiles`)
      // Crew got the freeplay starter items, and the force has researched nothing.
      const crew = storage.crew[f.crew[0]].character
      assert(crew.get_main_inventory()!.get_item_count("burner-mining-drill") === 1, "starter drill")
      assert(crew.get_main_inventory()!.get_item_count("iron-plate") === 8, "starter plates")
      let researched = 0
      for (const [, tech] of pairs(game.forces[f.force].technologies)) if (tech.researched) researched++
      assert(researched === 0, `${f.name} starts with ${researched} technologies researched`)
    }
    const d = positionDistance(a.brain!.base, b.brain!.base)
    assert(d >= config.spawnMinDistance, `factions are ${d} apart`)
    log(`[m3] spawns: ${a.brain!.base.x},${a.brain!.base.y} and ${b.brain!.base.x},${b.brain!.base.y}, ${d} apart`)
  })

  test("a self-feeding coal drill pair is built and keeps itself fuelled", () => {
    const lab = createLab(40)
    ore(lab, "coal", 6, -8, 8, 8, 20000)
    setConfigOverride("bootstrapSites", "coal=2")
    setConfigOverride("firstElectricityItems", "")
    const faction = labFaction(lab, "pair", { "burner-mining-drill": 1, wood: 2, coal: 10 })
    const pairDrills = (): LuaEntity[] => {
      const out: LuaEntity[] = []
      for (const site of faction.brain!.sites) {
        if (site.kind !== "pair" || site.status !== "built") continue
        for (const p of site.parts) if (p.built && p.built.valid) out.push(p.built)
      }
      return out
    }
    let builtAt: number | undefined
    let refuels = 0
    const activeFuelJob = (): boolean => {
      for (const id of faction.board.active) if (faction.board.jobs[id].payload.kind === "fuel") return true
      return false
    }
    until(20000, () => {
      const drills = pairDrills()
      if (drills.length < 2) return false
      if (builtAt === undefined) {
        builtAt = game.tick
        // Each drill must point into the other.
        for (const d of drills) {
          const other = drills[0] === d ? drills[1] : drills[0]
          const drop = d.drop_position
          // Inside the other drill's 2×2 tile footprint (the collision box is a little smaller).
          const half = other.prototype.tile_width / 2
          const into = math.abs(drop.x - other.position.x) < half && math.abs(drop.y - other.position.y) < half
          assert(into, `${d.position.x},${d.position.y} dir ${d.direction} drop ${drop.x},${drop.y}; other ${other.position.x},${other.position.y} dir ${other.direction}`)
        }
      }
      // Give the first fuel loads time to land, then watch the pair run on its own coal for 3 minutes.
      if (game.tick - builtAt > 600 && activeFuelJob()) refuels++
      if (game.tick - builtAt < 600 + 3 * 3600) return false
      for (const d of drills) {
        assert(d.status === defines.entity_status.working || d.status === defines.entity_status.waiting_for_space_in_destination, `drill status ${d.status}`)
        assert(d.get_fuel_inventory()!.get_item_count("coal") > 0, "drill still has coal")
      }
      assert(refuels === 0, `no crew refuelling once running (a fuel job was active for ${refuels} ticks)`)
      assert(faction.brain!.milestones["burner-mining:coal"] !== undefined, "burner-mining:coal milestone")
      log(`[m3] coal pair built at tick ${builtAt}; self-fed for 3 minutes, coal in the depot ${faction.stockpiles[0].get_item_count("coal")}`)
      return true
    })
  })

  test("a stall is detected, logged with a reason, and recovered from by replanning", () => {
    const lab = createLab(40)
    ore(lab, "stone", 10, -10, 6, 6)
    setConfigOverride("bootstrapSites", "stone=1")
    setConfigOverride("firstElectricityItems", "")
    setConfigOverride("stallTicks", 1800)
    const faction = labFaction(lab, "stall", { "burner-mining-drill": 1, wood: 4, coal: 10 })
    const brain = faction.brain!
    // The brain has scanned stone patch A. Remove it and put patch B elsewhere: the brain only learns about B by
    // rescanning, and exploring farther is already exhausted, so only the stall recovery (replan) can find it.
    clearOre(lab, "stone")
    ore(lab, "stone", -20, -14, 6, 6)
    brain.exploreRadius = getConfig().scanRadius * 3
    until(12000, () => {
      if (brain.stalls.length === 0) return false
      const stall = brain.stalls[0]
      assert(stall.idleFor >= 1800, `stalled after ${stall.idleFor} ticks`)
      assert(stall.reason.includes("stone"), `reason names the problem: ${stall.reason}`)
      if (stall.recoveredTick === undefined) return false
      let built = false
      for (const site of brain.sites) if (site.kind === "chest" && site.status === "built") built = true
      if (!built) return false
      log(`[m3] stall at tick ${stall.tick} (${stall.reason}); recovered at ${stall.recoveredTick}; replans ${brain.replans}`)
      assert(brain.replans >= 1, "replanned")
      return true
    })
  })

  test("a depleting mining site is replaced on remaining ore, then picked up (D43, B4)", () => {
    const lab = createLab(40)
    ore(lab, "stone", 6, -8, 12, 4)
    setConfigOverride("bootstrapSites", "stone=1")
    setConfigOverride("firstElectricityItems", "")
    const faction = labFaction(lab, "deplete", { "burner-mining-drill": 2, "wooden-chest": 2, wood: 4, coal: 30 })
    const brain = faction.brain!
    let first: Site | undefined
    let drained: MapPosition[] = []
    until(30000, () => {
      if (first === undefined) {
        for (const s of brain.sites) if (s.kind === "chest" && s.status === "built") first = s
        if (first === undefined) return false
        // Mine the patch under its drill down to a minute's worth (a burner drill mines 15 stone a minute).
        const drill = first.parts[0].built!
        for (const e of lab.surface.find_entities_filtered({ area: drill.mining_area, type: "resource" })) {
          e.amount = 3
          drained.push(e.position)
        }
        return false
      }
      if (first.status !== "retired") return false
      for (const part of first.parts) if (part.built && part.built.valid) return false
      let replacement: Site | undefined
      for (const s of brain.sites) if (s.kind === "chest" && s.status === "built" && s.id !== first.id) replacement = s
      assert(replacement !== undefined, "a replacement chest site is built")
      const drill = replacement!.parts[0].built!
      assert(drill.valid && drill.status !== defines.entity_status.no_minable_resources, `replacement drill status ${drill.status}`)
      for (const e of lab.surface.find_entities_filtered({ area: drill.mining_area, type: "resource" })) {
        for (const p of drained) assert(p.x !== e.position.x || p.y !== e.position.y, "the replacement is not on the drained tiles")
      }
      log(`[m3] depleting site ${first.id} replaced by ${replacement!.id} and picked up at tick ${game.tick}`)
      drained = []
      return true
    })
  })

  test("B15: a patch the factory reserved near the hub still gets a site on its far ore", () => {
    const lab = createLab(40)
    ore(lab, "stone", 2, -16, 36, 12)
    setConfigOverride("bootstrapSites", "stone=1")
    setConfigOverride("firstElectricityItems", "")
    const faction = labFaction(lab, "far", { "burner-mining-drill": 2, "wooden-chest": 2, wood: 4, coal: 30 })
    const brain = faction.brain!
    // The factory's modules (and their margins) cover the 28 columns nearest the hub: ~1,300 candidate spots there.
    const o = at(lab, 0, 0)
    for (let x = 2; x < 30; x++) for (let y = -16; y < -4; y++) brain.reserved[tkey(math.floor(o.x) + x, math.floor(o.y) + y)] = true
    until(20000, () => {
      for (const s of brain.sites) {
        if (s.kind !== "chest" || s.status !== "built") continue
        const d = s.parts[0].built!
        assert(d.position.x - o.x >= 29, `site on free ore (x ${d.position.x - o.x})`)
        log(`[m6] B15 far site built at x ${d.position.x - o.x} at tick ${game.tick}`)
        return true
      }
      return false
    })
  })

  test("B15: the factory's plans see bootstrap mining sites as clearable and evict them; the site is rebuilt elsewhere", () => {
    const lab = createLab(40)
    ore(lab, "stone", 6, -12, 16, 8)
    setConfigOverride("bootstrapSites", "stone=1")
    setConfigOverride("firstElectricityItems", "")
    const faction = labFaction(lab, "evict", { "burner-mining-drill": 2, "wooden-chest": 2, wood: 4, coal: 30 })
    const brain = faction.brain!
    let first: Site | undefined
    until(40000, () => {
      if (first === undefined) {
        for (const s of brain.sites) if (s.kind === "chest" && s.status === "built") first = s
        if (first === undefined) return false
        const drill = first.parts[0].built!
        const k = tkey(math.floor(drill.position.x), math.floor(drill.position.y))
        const view = claimView(faction.name, faction.surface, { block: () => FREE, ore: () => undefined })
        assert(view.block(math.floor(drill.position.x), math.floor(drill.position.y)) === TREE, "a site tile is clearable ground for plans")
        const out = evictSites(faction, lab.surface, { [k]: true }, "a test plan")
        assert(out.length === 2 && first.status === "retired", `evicted: ${out.length} entities, status ${first.status}`)
        assert(brain.reserved[k] === undefined, "its tiles are released")
        // The planned module would be built there: keep the bootstrap off it.
        for (const e of out) {
          const box = e.bounding_box
          for (let x = math.floor(box.left_top.x); x < math.ceil(box.right_bottom.x); x++) for (let y = math.floor(box.left_top.y); y < math.ceil(box.right_bottom.y); y++) brain.reserved[tkey(x, y)] = true
        }
        return false
      }
      for (const part of first.parts) if (part.built !== undefined && part.built.valid) return false
      for (const s of brain.sites) {
        if (s.kind === "chest" && s.status === "built" && s.id !== first.id) {
          log(`[m6] B15 evicted site ${first.id} picked up, replacement ${s.id} built at tick ${game.tick}`)
          return true
        }
      }
      return false
    })
  })

  test("B20: a planned outpost over a live bootstrap site: the site is evicted and picked up, the outpost built", () => {
    const lab = createLab(40)
    // A small patch: an outpost of two electric drills can only go where the bootstrap's site already stands.
    ore(lab, "stone", 8, -14, 5, 6)
    setConfigOverride("bootstrapSites", "stone=1")
    setConfigOverride("firstElectricityItems", "")
    const faction = labFaction(lab, "b20", { "burner-mining-drill": 2, "wooden-chest": 2, wood: 4, coal: 30 })
    const brain = faction.brain!
    let site: Site | undefined
    let planned = false
    let built = false
    const id = "b20-plan"
    if (getPlannerEntry(id) !== undefined) removePlan(id)
    until(50000, () => {
      if (site === undefined) {
        for (const s of brain.sites) if (s.kind === "chest" && s.status === "built") site = s
        if (site === undefined) return false
        // Materials for the outpost in a chest the crew uses as a depot.
        const chest = lab.surface.create_entity({ name: "iron-chest", position: at(lab, -6.5, 10.5), force: faction.force })!
        chest.insert({ name: "electric-mining-drill", count: 4 })
        chest.insert({ name: "transport-belt", count: 20 })
        chest.insert({ name: "small-electric-pole", count: 6 })
        addStockpile(faction, chest)
        const def = generatedModule("mining-outpost", { resource: "stone", rows: 2, sides: 1 })
        const o = at(lab, 0, 0)
        const region = { x: math.floor(o.x) - 30, y: math.floor(o.y) - 30, w: 60, h: 60 }
        startPlan({ id, surface: lab.surface.name, force: faction.force, faction: faction.name, baseFaction: faction.name, request: { modules: [{ id: "out", def }], connections: [], center: at(lab, 10, -11), region } })
        return false
      }
      const entry = getPlannerEntry(id)!
      if (!planned) {
        if (entry.phase === "scan" || entry.phase === "plan") return false
        assert(entry.phase === "done", `plan failed: ${serpent.line(entry.job?.failures)}`)
        const parts = allParts(entry.job!.layout)
        const taken: Record<number, boolean> = {}
        for (const k of partTiles(entry.job!.layout, parts)) taken[k] = true
        const evicted = evictSites(faction, lab.surface, taken, "test plan")
        assert(evicted.length > 0 && site.status === "retired", `the bootstrap site under the outpost is evicted (${evicted.length}, ${site.status})`)
        for (const k of partTiles(entry.job!.layout, parts)) brain.reserved[k] = true
        startBuild(entry, { parts, clear: evicted, priority: 90 })
        planned = true
        return false
      }
      if (entry.build!.phase !== "done") return false
      let ghosts = 0
      let drills = 0
      const m = entry.job!.layout.modules[0]
      const area = { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } }
      ghosts = lab.surface.count_entities_filtered({ area, type: "entity-ghost" })
      drills = lab.surface.count_entities_filtered({ area, name: "electric-mining-drill" })
      if (ghosts > 0 && !built) return false
      for (const part of site.parts) assert(part.built === undefined || !part.built.valid, "the evicted site was picked up")
      assert(drills === 2 && ghosts === 0, `outpost built: ${drills} drills, ${ghosts} ghosts`)
      built = true
      log(`[m6] B20 outpost built over evicted site ${site.id} at tick ${game.tick}`)
      return true
    })
  })
})
