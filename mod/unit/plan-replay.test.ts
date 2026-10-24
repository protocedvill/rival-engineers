// T1 replays of in-game plans that failed (soak regressions). A soak with frame dumps on writes each failed plan's
// input to script-output/rival-engineers/failed-plans/<faction>/<goal>-a<attempt>-t<tick>.input.lua (runtime.ts
// exportPlanInput); copy one into mod/unit/fixtures/ and list it below. Each replay runs the plan unbudgeted on the
// captured terrain and base layout and must succeed. (Plain Lua's `pairs` order is not Factorio's, so a replay is the
// same scenario, not a bit-exact rerun.) Each replay prints a `REPLAY {json}` metrics line (tabulated by
// `npm run replay:sweep`) and, when it fails or with REPLAY_DUMP=1, writes a decision dump (dump.ts) to
// out/replay-dumps/<replay>/.

import { BeltTier, beltTiers, tierByBelt } from "../src/planner/capacity"
import { routeId, layoutClaimTag } from "../src/shared/ids"
import { FOREIGN, FREE, keyX, keyY, OWN, ROCK, TerrainView, tkey, TREE, UNKNOWN } from "../src/planner/grid"
import { findModule, growthUnitRects, LayoutState, moduleMargin, ripRoute } from "../src/planner/layout"
import { CompareResult, logisticsFirst, newPlanJob, PlanRequest, runJob, stepPlan } from "../src/planner/plan"
import { laneLeadsOut, openPortEnds, sealedInputs } from "../src/planner/placement"
import { EARLY_COMPACT, LayoutPolicy } from "../src/planner/policy"
import { finishReplay, startTrace } from "./dump"
import { ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

interface PlanInput {
  id: string
  request: PlanRequest
  belt: string
  tiers: BeltTier[]
  base?: LayoutState
  policy: LayoutPolicy
  origin: { x: number; y: number }
  blocks: string[]
  ores: string[]
}

const BLOCKS: Record<string, number> = { ".": 0, T: 1, R: 2, "#": 3, X: 4, "~": 5, C: 6, "?": 7 }
const ORES: Record<string, string> = { i: "iron-ore", c: "copper-ore", k: "coal", s: "stone" }

function fixtureView(fx: PlanInput): TerrainView {
  const at = (rows: string[], x: number, y: number): string | undefined => {
    const row = rows[y - fx.origin.y]
    const i = x - fx.origin.x
    if (row === undefined || i < 0 || i >= row.length) return undefined
    return row.substring(i, i + 1)
  }
  return {
    block: (x, y) => {
      const c = at(fx.blocks, x, y)
      return c === undefined ? UNKNOWN : (BLOCKS[c] ?? FREE)
    },
    ore: (x, y) => {
      const c = at(fx.ores, x, y)
      return c === undefined ? undefined : ORES[c]
    },
  }
}

declare const os: { getenv(this: void, name: string): string | undefined }
declare function loadfile(this: void, path: string): ((this: void) => unknown) | undefined

function load(name: string, captured = false): PlanInput {
  // $UNIT_SRC: mod/unit (set by the T1 runner, whatever the build dir); else relative to mod/build-unit.
  const chunk = loadfile(`${os.getenv("UNIT_SRC") ?? "../unit"}/fixtures/${name}.lua`)
  if (chunk === undefined) error(`fixture ${name} not found (run through tools/run-unit-tests.mjs, or from mod/build-unit)`)
  const fx = chunk() as PlanInput
  // A capture freezes the policy of its day; replays judge the planner as it is now (user, 2026-10-20). Every weight
  // comes from the current defaults; only the choices the game made for that plan (topology, smelting, utilization)
  // stay as captured. A test that pins a past decision pins its weights itself, saying why (compareReplay: B26, D59).
  // REPLAY_CAPTURED=1 replays with the captured policy instead.
  if (!captured && (os.getenv("REPLAY_CAPTURED") ?? "") === "") fx.policy = currentPolicy(fx.policy)
  // Experiments, for every replay: REPLAY_ROUTER="maxRipups=6,rip=10" overrides router weights, REPLAY_PLACEMENT=
  // "growthBand=4,growthBlocked=8" placement weights (B26 judged on several replays).
  for (const [k, v] of string.gmatch(os.getenv("REPLAY_ROUTER") ?? "", "(%w+)=([%d.]+)")) (fx.policy.router as unknown as Record<string, number>)[k] = tonumber(v)!
  for (const [k, v] of string.gmatch(os.getenv("REPLAY_PLACEMENT") ?? "", "(%w+)=([%d.]+)")) (fx.policy.placement as unknown as Record<string, number>)[k] = tonumber(v)!
  return fx
}

/** The current default policy with the captured plan's own choices (see `load`). */
function currentPolicy(captured: LayoutPolicy): LayoutPolicy {
  const p = EARLY_COMPACT
  return {
    ...p,
    corridor: { ...p.corridor },
    moduleSelection: { ...p.moduleSelection },
    obstacles: { ...p.obstacles },
    searchRadii: [...p.searchRadii],
    overflow: { ...p.overflow, order: [...p.overflow.order] },
    router: { ...p.router },
    placement: { ...p.placement },
    topology: captured.topology,
    smelting: captured.smelting ?? p.smelting,
    utilization: captured.utilization,
  }
}

interface ReplayOptions {
  /** Plan with the vanilla belt tiers' undergrounds (the capture had them restricted). */
  undergrounds?: boolean
  /** Tiles (x1, y1, x2, y2 inclusive) the capture saw as own ground that hold nothing: free them (stale reservations). */
  free?: [number, number, number, number][]
  /** Expected outcome (default done). */
  expect?: "done" | "failed"
  /** Text required in a failed replay's certificate. */
  failureIncludes?: string
  /** Requests that represent route-reassignment providers and must use an independent mine site. */
  newSites?: string[]
}

/** REPLAY_DUMP=1: each module's placement, mine plan (B33) or ore-clipped strip, and belt ports. */
function dumpModules(layout: LayoutState): void {
  for (const m of layout.modules) {
    const ports = m.def.ports.filter((p) => p.kind !== "power").map((p) => `${p.id}@${m.origin.x + p.pos.x},${m.origin.y + p.pos.y}`)
    print(`    module ${m.id} ${m.canonical.id} at ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h}${m.minePlan !== undefined ? ` mine plan ${m.minePlan.claim.length} tiles` : ""}${m.oreUnits !== undefined ? ` strip, ${m.oreUnits} units on ore` : ""} ports ${ports.join(" ")}`)
  }
}

function replay(name: string, opts: ReplayOptions = {}): void {
  test(`replay ${name}${opts.undergrounds ? " with undergrounds" : ""}${opts.free !== undefined ? " (stale reservations freed)" : ""}`, () => {
    const fx = load(name)
    if (opts.undergrounds) fx.tiers = beltTiers(F)
    for (const m of fx.request.modules) if (opts.newSites !== undefined && opts.newSites.indexOf(m.id) >= 0) m.newSite = true
    const ug = tonumber(os.getenv("REPLAY_UNDERGROUND") ?? "")
    if (ug !== undefined) fx.tiers = fx.tiers.map((t) => ({ ...t, maxUnderground: ug }))
    const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
    const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
    const view = fixtureView(fx)
    const free = opts.free ?? []
    const terrain: TerrainView = {
      block: (x, y) => {
        for (const [x1, y1, x2, y2] of free) if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && view.block(x, y) === OWN) return FREE
        return view.block(x, y)
      },
      ore: (x, y) => view.ore(x, y),
    }
    startTrace()
    runJob(job, terrain, F, fx.policy, 100000)
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
    print(`  ${name}: ${job.phase} (${job.stats.searches} searches, ${job.stats.ripups} rip-ups, ${job.stats.replacements} replacements)`)
    if (os.getenv("REPLAY_DUMP") !== undefined) for (const m of job.layout.modules) print(`    module ${m.id} ${m.canonical.id} at ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h} rot ${m.transform.rot}${m.transform.mirror ? " mirror" : ""}`)
    finishReplay(`${name}${opts.undergrounds ? "-ug" : ""}${opts.free !== undefined ? "-freed" : ""}`, job, job.phase === (opts.expect ?? "done"))
    ok(job.phase === (opts.expect ?? "done"), `plan ${opts.expect ?? "done"} (${job.phase}: ${why.join("; ")})`)
    if (opts.failureIncludes !== undefined) ok(string.find(why.join("; "), opts.failureIncludes, 1, true)[0] !== undefined, `failure includes ${opts.failureIncludes}: ${why.join("; ")}`)
  })
}

