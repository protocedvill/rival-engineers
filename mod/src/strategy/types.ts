import { LuaEntity, MapPosition } from "factorio:runtime"
import { Patch } from "../world/resources"
import type { JobId, WorldClaimTag } from "../shared/ids"

// Storage shapes of the strategy layer (SPEC §5.5). Plain tables only.

/**
 * A production site of the burner bootstrap:
 * - `smelt`: a burner drill on ore feeding a furnace at its output;
 * - `chest`: a burner drill feeding a chest (stone);
 * - `pair`: two burner drills on a fuel resource (coal) facing each other, each fuelling the other;
 * - `depot`: the faction's shared chest, where crew put everything they gather, collect and craft.
 */
export type SiteKind = "smelt" | "chest" | "pair" | "depot"

export interface SitePart {
  /** Entity and item names. */
  entity: string
  item: string
  position: MapPosition
  direction: defines.direction
  /** The place job filling this part's ghost. */
  job?: JobId
  /** The built entity, once placed. */
  built?: LuaEntity
  /** Whether the crew keeps it fuelled. */
  burner: boolean
}

export interface Site {
  id: number
  kind: SiteKind
  /** Resource entity name (sites other than depots). */
  resource?: string
  patch?: number
  parts: SitePart[]
  /** Tiles reserved for it (footprints plus a one-tile margin), as keys. */
  tiles: number[]
  /** `retired`: replaced after its ore ran low (D43); its entities are picked up. */
  status: "planned" | "built" | "failed" | "retired"
  createdTick: number
  builtTick?: number
  /** D43: its ore is running out and a replacement goal is open. */
  depleting?: boolean
}

export type Goal =
  /** Build one more site of this kind on this resource. */
  | { kind: "site"; site: SiteKind; resource?: string; siteId?: number; done?: boolean; doneTick?: number; replaces?: number }
  /** Hold these items (crafted into the depot). */
  | { kind: "items"; items: Record<string, number>; label: string; done?: boolean; doneTick?: number }

export interface StallEvent {
  tick: number
  /** Ticks since the last progress. */
  idleFor: number
  reason: string
  goal?: string
  recoveredTick?: number
}

/** Entities and items the bootstrap uses, read from prototypes (see strategy/catalog.ts). */
export interface Catalog {
  drill: string
  drillItem: string
  furnace: string
  furnaceItem: string
  chest: string
  chestItem: string
  /** The fuel the crew hands out (coal). */
  fuel: string
  /** Ore item → the plate it smelts into. */
  smelts: Record<string, string>
  /** Plate item → its ore. */
  oreOf: Record<string, string>
}

export interface BrainState {
  base: MapPosition
  /** B15: bootstrap sites evicted by the factory's plans so far. */
  evicted?: number
  /** Hub the depot sits at (between the chosen patches). */
  hub?: MapPosition
  catalog: Catalog
  patches: Patch[]
  /** Patches where placement failed; not used again until the next rescan. */
  badPatches: Record<number, boolean>
  sites: Site[]
  nextSiteId: number
  goals: Goal[]
  /** Tile keys reserved by sites (footprint and margin). */
  reserved: Record<number, boolean>
  /** Paired owner for `reserved` ("site:3", "module:n6", "route:...", "pole:...", "mine:..."). Absent in old saves. */
  reservedBy?: Record<number, WorldClaimTag>
  /** D46: tile keys of the ore fields this faction mines (bootstrap sites, mining modules); off limits to others. */
  oreFields?: Record<number, boolean>
  /** Dedupe: a maintenance key ("fuel:<unit>") → its active job id. */
  jobKeys: Record<string, number>
  /** B82: keys whose job failed, with the tick (jobs/keys.ts). */
  failedKeys?: Record<string, number>
  /** Milestone name → tick first reached. */
  milestones: Record<string, number>
  /** Stall detection: last tick the plan progressed, and the count of plan steps done by then. */
  progressTick: number
  progressSteps: number
  stalls: StallEvent[]
  replans: number
  /** Why the plan is waiting right now (for stall reports and telemetry). */
  waiting: string[]
  /** B38: the last think's shortfalls: item → demand, stock, pending and what `produce` did about it (telemetry). */
  shortfalls?: Record<string, { demand: number; stock: number; pending: number; action: string }>
  done: boolean
  doneTick?: number
  nextThink: number
  lastPrune: number
  /** Plan steps done so far (goal completions + plan crafts + placements). */
  steps: number
  /** Radius around the hub explored and scanned so far (grows when a needed resource is missing). */
  exploreRadius: number
  /** Rescan the explored area at this tick (chunk generation is asynchronous). */
  rescanAt?: number
  /** Why the spawn spot is a compromise, if it is. */
  spawnNote?: string
}
