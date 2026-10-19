import { spawnFaction } from "../autospawn"
import { clearConfigOverrides } from "../config"
import { destroyFaction } from "../jobs/faction"

// B30: B17's preemption (crew.ts `preemptForPriority`) dropped a member's batch for any ready, strictly
// higher-priority fuel/transfer job, even one the member could not take (a fuel job with no coal around). The
// re-plan picked the old work again and the next tick preempted again: on a fresh map every member livelocked
// (~3250 preemptions and 0–2 jobs done in the first 2 game-minutes of a seed-11 soak). This runs a real-terrain
// bootstrap from scratch and pins that preemptions stay rare and jobs get done.
//
// B31: preemptions were still ~15 per member and game-minute, 82% of them wasted (another member had claimed the
// job, or the re-plan deposited first). Only urgent jobs preempt now, one member each, and that member takes the job:
// preemptions stay at a handful per member and game-hour and nearly all of them lead to taking the job.

/** Game ticks the bootstrap runs before the check (3 game-minutes). */
const RUN_TICKS = 3 * 3600
/**
 * B31: preemptions per member and game-hour allowed (a handful: only burners about to stop, furnaces about to fill).
 * Before B31 every new refuel/feed/collect preempted (~9 per member and minute on seed 11); the B30 livelock ~1700.
 */
const MAX_PREEMPTIONS_PER_HOUR = 10
/** B31: fraction of preemptions whose member then claims the job it dropped its batch for (before B31: 18%). */
const MIN_TAKEN_RATIO = 0.75

describe("B30 preemption livelock", () => {
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })

  test("a fresh bootstrap on real terrain gets work done without preempting itself in a loop", () => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    const surface = game.create_surface("b30-preempt", { seed: 11, autoplace_controls: { "enemy-base": { frequency: 0, size: 0, richness: 0 } } } as never)
    const faction = spawnFaction("b30", { surface: surface.name })
    const start = game.tick
    const completions0 = faction.board.counters.completions
    async(RUN_TICKS + 600)
    on_tick(() => {
      if (game.tick - start < RUN_TICKS) return
      const minutes = (game.tick - start) / 3600
      const lines: string[] = []
      let worst = 0
      let total = 0
      let taken = 0
      let jobsDone = 0
      for (const id of faction.crew) {
        const m = storage.crew[id]
        const s = m.stats
        const pre = s.preemptions ?? 0
        worst = Math.max(worst, pre)
        total += pre
        taken += s.preemptTaken ?? 0
        jobsDone += s.jobsDone
        lines.push(`#${id}: ${pre} preemptions (${s.preemptTaken ?? 0} taken), ${s.batches} batches, ${s.plans} plans, ${s.jobsDone} jobs done`)
      }
      const c = faction.board.counters
      const msg = `${lines.join("; ")}; board claims ${c.claims}, releases ${c.releases}, completions ${c.completions - completions0}`
      log(`[b30] after ${minutes} min: ${msg}`)
      // At least one allowed: a single urgent refuel in the window is legitimate.
      const allowed = math.max(1, math.floor((MAX_PREEMPTIONS_PER_HOUR * minutes) / 60))
      assert(worst <= allowed, `preemptions per member must stay rare: ${worst} > ${allowed} (${msg})`)
      assert(taken >= MIN_TAKEN_RATIO * total, `preemptions must lead to taking the job: ${taken}/${total} (${msg})`)
      assert(c.completions - completions0 >= 20, `the crew must complete jobs (${msg})`)
      assert(jobsDone >= 20, `crew members must get jobs done (${msg})`)
      done()
    })
  })
})
