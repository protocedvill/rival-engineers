/**
 * PROTOTYPE (B65 phases 2-3): supply-aware chain growth as a pure model. **Not wired into the design yet.**
 *
 * The design currently sizes a producer when it creates it and attaches later consumers to its *nameplate* spare, so a
 * provider can end up carrying more edges than its input chain supplies (the B65 gap: a copper smelter planned
 * 0.183/s carrying 0.827/s for 270 game-min). This module is the shape of the fix, small enough to test without a game:
 *
 *  1. `requiredRates` — propagate every consumer's demand *up* its providers' inputs to a fixpoint, so each node's
 *     required output reflects all the demand above it (phase 2: size on final demand, not on creation demand).
 *  2. `depthOrder` — resolve deepest first (ore, then plates, then packs): a smelter's growth only makes sense once its
 *     ore can be supplied.
 *  3. `planGrowth` — for every node short of its required output, prefer growing the chain in place by expansion units,
 *     and fork a new module only when the chain cannot grow (no unit, ceiling reached, or the ground is not there).
 *
 * The intended wiring is one call per design pass: map `DesignNode` to `SupplyNode`, call these, and turn the
 * obligations into the `grow` goals `diffDesign` already emits (plus the parallel-provider path for `new`).
 */

/** A producer as the growth model needs it (a `DesignNode`/`LogicalNode` reduced to supply facts). */
export interface SupplyNode {
  role: string
  item: string
  /** What the plan sized it to deliver; its input chain is built for this. */
  planned: number
  /** Full-speed output. */
  capacity: number
  /** Output added per expansion unit (0: cannot grow in place). */
  unitRate: number
  /** How many units it may grow by. */
  maxUnits: number
  /** Inputs per unit of output. */
  inputs: { item: string; perOutput: number }[]
}

export interface SupplyEdge {
  from: string
  to: string
  item: string
  rate: number
}

export type Obligation =
  | { role: string; kind: "grow"; units: number; /** Output the units add. */ add: number }
  | { role: string; kind: "new"; rate: number }

export interface GrowthPolicy {
  /** Can this role grow in place (space, patch under the growth strip)? Default: `unitRate > 0`. */
  canGrow?: (this: void, role: string) => boolean
  /** Can a new module for this role's item be placed (patch/site)? Default: yes. */
  canPlace?: (this: void, role: string) => boolean
}

const EPS = 1e-6

/**
 * Every node's required output once its consumers' demand is propagated up its inputs.
 *
 * Starts from the edges' requested rates and walks consumers-first, raising a provider's requirement where the node it
 * feeds needs more of that item. Mutates each edge's `rate` to the required flow (callers pass a scratch array) and
 * assumes one provider per (node, item); parallel providers are different consumers, which the design already does.
 */
export function requiredRates(nodes: SupplyNode[], edges: SupplyEdge[]): Record<string, number> {
  const rate: Record<string, number> = {}
  const byRole: Record<string, SupplyNode> = {}
  const incoming: Record<string, SupplyEdge[]> = {}
  for (const n of nodes) byRole[n.role] = n
  for (const e of edges) {
    rate[e.from] = (rate[e.from] ?? 0) + e.rate
    let list = incoming[e.to]
    if (list === undefined) {
      list = []
      incoming[e.to] = list
    }
    list.push(e)
  }
  // Consumers first (the reverse of the provider-first order): a node's own requirement is final before its providers
  // are raised, so one pass over a DAG replaces the earlier fixpoint. That pass was O(passes x nodes x inputs x edges)
  // with a string key per inner iteration and cost one seed's factory subsystem 40x its previous time.
  const order = depthOrder(nodes, edges)
  for (let i = order.length - 1; i >= 0; i--) {
    const role = order[i]
    const n = byRole[role]
    const out = rate[role] ?? 0
    if (n === undefined || out <= EPS) continue
    const list = incoming[role]
    if (list === undefined) continue
    for (const e of list) {
      let per = 0
      for (const inp of n.inputs) if (inp.item === e.item) per += inp.perOutput
      if (per <= EPS) continue
      const want = out * per
      if (want <= e.rate + EPS) continue
      rate[e.from] = (rate[e.from] ?? 0) + (want - e.rate)
      e.rate = want
    }
  }
  return rate
}