// Seed 222, the stage-1 production cluster (7 modules, 7 flows) on top of power + labs, first attempt. Without
// undergrounds every attempt and every retried goal failed on routes boxing each other in (M5a acceptance re-run); the
// strategy now researches undergrounds after such a goal (FactoryState.needUndergrounds), and with them it plans
// without a single rip-up.
replay("seed222-production", { undergrounds: true })

// D36's infinite case per attempt (M5d): the same capture without undergrounds fails to route; its comparison routes
// the same placement with them, so the attempt says "research logistics first" at once instead of after every retry.
test("replay seed222-production without undergrounds: routing fails, the underground alternative routes (infinitely shorter)", () => {
  // D36's infinite case is pinned at the capture's weights: on today's (D59 soft claims, B26 bands) the cluster routes
  // without undergrounds (197 tiles, no rip-ups), which is better, but no longer the case this test is about.
  const fx = load("seed222-production", true)
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  ok(tier.maxUnderground <= 1, "captured without undergrounds")
  fx.request.compare = { undergrounds: { tiers: beltTiers(F) }, workFactor: 2, minWork: 5000 }
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  startTrace()
  runJob(job, fixtureView(fx), F, fx.policy, 100000)
  if (os.getenv("REPLAY_DUMP") !== undefined) dumpModules(job.layout)
  const results: CompareResult[] = job.compare?.results ?? []
  const d = logisticsFirst(results, 50, 50)
  finishReplay("seed222-production-no-ug", job, job.phase === "failed" && d.undergrounds)
  ok(job.phase === "failed", `the plan fails without undergrounds (${job.phase})`)
  print(`  seed222 without undergrounds: ${d.why.join("; ")}`)
  ok(results.length === 1 && results[0].kind === "undergrounds" && results[0].status === "done" && results[0].baseFailed === true, "the underground alternative routes")
  ok(d.undergrounds, "research undergrounds first")
})

