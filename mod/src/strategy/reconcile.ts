// The reconciler (SPEC §5.8, D26): compares measured rates and machine states with the plan, classifies every built
// node of the Factory Graph (ok / starved / backed-up / unpowered / unfuelled), walks to the **root cause** (upstream
// for a starved node, downstream for a backed-up one, to the power or fuel supply otherwise) and proposes **remedies**
// for the root cause, not the symptom. Pure: no Factorio globals (T1: mod/unit/reconcile.test.ts). Measurement
// (strategy/measure.ts) fills `node.measured` and the edges' `measuredRate`/`measuredFull`; the strategy layer
// (strategy/factory.ts) turns remedies into goals.
//
// Robustness (no oscillation):
// - D49: the reconciler runs from the start (as soon as the factory graph exists); nodes the crew supplies by design
//   (hand-fed labs before their pack is automated) are "expected": neutral, no root cause, no remedy;
// - only built nodes past a warm-up are classified; a node's status changes only after the new raw status held for
//   `confirm` evaluations in a row (hysteresis);
// - a remedy acts on a root cause at most `maxRemedies` times, `cooldownTicks` apart; only confirmed statuses lead to
//   remedies; edges are judged from a fresh flow probe (older than `probeMaxAge`: measure first, act later).

import { edgesFrom, edgesInto, LogicalEdge, LogicalGraph, LogicalNode, NodeStatus, rateIn, RootCause, StateShares } from "../planner/logical"

export interface ReconcileParams {
  /** Ticks after a node (and its direct feeders) was built before it is classified. */
  warmupTicks: number
  /** Evaluations a new raw status must hold before the node's status changes. */
  confirm: number
  /** Output below planned × (1 − shortfall) is a deficit. */
  shortfall: number
  /** A bad state (no power, no fuel) with at least this share marks the node even without a deficit. */
  badShare: number
  /** Below this active (non-idle) share a node has nothing to judge: ok (idle). Also the least share of a bad state
   * that can explain a deficit. */
  minActive: number
  /** A producer whose working share is at least this runs flat out (undersized if its consumer still starves). */
  busyShare: number
  /** A producer is undersized only when at least this share of what it makes arrives (else the belt is filling). */
  arrivedShare: number
  /** A belt edge measured at this fraction of its usable capacity is full (undersized for its demand). */
  edgeFull: number
  /** A port tile full in at least this share of probe samples has items piling up. */
  portFull: number
  /** Edge measurements older than this are stale: probe again before judging the edge. */
  probeMaxAge: number
  /** Remedies per root cause, and ticks between two of them. */
  maxRemedies: number
  cooldownTicks: number
}

export type RemedyKind = "grow" | "repair" | "upkeep" | "parallel"

export interface Remedy {
  /** Root-cause key: one remedy history per key. */
  key: string
  kind: RemedyKind
  /** grow / upkeep: the node; repair: the edge whose physical parts (route, pole lines) are re-placed. */
  node?: string
  edge?: string
  why: string
}

export interface RemedyRecord {
  count: number
  last: number
  kind: RemedyKind
  why: string
}

/** Per-faction reconciler state (persisted with the factory). */
export interface ReconcileState {
  evaluations: number
  /** Raw status waiting for confirmation, per node. */
  pending: Record<string, { status: NodeStatus; count: number }>
  remedies: Record<string, RemedyRecord>
  /** Latest remedies (newest last), for telemetry. */
  log: { tick: number; key: string; kind: RemedyKind; why: string; result?: string }[]
  /** Status changes so far, by new status. */
  changes: Record<string, number>
}

export function newReconcileState(): ReconcileState {
  return { evaluations: 0, pending: {}, remedies: {}, log: [], changes: {} }
}

