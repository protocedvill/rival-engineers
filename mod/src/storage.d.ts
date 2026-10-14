import { PathfinderWaypoint } from "factorio:runtime"
import { ActionRecord, ControllerState } from "./character/types"
import { Config } from "./config"

declare global {
  interface PathRequestState {
    status: "pending" | "found" | "failed"
    path?: PathfinderWaypoint[]
    tryAgainLater?: boolean
  }

  interface RivalEngineersStorage {
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
    /** Scratch space for factorio-test tests that must find their objects again after a reload. */
    testScratch?: Record<string, unknown>
  }

  const storage: RivalEngineersStorage
}