/**
 * An adopted plan's capture (soaks dump every adopted plan's input to plans/): soaks before 2026-10-16 wrote it after
 * the plan's own layout became the base, so take the plan's modules, routes and pole lines out of the base again.
 */
function stripPlan(base: LayoutState, req: PlanRequest): LayoutState {
  const mods: Record<string, boolean> = {}
  for (const m of req.modules) mods[m.id] = true
  const routes: Record<string, boolean> = {}
  for (const c of req.connections) routes[`route:${c.id}`] = true
  for (const id of [...base.routeOrder]) if (routes[id] && base.routes[id] !== undefined) ripRoute(base, id)
  const lines: Record<string, boolean> = {}
  for (const l of base.poleLines ?? []) if (mods[l.to]) lines[l.id] = true
  base.poleLines = (base.poleLines ?? []).filter((l) => !lines[l.id])
  base.poles = (base.poles ?? []).filter((p) => !lines[p.line])
  for (const [k, v] of pairs(base.occ)) {
    const tag = v as string
    const rest = string.sub(tag, 3)
    if ((string.sub(tag, 1, 2) === "m:" || string.sub(tag, 1, 2) === "x:") && (mods[rest] || lines[rest])) delete base.occ[k as number]
  }
  for (const [k, v] of pairs(base.reserved)) {
    const [mod] = string.match(v as string, "^p:([^.]+)%.")
    if (mod !== undefined && mods[mod]) delete base.reserved[k as number]
  }
  base.modules = base.modules.filter((m) => !mods[m.id])
  return base
}

/** Items made by two or more producers of this request, each feeding a different consumer (point-to-point). */
function multiProducerItems(fx: PlanInput): string[] {
  const producers: Record<string, string[]> = {}
  const order: string[] = []
  for (const c of fx.request.connections) {
    if (c.from === undefined) continue
    const m = fx.request.modules.filter((x) => x.id === c.from!.module)[0]
    const item = m?.def.ports.filter((p) => p.id === c.from!.port)[0]?.item
    if (item === undefined) continue
    if (producers[item] === undefined) {
      producers[item] = []
      order.push(item)
    }
    if (producers[item].indexOf(c.from.module) < 0) producers[item].push(c.from.module)
  }
  return order.filter((i) => producers[i].length >= 2)
}

/**
 * D36 / B2 on a real adopted production plan (no undergrounds then): the plan with the comparison on, as the strategy
 * runs it (current router weights added to the captured policy). Prints both savings; `expect` pins the decision at the
 * default thresholds (50 / 50).
 */