export interface ReconcileInput {
  tick: number
  params: ReconcileParams
  /** Items that are fuel: an unfuelled node is traced along its fuel edges. */
  isFuel: (this: void, item: string) => boolean
  /**
   * D49: whether the crew supplies `item` to node `n` by design (hand-fed labs before the pack is automated). A node
   * short only of such items is "expected": not reported as a problem and never remedied.
   */
  crewSupplied?: (this: void, n: LogicalNode, item: string) => boolean
  /**
   * B98: whether node `n` is being handed over to a replacement (D67/D55 provider handover). A depleted outpost under
   * way to its replacement gets no deplete remedy: the handover is that remedy.
   */
  handingOver?: (this: void, n: LogicalNode) => boolean
}

export interface ReconcileResult {
  remedies: Remedy[]
  /** Edges to probe first (their verdict decides a root cause). */
  probe: string[]
}

const MAX_DEPTH = 8
const LOG_KEPT = 30

const EMPTY: StateShares = { working: 0, starved: 0, blocked: 0, unpowered: 0, unfuelled: 0, idle: 1 }

function shares(n: LogicalNode): StateShares {
  return n.measured?.states ?? EMPTY
}

/**
 * Ticks since the node and its direct feeders were all built; undefined while the node is not built (or being grown)
 * or a feeder was never built. A feeder being grown (e.g. the steam block gaining boilers) keeps running: its
 * consumers stay classified.
 */
function builtFor(g: LogicalGraph, n: LogicalNode, tick: number): number | undefined {
  if (n.lifecycle !== "built") return undefined
  let since = n.builtTick ?? n.createdTick
  for (const e of edgesInto(g, n.id)) {
    if (e.from === undefined) continue
    const p = g.nodes[e.from]
    if (p === undefined) continue
    if (p.builtTick === undefined) return undefined
    since = math.max(since, p.builtTick)
  }
  return tick - since
}

/** The raw status of a node from its last measurement (see the file comment), with a reason. */
export function classify(n: LogicalNode, p: ReconcileParams): { status: NodeStatus; why: string } {
  const m = n.measured
  if (m === undefined || m.states === undefined || (m.machines ?? 0) === 0) return { status: "unknown", why: "not measured" }
  const s = m.states
  const pct = (x: number): string => `${math.floor(x * 100 + 0.5)}%`
  if (n.kind === "power") {
    // B52: the shares are over boilers and engines together, and a boiler without fuel leaves its engines without steam
    // ("starved", like no water): with any boiler unfuelled, the engines it starves count toward the fuel shortage.
    if (s.unfuelled >= p.minActive && s.unfuelled + s.starved >= p.badShare) return { status: "unfuelled", why: `boilers without fuel ${pct(s.unfuelled)}, engines without steam ${pct(s.starved)}` }
    if (s.unfuelled >= p.badShare) return { status: "unfuelled", why: `boilers without fuel ${pct(s.unfuelled)}` }
    if (s.starved >= p.badShare) return { status: "starved", why: `boilers without water ${pct(s.starved)}` }
    return { status: "ok", why: `load ${pct(m.load ?? 0)}` }
  }
  const active = 1 - s.idle
  if (active < p.minActive) return { status: "ok", why: `idle ${pct(s.idle)}` }
  if (s.unpowered >= p.badShare) return { status: "unpowered", why: `no or low power ${pct(s.unpowered)}` }
  if (s.unfuelled >= p.badShare) return { status: "unfuelled", why: `no fuel ${pct(s.unfuelled)}` }
  // Machines starved behind their own inserters without power or fuel: the inserters are the cause.
  const ins = m.inserters
  if (ins !== undefined && s.working < 1 - p.shortfall) {
    if (ins.unpowered >= p.badShare) return { status: "unpowered", why: `inserters without power ${pct(ins.unpowered)}` }
    if (ins.unfuelled >= p.badShare) return { status: "unfuelled", why: `inserters without fuel ${pct(ins.unfuelled)}` }
  }
  // Sinks (the mall) run at a fraction of their capacity by design and stop when their chests are full.
  if (n.kind === "sink" || n.item === undefined) return { status: "ok", why: "sink" }
  const planned = rateIn(n.planned.outputs, n.item)
  const out = rateIn(m.outputs, n.item)
  const rate = `${string.format("%.3g", out)}/${string.format("%.3g", planned)}/s`
  if (planned <= 0 || out >= planned * (1 - p.shortfall)) return { status: "ok", why: rate }
  // Below plan: the state that took the most machine time decides.
  let best: NodeStatus = "ok"
  let bestShare = 0
  const cand: [NodeStatus, number][] = [["starved", s.starved], ["backed-up", s.blocked], ["unpowered", s.unpowered], ["unfuelled", s.unfuelled]]
  for (const [st, v] of cand) {
    if (v > bestShare) {
      best = st
      bestShare = v
    }
  }
  // A state below minActive is noise (a machine between two crafts), not a cause.
  if (best === "ok" || bestShare < p.minActive) return { status: "ok", why: `${rate}, below plan while working` }
  return { status: best, why: `${rate}, ${best} ${pct(bestShare)}` }
}

