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
- Do not run the full T2 suite as one shard (`TEST_JOBS=1`): every file then shares one game, the tests' factions pass
  Factorio's 64-force limit and 24 tests fail with `Too many forces` in `create_force` (VPS, 2026-10-28). Use
  `TEST_JOBS=2` or more to cap concurrent instances.
- Each process needs its own write-data directory. Sharing one produces lock, log and mod-settings collisions.
- factorio-test normally prints `log()` output only for failures. Use `out/test-results.json` to find the shard and
  read `.factorio-test/shards/N/factorio-current.log`.
- T2’s bundled save is lab tile, not Nauvis. A terrain test must create its own surface.
- T2 now defaults to one shard per core (capped at 8). The full suite is CPU-bound: six shards on six cores cut the
  wall time from 445 s to 162 s solo. Do not read that as a test-time reduction: shard time still adds up, and three
  concurrent soaks inflate the wall time again.
- The module lab’s steady-state check uses a `0.5/sqrt(expected items)` tolerance floor. A low-rate module (0.15/s)
  makes 8 or 10 items per window; a flat 3% tolerance never passed and both engine tests ran to the 60-minute cap.
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
- For work past a milestone (M7: blue science after red/green), keep a save library: `--save-at stage-3
  --stop-after-saves` files one save per seed in `out/saves/<config>/seed-N/`, and `--resume-from stage-3` starts every
  seed there. Rebuild the library when the storage layout or anything before the milestone changes, or after a fix whose
  bad state the saves already hold (a resume cannot show such a fix). Acceptance runs start fresh. Game-time caps and
  `--stop-after-saves` read the log, which Factorio flushes late: a sped-up server overshoots by a few game-minutes.
- This cloud box (4 vCPU Xeon, 15 GB): a 20-game-min early run took ~54 s alone and 28-34 s each with three at once
  (plus a fourth long run): run soaks with `-j 3` or `-j 4` here; the default (half the cores) is 2.
- Failed plans already emit `.input.lua`; copy a minimal reproducer into `mod/unit/fixtures/` and replay it.
- If the factory chooses the wrong next goal, call the remote probe `goal_selection_snapshot(faction)`. It returns
  only plain data: paste the `specs` and `state` into a `goal-selection` T1 regression, then change the pure policy.
  Do not try to load a `LuaEntity` or an entire save into a unit test.
- Use helper probes or `npm run diagnose -- <run> [seed] [faction]` to connect the current factory goal to planner and
  Job Board blockers before reading thousands of log lines.
- For a Job Board backlog (many jobs, a busy crew), run the soak with `--helper-lua tools/harness/probes/board.lua`:
  every 5 game-minutes it logs the active jobs grouped by key prefix, kind, item and target, with how many are claimed,
  waiting, backing off or ready, and whether the crew could take a ready job's materials now. A large group with no key
  prefix (`-`) whose producer uses keys means the keys were overwritten (M7c.7: orphaned temp-cell refills).
- In the live inspector, enable **Growth reserves and mine claims** before changing expansion logic. The green box is
  the built footprint, orange is non-mine growth room, and blue is the whole-patch mine claim; the label includes the
  latest failed growth reason. Looking only at entities hides the reservation that often caused the failure.
- Preserve the failing artifact until its regression exists. A new full soak is confirmation, not the first debugger.

## Performance work: prove "no behaviour change" cheaply

- **Find the cost before changing code.** Replay a captured plan in plain Lua at the in-game budget (400 units a step)
  and time each `stepPlan` call: a single step far over the budget is uncounted work (M7: one pipe route took 7.2 s in
  one step while counting as "expansions"). For per-tick runtime cost, wrap suspects in temporary `LuaProfiler`s logged
  once a game minute in a 45-game-minute `soak.py -j 1` run; the soak's per-subsystem table only names the subsystem.
- **Pure refactors:** log every result of the function over the whole T1 suite (a temporary hook appending a sorted
  serialisation to a file named by an env var), refactor, rerun, `cmp` the files (M7: 5,241 `computeRates` results,
  458 `tryExpand` calls). Remove the hook before committing.
- **Planner speedups:** every replay's `REPLAY {json}` line (candidates, work, outcome, failures) must stay identical;
  compare against a `--out` build of the previous commit.
- **Runtime speedups:** two same-seed soaks of the same config must play out identically (telemetry goals, counters,
  crew stats and work totals equal). A change that alters only the *amount* of planner work is not identical in play:
  plans finish earlier under the same budget and the game drifts, so compare those on replays, not soaks.
- A cache kept outside `storage` must be derived only (rebuilt after a load), or saves and multiplayer desync.

## Test placement

- T1 (`mod/unit`): deterministic policy, geometry, state transitions, board logic, planner and captured replays.
- T2 (`mod/src/test`): pathfinding, selection boxes, mining, entity creation/revival, inventories, engine events,
  research triggers, save/reload and other engine contracts.
- T3 (`tools/harness`): multi-hour emergence, seed robustness, throughput and performance gates.

The complete observed Factorio and TSTL behaviours remain in `CLAUDE.md`; read the relevant section before writing an
engine-facing test, because apparently reasonable setups can test a different entity or surface than intended.
