# M5: Power and planner

Branch `m5-power-planner` → `m4-modules-routing` (stacked). M5 is split in two halves on the same branch: **M5a, the
planner and power** (this section) and **M5b, measurement, reconciler, in-game overlay and the near-ore smelting policy
option** (to follow). The branch has `origin/m4-modules-routing` merged in (parallel T2 shards and soak seeds, live
review setup).

Status of the M5a part of the M5 acceptance (SPEC §8): from a fresh start, a faction with the default crew reaches
**automated red science feeding labs with research progressing on 5 of 5 fixed seeds** (bar: ≥ 4 of 5), in **25.8–45.8
game-minutes**, with no permanent stall. T1 solver, goal-diff, pole-planner and growth tests pass; the T2 power-up and
planner-driven expansion tests pass; the full T2 suite passes (75/75 after the merges, plus the new engine pin).

## Built

All runtime-free code is covered by T1 (`mod/unit`). New files: `strategy/solver.ts`, `strategy/design.ts`,
`strategy/factory.ts`, `strategy/research-queue.ts`, `planner/logical.ts`, `planner/power.ts`, `planner/grow.ts`,
`character/triggers.ts`, `test/factory.test.ts`, `tools/harness/m5_scorecard.py`, `tools/harness/m5.toml`,
`tools/harness/m5-mall.toml`.

