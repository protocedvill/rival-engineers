# M6 report

Status: **compact summary (2026-11-06)**. The full slice-by-slice journal — every diagnosis, commit and validation
detail from M6a through M6b.50 and the M6c acceptance checks — is preserved at
[`docs/archive/M6-report-full-2026-11-06.md`](../archive/M6-report-full-2026-11-06.md) (its M6c section has every
acceptance run). Work committed after M6b.49 (B62–B66, 2026-10-25/27) is recorded in [`docs/BUGS.md`](../BUGS.md).

**M6 acceptance passed (M6c, 2026-10-29/30).** Random 20: **20/20** (`m6-random20-8f39d07`). Fixed 10: **9/10**
(`m6-fixed10-845a46b`; seed 222 held ~18/min, deferred to M7 by the user, D71 (a)). Two factions: **3/3 seeds, 6/6
factions** (with D70). Space Age smoke and T4 determinism pass; timelapses approved by the user in-session 2026-10-30.

## 1. Scope and acceptance bar

M6 is v1: from a fresh map, one faction with the default crew reaches **≥ 30 red + 30 green science/min sustained over
30 game-min within 8 game-hours** (`science-sustained`) and researches every D30 red/green technology
(`research-goal-done`); together these are `v1-done`. SPEC §3 requires **≥ 9/10 fixed and ≥ 18/20 random seeds**,
two-faction runs, a Space Age smoke test and determinism. The work below also covers the bug backlog B14–B61 and the
M6 decisions D52–D64.

## 2. Result at a glance

| Run | Build | Seeds | Result |
|---|---|---|---|
| `m6a-final` | `ef994fa` | 5 | **1/5** (44444 only) |
| `m6a2-accept2` | B27/B28 partial | 5 | **0/5**; B28/B29 classes open |
| `m6-final2` | architecture slice | 5 | **4/5 reconstructed**; seed 3333 non-pass (B59) |
| `m6-final4` | `ebc0938` | 5 | **5/5** (11 208.3, 222 240.2, 3333 271.1, 44444 183.3, 555555 222.7 min) |
| `m6-final6` | B58 build | 5 | **5/5** (11 207.3, 222 240.2, 3333 267.1, 44444 190.3, 555555 171.7 min) |
| `m6-b60s-provider` | provider slice | 2 | **2/2** (8646103 233.5, 2229258 185.2 min), 0 stalls |
| `m6-b60v-handover` | `0938ab0` | 2 | **2/2** (8646103 232.5, 2229258 185.2 min) |
| `m6-prof` | `82ebc36`+ | 3 | 98765 done at 198.7; 3333/6666666 diagnosed, then 221.8/222.3 after B54–B56 |
| `m6-random20-8f39d07` | `8f39d07` | 20 | **20/20**, no stalls; v1-done 175–258 min (median ~212) |
| `m6-fixed10-845a46b` | `845a46b` | 10 | **9/10**; 222 failed at the cap (~18/min, D71 (a), deferred to M7) |
| `m6-two-factions-845a46b` + `…-3333-d494226` | `845a46b`, `d494226` | 3 | **3/3 seeds, 6/6 factions** (3333 with D70) |
| Space Age smoke / T4 determinism | `981ca35` | 11 | **pass** / **pass** (identical state at 30 and 45 min across 3 runs) |
| Timelapses | `3c2c18f` | — | **approved by the user** in-session, 2026-10-30 |

Test suites at the end of M6b.49: T1 **35/35** files, T2 **152/152** tests (8 shards). Earlier slices are quoted in
their sections below.

## 3. What was built

### 3.1 M6a: the 30 + 30 stage (2026-10-16/17)

