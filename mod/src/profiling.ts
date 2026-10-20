import { LuaProfiler } from "factorio:runtime"

// Measurement only (no gameplay effect): when set, on_tick accumulates all AI time (brains, crew and
// controllers) into `total`. Kept in its own module so tick.ts and telemetry.ts don't require each other.

export let aiProfiler: { total: LuaProfiler; tick: LuaProfiler } | undefined

export function setAiProfiler(total: LuaProfiler | undefined): void {
  aiProfiler = total ? { total, tick: helpers.create_profiler(true) } : undefined
}

/** The on_tick subsystems timed one by one (soaks: `[re-profile]` lines, `tools/harness/soak.py` sums them). */
export const PROFILE_PARTS = ["brain", "factory", "factory-meter", "planner", "terrain", "crew", "controller", "telemetry", "review"]

/** Per-subsystem time since the last telemetry write, by `PROFILE_PARTS` index; undefined: not profiling. */
export let partProfilers: LuaProfiler[] | undefined

export function setPartProfilers(parts: LuaProfiler[] | undefined): void {
  partProfilers = parts
}
