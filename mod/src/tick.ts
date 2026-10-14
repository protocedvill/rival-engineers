import { onAutoSpawnTick } from "./autospawn"
import { onControllerTick } from "./character/controller"
import { onCrewTick } from "./jobs/crew"
import * as profiling from "./profiling"
import { onBrainTick } from "./strategy/bootstrap"
import { onTelemetryTick } from "./telemetry"

// The one on_tick handler: faction brains (strategy) first, then crew members (they react to actions that
// finished last tick and plan new ones), then the Character Controllers step their bodies.

export function onTick(): void {
  onAutoSpawnTick()
  const p = profiling.aiProfiler
  if (p) p.tick.reset()
  onBrainTick()
  onCrewTick()
  onControllerTick()
  if (p) {
    p.tick.stop()
    p.total.add(p.tick)
  }
  onTelemetryTick()
}
