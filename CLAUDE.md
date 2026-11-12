# Rival Engineers — read `AGENTS.md` first

**Mandatory:** [`AGENTS.md`](AGENTS.md) is the tool-neutral entry point and routes each kind of change to the
learned rules it needs. Read it before searching the code. The ledger below is intentionally retained because its
Factorio and TSTL facts are part of the correctness model, not optional tips.

# Project rules and learned engine facts

Factorio 2.0 mod: AI factions whose physical character crews build factories like players do.

**`docs/SPEC.md` is the source of truth.** Read it before starting work. §2 decisions are settled, §8 lists
the milestones, and §9 is the operating model (stacked PRs, `proto/*` branches, non-blocking questions).

## Working rules

- Work milestone by milestone on `mN-<slug>` branches, stacked on the previous milestone branch. One PR per
  milestone, with a report at `docs/reports/MN-report.md`.
- Throwaway experiments go on `proto/<topic>` branches. No PRs for them.
- In a git worktree, `node_modules` (and `.factorio-test/factorio`) are symlinks to the main checkout. Stage only your
  own files (no `git add -A` / `git add .`): a committed `node_modules` link once replaced the main checkout's real one.
- Never touch the user's `~/.factorio` (saves, mods, blueprint storage) in place. Copy inputs into
  `tools/modules/input/` first. Test runs use the isolated install under `.factorio-test/` (git-ignored).
- Determinism rules in SPEC §5.6 are hard constraints. All persistent state goes in `storage`, use no
  `math.random`, and check `.valid` before using an entity.
- Prefer configurable settings over constants (SPEC §5.7).
- When a plan, placement or route misbehaves, read its dump (`REPLAY_DUMP=1` / the failure dump in
  `out/replay-dumps/`) before running variants; sweep variants with `npm run replay:sweep`, not one replay at a time.
  Rerun T1 with `--no-build -t <test>` after a build instead of recompiling for every run. T1 builds `mod/build-unit`;
  T2, soaks and the game load `mod/build`, and `--no-build` never rebuilds either (run `npm run build` after `mod/src`
  changes).
- **Escalate magic numbers to the user.** Every tuning number you introduce (thresholds, distances, counts, timeouts,
  weights, margins...) is listed in the milestone report's "Magic numbers for the user" table: name, where it lives,
  current value, why that value, and whether it is already a setting. The user decides which become settings and their
  values. Guesses and placeholders are fine during development and testing. Numbers that come from game data or
  mechanics (recipes, prototype values, engine limits like reach or belt speed) are exempt.
- **Never record a decision as user-approved** unless the user actually approved it. Agent proposals go
  into SPEC §11 Open questions and the milestone report, marked "proposed", until the user decides.
  If the user approves something directly in your session, record it as approved and say in your
  report that the user approved it in-session (with date), so the manager can tell it from a proposal.

## Commands

See `docs/DEVELOPMENT.md`. (Kept there so it stays next to the scripts it describes.)

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
- **`{ ...obj, field: undefined }` does not clear `field`**: TSTL drops undefined values from object literals, so the
  spread keeps the old value. Copy, then assign `copy.field = undefined` (plan.ts `altJob`).
- **A named function passed to `Array.prototype.sort` receives a shifted comparator**: TSTL compiles `arr.sort(cmp)`
  to `__TS__ArraySort(arr, cmp)`, and the bundled helper calls `compareFn(nil, a, b)`. Only an *inline arrow* gets the
  injected `self` parameter, so a named `function cmp(a, b)` sees `a = nil` ("attempt to index a nil value"). Pass
  `.sort((a, b) => cmp(a, b))`, not `.sort(cmp)`. Pinned by `mod/unit/merge.test.ts` (planner/merge.ts `byCost`).
- **`string.match` returns a 0-based TS array of captures**: TSTL compiles `const m = string.match(s, "(.*)#%d+$")` to
  `local m = {string.match(...)}`, so the first capture is `m[0]` (`m[1]` is the second capture; a Lua-style `m[1]`
  reads the next return or stays nil). Do not index the Lua multi-return directly.
- **A named import of an exported `let` is a load-time copy**: `import { x } from "./m"` compiles to `local x = ____m.x`,
  so later reassignments in `m` are never seen (telemetry logged no `[re-profile]` lines). Import the module
  (`import * as m`) and read `m.x`.
- **`import type` is erased, so it cannot create a Lua `require` cycle**: a module may type-reference a module that
  value-imports it (e.g. `claims.ts` takes `import type { LayoutState }` while `layout.ts` imports its writers). Only a
  value import closes the cycle, and `require` cycles fail at mod load. Keep the shared *values* in a leaf module
  (`claim-tags.ts`) instead.