Stage-2 design (red + green targets, curated `green-line-hellpet`, production clusters around one steam block, labs
sized by count), `factory-design-margin`/`factory-lab-sizing`/`factory-sustain-minutes`, `power#2`, shared providers
through splitter taps (B19), planned-site eviction of bootstrap sites (B15), stuck-build escalation and B22 unboxing,
buffer heads on assembler rows and circuit blocks (B14), `m6_scorecard.py`, and the close-out fix that makes a grown
module rip and reroute its splitter taps (`d4476ab`). Key commits: `b8d8e0e`, `baf27d3`, `a08877b`, `92ffef3`,
`7d93796`, `6db6e37`, `38803f5`, `d4476ab`, `ef994fa`.

Result: 1/5. The failures were coal running out for power/clusters (P36) and one new seed-11 green-line `no path`;
both handed to M6b. T2 was 112/112 after the shard-timeout fix (`f35878b`, `ef994fa`).

### 3.2 M6a.2/M6a.3: whole-patch mines, stale ground, escapes (2026-10-17/18)

- **Seed 222 (M6a.2):** three independent stalls — a depot ring walling in the labs' pack port, stale terrain after
  crew mining (crew pick-up raises none of the terrain events), and an inverted splitter-tap chain that growth never
  ripped. Fixes: depots evict like bootstrap sites, retired sites release their ground, growth rips the tap group to
  its root, every ghost-drop/pick-up rescans terrain, and hand-fuelling skips a producer being grown.
- **B21/B23/D52 (M6a.2):** whole-patch mine plans and completion of a fixed, partially built base mine
  (`bec529b`); the mall iron request can target it, adoption evicts sites on its claim, and a failed completion names
  the blocking tile (`wholeFail`).
- **B22 (M6a.3, `1b198fd`):** a stuck member mines neutral trees/rocks or picks up one own entity, in reach, up to
  16 trees per escape, and retries later instead of dropping its work every cycle.
- **B24:** whole-patch pole under the complete belt layer crashed a run; the full plan's belts now block partial
  poles.

Acceptance `m6a2-accept2`: **0/5**. The fast deaths were B28 (feeds boxed in by the infrastructure web), B29 (power
short + growth bands blocked), B27 (shared-mine completion; fixed the same evening) and a B24 crash.

### 3.3 M6b.1–M6b.29: bug-driven hardening (2026-10-19/21)

Each item below is a fix with its regression; full reasoning is in the archive.

- **Crew sourcing:** preemption for high-priority work (B17, `951e1da`), then only urgent refuels and only the
  nearest member (B30/B31); direct take from supply points and removal of collect transfers (B32); proactive temp-cell
  stocking (B18, `32076d2`); module buffers registered and temp-cell top-ups stopped at their output buffer (B36).
- **Planning:** B25 module belts never spill off the footprint; B26 growth bands kept clear at placement
  (`987553b`); B33 growth geometry audited for every module type, whole-patch mines and the *Growth plans* overlay
  (`7250e36`); B37 pole lines evictable nearly free; B41 live poles reused instead of ghosted over; B43 a replanned
  line joins the owner's whole pole component; B44 whole-patch plans independent of patch position.
- **Review tools:** B35 spectator hotkeys and the top-left review toolbar; B34 *Report…* diagnostic bundle
  (`fb31183`).
- **Power and routes:** B38 depot-ore feeds; B39 a second steam block joins the network; B42 an escape pick-up does
  an active clear job and queues no ghost; B45 other modules' open port lanes stay reachable; B46 evicted poles leave
  a building goal's plan; B47/B48 two completed mines both build and a completed mine is measured whole.
- **Depletion and exploration:** D54 hand-fed boilers then electric coal mines; D55 a worked-out mine reclaims its
  patch, else relocates; B49/B50 alias nodes dropped and free patches ranked (D57 patch index); D56 radar for
  realism; D58 two-level routing and one shared planner budget; B51 sealed smelter inputs relocated; B52/D59 steam
  coal and soft-claim cost by growth unit; B53/D60 site-retry pause; B54/B55/B56 power-first poles, mine output pole,
  stale route belts (`964e95e`, `54c7617`, `008ac34`); B57 lane/seal checks (`0787461`); D62 radar arms and the
  finding that faction radars do not chart (`on_sector_scanned` only).

