# Rival Engineers

Factorio 2.0 mod: AI factions whose physical character crews build factories like players do.

**`docs/SPEC.md` is the source of truth.** Read it before starting work. §2 decisions are settled, §8 lists
the milestones, and §9 is the operating model (stacked PRs, `proto/*` branches, non-blocking questions).

## Working rules

- Work milestone by milestone on `mN-<slug>` branches, stacked on the previous milestone branch. One PR per
  milestone, with a report at `docs/reports/MN-report.md`.
- Throwaway experiments go on `proto/<topic>` branches. No PRs for them.
- Never touch the user's `~/.factorio` (saves, mods, blueprint storage) in place. Copy inputs into
  `tools/modules/input/` first. Test runs use the isolated install under `.factorio-test/` (git-ignored).
- Determinism rules in SPEC §5.6 are hard constraints. All persistent state goes in `storage`, use no
  `math.random`, and check `.valid` before using an entity.
- Prefer configurable settings over constants (SPEC §5.7).

## Commands

See `README.md` → Development. (Kept there so it stays next to the scripts it describes.)

## TSTL gotchas (learned the hard way)

- Closures created inside `for (let i ...)` loops all share **one** `i` after transpiling. Capture loop values
  by passing them to a helper function. Don't rely on JS per-iteration binding.
- `foo.test.ts` compiles to `foo_test.lua`. Register test files by their Lua name in `control.ts`.
- factorio-test `on_tick` handlers keep a test running until they return `false`. Use `everyTickFor` in
  `mod/src/test/lab.ts`.
- `if (x)` on a value typed as a non-nullable object (e.g. a `Record<number, T>` lookup) draws a TSTL truthiness
  warning. Declare it `T | undefined` and compare with `!== undefined`.
- `noImplicitSelf` does **not** cover inline arrow functions assigned to a property of a generic options object
  (e.g. `planBatch(..., { isFree: (p) => ... })`): TSTL compiled it with a `self` parameter and the call shifted
  every argument. Declare callback types as `(this: void, ...) => ...`.
- T1 unit tests (`mod/unit`) can only import modules that touch no Factorio globals (`game`, `defines`,
  `settings`...). Keep pure logic in such modules (e.g. `character/steering.ts`). Avoid `Math.atan2`: it becomes
  `math.atan2`, which Lua 5.3+ lacks.

## Factorio engine gotchas

- **`surface.request_path` paths straight through anything the requesting force could attack**: neutral trees and
  walls, other forces' buildings. Only own/allied entities and indestructible ones block. Always request character
  paths with `force: "neutral"` (see `character/pathing.ts`; pinned by an engine-capabilities test).
- A player-less character's `walking_state` persists until changed (unlike a player's, which lasts one tick).
  Stop walking and mining explicitly when an action ends.
- `can_reach_entity` uses the **short mining reach** (≈ `resource_reach_distance` 2.7 + the box) for trees and
  rocks, not `reach_distance` (10). Walks toward a tree/rock must aim inside that (`walk.ts` `pathRadiusFor`).
- **Script-creating an entity on top of a ghost removes the ghost.** In tests, place obstacles before ghosts.
  A character's death and corpse do not remove ghosts.
- `character.can_place_entity` ignores ghosts, so filling a ghost uses the normal player check followed by
  `ghost.revive{raise_revive=true}` (keeps the ghost's settings; raises `script_raised_revive`, not `_built`).
- A crew member's last action can succeed on the tick it dies. Read finished actions before handling death, or
  a placed entity's job gets released and its (revived, so invalid) ghost looks "removed".
- `LuaProfiler.restart()` resumes without resetting. Use `reset()` to time one interval. Profiler values can only be
  logged, not read.
- factorio-test `.after_reload_script` re-runs the test file, so its locals are gone after the reload. Stash what
  the test needs in `storage.testScratch`.
- factorio-test prints `log()` output only for failing tests. Read measurements from
  `.factorio-test/data/factorio-current.log`.
