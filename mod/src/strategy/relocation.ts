import type { JobId } from "../shared/ids"

/**
 * D55/P36: a replacement goal must wait until the old module's clear jobs are off the board. Otherwise its plan starts
 * in the same think that scheduled the deconstruction, while the old footprint is still `OWN` in the terrain view: the
 * only free part of the patch is too small to place on and the goal burns its attempts within a few game-seconds.
 *
 * Returns the first role among `roles` whose clear jobs are still active (open or claimed).
 */
export function pendingRelocation(relocation: Record<string, JobId[]> | undefined, roles: string[], active: number[]): string | undefined {
  if (relocation === undefined) return undefined
  for (const role of roles) {
    const jobs = relocation[role]
    if (jobs === undefined) continue
    for (const id of jobs) if (active.indexOf(id) >= 0) return role
  }
  return undefined
}

/** Drops entries whose clear jobs are all done or failed; returns whether any remain. */
export function pruneRelocations(relocation: Record<string, JobId[]>, active: number[]): boolean {
  let left = 0
  for (const [role, jobs] of pairs(relocation)) {
    let busy = false
    for (const id of jobs as JobId[]) if (active.indexOf(id) >= 0) busy = true
    if (busy) left++
    else delete relocation[role as string]
  }
  return left > 0
}
