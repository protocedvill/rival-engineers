// T1 replays of in-game plans that failed (soak regressions). A soak with frame dumps on writes each failed plan's
// input to script-output/rival-engineers/failed-plans/<faction>/<goal>-a<attempt>-t<tick>.input.lua (runtime.ts
// exportPlanInput); copy one into mod/unit/fixtures/ and list it below. Each replay runs the plan unbudgeted on the
// captured terrain and base layout and must succeed. (Plain Lua's `pairs` order is not Factorio's, so a replay is the
// same scenario, not a bit-exact rerun.)

import { BeltTier, beltTiers, tierByBelt } from "../src/planner/capacity"
import { FREE, TerrainView, UNKNOWN } from "../src/planner/grid"
import { LayoutState, ripRoute } from "../src/planner/layout"
import { CompareResult, logisticsFirst, newPlanJob, PlanRequest, runJob } from "../src/planner/plan"
import { EARLY_COMPACT, LayoutPolicy } from "../src/planner/policy"
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

function load(name: string): PlanInput {
  const chunk = loadfile(`../unit/fixtures/${name}.lua`)
  if (chunk === undefined) error(`fixture ${name} not found (run from mod/build-unit)`)
  return chunk() as PlanInput
}

interface ReplayOptions {
  /** Plan with the vanilla belt tiers' undergrounds (the capture had them restricted). */
  undergrounds?: boolean
}

function replay(name: string, opts: ReplayOptions = {}): void {
  test(`replay ${name}${opts.undergrounds ? " with undergrounds" : ""}`, () => {
    const fx = load(name)
    // Experiments: REPLAY_ROUTER="maxRipups=6,rip=10" overrides router weights of the captured policy.
    for (const [k, v] of string.gmatch(os.getenv("REPLAY_ROUTER") ?? "", "(%w+)=([%d.]+)")) (fx.policy.router as unknown as Record<string, number>)[k] = tonumber(v)!
    if (opts.undergrounds) fx.tiers = beltTiers(F)
    const ug = tonumber(os.getenv("REPLAY_UNDERGROUND") ?? "")
    if (ug !== undefined) fx.tiers = fx.tiers.map((t) => ({ ...t, maxUnderground: ug }))
    const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
    const job = newPlanJob(fx.request, tier, fx.base, fx.tiers)
    runJob(job, fixtureView(fx), F, fx.policy, 100000)
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
    print(`  ${name}: ${job.phase} (${job.stats.searches} searches, ${job.stats.ripups} rip-ups, ${job.stats.replacements} replacements)`)
    ok(job.phase === "done", `plan done (${why.join("; ")})`)
  })
}

// Seed 222, the stage-1 production cluster (7 modules, 7 flows) on top of power + labs, first attempt. Without
// undergrounds every attempt and every retried goal failed on routes boxing each other in (M5a acceptance re-run); the
// strategy now researches undergrounds after such a goal (FactoryState.needUndergrounds), and with them it plans
// without a single rip-up.
replay("seed222-production", { undergrounds: true })

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
    const fx = load(name)
    // Current weights for what the capture's policy lacked (REPLAY_NO_BUNDLE / REPLAY_NO_SOFT leave one out).
    fx.policy.router = { ...EARLY_COMPACT.router, ...fx.policy.router }
    fx.policy.placement = { ...EARLY_COMPACT.placement, ...fx.policy.placement }
    if (os.getenv("REPLAY_NO_BUNDLE") === undefined) fx.policy.router.bundleFactor = EARLY_COMPACT.router.bundleFactor
    else fx.policy.router.bundleFactor = 1
    if (os.getenv("REPLAY_NO_SOFT") === undefined) {
      fx.policy.router.softClaim = EARLY_COMPACT.router.softClaim
      fx.policy.placement.softClaim = os.getenv("REPLAY_SOFT_PLACE") !== undefined ? tonumber(os.getenv("REPLAY_SOFT_PLACE"))! : EARLY_COMPACT.placement.softClaim
      if (os.getenv("REPLAY_NO_SOFT_ROUTE") !== undefined) fx.policy.router.softClaim = 0
    } else {
      fx.policy.router.softClaim = 0
      fx.policy.placement.softClaim = 0
    }
    if (os.getenv("REPLAY_UG") !== undefined) fx.tiers = beltTiers(F)
    const tier = tierByBelt(fx.tiers, fx.belt) ?? fx.tiers[0]
    ok(tier.maxUnderground <= 1 || os.getenv("REPLAY_UG") !== undefined, "captured without undergrounds")
    const base = fx.base !== undefined && adopted ? stripPlan(fx.base, fx.request) : fx.base
    fx.request.compare = { undergrounds: { tiers: beltTiers(F) }, splitters: { items: multiProducerItems(fx) }, workFactor: 2, minWork: 5000 }
    const job = newPlanJob(fx.request, tier, base, fx.tiers)
    runJob(job, fixtureView(fx), F, fx.policy, 100000)
    const why: string[] = []
    for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
    ok(job.phase === "done", `plan done (${why.join("; ")})`)
    if (os.getenv("REPLAY_DUMP") !== undefined) {
      for (const m of job.layout.modules) print(`    module ${m.id} ${m.canonical.id} at ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h}`)
      if (job.layout.soft !== undefined) {
        const owners: Record<string, number> = {}
        for (const [, o] of pairs(job.layout.soft)) owners[o as string] = (owners[o as string] ?? 0) + 1
        for (const [o, n] of pairs(owners)) print(`    soft claim of ${o as string}: ${n as number} tiles`)
      }
    }
    const results: CompareResult[] = job.compare?.results ?? []
    const d = logisticsFirst(results, 50, 50)
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
// REPLAY_DUMP=1 prints the placements and soft claims.
compareReplay("seed11-production-ok", { undergrounds: true, splitters: true })
compareReplay("seed3333-production-ok", { undergrounds: true, splitters: false })

run("plan-replay")