Notable measured effects: the **seal check** cut failing replays from 200–350 s to under 4 s and T1 from 8:16 to
4:58; module validation dropped from ~6,300 s to ~2,150 s via fuel priming and measuring the steady windows; `m6-prof`
AI time was 3.7–4.3 ms/tick under `-j 3` (not a performance measurement).

### 3.4 M6b.30–M6b.39: architecture hardening (2026-10-21/22)

One review slice, committed together because the files carried several boundaries: typed goal lifecycle; monotonic
layout revision and stale-plan rejection; derived-index invariants; pure `PlanDelta` with physical, logical, claim and
completed-mine evidence; typed spatial claims with paired, ownership-checked writers; persisted adoption phases and
resume; typed world claims; branded `GoalId`/`ModuleId`/`RouteId`/`ConnectionId`/`PoleLineId`/`PoleId`/`JobId`/
`ClaimTag`; stable decision codes; and model-sequence regressions (plan → mutation → replan, adopt → abandon →
reclaim). Docs updated in `docs/agent/architecture.md` and the TSTL gotchas in `CLAUDE.md`. Validation: T1 28–35
files, T2 150–152 tests, typecheck/build clean under the 185-local Lua guard.

The architecture slice did not claim acceptance: `m6-final2` was a partial harness run with seed 3333 a non-pass
(B59), later diagnosed as a relocation/replacement scheduling race (B59) rather than a claim-boundary defect.

### 3.5 M6b.40–M6b.49: provider groups and final acceptance (2026-10-22/24)

- **B59:** a relocation waits until its old footprint is deconstructed; a depleted mine reclaims its patch first
  (`strategy/relocation.ts`).
- **B58:** a splitter tap may not rip the trunk it taps; `commitRoute` still rips same-id routes and their taps.
  The broad tap/span check was reverted because it changed seed 3333's geometry; the local tap protection (`5d55fc2`,
  `8bd2a29`) plus the B28 sealed-replacement regression passed `m6-final6` **5/5**.
- **Provider groups:** `providerShort` keeps an unexpandable provider at its real capacity; residual demand goes to
  stable `parallelRole`s with merge side-loads; `providerSplit` gives each unreachable consumer its own provider;
  `providerNoTap` removes only the exact failed feed (B60/B61). `m6-b60s-provider` took 8646103 to 233.5 and 2229258 to
  185.2 game-min.
- **M6b.46:** per-ore region-radius memory was implemented, measured and **rejected**: it turned 8646103 from a
  233.5-min pass into a 448-min double stall. The radius ladder is part of the layout search; do not reintroduce the
  memory.
- **M6b.47:** verified handover with route adoption (`fuel.ts`, `handover.ts`, `adoptRoute`): a retiring provider waits
  for a built replacement, then retires; `HANDOVER_MAX_MINUTES = 10` is the safety valve. `m6-b60v-handover` 2/2.
  The survivor-route branch was not exercised end to end in a soak; it has T1 coverage and a revised T2 contract.
- **M6b.48:** merge splitter on the trunk (`planner/merge.ts`): side-loads are tried first; the splitter's far output
  lane is left empty so the trunk gets every item. T2 pins >8/s from two 6/s feeds.
- **M6b.49:** the reconciler emits a `parallel` remedy when a shared trunk saturates (previously diagnosed and
  ignored); point-to-point saturated belts deliberately keep no remedy.

### 3.6 After this report (2026-10-25/27)

B62–B66 are in [`docs/BUGS.md`](../BUGS.md) and are not duplicated here:

- **B62:** classify “no free patch / no site” as a knowledge failure; act on the first attempt, keep the goal, pause
  its kind or start D62 exploration, and do not count exploration plan failures against fail-fast.
- **B63:** claim-tag leak (`poles:kept:` ids, idempotent `commitModule`, orphan diagnostics) and power bridges kept
  across demolition.
