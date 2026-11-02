// Pure boundary between a completed planner job and the runtime adapter that adopts it.

import { BuildParts, EntitySpec, partEntities, partTiles } from "./build-list"
import { checkClaimOwners } from "./claims"
import { checkLayoutIndexes, layoutRevision } from "./layout"
import type { LayoutState } from "./layout"
import type { ModuleId, PoleId, RouteId } from "../shared/ids"

/** The planner fields needed to prepare adoption. Kept narrow so fixtures need not construct a whole running job. */
export interface PlanDeltaInput {
  sourceRevision?: number
  layout: LayoutState
  baseModules: Record<string, boolean>
  baseRoutes: Record<string, boolean>
  /** Pole ids recorded by the pole job as additions. */
  addedPoles?: PoleId[]
  /** Request id → placed module id, from the plan's expansion decisions (B23 mine completion). */
  expanded?: Record<string, { module: string; units: number }>
}

/** Logical consequences of the candidate, derived once before the adapter creates any Factorio work. */
export interface PlanLogicalDelta {
  /** Connection role → its candidate routes in `routeOrder`, a tap's base route first. The adapter's belt edges. */
  routesByConn: Record<string, RouteId[]>
  /** Candidate pole lines in order, so a power edge need not re-read the layout. */
  poleLines: { id: string; to: string; from: string }[]
}

/** Typed claim consequences of the candidate, so the adapter reserves exactly what the plan takes. */
export interface PlanClaimDelta {
  /** Ground the candidate takes: new part tiles plus whole-patch mine claims, deduped in partTiles order. */
  takenTiles: number[]
  /** Added modules with a whole-patch mine plan: the module id and its claim tiles, in `add.modules` order. */
  mineClaims: { module: ModuleId; tiles: number[] }[]
}

/** A built module whose whole-patch mine the plan completed: the entities the adapter must add. */
export interface PlanMineCompletion {
  module: ModuleId
  /** The completed mine's entities, in candidate part order. */
  entities: EntitySpec[]
}

export interface PlanDelta {
  /** Missing only for a planner job restored from before layout revisions existed. */
  baseRevision?: number
  candidateRevision: number
  /** Validated candidate layout. The runtime swaps this in before applying its Factorio-facing effects. */
  layout: LayoutState
  /** New physical parts the build adapter must create. */
  add: BuildParts
  /** Base parts absent from the candidate. Primarily evidence until removal effects migrate into this boundary. */
  remove: BuildParts
  /** Derived logical evidence: routes per connection and the candidate's pole lines. */
  logical: PlanLogicalDelta
  /** Derived claim evidence: the ground the candidate takes and the new mines' claims. */
  claims: PlanClaimDelta
  /** Built modules whose whole-patch mine the candidate completes, in candidate module order. */
  mineCompletions: PlanMineCompletion[]
}

/** Stable rejection codes: host tools match these; `detail`/`problems` carry the human explanation. */
export type PlanDeltaRejectionCode = "stale-base-revision" | "invalid-layout-indexes" | "invalid-layout-claims"

export type PlanDeltaRejection =
  | { status: "rejected"; code: "stale-base-revision"; sourceRevision: number; currentRevision: number; detail: string }
  | { status: "rejected"; code: "invalid-layout-indexes"; problems: string[]; detail: string }
  | { status: "rejected"; code: "invalid-layout-claims"; problems: string[]; detail: string }

export type PreparePlanDeltaResult = { status: "ready"; delta: PlanDelta } | PlanDeltaRejection

/**
 * Validates a completed planner result and derives its physical diff before persistent state changes. Ordering follows
 * the layouts' canonical arrays, so saves and diagnostics are deterministic. Old jobs without a source revision keep
 * their legacy adoption behaviour, but still receive structural validation.
 */