/**
 * D49: a starved node short only of items the crew supplies by design is "expected" (hand-fed labs before automated
 * science). The items it lacks come from measurement; when it can't tell, every planned input counts.
 */
export function expectedShortage(n: LogicalNode, raw: { status: NodeStatus; why: string }, crewSupplied: ReconcileInput["crewSupplied"]): { status: NodeStatus; why: string } {
  if (crewSupplied === undefined || raw.status !== "starved") return raw
  const items: string[] = []
  for (const [k, v] of pairs(n.measured?.missing ?? {})) if ((v as number) > 0) items.push(k as string)
  if (items.length === 0) for (const r of n.planned.inputs) items.push(r.item)
  if (items.length === 0) return raw
  items.sort()
  for (const item of items) if (!crewSupplied(n, item)) return raw
  return { status: "expected", why: `crew-supplied by design: ${items.join(", ")} (${raw.why})` }
}

/** What a belt edge's last flow probe says (see `trace`). */
export type EdgeVerdict = "stale" | "full" | "intake" | "broken" | "sparse"

export function edgeVerdict(e: LogicalEdge, tick: number, p: ReconcileParams): EdgeVerdict {
  if (e.measuredTick === undefined || e.measuredRate === undefined || tick - e.measuredTick > p.probeMaxAge) return "stale"
  const full = e.measuredFull ?? { from: 0, to: 0 }
  if (e.capacityRate !== undefined && e.capacityRate > 0 && e.measuredRate >= p.edgeFull * e.capacityRate) return "full"
  // Items wait at the consumer's port: the consumer takes them slower than the belt brings them.
  if (full.to >= p.portFull) return "intake"
  // Items pile up at the producer but don't arrive: the belt between is broken or blocked.
  if (full.from >= p.portFull) return "broken"
  return "sparse"
}

interface TraceCtx {
  g: LogicalGraph
  input: ReconcileInput
  remedies: Remedy[]
  probe: string[]
  seen: Record<string, boolean>
}

function remedy(t: TraceCtx, r: Remedy): void {
  for (const x of t.remedies) if (x.key === r.key) return
  t.remedies.push(r)
}

function wantProbe(t: TraceCtx, e: LogicalEdge): RootCause {
  if (t.probe.indexOf(e.id) < 0) t.probe.push(e.id)
  return { kind: "measuring", id: e.id, what: "probe", why: `measuring ${e.role}` }
}

function label(n: LogicalNode): string {
  return `${n.id} (${n.role})`
}

/**
 * B99: the node whose machines make `n`'s output: a node folded into a shared whole-patch mine (`alias`, D52/B78) has
 * none of its own and is never measured; that mine's status and output are its own.
 */
