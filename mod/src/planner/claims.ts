// Typed views, conflict queries and the paired write helpers over LayoutState's existing spatial indexes. The indexes
// stay separate: this module gives them one ownership vocabulary without adding a second stored representation.

import { interactionTag, isLaneReservation, isOwnPortReservation, isPoleTag, moduleTag, poleTag } from "./claim-tags"
import { moduleId } from "../shared/ids"
import type { ModuleId, RouteId } from "../shared/ids"
import { keyX, keyY } from "./grid"
import type { LayoutState } from "./layout"

export type SpatialClaimKind =
  | "module"
  | "interaction"
  | "pole-line"
  | "port-reservation"
  | "lane-reservation"
  | "reservation"
  | "route"
  | "mine-growth"
  | "soft-growth"

export type SpatialClaimStrength = "hard" | "evictable" | "soft"

export interface SpatialClaim {
  kind: SpatialClaimKind
  owner: string
  strength: SpatialClaimStrength
  index: "occ" | "reserved" | "routeOcc" | "mine" | "soft"
}

export interface ClaimConflict {
  code: "occupied" | "reserved" | "routed" | "mine-claimed"
  claim: SpatialClaim
}

function occupancyClaim(tag: string): SpatialClaim {
  if (string.sub(tag, 1, 2) === "m:") return { kind: "module", owner: string.sub(tag, 3), strength: "hard", index: "occ" }
  if (isPoleTag(tag)) return { kind: "pole-line", owner: string.sub(tag, 3), strength: "evictable", index: "occ" }
  if (string.sub(tag, 1, 2) === "x:") return { kind: "interaction", owner: string.sub(tag, 3), strength: "hard", index: "occ" }
  return { kind: "interaction", owner: tag, strength: "hard", index: "occ" }
}

function reservationClaim(tag: string): SpatialClaim {
  if (isLaneReservation(tag)) return { kind: "lane-reservation", owner: string.sub(tag, 6), strength: "hard", index: "reserved" }
  if (string.sub(tag, 1, 2) === "p:") return { kind: "port-reservation", owner: tag, strength: "hard", index: "reserved" }
  return { kind: "reservation", owner: tag, strength: "hard", index: "reserved" }
}

function conflict(code: ClaimConflict["code"], claim: SpatialClaim): ClaimConflict {
  return { code, claim }
}

