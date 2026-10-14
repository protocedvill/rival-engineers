import { onAutoSpawnTick } from "./autospawn"
import { onControllerTick } from "./character/controller"
import { onCrewTick } from "./jobs/crew"
import { onPlannerTick } from "./planner/runtime"
import * as profiling from "./profiling"
import { onBrainTick } from "./strategy/bootstrap"
import { onTelemetryTick } from "./telemetry"

// The one on_tick handler: faction brains (strategy) first, then layout planning jobs (budgeted), then crew members (they react to actions that
// finished last tick and plan new ones), then the Character Controllers step their bodies.

export function onTick(): void {
  onAutoSpawnTick()
  const p = profiling.aiProfiler
  if (p) p.tick.reset()
  onBrainTick()
  onPlannerTick()
  onCrewTick()
  onControllerTick()
  if (p) {
    p.tick.stop()
    p.total.add(p.tick)
  }
  onTelemetryTick()
}