- **B64:** `debugInfiniteResearch` makes the sustained-science window observable after `research-goal-done`; the
  factory no longer idles while that sink runs.
- **B65:** supply-aware sharing (`planned - Σ edges`, `supplyGaps` telemetry) and the phase-2 `growth-plan.ts`
  (`requiredRates`/`depthOrder`/`planGrowth`) wired as `supplyPass`.
- **B66:** power cascade past `power#2` (`stage.powerCaps`, `extraSteam`) and unrevivable ghosts in a mine completion
  (`extraAdd` dedupe, whole-footprint clear, crew destroys a ghost standing on its own live twin).
- **Validation caveat:** B66's status says fixed with VPS soak validation. The only complete local B66 run
  (`vps-b66-r8646103`) is marked failed for a harness reason (it resumed at game-min 200 against a 3 h cap), and
  `vps-b66-grow`/`vps-grow` were left as stale `running` manifests with no process. Treat B66's soak evidence as
  missing until rerun.

## 4. Magic numbers for the user

Consolidated from every slice. “Setting?” is the current state; values marked *guess* are agent choices awaiting a
user decision. Duplicates were merged at their final value (for example `portEscape` 8 → 32 in B57).

### 4.1 Settings and tunables

| Name | Where | Value | Why / status |
|---|---|---|---|
| `factory-targets` (stage 2) | `settings.ts`, `strategy/stage.ts` | `automation-science-pack=10;automation-science-pack=30,logistic-science-pack=30` | The v1 bar after D37's stage 1. Setting. |
| `factory-design-margin` | `settings.ts`, `strategy/factory.ts` | 1.1 | Design 10% above target to cover belt/inserter losses. Setting (new). |
| `factory-lab-sizing` | `settings.ts`, `strategy/design.ts` | `mean;max` | Stage 1 mean unit time; stage 2 slowest (30 s). Setting (new). |
| `factory-sustain-minutes` | `settings.ts`, `strategy/stage.ts` | 30 | The §3 bar. Setting (new). |
| `module-buffer-slots` | `settings.ts`, `modules/buffers.ts` | 2 (was 1) | D51 (1), user decision. Setting. |
| `factory-shared-providers` | `settings.ts`, `strategy/stage.ts` | 1 (from stage 1; 0 = never) | B19: share once splitters exist. Setting (new). |
| `logistics-share-min-modules` | `settings.ts`, `strategy/factory.ts` | 1 | Research splitters first when sharing saves one module. Guess. Setting (new). |
| `build-stuck-rounds` | `settings.ts`, `strategy/design.ts` | 10 rounds (30 s apart) | Long enough to fetch items, short enough not to hold a stage. Guess. Setting (new). |
| `bootstrap-temp-cell-feed-priority` | `settings.ts`, `strategy/bootstrap.ts` | 40 | Between gather (20) and craft (50); 0 = off. Guess. Setting (new). |
| `preempt-fuel-seconds` | `settings.ts`, `jobs/crew.ts` | 30 | Refuels are queued at 2 min; 30 s lets a member arrive first. 0 = never preempt. Guess. Setting (new). |
| `supply-radius` | `settings.ts`, `strategy/bootstrap.ts` | 384 (tiles from hub; 0 = any) | `scan-radius` × 3, the farthest default site. Guess. Setting (new). |
| `supply-min-take` | `settings.ts`, `jobs/supply.ts` | 5 | Fewer is not worth the walk. Guess. Setting (new). |
| `planner-placement-growth-band` | `settings.ts`, `planner/policy.ts` `placement.growthBand` | 4 per tile | ~8× the 0.5 soft claim. Guess, six replays. Setting (new, P38). |
| `planner-placement-growth-band-units` | same `placement.growthBandUnits` | 2 | The first units a growth usually needs. Setting (new, P38). |
| `planner-placement-growth-blocked` | same `placement.growthBlocked` | 3 per near unit | 8 broke seed 222; 3 passes. Guess. Setting (new, P38). |
| `supply-module-furnaces` | `settings.ts`, `strategy/bootstrap.ts` | false | P39: taking furnace output can starve the belt. Setting (new, P39). |
| `planner-pole-evict-cost` | `settings.ts`, `planner/policy.ts` | 0.5 per pole tile | User: poles give way “for nearly free”; a tree costs 2. Setting (new). |
| `planner-placement-new-field` | `planner/policy.ts` | 50 tiles | User's figure for preferring an existing field. Setting. |
| `factory-radar` | `settings.ts` | on | D56; cosmetic, no plan depends on it. Setting. |
| `planner-work-per-tick` | `settings.ts` | 400/tick for the whole mod (was 100/plan) | User: one plan may take the whole budget. Setting. |
| `planner-router-soft-claim` | `settings.ts`, `planner/policy.ts` `router.softClaim` | 10 per tile in the next growth unit (was 0.5) | User: “10 or so”. Setting. |
| `planner-router-soft-claim-decay` | same `router.softClaimDecay` | 0.5 per unit farther out | Largest decay that kept g20 out of units 1–2. Setting (new). |
| `factory-site-retry-minutes` | `settings.ts` | 5 game-min | D60; user-approved pause after “no site in region”. Setting (new). |
| `factory-power-build-priority` | `jobs/faction.ts`, `strategy/bootstrap.ts` | 150 | D61; above every other job. Setting (new). |
| Handover wait limit | `strategy/fuel.ts` `HANDOVER_MAX_MINUTES` | 10 game-min | Retiring provider waits, then retires anyway. **Guess, please confirm.** Not a setting. |

