// M7d.5/B67: a planned electric-pole ghost whose place job was dropped or never made keeps the *layout's* power graph
// connected, so `unpoweredModules` says the module is powered and no power repair runs. The world is an island. Adopt
// those orphans: a ghost the live layout plans and no open job builds gets a place job again.

import { LuaSurface } from "factorio:runtime"
import { getJob } from "../jobs/board"
import { addPlaceJob } from "../jobs/faction"
import type { FactionState } from "../jobs/types"
import { prototypeFacts } from "../modules/prototype-facts"
import type { LayoutState, PlannedPole } from "../planner/layout"
import { destroyEntity } from "../planner/terrain"
import type { JobId } from "../shared/ids"
import { findEntities } from "../work"

/** Own pole ghosts the live layout plans, keyed name@tile. A module's own poles and the layout's line poles count. */
function plannedPoles(layout: LayoutState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const p of layout.poles ?? []) out[`${p.name}@${p.x},${p.y}`] = true
  for (const m of layout.modules) {
    for (const e of m.def.entities) {
      if (prototypeFacts.entity(e.name)?.type !== "electric-pole") continue
      out[`${e.name}@${math.floor(m.origin.x + e.x)},${math.floor(m.origin.y + e.y)}`] = true
    }
  }
  return out
}

/** Gives a place job back to every planned pole ghost without a live one. Returns how many were adopted. */
export function adoptPlannedPoles(surface: LuaSurface, faction: FactionState, layout: LayoutState, priority: number): number {
  const planned = plannedPoles(layout)
  let adopted = 0
  for (const gh of surface.find_entities_filtered({ type: "entity-ghost", force: faction.force })) {
    const proto = gh.ghost_prototype
    if (proto?.type !== "electric-pole" || gh.unit_number === undefined) continue
    const key = `${gh.ghost_name}@${math.floor(gh.position.x)},${math.floor(gh.position.y)}`
    if (planned[key] !== true) continue
    const old = faction.ghostJobs[gh.unit_number]
    if (old !== undefined) {
      const j = getJob(faction.board, old)
      if (j !== undefined && j.status !== "failed" && j.status !== "done") continue
      delete faction.ghostJobs[gh.unit_number]
    }
    if (addPlaceJob(faction, gh, { priority }) !== undefined) adopted++
  }
  return adopted
}

/**
 * B158: a pole dropped from a building goal's plan by B46 must leave the world too. The goal's ghost (and its place
 * job) was stamped before the drop; leaving it behind is an orphan: the layout no longer plans the pole, the build no
 * longer owns it, and nothing gives it a job. It then blocks the crew, reads as a leftover and is never rebuilt, while
 * the layout's power graph still counted it (consumers read "powered" and the world is an island).
 */
export function dropEvictedPoleGhosts(surface: LuaSurface, faction: FactionState, dropped: PlannedPole[], placeJobs?: JobId[]): number {
  let removed = 0
  for (const p of dropped) {
    for (const gh of findEntities(surface, { ghost_name: p.name, position: { x: p.x + 0.5, y: p.y + 0.5 }, force: faction.force, limit: 1 })) {
      const unit = gh.unit_number
      destroyEntity(gh)
      removed++
      if (unit === undefined) continue
      const job = faction.ghostJobs[unit]
      delete faction.ghostJobs[unit]
      if (job !== undefined && placeJobs !== undefined) {
        const i = placeJobs.indexOf(job)
        if (i >= 0) placeJobs.splice(i, 1)
      }
    }
  }
  return removed
}