function compareReplay(name: string, expect: { undergrounds: boolean; splitters: boolean }, adopted = true): void {
  test(`replay ${name}: logistics comparison (undergrounds ${expect.undergrounds ? "≥" : "<"} 50, splitters ${expect.splitters ? "≥" : "<"} 50 tiles shorter)`, () => {
    // Current weights (`load`), with the pins below (REPLAY_NO_BUNDLE / REPLAY_NO_SOFT leave one out).
    const fx = load(name)
    // B26: these no-underground clusters pin the D36 / B2 decisions at the pre-B26 placement. Any B26 weight changes
    // the placements and the chaotic no-underground routing then fails (it routes with undergrounds: test below).
    // REPLAY_B26=1 keeps the current B26 weights.
    if (os.getenv("REPLAY_B26") === undefined) {
      fx.policy.placement.growthBand = 0
      fx.policy.placement.growthBlocked = 0
    }
    if (os.getenv("REPLAY_NO_BUNDLE") === undefined) fx.policy.router.bundleFactor = EARLY_COMPACT.router.bundleFactor
    else fx.policy.router.bundleFactor = 1
    if (os.getenv("REPLAY_NO_SOFT") === undefined) {
      // B52 / D59: pinned at the pre-D59 router cost too (0.5, no decay): at 10 / 0.5 the chaotic no-underground
      // seed 3333 cluster fails its routing (it plans with undergrounds: b26Replay). REPLAY_D59=1 uses the current cost.
      fx.policy.router.softClaim = os.getenv("REPLAY_D59") !== undefined ? EARLY_COMPACT.router.softClaim : 0.5
      fx.policy.router.softClaimDecay = os.getenv("REPLAY_D59") !== undefined ? EARLY_COMPACT.router.softClaimDecay : 1
      fx.policy.placement.softClaim = os.getenv("REPLAY_SOFT_PLACE") !== undefined ? tonumber(os.getenv("REPLAY_SOFT_PLACE"))! : EARLY_COMPACT.placement.softClaim
      if (os.getenv("REPLAY_NO_SOFT_ROUTE") !== undefined) fx.policy.router.softClaim = 0
    } else {
      fx.policy.router.softClaim = 0
      fx.policy.placement.softClaim = 0
    }
    for (const [k, v] of string.gmatch(os.getenv("REPLAY_PLACEMENT") ?? "", "(%w+)=([%d.]+)")) (fx.policy.placement as unknown as Record<string, number>)[k] = tonumber(v)!
    if (os.getenv("REPLAY_UG") !== undefined) fx.tiers = beltTiers(F)
    const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
    ok(tier.maxUnderground <= 1 || os.getenv("REPLAY_UG") !== undefined, "captured without undergrounds")
    const base = fx.base !== undefined && adopted ? stripPlan(fx.base, fx.request) : fx.base
    fx.request.compare = { undergrounds: { tiers: beltTiers(F) }, splitters: { items: multiProducerItems(fx) }, workFactor: 2, minWork: 5000 }
    const job = newPlanJob(fx.request, tier, base, fx.tiers)
    startTrace()
    runJob(job, fixtureView(fx), F, fx.policy, 100000)
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
    const results: CompareResult[] = job.compare?.results ?? []
    const d = logisticsFirst(results, 50, 50)
    finishReplay(`${name}-compare`, job, job.phase === "done" && d.undergrounds === expect.undergrounds && d.splitters === expect.splitters)
    ok(job.phase === "done", `plan done (${why.join("; ")})`)
    print(`  ${name}: plan work ${math.floor(job.stats.work)} (routing ${math.floor(job.stats.routeWork)}, comparison ${math.floor(job.stats.compareWork ?? 0)}); ${d.why.join("; ")}`)
    ok(d.undergrounds === expect.undergrounds, `undergrounds decision ${d.undergrounds}`)
    ok(d.splitters === expect.splitters, `splitters decision ${d.splitters}`)
  })
}

// The stage-1 production cluster of seeds 11 and 3333 as adopted in the M5c baseline soak (m5c-base, 209b69a), planned
// without undergrounds: with them the same placement routes 94 / 82 tiles shorter, so D36 now researches `logistics`
// first on these seeds. One coal producer with a splitter tap instead of two would save 32 / 46 tiles: under 50, so
// splitters alone would not. (Seeds 44444 and 555555's captures don't replay: plain Lua's `pairs` order makes the
// no-underground cluster fail there, as it often does in game.)
// D50 (placement soft claim 0.5, a module's partners exempt): seed 11's placement is the same as at 0.1 except one coal
// outpost 2 tiles over, but the no-underground cluster then routes 392 tiles instead of 336 (rip-up order); one coal
// producer then saves 88 tiles, so the splitter comparison (off by default since D50) would research splitters there.
// REPLAY_DUMP=1 writes the placements (score terms), soft claims and route failures to out/replay-dumps/<name>-compare/.
// D52 (3) (M6a.2): mining outposts' room to grow is a hard claim; the placements and routes moved, and the splitter
// decisions flipped (seed 11: one coal producer now saves -1 tiles, was 88; seed 3333: 60, was 46). The splitter
// comparison is off by default (D50); the underground decision is unchanged (118 / 82 tiles).
// B33: mines get their whole-patch plans in point-to-point plans too (one lane of the patch grid each) and strip mines
// claim growth only over ore; seed 3333's mines moved again and one coal producer now saves 14 tiles (was 60): the
// splitter decision flipped back (the comparison is still off by default). Undergrounds unchanged (seed 3333: 80).
compareReplay("seed11-production-ok", { undergrounds: true, splitters: false })
compareReplay("seed3333-production-ok", { undergrounds: true, splitters: false })

// B26 (growth bands): with the current placement weights the same two stage-1 clusters fail to route without
// undergrounds (the smelters' input/growth side now turns away from ore and claims, so feeds wrap around them), and
// route with them: in game D51 then researches undergrounds first, which these seeds decide anyway (≥ 50 tiles).
function b26Replay(name: string): void {
  test(`replay ${name} (B26 weights): plans with undergrounds`, () => {
    const fx = load(name)
    fx.policy.router.bundleFactor = EARLY_COMPACT.router.bundleFactor
    fx.policy.router.softClaim = EARLY_COMPACT.router.softClaim
    fx.policy.placement.softClaim = EARLY_COMPACT.placement.softClaim
    fx.tiers = beltTiers(F)
    const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
    const job = newPlanJob(fx.request, tier, stripPlan(fx.base!, fx.request), fx.tiers)
    runJob(job, fixtureView(fx), F, fx.policy, 100000)
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
    print(`  ${name} (B26): ${job.phase} (${job.stats.searches} searches, ${job.stats.ripups} rip-ups, ${job.stats.replacements} replacements)`)
    if (os.getenv("REPLAY_DUMP") !== undefined) dumpModules(job.layout)
    const map = os.getenv("REPLAY_MAP")
    if (map !== undefined) {
      const [x1, y1, x2, y2] = string.match(map, "(-?%d+),(-?%d+),(-?%d+),(-?%d+)")
      const view = fixtureView(fx)
      for (let y = tonumber(y1)!; y <= tonumber(y2)!; y++) {
        let row = ""
        for (let x = tonumber(x1)!; x <= tonumber(x2)!; x++) {
          const k = tkey(x, y)
          const o = job.layout.occ[k]
          let c = view.ore(x, y) !== undefined ? "," : "."
          if (view.block(x, y) !== FREE) c = "#"
          if (job.layout.mine?.[k] !== undefined) c = "m"
          if (job.layout.reserved[k] !== undefined) c = "r"
          if (o !== undefined) c = string.sub(o, 1, 1) === "m" ? string.sub(o, 4, 4) : "x"
          if (job.layout.routeOcc[k] !== undefined) c = "="
          row += c
        }
        print(`    ${y} ${row}`)
      }
    }
    ok(job.phase === "done", `plan done (${why.join("; ")})`)
  })
}
b26Replay("seed11-production-ok")
b26Replay("seed3333-production-ok")

