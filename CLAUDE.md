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
- **Never record a decision as user-approved** unless the user actually approved it. Agent proposals go
  into SPEC §11 Open questions and the milestone report, marked "proposed", until the user decides.
  If the user approves something directly in your session, record it as approved and say in your
  report that the user approved it in-session (with date), so the manager can tell it from a proposal.

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
- factorio-test prints `log()` output only for failing tests. Read measurements from the shard's
  `.factorio-test/shards/N/factorio-current.log` (`npm test` runs shards; `out/test-results.json` gives each test's
  shard) or `.factorio-test/data/factorio-current.log` after `npm run test:serial`.
- **T2 runs in parallel shards, each its own game** (`tools/test-parallel.mjs`). A test may only rely on state from
  tests in its own unit: its file, or for files split in `tools/test-shards.json`, its group (e.g. the real-terrain
  seed tests and their "4 of 5" summary share `storage.testScratch`). A new test that reads another test's results
  must join that test's group in `tools/test-shards.json`, or the summary test sees "not run". Files not listed
  there always run whole, in declaration order.
- Shard data dirs are `.factorio-test/shards/N/`; never point two Factorio processes at the same write-data dir
  (`.lock`, `factorio-current.log`, `mod-settings.dat`, script-output collide). `--benchmark` binds no network port.
  Concurrent instances slow each other a lot on the dev laptop (i5-1240P: 4 P-cores + 8 E-cores, power-limited):
  5 soak seeds at once each ran at about half speed (AI ms/tick doubled). Per-test durations from a parallel run and
  soak ms/tick figures from `-j` > 1 are inflated: take performance numbers from a single-test run or `soak.py -j 1`.
- `T2` runs on factorio-test's bundled **lab-tile save** (no resources, no terrain). For real terrain, create a
  surface: `game.create_surface(name, { seed, autoplace_controls: { "enemy-base": { size: 0, ... } } })` gives
  default Nauvis generation (see `test/bootstrap.test.ts`).
- **Resources outside starting areas are sparse in 2.0** (one seed had no iron farther than ~400 tiles from the
  origin in a 1536² area). A faction placed 300+ tiles out needs its own starting area: append its spawn to
  `surface.map_gen_settings.starting_points` *before* those chunks generate (`world/spawn.ts`). The typed field
  is readonly; cast. Nearby seeds can produce identical starting areas at the same spot (seeds 2/3 and 4/5 did),
  so use spread-out seeds.
- **Mining a resource tile under a ghost deconstructs the ghost** (`update_selected_entity` picks the ghost).
  The controller refuses to mine when a ghost is selected, and the brain never plans sites over tiles being hand-mined.
- The **pathfinder can't start from the 0.6-tile gap between two adjacent machines** (e.g. a coal drill pair),
  though the character fits there and can walk out. `walk.ts` steps to a free spot and re-requests (escape phase).
- `vector_to_place_result` reads back as an array (`{-0.5, -1.3}`, Lua indices 1 and 2), not `{x, y}`. A burner
  drill's drop point lands on the *tile footprint* of an adjacent drill but just outside its collision box; the pair
  still feeds itself.
- Furnace output counts for `craft-item` research triggers (`steam-power`: 50 iron plates, `electronics`: 10
  copper plates) with nothing queued; trigger techs complete on their own.
- `--benchmark` ignores SIGTERM (the harness kills with SIGKILL), prints per-tick timings only at the very end, and
  runs mods normally. `--create` runs `on_init` (the freeplay scenario's too, so its `freeplay` remote interface
  exists); the first tick happens in the benchmark run.
- Lua `require` cycles break module loading: keep shared state like the AI profiler hook in a leaf module
  (`profiling.ts`) instead of importing `tick.ts` from modules `tick.ts` imports.
- `LuaProfiler` output in a log line needs a localised string: `log(["", "text ", profiler])`.
- **Inserter direction is the side it picks up from** (2.0): an inserter facing north takes from the tile north of
  it and drops south. Yellow inserters move about one item per full turn (0.84/s), a bit more from belts.
- **An inserter won't put ore into a burner furnace that has no fuel.** Furnaces early on a thin fuel lane hoard coal
  and the last ones start late: at exactly the declared coal rate a column takes 15–23 game-min to reach its rate
  (D33 validation waits for steady state; a real build should prime its fuel lane).
- `require` works only while control.lua is parsed: load data files at file scope, never lazily. TSTL resolves
  `require` paths at compile time; generated Lua files need an entry in `noResolvePaths` (`tsconfig.base.json`).
- `products_finished` errors on mining drills (not a crafting machine).
- T1 runs on whatever Lua is installed (5.3+ locally): it prints `3` and `3.0` differently, so format numbers with
  `%g` in test keys.
- factorio-test filters are **Lua patterns**: no `|` alternation, and `-` is a quantifier (`"crew%-built"`). Run
  several filters as separate arguments (any of them matches). `npx factorio-test run` does not rebuild: `npm run
  build` first (or `npm test`, which also takes `--no-build`).
- `helpers.table_to_json` writes an empty Lua table as `{}`, not `[]`: JSON readers (tools/render) must accept both.
- Underground belts: `create_entity{type = "input"|"output", direction = flow direction}` for both ends (2.0); the
  routing tests follow `neighbours` / `belt_neighbours` to prove each route connects.
- A new surface from `game.create_surface(name, {seed, ...})` has a starting area at the origin (iron, copper, coal,
  stone and a lake within ~100 tiles). 160 tiles away there may be no iron within 112 tiles: plan near the origin.
- Builds over trees/rocks are two-phase (`planner/runtime.ts`): clear jobs first, ghosts after, because the controller
  refuses to mine where a ghost is selected.