function physicalNode(g: LogicalGraph, n: LogicalNode): LogicalNode {
  return n.alias !== undefined ? (g.nodes[n.alias] ?? n) : n
}

/** The belts `prod`'s machines feed: its own and those of the nodes folded into it. */
function beltsFrom(g: LogicalGraph, prod: LogicalNode): LogicalEdge[] {
  const out = edgesFrom(g, prod.id)
  for (const id of g.nodeOrder) if (g.nodes[id].alias === prod.id) for (const e of edgesFrom(g, id)) out.push(e)
  return out
}

/** Whether any belt from `prod` carrying `item` is already at capacity (the group remedy owns that case). */
function anyFull(g: LogicalGraph, prod: LogicalNode, item: string, tick: number, p: ReconcileParams): boolean {
  for (const o of beltsFrom(g, prod)) {
    if (o.kind !== "belt" || o.item !== item || o.from === undefined) continue
    if (edgeVerdict(o, tick, p) === "full") return true
  }
  return false
}

/** A starved (or unfuelled) node: which of its inputs is short, and why. */
function traceInputs(t: TraceCtx, n: LogicalNode, items: string[], depth: number): RootCause {
  const p = t.input.params
  // B87: an item no edge carries (crew-supplied, or an intermediate made inside the module, like a red line's gears) is
  // the cause only when no belt input explains the shortage: trace the belt inputs first.
  let external: RootCause | undefined
  for (const item of items) {
    const edges = edgesInto(t.g, n.id).filter((e) => e.kind === "belt" && e.item === item)
    if (edges.length === 0) {
      external = external ?? { kind: "external", what: "no producer", why: `${label(n)} lacks ${item}, which no graph node produces (crew-supplied)` }
      continue
    }
    for (const e of edges) {
      if (e.from === undefined) return { kind: "external", what: "no producer", why: `${label(n)} lacks ${item}, supplied from outside the graph` }
      const own = t.g.nodes[e.from]
      if (own === undefined) continue
      const prod = physicalNode(t.g, own)
      if (prod.lifecycle !== "built") return { kind: "building", id: prod.id, what: "under construction", why: `${item} comes from ${label(prod)}, still being built` }
      const v = edgeVerdict(e, t.input.tick, p)
      if (v === "stale") return wantProbe(t, e)
      if (v === "full") {
        const why = `${e.role} carries ${fmt(e.measuredRate)}/s, its belt's capacity (${fmt(e.capacityRate)}/s): undersized for ${fmt(e.plannedRate)}/s planned`
        // B60 group remedy: a shared trunk is undersized as a group. Growing one producer would not widen the belt it
        // shares, so the group gets a parallel provider instead (the design keeps this one at its real capacity and
        // assigns the residual consumers to a parallel role with merge side-loads). A point-to-point belt is a
        // single-route sizing decision, which the planner's overflow choice owns; the reconciler stays out of it.
        let shared = 0
        for (const o of beltsFrom(t.g, prod)) if (o.kind === "belt" && o.item === item) shared++
        if (shared > 1) remedy(t, { key: `parallel:${prod.id}`, kind: "parallel", node: prod.id, why })
        return { kind: "edge", id: e.id, what: "at-capacity", why }
      }
      if (v === "intake") return { kind: "node", id: n.id, what: "intake-limited", why: `${item} waits at ${label(n)}'s port (${fmt(e.measuredRate)}/s arrive): the module takes it slower than planned` }
      if (v === "broken" || prod.status === "backed-up") {
        remedy(t, { key: `repair:${e.id}`, kind: "repair", edge: e.id, why: `${item} piles up at ${label(prod)} but ${fmt(e.measuredRate)}/s reach ${label(n)}` })
        return { kind: "edge", id: e.id, what: "broken", why: `${e.role}: items pile up at the producer and don't arrive (${fmt(e.measuredRate)}/s)` }
      }
      // The belt is sparse at both ends: the producer doesn't make enough.
      if (prod.status === "starved" || prod.status === "unfuelled" || prod.status === "unpowered") return trace(t, prod, depth + 1)
      // The producer makes more than arrives: the belt between is still filling (or losing items). Wait.
      const made = rateIn(prod.measured?.outputs ?? [], item)
      // B69 (soak vps-d66 seed 5387208): nothing at all arrives at a warmed-up starved consumer while the producer makes
      // the item. A filling belt brings some; this route lost a piece (its splitter tap was never built, 150 game-min).
      if (made > 0 && e.measuredRate === 0) {
        remedy(t, { key: `repair:${e.id}`, kind: "repair", edge: e.id, why: `${label(prod)} makes ${fmt(made)}/s of ${item} but none reaches ${label(n)}` })
        return { kind: "edge", id: e.id, what: "broken", why: `${e.role}: nothing arrives while ${label(prod)} makes ${fmt(made)}/s` }
      }
      // B96 (sweep 3e1c4d7 seed 1264816): a shared producer's other belts of this item carry the rest of its output;
      // only what they leave is this belt's to bring (0.3/s of 0.633 reached one of three consumers: "filling" for 300
      // game-min, no remedy).
      let others = 0
      for (const o of beltsFrom(t.g, prod)) if (o.id !== e.id && o.kind === "belt" && o.item === item) others += o.measuredRate ?? 0
      const forThis = math.max(0, made - others)
      if (forThis > 0 && (e.measuredRate ?? 0) < p.arrivedShare * forThis) {
        return { kind: "edge", id: e.id, what: "filling", why: `${label(prod)} makes ${fmt(made)}/s of ${item}, ${fmt(forThis)}/s of it for this belt, but ${fmt(e.measuredRate)}/s arrive: the belt is filling` }
      }
      if (shares(prod).working >= p.busyShare) {
        // Unless one of this producer's belts is already full: then the group remedy below covers it, and growing the
        // producer would not widen a belt that is at capacity.
        if (!anyFull(t.g, prod, item, t.input.tick, p)) remedy(t, { key: `grow:${prod.id}`, kind: "grow", node: prod.id, why: `${label(prod)} runs flat out (${fmt(rateIn(prod.measured?.outputs ?? [], prod.item ?? ""))}/s) and ${label(n)} still lacks ${item}` })
        return { kind: "node", id: prod.id, what: "undersized", why: `${label(prod)} runs flat out and ${label(n)} still lacks ${item}` }
      }
      return { kind: "node", id: prod.id, what: "below plan", why: `${label(prod)} delivers ${fmt(e.measuredRate)}/s of ${item} (${fmt(e.plannedRate)}/s planned) without being starved or blocked` }
    }
  }
  return external ?? { kind: "node", id: n.id, what: "unknown", why: `${label(n)}: no input found short` }
}

