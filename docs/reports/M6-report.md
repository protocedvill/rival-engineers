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
| `TRAPPED_NO_PATHS` | `jobs/crew.ts` | 3 no-path failures in a row | Boxed-in detection: one or two failures happen on busy sites. Guess. | no |
| `UNBOX_RADIUS` | `jobs/crew.ts` | 3 tiles | The small entities around a boxed-in member it may pick up (within reach). Guess. | no |
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