// M6a.2: seed 11's cluster-1 green line (fix11, t211770): the labs' green input is boxed in by fixed routes.
replay("seed11-green-boxed", { expect: "failed" })
replay("seed11-green-boxed", { free: [[475, -81, 493, -76]] })

// M6a.2 (m6a2-dev5, seed 222, tick 520800): the logistic green line's route to the labs' in-logistic port fails
// "no path" at every region radius: the port's approach tile is walled by depot 22's reservation ring (a built depot
// was never evictable, so its 25 tiles read as OWN for good). In the fixed game the depot evicts like any other
// bootstrap site (evict.ts `evictable`), so its ground is clearable and the port is reachable.
replay("m6a2-seed222-green-line", { expect: "failed" })
replay("m6a2-seed222-green-line", { free: [[-44, 480, -40, 484]] })

// M6a.2 (m6a2-dev11, seed 222, tick 457740): the same plan as the fixed code saw it — depot 22's ring reads as
// clearable ground (the depot evicts now) and the plan routes through it, no rip-ups.
replay("m6a2-seed222-green-line-dev11")

// M6a.2 (m6a2-b21l, seed 222, tick 299250): the mall's iron request (g11). The stage-1 whole-patch iron mine n16
// (built 25 of 286 entities) is fixed, so the request was planned as a new 4x2 outpost — infeasible: the patch is
// claimed by the mine and 131 of its unbuilt footprint tiles are OWN (retired bootstrap sites whose entities were
// never picked up). "no feasible position" said nothing of the real cause. B23: the request instead completes the
// shared mine (wholePatchCandidate admits a fixed, not-yet-complete mine; the adoption builds the completion,
// `stepBuild` stamps `extraAdd`), and bootstrap sites on a mine's claim are evicted at adoption. As-is the freed
// ground is still reserved, so the plan works around the debris with a fresh mine (a legal outcome); with the sites'
// pickups freed (what the evictions do in game) it completes the mine and places smelter and mall.
replay("m6a2-seed222-mall-iron")

// B23 (A)→(B): the sites' pickups free the mine's claim; the request then completes the shared mine instead of
// placing a new one — n22 aliases to n16, the mine's plan is whole, and the full claim is occupied.
test("replay m6a2-seed222-mall-iron (stale reservations freed): the request completes the shared mine", () => {
  const fx = load("m6a2-seed222-mall-iron")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  const terrain: TerrainView = {
    block: (x, y) => {
      if (x >= -86 && x <= -47 && y >= 499 && y <= 535 && view.block(x, y) === OWN) return FREE
      return view.block(x, y)
    },
    ore: (x, y) => view.ore(x, y),
  }
  startTrace()
  runJob(job, terrain, F, fx.policy, 100000)
  const why: string[] = []
  for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
  print(`  m6a2-seed222-mall-iron (freed): ${job.phase} (${job.stats.searches} searches, ${job.stats.ripups} rip-ups, ${job.stats.replacements} replacements)`)
  finishReplay("m6a2-seed222-mall-iron-freed-shared", job, job.phase === "done" && (job.alias["n22"] ?? "") === "n16")
  ok(job.phase === "done", `plan done (${why.join("; ")})`)
  ok((job.alias["n22"] ?? "") === "n16", `n22 reuses the built mine instead of a new one (alias: ${job.alias["n22"]})`)
  const mine = findModule(job.layout, "n16")
  ok(mine !== undefined && mine.minePlan !== undefined && mine.minePlan.complete === true, "the shared mine's plan is whole")
  if (mine === undefined || mine.minePlan === undefined) return
  ok(mine.minePlan.occupied.length === mine.minePlan.claim.length, `the whole claim is occupied (${mine.minePlan.occupied.length}/${mine.minePlan.claim.length})`)
})