/**
 * Roles deepest first: ore before plates before packs. A node with no inputs is depth 0; a node's depth is one more than
 * the deepest provider feeding it, so providers come before the consumers they feed. Deterministic (ties by role) so
 * the design stays reproducible.
 */
export function depthOrder(nodes: SupplyNode[], edges: SupplyEdge[]): string[] {
  const byRole: Record<string, SupplyNode> = {}
  for (const n of nodes) byRole[n.role] = n
  const depth: Record<string, number> = {}
  const visit = (role: string, seen: Record<string, boolean>): number => {
    const cached = depth[role]
    if (cached !== undefined) return cached
    if (seen[role] === true) return 0 // a cycle cannot happen in a recipe graph; stay total anyway
    seen[role] = true
    let d = 0
    for (const e of edges) {
      if (e.to !== role || byRole[e.from] === undefined) continue
      d = math.max(d, visit(e.from, seen) + 1)
    }
    depth[role] = d
    return d
  }
  const order: string[] = []
  for (const n of nodes) order.push(n.role)
  order.sort((a, b) => {
    const da = visit(a, {})
    const db = visit(b, {})
    if (da !== db) return da - db
    if (a < b) return -1
    return a > b ? 1 : 0
  })
  return order
}

export interface GrowthPlan {
  /** Deepest-first role order the decision was made in. */
  order: string[]
  /** Grow in place / fork a new module. */
  obligations: Obligation[]
  /** A link that can neither grow nor be replaced (patch exhausted, no site): the exhausted-failure input. */
  stuck: { role: string; item: string; short: number }[]
}

/**
 * Decide how to meet every node's required output, deepest first.
 *
 * Growth is preferred because it keeps the factory compact: same footprint, same routes, no new patch. It is taken only
 * while the chain can carry it: a node grows by whole expansion units up to `maxUnits`; the remainder (and the whole
 * shortfall when the node cannot grow) becomes a new module. A node whose *feed* is stuck is not grown — growing it
 * would only add demand to a chain that cannot supply it — and is reported as `stuck` instead.
 */
export function planGrowth(nodes: SupplyNode[], edges: SupplyEdge[], required: Record<string, number>, policy: GrowthPolicy = {}): GrowthPlan {
  const order = depthOrder(nodes, edges)
  const byRole: Record<string, SupplyNode> = {}
  for (const n of nodes) byRole[n.role] = n
  const canGrow = policy.canGrow ?? ((role: string): boolean => (byRole[role]?.unitRate ?? 0) > EPS)
  const canPlace = policy.canPlace ?? ((): boolean => true)
  const stuck: { role: string; item: string; short: number }[] = []
  const blocked: Record<string, boolean> = {}
  const obligations: Obligation[] = []
  for (const role of order) {
    const n = byRole[role]
    if (n === undefined) continue
    const need = required[role] ?? 0
    const short = need - n.planned
    if (short <= EPS) continue
    // A chain whose own supply is stuck cannot be helped by growing this node.
    let fed = true
    for (const i of n.inputs) {
      for (const e of edges) if (e.to === role && e.item === i.item && blocked[e.from] === true) fed = false
    }
    if (!fed) {
      obligations.push({ role, kind: "new", rate: short })
      blocked[role] = true
      continue
    }
    let left = short
    if (canGrow(role) && n.unitRate > EPS && n.maxUnits > 0) {
      const units = math.min(math.ceil(left / n.unitRate - EPS), n.maxUnits)
      if (units > 0) {
        const add = units * n.unitRate
        obligations.push({ role, kind: "grow", units, add })
        left -= add
      }
    }
    if (left <= EPS) continue
    if (canPlace(role)) obligations.push({ role, kind: "new", rate: left })
    else {
      stuck.push({ role, item: n.item, short: left })
      blocked[role] = true
    }
  }
  return { order, obligations, stuck }
}

/** Human-readable one-liner for a soak log or a design note. */
export function describeGrowth(plan: GrowthPlan): string {
  const parts: string[] = []
  for (const o of plan.obligations) {
    if (o.kind === "grow") parts.push(`grow ${o.role} +${string.format("%.3f", o.add)}/s (${o.units}u)`)
    else parts.push(`new ${o.role} +${string.format("%.3f", o.rate)}/s`)
  }
  for (const s of plan.stuck) parts.push(`stuck ${s.role} ${s.item} ${string.format("%.3f", s.short)}/s`)
  return parts.join("; ")
}
