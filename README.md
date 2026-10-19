# Rival Engineers

A Factorio 2.0 mod in which AI factions crew physical engineers that build factories the way players do.
See [`docs/SPEC.md`](docs/SPEC.md) for the full design and milestones.

## Development

Agents and contributors start with [`AGENTS.md`](AGENTS.md). It routes each kind of change to the Factorio/TSTL
lessons that must be read before editing; those engine facts cannot be recovered reliably from the TypeScript alone.

Requirements: Node 22, Lua 5.2+ (`lua5.2` or `lua` on PATH, or `$LUA`) for unit tests, Python 3 with Pillow
(renderer), and Linux (headless Factorio).

```bash
npm ci
# one-time: isolated headless Factorio for tests (never uses ~/.factorio)
mkdir -p .factorio-test && curl -fsSL https://factorio.com/get-download/2.0.77/headless/linux64 | tar -xJ -C .factorio-test
mkdir -p .factorio-test/data/mods && cp ci/mods/*.zip .factorio-test/data/mods/

npm run typecheck        # T0
npm run check:architecture # setting registry parity and pure-module boundary checks (also included in typecheck)
npm run status           # branch/commit, dirty state, current report and unresolved BUGS rows
npm run doctor           # read-only environment check: build freshness, runtimes, locks and Factorio processes
npm run diagnose -- RUN [SEED] [FACTION]  # explain a soak's goal/planner/job/crew blocker chain
npm run test:unit        # T1: pure logic (mod/unit), compiled by TSTL, run with plain Lua
npm run test:unit -- --no-build -t "green-line-dev11" plan-replay   # reuse the last build, one test (0.5 s, not 30 s + all)
npm run replay:sweep -- "seed11-production-ok" "REPLAY_UG=,1" "REPLAY_SOFT_PLACE=0.25,0.5" -j 2   # replay variants in parallel
npm test                 # build + in-game tests (T2) on headless Factorio, in parallel shards (over 5 min: ~10 min on 2026-10-19 with other runs going; manager-only, SPEC §9)
npm test -- "pattern"    # filter tests by Lua pattern (several patterns: any of them)
npm test -- -j 4 "pattern"      # shard count (default: half the cores, at most one shard per unit; or $TEST_JOBS)
npm test -- --plan              # print the shard plan without running
npm test -- "validation fast"   # module validation lab without the slow modules
npm test -- "routing lab"       # M4b: 5 modules placed, routed and run in a lab (~20 s)
npm test -- "real terrain"      # M4b: the module set on 5 generated maps (~10 s; filters are Lua patterns: no "|", escape "-" as "%-")
npm run test:serial      # build + one `factorio-test run` in .factorio-test/data (debugging; takes the same filters)
```

T1 options (`tools/run-unit-tests.mjs`): `--no-build` skips the delete + TSTL compile (~20–30 s) and runs the existing
build (it stops with an error if there is none); `--out DIR` or `$UNIT_OUT` builds and runs in DIR instead of
`mod/build-unit`, so concurrent runs in one checkout don't clobber each other (any number of runs may share one build
read-only with `--no-build`); `-t TEXT` (`$UNIT_TEST_FILTER`) runs only the tests whose name contains TEXT; the last
argument filters test files. Without options it rebuilds and runs everything, as before.

`npm test` (`tools/test-parallel.mjs`) runs one `factorio-test run` per shard, each with its own write-data directory
`.factorio-test/shards/N/` (vendored mods copied from `ci/mods/`). A test file is one unit; `tools/test-shards.json`
splits files whose tests are independent (each module validation test; the M4b routing tests, keeping the
real-terrain seeds together). Units are packed by duration from `out/test-timings.json` (updated by every run,
seeded from `tools/test-timings.json`; refresh that with `npm test -- --save-timings` when the suite changes a lot).
Tests the plan didn't know (new tests in a split file) run in a short second pass. Output: one summary,
`out/test-results.json` (merged), and per shard `out/shards/shard-N.log`; a failure prints its shard's log and
Factorio log paths.