function fmt(x: number | undefined): string {
  return x === undefined ? "?" : string.format("%.3g", x)
}

/** Items a starved node lacks, most first (or every belt input when measurement could not tell). */
function missingItems(t: TraceCtx, n: LogicalNode): string[] {
  const out: string[] = []
  const miss = n.measured?.missing ?? {}
  const keys: string[] = []
  for (const [k] of pairs(miss)) keys.push(k as string)
  keys.sort((a, b) => (miss[a] !== miss[b] ? miss[b] - miss[a] : a < b ? -1 : 1))
  for (const k of keys) out.push(k)
  if (out.length === 0) for (const e of edgesInto(t.g, n.id)) if (e.kind === "belt" && out.indexOf(e.item) < 0) out.push(e.item)
  return out
}

/** The root cause of node `n`'s (confirmed) status. */
function trace(t: TraceCtx, n: LogicalNode, depth: number): RootCause {
  if (depth > MAX_DEPTH || t.seen[n.id]) return { kind: "node", id: n.id, what: n.status, why: `${label(n)}: ${n.status} (cycle or depth limit)` }
  t.seen[n.id] = true
  const p = t.input.params
  if (n.status === "starved") {
    const items = missingItems(t, n)
    if (items[0] === "depleted") {
      // D52/B21: a worked-out outpost expands in place over the rest of its patch (its growth area is already claimed);
      // D55: a whole-patch mine re-claims the next free part of its patch, and with none left it is relocated.
      if (t.input.handingOver?.(n) === true) return { kind: "node", id: n.id, what: "depleted", why: `${label(n)}: the ore under its drills is used up; its replacement is being connected (handover)` }
      if (n.kind === "outpost") remedy(t, { key: `deplete:${n.id}`, kind: "grow", node: n.id, why: `${label(n)}: the ore under its drills is used up; expand over the rest of the patch, else relocate` })
      return { kind: "node", id: n.id, what: "depleted", why: `${label(n)}: the ore under its drills is used up (D52/D55: expand or move within the patch, else relocate)` }
    }
    if (items[0] === "water") return { kind: "node", id: n.id, what: "no water", why: `${label(n)}: boilers without water` }
    return traceInputs(t, n, items, depth)
  }
  if (n.status === "unfuelled") {
    const fuels: string[] = []
    for (const e of edgesInto(t.g, n.id)) if (e.kind === "belt" && t.input.isFuel(e.item) && fuels.indexOf(e.item) < 0) fuels.push(e.item)
    if (fuels.length === 0) {
      remedy(t, { key: `upkeep:${n.id}`, kind: "upkeep", node: n.id, why: `${label(n)} has no fuel belt: the crew fuels it` })
      return { kind: "node", id: n.id, what: "crew fuel", why: `${label(n)} is fuelled by the crew and ran dry` }
    }
    return traceInputs(t, n, fuels, depth)
  }
  if (n.status === "unpowered") {
    const pe = edgesInto(t.g, n.id).filter((e) => e.kind === "power")[0]
    const pw = pe?.from !== undefined ? t.g.nodes[pe.from] : undefined
    if (pe === undefined || pw === undefined) return { kind: "node", id: n.id, what: "no power node", why: `${label(n)} has no power supply in the graph` }
    if (pw.lifecycle !== "built") return { kind: "building", id: pw.id, what: "under construction", why: `power ${label(pw)} is still being built` }
    if (pw.status === "unfuelled" || pw.status === "starved") return trace(t, pw, depth + 1)
    if ((pw.measured?.load ?? 0) >= p.busyShare) {
      remedy(t, { key: `grow:${pw.id}`, kind: "grow", node: pw.id, why: `power ${label(pw)} at ${math.floor((pw.measured?.load ?? 0) * 100)}% load while ${label(n)} lacks power` })
      return { kind: "node", id: pw.id, what: "undersized", why: `power ${label(pw)} runs at full load` }
    }
    remedy(t, { key: `repair:${pe.id}`, kind: "repair", edge: pe.id, why: `${label(n)} lacks power while ${label(pw)} has spare capacity: pole line broken?` })
    return { kind: "edge", id: pe.id, what: "not connected", why: `${label(n)} lacks power while ${label(pw)} has spare capacity` }
  }
  if (n.status === "backed-up") {
    const outs = beltsFrom(t.g, n).filter((e) => e.kind === "belt")
    if (outs.length === 0) return { kind: "demand", id: n.id, what: "no consumer", why: `${label(n)}: nothing in the graph takes its output` }
    for (const e of outs) {
      const c = t.g.nodes[e.to]
      if (c === undefined) continue
      if (c.lifecycle !== "built") return { kind: "building", id: c.id, what: "under construction", why: `consumer ${label(c)} is still being built` }
      const v = edgeVerdict(e, t.input.tick, p)
      if (v === "stale") return wantProbe(t, e)
      if (v === "broken") {
        remedy(t, { key: `repair:${e.id}`, kind: "repair", edge: e.id, why: `${e.item} piles up at ${label(n)} but ${fmt(e.measuredRate)}/s reach ${label(c)}` })
        return { kind: "edge", id: e.id, what: "broken", why: `${e.role}: items pile up at the producer and don't arrive` }
      }
      if (v === "full") return { kind: "edge", id: e.id, what: "at-capacity", why: `${e.role} at its belt's capacity (${fmt(e.capacityRate)}/s)` }
      if (c.status === "unpowered" || c.status === "unfuelled" || c.status === "starved" || c.status === "backed-up") return trace(t, c, depth + 1)
      if (v === "intake") return { kind: "node", id: c.id, what: "intake-limited", why: `${label(c)} takes ${e.item} slower than planned` }
    }
    return { kind: "demand", id: n.id, what: "low demand", why: `${label(n)}: its consumers take less than planned` }
  }
  return { kind: "node", id: n.id, what: n.status, why: n.statusReason ?? n.status }
}

