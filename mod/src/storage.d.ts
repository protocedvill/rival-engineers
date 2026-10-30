import { PathfinderWaypoint } from "factorio:runtime"
import { ActionRecord, ControllerState } from "./character/types"
import { Config } from "./config"
import { CrewMember, FactionState } from "./jobs/types"

declare global {
  interface PathRequestState {
    status: "pending" | "found" | "failed"
    path?: PathfinderWaypoint[]
    tryAgainLater?: boolean
  }

  interface RivalEngineersStorage {
    /** Explicit save schema. Optional only so saves created before schema 1 can be adopted deterministically. */
    schemaVersion?: number
    pathRequests: Record<number, PathRequestState>
    configOverrides: Partial<Config>
    controllers: Record<number, ControllerState>
    /** Controller ids in creation order, for round-robin stepping. */
    controllerOrder: number[]
    /** Index into controllerOrder where the next tick's stepping starts. */
    schedulerCursor: number
    nextControllerId: number
    actions: Record<number, ActionRecord>
    nextActionId: number
    /** AI factions by name (SPEC §5.7), each with its own force, crew and Job Board. */
    factions: Record<string, FactionState>
    /** Faction names in creation order, for deterministic iteration. */
    factionOrder: string[]
    crew: Record<number, CrewMember>
    nextCrewId: number
    /** Set by on_init: create the configured factions on the first tick. */
    autoSpawnPending?: boolean
    /** The soak harness's done.json has been written. */
    allDoneWritten?: boolean
    /** Scratch space for factorio-test tests that must find their objects again after a reload. */
    testScratch?: Record<string, unknown>
  }

  const storage: RivalEngineersStorage
}