### 4.2 Internal constants and policy defaults

| Name | Where | Value | Why |
|---|---|---|---|
| `GROW_MAX_FAILS` | `strategy/stage.ts` | 3 | A growth that failed 3× stops holding the stage. Guess. |
| Cluster-1 cap floor | `strategy/factory.ts` | 0.05 | Cluster 1 keeps ≥5% of target when a module cannot grow. Guess. |
| `redLine` / `labArray` expansion caps | `modules/generators.ts` | 10 units | Keeps a line/array within ~120 tiles. Guess. |
| `OUTPOST_FAR_RADIUS` | `planner/placement.ts` | 192 tiles | One extra ring for mining outposts. Guess. |
| `TRAPPED_NO_PATHS` | `jobs/crew.ts` | 3 walk failures | Boxed-in detection; a finished walk resets it. Guess. |
| `UNBOX_RADIUS` / `UNBOX_TREE_RADIUS` | `jobs/crew.ts` | 3 tiles | Own entities / neutral trees it may clear. Guess. |
| `UNBOX_TREES_PER_ESCAPE` | `jobs/crew.ts` | 16 | Enough to open a dense tree ring in ≤2 escapes. Guess. |
| `UNBOX_RETRY_TICKS` | `jobs/crew.ts` | 600 (10 game-s) | Wait before retrying an escape that found nothing. Guess. |
| Free slots to preempt | `jobs/crew.ts` | 1 | One slot covers a refuel; a full pocket would deposit first. |
| `PAIR_KEEP` | `strategy/bootstrap.ts` | 10 | Coal a pair drill keeps for its partner (existing M3 value). |
| `ROW_BUFFER_W` | `modules/generators.ts` | 2 columns | Buffer head width, layout-derived. |
| `SCIENCE_SAMPLE_TICKS` / `SCIENCE_MAX_SAMPLES` | `strategy/stage.ts` | 3600 (1 min) / 600 (10 h) | Sustained-window sampling; bounds storage. |
| `automated:<pack>` threshold | `strategy/stage.ts` | 10 packs consumed | Pack counts as automated. Guess. |
| Window margin + growth length | `planner/placement.ts` | footprint + corridor + 4 + growth length + `corridor.min` | Derived: the band must fit the scoring window. |
| Point-to-point mine: lanes / drills | `planner/placement.ts` `prepareWholePatchPlacement` (`maxLanes`) | 1 lane; template rows + cap × drills/unit (14 for electric 2-row) | Two lanes made the second coal outpost unplaceable (P40b); drills are the strip cap. |
| Shared mine: drills | `planner/mine-plan.ts` `beltDrillCap` | 2 lanes × lane speed ÷ drill rate (30 electric on iron, yellow) | Game data; one collector/one belt. |
| Overlay caps | `review/growth-overlay.ts` | 80 modules; 3,000 ore edges; patch margin 8 | Keeps a redraw cheap. Guess. |
| Patch join distance | `planner/placement.ts` `PATCH_JOIN` | 2 tiles (Chebyshev) | Same join as `world/resources.ts` `JOIN`. |
| Radar goal failures | `strategy/factory.ts` `RADAR_MAX_FAILED` | 2 | Cosmetic (D56); give up after two plans. Guess. |
| Two-level routing | `planner/policy.ts` `router.longRoute` / `router.coarseCell` / `router.corridorCells` / `router.corridorWeight`, `planner/router.ts` `cellCost`/`stepCoarse` | 128 tiles threshold; 8-tile cells; 1-cell corridor (2 at ends); weight 1.5 | 64 broke B7 bundling; 1.5 cut maze expansions ~13×. |
| Sparse-cell penalty | `planner/router.ts` `cellCost` | below 50% passable, up to ×4 | Steers the corridor away from blocked cells. Guess. |
| Coarse work per cell | `planner/router.ts` `stepCoarse` | C²/8, charged once | A tile read ≈ 1/8 of an expansion. Guess. |
| Lane escape (`portEscape`, `LANE_ESCAPE`) | `planner/policy.ts` `placement.portEscape`, `strategy/fuel.ts` `LANE_ESCAPE` | 32 steps (was 8) | Longer than both observed pockets (21 and ~15 tiles). Guess. |
| B51 relocation depth | `strategy/fuel.ts` `relocate` | 1 level | One depletion cannot rip a whole cluster. |
| Lane underground hop | `planner/placement.ts` `LANE_HOP` | 5 tiles | Game data (underground length). |
| Exploration step / cap | `strategy/bootstrap.ts` `EXPLORE_STEP`/`EXPLORE_MAX`, `strategy/arms.ts` `HOME_SCANS` | 64 tiles; 3 × `scan-radius` = 384 | M3 value; D62 keeps 384 as the home zone. User accepted. |
| First radar outpost / spacing / strip / wait | `strategy/arms.ts` `ARM_FIRST`/`ARM_SPACING`/`ARM_STRIP_HALF`/`ARM_SCAN_WAIT` | 400 tiles; 200 tiles; 32 half-width; 5 game-min | Just past the home zone; nearby squares touch; one chunk either side; charting cap. Guesses accepted. |
| Dry-boiler floor | `strategy/reconcile.ts` `classify` | `minActive` (10%) | Reuses the existing noise floor. |
| Seal check cap (first / retry) | `planner/policy.ts` `router.sealCheck` / `router.sealRetry` | 2000 states / 0 (no cap) | 2000 pays little on a reachable route; retries prove an enclosed end. |
| Ring search work per point | `planner/placement.ts` site phase (`satRow` rate) | 0.5 work units | Same rate as a SAT tile (~7 µs in game). |
| Diagnostic observability | `diagnostic-events.ts`, `crew-diagnostics.ts`, `tools/harness/soak.py` | 512 events/category; churn ≥32 obs and worse than 10:1; 3 rejected ids/reason; 200 log lines | Retained evidence only; no simulation effect. |
| Harness fail-fast | `tools/harness/m6.toml` | 2 stalls; 8 consecutive plan failures; 20 ghost rounds; deadlines red 1.5 h, stage-2 3 h, green 5 h; exploring 60 min | Stop dead seeds; soak-only. |
| `SHARD_OUTPUT_TIMEOUT_S` | `tools/test-parallel.mjs` | 900 s | Long validations under 8-shard contention. Test tooling. |