Curated modules (SPEC §5.4): edit a spec in `tools/modules/curated/`, then
`python3 -I tools/modules/curate.py show SPEC` (character grid, to place ports) and
`python3 -I tools/modules/curate.py build tools/modules/curated/*.json` (writes `data/modules/<id>.json`, a render
dump in `data/modules/render/` and `ATTRIBUTION.md`).

Rendering entity dumps (written by the `dump_entities` remote call to `script-output/` in the write-data directory:
`.factorio-test/shards/N/script-output/` after `npm test`, `.factorio-test/data/script-output/` after `test:serial`):

```bash
python3 tools/render/render.py DUMP.json -o out/frame.png
python3 tools/render/render.py frames/*.json --gif -o out/timelapse.gif
python3 tools/render/render.py frames/*.json --trail -o out/walk.png   # + the character's trail
python3 tools/render/render.py DUMP.json --graph DUMP.graph.json -o out/graph.png   # + Factory Graph overlay
```

Soak runs (T3, SPEC §7) on fresh maps, headless at max speed, with a scorecard and frames per seed (not in CI):

```bash
npm run soak                                              # tools/harness/soak.toml: M3 acceptance, 5 seeds
python3 tools/harness/soak.py -c tools/harness/two-factions.toml --gif
python3 tools/harness/soak.py --seeds 11 --hours 0.5 --name dev   # quick one-off
python3 tools/harness/soak.py -c tools/harness/soak.toml -c tools/harness/no-starting-area.toml   # several configs
python3 tools/harness/soak.py -j 1                        # one at a time (for performance numbers)
# → out/soak/<name>/scorecard.md, scorecard.json, seed-N/{telemetry.json,frames/,factorio-current.log}
```

Every new soak also writes `out/soak/<name>/run.json` atomically. It records the commit and dirty state, generated-mod
content hash, invocation, per-seed PID/status/exit reason and whether the experiment completed. Incremental scorecards
are marked partial until every seed finishes; use the manifest instead of inferring process state from file mtimes.
An unexpected Factorio exit also writes `seed-N/failure.json`. Start there: it bundles both log tails, last structured
diagnostics, and pointers to the newest visual/planner evidence so a fatal error is not stranded in terminal output.

Seeds and configs run concurrently, `-j` at a time (default `$SOAK_JOBS`, else half the cores), each in its own
write-data directory `.factorio-test/soak/<name>/seed-N/`. Concurrent runs slow each other: compare wall and AI
ms/tick only between runs with the same `-j` (recorded as `config.run.jobs` in `scorecard.json`).

