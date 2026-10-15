// Module geometry: entity footprints, tile occupancy and the placement transforms (rotation, mirroring).
// Pure: no Factorio globals.

import { ProtoFacts } from "./facts"
import { Dir, EAST, ModuleDef, ModuleEntity, Port, Rect, Vec, WEST } from "./types"

/** Tile size of an entity in its placed direction (east/west swap width and height). */
export function entitySize(e: ModuleEntity, facts: ProtoFacts): { w: number; h: number } {
  const f = facts.entity(e.name)
  const w = f?.tileW ?? 1
  const h = f?.tileH ?? 1
  if (e.dir === EAST || e.dir === WEST) return { w: h, h: w }
  return { w, h }
}

/** The tile-aligned box an entity covers (left/top inclusive, as tile coordinates). */
export function entityRect(e: ModuleEntity, facts: ProtoFacts): Rect {
  const { w, h } = entitySize(e, facts)
  return { x: Math.floor(e.x - w / 2 + 0.01), y: Math.floor(e.y - h / 2 + 0.01), w, h }
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Map of occupied tiles → index of the entity occupying it. Throws (error) on overlaps. */
export function occupancy(entities: ModuleEntity[], facts: ProtoFacts): Record<string, number> {
  const occ: Record<string, number> = {}
  for (let i = 0; i < entities.length; i++) {
    const r = entityRect(entities[i], facts)
    for (let x = r.x; x < r.x + r.w; x++) {
      for (let y = r.y; y < r.y + r.h; y++) {
        const k = tileKey(x, y)
        const other = occ[k]
        if (other !== undefined) {
          const a = entities[other]
          const b = entities[i]
          error(`entities overlap at ${k}: ${a.name}@${a.x},${a.y} and ${b.name}@${b.x},${b.y}`)
        }
        occ[k] = i
      }
    }
  }
  return occ
}

/** True when every entity lies inside the footprint. Returns the first offender's description otherwise. */
export function outsideFootprint(def: { footprint: { w: number; h: number }; entities: ModuleEntity[] }, facts: ProtoFacts): string | undefined {
  for (const e of def.entities) {
    const r = entityRect(e, facts)
    if (r.x < 0 || r.y < 0 || r.x + r.w > def.footprint.w || r.y + r.h > def.footprint.h) return `${e.name}@${e.x},${e.y}`
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Transforms. A transform is "mirror (x → W − x) first, then rotate `rot` quarter turns clockwise", applied in
// the module's frame: the result is again a module with its top-left corner at (0, 0).

export interface Transform {
  /** Quarter turns clockwise: 0..3. */
  rot: number
  /** Mirror across the vertical axis (east ↔ west) before rotating. */
  mirror: boolean
}

export const IDENTITY: Transform = { rot: 0, mirror: false }

export function transformDir(d: Dir, t: Transform): Dir {
  let out: number = d
  if (t.mirror && (out === EAST || out === WEST)) out = out === EAST ? WEST : EAST
  return (((out + 4 * t.rot) % 16) + 16) % 16 as Dir
}

/** Transforms a point (centre or corner) of a module with footprint w × h. */
export function transformPoint(p: Vec, w: number, h: number, t: Transform): Vec {
  let x = t.mirror ? w - p.x : p.x
  let y = p.y
  let cw = w
  let ch = h
  for (let i = 0; i < ((t.rot % 4) + 4) % 4; i++) {
    // Clockwise quarter turn of a cw × ch box: (x, y) → (ch − y, x); the box becomes ch × cw.
    const nx = ch - y
    const ny = x
    x = nx
    y = ny
    const tmp = cw
    cw = ch
    ch = tmp
  }
  return { x, y }
}

export function transformFootprint(w: number, h: number, t: Transform): { w: number; h: number } {
  return t.rot % 2 === 1 ? { w: h, h: w } : { w, h }
}

export function transformRect(r: Rect, w: number, h: number, t: Transform): Rect {
  const a = transformPoint({ x: r.x, y: r.y }, w, h, t)
  const b = transformPoint({ x: r.x + r.w, y: r.y + r.h }, w, h, t)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function transformEntity(e: ModuleEntity, w: number, h: number, t: Transform): ModuleEntity {
  const p = transformPoint(e, w, h, t)
  const out: ModuleEntity = { ...e, x: p.x, y: p.y }
  out.dir = transformDir(e.dir ?? 0, t)
  return out
}

export function transformPort(port: Port, w: number, h: number, t: Transform): Port {
  const p = transformPoint(port.pos, w, h, t)
  const out: Port = { ...port, pos: p, dir: transformDir(port.dir, t) }
  // Mirroring swaps belt lanes.
  if (t.mirror && port.side !== undefined) out.side = port.side === "left" ? "right" : "left"
  return out
}

/**
 * The module as placed with transform `t`, still in module-local coordinates (top-left at 0, 0). Rates, machines
 * and the rest are unchanged. `expand` is dropped: expand in the canonical frame first (`expandModule`), then
 * transform. Errors if `t` mirrors a non-mirrorable module or rotates a non-rotatable one.
 */
export function transformModule(def: ModuleDef, t: Transform): ModuleDef {
  if (t.mirror && !def.mirrorable) error(`module ${def.id} is not mirrorable`)
  if (t.rot % 4 !== 0 && !def.rotatable) error(`module ${def.id} is not rotatable`)
  const { w, h } = def.footprint
  const out: ModuleDef = {
    ...def,
    footprint: transformFootprint(w, h, t),
    entities: def.entities.map((e) => transformEntity(e, w, h, t)),
    ports: def.ports.map((p) => transformPort(p, w, h, t)),
    expand: undefined,
  }
  if (def.anchor) {
    out.anchor = {
      ...def.anchor,
      water: def.anchor.water?.map((r) => transformRect(r, w, h, t)),
      miningAreas: def.anchor.miningAreas?.map((r) => transformRect(r, w, h, t)),
    }
  }
  return out
}

/** Module-local → world: `origin` is the world tile coordinate of the module's top-left corner (integers). */
export function toWorld(origin: Vec, p: Vec): Vec {
  return { x: origin.x + p.x, y: origin.y + p.y }
}

/** The tile just outside a belt port where the router connects (upstream of belt-in, downstream of belt-out). */
export function portOutsideTile(port: Port): Vec {
  const v = dirVec(port.dir)
  const sign = port.kind === "belt-in" ? -1 : 1
  return { x: port.pos.x + sign * v.x, y: port.pos.y + sign * v.y }
}

function dirVec(d: Dir): Vec {
  if (d === 0) return { x: 0, y: -1 }
  if (d === 4) return { x: 1, y: 0 }
  if (d === 8) return { x: 0, y: 1 }
  return { x: -1, y: 0 }
}
