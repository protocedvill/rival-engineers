import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { moduleId } from "../shared/ids"
import { addStockpile, createFaction, destroyFaction } from "../jobs/faction"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { moduleEntities, routeEntities } from "../planner/build-list"
import { beltTiers, decideOverflow, availableTiers } from "../planner/capacity"
import { buildGraph } from "../planner/graph"
import { Rect } from "../planner/grid"
import { commitModule, findModule, LayoutState, newLayout, PlacedModule } from "../planner/layout"
import { newRoutingJob, PlanRequest, runJob } from "../planner/plan"
import { selectPolicy } from "../planner/policy"
import { getPlannerEntry, obstaclesUnder, PlannerEntry, removePlan, stampLayout, startBuild, startPlan } from "../planner/runtime"
import { newTerrain, requestArea, stepTerrain, terrainView } from "../planner/terrain"
import { setAiProfiler } from "../profiling"
import { at, createLab } from "./lab"
import { labForce } from "./module-lab"
import { feed, feeders, followRoute, layoutBill, layoutProblems, m4Modules, powerModules, writeRender } from "./route-lab"

// M4b acceptance (SPEC §8): the router connects 5 modules in a lab (no crossings through footprints, every route
// arriving at the right port from the right side, and the factory runs), the early-compact LayoutPolicy places and
// routes them on real generated terrain (cliffs, water, trees, pre-placed structures; ≥ 4 of 5 seeds), the crew build
// one routed plan from a stockpile, and a deliberately undersized belt caps throughput as the capacity math says.

const SPEED = 100
const SEEDS = [123456, 987654, 555555, 31337, 2718281]

