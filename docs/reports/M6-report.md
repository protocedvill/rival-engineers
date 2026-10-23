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

## M6b.4: B31 preemptions only for urgent refuels, one member each (2026-10-19)

The B31 row: after B30, a 10-game-min 2-faction soak (seed 11) still logged 608 preemptions (~15 per member and
game-minute), 82% wasted: every busy member preempted for the same new job (88 lost the race), and 439 re-plans
started with a deposit (brain factions empty the pocket before any job), so the interrupted trip went to the depot
first. Most triggers were routine (ore feeds p55, collect transfers p60, refuels p100), firing on the job's creation.

**Fix (`jobs/crew.ts` `preemptForUrgent`, run once per faction tick after the members):**
1. **One member per job:** no preemption while any member is idle (idle members plan every tick, so one takes the
   job, or none can). Otherwise only the nearest eligible busy member preempts, and it re-plans in the same tick
   with the job as its forced anchor (`CrewMember.preemptFor`, in storage). The others keep working.
2. **Urgency gate:** only a refuel (fuel job of an item with a fuel value) whose *running* target has less than
   `preempt-fuel-seconds` of fuel left (burning remainder plus the fuel inventory, at max consumption). A machine
   already out of fuel is not urgent (it has stopped; the priority-100 job is taken at the next plan). Ore and lab
   feeds and **collect transfers never preempt**: the user clarified in-session (2026-10-19) that crew should not walk
   off work to shuffle part stacks from supply points to the depot, while refuelling a machine about to run out
   should win. So the collect-fill threshold first drafted for transfers was dropped. (The user's broader intent,
   taking from supply points directly when a craft or a machine needs the item, is a sourcing change outside B31.)
3. **No deposit first:** the forced re-plan skips the between-jobs deposit (the pocket goes along and is deposited
   at the next plan). Only a member with a free inventory slot is eligible, so the pocket never blocks the job.
   Since every preemption is urgent now, I chose to skip the deposit rather than refuse to preempt.

B17's priority rule and B30's "became ready since the plan, materials available" rule are kept.
`CrewStats.preemptTaken` (telemetry dumps member stats) counts preemptions whose re-plan claimed the job.

**Tests:** T2 "B30 preemption livelock" now bounds preemptions at 10 per member and game-hour (at least 1 in the
window) and requires ≥ 75% taken. Old code: 27 and 23 preemptions per member in 3 min, 0 taken (fails). New: 1 and 1,
both taken, 40 non-haul jobs done (45 before, which included churn). B17 test 2 now asserts a collect does **not**
preempt and the busy crew still brings the plates at its next plan. New T2 test "an urgent refuel pulls only the
nearest busy member off its work, and it takes the job": 3 members busy hand-mining, a furnace with ~22 s of fuel
left gets a refuel job: exactly one preemption, taken.

### Magic numbers for the user (M6b.4)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `preempt-fuel-seconds` | `settings.ts`, `jobs/crew.ts` `isUrgent` | 30 | Refuels are queued at 2 min of fuel left (`FUEL_LOW_MINUTES`). 30 s leaves a member most of a walk to arrive before the machine stops, and only refuels nobody took for ~90 s preempt. Guess. 0 = refuels never preempt. | yes (new) |
| `MAX_PREEMPTIONS_PER_HOUR` | `test/preempt-loop.test.ts` | 10 | Test bound: "a handful per member and game-hour". | test only |
| `MIN_TAKEN_RATIO` | `test/preempt-loop.test.ts` | 0.75 | Test bound: most preemptions must lead to taking the job (was 18%). | test only |
| free slots to preempt | `jobs/crew.ts` `canPreemptMember` | 1 | A member with a full pocket would have to deposit first (point 3). One slot covers the coal for a refuel. | no |

## M6b.5: B32 crew take parts directly from supply points (2026-10-19)