// B23 (C): a failed completion is recorded on the job (wholeFail) and, when no fallback placement saves the module,
// surfaces in the module's failure naming the shared mine. Deterministic sabotage: the completion's first unplanned
// entity is the belt at mine tile (-47,500) (def-local 40.5,2.5); force foreign ground under it, so the completion
// check fails there on the very first entity, before any pairs-order-sensitive search.
test("replay m6a2-seed222-mall-iron: a blocked completion names the shared mine", () => {
  const fx = load("m6a2-seed222-mall-iron")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  const terrain: TerrainView = {
    block: (x, y) => {
      if (x >= -86 && x <= -47 && y >= 499 && y <= 535 && view.block(x, y) === OWN) return FREE
      if (x === -47 && y === 500) return FOREIGN
      return view.block(x, y)
    },
    ore: (x, y) => view.ore(x, y),
  }
  // Small step budgets: placeStep records wholeFail when the completion fails, and clears it only if a fallback
  // placement later succeeds — step by step and check the record between calls (the success is thousands of work
  // units away, so the record cannot appear and vanish inside one call).
  for (let i = 0; i < 1000000; i++) {
    stepPlan(job, terrain, F, fx.policy, 5)
    const wf = job.wholeFail?.["n22"]
    if (wf !== undefined) {
      ok(wf === "n16: planned mine blocked at -47,500", `wholeFail records the completion's blocker (n22: ${wf})`)
      return
    }
    if (job.phase !== "place") break
  }
  ok(false, `the blocked completion was never tried (phase ${job.phase})`)
})

// B25: the mine's claim only reserves tiles that were free when the mine was placed — earlier own structures (a
// pole line, a route) standing on its still unbuilt footprint tiles outlive it. In game the completion build picks
// them up first (clear jobs under the new entities) and the reconcile layer re-routes the broken edge; the plan
// must still complete the shared mine. In the fixed run the same tiles read as the faction's reserved ground (OWN)
// under the mine.
test("replay m6a2-seed222-mall-iron: the shared mine completes over its own pole lines and earlier routes", () => {
  const fx = load("m6a2-seed222-mall-iron")
  if (fx.base === undefined) error("the mall-iron fixture has no base layout")
  // The completion's first unplanned belt (-47,500) and its neighbour stand on the mine's own footprint.
  const k1 = tkey(-47, 500)
  const k2 = tkey(-48, 500)
  fx.base.occ[k1] = layoutClaimTag("x:poles:9:1")
  fx.base.occ[k2] = layoutClaimTag("route:iron-ore>iron-plate>x=>x.in-ore")
  fx.base.routeOcc[k2] = routeId("route:iron-ore>iron-plate>x=>x.in-ore")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  const terrain: TerrainView = {
    block: (x, y) => {
      if (x >= -86 && x <= -47 && y >= 499 && y <= 535 && view.block(x, y) === OWN) return FREE
      return view.block(x, y)
    },
    ore: (x, y) => view.ore(x, y),
  }
  runJob(job, terrain, F, fx.policy, 100000)
  const why: string[] = []
  for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
  print(`  m6a2-seed222-mall-iron (own poles/routes on the footprint): ${job.phase} (${job.stats.searches} searches, ${job.stats.ripups} rip-ups)`)
  ok(job.phase === "done", `plan done (${why.join("; ")})`)
  ok((job.alias["n22"] ?? "") === "n16", `n22 completes the shared mine (alias: ${job.alias["n22"]})`)
  const mine = findModule(job.layout, "n16")
  ok(mine !== undefined && mine.minePlan !== undefined && mine.minePlan.complete === true, "the shared mine's plan is whole")
})

// B43 (review report 333968, faction 1 g15, tick 334080): the second steam block's coal route evicts the trunk pole line
// (B37) that the copper mine n18's line hangs off. The pole planner aimed only at n18's own pole, in the middle of the
// mine where every tile in reach is footprint or growth room: "power:n18: no pole path" on every attempt. It now aims at
// n18's whole pole component, the surviving line included.
replay("r333968-second-power")

// B45 (seed 222 after D54, goal g4 at tick 67170): the steam block's electric coal mine n6 went on the coal patch south
// of the labs; its whole-patch claim, its margin and the bootstrap's reservations walled in the labs' unconnected pack
// input lane, and every red-science production plan after it failed on "no path". Placement now keeps every open port
// lane leading out: here no whole-patch plan can (its output belt crosses the lane's only way out), so n6 stays a strip.
function sealedLanes(name: string, escape: number): string[] {
  const fx = load(name)
  fx.policy.placement.portEscape = escape
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  runJob(job, view, F, fx.policy, 100000)
  ok(job.phase === "done", `${name} plans (${job.phase})`)
  const l = job.layout
  // What a later plan sees: the layout's ground, plus every module's margin as own ground (factoryReserveTiles).
  const margin: Record<number, boolean> = {}
  for (const m of l.modules) for (const k of moduleMargin(m)) margin[k] = true
  const free = (x: number, y: number): boolean => {
    const b = view.block(x, y)
    if (b !== FREE && b !== TREE && b !== ROCK) return false
    const k = tkey(x, y)
    if (l.occ[k] !== undefined || l.routeOcc[k] !== undefined || l.reserved[k] !== undefined || l.mine?.[k] !== undefined) return false
    return !margin[k]
  }
  const sealed: string[] = []
  for (const a of openPortEnds(l, undefined)) if (!laneLeadsOut(a, free, 8)) sealed.push(`${a.x},${a.y}`)
  const n6 = findModule(l, "n6")
  print(`  ${name} escape ${escape}: n6 at ${n6?.rect.x},${n6?.rect.y} ${n6?.rect.w}x${n6?.rect.h}${n6?.minePlan !== undefined ? " whole-patch" : " strip"}, sealed ${sealed.join(" ")}`)
  return sealed
}