Test/GUI-only: `MAX_PREEMPTIONS_PER_HOUR` 10 and `MIN_TAKEN_RATIO` 0.75 (preemption bound); `PRIME_FUEL` 5 coal and
`COLD_START` `smelter iron 12` (validation lab); captured-patch coverage ≥95% (lane-grid bound); `SLUG_CHARS` 32,
report box 420×110 px, toolbar 28 px, report hotkey Ctrl+Shift+R (review GUI).

Reused, not new: `SITE_MIN_LIFE` 2 (D43), `terrain-chunks-per-tick`, `FUEL_LOW_MINUTES` 2 min,
`bootstrap-factory-wait-seconds` 60, `scan-radius` 128, `JOIN` 2 (`world/resources.ts`). `factory-shared-fuel` was
replaced by `factory-shared-providers`; `PAIR_COLLECT_AT` was removed with the collect transfers.

## 5. Open items and questions for the user

1. **Finish M6 acceptance:** fixed 10 + random 20 seed sweeps, two-faction soak, Space Age smoke, determinism
   (same seed twice; save/load/continue), and final timelapses for approval. None of these are claimed here.
2. **B66 validation:** rerun the B66 soak on a fresh start or a save before the cap; the local completed run is
   invalid (resumed at min 200 into a 3 h cap) and the longer runs left no results. B65's `p2-growth` soak is also
   absent from this checkout.
