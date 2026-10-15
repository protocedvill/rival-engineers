# Rival Engineers

A Factorio 2.0 mod in which AI factions crew physical engineers that build factories the way players do.
See [`docs/SPEC.md`](docs/SPEC.md) for the full design and milestones.

## Development

Requirements: Node 22, Lua 5.2+ (`lua5.2` or `lua` on PATH, or `$LUA`) for unit tests, Python 3 with Pillow
(renderer), and Linux (headless Factorio).

```bash
npm ci
# one-time: isolated headless Factorio for tests (never uses ~/.factorio)
mkdir -p .factorio-test && curl -fsSL https://factorio.com/get-download/2.0.77/headless/linux64 | tar -xJ -C .factorio-test
mkdir -p .factorio-test/data/mods && cp ci/mods/*.zip .factorio-test/data/mods/

npm run typecheck        # T0
npm run test:unit        # T1: pure logic (mod/unit), compiled by TSTL, run with plain Lua
npm test                 # build + in-game tests (T2) on headless Factorio, in parallel shards (~2.5 min, serial ~11)
npm test -- "pattern"    # filter tests by Lua pattern (several patterns: any of them)
npm test -- -j 4 "pattern"      # shard count (default: half the cores, at most one shard per unit; or $TEST_JOBS)
npm test -- --plan              # print the shard plan without running
npm test -- "validation fast"   # module validation lab without the slow modules
npm test -- "routing lab"       # M4b: 5 modules placed, routed and run in a lab (~20 s)
npm test -- "real terrain"      # M4b: the module set on 5 generated maps (~10 s; filters are Lua patterns: no "|", escape "-" as "%-")
npm run test:serial      # build + one `factorio-test run` in .factorio-test/data (debugging; takes the same filters)
```

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

Seeds and configs run concurrently, `-j` at a time (default `$SOAK_JOBS`, else half the cores), each in its own
write-data directory `.factorio-test/soak/<name>/seed-N/`. Concurrent runs slow each other: compare wall and AI
ms/tick only between runs with the same `-j` (recorded as `config.run.jobs` in `scorecard.json`).

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