The B32 row (user, in-session 2026-10-19, the intent of B17): when a member needs an item for a job, it takes it
straight from where the faction holds it, instead of the brain creating collect transfers that shuffle furnace
output stacks to the depot (B17's fix) and crew walking off work to do them.

**Design:**
1. **Supply points** (`jobs/supply.ts`, a leaf module). Every think the brain registers the faction's supply points in
   `FactionState.supplies` (storage): the factory's chest-out chests (mall and temporary cells, `supplyChests`), module
   buffer chests (`bufferChests`), and the bootstrap sites' furnace outputs, chest-site chests and pair drills' coal
   above `PAIR_KEEP` (10). Only those within `supply-radius` of the hub (0 = any). The crew reads their live contents
   (cached per tick: idle members plan every tick; the controller, which moves items, steps after the crew).
2. **Availability.** `availableItems` (crew) counts held items + stockpiles + supply points, each source minus the
   takes reserved **at that source** (`FactionState.reservedAt`, by unit number and item), so two members never count
   the same stack. A supply point holding fewer than `supply-min-take` of an item is not worth the walk and does not
   count. The brain's `ctx.stock` adds the same supply holdings (`supplyStock`), so `reconcile` only hand-crafts or
   hand-mines what neither the depot nor a supply point in range holds. Ore-in-depot feeds and the smelting inbound
   count still use the depot and pockets only (`ctx.depotStock`).
3. **The haul** takes the batch's missing materials from several sources in one trip: greedy from the member's
   position, preferring a source that holds the whole remaining need of an item (one stop beats several), then the
   smallest detour on the way to where the batch is worked (the standing spot; a craft: where the member is), ties by
   unit number. Each take is reserved at its source until it finishes. Batch planning for place/fuel jobs plans from
   the nearest source of the first missing item (was: nearest stockpile).

**Collect transfers: removed.** `produce` no longer creates them (`collect`/`collectSources` are gone, and the
`transfer` priority with them). None was needed to keep a machine running: a full furnace, chest site or pair drill
just pauses its drill (H5 already accepted that, since collecting everything filled depot after depot), and the next
job needing the items takes them from there, which un-blocks it. The `transfer` payload kind stays so jobs in older
saves finish. B18 top-ups and D38 feeds are unchanged fuel jobs; their materials now come from supply points too
(a cell's input chest can be filled straight from a furnace), and a cell's output chest counts as stock.

**Tests (T2 `test/bootstrap-sources_test.ts`, describe "B17 material sources"):**
- "B32: a craft needing iron plates is fed straight from a furnace holding plates": empty depot, a furnace with 100
  plates; the 20-gear craft completes with **no plate ever in the depot, no transfer job and no hand-mining**, 40
  plates left in the furnace. Old code (9644eab + this test): fails, "depot plates max 100, transfers 1".
- "B32: two crafts take from different furnaces, never counting the same stack": two furnaces of 60 plates, two
  50-plate crafts: both complete, no job released, 20 plates left (old code fails: transfers 2, depot plates 70).
- "B32: with the furnaces empty, the brain falls back to hand-mining" (passes on old code too: the fallback).
- "B32: a furnace outside supply-radius is not taken from" (`supplyRadius` 5: hand-mining, the furnace keeps 100).
- The B17 busy-crew test now injects the craft into a crew busy hand-mining: no preemption, the plates go straight
  from the furnace to the craft (old code: depot plates max 100). The B31 urgent-refuel test is unchanged.

Filtered T2 runs: "B17 material sources", "B30 preemption livelock", "D38 temporary factories", "D42 buffer depots",
"job board", "burner bootstrap": all green. T1 green. No soak run (manager):
`python3 tools/harness/soak.py -c tools/harness/m6.toml --seeds 222,11 --hours 0.6 --name b32-check --no-build -j 2`
from the branch after building. Look for: no `transfer` jobs; `byKind.haul` share not much above B31's; fewer ore
gathers while furnaces hold plates; preemption stats as in B31; no new stalls (milestones on time vs B31's run).

### Magic numbers for the user (M6b.5)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `supply-radius` | `settings.ts`, `strategy/bootstrap.ts` `registerSupplies` | 384 | Tiles from the hub: `scan-radius` (128) × `EXPLORE_MAX` (3), the farthest the brain places sites by default, so every own site counts. 0 = any distance. Guess. | yes (new) |
| `supply-min-take` | `settings.ts`, `jobs/supply.ts` `takeable`/`supplyStock` | 5 | A supply point holding fewer is not worth the walk (B17's collect skipped sources under min(need, 8)). Stockpiles always count. Guess. | yes (new) |
| `PAIR_KEEP` | `strategy/bootstrap.ts` | 10 | Coal a pair drill keeps for its partner when the crew takes its surplus (unchanged from M3; `PAIR_COLLECT_AT` is gone). | no (existing) |
| haul source order | `jobs/crew.ts` `haul` | — | Rule, no number: whole-need sources first, then smallest detour. | no |

## M6b.6: B26 growth bands kept clear at placement (2026-10-19)

The B26 row: smelter columns never grew in place. Their growth band (on the tail end, which is also the ore/fuel input
side) was blocked by modules placed there, by ore, and by other modules' claims and reservations, so after 3 failed
expansions the design built a parallel cluster instead. Placement only had a 0.5/tile soft claim against other
modules, and only mines had a growth check of their own (D52).

**Fix (987553b, `planner/placement.ts`, `planner/policy.ts`):**
1. **Near band (fix direction 1).** A new placement layer marks each other expandable non-mine module's first
   `growthBandUnits` growth units, on the end `tryExpand` grows. A candidate pays `growthBand` per footprint tile there,
   on top of the soft claim. The D50 soft-claim default (0.5) is unchanged. Direct partners are exempt, as from the soft
   claim (P28). Without that exemption the ore outposts and feeders were pushed off the smelter's input side, and the
   seed 11 replay failed.
2. **Own band (fix direction 2).** For an expandable non-mining module, a second layer marks every tile `tryExpand`
   would refuse: non-free terrain (trees and rocks only when they can't be cleared), ore under `protectOre`, any `occ`
   (other modules, interaction tiles, poles), routes, port reservations, other modules' mine claims and soft claims.
   Each candidate counts the near units its band can grow into, checking both this layer and the other modules'
   corridor ring (`too close`). It pays `growthBlocked` per near unit that would be refused. This generalises D52's
   mining-only `growthCoverage`. The window margin grows by the module's growth length so the band is always inside
   the window.
3. **Failure reasons.** `tryExpand` and `planGrowth` already log distinct reasons, and they are unchanged: `occupied at`,
   `ore at`, `mine claim of`, `reserved at`, `route at`, `blocked at`, `too close to`, `reroute failed`.

**Judged on six replays** (new `REPLAY_PLACEMENT` / `UNIT_FILTER` / `REPLAY_DUMP` env vars):

| Replay | Result with the B26 defaults |
|---|---|
| seed222-production (undergrounds) | done |
| seed11-green-boxed (×2) | as expected |
| m6a2-seed222-green-line (×2) | as expected |
| green-line-dev11 | as expected |
| m6a2-seed222-mall-iron | done |
| seed11-production-ok, without undergrounds | fails |
| seed11-production-ok, with undergrounds | done |
| seed3333-production-ok, without undergrounds | fails |
| seed3333-production-ok, with undergrounds | done |

Dropped variants:
- **The own band over every unit up to the cap** (a smelter's band is 20 tiles deep), at 8 per unit: it moved the
  seed 222 red line and both smelters, its coal outpost went about 100 tiles out, and the iron feed failed "no path"
  even with undergrounds.
- **Own band at 8 per near unit:** still failed on seed 222.
- **Near band applied to partners:** failed on seed 11.

The no-underground failures are the trade-off of fix direction 2. A smelter's growth end is its input side. Keeping it
clear of ore and claims turns it away from the ore, so the feeds wrap round the column. Without undergrounds the
chaotic stage-1 routing then fails. In game, D51 reroutes the same placement with undergrounds and researches them
first, which both seeds decide anyway (saves 118 / 82 tiles). The D36 / B2 comparison replays now pin the pre-B26
placement weights, because their numbers document those decisions. New `b26Replay` tests pin that both clusters plan
with undergrounds under the B26 weights.

**Tests:**
- **T1 `planner-batch` "B26 (a)":** a non-partner module pulled into the first growth unit (by its cluster centre and
  its input's source) sits there under the old weights and keeps off it now. When cliffs leave only the near band free,
  it is placed there anyway, and `tryExpand` then fails with `occupied at`.
- **T1 `planner-batch` "B26 (b)":** a 4-furnace smelter between an ore patch (south) and a neighbouring column growing
  toward it. With the old weights it faces the ore and its near growth fails (`ore at 65,74`). Now it turns
  (rot 1, at 58,61), grows by its 2 near units, and the neighbour still grows fully.
- **T1 `planner` expand-first test:** with B26's check the module would avoid the walled spot, so the "places a copy"
  case runs with `growthBlocked: 0`, plus a case at weight 20 where it grows instead.
- **T2:** `planner%-driven expansion` and `soft claim` passed.

Not run: the full T1 and T2 suites (each over 5 min). Run per file, every T1 file passes.

**Fix direction (c), "a smelter column actually grows in place".** No replay or T2 test runs a factory to a grow goal
(the T2 expansion test calls `planGrowth` directly), so it needs a soak:
`python3 tools/harness/soak.py -c tools/harness/m6.toml --seeds 11,222,3333 --hours 4 --name b26-growth --no-build`
(after `npm run build` in this worktree). Look for:
- `goal gN (grow) done` for the iron-plate and copper-plate smelter roles.
- Fewer `cannot grow by … units` lines, and which reasons remain.
- No new parallel clusters for smelters.

**B29:** the steam block and labs are expandable non-mining modules, so their near bands are protected and their own
placement is scored the same way. The `ore at` / `blocked at` growth failures in B29's evidence are the cases fix
direction 2 scores against. B29's demand/supply diagnosis is not touched.

**Not covered:**
- Pole lines are still planned without regard to growth bands (`occupied at x:poles:`).
- Routes only pay the router soft claim (0.5).
- Head-end growth is not scored.

### Magic numbers for the user (M6b.6)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `planner-placement-growth-band` | `settings.ts`, `policy.ts` `placement.growthBand` | 4 per tile | About 8× the 0.5 soft claim. A 4×4 module overlapping a full near band pays about 64, so it moves rather than block a growth unless nothing else fits. Guess; passed six replays. | yes (new, proposed P38) |
| `planner-placement-growth-band-units` | `settings.ts`, `policy.ts` `placement.growthBandUnits` | 2 | The units a growth goal usually needs first (8 tiles for a smelter); also the depth of the own-band check. The full depth (5 units for a smelter) broke the seed 222 replay. | yes (new, proposed P38) |
| `planner-placement-growth-blocked` | `settings.ts`, `policy.ts` `placement.growthBlocked` | 3 per near unit | 8 broke seed 222 even with undergrounds; 3 passes it. At 3, the walled-in spot of the planner test still wins over moving. Guess. | yes (new, proposed P38) |
| Window margin + growth length | `placement.ts` `startWindow` | footprint + corridor + 4 + growth length + corridor.min | Derived: the own band must lie inside the scoring window. | no (derived) |

## M6b.7: B35 review hotkeys for spectators, review toolbar, B34 reports (2026-10-19)

**B35 root cause:** `CustomInputPrototype.enabled_while_spectating` defaults to `false`. The sandbox makes every
player a spectator, so the engine never raised Ctrl+Shift+I / Ctrl+Shift+G. The handlers, key sequences and
config were fine: the review profile's `config.ini` rebinds neither, and no vanilla control uses them. The shortcut
bar is not shown to a spectator, so the shortcut buttons were out of reach as well.

**Fix (`mod/static/data.lua`, `review/toolbar.ts`, `review/index.ts`):**
- Every review custom input sets `enabled_while_spectating = true`. A third input, Ctrl+Shift+R, opens the report
  dialog. Each input has a shortcut of the same name. One table in `index.ts` maps the name to its action for both
  `CustomInputEvent` and `on_lua_shortcut`.
- **Review toolbar** (`player.gui.top`): appears in the sandbox (`sandboxReady`) and for any spectating player.
  It is checked every review tick, which also covers saves made before the toolbar existed, and on
  `on_player_controller_changed`. Buttons: Inspector, Graph, Overlay, one toggle per `overlayLayers()` entry (so B33's
  growth layer shows up without changes), and Report…. Buttons show their window's state and are rebuilt after
  every review click, hotkey or checkbox.
- **Overlay without the inspector:** `PlayerReview.overlay`. Overlays draw while the inspector is open *or* the
  toolbar's Overlay switch is on, at the inspector's refresh cadence. Closing the inspector now keeps them if the
  switch is on.

**B34 (`review/report.ts`):** a dialog with a text box. Submitting it writes
`script-output/rival-engineers/reports/<tick>-<slug>/` and calls `game.auto_save("re-report-<tick>-<slug>")`, which
saves `_autosave-re-report-<tick>-<slug>.zip`. In single player it saves locally, in multiplayer only the server
saves, and under `--benchmark` it is a no-op. The bundle holds `message.txt` and `report.json`. `report.json` has the
message, tick, save name, surface, camera position and zoom, the controller, the physical position, the inspector's
selection, game speed, mod version, `factionTelemetry()` (the soak serializer, now exported) and `workReport()`. The
bundle also has `entities.json` (`dumpEntities` around the camera, radius `frame-dump-radius`, with water) and
`graph-<faction>.json` (`exportFactoryGraph`). In multiplayer only the reporter's machine writes files (`for_player`).
Mod log lines are not in the bundle: Lua cannot read the log. The README points to `factorio-current.log` instead.
README "Reports" says how an agent reads a bundle and loads the save (`npm run review -- --load ...` or
`soak.py --from-save`).

**Tests (T2 `test/review-tools.test.ts`, 4 tests):** (1) every review input is a Lua input enabled while
spectating, with a shortcut. **On the old data (the `enabled_while_spectating` lines removed) it fails:
"rival-engineers-toggle-inspector is enabled while spectating".** (2) For a spectating player, the mod's registered
handlers (`script.get_event_handler`) for each hotkey and each shortcut open and close the right window.
(3) A spectator gets the toolbar. Its buttons open and close the inspector, graph and report windows, Overlay draws
with the inspector closed, every registered layer has a toggle, and the graph window's own close button un-toggles
the toolbar. (4) The dialog submit writes a report, and a direct `writeReport` returns the expected dir, save name,
camera, zoom, controller, entity count and faction telemetry. The bundle files were checked in the shard's
`script-output`.

Limits: under `--benchmark` the save is skipped, so the save itself is untested. A spectating player who stays one
tick ends the headless test run, so tests 2–4 run within one tick and restore the character. The toolbar tests
dispatch `on_player_controller_changed` themselves. Filtered T2 runs: `"review tools %(B34"` gave 4/4, and
`"review" "graph" "inspector" "overlay"` gave 10/10. T1 `graph-layout` gave 4/4. The full `test:unit` exceeds the
5-minute limit and was not run; no T1-tested module changed.

**Manual check (user, review game):** run `npm run review`. Then check: (1) The toolbar shows at the top left.
(2) Ctrl+Shift+I and Ctrl+Shift+G toggle the inspector and the graph window, and the matching toolbar buttons do the
same. (3) Overlay with the inspector closed draws crew paths, and the layer buttons toggle them. (4) Report… or
Ctrl+Shift+R, type a line, then Save report. The chat line names the folder and the save. Check that
`.factorio-review/script-output/rival-engineers/reports/<tick>-*/` and
`.factorio-review/saves/_autosave-re-report-*.zip` exist, then `npm run review -- --load _autosave-re-report-...`.

### Magic numbers for the user (M6b.7)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `SLUG_CHARS` | `review/report.ts` | 32 | Longest slug cut from the message for the folder and save names. Long enough to recognise the report, short enough for file names. | no |
| Report text box size | `review/report.ts` `openReportDialog` | 420 × 110 px | Room for a few lines. GUI layout. | no |
| Toolbar button height / padding | `review/toolbar.ts` | 28 px, [0, 6] | Compact top-bar buttons. GUI layout. | no |
| Report hotkey | `mod/static/data.lua` | Ctrl+Shift+R | Free in vanilla and in the review config, next to I/G. Rebindable in Controls. | rebindable |

## M6b.8: B36 module buffers and temp-cell feeds as supply sources (2026-10-19)

The B36 row (user, review game on the B32 build): crew never take from module buffer chests and still hand-mine
while furnaces hold plates. Manager probe soak (seed 11, 45 game-min) added: the belt cell's output chest held 218
belts while the red-science cell never made a pack (its input chest had copper but no gears).

**Root causes:**
1. **Module buffers stamped by the planner runtime were never registered** (`storage.buffers`). `stampParts` /
   `stampLayout` create a module's entities with `stampModule`, which neither registers buffers nor (for ghosts) limits
   them; only growth ghosts (`factory.ts`), conflict repairs and route specs (`createSpec`) called `registerBuffer`. So
   a smelter column's or gear row's buffer head built from a first plan was no supply point (B32's `bufferChests` only
   lists registered ones) and had no slot limit (an iron chest soaked up 32 stacks off the line). Nothing in the
   radius, `supply-min-take`, haul source order or reservations dropped it.
2. **Temp-cell top-ups had no stopping point but the input chest** (B18 `topUpTempCells`): a cell was refilled up to
   `cap` "products" worth of input regardless of what its output chest held, and `cap` was used as a craft count (the
   belt cell asked for 120 gears per refill, not 60). Cells are refilled in node order from the shared surplus, so the
   belt cell, consuming as fast as it was fed, took every gear while belts piled up for no order, and the red-science
   cell (later in order) never saw a gear surplus. Copper did arrive (5 + 2 in the machine = its 6-pack buffer).

**Fix:**
- `planner/runtime.ts` `registerModuleBuffers`: every module stamped by the runtime (ghost or real) registers its
  buffer entities, like `createSpec`; the crew's revive then limits the chest (`onBufferBuilt`).
- `factory-report.ts` `repairBuffers` (each think, from `registerSupplies`): a built node's buffer chest that is not
  registered with a valid entity is found and registered (and limited). Repairs older saves; one table lookup per
  buffered module, a search only for missing ones.
- `topUpTempCells`: a cell whose output chest holds `cap` products is not topped up; otherwise it is refilled for
  `ceil((cap - output) / per)` crafts (was `cap` crafts). The on-demand feed (`feedTempCells`) is unchanged.
- **P39 (user decision in-session, 2026-10-19: keep as implemented, default off, no further work):** `supply-module-furnaces` (default off) makes built smelter modules' furnace
  outputs supply points (last in order). The hand-mining while module furnaces hold plates is by design today: only
  the buffer head is the module's crew-facing surplus. I did not turn it on: it can starve the belt.
- **Telemetry:** `CrewStats.takes` counts items actually taken (the take action's item count) by source kind:
  `depot`, `buffer`, `furnace` (bootstrap), `chest-site`, `pair`, `chest-out` (mall), `temp-out` (temp cell output),
  `module-furnace`. `soak.py` sums them per faction (`takes_by_source`, "Items taken by source" in the scorecard).

**Tests (T2):**
- `bootstrap-sources_test` "B36: a craft takes its plates from a smelter module's buffer chest built from the planner's
  ghosts": a smelter column stamped as ghosts by `stampParts`, revived; 100 plates in its buffer, empty depot, an ore
  patch: the craft takes 60 plates from the buffer, no hand-mining, `takes.buffer` = 60. Old code: fails (buffer
  bar 33, i.e. unregistered and unlimited).
- "B36: a built module's unregistered buffer chest (an older save) is registered and taken from": old code fails
  ("hand-sourcing 3, buffer 100").
- "B36: supply-module-furnaces (proposed, off by default) takes from a smelter module's furnaces" (setting on).
- `temp-factory_test` "B36: a stocked belt cell leaves the gears to the red-science cell": gear, belt and red-science
  cells, plates and copper in the depot. New code: 3 packs by tick ~8600. Old code: 0 packs after 19 800 ticks (the
  belt cell took every gear).

Filtered T2: "B17" "B30" "B31" "B32" "B36" "D42 buffer" "D38" (21 passed) and "job board" "burner bootstrap"
(18 passed), all green. T1 green (15/15). No soak run (manager), from the branch after `npm run build`:
`python3 tools/harness/soak.py -c tools/harness/m6.toml --seeds 222,11 --hours 1.5 --name b36-check --no-build -j 2`.
Look for: "Items taken by source" showing `buffer` and `temp-out` takes; red-science cell `products_finished` > 0;
fewer iron-ore gathers once smelter modules are built; no new stalls vs the B32 run.

### Magic numbers for the user (M6b.8)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `supply-module-furnaces` | `settings.ts`, `bootstrap.ts` `registerSupplies` | false | P39 (user, 2026-10-19: keep, default off): taking from a module's furnaces may starve its belt; off until the user decides. | yes (new, proposed P39) |
| temp-cell top-up stop | `bootstrap.ts` `topUpTempCells` | output chest ≥ `cap` | Reuses `cap` = `bootstrap-factory-wait-seconds` (60) × the cell's rate: the same buffer B18 meant to build. No new number. | no (rule) |

## M6b.9: B33 growth plans that match the module and its ore (2026-10-19)

The B33 row: a mining outpost's planned expansion ran long and off the ore patch, yet did not cover the patch the way
D52 whole-patch mines should.

**Diagnosis.** D52 whole-patch plans were only made in **splitter-tap** plans (`prepareWholePatchPlacement` returned
early for any other topology). Most stage-1 mines are point-to-point (one consumer each), so they stayed linear strips.
A strip's growth area ran to its belt-limited cap regardless of ore: 6 units × 6 tiles = 36 tiles for an electric
2-row strip, 30 × 2 = 60 for burner drills. D52 (3) makes that area a **hard** claim, so other modules and poles had to
keep off ground that would never be mined. Its growth also accepted a drill with a single ore tile anywhere in its
mining area. Shared mines did get whole-patch plans, but those covered the whole patch through one collector and one
output belt. That is 67-69 electric drills on the captured starting iron patches, while a yellow belt carries 30.

**Audit (T1 `growth-geometry`, every expandable generated module in all 8 orientations, plus the curated red tile):**

| Module type | What was wrong | Fix |
|---|---|---|
| Mining outpost, point-to-point (strip) | No whole-patch plan. Its growth claim ran the full cap off the patch (36/60 tiles). Growth needed only one ore tile in a new drill's mining area. | Whole-patch plan in every topology. A point-to-point mine claims **one lane** of the patch grid, up to its template's cap (P40 (b)). A strip that can't take a plan claims growth only while every new drill has ore under it (`oreUnits`, `stripOreUnits`). Growth needs ore under each new drill's body. |
| Mining outpost, shared (D52 whole-patch) | The plan covered the whole patch through one belt (up to 69 drills for 30 drills of belt). The plan wasn't checked against the layout: belts, poles and the port could land on other modules' ground or claims, water, or facing built structures. | `claimPart`: one belt's worth of drills (`beltDrillCap`, from belt speed and mining rate), whole lanes nearest the consumer first, on the full-coverage grid. Planned against the layout's taken ground. Falls back to the clipped strip when it doesn't fit (P40 (a), (c)). |
| D52 partial stages | Consistent: the initial stage is a subset of the full plan and the port is fixed. | — |
| Smelter column (incl. burner, buffered) | Consistent: unit = 2 furnace pairs, 4 tiles at the tail (input end); claims = tryExpand's new ground; cap from the ore lane. | — |
| Steam block | Consistent: 1 boiler + 2 engines per 4-tile unit, at the east end; cap from the pump. | — |
| Assembler row (1/2 inputs, buffered), red line, circuit block (buffered), lab array (1/2 packs) | Consistent: the units are the templates' own. The claimed units equal tryExpand's ground, on the same end, and the far end keeps its entities. Caps are from lanes (red line and labs: the existing 10-unit guesses). | — |
| Curated red tile | Consistent: its unit repeats the slice before `insertAt`. | — |
| Router (found by the replays) | A route that crossed itself was retried with the crossing tile at an extra cost only (`rip`). With the B33 claims, seed 222's copper feed (with undergrounds) found the same crossing path on every retry. | The tile is blocked on the retry (`router.ts` `tileCost`). |

Not changed: P37 (placement still credits head growth for mines that can't grow at the head). Mines are now whole-patch
plans and the strip check only gates the site.

**Visualizer.** A new review overlay layer, *Growth plans* (`review/growth-overlay.ts`, off by default: open the inspector
(Ctrl+Shift+I or its shortcut) and tick *Growth plans* in its Overlays row). It draws:
- **Expandable module:** footprint in white; planned growth units `+1`, `+2`... in amber (the first two bright), with
  an arrow to the last one and "grows k/max units".
- **Strip mine:** its capped units past the ore as dashed red.
- **Whole-patch mine:** full planned footprint in violet, built drills in green, unbuilt planned drills as dashed
  violet, and the ore patch outlined in yellow (read from the surface's resources around the plan).

Rendering only, for the inspecting player. Capped at 80 modules and 3,000 outline edges per redraw.

**Tests (each fails on the old code: placement.ts reverted, checked):**
- T1 `growth-geometry`, 16 template tests and 16 growth-area tests over every type × orientation. These pass on the
  old code too: they pin that nothing else was wrong.
- T1, the mine tests:
  - "a point-to-point mine gets its whole-patch plan" (old: no plan).
  - "claims one output belt's worth" (old: 384 drills for a 30-drill belt).
  - "a point-to-point mine claims one lane" (old: no plan).
  - "a second point-to-point mine takes the unclaimed part" (old: no plans).
  - "a strip mine that can't take a plan claims growth only over its ore" (old: claim ran to y 52, ore ends at y 30).
  - "strip growth refuses a drill with no ore under it" (old: grew onto grazed ore).
  - "a shared mine on a small patch covers the whole patch".
  - Captured patches from 3 fixtures: whole-patch plans reach 96-100% of the tiles any drill could mine.
- T2 `review` "B33 growth overlay draws…": a smelter's units, and a whole-patch mine's built and planned drills and its
  patch outline. Result: 2 modules, 5 units, 2 + 10 drills, 66 ore edges.
- T2 `B20` now builds its eviction set as the factory's adoption does, adding the mine's D52 claim to its built parts
  (B23). The stone outpost is a whole-patch mine now, and its first two drills may stand beside the bootstrap site
  rather than on it.

**Replays** (`plan-replay`, each filter run alone):
- `seed222-production` with undergrounds: done. Without undergrounds: fails, and the underground alternative routes;
  this needed the router fix.
- Logistics comparisons: seed 11 unchanged. Seed 3333's splitter saving fell from 60 to 14 tiles, so its pinned
  splitter decision is now `false` (the comparison is off by default; undergrounds unchanged).
- B26 replays (seed 11 / 3333): done.
- seed11-green-boxed, the m6a2 green-line replays and the four mall-iron replays: as before.

T2 `real terrain` (M4b) failed at first: on all 5 seeds the whole-patch outpost's first two drills sat on the thin edge
of the patch nearest the consumer (7-9 ore tiles of 25), and the test requires at least 50%. A partial stage now
starts with drills that meet the placement's own `minOreCoverage` (0.6), in the output lane order, then nearest the
consumer (`materializeMinePlan`). That passes 5 of 5. Other filtered T2 runs pass: growth overlay, planner-driven
expansion, B20, P36, routing lab, burner bootstrap (8) and review tools (4).

During the work, a fatter whole-patch part made seed 11 / 3333's second coal outpost unplaceable, which led to the
one-lane rule (P40 (b)). A port facing the base's built structures broke seed 3333's iron feed, which led to the port
and approach check (P40 (c)).

**Soak (manager):** after `npm run build` in this worktree:
`python3 tools/harness/soak.py -c tools/harness/m6.toml --seeds 11,222,3333 --hours 4 --name b33-growth --no-build`.
Look for:
- Mines with `/partial` ids in point-to-point plans.
- No `no feasible position` for a second outpost of the same ore.
- `goal gN (grow) done` for mines and smelters.
- Fewer `occupied at` / `mine claim of` growth failures.
- Turn on *Growth plans* in a review run to see each mine's plan against its patch.

### Magic numbers for the user (M6b.9)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Point-to-point mine part: lanes | `placement.ts` `prepareWholePatchPlacement` (`maxLanes`) | 1 lane | Two or more made the second coal outpost of the seed 11 / 3333 clusters unplaceable on one small field. Proposed P40 (b). | no |
| Point-to-point mine part: drills | same | template rows + cap × drills per unit (14 for a 1-side electric 2-row outpost) | Derived: what the strip could have grown to (its lane cap). | no (derived) |
| Shared mine part: drills | `mine-plan.ts` `beltDrillCap` | 2 lanes × lane speed ÷ drill rate (30 electric on iron, yellow) | Game data: one collector, one output belt. | no (game-derived) |
| Overlay caps | `review/growth-overlay.ts` | 80 modules, 3,000 ore edges per redraw; patch margin 8 tiles | Keeps a redraw cheap on a big base; guesses. | no |
| Captured-patch coverage bound | `mod/unit/growth-geometry.test.ts` | ≥ 95% of the 1-tile-grid upper bound | Test threshold: the lane grid gives up a few edge tiles (96-100% observed). | no (test) |

## M6b.10: agent workflow refactor and diagnostics (2026-10-19, Codex session, merged by the manager)

Branch `refactor/agent-phase1` (user-requested review of where agents get stuck; phases checked in with the user in
that session):
- **Phase 1:** `AGENTS.md` as the tool-neutral entry point with routed guides in `docs/agent/` (when to read which
  guide, and what goes wrong without it); `docs/HANDOFF.md` archived (`docs/archive/`), replaced by `npm run status`;
  `npm run doctor`, `npm run diagnose -- <run> [seed] [faction]`; `run.json` soak manifests (commit, dirty state, build
  hash, per-seed status); structured goal → planner → job blocker diagnostics in telemetry.
- **Phase 2:** factory goal scheduling extracted as pure `strategy/goal-selection.ts`, replayable from a live
  `goal_selection_snapshot` (T1 `goal-selection`).
- **Phase 3:** `storage-schema.ts` (current saves adopted as schema 1, newer schemas fail closed); the runtime config
  map is built from the settings name registry; `npm run check:architecture` checks settings alignment and keeps the
  pure modules free of Factorio globals.
- **Phase 4 (diagnostics the user picked: 1, 2, 4, 5, 6, 7):** bounded decision history per category
  (`diagnostic-events.ts`: crew plan rejections, haul sources with raw/reserved/takeable and detour, growth failures);
  placement rejection certificates and route-failure evidence on `PlanJob.evidence`; churn warnings; more cross-layer
  invariants (dependency cycles, missing plans/jobs/layout modules, invalid supply entities); the last failed growth
  reason on B33's *Growth plans* overlay; `seed-N/failure.json` on an unexpected Factorio exit.

Merge notes (manager): Codex's own growth overlay overlapped B33's; B33's was kept, with Codex's failure label added.
Placement certificates reuse the plan trace's rejection codes (`region`, `hard`, `coverage`, `foreign-ore`, ...), so
one vocabulary serves both. Phase 4 was finished by the manager: identical idle crew-plan observations still coalesce,
but batch events no longer do (a repeat would hide its job ids). Simulation decisions are unchanged.

### Diagnostic observability values (agent refactor)

These values affect retained evidence and warnings only; they do not alter simulation decisions.

| Name | Where | Value | Why this value | Status |
|---|---|---|---|---|
| Decision events retained | `diagnostic-events.ts` | 512 per category | User decision. Independent crew-plan, crew-supply, goal, planner and churn buckets prevent one noisy producer from evicting another subsystem's evidence. | accepted |
| Churn minimum volume | `diagnostic-events.ts` | 32 observations | Avoid warnings from a handful of ordinary retries. Diagnostic guess; no simulation effect. | accepted (user, in-session 2026-10-19) |
| Churn poor-outcome ratio | `diagnostic-events.ts` | worse than 10:1 | Historical B30 was roughly 6,500 claim/releases for two completions, so this catches the demonstrated failure far below its observed severity. Diagnostic guess; no simulation effect. | accepted (user, in-session 2026-10-19) |
| Rejected job samples | `crew-diagnostics.ts` | 3 ids per reason | Counts retain full magnitude; three ids make the class inspectable without duplicating the Job Board. Diagnostic display bound. | proposed |
| Fatal log tail | `tools/harness/soak.py` | 200 lines per log | Keeps `failure.json` compact while retaining both Factorio's current log and captured stdout around a fatal exit. Full logs remain beside it. | proposed |

## M6b.11: B37 pole lines give way to growth, placements and routes (2026-10-19)

The user asked whether expansion is blocked by poles. It was, in three ways:
- `tryExpand` refused a growth tile holding a pole line's pole (`occupied at x,y`), and `planGrowth` never moved poles.
- Pole placement (`poleCost`) avoided mine claims (D52) but not other modules' growth areas, so lines were laid
  straight across smelter, lab and power growth bands.
- A built pole is an own entity in the terrain scan: the planner's view read it as `OWN` (`blocked at x,y` in the
  soak's power and lab growth failures; the new T2 test reproduces it on a raw scan: `blocked at 53,2005`).

**User decision (in-session, 2026-10-19):** pole lines are evictable like trees, for nearly free, in growth, new
placements and routes; new lines are regenerated for what they powered. The cost is a setting, default 0.5 per tile.

**Fix:**
- `layout.ts`: `isPoleTag`, `evictPoleLines(state, keys)` removes every line with a pole on those tiles (whole lines:
  a line with a gap joins nothing) and lists its poles in `LayoutState.evictedPoles`. `markModule` evicts lines on a
  module's footprint, interaction tiles, port lanes and mine claim; `commitRoute` on its tiles.
- `placement.ts`: a pole tile is not hard; it adds `obstacles.poleEvict` to the clear cost. Strip growth, whole-patch
  fit checks and mine completion accept pole tiles. `router.ts`: a pole tile costs `obstacles.poleEvict`.
- `runtime.ts` `claimView`: the faction's own pole-line poles (built or ghosts) read as free ground.
- `power.ts`: new line ids skip ids still in use or just evicted.
- `grow.ts` `planGrowth`: when it evicted lines, a pole job joins what they powered again (prefix `poles:g<goal>:`);
  their poles go into `remove`, the new ones into `add` (a pole re-laid on the same tile stays). A module that was
  powered and can't be joined again fails the growth (`re-pole failed`).
- Plans: the plan's pole phase already joins every unpowered consumer, so it re-poles after an eviction.
- `factory.ts`: adoption picks up the evicted poles before ghosts (cancels pole ghosts), growth cancels ghosts of
  removed entities, and `powerEdges` keeps each power edge's `physical` lines current, so a repair goal never re-places
  an evicted line.

**Tests:**
- T1 `pole-eviction` (4): growth over a line (old code: `occupied at 41,22`), a route forced through a pole tile, a
  module committed on a line (fresh line ids), the placement search on a line (old code: `no feasible position`,
  certificate `hard`) and its preference for free ground. All pass; the full T1 suite (21 files, replays included)
  passes.
- T2 `factory` "B37: a built smelter grows over a built pole line": built steam block, labs, line and smelter; the raw
  scan blocks the growth; through `claimView` it picks up 9 poles, lays 7 new ones, every entity builds, and the labs
  and electric inserters stay on the engine's network.

### Magic numbers for the user (M6b.11)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| `planner-pole-evict-cost` | `settings.ts`, `policy.ts` `obstacles.poleEvict` | 0.5 per pole tile | User decision (in-session 2026-10-19): nearly free; a tree costs 2. On a tie the planner still keeps off a line. | yes (new) |

## M6b.12: B38 depot-ore feeds, B39 second power plant, richer report dumps (2026-10-19)

Triaged from the user's four B34 review reports (the user approved the fixes in-session):
- `147797-this-power-plant-should-have-exp`, `198830-power-poles-were-never-connected`: the first plant could not grow
  because a pole line stood in its growth area (`blocked at -295,-170` / `361,174`, a small pole on that tile) and a
  second plant was placed instead: B37 (M6b.11). The second plant was then never wired to the network: B39.
- `58098-hand-mining-iron-ore-when-there`, `88641-mining-copper-when-full-copper-f`: B38.

**B38 root cause** (`bootstrap.ts`): `maintain` turns ore in the depot into furnace feed jobs, one furnace per think,
each sized to the depot's whole ore count; the feeds already open were not subtracted, and `scanJobs` adds every
active job's materials as demand. Open feeds of 46 iron ore against ~2 in the depot (report 58098) made a 44-ore
shortfall, which `produce` met by hand-mining ore into the depot, which made more feeds. **Fix:** a feed (fuel job
moving a smeltable ore into a bootstrap furnace, `isOreFeed`) is no demand; new feeds book only the depot ore no open
feed claims, open feeds beyond what the depot holds are cancelled; no feed and no hand-mined ore goes into a furnace
whose output is full.

**B39 root cause** (`power.ts` `init`): every generator module's pole component counted as powered and only consumers
were joined, so a second steam block stayed an island (faction 1, report 198830: "n1 at 184% load", repair "nothing
missing" every cycle). **Fix:** only the first generator module is powered; later ones are pending like consumers, so
the plan's pole step joins them. `unpoweredModules` reports an unjoined later generator too.

**Observability:** report and frame dumps (`dumpEntities`) carry each built entity's non-empty inventories, its
`defines.entity_status` name and its electric network id; the bootstrap brain keeps its last think's `shortfalls`
(demand, stock, pending and what `produce` did) in `faction_report` / telemetry.

**Tests:**
- T2 `bootstrap-sources` "B38: ore in the depot is fed…": depot 40 tiles from four empty furnaces and one with a full
  output, 12 ore. Old code: 2 hand-mining jobs, 60 ore booked, feeds into the full furnace. New: none, at most 12
  booked, all 12 fed.
- T1 `power` "B39: a second steam block joins the first one's network". Old code: no line to it.
- Full T1 (21 files) passes; filtered T2 (B38, B32, B37, power-up, review tools) passes.

No new magic numbers.

## M6b.13: B41 replacement pole lines reuse live poles (2026-10-19)

The user's review report `132592-repeatedly-the-planner-keeps-pla` captured production goal g5 with 10
small-electric-pole ghosts exactly over 10 live poles. B37 had evicted a 15-pole line and planned its replacement;
the new line reused those 10 coordinates, so adoption deliberately kept the live entities. Factorio permits a ghost
over the same live entity, however, and every later `ghost.revive` failed `cannot-place`. The goal requeued the same
impossible placements each leftover-ghost round and eventually stalled.

`stampParts` now treats an exact same-force live pole as the already-built realization of that planned pole: it emits
no ghost and no place job, while genuinely new poles in the same replacement line are still ghosted. T2 `factory`
"B41: a re-laid pole line reuses a live pole instead of ghosting over it" pins both cases. No new magic numbers.

## M6b.14: B42 escape pick-ups don't restore entities scheduled for removal (2026-10-19)

The user's review report `125521-the-underground-belt-is-schedule` showed an underground belt left between steam
engines in faction 2's power plant, on the tile of growth g6's last small-pole ghost. g6 had scheduled the belt for
removal (a clear job; the coal route was rerouted). Crew members boxed in during the build used the M6/B22 escape,
which picks up an own entity and always queues a ghost to re-place it: the review log shows three pick-ups of that belt
(members 4 and 3, 684–711 s). Each pick-up made the clear job fail `target-invalid`, which the growth's clear phase
accepts as finished, and then the escape ghost's priority-90 place job rebuilt the belt. Nothing was left to remove
it; once the engines stood on both sides it blocked the pole, and g6 hit BUILD STUCK after 10 rounds.

`unbox` (`jobs/crew.ts`) now checks for an active clear job on the entity it picks up. If there is one, the pick-up
does that job: it claims the job when it is open, so the job ends done, and queues no ghost. T2 `jobs` "B42: a boxed-in
member that picks up an entity scheduled for removal…" boxes a member in a ring of chests with a pipe that has a clear
job; on the old code the clear job fails `target-invalid` and the pipe is ghosted back, with the fix the job is done
by the member and the pipe stays gone. Targeted runs: T2 "job board" (11 tests) and all T1 pass; full suite and soaks
not run by this change.

Second fix (the user asked for it in-session, 2026-10-19): a leftover ghost blocked by one of the faction's own
entities that the layout no longer plans used to be retried for `build-stuck-rounds` and given up. `replanGhosts` (the
leftover-ghost round of plans, growths and repairs) now also gives each such stray a clear job: `planner/runtime.ts`
`strayUnder` returns the faction's own built entities under the ghost that are not in the build's layout
(`layoutEntityKeys`, `name@x,y`); a live entity with the ghost's own name and position is the planned one already
built (B41) and not a stray. Stockpiles, parts of live bootstrap sites (`evictSites` handles those just before) and
entities with an active clear job are left alone. T2 `factory` "B42: an own entity the layout does not plan under a
leftover ghost is a stray…" pins the classification: the stray underground under a pole ghost, not a built planned pole
under its own ghost or under another ghost.

Validation: the report's save (`tools/modules/input/b42-report-125521.zip`) resumed with the fix for 40 game minutes
(`soak.py --from-save`, `stop_when_done = false`): faction 2's g6 round logs "picking up underground-belt at
-377.5,86.5 under a leftover small-electric-pole ghost (not in the layout)" and g6 grows power at tick 126870; no other
stray pick-ups, no BUILD STUCK. That save is from before the first fix, so only the second fix acts in it. Full T2 suite on the final code: 141/141
(an earlier run on the build before the last tweak had one order-dependent failure, B33 review overlay, which passes
alone, with the jobs tests, and in the rerun). No new magic numbers.

## M6b.15: B43 a second power plant's pole pass joins a cut-off line (2026-10-19)

The user's review report `333968-run-finished-all-research-but-ne`: faction 1 finished every red-only technology but
stayed at stage 0, so green science was never planned. Its steam block could not grow (its coal outpost n2 blocks it:
"blocked at 371,119", three failures), so the design asked for a second steam block. Every power goal from g6 to g15
failed all 4 attempts with `power:n18: no pole path (window margin 112)`, a new goal about every 18,800 ticks. With a
power spec always pending, `advanceGoals` never moved on to stage 2.

n18 is the faction's copper mine, powered in the game. Replaying the captured plan (`mod/unit/fixtures/r333968-second-power.lua`)
showed the mechanism: the second plant's coal route crosses trunk line `poles:905:1`, which B37 evicts as a whole. The
copper mine's line `poles:905:4` hangs off it and stays, still joined to the mine's pole. The pole planner then had to
reconnect n18 but aimed only at n18's own pole, which sits in the middle of the mine where every tile in wire reach is
module footprint or claimed growth room, although `startNext`'s comment said it targets "every pole of the owner's
component". It now does: the search ends at any pole of the owner's union-find component, here the surviving line.

Tests: T1 `power` "B43: a consumer whose trunk line was evicted joins through the line still hanging off it" (fails on
the old code with "no pole path (window margin 112)") and `plan-replay` "r333968-second-power" (the captured plan, now
done). The report's save (`tools/modules/input/r333968.zip`) resumed with the fix: g15 (whose attempt 1 was already in
flight in the save) plans on attempt 2, evicting 6 poles, and the second plant is built at tick 346050; the factory then
plans the mall (g16). That run stopped at tick 410400 with the mall still building, before any stage change, so the
move to green science is not yet shown. No new magic numbers.

## M6b.16: B44 whole-patch mine plans no longer depend on where the patch lies (2026-10-19)

While validating B42/B43, the full T2 suite failed once per run in T2 `review` "B33 growth overlay draws a smelter's
next units and a whole-patch mine's plan…" ("patch outline 58 edges", expected 66), only when a fast module-validation
test (`circuit-block 1` or `assembler-row belt 2`) ran earlier in the same shard; the pre-session commit b666577 fails
the same way. The user asked to track it down (in-session, 2026-10-19).

It is not a leak between tests. Those tests advance the shared lab allocator, so the B33 lab's origin moves from x 400
to x 496, and `planWholePatch` (`planner/mine-plan.ts`) then chooses a different plan: the mine shifts 5 tiles and its
outline area (plan footprint plus a margin) crops the test patch. Two grid phases tie on every criterion `better`
compares (covered tiles, drill count, axis, the first drill's tile): lane -2.5 with its drill on the east side and lane
1.5 with its drill on the west side put the first drill on the same tile. On a full tie the first phase tried won,
and the phases count from absolute coordinates, so the chosen plan depended on the patch's position mod the lane pitch
(9 tiles for the electric drill). That affects the game too: two identical patches at different places got different
mines. `better` now breaks the remaining tie on the first drill's lane, which makes the choice depend only on the
patch's shape.

Tests: T1 `mine-plan` "B44: a whole-patch plan does not depend on where the patch lies" shifts a rectangular and an
L-shaped patch through every x offset across the pitch (and three y offsets) and requires the same relative plan; it
fails on the old code at a 4-tile shift. Both failing T2 combinations now pass. Mines whose plans tied now consistently
take the lower lane, so soak layouts can differ from earlier runs for those patches. No new magic numbers.


## M6b.17: D54 steam-block coal is hand-fed, then mined electrically (2026-10-19)

Soaks of 55e7cad (m6.toml) failed 0/3. Two of the failures (seeds 222 and 3333, and seed 3333 on the pre-session base
b666577) were the same stall: the steam block's burner coal outpost (`coal>power`) can't grow and power stops growing.
The user decided the fix in-session (2026-10-19; SPEC §2 D54, approved):

- **Before electric mining drills are researched**, a steam block gets no coal outpost and no fuel belt
  (`design.ts` `designPower` adds its input demands only once `electricDrillsNow`). The crew hand-feed its boilers.
- **Hand-feeding is also the backup afterwards.** In the user's words, an outage would otherwise "create a spiral" (no
  power, so the electric coal mine stops, so no power). `factory.ts` `refuelBoilers` runs for every steam block that is
  not just planned, growing included. A boiler whose fuel slot is **empty** gets one priority-100 fuel job for a
  **whole stack** (the stack size comes from game data). Coal comes from the existing haul sourcing. The old P36
  hand-fuel gating (`powerFuelled` / `producerGrowing`, plus FUEL_LOW/TOP for boilers) is gone.
- **Factory burner outposts are replaced once electric drills are researched** (bootstrap sites are out of scope).
  `fuel.ts` `replaceBurnerOutposts` runs at the fuel-check cadence and only while no plan runs. It gives up the first
  built burner-drill outpost that no active goal uses, through P36's `relocate`, and the design then re-plans it as an
  electric mine. Burner drills no longer size producers for power (`sizes` / `sizeModule` lost `burnerOnly`).

Tests:
- T1 `design`: the 10-red design has no `coal>power`. A new test checks that with electric drills researched the
  power goal brings an electric coal mine and its belt. The goal-diff and one-outpost tests were updated, and
  `fuel.test.ts` (which only tested `producerGrowing`) was removed.
- T2 `reconciler`: new test "D54: an empty boiler gets a whole stack of coal by hand, once". P36, "unfuelled",
  power-up and M5a pass.

No new magic numbers. Soak comparison against m6-b44-55e7cad and m6-base-b666577 follows.

## M6b.18: B45 placements keep other modules' open port lanes reachable (2026-10-20)

The D54 soak's seed 222 stopped at 64 game-min ("g5 production planning (placed 0); waiting: no researchable
technology"). At the user's request (in-session, 2026-10-20) I rendered the area and found the cause:
- The labs (g2) came first. Their pack input stays unconnected while packs are hand-fed, and its 2-tile lane points
  south at a coal patch.
- D54's electric coal mine for the steam block (g4, after electric drills) went on that patch. Its whole-patch claim
  came within a tile of the lane end, its margin ring (and before this fix the whole bounding box: `factoryReserveTiles`
  reserved `rect` + 1, which reads as own ground to every later plan) closed the sides, and bootstrap reservations
  closed the rest.
- Every red-science plan then failed on "no path" to the labs, with undergrounds too, so the D36 fallback (research
  `logistics`) never triggered either.

Placement never checked that a new module leaves *other* modules' open ports reachable. The user chose a general
placement rule (in-session, 2026-10-20):
- `placement.ts` `openPortEnds` lists every belt port no route uses yet. `laneWayOut` / `laneLeadsOut` ask whether a
  route can get `portEscape` steps (Manhattan) away from its lane end over free ground.
- `evaluate` rejects a candidate (`port-sealed`) when its footprint plus margin ring walls in a lane that led out
  without it. Only lanes near the candidate are checked.
- `prepareWholePatchPlacement` checks the whole-patch plan's claim and margin the same way. If the plan walls a lane in,
  it re-plans once with that lane's way out (±1 tile) kept free. If the plan still walls the lane in, the mine stays the
  strip it was placed as.
- `layout.ts` `moduleMargin`: a whole-patch mine's reserved margin is its claimed tiles + 1, no longer its bounding box
  + 1 (`factoryReserveTiles`).

In the seed 222 case no whole-patch plan can keep the lane open: the mine's output belt has to cross the lane's only way
out, along the patch's top edge. So n6 stays a 5×7 strip, which can grow only over its own ore.

Tests:
- T1 `plan-replay` "B45: the steam block's coal mine leaves the labs' pack input lane a way out" replays the adopted g4
  plan. With the rule off, lane end -43,493 is sealed; with it on, no open lane is sealed.
- A replay sweep with `portEscape=0|8` over every replay: 16/16 pass either way. Only seed222-production changes, still
  done, with placement work 308k → 88k.

### Magic numbers for the user (M6b.18)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Port escape distance | `policy.ts` `placement.portEscape` | 8 steps | A lane must lead at least this far (Manhattan) over free ground, so it isn't a closed pocket; a guess, small enough to stay cheap per candidate. 0 turns the rule off. | no (policy default) |
| Way-out keep-out width | `placement.ts` `prepareWholePatchPlacement` | path ± 1 tile | One tile either side, the size of a mine's reserved margin. | no |

## M6b.19: B46 an evicted pole stays out of a goal that is still building (2026-10-20)

The D54 soak's seed 11 stopped at 113 game-min: the mall goal g9 had a pole ghost at (450, -27) that was never placed,
because a built belt stood on the tile ("leftover ghosts for 20 rounds … cannot-place"). The user asked me to
investigate (in-session, 2026-10-20). The adopted-plan captures show the sequence:
- g9 (mall) was planned at tick 179040 with a pole line through the tile (`poles:8942`). Its plan became the faction
  layout, and its build started with the clear phase (ghosts come after the trees and rocks are gone).
- g10 (production) was planned 360 ticks later on that layout. Its copper-plate route to the green labs took the tile
  and evicted g9's pole line (B37, "goal g10 evicts 6 poles").
- B37 eviction picks up built poles, destroys existing ghosts and updates the faction layout. g9 had no ghosts yet, and
  its build stamps from its own copy of the plan (`entry.job.layout` and `build.parts`), which still had the pole.
  When g9's clearing finished it ghosted the pole next to g10's belt ghost. The belt got built (`can_place_entity`
  ignores ghosts), and the pole could then never be placed. Leftover rounds re-place from the same stale plan.

Fix: `factory.ts` `adoptPlan` drops the plan's evicted poles (except those it lays again at the same spot) from every
other goal that is still building, in its plan layout and its build parts (`dropPlannedPoles`), and logs "goal X
evicts N poles goal Y has not built yet (B46)". The consumers those poles served are re-joined by the evicting plan's
own pole step (B37), as for built lines.

Tests: T2 `factory` "B46: poles another plan evicted leave a building goal's own plan" checks that the dropped pole
leaves the parts and the layout, and that stamping the goal's ghosts no longer creates it. No new magic numbers.

## M6b.20: B47 a plan completing two shared mines builds both; B48 completed mines are measured whole (2026-10-20)

The D54 soak's seed 3333 ran the full 480 game-min without a stall. It finished all research by 270 min but never
sustained science, so it didn't reach v1-done. The user asked me to log and fix both causes (in-session, 2026-10-20).

**B47.** Goal g14 (the second green cluster) completed two shared whole-patch mines, n6 (the steam block's coal) and
n18 (copper): "completes the shared mine n6: 27 entities", then "… n18: 87 entities". `adoptPlan` set
`b.extraAdd = add` inside the loop over completed mines, so n18's list replaced n6's. n6 stayed at 2 drills and 1 pole
in the game, while the layout held the completed mine (40 entities, 6 poles). Those poles were the pole planner's only
link from the network to the cluster's red line (n26) and green line (n25). In the game both modules formed their own
pole islands for the rest of the run (checked from the frames: nearest network pole 13 tiles away). The reconciler saw
"lacks power while the power plant has spare capacity" and tried a repair, but a power repair re-placed only pole-line
poles: "nothing missing". (Its earlier "power at 144% load … grow failed" came from the same unpowered cluster plus a
real short spike; the plant ran at 59% load at the end, all 9 boilers working.)

Fixes:
- `factory.ts` `adoptPlan`: `extraAdd` accumulates over every completed mine.
- `factory.ts` reconciler repair: for a power edge it also re-places the missing **poles** of built modules (D49: belts
  and poles may be re-placed, never machines). `conflicts.ts` `checkBuild` takes an entity filter for that.

**B48.** The cluster's iron mine n28 read as "the ore under its drills is used up … cannot grow". In the game 10 of its
17 drills were waiting for space (the cluster was backed up behind B47) and 7 were worked out. Measurement
(`measure.ts` `sampleNodes`) searches a node's machines again only when its `builtTick` changes. A shared mine's
completion (g17 completed n28) builds new drills into a built module without changing it, so only the original 5
drills were measured, 4 of them worked out. Measurement now searches again (counters kept) while fewer machines stand
than the module's layout plans.

Tests:
- T2 `reconciler` "B47: a module whose own pole is gone is repaired through its power edge": the pole is ghosted
  again, nothing else of the module is. It fails without the change ("nothing missing", no repair goal).
- T2 `reconciler` "B48: drills built into a built mine later join its measurement": 2, then 4 machines. It fails on
  the old code (2).
- The `extraAdd` accumulation was checked by resuming seed 3333 from its 60-min snapshot (before the cluster's plan)
  with the fix (`soak.py --from-save … --no-fail-fast`, to 150 min). The plan (now g15) again completed n6 and n18
  together. n6 was built whole (12 drills, 6 poles; before: 2 and 1), and the cluster's red and green lines read `ok`
  (0.4 and 0.2 packs/s). n28 was measured with all 18 drills and read "backed-up 33%", no longer "depleted".
- B46 was checked the same way: seed 11 resumed from its 40-min snapshot logged "goal g10 evicts 5 poles goal g9 has
  not built yet (B46)", g9 was built with 0 extra rounds, and the run reached 150 min without a stall (before: stopped
  at 113 min).

No new magic numbers. A resumed run's fail-fast "no automated-red-science by 1.5 game hours" fires falsely when the
milestone came before the snapshot (the log of the resumed run doesn't repeat it): use `--no-fail-fast` there.

## M6b.21: D55 a worked-out mine moves within its patch, else it is relocated (2026-10-20)

In the B48 soak (m6-b48-879fb9b, 2/3) seed 3333 ran 480 game-min without a stall and finished all research, but never
sustained science. Its iron mine n27 (a whole-patch mine, 18×15 at 346,-64) sat on an isolated patch of about 72 ore
tiles and was worked out by about 137 min. The other iron near it is separate patches, not more of the same one (I
first counted ~400 tiles and corrected that to the user). The reconciler said "cannot grow: no expandable module": a
completed whole-patch mine has no expand spec, and D28 deferred relocation. n6 (coal for power) also worked out at
about 426 min; D54's hand-feeding keeps the boilers going there.

The user chose, in-session on 2026-10-20, "Claim more of same field" (recorded as SPEC D55, an exception to D28):
"A worked-out mine claims the next free part of its own patch and is rebuilt/extended there, keeping its output route;
only when the patch is exhausted does it move to another patch."

Changes:
- `placement.ts` `reclaimWholePatch`: the patch is found from the ore within mining reach of the mine (the whole
  connected patch, not just the mine's rect). Ground other modules hold is foreign. The mine is planned again on it
  with at most as many drills as its whole-patch plan, and its output port is kept. The result is accepted only when
  the new drills cover more ore tiles than the current drills still reach; otherwise the layout is unchanged and the
  reason says so. `tryExpand` takes a `reclaim` flag, and `planGrowth` passes it (no fallback end when re-claiming).
- `factory.ts`: a `deplete:` remedy on a completed whole-patch mine starts a re-claim growth goal ("goal X moves it
  to the next part of its patch (D55)"). A re-claim that finds nothing better is not a growth failure. The mine is then
  relocated (`relocateDepleted`, through the P36/D54 relocation in `fuel.ts`): deconstructed, out of the layout and
  graph, and the design plans the producer again on fresh ore. A strip outpost with no ore left in its growth area is
  relocated the same way. A relocation waits while a plan is in flight, or while a building/planning goal has an
  edge from the mine.
- `reconcile.ts`: the depletion messages no longer say relocation is P2.

Tests (T1 `growth-geometry`):
- "D55: a worked-out mine re-claims the next part of its patch; a spent patch has none": 12 drills move to fresh
  ground, and a fully worked-out patch gives "no better part".
- "D55: planGrowth moves a worked-out mine to the next part of its patch and reroutes its output".

There is no T2 test of the relocation itself: it uses the same `relocate` as D54's burner-outpost replacement. The
re-soak (below) is the end-to-end check. No new magic numbers. The seed area is the drill's mining radius (game data),
and the drill cap and the acceptance rule come from the mine's own plan.

## M6b.22: B49/B50 relocation follow-ups, D57 faster mine site search, D56 radar (2026-10-20)

The D55 re-soak `m6-d55-73d7ac7` (2/3, the same as `m6-b48-879fb9b`): seed 11 done at 255.4 min, seed 222 at 296.6 min.
Seed 3333 was stopped at 137 min by fail-fast. D55 did run there. The iron mine n27 was worked out (7 ore tiles left
in its patch against 34 its drills still reach), had no better part of its patch, and was relocated. Two bugs
followed:

- **B49.** n35, the second green cluster's iron mine, was a D52 alias of n27: it had no module of its own and fed
  through a tap on n27's route. It stayed in the graph after n27 was removed, so the design only asked to connect
  `n35.out`, and 8 plans failed with "no belt-out port n35.out". `fuel.ts` `relocate` now also drops every node that
  fed only through the relocated mine's dropped routes and has no module of its own. The design plans those roles
  again ("1 aliased nodes dropped" on the resume).
- **B50.** The new iron mine then failed with "no feasible position" at every region radius up to 378. The home field
  was built out: about 520 of its 630 iron tiles lay in n16's and n27's drill areas, and the free rest was scattered
  (96 tiles). Iron fields of 4.2M and 2.9M ore lay about 324 and 335 tiles out, inside the region. The site search
  took the nearest ore tile as its only target and searched windows at most 192 tiles around it. Each failed attempt
  cost 1–5 min of wall time (up to ~30 s of AI per game minute).

The user asked why the field was a blocker, said the search looked inefficient, and approved in-session (2026-10-20)
the faster search P42 (a)–(d) → SPEC **D57**. The user chose "New field costs +50" for the ranking. They also
proposed a radar and chose to keep chunk-generation exploration with a radar for realism → SPEC **D56**.

D57 changes (`planner/placement.ts`, `planner/terrain.ts`, `planner/runtime.ts`, `planner/plan.ts`,
`strategy/factory.ts`):
- (a) A mine's site phase now builds a **patch index** of the region: the connected patches (2-tile join, as in
  `world/resources.ts`) of *free* ore of its resource. Free means not under a structure, route, reservation or another
  mine's claim, with trees and rocks counted as the policy clears them. The ore tiles come from the terrain cache's
  per-chunk ore tables (`TerrainView.oreTiles`), not from a new entity search. Patches are ranked by distance from the
  request centre to their nearest free tile, plus `newField` (50) for a fresh field. A fresh field has no mine of
  this resource on or next to it. Each patch gets one window search over its own box. B50 is fixed by trying the
  patches in order.
- (b) Patches with less free ore than the template's drill areas need at `minOreCoverage` are never searched.
- (c) A patch with no room is remembered under a terrain stamp (`TerrainView.stamp`: the chunk count and the newest
  scan tick under its window). The memory goes plan → job → `FactoryState.deadPatches` and back into later
  requests, and is skipped until a chunk under it is scanned again. It is not recorded when a module this plan
  placed lies over the patch.
- (d) This was already the case: the template placement only picks the spot, and `prepareWholePatchPlacement` lays a
  new mine out with the D52 whole-patch planner. No separate path was added.
- The user asked how Factorio's map-view resource search works (FFF #426). It scans every charted chunk on a separate
  thread and keeps no ore index; mods cannot call it. Our terrain cache already scans each chunk once (dirty chunks
  again), so reading the map is not where the time went. Bootstrap `scanPatches` still pulls every resource entity
  in its radius on each rescan; it was left as it is.

D56: a `radar` generator (one radar and its small pole, 4×3, a power port) and a `radar` goal kind.
`strategy/factory.ts` `radarGoal` starts one radar goal once power is built and the radar recipe is enabled. The
radar is planned and powered like any module (role `radar`), with at most 2 failed attempts. The setting
`factory-radar` (default on) turns it off. Plans never depend on what it charts.

Tests (T1):
- `planner` "placement B50 / D57: a mine whose nearest patch has no room goes on to the next patch (seed 3333)".
- `planner` "placement D57 (b): a patch with too little free ore for the drill areas is never searched".
- `planner` "placement D57 (c): a patch remembered as full under the same terrain stamp is skipped". It also checks
  that the patch is searched again once the stamp changes.
- `planner` "placement D57: a fresh field counts `newField` tiles farther than a field the faction already mines".
  With `newField` 0 the nearer fresh field wins.
- `modules` "radar cell (D56)", and the radar joins the generated-module layout invariants.

### Magic numbers for the user (M6b.22)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Fresh-field extra distance | `policy.ts` `placement.newField` | 50 tiles | The user's figure ("such like 50 or so"), 2026-10-20. | yes: `planner-placement-new-field` |
| Patch join distance | `placement.ts` `PATCH_JOIN` | 2 tiles (Chebyshev) | The same join as `world/resources.ts` `JOIN`, so both see the same patches. | no |
| Radar goal failures | `factory.ts` `RADAR_MAX_FAILED` | 2 | It is cosmetic (D56): give up after two failed plans instead of retrying forever. A guess. | no |
| Radar on/off | `factory-radar` | on | D56. | yes |

## M6b.23: D58 two-level routing and a shared planner budget, B51 sealed smelter input (2026-10-20)

The D57 resume of seed 3333 (`d57-s3333`, from `m6-d55-73d7ac7` min-0120) confirmed D57. Mine attempts that found
no room now fail in under 1 s (they took 1–5 min before), and g17's replacement iron mine was built at ~165 min
(~203 min with B50 alone). The run still stopped at 203 game min, not done. Plans g18 and g19 (the second iron line's
mine, labs#3) each spent ~12 min of wall time in their last attempt (radius 378, ~3.6M router expansions over 6
searches) and failed with "no path" into `n34.in-ore`.

- **B51.** n34 (a smelter of the second green cluster) had been fed by a tap on n27's route, so the B45 lane test never
  covered it. When D55 relocated n27, n34 lost its feed. Its input approach was walled in by the coal route above, n33
  plus the red-pack route's underground on the approach row, and n34's own margin. `fuel.ts` `relocate` now collects
  the consumers of the routes it drops. It relocates each production module (power is hand-fed under D54, labs are left
  alone) whose unfed input lane no longer leads out (`placement.ts` `sealedInputs`), one level deep.
- **D58** (user decision, approved in-session 2026-10-20). The user said: "Let's do two-level routing for long
  distances and do (3), but in a flexible way where any planning entry can take the entire mod's budget if there is
  nothing competing. Otherwise, they share."
  - `router.ts`: a connection whose nearest start is `longRoute` tiles or more from the goal is first searched over
    `coarseCell`-tile cells. A cell's cost is the cell size times its average tile cost, raised for cells that are
    mostly blocked; a cell with nothing passable is closed. The tile search then runs inside the corridor of cells
    along that path, with a weighted heuristic. If the corridor has no way through, or the coarse search fails, the
    whole window is searched as before. Both coarse failures and corridor failures fall back, so the result is never
    worse than "no path" from a full search.
  - `runtime.ts`: `planner-work-per-tick` is now the whole mod's budget. Plans in their "plan" phase share it equally.
    Work a plan leaves unused goes to the next plan, and a plan running alone gets all of it.
- On the T1 maze (a 300-tile route), two-level routing used 1,460 expansions against 23,873 for one level, at the same
  route cost (226). The heuristic weight sets the trade-off: 1.0 → 17,278, 1.2 → 11,355, 1.5 → 1,268. Weights of 1.3
  or more inside short routes lost the B7 belt bundling, and a 64-tile threshold broke the B7 test, so only routes of
  128+ tiles use it.

Tests (T1):
- `planner` "router: two-level routing finds a long route with far fewer expansions, about as short".
- `planner` "router: two-level routing falls back to the whole window when its corridor has no way through".
- `plan-replay` "B51: a smelter input that lost its tap feed is sealed; an open input is not". It uses the captured
  g19 layout (`unit/fixtures/s3333-b51-sealed-lane.lua`).

### Magic numbers for the user (M6b.23)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Two-level threshold | `policy.ts` `router.longRoute` | 128 tiles (Manhattan) | 64 broke the B7 bundling test; 128 keeps short and mid routes exact. | no |
| Coarse cell size | `router.coarseCell` | 8 tiles | A quarter chunk: small enough to thread between modules, 64× fewer nodes. A guess. | no |
| Corridor width | `router.corridorCells` | 1 cell each side (2 at the ends) | The narrowest corridor that still found the maze route; ends get one more for port approaches. | no |
| Corridor heuristic weight | `router.corridorWeight` | 1.5 | 1.5 cut expansions ~13× at equal cost on the maze; lower weights save little. | no |
| Sparse-cell penalty | `router.ts` `cellCost` | below 50 % passable, up to ×4 | Steers the corridor away from mostly-blocked cells. A guess. | no |
| Coarse work per cell | `router.ts` `stepCoarse` | C²/8 (8 per cell at C = 8), charged once per cell | A cell's first cost reads its C² tile costs; a tile cost read is counted as about 1/8 of a search expansion. A guess. | no |
| Planner budget | `planner-work-per-tick` | 400 per tick for the whole mod (was 100 per plan) | The user asked that one plan can take all of it. Estimated 2–3 ms/tick at full use; not yet measured. | yes |
| Lane escape distance | `fuel.ts` `LANE_ESCAPE` | 8 tiles | Same idea as the B45 lane test: an input lane must lead 8 free tiles out. | no |
| B51 relocation depth | `fuel.ts` `relocate` | 1 level | Relocating a sealed consumer does not cascade further, so one depletion cannot rip a whole cluster. | no |

## M6b.24: B52 the steam block never got its coal, D59 soft-claim cost by growth unit (2026-10-20)

The D58 resume of seed 3333 (`d58-s3333`, from `m6-d55-73d7ac7` min-0120) reached `v1-done` at 224.8 game min
(science sustained at 204.8, all 42 techs at 224.3; AI 6.6 ms/tick avg, 15.4 p99; no stalls). B51 worked: n34 was
relocated with n27 and g19 found the far iron field at radius 378. But the power plant never grew ("power cannot grow:
blocked at 459,-9"), and the user asked why. It was not too small: it was out of coal (B52, five causes):

1. A power growth (g10, ~41 min) rerouted the mall's coal route while the mall goal g9 was still building it. g9 kept
   placing its old copy: 22 belts north along x=430, which are in no route of the layout. One turned the steam block's
   coal belt at (430,3) north, so coal from n6 went up that column and n6's drills sat blocked. Boilers 1–4 ran on D54
   hand-fed stacks, 5–9 stayed dry: 8 of 18 engines, ~7 MW of 16.2 MW built, for ~2.5 game hours.
2. The repair check (`conflicts.ts` `ownBuilt`) matched name and position only: the turned belt counted as built.
3. Measured load used `powerW`, still the first unit's 1.8 MW, so the plant read "308–320% load" (really ~34%). The
   power classification spread its shares over boilers and engines (22% dry boilers, 43% engines without steam: neither
   reached 50%), so n1 read "ok" and the reconciler grew it instead of tracing the coal.
4. Those growths failed: the far mine's ore route (g20) ran along x=459, through n1's next growth unit. The router's
   soft-claim cost was 0.5 a tile, ~6 for the whole crossing.
5. The reconciler acts on one cause 3 times (`reconcile-max-remedies`), and a successful growth was one of them. The
   second-steam-block fallback needs 3 *failed* expansions (`GROW_MAX_FAILS`); power stopped at 2.

Fixes (approved in-session 2026-10-20: "Go ahead and make those fixes"):
- `goal-selection.ts`: a growth waits for every other active goal (mall, repair, temp and radar too).
  `factory.ts` `startGrow`: a growth plan that would reroute a connection whose producer or consumer is still being
  built waits (returns "wait": no growth failure, no reconciler try used). That also covers depletion and reconciler
  growths, which skip the selection rules.
- `conflicts.ts` `checkBuild` reports `misdirected` belts, undergrounds (incl. the wrong end), splitters and inserters.
  The repair remedy picks them up first, then places them as planned (a ghost on a live entity of the same name never
  revives).
- `measure.ts`: a power node's load is against its built capacity; `startGrow` keeps a power node's `powerW` in step,
  and `logical.ts` `powerBalance` takes the larger of the two for older saves. `reconcile.ts` `classify`: with dry
  boilers (≥ `minActive`), dry boilers plus engines without steam ≥ `badShare` is "unfuelled", so an unpowered consumer
  traces to the coal edge (here n6 backed up → `repair:` the coal route → the turned belt).
- `factory.ts`: a failed growth that uses up the reconciler's tries marks the role blocked (`GROW_MAX_FAILS`), so the
  design's fallback (a second steam block, other producers) can take over.
- D59 (user: "10 or so … diminish a bit after every single expansion unit"): the router's soft-claim cost is
  `planner-router-soft-claim` (10, was 0.5) × `planner-router-soft-claim-decay` (0.5) per growth unit farther out.
  `markModule` records each soft tile's unit (`LayoutState.softUnit`); `cloneLayout` (every plan, growth and reroute
  starts from one) fills the units of soft tiles marked before, so older saves and captures don't pay the full cost
  everywhere.

Checking (e) on the real plan: the g20 capture replayed (`unit/fixtures/s3333-b52-growth-strip.lua`; terrain outside
the captured window read as free, so the far shared mine completes) reproduces the game: at 0.5 the route puts 11 tiles
in n1's unit 1. At a flat 10, 20, 30, 50 or 100 it still crosses unit 1 with an underground: only its 4 end tiles pay,
while crossing farther west costs a ~40-tile detour plus the farther units' tiles. Two-level routing is not involved
(`longRoute=0` gives the same). Sweep (route tiles in n1's units 1–11; pass = units 1–2 clear):

| weight | decay | result |
|---|---|---|
| 10 | 1, 0.9, 0.8, 0.7, 0.65, 0.6, 0.55 | unit 1 (4 underground ends) |
| 10 | 0.5, 0.45, 0.4 | unit 5 |
| 8, 15, 20 | 0.5 | unit 5 (189–196 tiles at 8–15, 181 at 20) |
| 15, 20 | 0.7 | unit 1 |
| 20, 30, 40 | 0.6 | unit 5 (177 tiles) |
| 5 | 0.6 | unit 1 |

So 10 needs a decay of 0.5 or less here; 0.55 already fails. The margin is thin and this is one plan: the soak and
more replays should judge it.

One existing replay changed: `replay seed3333-production-ok: logistics comparison` (the stage-1 cluster planned
without undergrounds, already noted as chaotic) fails its routing at 10 / 0.5 and passes with the router's soft cost
off or at 0.5. Like the B26 weights, the comparison replays now pin the router's soft cost at the capture-era 0.5
(`REPLAY_D59=1` uses the current one). In the game such a cluster researches undergrounds first (D36); its replay with
undergrounds passes.

Tests (T1):
- `goal-selection` "B52: a growth waits for any other goal still building".
- `reconcile` "classify": n1's real shares (35% working, 43% starved, 22% unfuelled) → unfuelled; no dry boiler → starved.
- `plan-replay` "B52: a route keeps out of the steam block's nearest growth units" (g20, prints the per-unit counts;
  `REPLAY_ROUTER="softClaim=…,softClaimDecay=…"` and `REPLAY_MAP_B52=1` for a map of the strip).

Not fixed here: the orphan x=430 column itself stays built (it is in no route, so nothing picks it up). Once (430,3) is
turned back, the column's lower half side-loads whatever it carries onto the steam block's coal belt (not checked). A sweep for own belts that no
route owns would be a separate change.

### Magic numbers for the user (M6b.24)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Router soft-claim cost | `policy.ts` `router.softClaim` | 10 per tile in the next growth unit (was 0.5) | User: "10 or so depending on testing". | yes (`planner-router-soft-claim`) |
| Soft-claim decay per unit | `router.softClaimDecay` | 0.5 | Largest decay that kept g20's route out of units 1–2 at weight 10 (0.55 failed). The user asked for "a bit". | yes (`planner-router-soft-claim-decay`, new) |
| Dry-boiler floor | `reconcile.ts` `classify` | `minActive` (10%) of the machines | Reuses the existing noise floor: below it a dry boiler is between refuels. | no (existing) |

## M6b.25: seal check for unreachable ports, replays on today's weights (2026-10-20)

The user asked why T1 is slow. Two replays spent 200–350 s each proving that a port can't be reached: a boxed-in port
makes A* exhaust its whole window (seed 11's 445×434), and every rung of the retry ladder (rip, window ×3, ×9) does it
again. Asked for a cheap "can't be reached" test, the user picked a bidirectional flood (in-session, 2026-10-20).

**Seal check** (`router.ts` `stepSeal`, before the A* of every search): one flood from the starts and one backwards from
the goal over the search's own states (tile, heading) and moves (a belt straight on or turning; an underground entered
straight), passability and underground-span rule, with no costs. It expands the side with the shorter queue. A side
that runs out before the two meet proves "no path" at the cost of its own enclosed region. When the region did not
touch the window's edge, `plan.ts` also skips the wider-window retries (a wider window can't open it). When the floods
meet, or after `router.sealCheck` states, the A* runs as before; a meet means a path exists.

A first version flooded tiles without headings. It leaked on green-line: the goal's pocket connects to the outside
only through an underground that must be entered heading south from a blocked tile, and the tile flood entered it from
the side, so the check met after 21 steps and never proved anything. Flooding (tile, heading) states fixed it.

| Replay | Before | After |
|---|---|---|
| seed11-green-boxed (fails, as before) | 345 s, routing work 1.76M, 20 searches | 3.6 s |
| m6a2-seed222-green-line (fails, as before) | 205 s, routing work 1,733,248, 18 searches | < 1 s, routing work 66, 6 searches (the goal's pocket is 4 tiles) |
| the "freed" variants of both (route) | 9.9k / 449 work | 10.9k / 480 (the check's own cost) |

Full T1 then took 8 min 16 s. What remained slow was the two `m6a2-seed222-mall-iron` replays that *succeed* (about 85
s each, 35% of T1). A profile showed plain A* work (heap 15%, keys and window checks 25%, `tileCost` 41%).

**Guide experiments (not kept).** The A* heuristic assumes 0.81 a tile (corridor × bundle factor) while ore tiles cost
about 4, so the first suspect was a weak guide. Swept on every replay (19 tests, wall time with T2 running):

| Variant | Time | Result |
|---|---|---|
| today's guide | 222 s | baseline |
| cell guide, cheapest tile of each 8×8 cell (a reverse A* over cells, resumed on demand) | 240 s | more work, no gain: almost every cell has a cheap tile, so it rarely beats 0.81 |
| cell guide, mean tile (not a lower bound) | 234 s | breaks the seed11 no-underground comparison (no longer routes) |
| tie-breaking toward the goal (h × 1.001) | 222 s | no effect |
| weighted A*, h × 1.2 | 196 s | the only gain (B52 −22% work), routes as long; not adopted (it trades path cost) |

mall-iron stayed at ~700k routing work in all of them: it was not searching, it was failing. A per-search trace showed
97% of its work in one connection (`iron-plate*>mall => mall.in-iron-plate`) failing six times up the retry ladder
(22k, 23k, 136k, 136k, 178k, 179k expansions at windows ×1, ×3, ×9, each with and without rip) before the module is
placed again and the route takes 6 expansions. The goal's pocket was enclosed but bigger than the seal check's cap.

**The seal check runs to the end on retries** (the user asked: "if either end are enclosed, then consider it done and a
fail"). A connection's first search keeps the 2000-state cap (a reachable route pays little); a retry after "no path"
(the rip pass and the wider windows) runs the check with no cap (`router.sealRetry`, 0). Sweep on every replay:

| First search / retries | Time | mall-iron-shared routing work | Routes that succeed |
|---|---|---|---|
| 2000 / 2000 (before) | 201 s | 699,700 | baseline |
| **2000 / no cap** | **104 s** | **40,971** | unchanged (identical work) |
| 8000 / 8000 | 106 s | 25,329 | +6% to +78% work |
| 8000 / no cap | 108 s | 25,329 | +6% to +78% work |
| no cap / no cap | 111 s | 27,971 | B52 +19%, no-underground cluster +35% |

Outcomes and route lengths are identical in every variant. With no cap on retries, two replays that fail many times
pay more (the no-underground cluster +28%, the seed3333 comparison +20%): their retries prove nothing because a way
exists in rip mode, and the cost-blind floods meet late.

**Tile-cost cache**: a search caches `tileCost` by window tile (the layout does not change while one search runs; it
lives as long as the search). All replays give identical results with and without it; it saves 14% (118 → 102 s).
In game, terrain read once per search could go stale over the ticks a search runs (a tree mined meanwhile): the route
is checked again when it is built, as before.

Full T1 now takes 4 min 58 s (8 min 16 s before; the slowest tests are now the planner seal-check test at 17 s and the B52 replay at 11 s).

**Replays use today's weights** (user, in-session 2026-10-20: captures "static in time" would cause problems). `load`
replaces a capture's policy with the current `EARLY_COMPACT` copy, keeping only the plan's topology, smelting and
utilization; `REPLAY_CAPTURED=1` replays the captured policy (an empty value counts as unset). `REPLAY_ROUTER` and
`REPLAY_PLACEMENT` now apply to every replay (in `load`; the mall-iron and comparison replays ignored them). Pinned
exceptions:
- the D36 "seed222-production without undergrounds" test loads its captured weights (today's route it: 197 tiles);
- the logistics comparisons pin the router's soft cost at 0.5 with no decay (`REPLAY_D59=1` uses today's);
- planner-batch "B9: routes detour around a growth area" pins the decay at 1 (it tests a flat weight; with the decay
  the flow's crossing at the area's far end is nearly free, which is D59's intent).

Tests (T1): planner "router: the seal check proves a boxed-in port unreachable cheaply, and changes nothing when a way
exists".

### Magic numbers for the user (M6b.25)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Seal check cap (first search) | `policy.ts` `router.sealCheck` | 2000 states (about 500 tiles × 4 headings); 0 turns it off | Swept 2000–uncapped: higher caps cost routes that succeed 6–78% more work and gain nothing once retries run uncapped. | no |
| Seal check cap (retries after "no path") | `router.sealRetry` | 0 (no cap) | The user's rule: an enclosed end is a fail. 8000 gave the same mall-iron gain. | no |

## M6b.26: T2 time, config cache, B53 planner spin, D60 site-retry pause (2026-10-20)

The user asked what takes the most time in T2 (29.4 min wall, 11,513 s of test time over 8 shards). Module validations
were 56% of it, then routing 15% and bootstrap 11%; the longest single test was the coal-pair bootstrap (928 s).

**Shard balancing** was already automatic (units packed by their past durations, `out/test-timings.json`); a shard
running long came from run-to-run noise. Nothing changed there.

**Per-tick cost.** Every test runs ticks at a cost that had nothing to do with its own work: an idle 19,800-tick test
took 80.7 s (4 ms a tick), as long as a validation of four assemblers. With the mod's `onTick` skipped it took 30.1 s.
Profiled per subsystem: `stepAllTerrains` 0.91 ms a tick and `onTelemetryTick` 0.85 ms a tick, both from one
`getConfig()` call each. `getConfig()` read every mod setting through `settings.global` on every call (29 call sites,
several a tick in game). It now builds the config once and rebuilds it after `on_runtime_mod_setting_changed`,
`on_configuration_changed`, `on_init` or an override change (the cache is a Lua local derived from settings and
`storage`: a loaded game rebuilds the same values). Idle test 80.7 → 38.5 s. This is an in-game saving too.

**Module validations** (user: prime the fuel; run only as long as validation needs):
- *Fuel priming* (`LabOptions.primeFuel`): every burner machine starts with 5 coal (the lab's refuel amount), except
  `smelter iron 12`, which keeps the cold start covered. The burner smelters reached their rate at the first steady
  check instead of after 15–23 game-min of fuel-lane hoarding.
- *Measure from the steady windows* (`LabOptions.measureSteady`): steady means the last group of 3 windows agrees with
  the group before within 3%, so that group already measures the rate; the run ends there instead of measuring 2
  (fast) or 5 (slow) more game-minutes. Malls keep their 15-minute measurement (lumpy outputs). Fast validations now
  run 3.5 game-min (the minimum the steady rule allows), slow ones 7.
- Not changed: the window lengths (30 s fast, 60 s slow) and the 3-window groups. Windows sized by the slowest
  machine's cycle would need ~1/tolerance cycles each to keep counting noise under 3%, longer than today's for the
  slow modules; not worth it.

All 19 validations pass at 99.5–100.4% of their declared rates. Times (8-shard runs, before → after): fast ones
~150 → ~62 s each, smelter copper 759 → 69 s, stone-brick 646 → 124 s, green-line 422 → 63 s, mall-polse 629 → 341 s;
all 19 together ~6,300 → ~2,150 s.

**B53 (bug): the planner spun at ~43 ms a tick on a map without water.** The coal-pair test (lab tiles, no water) ran at
21 ticks/s alone. After the planner took over, its power goal found "no shore site in the region" at every radius up
to 378, failed all 4 plans, and an identical goal started at once, forever. The site-point ring search counted r / 2
work units for a ring of 8r points and ran out to the region's full width from the centre: one planner tick did ~16×
its budget. Fixed in `placement.ts`: half a work unit a point checked (as the SAT pass), the scan stops at the budget
inside a ring and resumes there (same point order), and points whose placement window could not meet the region are
skipped (such a point used to give an empty window and fail the placement; now the scan goes on to a usable one).

**D60 (user-approved in-session, 2026-10-20): site-retry pause.** After a goal fails all its plans with "no … site in
the region", goals of its kind wait `factory-site-retry-minutes` (5). The user: "it should also log pretty clearly so
we aren't surprised later": the pause logs `SITE RETRY PAUSE (B53): power goal g1 failed all 4 plans (…; region radius
up to 378); no power goal plans for 5 game-min, until tick N (setting factory-site-retry-minutes)`, its end logs
`SITE RETRY PAUSE (B53) over`, and the factory's waiting list shows it meanwhile. The coal-pair test asserts at most one
power goal on its waterless lab. Coal-pair test 928 → 70 s.

### Magic numbers for the user (M6b.26)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Site-retry pause | `factory.ts` (D60) | 5 game-min | User-approved. | yes (`factory-site-retry-minutes`, new) |
| Ring search work per point | `placement.ts` site phase | 0.5 work units | Same rate as a SAT tile (`satRow`); ~7 µs a point in game. | no |
| Lab fuel priming | `test/modules.test.ts` `PRIME_FUEL` | 5 coal per burner machine | The lab's existing refuel amount. Test only. | no |
| Cold-start validation | `test/modules.test.ts` `COLD_START` | `smelter iron 12` | The column size the AI builds; the hoarding shows most there. Test only. | no |


## M6b.27: profiled soak, B54 power gaps, B55 mine output pole, B56 stale route belts (2026-10-21)

**Profiling fix (008ac34).** The first profiled soak logged no `[re-profile]` lines: `telemetry.ts` imported the
exported `let partProfilers` by name, which TSTL compiles to a load-time copy (always nil). It reads it through the
module now; `soak.py` prints each seed's top three subsystems and warns (stdout and scorecard) when a seed logged AI
time but no profile lines. Not fixed: the `telemetry` part itself is never logged (the write swaps the profilers while
its own part is being timed).

**Soak `m6-prof`** (82ebc36 + 008ac34, `m6.toml`, seeds 3333, 6666666, 98765, `-j 3`, `--snapshots 20`,
`--no-fail-fast`; ms/tick inflated by -j 3):

| Seed | Result | Game min | Science at the end (red/green per min) | AI ms/tick | Top subsystems (ms/tick avg) | Planner worst minute |
|---|---|---|---|---|---|---|
| 98765 | **v1-done 198.7** (sustained 153) | 199 | ~36 / ~36 | 3.91 | crew 2.31, planner 0.53, brain 0.42 | 23.9 ms/tick @97 |
| 3333 | stopped at 186 (diagnosis) | 186 | ~10 / ~11 | 3.74 | crew 1.80, planner 0.80, brain 0.43 | 44.4 @149 |
| 6666666 | stopped at 171 (diagnosis) | 171 | ~8 / ~8 | 4.33 | crew 1.68, planner 1.57, brain 0.41 | 92.4 @115 |

On both stopped seeds cluster 1 ran at its design rate (~11 + 11/min) and clusters 2 and 3 delivered almost nothing.
Planner spikes coincide with failing or long plans for new clusters and a replacement mine. Crew time grows with the
base (0.24 → ~2 ms/tick).

**Diagnosis** (graph and entity dumps every 10 game-min, a probe of the min-100/160 saves via `--helper-lua`):

1. **B54, power gaps (both seeds).** Seed 3333: g16 (~98 min) evicted the 4 poles linking cluster 2's iron mine n28
   (B37) and re-laid them as ghosts; they were built ~130 min. Seed 6666666: g15 did the same to the mall's iron mine
   n25 (~85 → ~110 min). The reconciler's repair found "nothing missing" (the poles were another goal's ghosts).
2. **B55, a mine completion's pole on its own output (seed 6666666).** Probe of the min-100 save: tile (-42,-356), the
   out port's outside tile and the mall route's first tile, is `occ:m:n25`; a small-pole ghost stands on it. The D52
   pole placer gets a one-tile perimeter ring and nothing kept that tile free; B25 let the route give way. Repair g17:
   BUILD STUCK, `cannot-place transport-belt at -41.5,-355.5`, 11 rounds. Mall and cluster 2 starved from ~110 min.
3. **B56, a reroute's old belts (seed 3333).** g17 re-planned n39 → n37 (coal) after n27's relocation; the new route
   goes under a copper belt with an underground exit at (442,-47), where the old copy's belt still stood (and another
   old belt at (442,-48)). The exit's ghost was never created; n37 unfuelled 100% from ~150 min; three repairs failed.

Other observations, not acted on: seed 3333's cluster-2 iron mine was worked out ~10 game-min after it got power (D55
found 7 ore tiles under its drills); `coal>power short (1/3.48): cannot grow` is in every seed's waiting list,
including the passing one.

**Fixes** (the user, in-session 2026-10-21: "for the power problem, make placing any new power networks the first
priority. 2, 3 go with recommended fix"):

- **B54 / D61:** `addPlaceJob` gives a factory build's electric-pole place jobs `factory-power-build-priority` (150,
  never below the build's own); the bootstrap's hand-crafts of poles get it too. T2 `jobs` "B54". **Not enough on its
  own:** resumed from min-80, the gaps were as long as before (3333 ~100 → ~125, 6666666 ~90 → ~115). A `job_debug`
  remote showed why: 22 pole place jobs at priority 150 sat open with no poles in stock and no wood in the depot; wood
  is gathered at the bootstrap's lowest priority (20). Follow-up: the materials of poles being crafted (new crafts and
  pole craft jobs already on the board) are gathered at the power priority too, open gathers included. From the same
  min-100 save the 22 poles were placed by min 104.5 (was ~125).
- **B55:** `materializeMinePlan` blocks the out port's outside tile for both stages' poles; `tryExpand` refuses a
  completion whose full plan (from an older save) covers it. T1 `mine-plan` "B55" (2: a sweep of patch shapes, rows
  and consumer sides that hit it before the fix — 9×8 patch, 4 rows, consumer north — and the completion guard).
- **B56:** `conflicts.ts` `staleUnderRoutes` / `staleBeltsUnder`: a build's clear phase picks up the faction's own
  belts, undergrounds and splitters on its routes' tiles that are not the planned piece (another kind or place, or the
  same belt facing another way); `checkBuild` reports them as `stale` and the repair picks them up, then places the
  planned piece. T2 `conflicts` "B56".

**Verification** (resumed from each seed's `m6-prof` min-80 save, `-j 1`):

| Seed | m6-prof (before) | B55 + B56 + pole priority (964e95e) | + pole materials first |
|---|---|---|---|
| 3333 | stuck ~10/min, stopped at 186 | v1-done 227.8 | **v1-done 221.8** |
| 6666666 | stuck ~8/min, stopped at 171 | v1-done 219.3 | **v1-done 222.3** |
| power gap, cluster-2 / mall iron mine | ~98 → ~130 / ~85 → ~110 | ~100 → ~125 / ~90 → ~115 | unpowered at the min-100 / min-90 sample only, ok 10 min later |

Full T2 147/147 and T1 20/20 on both commits. With seed 98765 (v1-done 198.7 in m6-prof) the three seeds now pass.

### Magic numbers for the user (M6b.27)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Power build priority | `jobs/faction.ts` `addPlaceJob`, `strategy/bootstrap.ts` `craft` and pole-material gathers (D61) | 150 | Above every other job (bootstrap fuel 100, build 90), as the user asked; any value above 100 does the same today. | yes (`factory-power-build-priority`, new) |

## M6b.28: B57 walled-in port lanes, acceptance soak, D62 radar exploration arms (2026-10-21)

**Soak `m6-accept-5b9550c`** (5b9550c, `m6.toml`, seeds 11, 222, 3333, 44444, 555555, `-j 3`, `--snapshots 20`): 3/5.
222 v1-done 231.2, 3333 284.1, 44444 185.3. 555555 stopped at 44 min and 11 at 92 min, both on 8 plan failures in a
row ("no path"): the router's seal check proved an end walled in.

**Diagnosis (B57).** 555555: the labs' unfed green-science input sat in a pocket walled in by the power coal mine's
claim and the red-science plan g6's modules and routes (112 tiles when g6 planned). 11: the green cluster's iron mine
was placed with its output facing into a 221-tile pocket. B45's lane test asked for only 8 free steps (both pockets
reach farther), checked only other modules' ports at placement and never the plan's own routes, and its flood went
where belts can't (along underground spans, past exits that turn at once).

**Fixes** (the user approved all four in-session on 2026-10-21: "looks good go ahead and implement"; 0787461):

- `laneWayOut` follows the router's belt rules: an underground is entered straight, its exit tile must be free, its
  span may not overlap another on the same line or pass under a module; farthest-first, with the port's partner as a
  goal. `portEscape` 8 → 32 (fuel.ts `LANE_ESCAPE` too).
- Placement rejects a candidate whose own port lanes have no way out ("own-lane-sealed"), checked only for a new best.
  Each open port caches its lane path; B45 rechecks it only when a placement touches it.
- A plan that walls in a base module's open lane restarts once from its first placement with that lane reserved
  (`lane:` reservations, removed when the plan finishes).
- A route failure sealed on the start side moves the producer first; one sealed on the goal side at a built module
  relocates that module (`relocateSealed`, fuel.ts `relocate`) and the goal plans again.
- Traces and replay dumps say which end ran out and after how many tiles.

Replays: `m6acc-555555-g6-red` (the red plan now leaves the labs' green input a way out), `m6acc-555555-green-labs`
and `m6acc-11-green-iron` (the failed plans, expected to fail), T1 `planner` B57 ×4. Full T1 20/20 and T2 147/147
before the soak. `soak.py --port-base` gives a second concurrent soak its own server ports.

**Soak `m6-accept-b57`** (0787461's code, `m6.toml`; failed seeds kept, passing ones replaced by fresh ones;
1212121 and 8080808 ran as `m6-accept-b57x` at the same time at the user's request: five games at once, so wall times
and ms/tick are not comparable):

| Seed | Result | Notes |
|---|---|---|
| 11 | **v1-done 208.3** | was stopped at 92 |
| 555555 | **v1-done 232.7** | was stopped at 44; g15 (green) planned on attempt 4 after "route crosses itself" ×2 and "blocked by" ×1 |
| 8080808 | **v1-done 183.8** | new |
| 1212121 | stopped by hand at ~282: science stuck at ~16 + 16/min (best 63% of the bar) | new; **B58** (open): cluster 3's copper smelter gets no coal, the repair finds nothing missing; not diagnosed |
| 46464 | stopped at 115: 8 plan failures, "no free copper-ore patch in the region" | new; see below |

3/5 reached v1-done (11, 555555, 8080808): both B57 seeds pass.

**Seed 46464** (replay `m6acc-46464-green-copper`, expected to fail): the third green line's copper mine had no patch.
The only copper the faction knows (357 tiles, ~70 tiles from the hub) is under the copper mine n18 (252 tiles) and the
bootstrap copper site (78); 27 are free and a 2-drill mine needs ~30. The region ladder reached radius 378 and the
bootstrap explored to 384 (3 × `scan-radius`) in its first minutes: no other copper within ~378 tiles. Not B57: the
patch list is built before any lane check. Nothing explored farther.

**D62** (the user, in-session 2026-10-21; SPEC v0.29): radar outposts on N, E, S, W arms explore past the 384-tile home
zone when a mine finds no free patch; implementation in progress (M6b.29).

### Magic numbers for the user (M6b.28)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Port lane escape | `planner/policy.ts` `portEscape` (B45/B57) | 32 (was 8) | Longer than both pockets seen (21 and ~15 tiles of reach); a lane that gets 32 belt steps away is open in practice. Agent guess. | no |
| Fuel lane escape | `strategy/fuel.ts` `LANE_ESCAPE` (B51/B57) | 32 (was 8) | Same test as `portEscape` for relocations. Agent guess. | no |
| Lane underground hop | `planner/placement.ts` `LANE_HOP` | 5 | Game data (transport-belt underground length); exempt. | no |
| Exploration step | `strategy/bootstrap.ts` `EXPLORE_STEP` (H7, M3) | 64 tiles | Never escalated: one ring of two chunks per step. Agent guess from M3. | no |
| Exploration cap | `strategy/bootstrap.ts` `EXPLORE_MAX` (H7, M3; D62 `HOME_SCANS`) | 3 × `scan-radius` = 384 | Never escalated before; no reason was recorded in M3 (synchronous chunk generation costs ~0.5 s per step). D62 keeps it as the home zone, which the user accepted. | no |

## M6b.29: D62 radar exploration arms, first part; faction radars don't chart (2026-10-21)

**Done** (T1 21/21; full T2 147 passed + the radar test, which failed as first written and passes rewritten as the engine-fact pin below):

- `strategy/arms.ts` (pure, T1 `arms`): arm targets (N, E, S, W; first at 400 tiles, then every 200), the strip the
  crew explores along an arm, the home square, the known-chunk rule, the no-patch failure text.
- `planner/terrain.ts` / `runtime.ts`: a factory plan scans its region only where `known` allows (home zone, explored
  strips, charted chunks); everything else stays UNKNOWN to the planner. Plan regions are capped at the home zone.
- `strategy/explore.ts` (the D56 base radar moved here too: `factory.lua` was at 202 main-chunk locals, now 184): a
  goal whose mine finds no free patch after its last attempt starts a search; one radar outpost goal at a time (radar
  module + pole line, the radar placed near the arm target, a nudge on retries); the searching goal kind waits until
  the outpost is built and its nearby square charted (or `ARM_SCAN_WAIT`), plans again, and a plan of that kind ends
  the search. Logs `EXPLORING (D62)` / `EXPLORE (D62) over`.
- `soak.py` fail-fast `exploring_minutes` (60 in `m6.toml`, the user's number).
- T1 `power` "D62": a radar 400 tiles out gets its pole line (65 poles, ~75k work) along a strip with a lake and
  cliffs, never onto unknown ground.

**Finding: a radar charts nothing for a force with no players.** T2 engine test: powered, the same radar charted its
7×7 nearby square within 60 s for the `player` force and 0 chunks for a script-created force like the factions'. As
built, an outpost's radar reveals nothing: the search would wait `ARM_SCAN_WAIT` per outpost and only the arm strips
would count as explored. D62 is blocked on how faction radars reveal ground: SPEC §11 P43 (proposed options: emulate
the radar with `force.chart`, keep our own record, or count an outpost's reach as explored). Not soaked.

### Magic numbers for the user (M6b.29)

| Name | Where | Value | Why this value | Setting? |
|---|---|---|---|---|
| Home zone | `strategy/arms.ts` `HOME_SCANS` × `scan-radius` | 3 × 128 = 384 tiles | Today's bootstrap cap; the user accepted keeping it ("That's fine"). | `scan-radius` yes; the factor no |
| First outpost | `arms.ts` `ARM_FIRST` | 400 tiles | Just past the home zone. Agent guess the user accepted ("Spacing is fine"). | no |
| Outpost spacing | `arms.ts` `ARM_SPACING` | 200 tiles | Nearby squares (224 tiles) about touch. Agent guess the user accepted. | no |
| Strip half width | `arms.ts` `ARM_STRIP_HALF` | 32 tiles | One chunk either side of the arm: room for the pole line's detours and the radar's nudge. Agent guess. | no |
| Scan wait | `arms.ts` `ARM_SCAN_WAIT` | 5 game-min | The nearby square charts in under a minute (player force); a cap so a radar that never charts doesn't hold the search. Agent guess. | no |
| Stuck exploring | `tools/harness/m6.toml` `exploring_minutes` | 60 game-min | The user: "Give up can be after 1h in-game time stuck on exploration for fast-fail". Soak only. | soak config |

**P43 → D62 (a)** (the user, in-session 2026-10-21: "go with (a)"). Research: a forum post quotes a developer that the
engine skips charting for forces without players. Two T2 pins measured it: the player-less radar sector-scans at the
normal rate and raises `on_sector_scanned`, but the chunk is only marked requested for charting; nothing is charted or
generated, and `force.chart` only requests. A 30-game-min run (not kept in the suite: ~3 min of test time) scanned 53
distinct chunks nearest first in rings (0, 8 × ring 1, 16 × ring 2, 24 × ring 3, then ring 4). Implemented:
`explore.ts` `onSectorScanned` records each faction radar's scanned chunk (`FactoryState.radarChunks`); the planner's
known-ground rule accepts them; a powered outpost radar's nearby square counts as explored at once (its sector scans
take ~28 game-min to cover it). T2 "P43 (a)" (handler and known-ground rule), T1 `arms`.


**Verification** (38cbbc2): T1 21/21, T2 150/150. Seed 46464 resumed from its `m6-accept-b57` min-100 save
(`--no-fail-fast --hours 4`; with fail-fast on, a resumed run fails its milestone deadlines at once, because those
milestones were logged before the save: a harness gap, not fixed):

| Game min | Event |
|---|---|
| ~115 | g16's copper mine: no free patch after 4 attempts → `EXPLORING (D62)` |
| ~115 → 130 | outpost N1 (400 tiles north): planned first try, 47 poles; powered, nearby square explored; no copper |
| ~131 → 144 | outpost E1 (400 tiles east): 44 poles; powered |
| ~146 | g20 (green production, attempt 2) planned with a copper mine on the newly explored ground: `EXPLORE (D62) over` after 2 outposts, 31 game-min. Work 1.37M (typical plans 0.1–0.7M): the long belts are expensive. |

Still running when committed: whether the far mine's build lifts science to the v1 bar.

## M6b.30: architecture hardening — progress and next steps (working tree, 2026-10-21)

This section is the durable checkpoint for the architecture review prompted by repeated fixes in one decision tree
invalidating another. It records implementation work in the current dirty tree; it is **not** an acceptance result,
commit record, or user approval of the follow-up proposals below.

### Completed in the current working tree

1. **Typed factory-goal lifecycle.** `strategy/goal-lifecycle.ts` owns the legal status graph:
   `planning → planning/building/failed`, `building → building/done/failed`, and no transition out of `done` or
   `failed`. `strategy/factory.ts` has one mutation boundary, `transitionGoal`; the architecture check rejects direct
   status assignments elsewhere. The pure lifecycle has exhaustive T1 coverage, including terminal states failing
   closed.
2. **Optimistic layout revision guard.** `LayoutState.revision` is monotonic and optional for old saves and captures
   (missing reads as 0). Module, route and pole mutations advance it; layout clones preserve it. A `PlanJob` records
   `sourceRevision` when it copies its base. Before adoption, the factory compares that revision with its live layout,
   emits the structured `stale-plan-rejected` diagnostic, removes the stale plan, and retries without charging a
   failed attempt. Old saved jobs without `sourceRevision` retain their previous behaviour.
3. **Derived-index invariants.** `checkLayoutIndexes` checks canonical modules, routes, underground spans, poles and
   pole lines against `occ`, `routeOcc`, `spans` and ordering indexes, reporting the complete mismatch chain. Planner
   tests call this before the existing terrain/geometry checker. A T1 regression proves revisions survive clones and
   deliberate occupancy drift is diagnosed.
4. **Mutation audit and documentation.** Module removal paths go through the revisioned `unmarkModule`; route and pole
   removal/addition paths go through revisioned helpers. `docs/agent/architecture.md` documents the lifecycle,
   revision and index-check boundaries. `tools/check-architecture.mjs` treats the lifecycle and plan-delta modules as
   pure and enforces the single goal-status mutation boundary.
5. **First `PlanDelta` adoption boundary.** `planner/plan-delta.ts` is pure and serializable. A completed job is prepared
   once before adoption: its base revision and all derived indexes are validated, and deterministic module/route/pole
   additions and removals are derived from canonical layout order. `strategy/factory.ts` consumes the prepared delta
   instead of recomputing build parts. Stale deltas retry without spending an attempt; structurally invalid deltas emit
   `invalid-plan-delta`, retry under the existing attempt cap, and can no longer enter persistent factory state. The
   A-plans → B-mutates → A-rejects sequence, add/remove derivation, and index rejection have pure regressions. The
   actual entity/job side effects remain in the runtime adapter; this is an optimistic transaction boundary, not a
   claim that Factorio side effects are rollback-safe.
6. **Typed spatial-claim query boundary.** `planner/claims.ts` gives the raw layout indexes one typed vocabulary for
   module, interaction, pole-line, port/lane reservation, route, mine-growth and soft-growth claims, with explicit
   hard/evictable/soft strengths. Router, power and placement now use policy-specific conflict queries rather than
   independently decoding the tables. `checkClaimOwners` diagnoses orphaned occupancy, reservation, mine and soft
   claims; `PlanDelta` rejects them as `invalid-layout-claims`, and planner, batch and growth fixtures exercise the
   invariant. This deliberately does not merge indexes whose lifetime and cost semantics differ.

Validation on the dirty tree:

- `npm run typecheck`: pass (architecture check plus runtime, settings and unit TypeScript projects).
- Before the claim-boundary additions, `npm run test:unit -- --no-build`: **22/22 files passed**. Relevant totals
  include planner 39, planner-batch 14, plan-replay 23, growth/growth-geometry 51, power 10, pole-eviction 4, and
  goal-lifecycle 2. The post-claim full run is the interrupted run called out below.
- `npm run build`: pass. The first build exposed 190 main-chunk locals in `factory.lua`; consolidating the layout
  imports behind one namespace brought it back below the project's 185-local guard, and the rebuilt mod passed.
- `git diff --check`: pass.
- `npm run doctor`: 0 errors, 4 warnings. T2 and soaks were deliberately not started: the existing D62 seed-46464
  Factorio process was still running. (`mod/build` was stale at doctor time and was rebuilt successfully afterward.)
- Claim-boundary follow-up: targeted T1 passed (`claims` 3/3, planner 39/39, planner-batch 14/14, power 10/10,
  mine-plan 11/11, plan-replay 23/23, grow 6/6 and growth-geometry 45/45). Targeted T2 passed 3/3: routing lab,
  power-up and B37. Typecheck and build also passed after these changes.
- No tuning values or magic numbers were introduced.

### Pause handoff (2026-10-21)

Paused at the user's request with an uncommitted working tree and no test process intentionally left running. The
claim-query phase described in item 6 is implemented. No pre-existing bug of the target class was exposed: the new
claim-owner checks passed across the broadened planner, batch and growth fixtures. Their value so far is preventing
future one-sided updates and making policy differences explicit, rather than documenting a newly reproduced defect.

The full `npm run test:unit -- --no-build` was started after the targeted checks and then terminated when the pause
was requested. Suites observed before termination were passing, but this is **not** a completed full-T1 result and
must not be reported as one.

Resume in this order:

1. Run `npm run status`, then `npm run doctor`.
2. Rerun `npm run test:unit -- --no-build` to replace the interrupted full-T1 run with complete evidence.
3. If preparing to land the slice, run full T2; the focused routing/power/B37 selection is already green 3/3.
4. Continue the claim phase by migrating remaining direct claim reads and then writes through typed add/remove
   helpers. Extend prepared `PlanDelta` evidence to logical and claim changes, then address bootstrap/world claims.
   Do not merge the backing occupancy tables without profiling and an explicit design decision.
5. Keep old-save defaults, deterministic ordering and the 185-local Lua guard intact. Add a pure regression for each
   newly migrated mutation path and use T2 only for actual Factorio semantics.

No new tuning values or magic numbers were introduced in this phase.

### Proposed follow-up sequence (not approved SPEC decisions)

1. **Extend the new transaction boundary beyond physical build parts.** The first `PlanDelta` version now carries the
   validated candidate layout plus module/route/pole additions and removals. Next, move logical-graph changes and typed
   claim changes into its prepared evidence, validate those together, and make the adapter consume them in explicit
   deterministic phases. Factorio entity/job effects still cannot be rolled back like plain tables; fail before those
   effects wherever possible and record enough intent to reconcile an interrupted adapter phase.
2. **Finish the spatial-claim migration.** The typed owner/kind vocabulary, policy-specific conflict queries and first
   orphan checks now exist. Migrate the remaining reads and then route mutations through claim add/remove helpers;
   extend invariants to overlapping and one-sided claims, then cover bootstrap reservations and world ore claims.
   Only merge storage after profiling shows it is safe.
3. **Replace stringly identifiers and reasons at subsystem boundaries.** Add branded TypeScript IDs for goals,
   modules, routes, pole lines, jobs and claims where values cross layers. Give planner/adoption outcomes stable reason
   codes with separate human detail. Convert incrementally at constructors and serialization boundaries so old saves
   remain readable; avoid a repository-wide cast-only rewrite.
4. **Add model-sequence regressions.** Exercise sequences such as plan A starts → layout B mutates → A completes;
   route rip-up with taps and pole eviction; abandon/replan/adopt; and terminal goal transitions. Assert revision,
   claims, graph, build parts and diagnostics after every step. Prefer pure T1 models; add T2 only where Factorio ghost,
   inventory, entity-selection or save behaviour is the subject.
5. **Shrink the coordinator after the boundaries exist.** Move preparation and validation out of
   `strategy/factory.ts`; leave it responsible for scheduling and Factorio-facing orchestration. Add architecture
   checks for mutation entry points only after all legitimate call sites have migrated—premature source-shape rules
   would merely encourage bypasses.
6. **Runtime validation and landing.** Doctor, rebuild and targeted conflict T2 now pass; rerun the interrupted full
   T1 and then full T2. Capture a stale-plan interleaving at T2 if the runtime harness can do so cheaply.
   Run targeted replay/snapshot validation before any acceptance soak. Update this section with the final commit and
   evidence; do not call the work accepted based only on the current targeted post-claim evidence.

Suggested review slices: (1) land the lifecycle/revision/invariant foundation above together with the completed
`PlanDelta` preparation/adoption boundary; (2) claim abstraction; (3) branded IDs/reason codes. Each slice should
preserve old-save compatibility and finish with a pure regression before expanding the next boundary.

## M6b.31: claim write boundary and remaining policy reads (working tree, 2026-10-21)

Continues M6b.30 after its pause handoff. This records implementation and validation on the dirty tree; it is not an
acceptance result or a commit record.

### Completed in the current working tree

1. **One spelling for every claim tag.** The new leaf module `planner/claim-tags.ts` owns `m:<id>`, `x:<id>`,
   `x:<line>`, `p:<module>.<port>` and `lane:<port>`, plus `isPoleTag`, `isModuleTag`, `isOwnPortReservation` and
   `isLaneReservation`. `layout.ts` and `claims.ts` both import it; `layout.ts` re-exports `isPoleTag`/`portTag` (so
   existing consumers are unchanged) and `releasePoleTile` (so `strategy/factory.ts`, which already imports `layout` as
   a namespace, needs no new local).
2. **Paired add/remove writers.** `claims.ts` now exposes `claimModuleTile`/`releaseModuleTile`,
   `claimInteractionTile`/`releaseInteractionTile`, `claimPoleTile`/`releasePoleTile`, `reserveTile`/`reserveFreeTile`/
   `releaseReservation`/`releaseLaneReservation`, `claimRouteTile`/`releaseRouteTile`, and `claimMineTile`/
   `releaseMineClaims`/`claimSoftTile`/`releaseSoftClaims`. Every removal is conditional on the caller still owning the
   claim, and the mine/soft writers refuse occupied ground, so a stale cleanup can no longer free another owner's tile.
3. **Mutation sites migrated.** `layout.ts` (`markModule`, `unmarkModule`, `commitRoute`, `ripRoute`, `evictPoleLines`
   and `checkLayoutIndexes`), `power.ts` (`commitLine`, `removePoleLines`), `plan.ts` (the B57 lane reservation add and
   its end-of-plan clear) and `factory.ts` (`dropPlannedPoles`) now go through those helpers.
4. **Remaining policy reads typed.** `placement.ts`'s `rejectBlocker` hard-tile test and its whole-patch/expansion
   `taken` views now ask `placementClaimConflict`/`moduleGrowthClaimConflict`; the growth loop keeps its per-index
   reason strings by mapping the typed conflict code, so `planner-batch`'s "occupied at" assertion is unchanged. The
   new `moduleGrowthClaimConflict` states the policy once: a module's own footprint/interaction tags, pole lines and own
   port reservations give way, while another module, any route, another mine and another port's reservation are hard.
5. **Deliberately still raw.** Reads that are index mechanics or diagnostics rather than claim policy: the router's
   neighbour/victim scans, `plan.ts`'s lane identity checks, `runtime.ts`'s adapter view, `trace.ts`/`remote.ts`
   diagnostics, and the mine-completion loop (B25/B55) whose per-index reason strings are part of its evidence. They
   keep their own comments; they are not a policy fork.

### Validation on the dirty tree

- `npm run typecheck`: pass (architecture check plus runtime, settings and unit TypeScript projects).
- `npm run build`: pass under the 185-local guard. The first attempt (a new named `claims` import in `factory.ts`)
  pushed `factory.lua` to 186 main-chunk locals; routing the helper through the already-namespaced `layout` module
  restored it below the guard.
- `npm run test:unit -- --no-build`: **23/23 files passed**, including claims 6 (three new pure tests for the writers,
  the mine/soft pairing and the growth policy), planner 39, planner-batch 14, power 10, pole-eviction 4, plan-replay
  23 and goal-lifecycle 2. This replaces the interrupted full-T1 run recorded in M6b.30; it is a complete run.
- Targeted T2: routing lab, `power-up` and B37 all pass on the rebuilt mod (3 tests). Two `npm test` invocations were
  needed because `-` in a Lua pattern is a quantifier: `"power-up"` selects nothing, `"power%-up"` selects the test.
- `git diff --check`: pass. `npm run doctor`: 0 errors (the same stale active-run markers, no Factorio process).
- No tuning values or magic numbers were introduced.

### Learned rules recorded

- `CLAUDE.md`, TSTL gotchas: `import type` is erased and cannot create a Lua `require` cycle, so a module may
  type-reference a module that value-imports it; only value imports close the cycle.
- `docs/agent/architecture.md`: a single new named import can push a coordinator's Lua chunk over the 185-local guard;
  import the module as a namespace, or re-export the helper through an already-imported module, instead of adding a
  local.

### Next

M6b.30's ordered step 4 still stands: extend prepared `PlanDelta` evidence to logical and claim changes, then address
bootstrap/world claims. The first part was approved in-session by the user and implemented as M6b.32 below.

## M6b.32: PlanDelta logical and claim evidence (working tree, 2026-10-21)

User decision in-session 2026-10-21: extend the prepared `PlanDelta` evidence to logical and claim changes (the
handoff's next step). This records implementation and validation on the dirty tree; it is not an acceptance result or
a commit record.

### Completed in the current working tree

1. **Prepared logical evidence.** `PlanDelta.logical` carries `routesByConn` (connection role → its candidate routes in
   `routeOrder`, a tap's base route first) and `poleLines` (id, to, from in order). Both are derived once from the
   validated candidate, so `adoptPlan` no longer re-scans `layout.routeOrder` per belt edge, and `powerEdges` consumes
   the prepared lines instead of re-reading the layout.
2. **Prepared claim evidence.** `PlanDelta.claims` carries `takenTiles` (the new parts' tiles plus whole-patch mine
   claims, deduped in `partTiles` order) and `mineClaims` (added module id → its claim tiles, in `add.modules` order).
   `adoptPlan`'s B15/B23 `taken` set and `evictSites` call now consume `takenTiles` instead of re-deriving it from
   `partTiles` plus a separate `minePlan` loop.
3. **Validation still precedes derivation.** The revision check, `checkLayoutIndexes` and `checkClaimOwners` all run
   before any evidence is built, so a stale or inconsistent candidate is rejected before the adapter sees a delta. The
   physical add/remove evidence is unchanged.
4. **Not yet migrated.** The adapter still creates Factorio entities and jobs directly (they cannot be rolled back like
   plain tables); the mine-completion path (`job.expanded`) still reads the candidate layout; and `powerEdges` keeps
   its layout fallback for the growth path (`startGrow`). The follow-up list records the remaining work.

### Validation on the dirty tree

- `npm run typecheck`: pass (architecture check plus the three TypeScript projects).
- `npm run build`: pass under the 185-local guard (no new import was needed: the evidence arrives through the existing
  `plan-delta` import).
- `npm run test:unit -- --no-build`: **23/23 files passed**, planner 40 (one new pure test derives the logical and
  claim evidence, checks tap ordering, dedup and determinism, and confirms the base module's ground is not taken).
- Targeted T2 on the rebuilt mod: routing lab, `power-up` and B37 all pass (3/3), covering both plan-adoption paths
  the change touches.
- `git diff --check`: pass. `npm run doctor`: 0 errors. No tuning values or magic numbers were introduced.

### Next

Remaining from the approved direction and the follow-up list: make the adapter's Factorio-facing phases explicit and
reconcilable; and cover bootstrap reservations and world ore claims. The first half was implemented as M6b.33 below.

## M6b.33: completed-mine evidence and explicit adoption phases (working tree, 2026-10-22)

User decision in-session 2026-10-22: continue with the next stage after M6b.32. This records implementation and
validation on the dirty tree; it is not an acceptance result or a commit record.

### Completed in the current working tree

1. **Completed-mine evidence.** `PlanDeltaInput` gained `expanded` (request id → placed module, from the plan's
   expansion decisions). `PlanDelta.mineCompletions` now carries, for each built base module whose whole-patch mine
   the plan completed, the entities the adapter must add — derived once from the validated candidate, in candidate
   module order (not `pairs` table order). `adoptPlan` consumes it instead of iterating `pairs(job.expanded)`,
   re-reading the layout and calling `partEntities` per module. The adapter still filters against the surface's
   existing entities, which is a runtime query; the pure derivation no longer happens there.
2. **Explicit adoption phases.** `adoptPlan`'s header now documents the fixed phase order and the invariant that no
   persistent or engine effect happens before the prepared delta is validated: reads → layout swap and logical edges
   → world evictions → reservations and ore-field claims → build job and completed-mine additions. This is a
   documentation boundary, not a new mechanism; the reconciler for an interrupted adapter phase remains proposed.
3. **Still adapter-side.** The world-effect phases (evicting sites and poles, `brain.reserved`, `claimModuleFields`,
   `startBuild`) remain Factorio-facing and cannot be rolled back like plain tables. Bootstrap reservations and world
   ore claims are still plain `Record<number, boolean>` tables with no typed owner, so they are not yet covered by an
   invariant.

### Validation on the dirty tree

- `npm run typecheck`: pass.
- `npm run build`: pass under the 185-local guard.
- `npm run test:unit -- --no-build`: **23/23 files passed**, planner 41 (one new pure test: a completed base mine
  yields its entities; a non-base module and an incomplete mine yield none).
- Targeted T2 on the rebuilt mod: routing lab, `power-up` and B37 all pass (3/3).
- Full T2: `npm test -- --no-build` on the same build the soak runs: **150 passed, 0 failed, 0 skipped** (8 shards,
  1004 s wall / 7042 s of test time). Run concurrently with the acceptance soak, so wall and per-test durations are
  inflated by CPU contention; pass/fail is unaffected. No test was skipped.
- `git diff --check`: pass. No tuning values or magic numbers were introduced.
- **Acceptance soak `m6-final2` is running on this build** (`tools/harness/m6.toml`: seeds 11, 222, 3333, 44444,
  555555; 8 game-hour cap; fail-fast). Its scorecard is `out/soak/m6-final2/`. An earlier `m6-final` soak was
  deliberately stopped before it produced results because the build changed; it is not evidence and its partial
  output was removed.

### Next

Remaining from the approved direction: make the adapter's Factorio-facing phases reconcilable (an intent record that
survives an interrupted adoption), and give bootstrap reservations and world ore claims a typed boundary. Both were
implemented as M6b.34 below.

### Acceptance soak `m6-final2` (interrupted harness, reconstructed result)

The host restarted at 2026-10-22 02:07 while the soak was running, cancelling `soak.py`. Three seeds had already
finished and were scored; the other two were orphaned `--benchmark` processes, ran to the full 8 game-hour cap on
their own, and exited cleanly. The harness's `scorecard.md` is therefore **PARTIAL 3/5** and must not be quoted as
the run's result. Reconstructed from each seed's `factorio-current.log`, `telemetry.json` and `done.json`:

| Seed | Result | Done / end | Evidence |
|---|---|---|---|
| 11 | pass | `v1-done` @ 208.3 min | scorecard |
| 222 | pass | `v1-done` @ 238.2 min | scorecard |
| 44444 | pass | `v1-done` @ 183.3 min | scorecard |
| 555555 | pass | `v1-done` @ 232.7 min (tick 837570) | `done.json` + log; harness did not score it |
| 3333 | **non-pass** | cap @ 480 min; `research-goal-done` @ 273.5 min (tick 984510), no `science-sustained`, no `v1-done` | log + telemetry |

So the tree is 4/5 on the v1 bar, not 3/3. Seed 3333's best 30-minute window was 27.7 red / 23.4 green per minute
(below the 30 + 30 bar); science production stopped at 319 game-minutes and the factory idled to the cap
(`waiting: no researchable technology`, 42/42 techs researched). Its log shows the power block's fuel edge failing
repeatedly: `coal>power=>power.in-fuel: route crosses itself` for goals g22–g45 (4 attempts each, one new goal every
~180 ticks), plus `g9 mall` failing with 10 stuck pole ghosts and `g50` reporting `no path` fuel edges. This is the
known B28/B29 shape (feed route never widens / power short), but seed 3333 passed the previous acceptance runs at
~285 game-minutes, so the change in outcome has **not** been attributed. It must be diagnosed
(`npm run diagnose -- m6-final2 3333`) against the previous passing run before calling it a regression or a flake.

Consequence for the landing plan below: the soak is not green, so the commit is **not** made yet and no acceptance
result is claimed. The architecture slice itself still has T1 23/23 and full T2 150/150.

Diagnosis of seed 3333 (`npm run diagnose -- m6-final2 3333`, after copying the orphaned seed's telemetry into
`out/soak/m6-final2/seed-3333/`): at tick 935580 (~260 min) node n6 (`coal>power`) is
`growth-rejected (its patch has no better part left (50 ore tiles, its drills reach 82))`. The design then creates a
replacement power goal g21 (`no feasible position (1 of 1 patches tried)`) and g22–g45, which each fail
`coal>power=>power.in-fuel: route crosses itself` after four attempts. The coal feed to the power block is therefore
never rebuilt, and science production stops at 319 min. This is the B28/B29 shape, not a claim-boundary symptom. The
remaining invariants at the final tick are the expected end-state kind (`node n31/n33/n69 built without layout
module` after the failed mall relocation; `build-job-missing` for the finished goal's pruned jobs), not new claim
violations. Filed as **B59** (open) with the artifacts and the bisect next step.

Tooling fix made while diagnosing: `tools/diagnose.mjs` crashed on a completed run because the telemetry encoder
writes an empty Lua list as `{}`; it now normalises lists with an `Array.isArray` helper. That is an unrelated tool
bug, not mod behaviour.

### Landing (2026-10-22)

The architecture-hardening work from M6b.30 through M6b.33 is one review slice on `m6-v1`, committed together with
this report update and B59 (open). It cannot be split cleanly at file granularity: `layout.ts`, `plan.ts` and
`factory.ts` each carry both the lifecycle/revision/`PlanDelta` foundation and the claim migration, so a split needs
hunk surgery and would risk a non-building intermediate commit. The commit records the architecture slice and the
soak's partial result; it does **not** claim acceptance, because seed 3333 is a non-pass (B59). Full T2 passed
150/150. Message:

```
M6b: architecture hardening — goal lifecycle, layout revision, plan deltas, typed claims

- strategy/goal-lifecycle.ts: the legal goal status graph; factory.ts changes
  status only through transitionGoal (enforced by check-architecture).
- LayoutState.revision: monotonic; plan jobs record their base revision and
  adoption rejects a stale plan without spending a planning attempt.
- planner/plan-delta.ts: a completed plan is validated (revision, derived indexes,
  claim owners) and its physical, logical, claim and completed-mine evidence
  derived once before the adapter changes state or creates Factorio work.
- planner/claims.ts + planner/claim-tags.ts: one typed ownership vocabulary over
  the existing indexes, policy-specific conflict queries, orphan and one-sided
  checks, and paired add/remove writers whose removals are ownership-checked.
- Tests: pure goal-lifecycle, claims, layout-revision, index, plan-delta and
  evidence regressions; index and claim invariants in the batch and growth
  fixtures. Docs: architecture.md, CLAUDE.md TSTL gotchas, M6 report M6b.30–33.
```

The full T2 run was started with `--no-build` so it did not rewrite `mod/build` while the soak read it; it passed
150/150 (see above). The commit leaves B59 as the only open item from this work; the remaining proposals above
continue from a clean tree.

## M6b.34: adoption-phase record and typed world claims (working tree, 2026-10-22)

User asked to work through items 1 and 2 of M6b.33's next list. This records implementation and validation on the
dirty tree; it is not an acceptance result or a commit record.

### 1. Reconcilable adoption phases

- `strategy/adoption-intent.ts` (pure, T1-tested) owns the phase vocabulary `prepared → state → world → build`, the
  forward-only advance, and the resume/stale decision. `FactoryState.adoption` persists the record; old saves have no
  such field.
- `strategy/adoption-runtime.ts` holds the factory-side glue (kept out of `factory.ts` for the 185-local guard):
  `reconcile` clears a record whose goal is no longer planning or whose plan vanished (the post-commit crash window)
  and emits `adoption-intent-cleared`; `begin` emits `adoption-resumed` or `adoption-intent-orphaned`; `advance`
  records each phase; `queueClear` dedupes clear jobs.
- `factory.ts` reconciles at the start of every think, begins the record before the layout swap, advances after the
  state, world and build phases, and clears it immediately after `transitionGoal(..., "building")`.
- A resumed adoption re-runs from the top safely: graph `addNode`/`addEdge` replace by id, `evictSites` skips
  retired/failed sites, `dropPlannedPoles` is idempotent, `entry.build` is reused instead of re-created, completed-mine
  entities are deduped against `extraAdd`, and `startBuild`'s clear jobs are deduped with `clearJobFor`.
- Tests: T1 `adoption-intent` (4) and T2 `factory` "M6b: a persisted adoption record survives a save and is cleared
  once its goal committed" (sets a record for a committed goal, saves/reloads, and asserts the next think clears it
  with the diagnostic).

### 2. Typed bootstrap reservations and world ore claims

- `world/claim-index.ts` (pure, T1-tested) is the typed owner/kind boundary: tag spelling (`site:`, `module:`, `route:`,
  `pole:`, `mine:`), paired `reserveWorldTile`/`releaseWorldTile`, `syncWorldClaims` (rebuild from live sites plus the
  layout's module footprints/margins, routes, poles and mine claims; drops stale tiles and orphaned owners), and
  `checkWorldClaimOwners` (tagged orphans, one-sided entries, malformed tags; untagged old-save tiles stay
  compatible). Ore fields get typed helpers used by `claimOreField`.
- `BrainState.reservedBy?: Record<number, string>` pairs each reservation with its owner. `resyncReserved` is now a
  thin wrapper over `syncWorldClaims`; bootstrap site reservation/release and eviction go through the helpers.
- `factoryDiagnostics` builds the live-owner set (non-retired sites plus layout modules, routes, poles and mines) and
  reports `world-claim` invariants, so an orphaned tag or a one-sided owner shows up in telemetry and `npm run
  diagnose`.
- The owner index adds one string per reserved tile to new saves (Lua interns the repeated tags). There is no new
  tuning number; old saves keep the previous behaviour and are not reported.

### Validation

- `npm run typecheck`: pass.
- `npm run build`: pass under the 185-local guard (the first attempt reached 186; moving the adoption glue into its
  own module and namespacing `planner/grow` brought it back).
- `npm run test:unit -- --no-build`: **25/25 files passed**, including the new `adoption-intent` (4) and
  `world-claim-index` (3) suites; planner 41 and claims 6 unchanged.
- Targeted T2: the new save/reload adoption test passes.
- Full T2 (`npm test -- --no-build`, 8 shards): **151 passed, 0 failed, 0 skipped** in 1075.0 s wall (4498.6 s of
  test time).

## M6b.35: claim agreement, branded goal ids, decision codes and model sequences (working tree, 2026-10-22)

Continues the M6b.33 follow-up list with items 1–3: the mine-vs-soft owner agreement, the first branded-ID and reason-
code slice, and model-sequence regressions. Not an acceptance result or a commit record.

### 1. Mine-vs-soft owner agreement

- `claimMineTile` now releases another module's soft claim (and its unit) on the tile it hard-claims, and
  `claimSoftTile` refuses a tile another module has claimed as mine. The disagreement is therefore prevented at the
  write boundary, not only reported.
- `checkClaimOwners` still reports a persisted/old-save state where the two owners differ. A mine's own ground is
  claimed both ways on purpose (`layout.ts`), so only the disagreement is a problem: growth cannot use it (the hard
  claim refuses) but soft queries would still read it as free.
- Tests: `claims` adds same-owner acceptance, different-owner rejection, stale-soft release and the soft-write refusal.

### 2. Branded ids and stable decision codes

- `shared/ids.ts` declares branded `GoalId`, `ModuleId`, `RouteId`, `PoleLineId`, `JobId` and `ClaimTag`, with
  constructors. Brands are compile-time only, so saves, Lua comparisons and diagnostics keep their runtime shape.
- `GoalId` is migrated end to end: `FactoryGoal.id`, goal construction (`g${f.nextGoal++}`), `goal-lifecycle` calls,
  the adoption record and diagnostic events. Module/route/pole/job/claim brands remain declared for later slices; the
  policy is construct-at-the-owner, no casts at use sites.
- `DiagnosticDecision` types every telemetry decision string (`idle`, `batch`, `haul`, `growth-rejected`,
  `adoption-*`, `stale-plan-rejected`, `invalid-plan-delta`), so a typo cannot invent a code host tools must learn.
  `PlanDeltaRejectionCode` names the plan-delta rejection codes; prose stays in `reason`/`detail`.
- Tests: T1 typecheck/build; `adoption-intent` uses the branded constructor.

### 3. Model-sequence regressions

- New T1 suite `model-sequences` chains the boundaries in runtime order and asserts revision, indexes, claims and
  prepared evidence after every step:
  1. plan A → B commits → A rejected as `stale-base-revision` with no side effects → replan from B's revision adds
     only the intended module;
  2. routed plan → adopt the candidate revision → abandon its routes → claims and indexes clean → replan on the freed
     ground;
  3. module abandonment releases its footprint/claims → a replan takes the same ground with a ready delta.
- Existing suites already cover growth rip-ups with splitter taps and the goal-transition matrix; the new suite covers
  the hand-off between them.

### Validation

- `npm run typecheck`: pass (architecture check included).
- `npm run build`: pass under the 185-local guard.
- `npm run test:unit -- --no-build`: **26/26 files passed**; `claims` 8, `model-sequences` 3, `adoption-intent` 4.
- Full T2 (`npm test -- --no-build`, 8 shards): **151 passed, 0 failed, 0 skipped** in 642.9 s wall (4721.8 s of
  test time).

### Next (refactor)

- Migrate the remaining brands (module, route, pole line, job, claim) at their owners, one boundary at a time.
- Shrink `strategy/factory.ts` (still ~2.3k lines) once preparation/validation sit behind those boundaries.
- Surface `checkClaimOwners` in `factoryDiagnostics` for rejected plans (M6b.35 only runs it during validation).
- B59 attribution and a fresh 5-seed acceptance soak remain the release gate.

## M6b.36: ModuleId brand, first storage boundary (working tree, 2026-10-22)

First slice of the remaining brand migrations. Not an acceptance result or a commit record.

### Scope

- `PlacedModule.id`, `GoalNode.id`, `LogicalNode.id` (and `LogicalEdge.from`/`to`), `PhysNode.id` are `ModuleId`.
  The goal graph constructor and the planner's placement are the owners and call `moduleId(...)`.
- Stored claim owners are branded: `LayoutState.mine` / `soft` values are `ModuleId`; the claim writers receive the
  string and construct at the storage boundary (`claimMineTile`, `claimSoftTile`). `PoleLine.to`, `PoleSearch.target`
  and `powerRoles` return/accept `ModuleId`.
- Deliberately **not** branded yet: `ModuleRequest.id`, `PlacementRequest.id`, `PortRef.module`. They stay strings
  until the route/connection slice, where their crossing boundary is defined; branding them now would churn every
  fixture without adding a check. `ModuleDef.id`, `canonical.id` and `LogicalNode.module` are definition ids and must
  never become `ModuleId`.
- `mod/unit/ids.test.ts` pins the one invariant that matters for saves: every constructor is the identity at runtime,
  so old values, Lua comparisons and telemetry are unchanged.

### Validation

- `npm run typecheck`: pass (architecture check included).
- `npm run build`: pass under the 185-local guard.
- `npm run test:unit -- --no-build`: **27/27 files passed** (new `ids` suite).
- Full T2 (`npm test -- --no-build`, 8 shards): **151 passed, 0 failed, 0 skipped** in 746.0 s wall (5289.0 s of
  test time).

### Next

- Route/connection slice (`RouteId` + `ConnectionId`), then pole line/pole, claim tags, and job ids.
- `strategy/factory.ts` shrink and the diagnostic `checkClaimOwners` wiring remain after the id slices.

## M6b.37: RouteId and ConnectionId (working tree, 2026-10-22)

Second brand slice. Not an acceptance result or a commit record.

### Scope

- `Route.id`, `Route.tapOf`, `routeOrder`, `routeOcc` values and `ripRoute`/`reroute` route lists are `RouteId`;
  `BuildParts.routes` and the prepared `PlanDelta` route evidence follow.
- `ConnectionRequest.id` and `Route.conn` are `ConnectionId`; the factory converts an edge role at the connection
  boundary. Route construction (`router.ts`, `externalStub`) and reroute planning are the owners that call
  `routeId(...)`/`connectionId(...)`.
- Still strings on purpose: `PortRef.module` and `ModuleRequest.id`/`PlacementRequest.id` (their own later slice), and
  `LogicalEdge.physical` because it mixes route ids with pole-line ids; the power slice will split it.
- Old saves are untouched: both brands are erased at runtime, and `ids` still pins constructor identity.

### Validation

- `npm run typecheck`: pass.
- `npm run build`: pass under the 185-local guard.
- `npm run test:unit -- --no-build`: **27/27 files passed**.
- Full T2 (`npm test -- --no-build`, 8 shards): **151 passed, 0 failed, 0 skipped** in 129.5 s wall (945.6 s of
  test time).

### Next

- Pole line/pole slice, then claim tags, then job ids; after that the `PortRef.module`/request-id close-out and the
  `factory.ts` shrink.

## M6b.38: PoleId and PoleLineId (working tree, 2026-10-22)

Third brand slice. Not an acceptance result or a commit record.

### Scope

- `PlannedPole.id` and `BuildParts.poles` are `PoleId`; the pole planner constructs ids at the line it lays.
- `PlannedPole.line`, `PoleLine.id` and the `poleLines` evidence are `PoleLineId`; `PoleJob.added` is `PoleId[]` and its
  `pending`/`connected` owners are `ModuleId`.
- `PoleLine.from` stays a string: it is the owner marker of the powered pole (or `"?"`), not a pole line id. Claim
  tags such as `x:poles:<line>` stay strings until the claim-tag slice.
- Brands are erased; old saves are unchanged.

### Validation

- `npm run typecheck`: pass.
- `npm run build`: pass under the 185-local guard.
- `npm run test:unit -- --no-build`: **27/27 files passed**.
- Full T2 (`npm test -- --no-build`, 8 shards): **151 passed, 0 failed, 0 skipped** in 165.3 s wall (1226.4 s of
  test time).

### Next

- Claim tags (layout and world), then job ids; the request/port-id close-out and `factory.ts` shrink follow.

## M6b.39: claim tags and job ids (working tree, 2026-10-22)

Final brand slices for the claim/index and job boundaries. Not an acceptance result or a commit record.

- `LayoutClaimTag` (`m:`, `x:`, `p:`, `lane:`) types `LayoutState.occ`/`reserved`; `WorldClaimTag` (`site:`,
  `module:`, `route:`, `pole:`, `mine:`) types `BrainState.reservedBy` and the world claim index. The constructors in
  `planner/claim-tags.ts` and `world/claim-index.ts` are the owners; predicates still accept plain strings.
- `JobId` covers `Job.id`, `deps`, `JobSpec.deps`, `addClearJob`/`addPlaceJob` returns, build-job arrays, `SitePart.job`,
  `ghostJobs`, `FactoryGoal.clearing` and diagnostic events. `Board.nextId` and the `jobs` table key stay numeric.
- Still plain strings: `PoleLine.from` (owner marker) and `ModuleRequest.id`/`PlacementRequest.id`/`PortRef.module`
  (request-local close-out), which do not cross a stored boundary.
- Brands are erased; the `ids` suite pins constructor identity.

Validation: typecheck and build pass; T1 **27/27**; full T2 **151 passed, 0 failed** in 349.8 s wall.


## M6b.40: B59 relocation wait and depleted no-expand mines (working tree, 2026-10-22)

B59 diagnosis from the `m6-final3` seed-3333 fail-fast (tick 950900) and the targeted reruns.

- **Race:** D55 gives up a depleted mine and the design starts its replacement goal in the same think. The old footprint is still `OWN` until the relocation's clear jobs run, so the plan sees a fragment of the patch and burns its attempts (`no feasible position (1 of 1 patches tried)`). `FactoryState.relocation` records the clear jobs; `startGoal` defers a goal whose node roles are still being deconstructed and continues with other goals.
- **Second cause:** a depleted mine with no `expand` and no whole-patch plan repeated `cannot grow: no expandable module` and starved its consumers. The D55 path now tries `reclaimWholePatch` first (reuse the footprint, keep the routes, add drills) and relocates only when the patch has no better part left.
- New pure boundary `strategy/relocation.ts`; T1 `relocation.test.ts`. `factory.ts` stays under the 185-local guard (namespace import; the fuel/lab minute constants are grouped to make room).

Validation:
- `b59-fix3` seed 3333: **pass**, v1-done at **271.1 game-min**, best science window **1.086**, 0 stalls, 0 replans.
- `npm run test:unit -- --no-build`: **28/28** files.
- Full T2: **151 passed, 0 failed**.
- Full 5-seed acceptance soak `m6-final4` on `ebc0938`: **5/5**, no stalls or replans.

  | seed | v1-done (game-min) | best science window |
  |---|---|---|
  | 11 | 208.3 | 1.092 |
  | 222 | 240.2 | 1.019 |
  | 3333 | 271.1 | 1.086 |
  | 44444 | 183.3 | 1.351 |
  | 555555 | 222.7 | 1.168 |

  Seed 222 exercised the reclaim path (`goal g20 moves it to the next part of its patch (D55)`); seeds 3333 and
  555555 exercised the relocation fallback (n26 and n42). Work counts: 49 flagged against the soft baseline, mostly
  router/scan counters; the acceptance gate is pass/fail on v1-done, not the soft work gate.


## M6b.41: B58 splitter tap on a replaced route (working tree, 2026-10-22)

The min-160 graph dump showed the coal feed `n39 -> n37` was a splitter tap whose splitter tile was covered by the
parent route's underground span. Its west input was the underground end, not a belt, so it received nothing while the
logical edge still looked connected and the repair said "nothing missing".

- `commitRoute` now rips an existing route (and, recursively, its splitter taps) before replacing it in place.
- `spanConflicts` treats a tap's splitter tile as a conflict, so a later underground span blocks or rips the tap.

T1 `planner` B58 ×2; full T2 151/151. Seed 1212121 `b58-fix2`: **v1-done 212.7 game-min**, 0 stalls.

**Superseded by M6b.43:** the broad tap/span check fixed seed 1212121 but changed seed 3333's cluster geometry and
made it fail. The g16 replay showed the tap search itself ripping its trunk; the tap was then committed with a
dangling `tapOf` and the re-routed trunk covered its input. `commitRoute` rip-up cannot catch that ordering.

## M6b.42: B28 sealed replacement leaves the pocket (working tree, 2026-10-22)

Part 2 of B28: `tryReplace` excluded only the old footprint, so it could choose an adjacent site in the same pocket and
repeat the unroutable feed. A sealed failure now avoids `replacementAvoid(old rect, router.margin)`; ordinary
congestion keeps the tight rectangle because padding every replacement broke the `seed3333-production-ok` comparison.
T1 adds `replacementAvoid`; the affected replay plans again. Review and options: `docs/analysis/B28-review.md`.

## M6b.43: B58 tap/trunk protection and the B28 behavior regression (5d55fc2, 8bd2a29, 2026-10-23)

### B58: the tap ripped its own trunk

The real g16 plan (`out/soak/b58-riponly2/seed-1212121/plans/1/g16-a2-t336600.input.lua`, copied to
`mod/unit/fixtures/b58-g16.lua`) reproduces the stale `n39 -> n37` coal tap deterministically. Instrumenting
`commitRoute` showed the order:

1. the `n39 -> n35` trunk was committed;
2. the `n39 -> n37` tap search used a tile of that trunk, so the trunk was a victim;
3. `routeStep` ripped the trunk, committed the tap with `tapOf` pointing at the now-absent trunk, and re-queued the
   trunk;
4. the trunk re-routed (its new path had an underground span at 452..457 on y=36) and `commitRoute` saw no existing
   route of that id, so it did not rip the orphan tap. The splitter at (453,36) stood above the span with no belt
   feeding it.

The trunk cannot be replaced by the old broad `spanConflicts` tap check: that check also blocked unrelated spans and
changed seed 3333's cluster geometry, failing the acceptance seed. The fix is local to tap routing:

- `tileCost` refuses a tile of any route in `req.taps` even in rip mode. A tap may not rip a route it could tap.
- An underground span may not overlap any route in `req.taps` for the same reason.
- A retry guard still refuses to commit a tap whose result lists its trunk as a victim.
- `commitRoute` keeps ripping a same-id route and its taps for ordinary in-place replacement.

T1 replay: `B58: a splitter tap never sits on the span of the route it taps`; it fails without the protection.

### B28: sealed replacement behavior regression

The existing `replacementAvoid` test only checked rectangle arithmetic. The new `planner` test builds a sealed room,
routes a feed into it, and lets `tryReplace` move the consumer. With `replacementAvoid(old rect, router.margin)` the
module leaves the margin; with `pad = 0` it lands at (8,29), inside the band the failed route had to cross. It pins
the behavior that B28 part 2 fixed, not just the helper.

### Validation

- T1: **28/28 files**.
- Full T2: **151 passed, 0 failed, 0 skipped** (8 shards, 386.1 s wall).
- B58 seeds: 1212121 **v1-done 213.7 game-min**; 3333 **267.1**; both 0 stalls, 0 replans.
- Full 5-seed acceptance `m6-final6` (same build, 5 parallel): **5/5**; 11 207.3, 222 240.2, 3333 267.1, 44444 190.3,
  555555 171.7 game-min; 0 stalls, 0 replans. AI ms/tick from this run is not a performance measurement (five
  Factorio instances shared the laptop).