- **`${x?.y}` in a template literal crashes when it is nil**: TSTL compiles templates to `..` and wraps only values it
  cannot prove are strings in `tostring`; an optional string field goes in raw, and `..` on nil is a Lua error that kills
  the game (soak `vps-b68` seed 3891760, `goal grew ${node?.role}` after the node was removed). Give it a `??` fallback.
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
- **Script-creating an entity on top of a ghost removes the ghost.** In tests, place obstacles before ghosts. **A ghost created over another ghost also removes the existing one**, even though `can_place_entity` returns true; check for a different own ghost on the tile before creating a ghost (B144, `conflicts.ts` `preflightSpecs`).
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
- **A module port's outside tile must lie outside the module's footprint** (B113, B161). A belt-in on the module's
  last row facing inward has its outside tile one row further out; if that row is still inside the footprint, no
  route can ever start there and every plan fails `no path`. Add every new generator to the `port-edges` T1 sample
  list: it checks all rotations, not only the one a plan happened to use.
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
- **A player-less character's hand-crafting does not fire `craft-item` research triggers** (`automation-science-pack`:
  craft a lab). Machine output does (furnace plates fire `steam-power`/`electronics`). The controller emulates the
  trigger for crew crafts (`character/triggers.ts`); an engine-capabilities test pins the gap.
- **Hand-crafts with intermediates restart `crafting_queue_progress` at 0 for each queued intermediate.** A stall check
  on `gained + crafting_queue_progress` fails any craft whose chain takes longer than `action-stall-ticks` (a lab is
  ~21 s), and the cancel leaves the finished intermediates behind: thousands of circuits piled up in one soak. Progress
  now also counts finished queue entries.
- Revived small-pole ghosts (`ghost.revive`) connect their copper wires to poles in reach, like a player's build: the
  pole network planner only has to put poles within wire reach (T2 "power-up").
- **Poles skip redundant copper wires**: a medium-pole assembler row's poles each have up to 5 others within wire reach
  but only 2-3 wires, and a later pole still connects. Counting poles in reach overstates a pole's wires (planner/power.ts
  `wireDegree` is an upper bound). A wire's length is limited by the *shorter* reach of its two poles (small 7.5,
  medium 9). Pinned by the engine test "B206 finding".
- Plans on top of a faction's base (`newPlanJob(..., base)`) copy the layout; existing modules are `fixed` and existing
  routes `Route.fixed` (never ripped). A finished plan's layout *becomes* the faction's (`strategy/factory.ts`).
- Lua 5.3+ (T1) prints `43` and `43.0` differently: keys built from coordinates that went through arithmetic (module
  expansion) must use `%g`, or equal positions compare unequal (planner/grow.ts).
- Soak graph dumps go to `script-output/rival-engineers/graphs/<faction>/`, not `frames/`: soak.py renders every
  `frames/*/*.json` as an entity dump.

- **Saves never happen under `--benchmark`** (`game.auto_save`/`server_save` are silently ignored). Snapshot runs use
  `--start-server` with a script setting `game.speed = 1000` (about benchmark speed) and `game.server_save(name)`; the
  write-data `saves/` dir must exist or `server_save` throws a filesystem error. `--benchmark <save>` resumes a save with
  the current mod build (storage carries over; same mod version, so no `on_configuration_changed`).
- **A big rock off the tile grid overlaps three tile rows** (box 1.9 tall at y = n.5): the terrain scan and
  `obstaclesUnder` see it, but a walk to within `resource_reach_distance - 1.2` of its *centre* found no path (every
  end node next to it collides). Walks to trees/rocks aim at their box plus that margin (`walk.ts`).
- **Without undergrounds (before `logistics`) a 7-flow production cluster next to fixed modules can be unroutable**:
  belts can't cross, rip-up cycles forever. After a production/mall goal fails all attempts without undergrounds, the
  factory makes their technology a prerequisite (`needUndergrounds`). D36 (M5c): a successful plan also reroutes its
  placement with undergrounds and researches them first when that is ≥ 50 tiles shorter; the no-underground cluster is
  chaotic (small weight changes flip it between routable and not), so judge planner changes on several replays.
- **Mining acts on whatever is selected at the mining position**: a tree's selection box over an ore tile makes the
  crew mine the tree, a built belt on ore gets picked up. The controller mines from a corner of the target's box where
  the target itself is selected, refuses built entities over ore, and mines trees/rocks first. After the selected
  entity is mined away, a player-less character's `mining_state` stays idle: set `{mining: false}` once, then resume.
