import { LuaProfiler } from "factorio:runtime"
import { onControllerTick } from "./character/controller"
import { onCrewTick } from "./jobs/crew"

// The one on_tick handler: crew members first (they react to actions that finished last tick and plan
// new ones), then the Character Controllers step their bodies.

let aiProfiler: { total: LuaProfiler; tick: LuaProfiler } | undefined

/** Measurement only: accumulate all AI on_tick time (crew + controllers) into `total`. No gameplay effect. */
export function setAiProfiler(total: LuaProfiler | undefined): void {
  aiProfiler = total ? { total, tick: helpers.create_profiler(true) } : undefined
}

export function onTick(): void {
  if (aiProfiler) aiProfiler.tick.reset()
  onCrewTick()
  onControllerTick()
  if (aiProfiler) {
    aiProfiler.tick.stop()
    aiProfiler.total.add(aiProfiler.tick)
  }
}