**Debugging a failing soak seed (don't re-run 20-minute soaks per fix):**

1. **Fail fast:** a config's `[run.fail_fast]` (on in `m5.toml`) stops a seed at its 2nd STALL, 8 failed plans in a
   row, or 20 rounds of unplaceable leftover ghosts; the reason is in the scorecard. `m5_scorecard.py` prints each
   failing seed's open goals, stall reasons, latest plan-failure kinds and leftover ghosts.
2. **Snapshot, then resume:** `soak.py ... --seeds N --snapshots 5 --name snap` saves every 5 game-minutes
   (a sped-up headless server: `--benchmark` can't save) to `.factorio-test/soak/snap/seed-N/data/saves/min-MMMM.zip`.
   `soak.py ... --seeds N --name repro --from-save <that zip>` rebuilds and continues it with the current code: a
   fix to a late failure is checked in 15–60 s instead of a full run (works while the storage layout stays compatible).
3. **Failed plans as T1 tests:** with frame dumps on, every failed plan writes `failed-plans/<faction>/<goal>-aN-tT`
   `.graph.json` (render with `render.py <nearest frame> --graph ...`) and `.input.lua` (request, base layout, terrain).
   Copy the input to `mod/unit/fixtures/` and add a `replay(...)` in `mod/unit/plan-replay.test.ts`: it replays the
   plan in plain Lua (`npm run test:unit -- --no-build -t "<fixture>" plan-replay`: one replay takes from 0.5 s to a minute or so; the
   whole file takes over 5 minutes). `REPLAY_ROUTER="maxRipups=6"` and `REPLAY_UNDERGROUND=4` try router variants. Soaks
   also keep every *adopted* plan's input (`plans/<faction>/`); `compareReplay(...)` replays one with the D36 / B2
   comparison (`REPLAY_UG=1`, `REPLAY_NO_BUNDLE=1`, `REPLAY_NO_SOFT=1`, `REPLAY_SOFT_PLACE=0.25` try weight variants).
   - **Read the dump first.** A replay that fails writes `out/replay-dumps/<replay>/summary.txt` and `plan.json`
     (`REPLAY_DUMP=1`: every replay; `REPLAY_DUMP=0`: no trace). For each placement: the chosen site and the runners-up
     with every weighted score term (`center`, `port`, `facing`, `clear`, `adjacent`, `exactGap`, `coverage`,
     `growthCoverage`, `softClaim`; lower wins), and the rejected candidates counted by reason (`hard`, `ore`,
     `corridor`, `port-lane`, ...) with the nearest one's blocker (`blocked at 475,-70: terrain own`,
     `ore at ...`, `occupied m:n3`, `reserved p:n21.out`, `route route:... (fixed)`). For each failed route: window,
     expansions, and what walls the explored region (tiles per blocker), plus the start and goal neighbourhoods.
     Events list re-placements, expansions and shared-mine completions. The trace (`src/planner/trace.ts`) is off in
     game: one nil check per placement candidate.
   - **Sweep variants in parallel**, not one replay at a time: `npm run replay:sweep -- "<test filter>" "VAR=a,b"
     "VAR2=x,y" [-j N] [--no-build] [--out DIR] [--name NAME]` builds once, runs every combination as its own Lua
     process (`-j`: default half the cores, or `$SWEEP_JOBS`) and prints one row per replay and combination: result,
     phase, work (placement / routing / comparison), searches, rip-ups, re-placements, route tiles, failures. An empty
     value unsets the variable (`REPLAY_UG=,1`); split values on `|` when one contains a comma
     (`"REPLAY_ROUTER=maxRipups=6,rip=10|maxRipups=8"`). Output: `out/replay-sweep/NAME/summary.{txt,json}` and per
     combination `output.log` and `dumps/`.
4. Engine-side bugs (walks, mining, placement) get a T2 test with the same neighbourhood (`npm test -- "name"`, ~20 s).
5. Full acceptance last, more seeds than the bar (`--seeds 11,222,...,7,77,777`) so one round shows several bugs.

**Performance gates (SPEC §9).** Wall-clock numbers move with whatever else the machine runs, so two other measures:

1. **Work counts (soft gate, every validation).** The mod counts its work deterministically (`mod/src/work.ts`: planner
   work units, placement candidates scored, router expansions, path requests, entity scans, jobs processed, reconciler
   node evaluations; per run and the peak per game-minute) into each seed's `telemetry.json` (`work`). A config names
   its committed baseline (`[run] work_baseline`, e.g. `tools/harness/baselines/m5-work.json`); `soak.py` and
   `m5_scorecard.py` append a "Work counts" section flagging every counter more than 15% above it (a flag is a
   regression signal for the report, not a failure). By hand:
   ```bash
   python3 tools/harness/workcounts.py out/soak/<run>             # compare with the config's baseline
   python3 tools/harness/workcounts.py out/soak/<run> --update    # make this run the baseline (commit the file)
   ```
   The counts depend only on seed, config and code, not on concurrency. Changing behaviour changes run lengths too;
   the scorecard says when a seed ran longer or shorter than its baseline.
2. **Reference-save benchmark (to confirm a flagged regression, on an idle machine).** A fixed vanilla base generated
   by script (`refbench.py generate`, once: 48 cells of drills → electric furnaces → sinks, assemblers on infinity
   chests, belt loops; ~12,000 entities, no mods) is benchmarked in the same session as the mod run, and AI time is
   reported as a percentage of its update time:
   ```bash
   python3 tools/harness/refbench.py generate                     # → .factorio-test/refbench/reference.zip
   python3 tools/harness/refbench.py report out/soak/<run>        # bench the reference now; each seed's AI as % of it
   python3 tools/harness/refbench.py session -c tools/harness/m5-mall.toml --seeds 11 --name ref-11
                                                                  # bench, soak at -j 1, bench again
   ```
   Absolute ms/tick stays informational.

In-game test logs (`[m1] ...` measurements) are printed only for failing tests. Read them from the shard's
`.factorio-test/shards/N/factorio-current.log` (the summary names the shard of each failure; `out/test-results.json`
lists every test's shard), or run the test alone (`npm test -- "name"`, one shard: `.factorio-test/shards/0/`).

Layout: `mod/src` holds the TypeScript sources (`control.ts` runtime, `settings.ts` settings stage,
`character/` the Character Controller, `jobs/` factions, the Job Board (`board.ts`, pure) and the crew runtime,
`strategy/` the research goal and the burner bootstrap brain, `world/` resource scanning and spawn placement,
`modules/` the module library (types, rate engine, generators, curated loader, transforms, stamping), `planner/` the
layout planner (terrain model, LayoutPolicy, placement, A* belt router, plan jobs, Factory Graph physical layer and
capacity math, the runtime that budgets it per tick and builds plans through the Job Board),
`telemetry.ts` telemetry and frame dumps, `tick.ts` the on_tick entry, `config.ts` the typed settings, `test/`
in-game tests), `mod/unit`
holds T1 unit tests for pure modules, `mod/static` holds files copied verbatim into the mod, `tools/` holds the build,
render, soak harness (`tools/harness`) and module tooling (`tools/modules`), `data/modules` holds the curated
modules (JSON, built into the mod by `tools/build-mod.mjs`) with their sources and attribution, and `ci/mods` holds
vendored test-only mods.

## Watching the AI in game

Run the mod live in your own Steam Factorio (2.0.77) and see where the crews' time goes.

```bash
npm run review                      # build, set up the review profile, start the sandbox scenario
npm run review -- --factions 1 --crew 3   # change the faction count / crew size (kept until changed)
npm run review -- --space-age       # also enable space-age, quality and elevated-rails (off by default)
npm run review -- --menu            # open the main menu instead (to load a save, change mod settings...)
npm run review -- --load NAME       # load .factorio-review/saves/NAME.zip
npm run review -- --no-launch       # set up only, print the command
```

**Review profile.** Everything lives in `.factorio-review/` in the **main checkout** (git-ignored): its own
`config/config.ini`, `mods/mod-list.json`, `mods/mod-settings.dat`, `saves/` and `factorio-current.log`. Your normal
`~/.factorio` (mods, saves) is never written; on first setup its `config.ini` is copied (graphics, keybindings) with
the paths pointed at the review profile (`--fresh-config` skips that). `mods/rival-engineers` is a symlink to
`<main checkout>/mod/build`, so any `npm run build` in the main checkout (yours or an agent's) is what the game loads
on its next start. Run from a worktree, the script still uses the main checkout's build and profile
(`REVIEW_ROOT=<dir>` overrides that, e.g. to try a worktree's build in its own profile). The game is started as
`…/steamapps/common/Factorio/bin/x64/factorio --config .factorio-review/config/config.ini --load-scenario
rival-engineers/sandbox` while Steam runs (`--via-steam` uses `steam -applaunch 427520` instead). Steam's launch
options are not touched. First start takes a while (sprite loading).

**Sandbox.** `npm run review` starts **Rival Engineers sandbox** directly; from the menu it is under
New Game → Scenarios. You are a **spectator** (free camera, WASD; no body), biters are off (setting "Sandbox
scenario: keep biters"), it is always day, the inspector opens, and the camera jumps to the first faction once it
spawns. Factions spawn on the first tick per the mod settings (faction count, crew size, spawn placement and
starting areas, SPEC §5.7 / D32). In a normal freeplay game with the mod, the inspector works the same way; its
**Spectate / Take body** button switches between your character and a spectator camera.

**Review toolbar** (top left, in the sandbox and for any spectator; a spectator has no shortcut bar): *Inspector*,
*Graph* (the factory-graph window), *Overlay* (draws the overlay layers with the inspector closed) with one toggle per
overlay layer, and *Report…*. Hotkeys: **Ctrl+Shift+I** inspector, **Ctrl+Shift+G** factory graph, **Ctrl+Shift+R**
report (they work while spectating; a character player also has them as shortcut-bar buttons).

**Reports** (B34): *Report…* asks what you see, then writes a diagnostic bundle to
`.factorio-review/script-output/rival-engineers/reports/<tick>-<slug>/` and saves the game as
`.factorio-review/saves/_autosave-re-report-<tick>-<slug>.zip` (the chat line names both). The bundle:
`message.txt`; `report.json` (message, tick, save name, surface, your camera position and zoom, controller, the
inspector's selected faction/crew, game speed, mod version, and per faction the soak telemetry: brain, board job
counts and open jobs, depot, research, each crew member's pocket, stats, last action and position, plus the work
report; the brain's `shortfalls` say what it was short of and what it did about it); `entities.json` (a frame dump
around the camera, `frame-dump-radius` tiles, `tools/render` format; built entities carry their non-empty `inventories`,
`status` and electric `network` id, so full furnaces and unjoined poles show) and
`graph-<faction>.json` (each Factory Graph). An agent diagnosing one: read `message.txt` and `report.json`, render
`entities.json` with `tools/render` (with `--graph` for a graph), then reproduce from the save:
`npm run review -- --load _autosave-re-report-<tick>-<slug>` to watch it, or copy the zip and
`python3 tools/harness/soak.py --seeds 1 --name repro --from-save <copy>` to resume it headless with the current
build. The mod's log lines from that session are in `.factorio-review/factorio-current.log` (until the next start).

**Inspector** (Ctrl+Shift+I, the toolbar, or the magnifier button on the shortcut bar):
- Top row: game speed ×1–×16, Pause/Resume, Step (one tick), Spectate. Overlay checkboxes: *Crew paths and
  actions* (each crew member's walk path, its target, and "#id action · category Ns" above its head) and *Planned
  entities* (ghosts outlined in the faction's colour, brighter when claimed), *Factory graph*, and *Growth plans* (B33,
  off by default: each expandable module's footprint in white, its planned growth units in order `+1`, `+2`... in amber
  with an arrow toward the last one, a strip mine's units past its ore in dashed red; a whole-patch mine's full planned
  footprint in violet, its built drills in green, its unbuilt planned drills dashed violet and its ore patch outlined in
  yellow). Overlays are drawn only for you.
- Faction (◀ ▶ to cycle, Go to base): the brain's current goal, what it waits on, the Job Board (ready, claimed,
  waiting on dependencies, in back-off, done, failed, releases), the oldest job nobody is working and why, and
  stalls (with the current one, if any).
- Crew table: what each member is doing now and for how long, its job and action queue, and its recent share of
  idle+waiting, hauling and walking+pathing. **Follow** puts the camera in remote view centred on that member
  (Esc leaves it); **Inspect** selects it.
- Selected member: action and phase, job, queue, and the **time breakdown** since it spawned and over the last
  minute of game time, in seconds and %: walking, stuck/pathing, mining, crafting, placing, hauling (haul, deposit
  and transfer jobs including their walks, and every insert/take), waiting for materials (ready jobs exist but none
  it can take), idle (no ready job), other. Hover a category for its definition. Plus jobs done/released, busy time
  by job kind and the last failed action.

Reading it: high *hauling* means depot round trips dominate; high *waiting* means the board has work but no
materials (look at the oldest waiting job); high *idle* means the brain has nothing queued (look at "Brain waiting
on"); high *stuck/pathing* means the pathfinder or terrain is the problem (turn on the path overlay and follow).
Time accounting is in `mod/src/review/time.ts` (storage only, deterministic, never changes what the crew does).
The in-game Factory Graph overlay (M5b, SPEC §5.8 D29) plugs in as another overlay layer:
`registerOverlayLayer(...)` in `mod/src/review/overlay.ts`.