/** Every claim on a tile, in stable index order. Intended for diagnostics and tests, not router hot loops. */
export function claimsAt(state: LayoutState, key: number): SpatialClaim[] {
  const out: SpatialClaim[] = []
  const occ = state.occ[key]
  if (occ !== undefined) out.push(occupancyClaim(occ))
  const reserved = state.reserved[key]
  if (reserved !== undefined) out.push(reservationClaim(reserved))
  const route = state.routeOcc[key]
  if (route !== undefined) out.push({ kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  const mine = state.mine?.[key]
  if (mine !== undefined) out.push({ kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  const soft = state.soft?.[key]
  if (soft !== undefined) out.push({ kind: "soft-growth", owner: soft, strength: "soft", index: "soft" })
  return out
}

/** Claim rules for a belt route. Returns nothing on the common free/allowed path, avoiding diagnostic allocations. */
export function routeClaimConflict(state: LayoutState, key: number, ownReservations: Record<string, boolean>, fromModule: string | undefined, toModule: string, ripRoutes: boolean): ClaimConflict | undefined {
  const occ = state.occ[key]
  if (occ !== undefined && !isPoleTag(occ)) return conflict("occupied", occupancyClaim(occ))
  const reserved = state.reserved[key]
  if (reserved !== undefined && !ownReservations[reserved]) return conflict("reserved", reservationClaim(reserved))
  const mine = state.mine?.[key]
  if (mine !== undefined && mine !== fromModule && mine !== toModule) return conflict("mine-claimed", { kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  const route = state.routeOcc[key]
  if (route !== undefined && (!ripRoutes || state.routes[route]?.fixed)) {
    return conflict("routed", { kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  }
  return undefined
}

/** A pole may not share any indexed physical/reserved/mine ground. */
export function poleClaimConflict(state: LayoutState, key: number): ClaimConflict | undefined {
  const occ = state.occ[key]
  if (occ !== undefined) return conflict("occupied", occupancyClaim(occ))
  const reserved = state.reserved[key]
  if (reserved !== undefined) return conflict("reserved", reservationClaim(reserved))
  const route = state.routeOcc[key]
  if (route !== undefined) return conflict("routed", { kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  const mine = state.mine?.[key]
  if (mine !== undefined) return conflict("mine-claimed", { kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  return undefined
}

/** Placement/mine-search ground: poles give way, while another mine's growth claim is hard. */
export function placementClaimConflict(state: LayoutState, key: number, mineOwner?: string): ClaimConflict | undefined {
  const occ = state.occ[key]
  if (occ !== undefined && !isPoleTag(occ)) return conflict("occupied", occupancyClaim(occ))
  const reserved = state.reserved[key]
  if (reserved !== undefined) return conflict("reserved", reservationClaim(reserved))
  const route = state.routeOcc[key]
  if (route !== undefined) return conflict("routed", { kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  const mine = state.mine?.[key]
  if (mine !== undefined && mine !== mineOwner) return conflict("mine-claimed", { kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  return undefined
}

/** Port escape ground has placement rules but admits this port and its temporary protected lane. */
export function laneClaimConflict(state: LayoutState, key: number, portTag: string, protectedLaneTag: string): ClaimConflict | undefined {
  const occ = state.occ[key]
  if (occ !== undefined && !isPoleTag(occ)) return conflict("occupied", occupancyClaim(occ))
  const route = state.routeOcc[key]
  if (route !== undefined) return conflict("routed", { kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  const mine = state.mine?.[key]
  if (mine !== undefined) return conflict("mine-claimed", { kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  const reserved = state.reserved[key]
  if (reserved !== undefined && reserved !== portTag && reserved !== protectedLaneTag) return conflict("reserved", reservationClaim(reserved))
  return undefined
}

/**
 * New ground a module expands into (growth, or a whole-patch mine completing over its own claim). Its own footprint and
 * interaction tags, its pole lines and its own port reservations give way; every other claim is hard. Routes never do:
 * a growth re-marks the module and its routes are re-derived around it.
 */
export function moduleGrowthClaimConflict(state: LayoutState, key: number, moduleId: string): ClaimConflict | undefined {
  const occ = state.occ[key]
  if (occ !== undefined && occ !== moduleTag(moduleId) && occ !== interactionTag(moduleId) && !isPoleTag(occ)) return conflict("occupied", occupancyClaim(occ))
  const route = state.routeOcc[key]
  if (route !== undefined) return conflict("routed", { kind: "route", owner: route, strength: state.routes[route]?.fixed ? "hard" : "evictable", index: "routeOcc" })
  const mine = state.mine?.[key]
  if (mine !== undefined && mine !== moduleId) return conflict("mine-claimed", { kind: "mine-growth", owner: mine, strength: "hard", index: "mine" })
  const reserved = state.reserved[key]
  if (reserved !== undefined && !isOwnPortReservation(reserved, moduleId)) return conflict("reserved", reservationClaim(reserved))
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Paired write helpers. Layout mutation functions own the surrounding rules; these own the tag spelling and make every
// removal conditional on the caller still owning the claim, so a stale cleanup cannot free another owner's tile.

/** Adds a module footprint claim. Placement has already checked the ground; the index checker catches a stale tag. */
export function claimModuleTile(state: LayoutState, key: number, id: string): void {
  state.occ[key] = moduleTag(id)
}

/** Removes a footprint claim only while it still belongs to `id`. */
export function releaseModuleTile(state: LayoutState, key: number, id: string): boolean {
  if (state.occ[key] !== moduleTag(id)) return false
  delete state.occ[key]
  return true
}

/** Adds an interaction tile when nothing else occupies it. */
export function claimInteractionTile(state: LayoutState, key: number, id: string): boolean {
  if (state.occ[key] !== undefined) return false
  state.occ[key] = interactionTag(id)
  return true
}

export function releaseInteractionTile(state: LayoutState, key: number, id: string): boolean {
  if (state.occ[key] !== interactionTag(id)) return false
  delete state.occ[key]
  return true
}

/** Adds a pole line's pole claim. */
export function claimPoleTile(state: LayoutState, key: number, line: string): void {
  state.occ[key] = poleTag(line)
}

/** Removes a pole claim only while the tile still belongs to that line. */
export function releasePoleTile(state: LayoutState, key: number, line: string): boolean {
  if (state.occ[key] !== poleTag(line)) return false
  delete state.occ[key]
  return true
}

/** Records a reservation. The caller has already refused the tile if another owner holds it. */
export function reserveTile(state: LayoutState, key: number, tag: string): void {
  state.reserved[key] = tag
}

/** Records a reservation only while no other reservation holds the tile. */
export function reserveFreeTile(state: LayoutState, key: number, tag: string): boolean {
  if (state.reserved[key] !== undefined) return false
  state.reserved[key] = tag
  return true
}

/** Removes a reservation only while it still belongs to `tag`. */
export function releaseReservation(state: LayoutState, key: number, tag: string): boolean {
  if (state.reserved[key] !== tag) return false
  delete state.reserved[key]
  return true
}

/** B57: drops a plan's temporary lane reservation, leaving any later reservation on that tile alone. */
export function releaseLaneReservation(state: LayoutState, key: number): boolean {
  if (!isLaneReservation(state.reserved[key])) return false
  delete state.reserved[key]
  return true
}

/** Adds a route tile claim. The route's own search has already cleared the tile. */
export function claimRouteTile(state: LayoutState, key: number, id: RouteId): void {
  state.routeOcc[key] = id
}

export function releaseRouteTile(state: LayoutState, key: number, id: RouteId): boolean {
  if (state.routeOcc[key] !== id) return false
  delete state.routeOcc[key]
  return true
}

/** Adds a mining outpost's growth claim on free, unoccupied ground. */
export function claimMineTile(state: LayoutState, key: number, owner: string): boolean {
  state.mine ??= {}
  if (state.mine[key] !== undefined || state.occ[key] !== undefined) return false
  state.mine[key] = moduleId(owner)
  // The mine hard-claims this ground, so another module's soft growth claim on it is stale. Release it here; keeping
  // it would make the tile read as free to soft queries while the hard claim refuses every growth.
  const softState = state.soft
  const soft = softState?.[key]
  if (softState !== undefined && soft !== undefined && soft !== owner) {
    delete softState[key]
    if (state.softUnit !== undefined) delete state.softUnit[key]
  }
  return true
}

/** Removes every mine claim of one owner; returns how many tiles were released. */
export function releaseMineClaims(state: LayoutState, owner: string): number {
  if (state.mine === undefined) return 0
  let n = 0
  for (const [key, claimant] of pairs(state.mine)) {
    if (claimant !== owner) continue
    delete state.mine[key as number]
    n++
  }
  return n
}

/** Adds a soft growth claim and its growth unit on free, unoccupied ground. */
export function claimSoftTile(state: LayoutState, key: number, owner: string, unit: number): boolean {
  state.soft ??= {}
  if (state.soft[key] !== undefined || state.occ[key] !== undefined) return false
  // Another module's mine ground is hard: it may not gain a soft claim beside its own hard one.
  const mine = state.mine?.[key]
  if (mine !== undefined && mine !== owner) return false
  state.soft[key] = moduleId(owner)
  state.softUnit ??= {}
  state.softUnit[key] = unit
  return true
}

/** Removes every soft claim of one owner (and their units); returns how many tiles were released. */
export function releaseSoftClaims(state: LayoutState, owner: string): number {
  if (state.soft === undefined) return 0
  let n = 0
  for (const [key, claimant] of pairs(state.soft)) {
    if (claimant !== owner) continue
    delete state.soft[key as number]
    if (state.softUnit !== undefined) delete state.softUnit[key as number]
    n++
  }
  return n
}

function hasModule(state: LayoutState, id: ModuleId): boolean {
  for (const m of state.modules) if (m.id === id) return true
  return false
}

function hasPoleLine(state: LayoutState, id: string): boolean {
  for (const line of state.poleLines ?? []) if (line.id === id) return true
  return false
}

/** Resolves `p:<module>.<port>` without assuming module ids contain no dots. */
function reservationModule(state: LayoutState, tag: string): ModuleId | undefined {
  const raw = isLaneReservation(tag) ? string.sub(tag, 6) : tag
  if (string.sub(raw, 1, 2) !== "p:") return undefined
  for (const m of state.modules) if (isOwnPortReservation(raw, m.id)) return m.id
  return undefined
}

/** Ownership-side invariants that complement layout.ts's canonical-to-index checks. */
export function checkClaimOwners(state: LayoutState): string[] {
  const problems: string[] = []
  for (const [key, tag] of pairs(state.occ)) {
    const k = key as number
    const claim = occupancyClaim(tag as string)
    if (claim.kind === "module" && !hasModule(state, moduleId(claim.owner))) problems.push(`occ ${keyX(k)},${keyY(k)} names missing module ${claim.owner}`)
    else if (claim.kind === "interaction" && !hasModule(state, moduleId(claim.owner))) problems.push(`occ ${keyX(k)},${keyY(k)} names missing interaction owner ${claim.owner}`)
    else if (claim.kind === "pole-line" && !hasPoleLine(state, claim.owner)) problems.push(`occ ${keyX(k)},${keyY(k)} names missing pole line ${claim.owner}`)
  }
  for (const [key, tag] of pairs(state.reserved)) {
    const raw = tag as string
    if (string.sub(raw, 1, 2) !== "p:" && string.sub(raw, 1, 7) !== "lane:p:") continue
    if (reservationModule(state, raw) === undefined) problems.push(`reservation ${keyX(key as number)},${keyY(key as number)} names missing port owner ${raw}`)
  }
  for (const [key, owner] of pairs(state.mine ?? {})) {
    if (!hasModule(state, moduleId(owner as string))) problems.push(`mine claim ${keyX(key as number)},${keyY(key as number)} names missing module ${owner as string}`)
    // A mine claims its ground both hard (`mine`) and for its own growth (`soft`). Another module's soft claim left on
    // a mine tile is stale: growth cannot use it (the hard claim refuses) but it makes the tile look free to soft
    // queries, so report the disagreement instead of letting it accumulate.
    const soft = state.soft?.[key as number]
    if (soft !== undefined && soft !== owner) problems.push(`mine claim ${keyX(key as number)},${keyY(key as number)} owned by ${owner as string} is soft-claimed by ${soft as string}`)
  }
  for (const [key, owner] of pairs(state.soft ?? {})) if (!hasModule(state, moduleId(owner as string))) problems.push(`soft claim ${keyX(key as number)},${keyY(key as number)} names missing module ${owner as string}`)
  for (const [key] of pairs(state.softUnit ?? {})) if (state.soft?.[key as number] === undefined) problems.push(`soft unit ${keyX(key as number)},${keyY(key as number)} has no soft claim`)
  return problems
}