/**
 * One evaluation: classifies every built node (with hysteresis), traces the root cause of each node that is not ok,
 * and returns the remedies that may act now (cooldowns and limits applied; the caller records them with `recordRemedy`).
 */
export function reconcile(g: LogicalGraph, st: ReconcileState, input: ReconcileInput): ReconcileResult {
  const p = input.params
  st.evaluations++
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    const age = builtFor(g, n, input.tick)
    if (age === undefined || age < p.warmupTicks) {
      delete st.pending[id]
      if (n.lifecycle !== "built" || n.status !== "unknown") {
        n.status = "unknown"
        n.statusReason = age === undefined ? "not built" : "warming up"
        n.cause = undefined
      }
      continue
    }
    const raw = expectedShortage(n, classify(n, p), input.crewSupplied)
    if (raw.status === n.status) {
      delete st.pending[id]
      n.statusReason = raw.why
      continue
    }
    const pend = st.pending[id]
    const count = pend !== undefined && pend.status === raw.status ? pend.count + 1 : 1
    // From unknown, the first classification counts at once; between known statuses it must hold.
    if (n.status === "unknown" || count >= p.confirm) {
      delete st.pending[id]
      n.status = raw.status
      n.statusReason = raw.why
      n.statusTick = input.tick
      st.changes[raw.status] = (st.changes[raw.status] ?? 0) + 1
    } else st.pending[id] = { status: raw.status, count }
  }
  const t: TraceCtx = { g, input, remedies: [], probe: [], seen: {} }
  for (const id of g.nodeOrder) {
    const n = g.nodes[id]
    if (n.status === "unknown" || n.status === "ok" || n.status === "expected") {
      n.cause = undefined
      continue
    }
    t.seen = {}
    n.cause = trace(t, n, 0)
  }
  const ready: Remedy[] = []
  for (const r of t.remedies) {
    const rec = st.remedies[r.key]
    if (rec !== undefined && (rec.count >= p.maxRemedies || input.tick - rec.last < p.cooldownTicks)) continue
    ready.push(r)
  }
  return { remedies: ready, probe: t.probe }
}

/** Records that a remedy acted (or was tried: `result` says what happened). */
export function recordRemedy(st: ReconcileState, r: Remedy, tick: number, result: string): void {
  const rec = st.remedies[r.key] ?? { count: 0, last: tick, kind: r.kind, why: r.why }
  rec.count++
  rec.last = tick
  rec.why = r.why
  st.remedies[r.key] = rec
  st.log.push({ tick, key: r.key, kind: r.kind, why: r.why, result })
  while (st.log.length > LOG_KEPT) st.log.shift()
}

/** Counts of node statuses (for telemetry and the scorecard). */
export function statusCounts(g: LogicalGraph): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id of g.nodeOrder) {
    const s = g.nodes[id].status
    out[s] = (out[s] ?? 0) + 1
  }
  return out
}