- **A new game queues chunks ~10 chunks around the origin before `on_init`** and computes their tiles on worker
  threads; `is_chunk_generated` stays false for them. A starting point appended over them (faction spawns at ~336
  tiles) gets starting-area ores (placed at a later chunk stage) but **no starting lake**. Soaks (`--create` save, then
  `--benchmark`) don't show it; the sandbox scenario and new freeplay games do (`world/spawn.ts` repairs the lake).
- `surface.calculate_tile_properties({"elevation"}, positions)` evaluates the current noise program, already including
  starting points appended a moment ago. Nauvis water tiles match `elevation < 0` sampled at the tile's integer corner
  (x, y), not its centre (2–10 shore tiles differ in a 192² area).
- Starting a headless game from a scenario: `--start-server-load-scenario rival-engineers/sandbox --server-settings S`
  with `auto_pause: false`, and keep stdin open (`sleep N | factorio ...`) or it exits on EOF.
- **Trees' selection boxes are tall and overlap in forests**: the tree south of a target covers its centre and its
  whole collision box, so `update_selected_entity(tree.position)` often selects a neighbour that is out of mining
  reach, and mining makes no progress. Mine from a point of the target's *selection box* where it is the selected
  entity (`controller.ts` `selectPoint`); the mining arena (`test/mining-arena.test.ts`) pins it.
- Several `update_selected_entity` calls in one tick leave the selection on the **last** point: re-select the
  wanted point right before setting `mining_state`.
- **Items on belts keep a `unique_id`** (`LuaTransportLine.get_detailed_contents()`) while they move from belt to belt:
  sampling one belt tile more often than an item takes to cross it and counting new ids measures its flow exactly
  (15.00/s on a full yellow belt; `strategy/measure.ts` edge probes). A belt entity's transport line covers that tile only.
- **Built own entities read as `OWN` in the terrain scan**, whatever the layout says: a growth or plan that may take a
  built entity's tile needs the planner view (`claimView`) to say so. B37: own pole-line poles read as free there.
- **Factorio permits an entity ghost on top of the same live entity**, but that ghost can never be revived. When B37
  re-lays a pole line through an unchanged live pole, `stampParts` reuses the pole instead of creating a ghost/place
  job over it (T2 factory test B41).
- **A radar charts nothing for a force with no players** (2.0): powered, the same radar charts and generates its
  7×7-chunk nearby square for the `player` force and nothing for a script-created force (our factions). It still
  sector-scans (one `on_sector_scanned` per ~33 s; nearest first in rings, no chunk twice: 53 scans in 30 game-min
  reached ring 4); the chunk is only marked requested for charting, never charted or generated (D62 (a) uses the event). `force.chart` on such a force only requests too. (A forum post quotes a
  developer: charting is skipped for forces without players.) Pinned by two engine-capabilities tests ("D62 finding").
  A script-created `electric-energy-interface` makes no power until `power_production` and `electric_buffer_size` are set.
- **Construction robots work for a force with no players** (unlike radars, D62): a script-created force's roboport
  network builds ghosts from a storage chest and removes trees marked for deconstruction, and a player-less character's
  personal roboport (modular armour grid) builds from its main inventory. Pinned by two engine-capabilities tests ("M7d").
- **A 2.0 fluid segment longer than the pipeline extent carries nothing** (utility constant `default_pipeline_extent`,
  320 tiles; a fluid box may override it). Pipe-to-ground pairs count their whole span. A pump starts a new segment
  (~1040-1140/s through 2200 tiles with a pump every 220); within the extent a line carries ~1000-1170/s. Pinned by the
  engine-capabilities test "M7b finding". Measure fluids with a pushing source (an offshore pump): an `infinity-pipe`
  sets its whole segment's contents and fakes any flow; read amounts with `get_fluid_contents()` (TSTL shifts
  `fluidbox[1]`). An offshore pump's output is on the side opposite its facing (`west` → connects east).
- **Diagonal cliffs have turned collision boxes**: `bounding_box` carries `orientation` (0.125 turns for a corner piece)
  and its corners are the *unturned* rectangle about the box centre. Turned, it reached ~1 tile further: a belt could not
  be placed on a tile the corners missed (B123). Tile coverage goes through `grid.ts` `boxTiles`.
- **Machine status alone misreads a module behind its own inserters**: the generated smelter column's inserters are
  electric; without power its furnaces just say `no_ingredients`. Measurement samples a module's inserters for power and
  fuel too (`measured.inserters`). Mining drills and labs have no output counter (`products_finished` errors on drills).