export function preparePlanDelta(input: PlanDeltaInput, current: LayoutState): PreparePlanDeltaResult {
  const currentRevision = layoutRevision(current)
  if (input.sourceRevision !== undefined && input.sourceRevision !== currentRevision) {
    return {
      status: "rejected",
      code: "stale-base-revision",
      sourceRevision: input.sourceRevision,
      currentRevision,
      detail: `layout revision ${input.sourceRevision} -> ${currentRevision}`,
    }
  }

  const indexes = checkLayoutIndexes(input.layout)
  if (indexes.problems.length > 0) {
    return { status: "rejected", code: "invalid-layout-indexes", problems: indexes.problems, detail: indexes.problems.join("; ") }
  }
  const claimProblems = checkClaimOwners(input.layout)
  if (claimProblems.length > 0) return { status: "rejected", code: "invalid-layout-claims", problems: claimProblems, detail: claimProblems.join("; ") }

  const addModules: ModuleId[] = []
  for (const m of input.layout.modules) if (!input.baseModules[m.id]) addModules.push(m.id)
  const addRoutes: RouteId[] = []
  for (const id of input.layout.routeOrder) if (!input.baseRoutes[id]) addRoutes.push(id)

  const candidatePoles: Record<string, boolean> = {}
  for (const p of input.layout.poles ?? []) candidatePoles[p.id] = true
  const addPoles: PoleId[] = []
  for (const id of input.addedPoles ?? []) if (candidatePoles[id]) addPoles.push(id)
  // M7c.8: poles the pole job did not add but the plan did: a fluid route's pump poles (`pipeStep`, `pumpPoleLine`).
  // Left out, no pump of a long crude line was ever built a pole, and the line carried nothing (seed 11).
  const currentPoles: Record<string, boolean> = {}
  for (const p of current.poles ?? []) currentPoles[p.id] = true
  const listed: Record<string, boolean> = {}
  for (const id of addPoles) listed[id] = true
  for (const p of input.layout.poles ?? []) if (!currentPoles[p.id] && !listed[p.id] && string.sub(p.line, 1, 5) === "pump:") addPoles.push(p.id)

  const removeModules: ModuleId[] = []
  for (const m of current.modules) if (input.layout.modules.every((candidate) => candidate.id !== m.id)) removeModules.push(m.id)
  const removeRoutes: RouteId[] = []
  for (const id of current.routeOrder) if (input.layout.routes[id] === undefined) removeRoutes.push(id)
  const removePoles: PoleId[] = []
  for (const p of current.poles ?? []) if (!candidatePoles[p.id]) removePoles.push(p.id)

  const add: BuildParts = { modules: addModules, routes: addRoutes, poles: addPoles }
  const addSet: Record<string, boolean> = {}
  for (const id of addModules) addSet[id] = true

  // Logical evidence, in candidate order (deterministic across saves). A tap's base route is listed before the tap.
  const routesByConn: Record<string, RouteId[]> = {}
  for (const id of input.layout.routeOrder) {
    const route = input.layout.routes[id]
    let list = routesByConn[route.conn]
    if (list === undefined) {
      list = []
      routesByConn[route.conn] = list
    }
    if (route.tapOf !== undefined) list.push(route.tapOf)
    list.push(id)
  }
  const poleLines: { id: string; to: string; from: string }[] = []
  for (const line of input.layout.poleLines ?? []) poleLines.push({ id: line.id, to: line.to, from: line.from })

  // Claim evidence: exactly the ground the adapter reserves (B15/B23: new parts, plus a whole-patch mine's claim).
  const takenTiles = partTiles(input.layout, add)
  const takenSeen: Record<number, boolean> = {}
  for (const k of takenTiles) takenSeen[k] = true
  const mineClaims: { module: ModuleId; tiles: number[] }[] = []
  for (const m of input.layout.modules) {
    if (!addSet[m.id] || m.minePlan === undefined) continue
    const tiles = [...m.minePlan.claim]
    mineClaims.push({ module: m.id, tiles })
    for (const k of tiles) {
      if (takenSeen[k]) continue
      takenSeen[k] = true
      takenTiles.push(k)
    }
  }

  // B23: a request that completed a built whole-patch mine adds entities outside the physical diff. Derive them here,
  // in candidate module order, so the adapter neither re-reads the layout nor iterates `expanded` in table order.
  const expandedBase: Record<string, boolean> = {}
  for (const [, ex] of pairs(input.expanded ?? {})) if (input.baseModules[ex.module]) expandedBase[ex.module] = true
  const mineCompletions: PlanMineCompletion[] = []
  for (const m of input.layout.modules) {
    if (!expandedBase[m.id] || m.minePlan === undefined || !m.minePlan.complete) continue
    mineCompletions.push({ module: m.id, entities: partEntities(input.layout, { modules: [m.id], routes: [], poles: [] }) })
  }

  return {
    status: "ready",
    delta: {
      baseRevision: input.sourceRevision,
      candidateRevision: layoutRevision(input.layout),
      layout: input.layout,
      add,
      remove: { modules: removeModules, routes: removeRoutes, poles: removePoles },
      logical: { routesByConn, poleLines },
      claims: { takenTiles, mineClaims },
      mineCompletions,
    },
  }
}