function surfaceFor(seed: number, name = `m4b-${seed}`): LuaSurface {
  const existing: LuaSurface | undefined = game.surfaces[name]
  if (existing !== undefined) return existing
  // Default Nauvis generation (cliffs, water, trees, starting area at the origin) with no enemy bases (D6).
  return game.create_surface(name, { seed, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
}

/** The red-only technology with the most units, with its prerequisites researched: labs research it during runs. */
function startRedResearch(force: LuaForce): string {
  let best: string | undefined
  let units = -1
  const names: string[] = []
  for (const [n] of pairs(prototypes.technology)) names.push(n as string)
  names.sort()
  for (const n of names) {
    const t = prototypes.technology[n]
    const ing = t.research_unit_ingredients
    if (ing.length !== 1 || ing[0].name !== "automation-science-pack" || t.research_unit_count_formula !== undefined) continue
    if (t.research_unit_count > units) {
      units = t.research_unit_count
      best = n
    }
  }
  const research = (name: string): void => {
    for (const [p] of pairs(prototypes.technology[name].prerequisites)) {
      if (!force.technologies[p as string].researched) {
        research(p as string)
        force.technologies[p as string].researched = true
      }
    }
  }
  research(best!)
  force.cancel_current_research()
  force.add_research(best!)
  return best!
}

function labPacks(surface: LuaSurface, layout: LayoutState): number {
  const m = findModule(layout, moduleId("labs"))!
  let n = 0
  for (const e of surface.find_entities_filtered({ type: "lab", area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })) {
    n += e.get_inventory(defines.inventory.lab_input)!.get_item_count("automation-science-pack")
  }
  return n
}

interface PlanRun {
  entry: PlannerEntry
  ticks: number
}

/** Runs the planner (through the mod's on_tick) until the job finishes; logs per-tick planner time. */
function awaitPlan(id: string, tag: string, then: (this: void, run: PlanRun) => void): void {
  const total = helpers.create_profiler(true)
  setAiProfiler(total)
  let ticks = 0
  on_tick(() => {
    const entry = getPlannerEntry(id)!
    ticks++
    if (entry.phase === "scan" || entry.phase === "plan") return
    setAiProfiler(undefined)
    const s = entry.job?.stats
    log(["", `[m4b] ${tag} planned in ${ticks} ticks (scan ${entry.scanTicks}, plan ${entry.planTicks}), work ${s?.work} (placement ${s?.placeWork}, routing ${s?.routeWork}), ${s?.expansions} A* expansions in ${s?.searches} searches, ${s?.ripups} rip-ups, max ${s?.maxStepWork} units/tick; AI time `, total])
    then({ entry, ticks })
    return false
  })
}

function routeNumbers(layout: LayoutState): { tiles: number; ugs: number; routes: number; longest: number } {
  let tiles = 0
  let ugs = 0
  let longest = 0
  let routes = 0
  for (const id of layout.routeOrder) {
    const r = layout.routes[id]
    if (r.external) continue
    routes++
    tiles += r.length
    ugs += r.undergrounds
    longest = math.max(longest, r.length)
  }
  return { tiles, ugs, routes, longest }
}

function failures(entry: PlannerEntry): string {
  const parts: string[] = []
  for (const [k, v] of pairs(entry.job?.failures ?? {})) parts.push(`${k}: ${v}`)
  return parts.join("; ")
}

/** Builds a plan with real entities (script), after clearing trees and rocks; then checks every route in-game. */
function scriptBuild(surface: LuaSurface, entry: PlannerEntry): string[] {
  const layout = entry.job!.layout
  for (const e of obstaclesUnder(surface, layout)) e.destroy()
  const problems: string[] = []
  const r = stampLayout(surface, entry.force, layout, false)
  for (const f of r.failed) problems.push(`could not build ${f}`)
  for (const id of layout.routeOrder) {
    const route = layout.routes[id]
    if (route.external) continue
    const p = followRoute(surface, layout, route)
    if (p !== undefined) problems.push(`${id}: ${p}`)
  }
  return problems
}

function siteProblems(surface: LuaSurface, layout: LayoutState): string[] {
  const out: string[] = []
  const steam = findModule(layout, moduleId("steam"))
  if (steam) {
    for (const w of steam.def.anchor?.water ?? []) {
      for (let x = w.x; x < w.x + w.w; x++) {
        for (let y = w.y; y < w.y + w.h; y++) {
          if (!surface.get_tile(steam.origin.x + x, steam.origin.y + y).collides_with("water_tile")) out.push(`steam: anchor ${x},${y} is not water`)
        }
      }
    }
  }
  const mine = findModule(layout, moduleId("outpost"))
  if (mine) {
    for (const a of mine.def.anchor?.miningAreas ?? []) {
      const n = surface.count_entities_filtered({ name: "iron-ore", area: { left_top: { x: mine.origin.x + a.x, y: mine.origin.y + a.y }, right_bottom: { x: mine.origin.x + a.x + a.w, y: mine.origin.y + a.y + a.h } } })
      if (n < 0.5 * a.w * a.h) out.push(`outpost: drill area at ${a.x},${a.y} has ${n} iron tiles`)
    }
  }
  return out
}

let speed = 1

describe("M4b routing", () => {
  before_all(() => {
    speed = game.speed
    game.speed = SPEED
  })
  after_all(() => {
    game.speed = speed
    // Leftover factions keep planning (and slow every later test in the shard).
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    // The default budgets (settings.ts), pinned so the logged per-tick costs are at the defaults.
    setConfigOverride("plannerWorkPerTick", 100)
    setConfigOverride("terrainChunksPerTick", 2)
  })

  test("routing lab: 5 modules placed and routed, no crossings, right port sides, and red science reaches the labs", () => {
    const lab = createLab(80)
    const force = labForce()
    const s = lab.surface
    for (let x = 30; x < 48; x++) for (let y = -72; y < -50; y++) s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, y + 0.5), amount: 100000 })
    const set = m4Modules(false)
    const region: Rect = { x: lab.origin.x - 76, y: lab.origin.y - 76, w: 152, h: 152 }
    const request: PlanRequest = { modules: set.modules, connections: set.connections, center: { x: lab.origin.x, y: lab.origin.y }, region }
    if (getPlannerEntry("lab") !== undefined) removePlan("lab")
    startPlan({ id: "lab", surface: s.name, force: force.name, request })
    async(60 * 60 * 20)
    awaitPlan("lab", "lab", ({ entry }) => {
      assert(entry.phase === "done", `plan failed: ${failures(entry)}`)
      const layout = entry.job!.layout
      const t = storage.terrains![entry.terrain]
      const problems = layoutProblems(layout, terrainView(t))
      assert(problems.length === 0, problems.join("; "))
      const built = scriptBuild(s, entry)
      assert(built.length === 0, built.join("; "))
      const n = routeNumbers(layout)
      log(`[m4b] lab: ${n.routes} routes, ${n.tiles} belt tiles (longest ${n.longest}), ${n.ugs} undergrounds; modules ${layout.modules.map((m) => `${m.id}@${m.origin.x - lab.origin.x},${m.origin.y - lab.origin.y} r${m.transform.rot}${m.transform.mirror ? "m" : ""}`).join(" ")}`)
      writeRender(s, entry, "lab-planned")
      const powered = powerModules(s, force, layout)
      assert(powered.length === 0, powered.join("; "))
      const tech = startRedResearch(force)
      const fs = feeders(s, layout, { coal: 1, "copper-plate": 1.5 })
      let ticks = 0
      const RUN = 60 * 60 * 8
      on_tick(() => {
        feed(fs)
        ticks++
        if (ticks % 3600 === 0) print(`[m4b] lab factory: ${ticks / 3600} game-min`)
        if (ticks < RUN) return
        const progress = force.research_progress
        const packs = labPacks(s, layout)
        log(`[m4b] lab run: after ${RUN / 3600} game-min, ${tech} progress ${progress}, ${packs} red packs in the labs`)
        writeRender(s, entry, "lab-running")
        assert(progress > 0 || packs > 0, "no red science reached the labs")
        done()
        return false
      })
    })
  })

  for (const seed of SEEDS) {
    test(`real terrain [slow]: seed ${seed}: 6 modules placed and routed around water, cliffs, trees and structures`, () => {
      const surface = surfaceFor(seed)
      const center = { x: 0, y: 0 }
      surface.request_to_generate_chunks(center, 5)
      surface.force_generate_chunk_requests()
      const faction = createFaction(`m4b-${seed}`, { surface: surface.name })
      // Pre-placed structures: some of the faction's own (existing production) and another force's.
      const own: [string, number, number][] = [
        ["stone-furnace", 2, 2],
        ["stone-furnace", 5, 2],
        ["wooden-chest", 3, -3],
        ["burner-mining-drill", -4, 4],
      ]
      for (const [name, x, y] of own) {
        const p = surface.find_non_colliding_position(name, { x, y }, 10, 1)
        if (p) surface.create_entity({ name, position: p, force: faction.force })
      }
      for (let i = 0; i < 6; i++) {
        const p = surface.find_non_colliding_position("stone-wall", { x: -12 + i, y: -10 }, 6, 1)
        if (p) surface.create_entity({ name: "stone-wall", position: p, force: faction.force })
      }
      const other = game.forces["m4b-other"] ?? game.create_force("m4b-other")
      for (const [x, y] of [[14, -6], [15, -6], [-15, 12]]) {
        const p = surface.find_non_colliding_position("iron-chest", { x, y }, 8, 1)
        if (p) surface.create_entity({ name: "iron-chest", position: p, force: other })
      }
      const set = m4Modules(true)
      const region: Rect = { x: -112, y: -112, w: 224, h: 224 }
      const id = `seed-${seed}`
      if (getPlannerEntry(id) !== undefined) removePlan(id)
      startPlan({ id, surface: surface.name, force: faction.force, faction: faction.name, request: { modules: set.modules, connections: set.connections, center, region } })
      async(60 * 60 * 20)
      awaitPlan(id, `seed ${seed}`, ({ entry, ticks }) => {
        // Terrain fingerprint: tells a planner difference from a terrain difference between runs.
        const view = terrainView(storage.terrains![entry.terrain])
        let hash = 0
        for (let x = region.x; x < region.x + region.w; x++) {
          for (let y = region.y; y < region.y + region.h; y++) {
            const b = view.block(x, y)
            const o = view.ore(x, y)
            if (b !== 0 || o !== undefined) hash = (hash * 31 + (x - region.x) * 7 + (y - region.y) * 13 + b * 101 + (o !== undefined ? string.len(o) : 0)) % 1000000007
          }
        }
        log(`[m4b] seed ${seed}: terrain hash ${hash}`)
        const result: string[] = []
        if (entry.phase !== "done") result.push(`plan failed: ${failures(entry)}`)
        else {
          const layout = entry.job!.layout
          for (const p of layoutProblems(layout, terrainView(storage.terrains![entry.terrain]))) result.push(p)
          for (const p of siteProblems(surface, layout)) result.push(p)
          let trees = 0
          for (const e of obstaclesUnder(surface, layout)) if (e.valid) trees++
          for (const p of scriptBuild(surface, entry)) result.push(p)
          const n = routeNumbers(layout)
          log(`[m4b] seed ${seed}: ${n.routes} routes, ${n.tiles} belt tiles (longest ${n.longest}), ${n.ugs} undergrounds, ${trees} trees/rocks cleared, ${ticks} ticks; modules ${layout.modules.map((m) => `${m.id}@${m.origin.x},${m.origin.y} r${m.transform.rot}${m.transform.mirror ? "m" : ""}`).join(" ")}`)
        }
        writeRender(surface, entry, `seed-${seed}`)
        storage.testScratch ??= {}
        const scratch = (storage.testScratch.m4seeds ??= {}) as Record<string, string>
        scratch[tostring(seed)] = result.length === 0 ? "valid" : result.join("; ")
        log(`[m4b] seed ${seed}: ${result.length === 0 ? "VALID" : "INVALID: " + result.join("; ")}`)
        destroyFaction(faction.name)
        done()
      })
    })
  }

  test("real terrain [slow]: valid on at least 4 of 5 seeds", () => {
    const scratch = (storage.testScratch?.m4seeds ?? {}) as Record<string, string>
    let valid = 0
    const bad: string[] = []
    for (const seed of SEEDS) {
      if (scratch[tostring(seed)] === "valid") valid++
      else bad.push(`${seed}: ${scratch[tostring(seed)] ?? "not run"}`)
    }
    log(`[m4b] real terrain: ${valid}/${SEEDS.length} seeds valid`)
    assert(valid >= 4, `only ${valid} of ${SEEDS.length} seeds valid: ${bad.join(" | ")}`)
  })

  test("crew-built [slow]: the crew build a routed real-terrain plan from a stockpile, and it runs", () => {
    // Its own copy of the first seed's map (the seed test built at its origin with script).
    const seed = SEEDS[0]
    const surface = surfaceFor(seed, `m4b-crew-${seed}`)
    const base = { x: 0, y: 0 }
    surface.request_to_generate_chunks(base, 5)
    surface.force_generate_chunk_requests()
    const faction = createFaction(`m4b-crew`, { surface: surface.name, position: base, crew: 2 })
    const set = m4Modules(true)
    const region: Rect = { x: base.x - 112, y: base.y - 112, w: 224, h: 224 }
    if (getPlannerEntry("crew") !== undefined) removePlan("crew")
    startPlan({ id: "crew", surface: surface.name, force: faction.force, faction: faction.name, request: { modules: set.modules, connections: set.connections, center: base, region } })
    async(60 * 60 * 120)
    awaitPlan("crew", "crew seed", ({ entry }) => {
      assert(entry.phase === "done", `plan failed: ${failures(entry)}`)
      const layout = entry.job!.layout
      const specs = [...moduleEntities(layout), ...routeEntities(layout)]
      const bill = layoutBill(specs, { coal: 200 })
      // Stockpile chests next to the crew, out of the layout.
      const remaining = { ...bill }
      for (let i = 0; i < 12; i++) {
        let any = false
        for (const [k, v] of pairs(remaining)) if (v > 0 && k !== undefined) any = true
        if (!any) break
        const p = surface.find_non_colliding_position("iron-chest", { x: base.x - 30 + i, y: base.y + 40 }, 30, 1)!
        const chest = surface.create_entity({ name: "iron-chest", position: p, force: faction.force })!
        for (const [item, n] of pairs(remaining)) {
          if (n <= 0) continue
          const put = chest.insert({ name: item as string, count: n })
          remaining[item as string] = n - put
        }
        addStockpile(faction, chest)
      }
      // Obstacles on the plan: a few trees on the longest route's tiles, which the crew must clear before building.
      let longest = layout.routes[layout.routeOrder[0]]
      for (const id of layout.routeOrder) if (layout.routes[id].length > longest.length) longest = layout.routes[id]
      for (const i of [3, 8, 13]) {
        const st = longest.steps[math.min(i, longest.steps.length - 1)]
        surface.create_entity({ name: "tree-01", position: { x: st.x + 0.5, y: st.y + 0.5 } })
      }
      const build = startBuild(entry, { fuel: { item: "coal", count: 5 } })
      log(`[m4b] crew: ${specs.length} entities to build, ${build.clearJobs.length} trees/rocks to clear`)
      const startTick = game.tick
      on_tick(() => {
        if (entry.build!.phase !== "done") return
        const ticks = game.tick - startTick
        const r = entry.build!
        let ghosts = 0
        for (const m of layout.modules) ghosts += surface.count_entities_filtered({ type: "entity-ghost", force: faction.force, area: { left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h } } })
        log(`[m4b] crew: built in ${ticks} ticks (${string.format("%.1f", ticks / 3600)} game-min), ${r.placeJobs.length} place jobs, ${ghosts} ghosts left in modules, problems: ${r.failed.join("; ")}`)
        writeRender(surface, entry, "crew-built")
        const problems: string[] = []
        for (const id of layout.routeOrder) {
          const route = layout.routes[id]
          if (route.external) continue
          const p = followRoute(surface, layout, route)
          if (p !== undefined) problems.push(`${id}: ${p}`)
        }
        assert(ghosts === 0 && problems.length === 0, `not built: ${ghosts} ghosts; ${problems.join("; ")}`)
        const force = game.forces[faction.force]
        for (const [, recipe] of pairs(force.recipes)) recipe.enabled = true
        const powered = powerModules(surface, force, layout)
        assert(powered.length === 0, powered.join("; "))
        const tech = startRedResearch(force)
        const fs = feeders(surface, layout, { coal: 1, "copper-plate": 1.5 })
        let ticksRun = 0
        const RUN = 60 * 60 * 8
        on_tick(() => {
          feed(fs)
          // A heartbeat on stdout: the test CLI kills Factorio after a stretch with no output.
          if (++ticksRun % 3600 === 0) print(`[m4b] crew-built factory: ${ticksRun / 3600} game-min`)
          if (ticksRun < RUN) return
          const progress = force.research_progress
          const packs = labPacks(surface, layout)
          log(`[m4b] crew-built run: ${tech} progress ${progress}, ${packs} red packs in the labs`)
          writeRender(surface, entry, "crew-running")
          destroyFaction(faction.name)
          assert(progress > 0 || packs > 0, "no red science reached the labs")
          done()
          return false
        })
        return false
      })
    })
  })

  test("undersized belt: a 20/s flow on a yellow route measures ≤ 15/s; the overflow decision upgrades it and it carries 20/s", () => {
    const lab = createLab(40)
    const force = labForce()
    force.technologies["logistics-2"].researched = true
    const s = lab.surface
    // A pond between source and sink.
    const tiles = []
    for (let x = -4; x < 4; x++) for (let y = -6; y < 6; y++) tiles.push({ name: "water", position: at(lab, x, y) })
    s.set_tiles(tiles)
    const beltBox = (id: string, kind: "belt-in" | "belt-out", rate: number): ModuleDef => ({
      id,
      source: "generated",
      footprint: { w: 1, h: 1 },
      entities: [{ name: "transport-belt", x: 0.5, y: 0.5, dir: 4 }],
      ports: [{ id: kind === "belt-out" ? "out" : "in", kind, pos: { x: 0.5, y: 0.5 }, dir: 4, item: "iron-plate" }],
      recipes: [],
      machines: [],
      rates: kind === "belt-out" ? { inputs: [], outputs: [{ item: "iron-plate", perSecond: rate }] } : { inputs: [{ item: "iron-plate", perSecond: rate }], outputs: [] },
      requiresTech: [],
      rotatable: true,
      mirrorable: true,
    })
    const layout = newLayout()
    const place = (def: ModuleDef, x: number, y: number): PlacedModule => {
      const m: PlacedModule = { id: moduleId(def.id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: 1, h: 1 } }
      commitModule(layout, m, prototypeFacts, 0)
      return m
    }
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    place(beltBox("src", "belt-out", 20), ox - 20, oy)
    place(beltBox("dst", "belt-in", 20), ox + 20, oy)
    const terrain = newTerrain("m4b-undersized", s.name, force.name)
    requestArea(terrain, { x: ox - 40, y: oy - 40, w: 80, h: 80 })
    while (stepTerrain(terrain, 100) > 0) {
      // synchronous scan for the test
    }
    const tiersList = beltTiers(prototypeFacts)
    const policy = selectPolicy("early-compact", {})
    const request: PlanRequest = { modules: [], connections: [{ id: "flow", from: { module: moduleId("src"), port: "out" }, to: { module: moduleId("dst"), port: "in" } }], center: { x: ox, y: oy }, region: { x: ox - 40, y: oy - 40, w: 80, h: 80 } }
    const job = runJob(newRoutingJob(request, tiersList[0], layout), terrainView(terrain), prototypeFacts, policy)
    assert(job.phase === "done", "routed")
    const g = buildGraph(layout, policy, { tiers: tiersList, researched: { "logistics-2": true } })
    const edge = g.physical.edges[0]
    log(`[m4b] undersized: planned ${edge.plannedRate}/s, capacity ${edge.capacity.capacity}/s, usable ${edge.capacity.usable}/s, decision ${serpent.line(edge.decision)}; route ${edge.length} tiles, ${edge.undergrounds} undergrounds`)
    assert(!edge.capacity.ok && edge.capacity.limitedBy === "belt", "flagged as over capacity")
    assert(edge.decision.action === "upgrade-tier", `decision ${edge.decision.action}`)
    const without = decideOverflow({ demand: 20, edge: { tier: tiersList[0], lanes: 2, utilization: 0.99 }, available: availableTiers(tiersList, {}), order: policy.overflow.order, maxParallel: 2 })
    assert(without.action === "parallel-route", "without logistics-2: parallel routes")
    let built = stampLayout(s, force.name, layout, false)
    assert(built.failed.length === 0, built.failed.join("; "))
    const dstPos = { x: ox + 20.5, y: oy + 0.5 }
    const measure = (ticks: number, then: (this: void, rate: number) => void): void => {
      let n = 0
      let t = 0
      const srcBelt = (): LuaEntity => s.find_entities_filtered({ position: { x: ox - 19.5, y: oy + 0.5 }, type: "transport-belt" })[0]
      const dstBelt = (): LuaEntity => s.find_entities_filtered({ position: dstPos, type: "transport-belt" })[0]
      const sb = srcBelt()
      const db = dstBelt()
      const fs = [{ item: "iron-plate", lines: [sb.get_transport_line(1), sb.get_transport_line(2)], perTick: 25 / 60, credit: 0, next: 0 }]
      on_tick(() => {
        feed(fs)
        t++
        for (const i of [1, 2]) {
          const line = db.get_transport_line(i)
          if (t > 3600) n += line.get_item_count()
          line.clear()
        }
        if (t < 3600 + ticks) return
        then((n / ticks) * 60)
        return false
      })
    }
    async(60 * 60 * 5)
    measure(60 * 60, (yellow) => {
      log(`[m4b] undersized: yellow route measured ${string.format("%.2f", yellow)}/s for 20/s planned (capacity 15/s)`)
      assert(yellow <= 15.05 && yellow >= 14, `yellow carried ${yellow}/s`)
      // Act on the decision: rebuild the route (and the end belts) with the upgraded tier.
      const fast = tiersList.filter((t) => t.belt === (edge.decision as { belt: string }).belt)[0]
      for (const e of built.entities) if (e.valid) e.destroy()
      for (const id of layout.routeOrder) {
        const r = layout.routes[id]
        r.belt = fast.belt
        r.underground = fast.underground
        r.splitter = fast.splitter
      }
      for (const m of layout.modules) m.def = { ...m.def, entities: m.def.entities.map((e) => ({ ...e, name: fast.belt })) }
      built = stampLayout(s, force.name, layout, false)
      assert(built.failed.length === 0, built.failed.join("; "))
      measure(60 * 60, (red) => {
        log(`[m4b] undersized: after upgrade to ${fast.belt} measured ${string.format("%.2f", red)}/s`)
        assert(red >= 19.5, `upgraded route carried ${red}/s`)
        done()
      })
    })
  })

  test("D36: a plan without undergrounds compares itself with them in game (river detour), bounded and counted", () => {
    const lab = createLab(60)
    const force = labForce()
    const s = lab.surface
    // A 3-wide river from the north edge down to y = +20: a source west of it, a sink east of it, both near the top.
    const tiles = []
    for (let x = -1; x < 2; x++) for (let y = -60; y < 20; y++) tiles.push({ name: "water", position: at(lab, x, y) })
    s.set_tiles(tiles)
    const box = (id: string, kind: "belt-in" | "belt-out"): ModuleDef => ({
      id,
      source: "generated",
      footprint: { w: 1, h: 1 },
      entities: [],
      ports: [{ id: kind === "belt-out" ? "out" : "in", kind, pos: { x: 0.5, y: 0.5 }, dir: 4, item: "iron-plate" }],
      recipes: [],
      machines: [],
      rates: { inputs: [], outputs: [] },
      requiresTech: [],
      rotatable: false,
      mirrorable: false,
    })
    const a = box("a", "belt-out")
    const b = box("b", "belt-in")
    const layout = newLayout()
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const put = (def: ModuleDef, x: number, y: number): void => {
      commitModule(layout, { id: moduleId(def.id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: 1, h: 1 } } as PlacedModule, prototypeFacts, 0)
    }
    put(a, ox - 20, oy - 40)
    put(b, ox + 20, oy - 40)
    const request: PlanRequest = {
      modules: [],
      connections: [{ id: "c", from: { module: moduleId("a"), port: "out" }, to: { module: moduleId("b"), port: "in" } }],
      center: { x: ox, y: oy },
      region: { x: ox - 58, y: oy - 58, w: 116, h: 116 },
      compare: { undergrounds: { tiers: beltTiers(prototypeFacts) }, workFactor: 2, minWork: 5000 },
    }
    // Planned on top of a "base" layout holding the two modules (a plan normally takes its faction's), with
    // undergrounds clamped to none (logistics not researched).
    storage.factories ??= {}
    storage.factories["d36-test"] = { layout } as never
    const work0 = storage.work?.total.routerExpansions ?? 0
    if (getPlannerEntry("d36") !== undefined) removePlan("d36")
    startPlan({ id: "d36", surface: s.name, force: force.name, request, maxUnderground: 1, baseFaction: "d36-test" })
    async(60 * 60 * 10)
    on_tick(() => {
      const e = getPlannerEntry("d36")!
      if (e.phase === "scan" || e.phase === "plan") return
      delete storage.factories!["d36-test"]
      assert(e.phase === "done", `plan failed: ${failures(e)}`)
      const route = e.job!.layout.routes["route:c"]
      assert(route.undergrounds === 0, "the plan has no undergrounds")
      const r = (e.job!.compare?.results ?? [])[0]
      assert(r !== undefined && r.kind === "undergrounds" && r.status === "done", `comparison: ${serpent.line(r)}`)
      log(`[d36] in game: without undergrounds ${r.base} tiles, with ${r.alt} (saving ${r.saving}); comparison work ${r.work}, plan routing work ${e.job!.stats.routeWork}`)
      // The router's window (24 tiles past the endpoints) bounds the detour this lab can force: ~46 tiles. The ≥ 50 cases
      // and the decision are pinned by T1 (planner-batch, plan-replay); this checks the in-game runtime path.
      assert(r.saving! >= 40, `saving ${r.saving}`)
      assert(r.work <= math.max(5000, 2 * e.job!.stats.routeWork) + 200, `bounded work ${r.work}`)
      assert((storage.work?.total.routerExpansions ?? 0) > work0, "router expansions counted")
      done()
      return false
    })
  })
})