- **Solver (D21)** (`strategy/solver.ts`, pure). A `Solver` interface (`start`, `step` under a budget, resumable state in
  plain tables) with the v1 **recursive ratio solver** behind it. Input: target rates, machines and drills in preference
  order, the resources on the map, items to treat as raw, the fuel, boiler and engine, and the enabled recipes. It orders
  items consumers-first (DFS over the recipe graph; a cycle is reported, since the ratio solver handles DAGs only),
  propagates demand once per item, and gives per-recipe crafts/s and fractional machine counts (category → the first
  machine that can craft it, so Space Age's `pressing`/`electronics` categories work), mining drills per resource, the
  burner fuel, the electric demand and the steam supply (boilers, engines, boiler fuel) as a **fixed point** (electric
  coal drills need power whose boilers burn coal). Locked recipes are planned with and reported with their technology.
  An LP solver can implement the same interface (P3).
- **Factory design and goal diff** (`strategy/design.ts`, pure). From a stage target ("labs consume N packs/s"):
  - **Module selection, generators first (D34):** structural rules over prototypes. A resource item gets a mining outpost,
    a one-ingredient furnace recipe a smelter column, a two-ingredient recipe with a one-ingredient intermediate a red line
    (or a circuit block when the intermediate yields ≥ 2), anything else with ≤ 2 ingredients an assembler row. The lab
    array is the sink, sized for the target at the mean unit time of the research goal's pack technologies.
  - **Sizing:** each module grows its generator parameter in the same quanta `expand` uses until its output covers the
    demand; input port rates scale with the module's load. The solver's consumers-first order drives the walk.
  - **Topology (D22):** point-to-point gives each consumer port its own producer (so each smelter column gets its own coal
    outpost); splitter-tap shares one producer per item.
  - **Power last:** the steam block is sized to every module's full-speed electric demand; then all fuel demands
    (furnaces and boilers) are mined, iterating to a fixed point. The steam block's own coal outpost uses **burner drills**
    until electric drills are enabled (it must run before there is power); production outposts use electric drills when
    their technology is researched or in the research goal.
  - **D24 overflow on every flow:** checked against the usable capacity of its belt (D25). Remedies in the policy's
    order: a faster researched tier for that edge (the connection carries its own belt tier into the plan), otherwise the
    **target is split into n production clusters** (parallel routes need parallel port pairs, i.e. module copies). A module
    that cannot grow big enough splits the target the same way.
  - **Goal diff:** design nodes are matched to the logical graph by **role** (`labs`, `automation-science-pack>labs`,
    `iron-plate>automation-science-pack>labs`, `coal>power`, …). Missing roles become build goals in order power → labs
    → production → mall; built nodes short of their need become **grow** goals (units of `expand`).
- **Logical graph layer (§5.8)** (`planner/logical.ts`, pure, persisted per faction in `storage.factories`). Nodes =
  production units (`module`, `outpost`, `power`, `labs`, `sink` for the mall, `source`) with capacity and planned rates,
  electric demand or supply, lifecycle (planned → building → built), and **slots for M5b**: `status` (`unknown` until
  the reconciler classifies it), `statusReason`, `measured`. Edges = belt flows (one item, D23) and power flows, with
  planned rate, D27 headroom rate, the belt tier, the D24 remedy applied, and **`measuredRate`/`measuredTick` for M5b**.
  Each node is the module instance of the same id in the faction's layout (physical layer); each belt edge lists its
  route ids, each power edge its pole lines. `upstream(graph, node)` walks feeders nearest first (for M5b's root-cause
  trace). Exported with the physical layer (`factoryGraph`, `dump_factory_graph`).
- **Strategy layer** (`strategy/factory.ts`). Takes over each faction at the `first-electricity-materials` milestone
  (`factory-enabled`). Every brain interval:
  1. **Design** for the current stage (`factory-targets`, D27 staged targets: `item=n,...;...`, default
     `automation-science-pack=10` per minute), cached while tech, graph and stage are unchanged.
  2. **Goals:** one goal *plans* at a time, on top of the faction's layout (so the base stays compact and later plans
     see earlier ones); any number *build*. Production waits until power and labs are built and the technologies its
     modules need are researched; the mall waits for production. A plan that fails is retried with a larger region and a
     different cluster centre (hub, then 24 tiles off it in turn).
  3. **Build:** a finished plan's layout becomes the faction's; its new parts become graph nodes and edges and are built
     by the crew through the Job Board (clear jobs, then ghosts and place jobs; burners get a first load of fuel).
     Planned tiles are added to the bootstrap's reservations so its sites and hand-mining keep off them. Ghosts whose
     jobs failed or were dropped get new place jobs every 30 s, with the failure reasons logged; a build is never abandoned.
  4. **Research (§5.5)** (`strategy/research-queue.ts`): technologies that unblock goals first (their prerequisites
     first, cheapest first), then the rest of the D30 set. Packs are **hand-crafted and put into the labs** only for
     technologies that unblock a goal (`automation`, `electric-mining-drill`); the rest of the research goal waits for
     automated packs.
  5. **Upkeep:** burners the crew must fuel (module `upkeep.fuel`: the steam block's burner coal drills).
  6. **Milestones** (in the brain's milestone list, so telemetry and the scorecard see them): `planner-takeover`,
     `<goal>-planned`, `<goal>-built`, `first-power`, `automated-red-science`, `grow-built`, `mall-built`.
  7. **Stalls (§3):** once the bootstrap is done (it detects its own before), no progress (placements, crafts, research
     progress) for `stall-ticks` logs a stall with the active goals and waiting reasons and recovers: crew reset, non-build
     jobs dropped, place jobs re-planned for leftover ghosts.
- **Power:** the steam block on a shore (M4 site constraint) plus the **pole network planner** (`planner/power.ts`,
  pure, budgeted, a phase of the plan job). Modules carry their own poles; the planner joins pole *components*: union-find
  over poles within wire reach, a component is powered when it holds a generator module's pole, and the unpowered
  consumer component nearest the powered set is joined next (Prim) by an A* over pole positions (hops up to the wire
  reach, longest first, on free tiles; trees and rocks at a clearing cost, corridors and ore at a small cost; wires span
  water). A failed search is retried with a wider window (16 → 48 → 112 tiles) before it is reported. Small wooden poles
  only (D20); the crew gathers the wood. Sized from demand: the steam block's boiler count comes from the design and
  grows (expand) when demand rises.
- **Growth of built modules (expand-first)** (`planner/grow.ts`, pure): rip the module's routes, `tryExpand` (with the
  module's own footprint and its ripped route tiles counted as free), reroute, and diff world entities: what the crew
  picks up (moved entities, belts of rerouted routes) and what it builds. Unchanged entities stay.
- **D24 overflow actions:** upgrade-tier → the edge's connection is planned with the faster belt; parallel-route and
  new-producer-cluster → production clusters (`#1`, `#2`, … roles). None triggered at the stage 1 target (all flows are
  well under a yellow belt); T1 covers both remedies.
- **Material supply loop (decided, documented):** the bootstrap brain stays the faction's economy. Its demand loop (H4)
  sees the materials of every active job, the factory's place jobs included, and collects, hand-crafts or hand-mines
  them. Once science is automated, the **curated mall** (`factory-mall`, default `mall-polse`) joins the design as a
  second sink at `factory-mall-utilization` (0.25 of its full-speed plate demand: it only runs while its chests have
  room); its output chests become the **first collect source** of the economy, before hand-crafting. Hand-crafting stays
  the fallback for what the mall doesn't make (labs, poles, offshore pumps…).
- **Plan job extensions** (`planner/plan.ts`, `router.ts`, `layout.ts`, `runtime.ts`, `build-list.ts`): plans on a base
  layout (a copy; existing modules `fixed`, existing routes `Route.fixed` and never ripped), a pole phase, per-connection
  belt tiers, no undergrounds until `logistics` is researched, the faction's terrain reused across plans with the
  bootstrap's reservations overlaid, part-wise builds (only what a plan added), **mining outposts placed after and near
  the module they feed**, and the **tile beyond each belt port reserved** for that port (P15).
- **Engine findings fixed** (details under Findings): emulated `craft-item` triggers for crew hand-crafts; the craft
  stall check on intermediate chains; craft jobs only for what the stock covers.
- **Settings (§5.7):** `factory-enabled`, `factory-targets`, `factory-region-radius` (112), `factory-entities`,
  `factory-research-unit-time` (0 = computed), `factory-hand-feed-labs`, `factory-build-priority` (90), `factory-mall`,
  `factory-mall-utilization`, `soak-done-milestone`.
- **Remote:** `factory_report`, `start_factory`, `dump_factory_graph`. **Telemetry:** a `factory` report per faction
  (goals, node lifecycles, design summary, research, waiting reasons, automation check), research state, a sample of open
  jobs; graphs per frame in `script-output/rival-engineers/graphs/<faction>/`; `done.json` at `soak-done-milestone`.
- **Tools:** `tools/harness/m5_scorecard.py` (M5 pass rule, phase breakdown), `render.py --graph-dir` (per-frame
  graph overlay in timelapses, poles, node lifecycle).

## Acceptance re-run after the economy change (2026-10-15, final commit 18ca1fd)

Commit 4ebf208 (craft chunks sized to the stock) changed the bootstrap economy after the acceptance run below, and a
manager re-run on it scored **3/5** (222 and 3333 failed). Root causes, all fixed with regression tests:

- **Seed 222: production unroutable without undergrounds.** Before `logistics` the router has no undergrounds, so belts
  can't cross; the 7-flow cluster next to the fixed labs rip-up cycled on every attempt and every retried goal (69
  failed plans, AI 2.5 ms/tick of thrash). The economy change only moved the bootstrap's sites. Fix: after a production
  or mall goal fails all attempts without undergrounds, their technology becomes a prerequisite and is researched with
  hand-fed packs (**P16, proposed**). Seed 222 then plans in one attempt with 0 rip-ups (+~3 game-min of research).
  T1 replay of the captured plan: `mod/unit/plan-replay.test.ts`.
- **Seed 3333: a big rock under an outpost.** A 2×2 rock off the tile grid: walks to within the short reach of its
  *centre* found no path (every end node next to it collides), its clear job failed, the build stamped ghosts over it
  and waited for good. Fix: walks to trees/rocks aim at their box plus the margin; leftover-ghost rounds also re-clear
  trees/rocks under the ghosts; rocks partly under a ghost are mined from a corner. T2 test with the same neighbourhood.
- **Seed 77 (extra seed): hand-mining picked up an ore belt.** A mine job planned before the ore route was built ran
  after it; mining acts on whatever is selected, so it picked up two belts and the iron smelters starved. Fix: no
  mining of ore under a built entity (trees over ore are mined first, as by a player; mining restarts after an obstacle
  is cleared). Also found: `stampModule` lost the index of a failed entity (push(nil) in Lua), so stamping failures went
  unreported; now indexed and logged. T2 tests for both mining cases.

| Seed | Pass | Automated red science (game-min) | Bootstrap | Power + labs | Research to unblock | Production build | Automation verified | Stalls |
|---|---|---|---|---|---|---|---|---|
| 11 | ✅ | **27.2** | 7.0 | 3.7 | 3.7 | 10.8 | 2.0 | 0 |
| 222 | ✅ | **29.9** | 6.6 | 4.4 | 10.3 (incl. `logistics`) | 6.6 | 1.9 | 0 |
| 3333 | ✅ | **43.7** | 8.8 | 10.5 | 7.4 | 15.6 | 1.4 | 0 |
| 44444 | ✅ | **32.2** | 7.4 | 9.0 | 4.3 | 9.8 | 1.8 | 0 |
| 555555 | ✅ | **40.7** | 9.4 | 6.2 | 10.7 | 12.5 | 2.0 | 0 |

**5/5** on commit 18ca1fd (`out/soak/m5-final3`, `-j 5`). An earlier round with 5 extra seeds (7, 77, 777, 7777,
77777) passed 9/10 before the seed-77 fix (seed 7777 slow: power + labs 37.9 min); seed 77 passes from its snapshot
after the fix (29.9 min); the extra seeds were not re-run on the final commit. M3 soak on the final commit: **5/5**,
first-electricity materials at 6.6–9.4 game-min. Wall times of these runs are inflated: the laptop ran on battery
(≈1 GHz) for most of the session.

## Test workflow (fast debug loop)

The previous loop was "fix, run a full soak (~17 wall-min for a stuck seed), find the next bug". Now (README →
Development):

1. **Fail fast** (`[run.fail_fast]` in `m5.toml`): a seed stops at its 2nd stall, 8 failed plans in a row or 20 rounds
   of unplaceable leftover ghosts. Seed 222 stopped after 303 s instead of running 1008 s; a 3333-type build stall stops
   after 10 game-min of leftovers instead of 2 game-hours. The soak's own summary now scores the config's
   `soakDoneMilestone` (it scored M3's for M5 runs and said "5/5"); `m5_scorecard.py` prints each failing seed's open
   goals, stall reasons, latest plan-failure kinds and leftover ghosts.
2. **Snapshots** (`--snapshots 5`: a sped-up headless server, since `--benchmark` never saves) and **resume**
   (`--from-save`, with the current build). Fix checks from the last checkpoint: 3333's 16 s (vs ~8 min to reach the
   stall), 222's 2.5 min, 77's 2 min. `--helper-lua` injects debug probes (`tools/harness/probes/status.lua` logs every
   machine's status and contents; a 20 s probe run found 77's starved smelters and the missing belts).
3. **Failed plans as T1 tests**: each failed plan dumps its graph (render over the nearest frame) and its input
   (request, base layout, terrain) as Lua; `plan-replay.test.ts` replays it in plain Lua in ~10 s, with env overrides
   for router experiments. Seed 222's failure reproduced exactly; four router variants were ruled out in a minute.
4. **More seeds per round**: one 10-seed round found the seed-77 bug. Concurrency: at `-j 10` each instance ran at
   ~6.4 ms/tick vs ~2.1 at `-j 5` (each Factorio uses several threads), so `-j 10` had ~30% less throughput than
   `-j 5`; keep `-j 5` (battery caveat above).

## Acceptance (SPEC §8 M5, M5a part)

**T3 soak** (`python3 tools/harness/soak.py -c tools/harness/m5.toml -j 5`, then `m5_scorecard.py`): one faction, default
crew of 2, every setting at its default except telemetry outputs and the milestone that ends the run; 3-hour cap.

| Seed | Pass | Automated red science (game-min) | Bootstrap | Power + labs | Research to unblock | Production build | Automation verified | Stalls (recovered) |
|---|---|---|---|---|---|---|---|---|
| 11 | ✅ | **25.8** | 6.8 | 3.9 | 4.0 | 9.1 | 1.9 | 0 |
| 222 | ✅ | **28.4** | 7.4 | 4.9 | 7.2 | 7.1 | 1.8 | 0 |
| 3333 | ✅ | **45.3** | 13.6 | 8.1 | 7.4 | 15.2 | 1.0 | 0 |
| 44444 | ✅ | **45.8** | 7.5 | 8.9 | 4.3 | 24.1 | 0.9 | 1 (1) |
| 555555 | ✅ | **39.0** | 10.0 | 10.7 | 6.2 | 11.2 | 1.0 | 0 |

**5/5** (bar ≥ 4/5). Phases: bootstrap = start → first-electricity materials (M3); power + labs → labs built and powered;
research to unblock → production planned (`automation` and `electric-mining-drill` researched with hand-fed packs);
production build → the red chain built; automation verified → the `automated-red-science` check (P14) holds. Full
scorecard: [m5/acceptance-scorecard.md](m5/acceptance-scorecard.md).

What gets built (seed 11): steam block (1 boiler) + burner coal outpost; lab array (4 labs); red line (2 red + 1 gear
assemblers); iron and copper smelter columns (4 stone furnaces each); iron and copper outposts (2 electric drills
each); one electric coal outpost per smelter column; pole lines between them. 10 modules, 8 belt flows, 160–225
placements for production.

**The automation check (P14):** when the red producer is built, hand-feeding stops (its open jobs are dropped) and the
packs left in the labs are counted. The milestone needs the labs to complete more research units than those leftovers
(+5) while the red line made ≥ 10 packs. On every seed the leftovers were 0 (labs had used up the hand-fed packs) and
it took 0.9–2.1 game-min after the build.

**Slow parts, honestly:** the production build dominates (7–24 min). The crew of two hand-crafts every building from
burner-smelted plates (≈ 170 entities: belts, inserters, 3 assemblers, 6–8 electric drills, poles from gathered wood)
while also keeping the burner economy running. Seed 44444's 24 min includes one recovered stall: 15 game-min without a
placement, the build at 160 of 160+ entities; the stall recovery (crew reset, non-build jobs dropped and re-derived)
unblocked it and the build finished 20 s later. The root cause is not identified (likely a stuck claim or reservation
in the economy; the next soak's telemetry has an open-job sample to tell). Seeds 3333 and 555555 start slower (bootstrap 10–14 min, power 8–11 min: the
shore is far from the hub and the steam block's coal belt is long).

Planner retries: 5 production plans failed at least once (routes boxed in by each other after 3 rip-ups); each
succeeded on a later attempt with a different cluster centre (2nd–4th attempt). Plan cost per goal (scan + place +
route + poles, at 100 work units/tick): power 212–421 ticks, labs 89–184 ticks, production 713–1946 ticks (74k–200k
work units, 7–43 A* searches).

**T1** (`npm run test:unit`, 8 files, all pass): `solver.test.ts` 7 (30+30/min → 3.75 Fe/s, 1.25 Cu/s, 12 + 4 furnaces,
5/6/1.25/0.75/0.5/0.5 assemblers, 7.5 + 2.5 drills; fuel 0.36 coal/s and the electric fixed point in closed form;
10 red/min; locked recipes; raw overrides; budget-1 stepping ≡ one step; burner drills), `design.test.ts` 8 (module
selection, the 10 red/min design and its plate flows equal to the solver's, power roles, goal diff order and contents,
expand-first growth units, D24 upgrade vs cluster split, module-cap split, splitter-tap), `power.test.ts` 6 (a pole line
over 40 tiles within reach, around a lake and cliffs, none without a generator or when adjacent, budgeted ≡ one-shot,
an unreachable consumer reported), `grow.test.ts` 1 (4 → 8 furnaces, 4 added, the moved end rebuilt, its route
rerouted and valid).

**T2** (`test/factory.test.ts`):
- **Power-up:** a steam block placed on a shore by the planner, a lab array 40 tiles away, the pole network planned
  (a line of small poles), everything stamped as **ghosts and revived the way the crew builds**; the boiler fuelled and
  the labs fed: both labs are on the engine's electric network with energy, and `automation` research progresses.
- **Planner-driven expansion:** a built 4-furnace smelter column fed by an 8-drill outpost smelts **1.24 plates/s**;
  `planGrowth` grows it by one unit (22 entities picked up, 45 built, the ore belt rerouted), built by revive: **2.49
  plates/s** with 8 furnaces.
- Engine pin (`engine-capabilities.test.ts`): a player-less hand-craft of a lab does **not** research
  `automation-science-pack`.
- Full suite after both merges: 75/75 (8 shards), and the new tests.

**CPU:** see the section below.

### Timelapse and renders (graph overlay)

Seed 11, one frame per 2 game-minutes, from takeover to automated red science; module boxes with their graph ids,
belt flows coloured by planned utilization, poles yellow, node lifecycle labels:

![seed 11 timelapse](m5/m5-seed-11-timelapse.gif)

| Seed 11 at 26 min (power node growing after the mall joined the design) | Seed 555555 at 39 min | Seed 11 at 48 min, mall built |
|---|---|---|
| ![](m5/m5-seed-11-final.png) | ![](m5/m5-seed-555555-final.png) | ![](m5/m5-seed-11-mall.png) |

**Mall (beyond the acceptance):** on seed 11 run on (`m5-mall.toml`), the mall goal (the curated mall plus its own
smelters and outposts, 7 modules, 6 flows) was planned at 28.3 min, once `logistics` was researched with automated
packs, while the steam block grew by 3 boilers for it; it was built at 47.6 min (136 placements). The run stopped there,
so its output chests supplying later builds is implemented but not yet exercised in a soak (M5b/M6 runs continue past
it).

## CPU (D13: 2 ms/tick soft target for all AI, 2 factions × 2 crew)

Measured with the mod's AI profiler (brains, factory planner, layout planner, crew and controllers) per game-minute, on
seed 11 run alone (`tools/harness/m5-mall.toml`, `-j 1`, no other Factorio running), one faction with 2 crew, from the
start through automated red science (25.8 min) to the mall built (47.6 min):

| Phase | AI ms/tick, average | Worst game-minute |
|---|---|---|
| Bootstrap (0–6.8 min) | 0.204 | 0.209 |
| Takeover → automated red science (6.8–25.8 min) | 0.353 | 0.741 (the production plan's minute) |
| Automated red science → mall built (25.8–47.6 min) | 0.436 | 0.747 (the mall plan's minute) |
| Whole run | 0.374 | 0.747 |

The peaks are the layout planner at its budget (`planner-work-per-tick` 100 ≈ 1 ms/tick while a plan runs, M4/P7):
production plans take 700–1,950 ticks (12–33 game-s) and the mall plan 2,357 ticks. Between plans the factory layer adds
≈ 0.1–0.2 ms/tick over the bootstrap (the design is cached; the per-think work is goal bookkeeping, hand-feeding and upkeep
scans, and the larger Job Board). For D13's 2 factions × 2 crew: ≈ 0.75 ms/tick on average and ≈ 1.5 ms in a minute
where both plan at once, under the 2 ms soft target. Two factions planning in the same tick could exceed 2 ms in that
tick; a shared planner budget across factions would cap it (not done). The acceptance scorecard's 0.7–1.1 ms/tick
figures come from 5 concurrent games plus another agent's soaks on the same laptop and are inflated (CLAUDE.md).

## Findings

- **Crew hand-crafting does not fire `craft-item` research triggers.** The engine fires them for a player's crafting and
  for machine output (furnace plates complete `steam-power` and `electronics`, M3), but not for a player-less
  character: `automation-science-pack` (craft a lab) never completed and the first soak deadlocked waiting for the red
  science recipe. The controller now emulates the trigger for crew crafts (`character/triggers.ts`, proposal P9); an
  engine test pins the gap.
- **Long hand-crafts looked stalled.** A craft's progress was `gained + crafting_queue_progress`, but the queue progress
  restarts at 0 for every intermediate; a lab (≈ 21 s of circuits, gears and belts) passed the 20 s stall limit and was
  cancelled, leaving its finished intermediates behind. The first soak piled up 3,800 circuits and 3,850 gears that
  way. Progress now also counts finished queue entries.
- **Big craft jobs on a scarce raw item never start.** The bootstrap chunks craft jobs by 60 raw items; for small poles
  that is a job needing 30 wood, claimable only when the depot holds all 30. Trees are scarce in starting areas, so the
  last poles of a build waited for good. Craft jobs are now created only for what the stock covers; the rest stays
  demand, so gathering continues.
- **Placement order matters for outposts.** Outposts were placed first, on the ore nearest the hub; the steam block's
  coal outpost on seed 555555 landed 120 tiles from the steam block and its belt ran along the labs' input side, which
  then could not be routed. Outposts are now placed after the module they feed, on the ore nearest it, and the tile
  beyond every belt port stays reserved for that port (P15).
- **Routing failures are mostly mutual blocking**, not terrain: "blocked by X (ripped 3 times already)". Moving the
  cluster centre on retry was enough on every seed. A smarter remedy (rip-up across goals, re-placing the consumer of
  the failing route first) is future work.
- **Point-to-point coal:** each smelter column gets its own coal outpost (3 coal outposts incl. the steam block's). It
  works on every seed's starting-area coal patch; splitter-tap topology would need one.
- **Growth works in the field:** after automated science the mall joins the design, the electric demand rises and the
  steam block grows in place (+3 boilers on seeds 11 and 222, its coal belt rerouted), and the burner coal outposts
  feeding it grow (+2 rows on 3333 and 44444).
- **Revived small-pole ghosts connect** to poles in wire reach (T2 power-up), so the pole planner only has to keep hops
  within reach.

## Deviations and assumptions

- **Stage 1 target 10 red/min** (`factory-targets`): the M5 bar is "automated red science feeding labs"; the v1 target
  (30 + 30/min) is M6's stage 2. Staged targets and headroom (D27) are in place: stages advance when everything of a
  stage is built; edges record their headroom rate. Space is not reserved for the next stage's growth (expansion grows
  into free space when it can; when it can't, the shortfall is a waiting reason and the D24 cluster remedy applies at
  design time).
- **Hand-fed research before automation** (P10): `automation` and `electric-mining-drill` are researched with
  hand-crafted packs (35 packs) in the planned lab array. Without that, assemblers and electric drills cannot be built.
- **The steam block's coal comes from a burner-drill outpost** (crew refuel it): electric drills need the power it
  makes. Production outposts are electric.
- **Logical nodes include the mall as a `sink`**, power edges run from the (first) power node to each consumer.
- **The bootstrap keeps running** after takeover: its remaining burner sites, upkeep and demand-driven economy continue
  (they are the material supply). Its stall check runs until its goals are done, the factory's afterwards.
- **No undergrounds before `logistics`.** The router plans without them until underground belts can be crafted.
- The acceptance soak ran 5 seeds concurrently (`-j 5`) while another agent's soaks also ran: wall-clock and AI ms/tick
  in that scorecard are inflated; the CPU section uses a `-j 1` run.

## Proposals (also in SPEC §11, all proposed)

P9 crafting triggers emulated for the crew · P10 hand-fed research only for unblocking technologies · P11 stage 1 target
10 red/min and lab sizing · P12 goal order (power → labs → production → mall → growth; one plan at a time) · P13 material
supply (bootstrap economy, then the mall at 25% as the first collect source) · P14 the `automated-red-science` check ·
P15 port approach tiles reserved · P16 undergrounds researched when a production plan is boxed in (re-run, above).

## Interfaces for M5b

- **Where measured rates go:** `storage.factories[faction].graph` (`planner/logical.ts`). Per node: `measured = { tick,
  window, inputs: Rate[], outputs: Rate[] }`, `status` (`NodeStatus`: `ok | starved | backed-up | unpowered |
  unfuelled`, `unknown` until measured) and `statusReason`. Per edge: `measuredRate`, `measuredTick`. Planned values to
  compare against: `node.planned.{inputs,outputs}`, `node.capacity`, `edge.plannedRate` (and `headroomRate`).
- **Finding the entities:** a node's id is its module instance in `f.layout` (`findModule(f.layout, id)`: `rect`,
  `origin`, `def` with world-ready local positions; `def.ports` for port tiles (`portTile`, `portOutside` in
  `planner/layout.ts`)). A belt edge's `physical` lists route ids (`f.layout.routes[id].steps` = the belt tiles, first
  and last for port sampling); power edges list pole line ids (`f.layout.poleLines`).
- **Root cause:** `upstream(graph, nodeId)` (nearest feeders first) and `edgesInto`/`edgesFrom`. `node.lifecycle` tells
  built nodes from ones under construction (only `built` should be classified).
- **Replanning hook:** the strategy acts on the graph each think (`strategy/factory.ts` `think`): a reconciler step
  after `updateGoals` can emit goals; `startGrow`/`startGoal` show how goals are made and `designNow` caches by a key
  (add the reconciler's state to it if it changes the design).
- **Overlay:** `factoryGraph(name)` returns both layers (+ planned poles) for `registerOverlayLayer` (review setup) and
  for `dump_factory_graph`. Node `lifecycle` and edge `overflow` are there for colouring.
- **Policy option (D35, near-ore smelting):** placement order already places outposts after their consumer
  (`placementOrder` in `planner/plan.ts`); a policy flag can invert it for smelters (place the smelter near its outpost)
  through `ModuleRequest`/`PlacementRequest.center`.
- **Scorecard:** `tools/harness/m5_scorecard.py` reads telemetry `factory` reports; add measured utilization there.

## Questions for the user (non-blocking)

1. Is **10 red/min** a fine stage-1 target for "automated red science" (M6 adds 30 + 30)? Larger targets mostly add crew
   build time at this stage.
2. P10: is hand-crafting the ~35 packs that unblock assemblers and electric drills acceptable as "player-like", or should
   the faction build an early burner-fed hand-assembly line instead? (Players do hand-craft the first packs.)
