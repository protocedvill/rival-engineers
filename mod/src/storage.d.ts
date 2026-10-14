import { PathfinderWaypoint } from "factorio:runtime"

declare global {
  interface PathRequestState {
    status: "pending" | "found" | "failed"
    path?: PathfinderWaypoint[]
    tryAgainLater?: boolean
  }

  interface RivalEngineersStorage {
    pathRequests: Record<number, PathRequestState>
  }

  const storage: RivalEngineersStorage
}
