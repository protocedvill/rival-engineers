import { spawnFaction } from "../autospawn"
import { clearConfigOverrides } from "../config"
import { destroyFaction } from "../jobs/faction"

// B30: B17's preemption (crew.ts `preemptForPriority`) dropped a member's batch for any ready, strictly
// higher-priority fuel/transfer job, even one the member could not take (a fuel job with no coal around). The
// re-plan picked the old work again and the next tick preempted again: on a fresh map every member livelocked
// (~3250 preemptions and 0–2 jobs done in the first 2 game-minutes of a seed-11 soak). This runs a real-terrain
// bootstrap from scratch and pins that preemptions stay rare and jobs get done.

/** Game ticks the bootstrap runs before the check (3 game-minutes). */
const RUN_TICKS = 3 * 3600
/**
 * Preemptions per member and game-minute allowed. Legitimate ones come one per newly created fuel/transfer job
 * (seed 11: ~9/min while furnace refuels appear every ~300 ticks); the livelock made ~1700/min.
 */
const MAX_PREEMPTIONS_PER_MINUTE = 15

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
      let jobsDone = 0
      for (const id of faction.crew) {
        const m = storage.crew[id]
        const s = m.stats
        const pre = s.preemptions ?? 0
        worst = Math.max(worst, pre)
        jobsDone += s.jobsDone
        lines.push(`#${id}: ${pre} preemptions, ${s.batches} batches, ${s.plans} plans, ${s.jobsDone} jobs done`)
      }
      const c = faction.board.counters
      const msg = `${lines.join("; ")}; board claims ${c.claims}, releases ${c.releases}, completions ${c.completions - completions0}`
      log(`[b30] after ${minutes} min: ${msg}`)
      assert(worst <= MAX_PREEMPTIONS_PER_MINUTE * minutes, `preemptions per member must stay rare (${msg})`)
      assert(c.completions - completions0 >= 20, `the crew must complete jobs (${msg})`)
      assert(jobsDone >= 20, `crew members must get jobs done (${msg})`)
      done()
    })
  })
})
