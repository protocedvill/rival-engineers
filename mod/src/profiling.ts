import { LuaProfiler } from "factorio:runtime"

// Measurement only (no gameplay effect): when set, on_tick accumulates all AI time (brains, crew and
// controllers) into `total`. Kept in its own module so tick.ts and telemetry.ts don't require each other.

export let aiProfiler: { total: LuaProfiler; tick: LuaProfiler } | undefined

export function setAiProfiler(total: LuaProfiler | undefined): void {
  aiProfiler = total ? { total, tick: helpers.create_profiler(true) } : undefined
}