test("B45: the steam block's coal mine leaves the labs' pack input lane a way out", () => {
  const before = sealedLanes("r-d54-222-g4", 0)
  ok(before.indexOf("-43,493") >= 0, `without the rule the labs' lane end -43,493 is sealed (sealed: ${before.join(" ")})`)
  const after = sealedLanes("r-d54-222-g4", 8)
  ok(after.length === 0, `with it every open lane leads out (sealed: ${after.join(" ")})`)
})

// B51 (seed 3333, D55 resume, g19): the smelter n34's ore input was fed by a splitter tap on the relocated mine's route.
// Once the tap was gone, its lane was walled in (the coal route above, n33 and the pack route's underground on the
// approach row, its own margin below): two plans searched the whole region for 12 min each and failed "no path".
// `relocate` now relocates such a consumer too.
test("B51: a smelter input that lost its tap feed is sealed; an open input is not", () => {
  const fx = load("s3333-b51-sealed-lane")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  const sealed = sealedInputs(job.layout, view, "n34", {}, 8)
  ok(sealed.indexOf("in-ore") >= 0, `n34 in-ore sealed (${sealed.join(",")})`)
  const open: string[] = []
  for (const m of job.layout.modules) {
    if (m.id === "n34") continue
    for (const p of m.def.ports) if (p.kind === "belt-in" && sealedInputs(job.layout, view, m.id, {}, 8).indexOf(p.id) < 0) open.push(`${m.id}.${p.id}`)
  }
  print(`    [b51] open inputs: ${open.join(" ")}`)
  ok(open.length > 0, "other inputs lead out")
})

// B52 (seed 3333, D58 resume, g20): the far mine n40's ore route to the new smelter n41 ran north-south through the
// steam block n1's growth strip (its next units, west of it), right next to it: the block could never grow again. The
// router's soft-claim cost was 0.5 a tile; it is now high next to the module and lower for each farther unit. An
// underground pays only its two ends, so at 10 a tile with a 0.8 decay the route still crossed unit 1 (4 ends): the
// detour west and the other units' tiles cost more. 10 / 0.5 crosses unit 5 (sweep: decay <= 0.5 at 8-20, or 0.6 at 20+).
test("B52: a route keeps out of the steam block's nearest growth units", () => {
  const fx = load("s3333-b52-growth-strip")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  // The base was captured before B52: `cloneLayout` gives its soft claims their growth units.
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  // The capture's terrain covers the request region only; the shared mine n40 it completes is ~330 tiles out (planned
  // in game on real terrain): outside the window reads free.
  const view = fixtureView(fx)
  const terrain: TerrainView = { block: (x, y) => { const b = view.block(x, y); return b === UNKNOWN ? FREE : b }, ore: (x, y) => view.ore(x, y) }
  startTrace()
  runJob(job, terrain, F, fx.policy, 100000)
  finishReplay("s3333-b52-growth-strip", job, job.phase === "done")
  ok(job.phase === "done", `plan done (${job.phase})`)
  const n1 = findModule(job.layout, "n1")!
  const units = growthUnitRects(n1)
  const route = job.layout.routes["route:iron-ore>iron-plate*>logistic-science-pack>labs#3=>iron-plate*>logistic-science-pack>labs#3.in-ore"]
  ok(route !== undefined, "the ore route is planned")
  const hits = units.map(() => 0)
  for (const k of route.tiles) {
    const [x, y] = [keyX(k), keyY(k)]
    for (let i = 0; i < units.length; i++) {
      const r = units[i]
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        hits[i]++
        if (os.getenv("REPLAY_DUMP") !== undefined) print(`    [b52] unit ${i + 1}: ${x},${y} soft ${job.layout.soft?.[k] ?? "-"} unit ${job.layout.softUnit?.[k] ?? "-"}`)
      }
    }
  }
  if (os.getenv("REPLAY_MAP_B52") !== undefined) {
    const L = job.layout
    for (let y = -22; y <= 10; y++) {
      let row = ""
      for (let x = 405; x <= 505; x++) {
        const k = tkey(x, y)
        const tb = terrain.block(x, y)
        let c = "."
        if (route.tiles.indexOf(k) >= 0) c = "@"
        else if (L.routeOcc[k] !== undefined) c = L.routes[L.routeOcc[k]]?.fixed ? "=" : "-"
        else if (L.occ[k] !== undefined) c = string.sub(L.occ[k], 1, 2) === "m:" ? "M" : "x"
        else if (L.reserved[k] !== undefined) c = "r"
        else if (L.mine?.[k] !== undefined) c = "m"
        else if (tb !== FREE && tb !== TREE && tb !== ROCK) c = "#"
        else if (L.soft?.[k] === "n1") c = string.format("%x", (L.softUnit?.[k] ?? 0) % 16)
        else if (L.soft?.[k] !== undefined) c = "s"
        row += c
      }
      print(`    ${string.format("%4d", y)} ${row}`)
    }
  }
  print(`    [b52] soft ${fx.policy.router.softClaim} decay ${fx.policy.router.softClaimDecay}: ${route.tiles.length} route tiles; in n1's growth units 1..${units.length}: ${hits.join(" ")}`)
  ok(hits[0] === 0 && hits[1] === 0, `no route tile in the two nearest growth units (${hits.join(" ")})`)
})