3. **Open bugs:** B29 (no dedicated regression), B40 (graph explorer), B65 (phase 2), B6 (minimum fix only; full
   mixed-ore sorting is D63, deferred beyond v1).
4. **Proposals without formal approval:** P9, P12–P15, P22, P26–P28, P30–P38 and P40. Several are implemented and
   merely await a decision; P37 (no mine-site credit for head growth) is not implemented. The status index is in
   SPEC §11.
5. **D64:** M7 decides whether verified provider handover is needed or should be refactored. The M6 evidence is in
   M6b.47: handover was exercised, but the route-adoption branch was not observed end to end in a soak.
6. **Deviations/assumptions:** the 5-seed runs are one faction; all performance numbers from runs with `-j > 1` are
   inflated and are not acceptance evidence; `out/` evidence is git-ignored and may be absent on another machine.

## 6. Learned rules recorded

The engine/TSTL surprises found in M6 are in `CLAUDE.md` and the boundary rules in `docs/agent/architecture.md`.
The ones that changed code shape:

- A named function passed to `.sort` receives a shifted comparator in TSTL; pass an inline arrow (B48).
- `import type` is erased and cannot create a Lua `require` cycle; only value imports close it (M6b.31).
- A named import of an exported `let` is a load-time copy; import the module and read the field (profiling,
  M6b.27).
- Lua's 200-local main-chunk limit: the build guard is 185; use a namespace import or re-export, not a new local
  (architecture slices).
- The pathfinder, mining selection, ghost revival and player-less radar behaviours discovered in M6 are in the
  *Factorio engine gotchas* ledger with the T2 tests that pin them.

## 7. Evidence and reproduction

- Full journal: [`docs/archive/M6-report-full-2026-11-06.md`](../archive/M6-report-full-2026-11-06.md).
- Bug rows and fix commits: [`docs/BUGS.md`](../BUGS.md).
- Acceptance configs: `tools/harness/m6.toml` (5 seeds), `m6-fixed10.toml`, `m6-random20.toml`,
  `m6-two-factions.toml`, `m6-space-age.toml`, `m6-throughput.toml`.
- Typical checks: `npm run typecheck`, `npm run test:unit`, `npm test -- "<Lua pattern>"`,
  `python3 tools/harness/soak.py -c tools/harness/m6-fixed10.toml`.
- Historical run directories named in the full journal are under `out/soak/`; they are local artifacts and may be
  gone. The committed tests and the archive are the durable evidence.
