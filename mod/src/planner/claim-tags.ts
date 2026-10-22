// The string spelling of LayoutState's index claims, in one leaf module. layout.ts (the canonical writer) and
// claims.ts (the typed reader and owner checker) share these, so an add and its matching remove cannot drift apart.

import { layoutClaimTag } from "../shared/ids"
import type { LayoutClaimTag } from "../shared/ids"


/** A module's footprint tile: "m:<module id>". */
export function moduleTag(id: string): LayoutClaimTag {
  return layoutClaimTag(`m:${id}`)
}

/** A tile a module's entities interact with outside its footprint: "x:<module id>". */
export function interactionTag(id: string): LayoutClaimTag {
  return layoutClaimTag(`x:${id}`)
}

/** A pole line's pole occupies `occ` as "x:<line id>"; line ids start with "poles:". */
export function poleTag(line: string): LayoutClaimTag {
  return layoutClaimTag(`x:${line}`)
}

/** B37: an `occ` tag of a pole line's pole. Poles give way like trees. */
export function isPoleTag(o: string | undefined): boolean {
  return o !== undefined && string.sub(o, 1, 8) === "x:poles:"
}

export function isModuleTag(o: string | undefined): boolean {
  return o !== undefined && string.sub(o, 1, 2) === "m:"
}

/** A port outside tile: "p:<module>.<port>". */
export function portTag(module: string, port: string): LayoutClaimTag {
  return layoutClaimTag(`p:${module}.${port}`)
}

/** "p:<module>." — the reservation prefix that belongs to one module's ports (module ids may contain dots). */
export function portPrefix(module: string): string {
  return layoutClaimTag(`p:${module}.`)
}

/** Whether a reservation is one of `module`'s own port reservations. */
export function isOwnPortReservation(tag: string, module: string): boolean {
  const prefix = portPrefix(module)
  return string.sub(tag, 1, string.len(prefix)) === prefix
}

/** B57: a lane kept clear for one port: "lane:<port tag>". */
export function laneTag(port: string): LayoutClaimTag {
  return layoutClaimTag(`lane:${port}`)
}

export function isLaneReservation(tag: string | undefined): boolean {
  return tag !== undefined && string.sub(tag, 1, 5) === "lane:"
}
