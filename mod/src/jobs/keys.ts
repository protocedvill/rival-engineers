// Keyed jobs: the brain and the factory remember which job serves a target (a tree, an ore tile, a lab...) by a
// key, so the same target is never queued twice. Pure: no Factorio globals.

/**
 * B82: how long a key whose job failed stays taken (game ticks). The board fails a job after its attempts are used up
 * (an unreachable target: no path); without this the next pass picked the same nearest target at once. vps-d68b
 * 1376111: gather jobs for one unreachable dead tree were queued again and again for ~200 game-min, and the walks kept
 * one crew member boxed in.
 */
export const FAILED_KEY_COOLDOWN_TICKS = 10 * 3600

export interface KeyedJobs {
  jobKeys: Record<string, number>
  /** Keys whose job failed, with the tick it failed (B82). */
  failedKeys?: Record<string, number>
}

/**
 * Whether `key` is taken: its job is open or claimed, or it failed less than `cooldown` ticks ago. A finished job's
 * key is released (and a failed one remembered, since the board prunes finished jobs soon after).
 */
export function keyTaken(k: KeyedJobs, jobs: Record<number, { status: string; finishedTick?: number } | undefined>, key: string, tick: number, cooldown = FAILED_KEY_COOLDOWN_TICKS): boolean {
  const id = k.jobKeys[key]
  if (id !== undefined) {
    const job = jobs[id]
    if (job !== undefined && (job.status === "open" || job.status === "claimed")) return true
    if (job !== undefined && job.status === "failed") {
      k.failedKeys ??= {}
      k.failedKeys[key] = job.finishedTick ?? tick
    }
    delete k.jobKeys[key]
  }
  const failed = k.failedKeys?.[key]
  if (failed === undefined) return false
  if (tick - failed < cooldown) return true
  delete k.failedKeys![key]
  return false
}

/** Forgets failed keys whose cooldown is over (keeps storage bounded). */
export function pruneFailedKeys(k: KeyedJobs, tick: number, cooldown = FAILED_KEY_COOLDOWN_TICKS): void {
  if (k.failedKeys === undefined) return
  for (const [key, at] of pairs(k.failedKeys)) if (tick - (at as number) >= cooldown) delete k.failedKeys[key as string]
}
