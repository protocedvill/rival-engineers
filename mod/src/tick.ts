import { onAutoSpawnTick } from "./autospawn"
import { onControllerTick } from "./character/controller"
import { getConfig } from "./config"
import { onCrewTick } from "./jobs/crew"
import { onPlannerTick } from "./planner/runtime"
import { stepAllTerrains } from "./planner/terrain"
import * as profiling from "./profiling"
import { onReviewTick } from "./review/index"
import { onBrainTick } from "./strategy/bootstrap"
import { onFactoryMeterTick, onFactoryTick } from "./strategy/factory"
import { onTelemetryTick } from "./telemetry"

// The one on_tick handler: faction brains (strategy) first, then layout planning jobs (budgeted), then crew members (they react to actions that
// finished last tick and plan new ones), then the Character Controllers step their bodies.

export function onTick(): void {
  onAutoSpawnTick()
  const p = profiling.aiProfiler
  if (p) p.tick.reset()
  onBrainTick()
  onFactoryTick()
  onFactoryMeterTick()
  onPlannerTick()
  // M6a.2: removals between planner entries (a crew pick-up, a dropped ghost) mark chunks dirty; drain them here
  // (same budget as a planner entry's drain, terrain-chunks-per-tick) so a synchronous plan in between (a growth)
  // never reads ground that no longer stands.
  stepAllTerrains(getConfig().terrainChunksPerTick)
  onCrewTick()
  onControllerTick()
  if (p) {
    p.tick.stop()
    p.total.add(p.tick)
  }
  onTelemetryTick()
  onReviewTick()
}
