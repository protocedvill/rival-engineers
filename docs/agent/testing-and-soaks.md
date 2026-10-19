# Testing without burning an hour or believing the wrong result

Read this before changing a test, diagnosing a shard, launching Factorio, using a snapshot, or quoting performance.
Factorio tests are not ordinary Jest tests: filters are Lua patterns, shards are separate games, logs are conditional,
and builds can be stale.

## Cheapest valid ladder

1. `npm run typecheck` catches TS and TSTL constraints without launching Factorio.
2. `npm run test:unit -- <file-fragment>` runs T1 pure logic under Lua.
3. `npm test -- "exact Lua pattern"` builds and runs the smallest T2 engine test.
4. Replay a captured planner or runtime fixture.
5. Resume a snapshot for a late engine failure.
6. Run the relevant full suite and acceptance soak only after the targeted regression passes.

Run `npm run doctor` first. `npx factorio-test run` does **not** rebuild; use `npm test` or build explicitly.

## Traps that invalidate results

- T2 filters are Lua patterns: `-` must be escaped as `%-`, and `|` is not alternation. Pass several filters instead.
- Parallel shards are separate Factorio games. A test may only consume state created in its own shard unit. Configure
  intentional grouping in `tools/test-shards.json`.
- Each process needs its own write-data directory. Sharing one produces lock, log and mod-settings collisions.
- factorio-test normally prints `log()` output only for failures. Use `out/test-results.json` to find the shard and
  read `.factorio-test/shards/N/factorio-current.log`.
- T2’s bundled save is lab tile, not Nauvis. A terrain test must create its own surface.
- Concurrent Factorio instances distort wall time and AI ms/tick. Quote performance only from `-j 1`; deterministic
  work counters are the concurrency-independent comparison.
- A scorecard written while seeds remain is partial. Check `run.json` and do not treat absent seeds as passes.

## Fast soak debugging

**Stop before opening the coordinator code.** Run `npm run diagnose -- <run> [seed] [faction]` first. It now prints
the evidence agents previously spent hours reconstructing by hand:

- crew-plan rejection counts and representative job ids (why an apparently ready job was skipped);
- supply-source raw/reserved/takeable counts and the chosen haul detour;
- placement rejection certificates by cause and representative tile, plus every failed routing retry;
- cross-layer invariant violations and churn warnings.

These are facts from the exact failing run. Reading `crew.ts`, `factory.ts`, or planner scoring first invites a
plausible but wrong theory because Factorio inventory, reservation, terrain and ghost state are not visible in code.
If the process crashed, open `seed-N/failure.json` before either log: it contains both log tails, the last telemetry
diagnostics, and paths to the newest frame/graph/plan artifact.

- Use fail-fast rules to stop known-dead runs.
- Use `--snapshots N`, then `--from-save`, for bugs that appear late. `--benchmark` cannot save.
- Failed plans already emit `.input.lua`; copy a minimal reproducer into `mod/unit/fixtures/` and replay it.
- If the factory chooses the wrong next goal, call the remote probe `goal_selection_snapshot(faction)`. It returns
  only plain data: paste the `specs` and `state` into a `goal-selection` T1 regression, then change the pure policy.
  Do not try to load a `LuaEntity` or an entire save into a unit test.
- Use helper probes or `npm run diagnose -- <run> [seed] [faction]` to connect the current factory goal to planner and
  Job Board blockers before reading thousands of log lines.
- In the live inspector, enable **Growth reserves and mine claims** before changing expansion logic. The green box is
  the built footprint, orange is non-mine growth room, and blue is the whole-patch mine claim; the label includes the
  latest failed growth reason. Looking only at entities hides the reservation that often caused the failure.
- Preserve the failing artifact until its regression exists. A new full soak is confirmation, not the first debugger.

## Test placement

- T1 (`mod/unit`): deterministic policy, geometry, state transitions, board logic, planner and captured replays.
- T2 (`mod/src/test`): pathfinding, selection boxes, mining, entity creation/revival, inventories, engine events,
  research triggers, save/reload and other engine contracts.
- T3 (`tools/harness`): multi-hour emergence, seed robustness, throughput and performance gates.

The complete observed Factorio and TSTL behaviours remain in `CLAUDE.md`; read the relevant section before writing an
engine-facing test, because apparently reasonable setups can test a different entity or surface than intended.
