# M6 report

## M6a: green science, the 30 + 30 stage, shared providers, stuck builds (2026-10-16/17)

Scope: automated green science and the stage-2 target (30 red + 30 green per minute consumed by the labs), every one of
the 42 D30 technologies, backlog B14, B15, B19, B20, unboxing crew members boxed in by their own builds, and the
`m6.toml` acceptance config with `m6_scorecard.py`. Bar (SPEC §3, §8): ≥ 30 + 30/min sustained over 30 game-min within
8 game-hours plus the research goal (milestone `v1-done`) on ≥ 4 of 5 seeds (11, 222, 3333, 44444, 555555), one
faction.

**Result: the bar is not met (1/5 seeds on the final code, 2/5 on the pre-session code).** The open failures are handed to M6b below.

### What was built (commits)

| Commit | What |
|---|---|
| b8d8e0e | Stage-2 design: red + green targets, the curated green line (`green-line-hellpet`), production clusters that keep the stage-1 roles around one steam block, labs grown by count; settings `factory-design-margin` (1.1), `factory-lab-sizing` (`mean;max`), `factory-sustain-minutes` (30); science sampling with the `science-sustained`, `research-goal-done` and `v1-done` milestones; grow order and stage advancement; `tools/harness/m6.toml` with fail-fast deadlines. |
| baf27d3 | B15 / D51 (3): plans see the faction's bootstrap mining sites as clearable ground and evict them (built: retired and picked up before the build; planned: dropped; a replacement goal either way). The site search counts only spots that pass the table lookups and skips worked-out tiles. T2 tests. |
| 9628ee7, cde00fa | BUGS rows B16–B18 (user reports, not M6a work). |
| a08877b | B14 / D51 (1): `module-buffer-slots` default 2; assembler rows (gears) and circuit blocks get a buffer head (two columns at the output end). T1 layout, growth and power checks; T2 buffer-fill tests; validation entries. |
| 3406876 | A shared fuel producer per cluster for new furnaces from stage 2 (setting `factory-shared-fuel`, replaced by `factory-shared-providers` in 7d93796). Leftover ghosts evict bootstrap sites under them. |
| 92ffef3 | A second steam block (`power#2`) when the first can't grow; `m6_scorecard.py` (the sustained window recomputed from the science samples, research, phases). |
| 3deb8a8 | Stage helpers and science sampling moved to `strategy/stage.ts` (`factory.lua` hit Lua's 200-local limit and the mod failed to load). |
| 7d93796 | B19: shared providers for any item from stage `factory-shared-providers` (1) once splitters exist: new consumers tap a built producer with spare capacity (the steam block's coal outpost included), else share one new producer per cluster; splitters researched first when sharing saves `logistics-share-min-modules` (1) modules. B20: T2 planned outpost over a live bootstrap site; stuck builds escalate after `build-stuck-rounds` (10). `factory.ts` split with a build-time guard on the local count. |
| 6db6e37 | A crew member boxed in by its own build (3 no-path failures in a row) picks up the nearest small entity and leaves a ghost for it; `crew_debug` remote and `tools/harness/probes/crew.lua`; T2 test. |
| 38803f5 | A cluster-1 module that can't grow caps cluster 1's share of the stage target (the other clusters make the rest; replaces the second lab array); producers whose routes can't take a tap are not shared again; mining outposts search up to 192 tiles from their consumer; SPEC §11 P30–P35. |
| **d4476ab** | **Close-out fix (this session):** growing a module now rips, picks up and reroutes the splitter taps hanging off its routes. See "Fix: growth and splitter taps". |
| f35878b | T2 hygiene: every test describe that destroys factions before each test also destroys them after its last test; SPEC §11 P36 (proposed). |
| ef994fa | T2 runner: shards allow 900 s without output (long validation tests next to 7 other shards were flagged stuck at 180 s while passing). |

### Fix: growth and splitter taps (d4476ab)

Seed 11 (m6-dev4) stalled at 175 game-min with `power short (1.8e+06/1.38e+07): cannot grow; coal>power short:
cannot grow`. The reconciler named the cause: `n1 power starved: edge coal>power=>power.in-fuel broken (items pile up at
the producer and don't arrive)`. Chain of events, read from the min-0040 snapshot with an entity probe at the stuck
ghost:

1. At 32 min the steam block's coal outpost (`coal>power`) grew by 4 units. Since B19, that outpost also fed the copper
   smelters' fuel through a **splitter tap** on its route.
2. `planGrowth` ripped every route touching the module; `ripRoute` also rips the taps hanging off a route, but
   `planGrowth` only recorded the root route: the tap's belts were neither picked up nor rerouted, and its tiles became
   free in the layout. The grown outpost put a burner drill ghost on two of the tap's belts (488,-83).
3. The ghost could never be placed (`cannot-place`), B20 abandoned the growth after 10 rounds with the coal route
   half-rebuilt, and every reconciler repair re-placed the same unplaceable ghost (`1 ghosts failed`). The steam block
   starved, the labs lost power from 53 min, and research stopped at `heavy-armor`.

Fix (`planner/grow.ts`): a route and, depth first, every tap on it are collected before the rip; their entities go into
the pick-up diff, their tiles count as free for the growth, and their connections are routed again (with the
`splitter-tap` topology, so the tap is rebuilt as a tap). `startGrow` maps a rerouted tap edge to its new route and its
root (as the conflict reroute already did) and reserves every rerouted route's tiles. T1 `grow.test.ts`: a mine feeding
two smelters through a tap grows; both connections are rerouted, every piece of the old tap is picked up or kept, the
layout checks clean (fails without the fix).

Check on the snapshot: seed 11 resumed from min-0020 grew `coal>power` twice (`rerouted coal>power=>power.in-fuel,
coal>power=>copper-plate…in-fuel`), both growths finished, no repair loop, power stayed up. The run then stopped on a
different failure (next section).

### Acceptance results

Final code commit **ef994fa** (d4476ab is the last behaviour change; f35878b and ef994fa touch tests and the test
runner only). Runs were sequential: suite, then M5 soak, then M6 soak, nothing else running.

| Check | Run | Result |
|---|---|---|
| T1 (`npm run test:unit`, 11 files) | d4476ab | pass (grow: 2 tests, the new one fails without the fix) |
| Full T2 (`npm test`, 8 shards) | ef994fa | **112/112 passed**, 584 s wall |
| M5 acceptance (`m5.toml`, 5 seeds, -j 5, `out/soak/m6a-m5-final`) | ef994fa | **5/5**, no stalls |
| M6a acceptance (`m6.toml`, 5 seeds, -j 5, `out/soak/m6a-final`) | ef994fa | **1/5** (44444) |

Earlier T2 runs this session at f35878b/d4476ab passed every test that ran but flagged shards "stuck": with 8 shards
on this laptop, long validation tests (`smelter copper 4 buffer` 456 s, `the mall makes every product` 529 s) and a
bootstrap file slowed by a leftover B20 faction stayed silent past factorio-test's 180 s output timeout. The bootstrap
file alone runs in 53 s. Fixed by f35878b (factions destroyed after each describe) and ef994fa (900 s per shard).

**M6a per seed** (`m6_scorecard.py out/soak/m6a-final`, game minutes; m6-dev4 was the same config at 38803f5):

| Seed | Pass | v1-done | Techs (of 42) | Red automated | Stage 2 | Green automated | Best 30-min window (× target) | Stopped at | Why | m6-dev4 (38803f5) |
|---|---|---|---|---|---|---|---|---|---|---|
| 11 | no | — | 16 | 34.5 | 32.4 | — | 0 | 61 | 8 plan failures: cluster 1's green line can't reach the labs' green input (`no path`) | stall 175 (power starved, fixed) |
| 222 | no | — | 17 | 38.4 | 35.6 | — | 0 | 195 | 2 stalls: cluster 3's shared coal outpost has no feasible position | **pass 228** |
| 3333 | no | — | 23 | 30.9 | 28.9 | 72.9 | 0.39 | 115 | 8 plan failures: cluster 2's shared coal outpost has no feasible position | same, 92 |
| 44444 | **yes** | **249.0** (sustained 233.0, techs 248.4) | 42 | 40.8 | 38.9 | 76.0 | 1.07 | 249 | — | pass 249 (identical) |
| 555555 | no | — | 20 | 29.5 | 27.0 | 70.4 | 0.17 | 164 | 2 stalls: the steam block's coal outpost is depleted | same, 153 |

Seed 222 regressed. Its pre-session pass needed the cluster-3 coal outpost to fit at the second region size; with the
growth fix its coal outposts grew differently (a `coal>power#2` growth was also abandoned by B20 on an unplaceable
drill ghost at 10.5,342.5, no taps involved) and no coal spot was left for cluster 3. It fails in the same class as 3333
(coal running out, P36), not on the fixed bug. Seed 44444 never grew a tapped producer, so its run is identical.

**M5 regression** (minutes to automated red science, `m5.toml`):

| Seed | M5d (98f9b39) | M6a final (ef994fa) | Δ |
|---|---|---|---|
| 11 | 32.9 | 34.5 | +1.6 |
| 222 | 41.8 | 38.4 | −3.4 |
| 3333 | 36.4 | 30.9 | −5.5 |
| 44444 | 37.9 | 40.8 | +2.9 |
| 555555 | 31.8 | 29.5 | −2.3 |
| mean | 36.2 | 34.8 | −1.4 |

**Work counts.** M5 run vs `m5-work.json` (98f9b39): all seeds together every counter is at or below the baseline
(planner work 0.81×, router expansions 0.71×, path requests 1.08×); 3 flags, all seed 11 (placement candidates 1.37×,
path requests 1.30×, jobs 1.23×) on a run 2 min longer, plus peak-per-minute flags for path requests on four seeds
(about 2×: B19's tap goals and the boxed-in pick-ups add walks early). M6: there was no baseline; this session wrote
`tools/harness/baselines/m6-work.json` from `m6a-final` (ef994fa). Totals: seed 11 (61 min) planner work 3.09M; 222
(195 min) 14.11M; 3333 (115 min) 17.63M; 44444 (249 min) 5.67M; 555555 (164 min) 2.58M. The failing seeds' totals
are dominated by the repeated failed outpost placements (placement candidates 12–16M on 222 and 3333); the baseline is
for regression signals only, not a target.

### Open failures (hand-offs to M6b)

1. **Coal runs out (seeds 3333, 222, 555555; P36, proposed).** Not a planning bug.
   - 3333: in the failed plan's capture (`out/soak/m6-dev4/seed-3333/failed-plans/1/g14-a2-*.input.lua`) the only coal
     patch within 168 tiles of the hub has 314 tiles, 210 under the faction's own entities and 38 under trees; the
     66 free tiles are scattered, and a 2-drill outpost (5 × 7) fits nowhere. Larger regions (252, 378) fail too.
   - 222: the same for cluster 3 at 195 min (it fit at the second region size before the fix).
   - 555555: the first steam block's coal outpost reports `depleted` (`no_minable_resources`) at ~150 min and every
     electric consumer loses power (D28: no relocation in v1).
   - M6b: P36 (a) replace a depleted steam-block coal supply (D28 exception like D43), (b) when a fuel producer can't be
     placed, tap the nearest built coal producer and grow it, or wait, instead of failing the goal. A coal patch
     search farther than `OUTPOST_FAR_RADIUS` (192) with a long belt is a fallback. Needs the user's decision on D28.
2. **Seed 11: cluster 1's green line can't reach the labs (new after the fix).** From the min-0020 snapshot with the
   fix, `coal>power` grows twice and `power#2` is built; the cluster-1 green goal (1 module, 2 connections) then
   fails all 8 attempts with `logistic-science-pack>labs=>labs.in-logistic-science-pack: no path`. Rendered
   (`render.py frame-000216000.json --graph failed-plans/1/g9-a1-*.graph.json`): the labs and red line sit inside a
   ring of fixed routes (the rerouted coal line and the ore lines), so no new belt can reach the labs' green port and
   fixed routes are never ripped. M6b: when a connection to a built module has no path, rip and reroute the fixed
   routes around that port (like the conflict reroute), or let cluster 1's share drop to 0 for green (new labs in
   cluster 2). Replay input: `out/soak/fix11/seed-11/failed-plans/1/g9-a1-t211770.input.lua` (a T1 replay fixture).
3. **Unplaceable growth ghosts without taps (seed 222, `coal>power#2` at 10.5,342.5).** B20 abandons the growth after
   10 rounds, which is the intended escalation, but the cause was not looked at (no snapshot taken in this run).
   M6b: re-run 222 with `--snapshots 20` and probe the ghost's tile like seed 11's (probe script pattern in this
   report's fix section).
4. **`mall short (0/0.25): cannot grow`** appears in every failing seed's waiting list: the mall's growth has no
   expansion units (`units < 1`). It does not hold the stage, but it means the mall output is never measured above 0;
   check in M6b whether the mall is measured at all (its chests are emptied by the crew).

### Backlog status

| # | Status |
|---|---|
| B14 | fixed a08877b (buffer heads on assembler rows and circuit blocks, 2 slots). |
| B15 | fixed baf27d3, 3406876 (bootstrap sites are clearable and evicted; leftover ghosts evict sites under them). |
| B19 | fixed 7d93796, 38803f5, d4476ab (shared providers through splitter taps; a growth now carries its taps along). No distance check yet (P32). |
| B20 | fixed 7d93796, 6db6e37 (planned outpost over a live bootstrap site: T2; stuck builds escalate after `build-stuck-rounds`; boxed-in crew members unbox themselves). |
| L3 | later (not M6a). |

### Magic numbers for the user

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `factory-targets` (stage 2) | `settings.ts`, `strategy/stage.ts` | `automation-science-pack=10;automation-science-pack=30,logistic-science-pack=30` | The v1 bar (§3) after D37's stage 1. | yes |
| `factory-design-margin` | `settings.ts`, `strategy/factory.ts` | 1.1 | Designed 10% above target so the measured rate reaches it (belt and inserter losses). | yes (new) |
| `factory-lab-sizing` | `settings.ts`, `strategy/design.ts` | `mean;max` | Stage 1 D37's mean unit time; stage 2 the slowest (30 s) so labs never cap 30 + 30. | yes (new) |
| `factory-sustain-minutes` | `settings.ts`, `strategy/stage.ts` | 30 | The §3 bar. | yes (new) |
| `module-buffer-slots` | `settings.ts`, `modules/buffers.ts` | 2 (was 1) | D51 (1), user decision. | yes |
| `factory-shared-providers` | `settings.ts`, `strategy/stage.ts` | 1 (from stage 1; 0 = never) | B19: share from the start once splitters exist. Replaced `factory-shared-fuel` (3406876, stage 2 fuel only). | yes (new) |
| `logistics-share-min-modules` | `settings.ts`, `strategy/factory.ts` | 1 | Research splitters first when sharing saves at least one module (like D36's threshold, guess). | yes (new) |
| `build-stuck-rounds` | `settings.ts`, `strategy/design.ts` `stuckRounds` | 10 rounds (30 s apart, ~5 game-min) | Long enough for the crew to fetch items, short enough not to hold a stage (guess). | yes (new) |
| `GROW_MAX_FAILS` | `strategy/stage.ts` | 3 | A growth that failed 3 times no longer holds the stage (`power#2`, cluster-1 cap follow). Guess. | no |
| Cluster-1 cap floor | `strategy/factory.ts` `startGrow` | 0.05 | Cluster 1 keeps at least 5% of the target when a module can't grow (never zero). Guess. | no |
| `redLine` expansion cap | `modules/generators.ts` | 10 units (`10 - units`) | Guess: keeps a red line within ~120 tiles; no game limit. | no |
| `labArray` expansion cap | `modules/generators.ts` | 10 units (`10 - units`) | Guess: same reason (8 tiles per unit). | no |
| `OUTPOST_FAR_RADIUS` | `planner/placement.ts` | 192 tiles | One more search ring for mining outposts beyond the policy's radii (ore near the core runs out); within the plan's region. Guess. | no |
| `TRAPPED_NO_PATHS` | `jobs/crew.ts` | 3 walk failures in a row (B22: no-path walks, stuck and unreachable re-path loops; only a finished *walk* resets it) | Boxed-in detection: one or two failures happen on busy sites. Guess. | no |
| `UNBOX_RADIUS` | `jobs/crew.ts` | 3 tiles | The own entities around a boxed-in member it may pick up (within reach). Guess. | no |
| `UNBOX_TREE_RADIUS` (B22) | `jobs/crew.ts` | 3 tiles | How far around a boxed-in member it looks for neutral trees/rocks to mine through. Guess. | no |
| `UNBOX_TREES_PER_ESCAPE` (B22) | `jobs/crew.ts` | 16 | Most trees/rocks one escape mines before it walks on (the walk re-checks the rest); enough to open a dense seed-222-style ring in ≤2 escapes. Guess. | no |
| `UNBOX_RETRY_TICKS` (B22) | `jobs/crew.ts` | 600 (10 game-s) | Wait before the next escape attempt when the last found nothing to clear (instead of dropping work every cycle). Guess. | no |
| `ROW_BUFFER_W` | `modules/generators.ts` | 2 columns | Buffer head width on assembler rows / circuit blocks (belt + inserter + chest). Layout-derived. | no |
| `SCIENCE_SAMPLE_TICKS` | `strategy/stage.ts` | 3600 (1 game-min) | Sample period for "sustained" (P31). | no |
| `SCIENCE_MAX_SAMPLES` | `strategy/stage.ts` | 600 (10 game-h) | Keeps the 8-h run's samples with margin; bounds storage. | no |
| `automated:<pack>` threshold | `strategy/stage.ts` | 10 packs consumed | A pack counts as automated once labs used 10 machine-made packs. Guess. | no |
| m6.toml fail-fast deadlines | `tools/harness/m6.toml` | `automated-red-science` 1.5 h, `stage-2` 3 h, `automated:logistic-science-pack` 5 h | Stop seeds that can't reach 8 h's bar; harness only. | config |
| m6.toml fail-fast counts | `tools/harness/m6.toml` | 2 stalls, 8 plan failures in a row, 20 ghost rounds | Same as M5. | config |
| `SHARD_OUTPUT_TIMEOUT_S` | `tools/test-parallel.mjs` | 900 s | T2 only: long validation tests under 8-shard contention were silent > 180 s while passing. | no (test tooling) |

`SITE_MIN_LIFE` (2, D43) is reused by the B15 site search, not new.

### Open proposals (all proposed, none approved)

- **P30** the 30 + 30 stage: `factory-targets` default, design margin 1.1, two production clusters around one steam
  block, labs sized `mean;max`.
- **P31** "sustained" = packs consumed by the labs, sampled every game-minute, averaged over `factory-sustain-minutes`
  (30) consecutive minutes.
- **P32** shared providers through splitter taps from stage 1 once splitters exist; splitters researched first when
  sharing saves ≥ `logistics-share-min-modules` modules; no distance check yet.
- **P33** a growth that fails 3 times no longer holds its stage; a steam block that can't grow gets `power#2`; a
  cluster-1 module that can't grow caps cluster 1's share.
- **P34** stuck builds give up after `build-stuck-rounds`; a crew member with 3 no-path failures in a row unboxes itself.
- **P35** bootstrap sites are clearable ground for plans (evicted, replaced elsewhere; the depot never).
- **P36 (new)** coal running out for power and the green clusters: replace a depleted steam-block coal supply (a D28
  exception limited to power fuel, like D43), and let consumers whose fuel producer can't be placed tap the nearest
  built coal producer and grow it. Not implemented.

Full text in SPEC §11.

### Time breakdown (wall clock, estimates)

Session of 2026-10-17 (close-out), about 4.5 h wall clock in all:

- (a) Full T2 suite: 4 runs, 21 + 14 + 13 + 10 min ≈ **58 min** (the first three flagged stuck shards; see above).
- (b) Targeted tests: T1 grow tests and full T1 ×3 (~2 min), bootstrap file alone (1 min): **~3 min**.
- (c) Soaks: seed 11 snapshot probe 1 × 1 (0.2 min), seed 11 fix check from min-0020 1 × 1 (3.5 min), M5 acceptance
  5 seeds × 1 (14 min), M6a acceptance 5 seeds × 1 (61 min): **~79 min**.
- (d) Everything else (reading, log and snapshot diagnosis, the fix, report, SPEC/BUGS): **~2 h 10 min**, an estimate.

The 2-hour fix budget was spent on the seed-11 diagnosis and fix; the 3333/555555 coal problems were diagnosed but
not fixed (P36), and the seed-11 follow-up failure surfaced only in the final soak window.

## M6a.2: seed 222 — depot ring, stale terrain, inverted tap chain (2026-10-17/18)

Picked up the dead session on seed 222 (manager `cd92ceea` + fix subagent died 2026-10-17 08:08 UTC, work at
`c058d19`). Seed 222 stalled twice in M6a.2 (m6a2-dev1, 123 game-min): the stage-2 growth stall, then the green line
failing `no path` at every region radius. Live probes from the min-0120 save (dev2–dev10, entity/terrain/route
classifications every 10 game-min) found **three independent bug classes**, each sufficient to stall the run:

1. **The lab's in-logistic port is walled in by depot 22** (reservation staleness). Depot 22 (a "depot full" spare
   chest, site 22) was built at (-42,482) with its 25-tile reservation ring. The lab n3's in-logistic port
   (approach (-42,484), destination (-42,485)) can only be entered through that approach tile, and the approach's
   three outside neighbors (-42,483), (-43,484), (-41,484) are depot 22 ring tiles. Depots were never evictable
   (evict.ts `evictable` excluded `kind === "depot"`), and depots are never retired (D43 skips them), so those tiles
   read as hard OWN for good. A 520800 probe classified all 1631 OWN tiles: 1160 legit terrain, 259 module margin
   orphans (by design), 107 retired-site tiles (sites 2/4/6/14/23 — `retireSite` never released `site.tiles`), and
   125 depot ring tiles (sites 1/22/26/28).
2. **Character mining leaves stale terrain** (no events). The crew's pick-up is the only pickup path
   (crew.ts "clear" → "pickUp" → `mining_state`), and it raises **none** of the 8 events the terrain model listens to
   (there is no `on_deconstructed_tile` in this Factorio version); `ghost.destroy()` is silent too. Probe: site 23's
   drill (-46,467) and chest (-45.5,468.5) present at 432000, gone by 540000 (item on the ground), zero terrain
   events in the region → 44 terrain=3 tiles with nothing on them. The dirty queue also drained only during planner
   entries, so removals during builds sat stale for hours.
3. **The coal tap chain is inverted for growth** (planner). The main `coal>power` route (to n1) has
   `tapOf` = the iron route, which has `tapOf` = the copper route (to n17, the root): the route touching the growth
   module is the **deepest tap**, and `planGrowth`'s rip loop skipped every route with `tapOf` set. Nothing was
   ripped, (41,367) stayed in `routeOcc`, and n1's +2 growth failed with `route at 41,367`. Two earlier failures
   (dev1) plus this one hit `GROW_MAX_FAILS` (3) and blocked the growth for the stage; the `power#2` fallback (n19/n20)
   carried on instead.

**Fixes (all on `m6-v1`):**

| Fix | Where | What |
|---|---|---|
| Depot evicts | `strategy/evict.ts` `evictable` | Depots evict like any bootstrap site: a plan taking the chest's footprint retires the depot, the crew picks it up, the bootstrap rebuilds a depot near the hub. Ring tiles read as clearable ground (TREE) even before eviction. |
| Retired sites release their ground | `strategy/evict.ts` `resyncReserved`, `strategy/bootstrap.ts` `retireSite` | `retireSite` clears `site.tiles` from `brain.reserved` at retirement (standing parts stay protected by the terrain scan until picked up); the resync skips retired sites' tiles (cleans pre-fix saves). Failed sites keep their spot (bad ground). |
| Tap chain rips to the root | `planner/grow.ts` | A route touching the module is walked up its `tapOf` chain to the group root (deduped); the root is ripped (taps come with it) and every route in the group is rerouted. The reroute region now covers every module a rerouted connection touches (the coal taps feed smelters ~110 tiles west of the grown steam block). |
| Drops and pick-ups rescan | `planner/terrain.ts` `destroyEntity`, `tick.ts`, `character/controller.ts`, 7 destroy sites | `destroyEntity` (destroy + `markDirty`) at every ghost-drop site (evict, factory ×2, bootstrap ×3, conflicts); the character controller remembers the box of a pick-up target and of covering obstacles and rescans when they vanish; `onTick` drains every terrain's dirty queue (budget: the existing `terrain-chunks-per-tick` setting) so a synchronous growth between planner entries never reads stale ground. |
| Hand-fuelling skips grown producers | `strategy/fuel.ts` `producerGrowing`, `strategy/factory.ts` `upkeep` | P36 (a)'s hand-fuelling no longer fires while a steam block's fuel producer is being grown (its built drills run through the growth); at build priority it starved the growth's own craft jobs and stalled the stage (the g8 stall, fixed earlier this session, validated on dev5: g8 done at 436800). |

**Validation (m6a2-dev11, seed 222 from min-0120.zip, 156 game-min).** Probes at 432300 and 520800:

- `growth_debug("1","n1",2,41,367)`: `ok=true`; tile (41,367) owned by `coal>power` before, free after. The tap chain
  in the save is exactly the inverted one (main route `tapOf`=iron, iron `tapOf`=copper, copper root).
- The growth happened in game: `grow-built` at 51.6 game-min (dev5: third failure, blocked).
- The green line planned and was adopted (g11, t457740); at 520800 its route runs through depot 22's ring tile
  (-41,484) → approach (-42,484) → destination (-42,485), all in the layout as the `in-logistic` route.
- Retired sites' ground released: (-46,467) (site 23) and (-45,468) (site 4) no longer reserved.
- No new stalls (the 108.1-min stall in the scorecard is from the pre-save original run). Work counts: one flag,
  `routerExpansions` 1.82× — the successful growth rerouted the whole coal group (3 routes) over the scanned terrain,
  while the baseline run's growth had failed before any reroute; a one-off, not a per-tick cost.

**Tests.** T1 `grow.test.ts`: a mine feeding three smelters where the growth target is fed by a tap — the whole
group rips and reroutes (fails on the old code with `route at 16.0,28.0`, the same failure mode). T1 `evict.test.ts`
(new): depot tiles are clearable; evicting a built depot retires it, releases its tiles and queues a replacement
depot; the resync releases retired sites' tiles and keeps failed/active ones; `destroyEntity` marks the chunk dirty.
`plan-replay`: the failed 520800 capture still fails as captured, succeeds with depot 22's ring freed (the fix), and
the same plan as dev11 saw it (depot ring clearable in the capture, fixture `m6a2-seed222-green-line-dev11`) plans
with 0 rip-ups. `tsconfig.unit.json` now includes the Factorio runtime types and `storage.d.ts` (the evict/terrain
imports need the Factorio globals). Debug remotes `reserved_debug` and `growth_debug` (marked "Debug probe (M6a.2)"
in `remote.ts`) stay for the acceptance run.

### Acceptance results (M6a.2)

**Round 1** (`m6a2-accept`, pre-B24): seed 3333 died silently at 21 game-min — the B24 Lua crash inside
`materializeMinePlan` (whole-patch placement put a pole under the complete stage's belt layer). Killed and relaunched
fresh on a fixed build as round 2.

**Round 2** (`m6a2-accept2`, at commit `06ed5d` = B23/B24 fixed): launched Sun Oct 18 ~22:57, all 5 seeds
(11/222/3333/44444/555555), up to 8 game-h each, fail-fast per config. **Finished Mon Oct 19 ~00:20 after 5543 s wall:
0/5 seeds reached `v1-done` — bar (≥ 4/5) not met.** The four fast deaths decompose into three classes (all diagnosed
from the harness's `factorio-current.log` / failed-plan captures; evidence in `out/soak/m6a2-accept2/evidence/`,
scorecard at `out/soak/m6a2-accept2/scorecard.md`):

| Seed | Killed (game min) | Class |
|---|---|---|
| 3333 | 86 | B28: every feed into the mall "no path" (copper/iron ore + fuel), all attempts, all regions |
| 44444 | 179 | B28-family: copper ore feeds to the mall-era smelters "no start"/"no path"; iron request "no feasible position" |
| 555555 | 201 | B27 (fixed 8bcf577 that evening, too late for this run): shared mine completion blocked by earlier own poles/routes on its unbuilt footprint |
| 11 | 205 | B29 (open): power short → grow attempts blocked (`ore at`, `blocked at`) → 2 stalls |
| 222 | 361 | B27-class (shared mine n27 blocked at 18,346) — exactly the shape B27 fixes; died before the fix existed |

Confirmed-side signal: rail-then-soak validation held (B23/B24 fixes verified on capture replays before launch;
seed-222's whole run ran past its old M6 mall death at ~195 game-min with zero stalls of that kind, seed-555555
reached `automated logistic-science-pack` (its m6a blocker is gone), and the harness's fail-fast killed every
wedged seed within one goal cycle — no silent deaths this round).

Acceptance remains **pending**: the fix set needed for a passing run is B27 (landed) + B28 part 2 (open: placement
route-awareness for feeds boxed in by the infra web) + B29 (power-short growth priority). Relaunch full 5 seeds on a
build containing them.

### Magic numbers for the user (M6a.2)

No new settings: the global terrain drain reuses `terrain-chunks-per-tick` (default 2). `GROW_MAX_FAILS` (3) and the
reroute region padding (±96 tiles) are unchanged.

## M6a.2: B21/D52 whole-patch mines and the mall's iron request, B23 (2026-10-18)

The m6a2-b21l soak (seed 222, the B21 tree) stalled on the mall's iron-plate request (goal g11, attempts at ticks
299250–403410): every retry died `no feasible position` at placement, and retries at earlier goals (g10, the
iron-ore request) drifted the base between captures, which is why the g11 capture holds debris the g10 attempt built.

**Diagnosis (raw-Lua replay of the g11 capture, diag17–diag46).** Three original gaps, each sufficient to fail the
goal:

1. The request could not target the base stage-1 whole-patch iron mine n16 (fixed, 25 of 286 entities built, building
   area 838 tiles): expansion targeting needs the mine unfixed, so the planner only tried a fresh 4x2 outpost — no
   room on the claimed field.
2. Adoption could not complete a fixed mine even if it had targeted one: `wholePatchCandidate` only admitted unfixed
   mines, and 131 tiles of n16's unbuilt building area were reserved — retired bootstrap sites' entities nobody
   picks up (the same stale-reservation class the depot-ring fix addressed for `evictable`, here for mine claims).
3. The failure message described the fresh-mine attempt and said nothing of the real cause.

Fixing these surfaced three more, each fatal in its own right and none observable until a later phase ran (the
parser died at placement, before routing): (4) the completion check re-verified ore under every planned drill —
planning already validated the whole patch, and drills legitimately reach across patches, so completion demanded more
than planning and could never pass; (5) `sameSource` compared raw module ids (`n22`, the request's alias) with
committed routes' ports (`n16`) — an iron-ore tap of the base mine's own route was never found and died as a
1-expansion start inside the fixed base route's corridor; (6) a belt-in port's feeder belt must stand on the port's
outside tile, but that tile carries the module's built interaction perimeter (real g10 build output) reading as hard
OWN — the goal was unreachable by construction (`router.ts` now admits a tile reserved as one of the searching
route's own ports).

**Fixes (bec529b):** adoption evicts sites standing on a mine's claim and then completes the built mine — the
finished shape is planned as a diff of not-yet-built entities, queued as clear jobs over the evicted ground, and
stamped by `stepBuild` via the new `extraAdd` ghost list after the clear phase; `wholePatchCandidate` admits a fixed,
not-yet-complete mine (completion adds entities, moves nothing — the out port is identical in both shapes); the ore
re-check is dropped from completion; `sameSource` takes the alias-resolved port; and a failed completion is recorded
on the job (`PlanJob.wholeFail`) so the module's failure names the shared mine and the blocking tile
(`… (shared mine n16: planned mine blocked at -47,500)`) instead of the misleading fresh-mine wording.

**Tests (T2 `plan-replay`, fixture `m6a2-seed222-mall-iron`):** as-is, the plan now works around the debris with a
fresh mine (a legal outcome — previously it hard-failed); with the evicted sites' pickups freed (what the in-game
eviction does), the request completes the shared mine: `alias n22→n16`, the mine's plan is whole and the full 838-tile
claim is occupied; and a sabotaged completion (foreign ground under the first not-yet-built belt at (-47,500)) leaves
`wholeFail["n22"] = "n16: planned mine blocked at -47,500"` before any fallback, checked step-by-step so it does not
depend on Lua table order. Codex's B21 work (whole-patch drill plans `mine-plan.ts`, D52, and the rest of the
uncommitted 25-file tree) landed in the same commit bec529b.

## M6a.3: B22 the stuck member — unboxing becomes a real escape (2026-10-18)

The M6 unbox (6db6e37) covered only part of the stuck-member problem, as the B22 row describes: it triggered only on
3 straight "pathfinder found no path" walk failures (members looping "stuck"/"unreachable" re-paths never triggered
it, and any successful action — a standing craft, a transfer — erased the count), it could only pick up small own
entities within 3 tiles (big machines, walls, and all neutral trees/rocks were invisible to it), and with nothing to
pick up it logged and dropped its work, re-triggering every cycle forever.

**Fix (1b198fd, `jobs/crew.ts`):**

- The trigger now counts `stuck` and `unreachable` walk failures equally, and only a finished *walk* action resets
  the count (a standing action says nothing about mobility).
- The escape is chosen from what the member can act on **from where it stands** (`can_reach_entity`) and ordered
  cheap first: its faction's own entities one at a time, small types then walls and big machines (the pick-up leaves
  a ghost with the entity's recipe, so a picked-up assembler re-places with its recipe); if no own structure stands
  in the way, it mines the neutral trees and rocks in its reach — all of them, up to `UNBOX_TREES_PER_ESCAPE` (16),
  so a dense ring actually opens instead of one tree per cycle.
- With nothing nearby to clear it no longer drops its work every cycle: the attempt waits out
  `UNBOX_RETRY_TICKS` (600) before unboxing again, and the member's jobs keep running through the board's own
  failure handling (penalised releases, `jobMaxAttempts`) — the real escalation path when the walk is unfixable.

**Tests (T2 `jobs.test`):** a member boxed in behind two staggered tree rings (seed-222-style density, 28 trees)
mines its way out and builds its chest; a member enveloped by its own assembling machines (pitch-3 ring, boxes
touching in a continuous wall) picks one up, gets out, builds, and the machine is re-placed. Both pass `stats.unboxed`
matches: the tree case mines (no ghosts), the machine case picks up. Full suite 115/115 at 1b198fd.

## M6b: B16 the factory-graph GUI window (2026-10-19)

The B16 row: a factory-graph window beside the map overlay, like the vanilla production graph — nodes with
planned vs measured rates and status, edges as plain relationships, laid out to be understood rather than to
match real positions. The overlay (M5b) needs a spectator in the base and clutters with many modules; the dumps
leave the game. This window is a per-player screen frame read at the same cadence as the inspector.

**What (`review/graph-window.ts` + `review/graph-layout.ts`, SPEC D29 note):**

- Hotkey `Ctrl+Shift+G` / a shortcut-bar button (own shortcut prototype, same icon scheme as the inspector's);
  the faction ◀ ▶ buttons share the inspector's per-player faction selection.
- **Layout by dataflow, not position:** `graph-layout.ts` is pure (no Factorio globals) and computes each
  node's depth from its belt/crew inputs (power edges are drawn but do not shape the layout; a cycle's leftovers
  share one level past the deepest resolved node). The window draws one column per depth, one chip (button) per
  node tinted with the overlay's status colours — grey when `planned`/`building` — with its measured/planned
  output (power: load %) under it, and the status counts in a header.
- **Plain edges:** a bordered table — From · To · Item · Plan · Measured · Probe — reusing the reconciler's own
  `edgeVerdict` (stale/full/intake/broken/sparse), so the window and the remedies language never disagree.
- Root cause and status reason sit in each chip's tooltip; clicking a chip takes your camera to the module in
  the base (`findModule` + `goTo`), which is where the map overlay takes over for the real geometry.
- No factory yet (or an empty graph) prints a note instead of an empty frame; the window never writes to AI
  state (the `model.ts` rule) and every new number it could have invented was avoided: it reuses the overlay's
  `MAX_NODES`/`MAX_EDGES` caps and the inspector's refresh cadence and frame sizes.

**Tests:** T1 `unit/graph-layout.test.ts` (4 tests): levels for outpost → smelter → gears with a power edge in,
cycle leftovers, crew-fed edges, verdict rows, status counts and cause text. T2 `test/graph-window.test.ts`: a
faction with a hand-built two-node chain (reconciler.test.ts's pattern) — the layout is asserted headless
(levels, counts, verdict) and, with a player, the window opens, renders 2 chips sharing the faction cycle, and
closes; a faction without a factory gets the note. Registered in `control.ts`.

## M6b.1: B17 preemption — collect-first material sourcing (2026-10-19)

The B17 row: a soak (`faction b17-a`/`b17-b` labs, the `B17 probe:` log lines during development) showed the crew
hand-mining ore while bootstrap furnaces held full plate stacks. The brain's collect transfer jobs were open and
ready the whole time — root cause is on the crew side: `planNext` only fires between batches (when a member's
actions empty), and `selectJob` never interrupts work already in flight, so an open high-priority transfer had to
wait for every busy member to finish a whole low-priority gather batch first.

**Fix (951e1da, `jobs/crew.ts`):** crew preemption. `stepFaction` checks each member with work in flight
(claims + queued actions) against the open board first; when a **strictly higher-priority ready** job exists and is
worth the drop (`isPreemptable`: fuel jobs or a transfer payload — a back-off or claimed job never pulls a member
off started work), the member preempts itself: `resetMember` drops the whole batch (claim release without the
failure penalty) and it re-plans on the next tick, where plain priority ordering sends it to the preempting job.
`CrewStats.preemptions` accounts the drops. No new setting or constant: it reuses the existing priority table
(fuel 100 > place 90 > transfer 60 > gather 20), so a preempt only ever moves work *forward*.

**Tests (T2 `test/bootstrap-sources_test.ts`):** two labs, empty depot chest, a plated furnace with 100 plates.
1. The basic collect round trip on an idle crew (plates reach the depot; no ore patches in the lab, so the
   collect is the only plate source).
2. Preempt-over-hand-mining: `tripMaxJobs=1` (test-only override — otherwise `planTrip` chains the row of 12
   neighbouring trees into two members' trips and the third never gets work, so the crew can't be saturated),
   wait until all three members are provably in flight on gather jobs, then inject a craft demand and force a
   think; the collect transfer appears into a saturated crew where only a preemption can claim it. Asserts
   `preemptions > 0`, the depot empty at inject, and the trees surviving the dropped batch.

Both pass in-tick (~0.5 s). The soak probe code itself (the `B17 probe` diagnostics) was never committed —
stripped from the fix. Full suite (119 tests, 12 shards) green.

### Magic numbers for the user (M6b.1)

None new: preemption uses the existing priority table, and the engine-capability numbers it relies on (reach 10,
character speed) were already measured in `engine-capabilities_test`.

## M6b.2: B18 proactive temp-cell stocking (2026-10-19)

The B18 row: temporary factory cells (D38 "chest cells") were fed only when an order asked for their product
(`feedTempCells` runs inside the produce pass) — with no request in flight the input chest drained, the cell
stopped, and there was no buffered output to serve a later request. The user's P26 check in game kept tripping
over dry cells.

**Fix (32076d2, `strategy/bootstrap.ts` `topUpTempCells`):** every think (after `reconcile`), each **built** cell's
input chest is topped up to the same buffer the demand feed uses (`bootstrap-factory-wait-seconds` of the cell's
output; a powered, non-marked machine only) from the depot's surplus — requests win, what they leave stocks the
cells. Each ingredient is one keyed `tempfeed:` **fuel** job, the same keys the on-demand feed uses, so the two
passes never double-book (what a refill is already bringing counts across thinks), and only enough to reach the
buffer is reserved (`addDemand`). The refills' competition with other work is the new
`bootstrap-temp-cell-feed-priority` (default **40**: above gather 20, below the collect transfers 60, so a furnace
collect still preempts an in-flight refill — §5.5 collect-first holds; **0 = never stock proactively**). The D38
feeds stay at `feed` (55). `tempCells` now takes an optional item (so the pass sees every cell) and carries the
cell's product.

**Tests (T2 `test/temp-factory.test.ts`, sharing the extracted cell builder):** a quiet economy (no goals, no
sites, replan held off by a `stallTicks` override) with a depot of 200 plates: the input chest is topped up exactly
to the target with **nothing anywhere asking for the cell's product**; the setting steers the refill job's priority
(65) and **0** queues no refill. Full suite (122 tests, 12 shards) green.

### Magic numbers for the user (M6b.2)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `bootstrap-temp-cell-feed-priority` | `settings.ts`, `strategy/bootstrap.ts` | 40 | Between gather (20) and craft (50): refills beat hand-mining but never pre-empt the §5.5 collects/fuel; 0 = off (P26 pending). Guess. | yes (new) |

## M6b.3: B25 belts spilling off module edges (2026-10-19)

The B25 row: a mall belt ran to the module edge and dropped iron plates onto a neighbour's belt. **Root cause: module
templates, not transforms or placement.** A geometric check over every module showed the same defect in seven
places: the curated mall's two-belt trunk ended on row 0 pointing out of the north edge (the source blueprint's
magazine assemblers it once fed were cropped away); `green-line-hellpet`'s copper, iron and row-7 pass-throughs ran
out of the west edge (noted as "tileable pass-throughs" when curated); `red-tile-ramqvist`'s copper and gear belts ran
out of the bottom edge; and every non-buffered row generator (assembler row, red line, circuit block, lab array)
let its input belt's head tile flow west off the module — so a gear row's iron plates spilled onto whatever ran
past, typically its own output route leaving the west port. Transforms preserve inside/outside, so every orientation
had the same leaks. (The planner already reserved the outward tile as an interaction tile, but that only keeps
routes off it while the layout state holds; any belt there still received the items.)

**Fix:** curated specs edited and rebuilt with `curate.py` (mall: trunk row 0 removed, the trunk now ends at the
pipe-to-ground assembler's inserter; green line: copper end turns south into its inserter, the unused west tiles of
rows 5 and 7 removed; red tile: the last copper/gear tiles turn west/east into an empty tile and the picking
inserter). Row generators drop the input belt's head tile after slicing the growth unit (`dropBelt`): nothing picks
from it. **Validation:** `geometry.ts` `beltLeaks` (a belt, an underground exit or a splitter half whose output tile
is outside the footprint, with no `belt-out` port there pointing the same way) and `finalizeModule` errors on any
leak. Growing a module that already leaks (an old save's stored layout) skips the check, and head growth
(`expandHeadModule`) that would open a belt returns undefined, so `tryExpand(..., "head")` refuses it
(`HEAD_GROWTH_OPENS_BELT`). That refusal covers every module with a port or belt end at its head, mining outposts
included: their head growth used to bury the output port and run the ore off the new north edge. `planGrowth` keeps
the usual end's failure reason in that case. T1 now also loads the curated data (`tools/curated-lua.mjs`, shared
with the mod build).

**Tests (T1 `modules`):** "B25: no module belt feeds out of its footprint …" (every generated module at base size
and grown by 1–2 units, plus every curated module, in every allowed rotation and mirror); `beltLeaks` cases (belt,
underground exit vs entrance, splitter halves, a port pointing elsewhere or a belt-in port doesn't excuse it) and
`finalizeModule` refusing a leaking draft; row-module input belts end under the first inserter, and head growth is
either leak-free or refused. No new T2 test: the leak is purely geometric, and the T1 check covers every template
the library can produce. The T2 validation lab still stamps the changed modules.

**Proposed (not approved):** placement's D52 mine-site check still counts head-growth ore (`firstGrowthCoverage`
"head"), although mining outposts can no longer grow at the head (SPEC §11 P37). The scorer should drop it, but it changes mine
placement and needs replays, so it is left for a decision.

No new magic numbers.
