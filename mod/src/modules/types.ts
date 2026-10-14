// Module library types (SPEC §5.4). Pure data: no Factorio globals, so T1 tests and the offline tools can use it.
//
// Coordinates are module-local tiles: (0, 0) is the top-left corner of the footprint, x grows east, y grows
// south. Entity and port positions are entity centres (a 1×1 entity on tile (3, 4) sits at (3.5, 4.5)).
// Every module is stored in its canonical ("north-facing") orientation. Rotation and mirroring are transforms
// applied at placement (`geometry.ts`) and never make separate modules.

/** Factorio 2.0 16-way direction values for the four cardinal directions. */
export type Dir = 0 | 4 | 8 | 12
export const NORTH: Dir = 0
export const EAST: Dir = 4
export const SOUTH: Dir = 8
export const WEST: Dir = 12

export interface Vec {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One entity of a module, normalised to the module's canonical orientation. */
export interface ModuleEntity {
  name: string
  /** Centre, module-local. */
  x: number
  y: number
  dir?: Dir
  /** Crafting machines: the recipe to set. Furnaces have no fixed recipe in-game; for them it is the intended smelting recipe. */
  recipe?: string
  /** Underground belts: which end. */
  ioType?: "input" | "output"
  /** Mining drills: the resource the module is built for (informational; the drill mines what is under it). */
  mines?: string
}

export type PortKind = "belt-in" | "belt-out" | "pipe-in" | "pipe-out" | "power" | "chest-out"

/**
 * Where the outside world attaches (SPEC §5.4, single-item per D23).
 *
 * - `belt-in`: `pos` is the module's first belt tile, on the footprint edge, and `dir` its flow direction. The router
 *   must deliver a belt into it from the tile at `pos - dirVector(dir)` (just outside the footprint), pointing `dir`.
 * - `belt-out`: `pos` is the module's last belt tile and `dir` its flow direction. Items leave onto the tile at
 *   `pos + dirVector(dir)` (just outside the footprint); the router starts a belt there.
 * - `power`: `pos` is a small electric pole inside the module that the planner's pole network connects to.
 * - `chest-out`: `pos` is a chest the crew empties (malls). No belt.
 * - `pipe-in`/`pipe-out`: reserved for fluid modules (none in v1: the steam block fuses its pump).
 */
export interface Port {
  /** Stable within a module (e.g. "in-ore", "out", "power"). */
  id: string
  kind: PortKind
  pos: Vec
  dir: Dir
  /** The single item this port carries (D23). Absent for power. */
  item?: string
  /** Which lane(s) a belt must arrive on, if it matters. Absent: any lane (the module's first tile is fed straight). */
  side?: "left" | "right"
}

export type RateKind = "item" | "power" | "research"

export interface Rate {
  /** Item name; "electricity" for power (perSecond in watts); "research-unit" for labs. */
  item: string
  perSecond: number
  kind?: RateKind
}

export interface ModuleRates {
  inputs: Rate[]
  outputs: Rate[]
}

export interface MachineCount {
  name: string
  count: number
}

/**
 * Terrain anchor for site-constrained modules (SPEC §5.3 Sites).
 * - shore: every tile of `water` (module-local, may lie outside the footprint) must be water; the footprint is land.
 * - resource-patch: `miningAreas` are the drill mining areas; the planner places the module so they cover ore of
 *   `resource` (the outpost's drills mine whatever is under them).
 */
export interface SiteAnchor {
  water?: Rect[]
  miningAreas?: Rect[]
  resource?: string
}

/**
 * Growth in place (SPEC §5.4 `ModuleDef.expand`, "promoted to generator").
 *
 * Semantics (`expandModule` in `expand.ts` implements them): to grow by k units along `axis`, every entity and
 * port whose coordinate on that axis is ≥ `insertAt` shifts by k × unit size; then k copies of `unit.entities`
 * (module-local to the unit, origin at the insertion line) are inserted at insertAt, insertAt + size, …
 * The footprint grows by k × unit size along the axis. Ports "shift" with the far end.
 */
export interface ModuleExpand {
  unit: { footprint: { w: number; h: number }; entities: ModuleEntity[] }
  axis: "x" | "y"
  /** Coordinate on `axis` where units are inserted. */
  insertAt: number
  /** Units that may be added on top of the base module (belt lane throughput, feeder capacity, …). */
  maxUnits: number
  perUnit: { rates: ModuleRates; machines: MachineCount[] }
  ports: "shift" | Port[]
}

export interface ModuleDef {
  id: string
  source: "curated" | "generated"
  /** Generator name for source = "generated" (e.g. "smelter-column"). */
  generator?: string
  /** Attribution: author, URL, licence for curated modules; the generator and parameters for generated ones. */
  provenance?: string
  description?: string
  footprint: { w: number; h: number }
  entities: ModuleEntity[]
  ports: Port[]
  /** Main recipe (the module's product), if any. */
  recipe?: string
  /** Every recipe run inside the module. */
  recipes: string[]
  machines: MachineCount[]
  /** Items/s at full speed, computed from prototypes (`rates.ts`), never hand-entered. */
  rates: ModuleRates
  /** Technologies that must be researched before the module can be built (from recipe unlocks). */
  requiresTech: string[]
  rotatable: boolean
  /** False when the layout depends on handedness (e.g. burner drills drop off-centre). */
  mirrorable: boolean
  site?: "shore" | "resource-patch"
  anchor?: SiteAnchor
  params?: Record<string, number | string>
  expand?: ModuleExpand
  /** Entities the crew must keep fuelled by hand (burners not fed from a port). Names → count. */
  upkeep?: { fuel: MachineCount[] }
  /** Free-form notes from normalisation (what was changed from the source). */
  notes?: string[]
}

/** The JSON shape in data/modules/*.json: a ModuleDef without computed fields. */
export interface CuratedModuleFile {
  id: string
  provenance: string
  description?: string
  footprint: { w: number; h: number }
  entities: ModuleEntity[]
  ports: Port[]
  recipe?: string
  rotatable?: boolean
  mirrorable?: boolean
  site?: "shore" | "resource-patch"
  anchor?: SiteAnchor
  params?: Record<string, number | string>
  /** Expansion as data: rates and machines per unit are computed. */
  expand?: { unit: ModuleExpand["unit"]; axis: "x" | "y"; insertAt: number; maxUnits: number }
  notes?: string[]
}

export function dirVector(dir: Dir): Vec {
  if (dir === NORTH) return { x: 0, y: -1 }
  if (dir === EAST) return { x: 1, y: 0 }
  if (dir === SOUTH) return { x: 0, y: 1 }
  return { x: -1, y: 0 }
}
