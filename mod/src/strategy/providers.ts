// Provider groups (B60/B61 refactor): a shared item may have several producers and several consumers. The group
// preserves existing assignments, keeps every provider feeding what it can, and only sends the residual demand to a
// new provider / merged input / parallel stream. Pure: no Factorio globals.

export interface ProviderState {
  node: string
  role: string
  item: string
  capacity: number
  /** Known committed assignment, if any; the group preserves it across ticks. */
  assigned?: number
  expandable: boolean
  fixed?: boolean
}

export interface ConsumerObligation {
  module: string
  port: string
  item: string
  rate: number
  /** Lower wins when assigning scarce provider capacity. */
  priority: number
  /** Preferred provider role, preserved when possible. */
  provider?: string
}

export interface ProviderAssignment {
  provider: string
  role: string
  module: string
  port: string
  rate: number
}

export interface ProviderGroupPlan {
  assignments: ProviderAssignment[]
  /** Consumers that no current provider can satisfy. */
  residual: ConsumerObligation[]
  capacity: number
  used: number
}

function compareConsumers(a: ConsumerObligation, b: ConsumerObligation): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  if (a.module !== b.module) return a.module < b.module ? -1 : 1
  if (a.port !== b.port) return a.port < b.port ? -1 : 1
  return 0
}

/**
 * Assign whole consumer obligations to providers.
 *
 * A consumer is never partially assigned to two parallel providers: that needs a merge and is a separate route
 * decision. Existing `consumer.provider` preferences are honoured first; remaining capacity is allocated by priority
 * and stable identity. Anything left is the residual that needs another provider/merged input.
 */
export function assignProviders(providers: ProviderState[], consumers: ConsumerObligation[]): ProviderGroupPlan {
  const free: Record<string, number> = {}
  const byRole: Record<string, ProviderState> = {}
  let capacity = 0
  const ps: ProviderState[] = []
  for (const p of providers) ps.push(p)
  ps.sort(function(a, b) { return a.role < b.role ? -1 : a.role > b.role ? 1 : 0 })
  for (const p of ps) {
    byRole[p.role] = p
    free[p.role] = math.max(0, p.capacity - (p.assigned ?? 0))
    capacity += p.capacity
  }
  const assignments: ProviderAssignment[] = []
  const residual: ConsumerObligation[] = []
  const cs: ConsumerObligation[] = []
  for (const c of consumers) cs.push(c)
  cs.sort(function(a, b) { return compareConsumers(a, b) })
  const left: ConsumerObligation[] = []

  // Preserve explicit provider preferences first.
  for (const c of cs) {
    if (c.provider === undefined) {
      left.push(c)
      continue
    }
    const room = free[c.provider] ?? 0
    const p = byRole[c.provider]
    if (p === undefined || c.rate > room + 1e-9) {
      left.push(c)
      continue
    }
    free[p.role] = room - c.rate
    assignments.push({ provider: p.node, role: p.role, module: c.module, port: c.port, rate: c.rate })
  }

  // Fill the remaining capacity in priority order.
  for (const c of left) {
    let picked: ProviderState | undefined
    for (const p of ps) if ((free[p.role] ?? 0) + 1e-9 >= c.rate) {
      picked = p
      break
    }
    if (picked === undefined) {
      residual.push(c)
      continue
    }
    free[picked.role] = (free[picked.role] ?? 0) - c.rate
    assignments.push({ provider: picked.node, role: picked.role, module: c.module, port: c.port, rate: c.rate })
  }

  let used = 0
  for (const a of assignments) used += a.rate
  assignments.sort(function(a, b) { return a.role !== b.role ? (a.role < b.role ? -1 : 1) : a.module !== b.module ? (a.module < b.module ? -1 : 1) : a.port < b.port ? -1 : a.port > b.port ? 1 : 0 })
  return { assignments, residual, capacity, used }
}

/** Consumers that justify a new parallel provider, in stable order. */
export function residualDemand(plan: ProviderGroupPlan): number {
  let n = 0
  for (const c of plan.residual) n += c.rate
  return n
}
