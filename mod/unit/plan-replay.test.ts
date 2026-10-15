// T1 replays of in-game plans that failed (soak regressions). A soak with frame dumps on writes each failed plan's
// input to script-output/rival-engineers/failed-plans/<faction>/<goal>-a<attempt>-t<tick>.input.lua (runtime.ts
// exportPlanInput); copy one into mod/unit/fixtures/ and list it below. Each replay runs the plan unbudgeted on the
// captured terrain and base layout and must succeed. (Plain Lua's `pairs` order is not Factorio's, so a replay is the
// same scenario, not a bit-exact rerun.)

import { BeltTier, beltTiers, tierByBelt } from "../src/planner/capacity"
import { FREE, TerrainView, UNKNOWN } from "../src/planner/grid"
import { LayoutState } from "../src/planner/layout"
import { newPlanJob, PlanRequest, runJob } from "../src/planner/plan"
import { LayoutPolicy } from "../src/planner/policy"
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

run("plan-replay")
