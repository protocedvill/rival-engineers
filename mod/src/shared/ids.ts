// Branded identifiers at subsystem boundaries. A brand exists only in TypeScript: the runtime value is still a plain
// string (or number), every save keeps its old shape, and Lua/Lua-side comparisons are unchanged.
//
// Rule: construct at the owner (the code that first makes the id) and pass the branded value along. Do not cast at
// use sites, and read old saves through the same constructor so the type never becomes a lie. Brands migrate one
// boundary at a time; `GoalId` covers the factory goal lifecycle, planning attempts, adoption record and diagnostics.
// Module, route, pole-line, job and claim brands are declared for the migrations that follow.

declare const goalIdBrand: unique symbol
declare const moduleIdBrand: unique symbol
declare const connectionIdBrand: unique symbol
declare const routeIdBrand: unique symbol
declare const poleIdBrand: unique symbol
declare const poleLineIdBrand: unique symbol
declare const jobIdBrand: unique symbol
declare const layoutClaimTagBrand: unique symbol
declare const worldClaimTagBrand: unique symbol

/** A factory goal id (`g1`, …). */
export type GoalId = string & { readonly [goalIdBrand]: true }
/** A module instance id; also a graph node id. */
export type ModuleId = string & { readonly [moduleIdBrand]: true }
/** A connection request id (an edge role). */
export type ConnectionId = string & { readonly [connectionIdBrand]: true }
/** A belt route id (`route:<conn>`, …). */
export type RouteId = string & { readonly [routeIdBrand]: true }
/** A planned pole entity id (unique in the layout). */
export type PoleId = string & { readonly [poleIdBrand]: true }
/** A pole line id (`poles:g1:0`, …). */
export type PoleLineId = string & { readonly [poleLineIdBrand]: true }
/** A Job Board job number. */
export type JobId = number & { readonly [jobIdBrand]: true }
/** A layout index tag (`m:`, `x:`, `p:`, `lane:`). */
export type LayoutClaimTag = string & { readonly [layoutClaimTagBrand]: true }
/** A world reservation tag (`site:`, `module:`, `route:`, `pole:`, `mine:`). */
export type WorldClaimTag = string & { readonly [worldClaimTagBrand]: true }

export function goalId(value: string): GoalId {
  return value as GoalId
}

export function moduleId(value: string): ModuleId {
  return value as ModuleId
}

export function connectionId(value: string): ConnectionId {
  return value as ConnectionId
}

export function routeId(value: string): RouteId {
  return value as RouteId
}

export function poleId(value: string): PoleId {
  return value as PoleId
}

export function poleLineId(value: string): PoleLineId {
  return value as PoleLineId
}

export function jobId(value: number): JobId {
  return value as JobId
}

export function layoutClaimTag(value: string): LayoutClaimTag {
  return value as LayoutClaimTag
}

export function worldClaimTag(value: string): WorldClaimTag {
  return value as WorldClaimTag
}
