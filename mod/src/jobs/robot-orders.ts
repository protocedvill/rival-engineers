// M7d.5: removals go through Factorio's own deconstruction orders, as a player's deconstruction planner does: a clear
// job marks its target, construction robots in range take it down, and the crew does the rest. Orders are only issued
// once the faction has a roboport network (a marked machine stops working, and without robots nothing would come).

import { LuaEntity } from "factorio:runtime"
import { JobId } from "../shared/ids"
import { FactionState, JobPayload } from "./types"

/** Whether the faction has a roboport network on `surface`. */
export function hasNetwork(faction: FactionState, surface: string): boolean {
  const networks = game.forces[faction.force]?.logistic_networks[surface]
  return networks !== undefined && networks.some((n) => n.valid && n.cells.length > 0)
}

/** Marks a clear job's target for deconstruction (once) and remembers the order. Returns whether it is marked. */
export function orderRemoval(faction: FactionState, job: JobId, p: Extract<JobPayload, { kind: "clear" }>): boolean {
  if (p.robotOrdered === true) return true
  if (!p.target.valid) return false
  p.robotOrdered = p.target.to_be_deconstructed() || p.target.order_deconstruction(faction.force)
  if (p.robotOrdered) {
    faction.deconOrders ??= []
    faction.deconOrders.push({ job, target: p.target })
  }
  return p.robotOrdered
}

/**
 * Cancels the orders of clear jobs that ended (failed, or dropped by a replan) with their target still standing, so the
 * robots never remove what the plan kept; forgets the orders that are done.
 */
export function sweepOrders(faction: FactionState): void {
  const orders = faction.deconOrders
  if (orders === undefined || orders.length === 0) return
  const kept: { job: JobId; target: LuaEntity }[] = []
  const ended: LuaEntity[] = []
  for (const o of orders) {
    if (!o.target.valid) continue
    const job = faction.board.jobs[o.job]
    if (job !== undefined && (job.status === "open" || job.status === "claimed")) kept.push(o)
    else ended.push(o.target)
  }
  // A replan can drop a clear job and queue a new one for the same target: that one keeps the order.
  for (const e of ended) if (!kept.some((o) => o.target === e) && e.to_be_deconstructed()) e.cancel_deconstruction(faction.force)
  faction.deconOrders = kept
}