// B57 (soak m6-accept-5b9550c, seed 555555 g12): the labs' green-science input (n2) sits in a pocket walled in by
// earlier plans; the seal check proves every route to it impossible. No plan can succeed: the factory relocates the
// labs (factory.ts `relocateSealed`) instead of failing every green plan.
replay("m6acc-555555-green-labs", { expect: "failed" })
// B57 (same soak, seed 11 g20): the green cluster's iron mine n36 faced its output into a 221-tile pocket (only one
// tile of clearance was checked). Its own lanes must now lead out, and the patch's only two positions don't: the mine
// finds no position on this patch (the game's next attempts widen the region, D57 skips the dead patch) instead of a
// plan that can never route.
replay("m6acc-11-green-iron", { expect: "failed" })
replay("m6acc-46464-green-copper", { expect: "failed" })

// B57 (seed 555555 g6, the plan that walled the labs' green input in): its red-science modules and routes closed the
// pocket west of the labs. A plan that walls in a base lane that led out is planned again with that lane kept clear.
test("B57: the red-science plan leaves the labs' unfed green input a way out", () => {
  const fx = load("m6acc-555555-g6-red")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  runJob(job, view, F, fx.policy, 100000)
  const guarded = (job.evidence ?? []).some((e) => string.find(e.reason, "B57", 1, true)[0] !== undefined)
  const sealed = sealedInputs(job.layout, view, "n2", { "in-automation-science-pack": true }, fx.policy.placement.portEscape ?? 0)
  print(`  m6acc-555555-g6-red: ${job.phase}, ${guarded ? "planned again with the lane kept clear" : "lanes never walled in"}; n2 sealed inputs: ${sealed.join(" ")}`)
  ok(job.phase === "done", `plan done (${job.phase})`)
  ok(sealed.length === 0, `the labs' green input leads out (sealed: ${sealed.join(" ")})`)
  let left = 0
  for (const [, r] of pairs(job.layout.reserved)) if (string.sub(r, 1, 5) === "lane:") left++
  ok(left === 0, `no lane reservation left in the adopted layout (${left})`)
})



// B58 (seed 1212121, goal g16): the n39 -> n37 coal feed is a splitter tap on the n39 -> n35 trunk. The tap search
// used a trunk tile, ripped the trunk, and committed the tap; the trunk then re-routed with an underground span under
// the splitter's input, so the branch stood with no belt to take from. A tap may not rip a route it could tap.
test("B58: a splitter tap never sits on the span of the route it taps", () => {
  const fx = load("b58-g16")
  const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
  const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
  const view = fixtureView(fx)
  runJob(job, view, F, fx.policy, 100000)
  ok(job.phase === "done", `plan done (${job.phase})`)
  const overlaps: string[] = []
  for (const id of job.layout.routeOrder) {
    const r = job.layout.routes[id]
    if (r.tapOf === undefined) continue
    const parent = job.layout.routes[r.tapOf]
    if (parent === undefined) continue
    for (const s of r.steps) {
      if (s.kind !== "splitter") continue
      for (const sp of parent.spans) {
        const horiz = string.sub(sp.line, 1, 1) === "h"
        const coord = tonumber(string.sub(sp.line, 2))
        if (coord === undefined) continue
        const along = horiz ? s.x : s.y
        const across = horiz ? s.y : s.x
        if (across === coord && sp.span.a <= along && along <= sp.span.b) {
          overlaps.push(`${id} splitter ${s.x},${s.y} on ${r.tapOf} ${sp.line} ${sp.span.a}..${sp.span.b}`)
        }
      }
    }
  }
  ok(overlaps.length === 0, `tap splitter on its trunk's span: ${overlaps.join("; ")}`)
})

// B60 (m6-b60n-provider, seed 8646103 g19): after a route-infeasible shared coal provider is split per consumer,
// each fresh provider must be placed where its one assigned consumer can actually be reached.
replay("m6-b60-provider-single-route", { newSites: ["n51", "n52"], expect: "failed", failureIncludes: "no free coal patch in the region" })

run("plan-replay")

