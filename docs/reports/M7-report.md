# M7 report

M7 is blue science (SPEC §8, decisions D72–D79, phases P45). Each faction sustains ≥ 30 red + 30 green + 30 blue
science/min over 30 game-minutes within 16 game-hours and researches the D74 set, on ≥ 18/20 random seeds, ≥ 9/10 fixed
seeds and two factions. Phases: M7a refactor and hardening; M7b fluids; M7c a first blue line; M7d advanced oil,
robots and the full mall; M7e scale to 30 + 30 + 30 and acceptance.

## M7a: refactor and hardening

Scope (P45): remove verified handover (D76); the D69 refactors from the 2026-10-29 audit (a typed planner failure and
one constraint store, node fields instead of role-string parsing, one reconciler handler per remedy kind); split
`strategy/factory.ts`; D71 (a) and (b); check and close B29 and B65; triage SPEC §11. Gate before blue work: random20
≥ 18/20 on the refactored code.

### M7a.1: verified handover removed (D76)

The user approved removing verified provider handover in-session (2026-10-30). M6b.47's evidence: no route was ever
adopted in a soak, one handover completed at once because another built provider already fed the port, and one
stalled at the 10-minute valve and fell back to deconstruct-then-plan.

What replaced it (the provider-group rule, "build a parallel provider, then retire the old one"):

- `strategy/retire.ts` (pure, T1 `retire`): a retiring provider records which built providers already fed its consumer
  ports when it began. It is deconstructed once its drills run dry, or once every consumer port it feeds is also fed
  by a built provider that was not feeding that port then (its replacement). There is no time limit: a burner outpost
  (D54) whose replacement can never be built keeps producing instead of being torn down after 10 minutes.
  The replacement is judged by the ports, not by the provider family. A first draft retired a provider once any new
  member of its family (`role`, `role~N`) was built; fixed seed 222 (`m6-fixed10-845a46b`) shows why that is wrong:
  `iron-ore>…labs~2` (n25) fed the parallel smelter n29 while the family's new first mine (n49) fed n15, so the family
  rule would have torn n25 down and starved n29 (T1 `retire` pins the case).
- `strategy/fuel.ts` `beginRetire` / `serviceRetiring` replace `beginHandover` / `serviceHandovers`, checked once a
  game-minute like the ore. The entry points are unchanged: P36 (a) fuel running low, D67 mine lead time, D54
  burner outposts, D55 worked-out mines.
- The design still plans the replacement under a parallel role whose edge merges into the belt the retiring provider
  feeds (`DesignContext.retiring`, was `handover`), so both feed the consumer until the old one goes.
- Removed: `strategy/handover.ts`, `planner/adoption.ts` (`planAdoption`), `planner/layout.ts` `adoptRoute`,
  `abandonParts(..., adopt)`, the `HANDOVER_MAX_MINUTES` valve, T1 `handover`, `handover-route`, `adoption`.
  When the old provider goes, its routes go with it, and the replacement's merge onto that belt is routed again by the
  reconciler, as in every M6 soak (none adopted a route).

Tests: T1 (new `retire`, 5 tests); T2 `reconciler` P36 (a) and D67 rewritten for D76 (kept while the replacement is only
planned, retired once it is built and feeds the port; a mine with ore is kept with no time limit). Full T2 162/162 on the M7a
code (with the D71 (b) test).

### M7a.2: the D69 refactor (constraint store, typed failures, node facts, remedy handlers, first factory split)

The three refactors the user deferred to M7 (D69, from the 2026-10-29 audit), each kept behaviour-identical except
where noted:

1. **Typed planner failures and one constraint store.**
   - `shared/plan-failure.ts`: a failure has a `kind` (`no-patch`, `no-position`, `no-site`, `no-merge-target`,
     `other`) next to its text. The placer sets it where it gives up (`PlacementSearch.failure`); `routeRequest`
     returns a typed failure; `PlanJob.failed` holds them (all writes go through one `fail()` helper).
   - `strategy/constraints.ts`: one store (`FactoryState.constraints`) replaces ten flag maps on the factory state
     (`noTap`, `providerShort`, `providerSplit`, `ownSite`, `growFails`, `cluster1Caps`, `providerNoTap`, `noMerge`,
     `wideJoin`, `fallback`). Each kind has a scope (provider, feed, port, item); `dropRole` drops a provider's
     entries when it leaves the graph (was six hand-written deletes in `relocate`); the design cache key is built from
     it. Saves made before it are migrated on the first think (`adoptLegacy`).
   - `strategy/failure-rules.ts`: the six detectors of `updatePlanning`'s failure branch are one pure rule,
     `learnFromFailure`, over typed failures. "no merge target" and "no site in the region" are read from the kind,
     not the text; `EX.exhausted` takes the typed failures.
   - Behaviour changes: (a) a module that is not a mine and found no position is no longer read as an exhausted
     "patch" of its product (the old text pattern took `(iron-plate>labs): no feasible position` as a patch failure of
     `iron-plate` and started exploring for it); (b) dropping a role also drops its `ownSite` flag.
   - `stage.ts`: the tap eligibility test (`noTap || providerShort || retiring`), written twice, is one `tappable()`.
2. **Node facts instead of role strings.** `strategy/node-facts.ts`: the design stamps each node with `family`,
   `serves` (`power`/`mall`) and `homeCluster` when it mints the role; goal and graph nodes keep them. Goal grouping,
   growth power checks, the cluster-1 cap guard (was `!isPowerRole && no "#" && !isParallelRole`) and the retire family
   read the fields. Only `node-facts.ts` parses roles, for nodes from older saves and inside the design walk.
3. **One handler per remedy kind.** `applyRemedy` (≈270 lines, branching on the kind and on the key prefix
   `deplete:` four times) is a table `REMEDIES` with one handler per kind. A worked-out outpost is its own remedy kind
   (`deplete`) instead of a `grow` remedy recognised by its key; `grow` and `deplete` share `growNode`.

Also the first slice of the `factory.ts` split: research and hand-fed labs moved to `strategy/lab-feed.ts`.
`factory.lua` had reached 189 main-chunk locals with the new imports (build guard 185, Lua limit 200); it is at 178.

Tests: T1 42/42 files (new `constraints`, `failure-rules`, `node-facts`; `failed-mine` rewritten for typed failures;
`exhausted` folded into it). The new pure modules are in the architecture check's pure list.

### M7a.3: make before break for evicted poles (D71 b)

Two-faction seed 222 (M6): production goal g19 evicted 22 poles (B37) at 99 min; they were picked up in the build's
clear phase while their replacement line went up with the rest of a 153-entity build, and most of the factory was
dark until ~130 min. The user deferred the proposed remedy to M7 (D71 (b), 2026-10-30).

- `planner/runtime.ts`: a build that evicts poles (`startBuild(..., { breakAfter })`) starts in a new `poles` phase.
  `placeReplacementPoles` ghosts the plan's pole-line poles whose tiles nothing still has to be cleared from, with place
  jobs; once those are done the evicted poles get their clear jobs and the build goes on as before (`clear`, `place`).
  A pole standing where an obstacle or old entity goes first waits for the normal stamp; `stampParts` skips a pole whose
  ghost is already there.
- Growth builds (`startGrow`) do the same with `growBuild.phase = "poles"`: the old poles among `plan.remove` wait until
  the electric poles among `plan.add` stand. This covers B37 evictions by growths and a module's own poles that a growth
  moves (B67).
- Without an eviction nothing changes (no `poles` phase).

Test: T2 `factory` "D71 (b)": a build evicting a pole starts in `poles`, ghosts only the new pole on open ground, keeps
the old pole until the new one is placed, then queues its clear job; a build without an eviction starts in `clear`.

### M7a.4: fixed seed 222 on the M7a code (D71 a, B110, B111)

`m7a-fixed222-1e01f8b` failed at the cap (0/1). The B110 path changed (D76): n25 retired only when its drills ran dry
(no valve). A new livelock (B111): after the power plant's coal mine retired (P36), the coal goal g31 stayed `building`
for 140 game-min because urgent boiler refuels, caused by that very shortage, preempted its last placements; meanwhile
every production goal waited for power. Fixes: unreachable standing spots are avoided for a while, and builds that
restore the power supply run at the refuels' priority. Resumed from `min-0340`, g31 is built (at ~427 min) and
production follows, but seed 222 still falls short: science peaks at ~26.7/min around 230 min and sags to 12–23/min
as its mines deplete and are rebuilt. D71 (a) stays open; the random20 gate is unaffected (12/12 so far).

### M7a.5: the gate sweep (P45)

`m7a-random20-1e01f8b` (the M7a code, `m6-random20.toml`, 3 at a time): **19/20 v1-done, no stalls** (gate ≥ 18/20:
**passed**). Done times 173–291 game-min (M6's final sweep: 175–258). The failure, 2034469 (it passed in M6 at
175 min), made ~25 red + 25 green/min from ~125 min, finished the research goal at 209 min and then consumed exactly
18/min to the cap: the throughput-test sink's 60-s units made labs sized for shorter units the bottleneck (B112, a
harness artefact; fixed in `7d0549e`). Resumed from `min-0200` on the fix, 2034469 reaches `v1-done` at ~212 min, so
the gate stands at 20/20 with B112. Full T2 on the M7 code (`7d0549e` + docs): 170/170.

### M7a.6: SPEC §11 triage (P45; for the user to decide, nothing here is approved)

Every §11 entry still marked "proposed", with what the code does now. "Implemented" means the proposal is in the code
as written (built in M5/M6 while marked proposed); the user's approval would make it a decision.

| Entry | Status in the code | Recommendation |
|---|---|---|
| P9 crafting triggers for the crew | implemented (`character/triggers.ts`) | approve |
| P12 build order of goals | implemented (`goal-selection.ts`: power, labs, production, mall, growth) | approve |
| P13 material supply | implemented (the bootstrap economy supplies every build) | approve |
| P14 M5 acceptance milestone | obsolete (M5 closed; v1-done replaced it) | close |
| P15 port approach tiles | implemented (`layout.ts` `portApproach`) | approve |
| P22 edge flow probes | implemented (`measure.ts` edge probes, item `unique_id`s) | approve |
| P26 temporary factories | implemented (D38 chest cells) | approve |
| P27 opportunistic crafting | implemented (`crew-background-crafts`) | approve |
| P28 soft claims and partners | implemented (`partnersOf`, `softExempt`) | approve |
| P30 the 30 + 30 stage | implemented (`factory-targets` default) | approve |
| P31 how "sustained" is measured | implemented (packs consumed by the labs, force statistics) | approve |
| P32 shared providers | implemented (B19, `factory-shared-providers`) | approve |
| P33 when a module can't grow | implemented (`growFails`, B60 provider groups) | approve |
| P34 stuck builds, boxed-in crews | implemented (B20 leftover rounds, B22 unboxing) | approve |
| P35 bootstrap eviction | implemented (`evict.ts`, B15) | approve |
| P36 coal running out | (a) implemented, now through D76 retirement; (b) superseded by D68 | approve (a), close (b) |
| P37 no mine-site credit for head growth | not implemented (needs replays) | keep open |
| P38 growth bands at placement | implemented (B26 policy weights, settings) | approve |
| P40 the part of a patch a mine claims | implemented (D52 claims, B33) | approve |
| P44 avoid side-loading (implementation) | implemented (`4bf6b94`: splitter merges first, side-loads capped) | approve |

## M7b: fluids

### M7b.1: how far crude can be piped (engine finding)

D73 pipes crude home from an oil field outside the starting area. T2 engine-capabilities "M7b finding" pushes water
(fluid flow does not depend on the fluid) from an offshore pump through pipe-to-ground pipelines into a storage tank
emptied every tick:

| Length (tiles) | No pump | Pump every 220 tiles |
|---|---|---|
| 22 | 1172/s | — |
| 110 | 1103/s | — |
| 308 | 974/s | 1136/s |
| 330 | **0/s** | 1119/s |
| 1100 | **0/s** | 1042/s |
| 2200 | **0/s** | 1035/s |

A 2.0 fluid segment longer than `default_pipeline_extent` (utility constant, 320 tiles) carries nothing at all; a pump
starts a new segment. The crude line therefore needs a pump at least every 320 tiles of segment (game data, read from
`prototypes.utility_constants` at runtime, not a tuning number). Throughput is not the limit: the blue chain needs about
42 crude/s, a pumped line carries over 1000/s.

### M7b.2: plan for fluids (agent design, not a user decision)

Fluid connections are kept point to point, so the planner needs no general fluid network:

- **Fluid plumbing stays inside modules.** A generated oil-processing module holds the refineries and chemical plants
  (plastic, sulfur; later cracking, lubricant, sulfuric acid) with every pipe between them, and its products leave on
  belt ports like any other module. Pumpjack fields are a mining module with one `pipe-out` port.
- **Only two kinds of fluid route cross the map:** crude (pumpjack field → oil module, long, D73) and water (offshore
  pump → oil module). `pipe-in`/`pipe-out` ports (already in `PortKind`) mark their ends.
- **Pipe router** (`planner/pipe-router.ts`, pure, T1): A* over (tile, heading) with two moves, a plain pipe or a
  pipe-to-ground pair (2 to `max_underground_distance` + 1 apart). Underground ends connect only along their axis, so
  the route prefers them; a plain pipe joins every fluid box next to it, so it may not stand next to another route's
  pipe or another port (two fluids must never touch). Pumps start a new segment at least every pipeline extent
  (`default_pipeline_extent`, M7b.1) and are powered by the pole planner like a module.
- Pumpjacks need power at the field, so the field's pole line runs along the crude route.

### M7b.3: fluid routes in the layout, plan and build

- `Route.fluid` (fluid name and its pipe, pipe-to-ground and pump entities) and step kinds `pipe`, `pipe-ug-in`,
  `pipe-ug-out`, `pump`. `ConnectionRequest.fluid` carries the entities and limits (`max_underground_distance`, the
  pipeline extent) the caller reads from the prototypes, so the planner stays pure.
- `plan.ts` `pipeStep`: a fluid connection is routed by `routePipe` in one search (bounded by `PIPE_BUDGET`) with the
  belt router's tile costs and claims; "other fluids" are other fluid routes' tiles and every other module's pipe port.
  Pipe-to-ground spans get their own underground lines (`p…`): they never connect to belt undergrounds.
- `pipe-in`/`pipe-out` ports mean what belt ports mean (`pos` on the footprint edge, `dir` the flow); `portOutsideTile`
  treats `pipe-in` like `belt-in`.
- `build-list.ts` turns fluid steps into entities (a pipe-to-ground faces its above-ground side; a pump faces the
  flow and sits between its two tiles); `checkLayout` checks a fluid route's chain and its arrival into the port.

Tests: T1 `fluid-route` (a 55-tile crude line of pipe-to-ground pairs passes the layout check; a water line never puts
a plain pipe beside another module's crude port), T1 44/44 files.

### M7b.4: fluid facts, fluid-aware rates, the fluid-chain module

- Recipe facts keep fluids (flagged, with their `fluidbox_index`); v1 dropped them (no red/green recipe uses one).
  Entity facts carry fluid boxes (north-facing connection tiles, from `fluidbox_prototypes`) and the pipe-to-ground
  reach. T1 vanilla facts gained the refinery, chemical plant, pipe-to-ground, pump and the basic oil, plastic and
  sulfur recipes.
- `rates.ts`: inserters carry only items; a machine whose products are all fluids needs no output inserter; fluid
  rates have kind `fluid`. The internal balance already handles an intermediate made and used inside a module.
- Generator `fluid-chain` (`recipe`, `chemPlants`, `refineries`): refineries facing north under chemical plants facing
  south, the intermediate on a manifold between them. Only one riser touches each used fluid box, so the boxes a recipe
  leaves unused (a refinery's water input on basic processing, heavy and light oil) touch nothing; a second fluid
  (sulfur's water) rises to the plant's other box on a pipe-to-ground pair from its own manifold at the bottom. Fluid
  box tiles come from the facts, not from constants. One long-handed inserter takes the product out (1.2 items/s per
  plant: the design sizes the plant count).
- Validation lab: `pipe-in` ports are fed from an infinity pipe (only outputs are judged).

| Module | Declared | Measured in the validation lab |
|---|---|---|
| `fluid-chain plastic 2/2` (2 refineries, 2 plants) | 1.8 plastic/s, 40 crude/s, 0.9 coal/s | 1.80/s (100%), steady after 3.5 min |
| `fluid-chain sulfur 1/1` (1 refinery, 1 plant) | 0.6 sulfur/s, 20 crude/s, 9 water/s | 0.60/s (100%), steady after 3.5 min |

- Generator `water-pump`: an offshore pump on a shore (`site = shore`, like the steam block) and its output pipe as the
  `pipe-out` port; `rates.ts` puts a water-port pump's 1200/s out (pumps feeding boilers stay the steam block's).

- Generator `pumpjack-field` (`wells`: tile and crude/s of each, encoded in the params so the module regenerates): a
  pumpjack facing north on every well, plain pipes (one fluid: they may touch anything) joining every output to one
  `pipe-out` port on the east edge (BFS to the growing collector), poles by `placePoles`. A drill entity may carry
  `perSecond` (a pumpjack's yield), which the rate engine uses instead of its mining speed. In-game: three wells at
  100% (10/s each) deliver **29.98 of 30 crude/s** at the port (T2 engine-capabilities "M7b: a generated pumpjack field").

Tests: T1 `fluid-chain` (rates; no overlaps; unused boxes touch no pipe; water apart from petroleum; the water pump; the
pumpjack field's network, power and rates),
T2 validation `fluid-chain plastic 2/2` and `sulfur 1/1`. The water pump is checked in-game with its first real route.

### M7b.5: modules placed on one spot (`ModuleRequest.at`)

A pumpjack field is generated for one field (its wells and their yields, read by the runtime), so the planner must put
it exactly there. `ModuleRequest.at` places the module at that origin through `placement.ts` `placeFixed` (every
footprint tile placeable, trees and rocks only where the policy clears them, no claim) without a site search, or fails
the plan with a `no-position` failure; a fixed module is never moved by a re-placement. A module anchored to a resource
may stand on that resource (`protectOre` skips it). T1 `fluid-route`: a field fixed on three wells pipes crude to a
plastic block the planner places, and the layout check passes.

Open for M7c: the field keeps `anchor.resource`, so the D67/P36 ore checks (`fuel.ts`) would read it as an ore mine;
crude wells do not run dry the way ore does (their yield falls to a floor), so those checks must skip fluid fields.

### M7b.6: pumps get power

A pump on a long fluid route needs power. `pipeStep` puts a pole on a free tile beside each pump, as the route's own
pole line (`pumpPoleLine`, `from: "pump"`); `powerRoles` lists those lines as consumers, so the pole step joins them
to the network like a module; `ripRoute` takes them away with the route. T1 `fluid-route`: a 228-tile crude line with
extent 100 gets its pumps, a pole beside each, and nothing is left unpowered after the pole step.

## M7c: the blue chain

### M7c.1: three-ingredient assembler rows

Engines (steel, gear, pipe), advanced circuits (green circuit, plastic, cable) and blue packs (engine, advanced
circuit, sulfur) take three ingredients; `assembler-row` took two. A third ingredient (the one used most per craft) now
rides a belt of its own one row further south, fed by a long-handed inserter beside each machine's input inserter; it
enters from below at the tail and curves west, so it touches neither the two-lane belt nor that belt's merge column.
One- and two-ingredient rows are unchanged. T1 facts gained assembler 2, steel, engines, advanced circuits and blue packs.

| Module | Declared | Validation lab |
|---|---|---|
| `assembler-row engine 2` (assembler 2) | 0.15 engines/s | 0.153/s (102%; 10-s crafts are lumpy: never "steady") |
| `assembler-row advanced-circuit 2` (assembler 2) | 0.25/s | 0.244/s (98%) |

### M7c.2: the M7 research goal (D74, P47)

The goal stays computed from prototypes (D30). New setting `research-skip-combat` (default off, so v1 runs keep their
42): a technology is combat-only when every effect is a combat modifier (ammo damage, gun speed, turret attack,
artillery range) or unlocks recipes whose every product is a combat item (a gun, ammo, a capsule, something that
places a turret, wall, gate or land mine, or a science pack outside the goal made only of those: military science).
Combat-only technologies leave the goal unless a kept one needs them as a prerequisite (`military` stays for heavy
armour). With packs red + green + blue and the `uranium-ore` trigger excluded, vanilla 2.0.77 gives **89 of 98**:
gate, gun-turret, military-science-pack, physical-projectile-damage-1/2, stone-wall, stronger-explosives-1,
weapon-shooting-speed-1/2 are dropped; production and utility science stay (D74: every blue technology). T2
`research` pins the count. M7 harness configs set `research-science-packs`, `research-excluded-triggers` and
`research-skip-combat`.

### M7c.3: the design knows the blue chain

- `ProtoFacts.isFluid`. Generator rules: a fluid resource (crude oil) → `pumpjack-field`; the offshore-pumped fluid
  (water) → `water-pump`; other fluids are made and used inside a module (no producer); a recipe with a fluid
  ingredient whose fluid a refinery recipe makes → `fluid-chain`; an assembler row takes up to `rowInputs` ingredients
  on the first assembler whose crafting categories include the recipe's (`assemblers`; engines need assembler 2).
- Sizes: fluid chains by plant count, then refineries; pumpjack fields on nominal wells at 100% (10/s, game data; the
  runtime generates the module from a real field when it plans it); one water pump.
- Pipe ports are demands and outputs like belt ports (`inputPorts`, `outPort`). A module may ask for items the recipe
  walk never reaches (a fluid chain's crude and water: petroleum has no recipe of its own): they are expanded after
  the ordered walk.
- Lab arrays take a third pack on a top belt fed by regular inserters (no long-handed ones: the first lab array is
  built before `automation`, and long-handed inserters deadlocked the first M7 soak, `m7x-11`, at 50 min). Both its
  east-side inputs enter on the edge, one column wider. Validation lab: `lab-array 4 blue` 98.8% on a three-pack
  technology; the two-pack array is unchanged (100%).
- The D67/P36 ore checks skip fluid wells (their yield falls to a floor; they do not run dry).
- `rowInputs` stays 2 by default (v1 unchanged); M7 configs set 3. A curated module keeps its item even at 3:
  whether a generator chain can make an item is judged with two-ingredient rows (`chainProducible`), so v1's
  validated green line stays and three-ingredient rows serve only items no curated module covers (engines, advanced
  circuits, blue packs). The first M7 soak with 3 (`m7x-11`) had replaced the green line with a generated inserter row
  whose circuit route could not be placed (8 plan failures). Whether the green line should ever move to a generated
  row stays open for the user (proposed: no, while the curated line is validated).

T1 `design`: 10 blue/min gives plastic and sulfur fluid chains, a pumpjack field, a water pump and assembler-2 engine
rows with no errors; at the default 2 inserters still have no generator.

### M7c.4: goals behind a trigger technology

First M7 soak (`m7x-11`), stage 3: after 150 game-min no blue goal had started. The blue cluster's production goal held
the pumpjack field and the refineries and chemical plants together; those need `oil-processing`, a trigger technology
(it completes when crude is first mined), and `plastics`/`advanced-circuit` sit behind it: the goal waited for a research
no lab can do, and the pumpjack field that would fire the trigger was in the same waiting goal. `goalsFrom` now puts a
production or mall node needing an unresearched trigger technology (or one behind such a trigger) in a later goal of its
kind (`production#c~trigger`): the rest, the pumpjack field included, is built first, and an edge into the later part
belongs to it. Labs and power goals never waited for technologies and are not split (v1 order unchanged). T1 `design`.

### M7c.5: finding crude (B114, B115)

Resumed soak `m7r-11-m450`: the first blue goal planned no pumpjack field (B114), because the design only knew the
bootstrap's ore patches. Fluid resources are now always in the design context. Then the field goal explored through
five radar outposts without finding crude (B115). The field is chosen from real wells before the plan starts
(`OIL.fieldModule`). That search read only the home zone and only chunks already generated. It now counts as a mine for
the plan region and reads every known chunk (home, explored strips, radar-scanned or charted). Known chunks that were
never generated are generated on the spot (blocking, once per chunk).

Ground truth from a probe on the minute-450 save: with every chunk within 768 tiles of the faction generated, seed 11
has no crude there. The nearest wells are 7 at about (−364, 31), ~830 tiles west of the hub. The west arm reaches them
with its third outpost, the 12th outpost in arm order. The second east outpost (E2) then stalled for 45 game-min
(B116): its 28 small poles needed 14 wood, the two members held 13 and 10, and the depot was full with no spot for
another within 24 tiles of the hub. The bootstrap pools pockets when there is a depot, so it saw enough wood, while
neither member could claim the craft alone.

With B116 fixed (`m7r-11-m450c`) the outposts keep coming, but slowly: 8 in 120 game-min, against the 12 seed 11 needs.
Much of that was the crew walking home to empty its pockets between pole jobs (B117). One outpost (S2) failed: "no pole
path" within the plan window, and exploring moved on to the next arm.

After B117 (`m7r-11-m450d`) outposts take 4–5 game-min each: the 12th (W3) was built about 50 game-min after the
search began. It found the crude. Building the field then crashed the game on a well listed twice (B118). S2 and S3
again found no pole path.

With B118 fixed the field was generated and planned, and every plan then failed at its fixed spot: the wells sit in a
ring of cliffs (B119). A field is now generated around the cliffs and water in its box, and its fixed placement checks
terrain only under its entities.

### M7c.6: fluid exits and a shared crude line (B120)

The `m7r-11-m510` seed 11 run built the oil field and completed `oil-processing`, but made no blue packs. The next
production goal failed crude to plastic, crude to sulfur, and water to sulfur with `no pipe path`. The captured plan
only scanned the home region, while the oil field stands ~800 tiles west; the first crude exit was UNKNOWN in that
replay. In the live planner both the crude and water exits read OWN despite no layout occupancy. A save probe at
minute 640 found both physically free for a pipe. Fluid plans now include their built sources in the scan region and
rescan their exit chunks; a source exit and its immediate neighbours are treated as free only when the live surface
accepts a pipe on each tile. The second
consumer of one field port taps a plain pipe of the first route, with layout validation of the tap. The pipe router
now uses weighted A* for long lines: the base distance estimate includes underground-pair cost, then a weight of 4
favours progress toward the destination (a synthetic 800-tile line: 40,881 → 157 expansions).

T1 `fluid-route` covers the verified exit and the two crude consumers; `pipe-router` covers a tap and an 800-tile line.
The captured minute-646 blue production plan (`m7-seed11-blue-wide`) now has no fluid-route failures in T1; only the
blue-pack belt into the boxed old lab fails. A minute-640 snapshot resume reached the same separation on the live
map (goals g56 and g57). Blue packs and sustained science remain unconfirmed; the lab input is the next blocker.

The committed B120 build was resumed again from minute 640 (`m7-b120-r640h`). g56 and g57 failed only at that lab
input, then B57 relocated lab n2 (121 entities to deconstruct, two routes dropped). The replacement production plan
g58 continued without a lab connection but was expensive: at minute 648, the live planner had exhausted 200,000
expansions on a crude-to-plastic route, then recorded several belt routes with 79,000–106,000 expansions. The run was
stopped during g58 planning after about eight wall minutes, so this is a performance and routing diagnostic, not an
outcome for g58. A T1 approximation made from the g57 fixture by removing n2 and its two feeds reached the power
phase after 3.47 million work units, then failed to connect five existing modules to power. That fixture is not an
exact capture of g58; the live run must establish whether power is also blocked there.

### M7c.7: performance and complexity pass (planner, crew; M7 and earlier features)

The g58 diagnostic above stopped on planner cost: one crude route searched 200,000 expansions, and the replay of the
captured blue plan (`m7-seed11-blue-wide`) spent **7.2 s of plain Lua in a single planner step**. The user asked for
performance under control through M7, speedups in older features too, and lower cyclomatic complexity. Every change
below either keeps decisions identical (verified as described) or says how it changes them.

**Pipe router** (`planner/pipe-router.ts`, `plan.ts` `PipeJob`). A fluid route ran in one call regardless of the
`planner-work-per-tick` budget. The search is now plain resumable data (callbacks are passed to each step, never stored,
so a plan job holding it can sit in `storage`), stepped under the budget like the belt router, with tile costs and
underground checks cached per search. A coarse pass runs over `coarseCell` cells split into their 4-connected
*traversable* components (a tile any move can use: placeable, or passable under). Its graph has a path exactly when the
tile graph has one, so when it runs out it proves "no path" at once (the 200,000-expansion failures). On a long line
(`longRoute`), the tile search keeps to the `corridorCells` corridor around the coarse path, guided by a reverse BFS of
cell distances inside the corridor (wall-aware, so it no longer floods the open ground in front of a walled-in goal).
No corridor path: the search is rerun without it. The coarse search reuses the router's `PIPE_HEURISTIC_WEIGHT` (4).
T1 `pipe-router`: a long line into a pocket open away from the source (work 35,472 → 3,047, route cost 150 → 184), a
walled-in goal proved by the cells, and a resumed search that keeps to its step budget and finds the one-shot route.

**Placement** (`planner/placement.ts`). (a) B26 sized an expandable module's window for its whole growth cap though
`evaluate` scores only `growthBandUnits` units: a blue-pack assembler row (~300 tiles of growth) built a 711×224
summed-area table at the smallest radius, again on every re-placement. The window holds the scored band now
(`scoredGrowthLength`, `windowMargin`). This is a behaviour change: the window also bounds the other modules' open port
lanes a candidate is checked against (B45) and the lane floods' "hard" lookups, so expandable modules now get the same
window-bounded lane checks every other module always had. On every replay fixture the placements are unchanged (routing
work identical) except `m7-seed11-blue-wide` (same outcome, two fewer re-placements). T1 `planner` pins the window size.
(b) B45's port-lane seal check flooded a lane again for every candidate touching its way out; the result is memoised per
footprint (the eight transforms share two) and a lane whose bounds miss the candidate is skipped (metrics identical).

**Pole network** (`planner/power.ts`, M5). A pole search costed every tile once per pole in wire reach of it (~170
times): cached per search. `wireDegree` counted over every pole at each look and `startNext` asked it for every powered
pole for every pending module (O(poles²) per pick): `addNode` keeps the counts (rebuilt once for older saves).
**Whole-patch mines** (`planner/mine-plan.ts`, M6): the 54 grid phases revisit each drill centre about four times; a
centre's terrain check is read once per plan. Both decision-identical (every replay metric unchanged).

**Crew** (`jobs/crew.ts`, M2/M3). Profiled in soaks with temporary `LuaProfiler`s: `preemptForUrgent` was most of the
crew's time (up to 13 s per game minute at minute 32 of seed 11). Every tick it read the burner of every ready refuel
(~800 of them) and looked each up with `indexOf` in each busy member's `planSeen` (~850 ids). Now a refuel's urgency is
read only if some busy member may drop its batch for it (a member reset in the same loop plans again and sees the tick's
jobs as seen, so the filter cannot change the outcome); `planSeen` lookups use a derived set (not in `storage`); jobs at
or below every busy member's batch priority are skipped first; idle-tick accounting looks for a ready job only for a
member without a claim. Each step was checked by a same-seed soak that played out identically (goals, counters, crew
stats, work totals).

**Complexity** (cyclomatic, decision points per function; a TypeScript-API count over `mod/src`): `computeRates` 127 →
pieces of at most 28 (verified: all 5,241 `computeRates` results of the T1 suite byte-identical); `tryExpand` 113 → 25
(all 458 calls of the T1 suite identical, including the claims around the module); `stepPlacement` 62 → 16 and
`routeStep` 61 → 21 at most (every replay metric identical, same step boundaries). Functions over 50: 16 → 11 (`d56970c` → final).

Results (plain Lua 5.4, T1 replays at the in-game budget of 400 units a tick):

| Measure | Before (`d56970c`) | After |
|---|---|---|
| `m7-seed11-blue-wide` largest single step | 7.2 s | 34 ms |
| `m7-seed11-blue-wide` replay | 15.4 s, 1.22 M work | 2.6 s, 0.50 M work, same outcome |
| B85 cluster replay (poles 2.6 s → 0.9 s) | 4.9 s | 2.4 s |
| 18 replay fixtures: candidates / work | 1.27 M / 4.07 M | 1.22 M / 3.16 M, same outcomes and failures |

Soaks on this machine (4 cores, Factorio 2.0.77 headless, `m7.toml`, seed 11; ms figures from overlapping runs are
indicative only, SPEC §9):

| Run | AI ms/tick avg / worst interval | planner | crew | Work totals |
|---|---|---|---|---|
| 3 game-h, `d56970c` (concurrent with the next) | 0.78 / 6.60 | 0.20 / 10.07 | 0.29 / 1.64 | planner 5.15 M, expansions 2.86 M, candidates 0.95 M |
| 3 game-h, `7470d40` (planner changes only) | 0.82 / 3.58 | 0.10 / 4.64 | 0.42 / 2.88 | planner 3.74 M, expansions 1.09 M, candidates 1.66 M |
| 45 game-min, before the preemption changes (temporary profiling hooks: ~10 profiler calls a tick), alone | 0.97 / 5.35 | 0.07 / 1.42 | 0.60 / 3.66 | identical play in all four 45-min runs |
| 45 game-min, `b397fb3` (all, no hooks), alone | 0.42 / 1.55 | 0.07 / 1.33 | 0.16 / 0.50 | |

The two 3-hour runs diverge from minute ~8 without any different decision: at minutes 10 and 20 both bases hold the same
entities at the same places, but plans needing less work finish earlier under the same per-tick budget (labs g2 30
ticks sooner), so the crew's build order shifts and the trajectories drift apart (same goal sequence, different sizes
later). Their work totals therefore compare different games: the candidates rise there is the drift (one minute held
0.8 M), while on the identical replay inputs above candidates fell. The crew's 0.29 → 0.42 there is the same drift; the
crew work was measured on identical play in the 45-minute series.

Tests: T1 47/47 files; full T2 170/170 on `7470d40` (planner changes) and on `b397fb3` (final code); targeted T2 for
the crew changes (`preempt`, `jobs`, B17/B30/B31: 26/26); T4 determinism (`determinism.py --seed 11`) on `b397fb3`: fresh,
resumed from a save and benchmark runs identical at 30 min. Not run here (manager): the M7 acceptance soaks and the
two-faction soak on the final commit, and the g58 live resume, which should now show whether its plan completes.

Observations, not changed (for the user):
- ~800 refuel/feed jobs stay ready and unclaimed for long stretches around minute 30 of seed 11: diagnosed and fixed in
  the follow-up below (orphaned temp-cell refills, not burner refuels).
- Whole-patch mine planning ran in one step and counted no work: done in the follow-up below.
- T1 fixtures have no `oreTiles` index, so `buildPatches` scans whole regions in T1 (~100 ms steps); in game the chunk
  ore index is used and its work is counted.

#### M7c.7 follow-up: whole-patch mine planning in budgeted steps (M6 mines)

Asked for in-session (2026-11-01): make the mine-layout step resumable, then diagnose the refuel jobs.

A mine's whole-patch preparation (D52/B33/B45: patch, grid search, materialising, lane seal check, fit) ran inside the
placement step that accepted the mine and counted no work. It is now plain resumable state (`planner/whole-patch.ts`,
`PlanJob.wholePatch`) stepped under `planner-work-per-tick`, its work counted as placement work, and it is cheaper:

- **Grid search** (`mine-plan.ts` `stepPatchSearch`): each tile of the search area is read once into summed-area tables
  (blocked, the resource, foreign ore); before, each tile was read once per drill position over it (~20k `block` and
  ~52k `ore` reads for a 732-tile patch). Phases are scored by covered tiles and drills alone; a phase's full plan is
  built only when it ties the best on both, and for the winner. 47 → 14 ms on that patch.
- **Poles** (`modules/poles.ts` `placePoles`, also used for every generated module): each greedy pick tested every free
  tile against every pole and consumer; wire-reach connectivity is now kept as poles are added and each tile's covered
  consumers are listed once. A 158-entity mine: 28 → 9 ms to materialise.
- **Lane floods** (`placement.ts` `laneWayOut`, B45/B57/B85, also used by placement): moves are tried without a table per
  move; ground/under lookups are memoised per piece of the mine preparation.

Decision-identical (logged before/after over the whole T1 suite): all 156 `planWholePatch`, 406 `placePoles` and 17,516
`laneWayOut` results, and all 161 placements the replays commit. Replay outcomes are identical; only their `work` grows
by the now-counted preparation (e.g. `seed11-production-ok-compare` 145,791 → 158,155). Largest single planner step at the
in-game budget (400), same replays: 84 → 36, 73 → 15, 79 → 13, 93 → 34 ms; the remaining >30 ms steps are the T1-only
`buildPatches` region scan noted above. T1 `mine-plan`: a stepped search and a stepped preparation give the one-shot
result within the budget. Tests: T1 47/47, full T2 170/170 (`90a892e`).

#### M7c.7 follow-up: the ready, unclaimed "refuel" backlog was a temp-cell refill leak (D38/B18)

A new debug probe (remote `board_summary`, soak helper `tools/harness/probes/board.lua`) groups a faction's active jobs
by key prefix, kind, item and target. On seed 11 (m7.toml, 40 game-min) it showed the backlog was not burner refuels:
at minute 30, 523 of the 902 active jobs were `fuel`-kind deliveries of about one copper plate each into temporary cells'
input chests, at priority 40 (`bootstrap-temp-cell-feed-priority`), all ready with their materials in stock, and none
carried a job key. `topUpTempCells` (B18) queued another `tempfeed:<chest>:<item>` refill every think while the key's
job was still open; `addKeyed` re-pointed the key, so the old job was orphaned: no longer counted as in flight (so the
next think queued more), still counted as demand (shrinking the surplus to about one item, hence the one-item jobs), and
starved by priority-90+ work. Every other keyed producer (refuels, ore feeds, the on-demand cell feed, lab feeds,
upkeep) already skipped an active key; the top-up now does too (one refill per ingredient in flight; the next chunk
follows when it is done).

Same seed, same build otherwise: active jobs at minute 30 902 → 225 (a build's place jobs), unkeyed refills 523 → 0, jobs
processed 2,544 → 1,847, crew 0.115 → 0.067 and AI 0.35 → 0.30 ms/tick; the same milestones through automated red
science (36.7 min in both), production built at 35.8 instead of 34.7 min, `logistic-science-pack` research started at
39.4 min (not reached by 40 before). This is a behaviour change: temp cells get fewer, larger refills. T2
`temp-factory`: with no crew to take them and the depot gaining plates between thinks, one refill is in flight after 8
thinks (8 before the fix). Tests on the final code (`3b33426`): T1 47/47, full T2 171/171, T4 determinism (seed 11)
PASS. Not run: the M7 acceptance soaks.

#### M7c.8: seed 11 to the blue line (debugging the chain after M7c.7)

Seed 11 (m7.toml) planned the blue chain (goal g49) but never built it. Its blockers, in the order they showed up, and
what was changed; runs resumed from saves in the new save library (`out/saves/manual/`, soak `--save-at`,
`--resume-from`):

- **The oil field's fixed spot read "terrain unknown"** (agent design, proposed): the pumpjack field's box reached past
  the explored chunks. A field chosen from seen wells now marks the chunks under its footprint known (`explore.ts`
  `knowRect`).
- **The blue line's iron smelter was starved, so no steel and no pumpjacks.** Its replacement iron mine was shared with
  consumers drawing more than planned (n27 0.5/s against 0.29 planned, n28 0.3 against 0.18), and the design kept
  tapping a mine about to run dry. The user asked why the expected ore differed from reality and approved both fixes
  in-session (2026-11-01):
  - (a) a mine with less than `MINE_TAP_LIFE_LEADS` mine leads of ore left at nameplate output gets no new consumers
    (`stage.ts` `oreRunsOut`; `fuel.ts` records `f.oreLeft` and logs the transition once);
  - (b) a production goal that feeds an input of a module still being built, which no graph edge feeds yet, is not held
    by the one-production-goal lock (`goal-holds.ts` `feedsBuilding`).
- **Measured draw sizes shared providers** (user-approved in-session, 2026-11-01): spare capacity and shared-provider
  demand use `max(planned, measured)` per edge (`logical.ts` `edgeDraw`, `design.ts` `expandShared`); measured
  overdraws above a step of 1/`DRAW_KEY_STEPS` per second are part of the design cache key, as are the running-out mines.
  Expected churn: draw-420 planned a run of parallel power goals (g59–g67) once real draws were counted.
- **A stalled building goal held up the growth that would unblock it** (user-approved in-session, 2026-11-02): g49 placed
  nothing for hours while the iron-mine growth waited for it (B52 reroute wait, B98 growth waits). A building goal that
  has placed nothing for `stall-ticks` (existing setting; `FactoryGoal.progressTick` set at plan time and on each
  placement) no longer blocks growths (`goal-holds.ts` `goalStalled`).
  First version released the goal-kind ordering lock too. Resumed from minutes 540 and 300, that let the second blue
  cluster (`labs#2`) plan a full copy of the stalled chain, whose oil module failed at the same fixed spot ("no room at
  its fixed spot: occupied at -375,28") 8 times, and fail-fast stopped both runs. Reverted: the kind lock still holds;
  feeders pass by (b), growths by the stall rule. From minute 540 the stall rule did let six goals through (power g69,
  g72; production g70, g71, g74) before that failure.
- **A drill ghost on mined-out ground made the blue chain give up its location** (agent design, proposed): resumed from
  minute 300, one electric drill of goal g54 stood on ground whose ore was mined out after the plan (probe: no resource
  in its mining area, nothing overlapping, `surface.can_place_entity` true). The character's check refused it for 10
  rounds and B20 relocated the module: 1,734 built entities to deconstruct, and the faction-owned entities it left
  blocked the oil field's fixed spot for every later plan ("blocked (terrain own) at -373,39"). A drill place job that
  fails `cannot-place` with no resource in the mining area now drops its ghost (`no-ore-left`; `jobs/crew.ts`); from the
  minute-360 save g54 was built in one extra round. Open: a relocation can still leave own entities on a fixed spot.
- Seed 11 status on `f9a464c`: from minute 540 (no drill fix needed there) the blue goal g49 was built at tick 2,979,630
  (~minute 828). From minute 360 the next goal, the sulfur module, failed every attempt: "no pipe path (budget exhausted,
  200000 expansions)" for its 125-tile water line inside the base and for a ~900-tile crude line from the oil field
  (`taps 0`: it found nothing on g54's crude line to tap); AI 12 ms/tick during those searches. Not fixed yet.
- **Pipe ports were invisible to placement and to port reservations** (agent fix; follows the belt-port rules):
  the sulfur chain's failures above reproduced in a T1 replay captured from the minute-360 save
  (`m7-seed11-sulfur`, region 2,478 × 2,169; it needed the capture limit raised). A failed pipe search now says where
  it stood (pass, nodes, closest approach, a 5 × 5 map of the goal's neighbourhood). The water line got within one
  tile of its goal: placement had put the chain with both pipe inputs facing a row of built belts (the blue chain's
  coal fuel route and a copper route), because placement's candidate port checks covered belt ports only. Pipe ports
  now get the same outside-tile and lane checks (`placement.ts` `tdefOf`); the replay plans with the normal budget
  (2.47M work units against 3.58M failing). The live resume then failed with the search reaching the goal tile itself
  and finding it taken: only belt ports reserved their outside and approach tiles when a module was placed, so belt
  routes and poles took a pipe port's entry. Pipe ports now reserve them too (`layout.ts` `isLanePort`). The lane
  sealing checks (B45/B57 `openPortEnds`, `openLanes`, growth port checks) are still belt-only.
- **Fluid chains fed from a remote field were placed deep inside the base** (agent design, proposed): with the
  ports fixed, the next resume failed only on the ~900-tile crude line, stalling 60–100 tiles short at the west edge
  of the base's built block every attempt (replay `m7-seed11-crude`, goal g62). Placement searched radius 48 around the
  cluster centre in the middle of the base, where the only room was on the far (east) side, and weighed a pipe tile
  like a belt tile, so moving toward the source saved its crude port what it cost its belt ports. Now a pipe port's
  distance to its connection counts `pipePort` times a belt port's, and a module with a pipe port fed from beyond the
  largest search radius scans every radius before choosing (`placement.ts` `remotePipe`). The replay plans: 1.08M
  work units, no rip-ups, 2,285 route tiles.
- **At the base edge, the crude lines failed on their last tiles** (replay `m7-seed11-edge`, resume goal g71): the
  plan routed short connections first, so its belt routes had walled in the plastic chain's pipe entry before the
  900-tile crude line was searched. Fluid connections now route before belts (`plan.ts` queue order: a pipe cannot rip
  up, side-load or pass under a module). The plastic line then routes. The sulfur chain's crude line still failed:
  its crude and water inputs sat two tiles apart on one edge, facing a 2-wide gap beside the steam block, and the water
  line ran past the crude port's outside tile. Two changes: a pipe search treats another fluid's port outside tiles as
  that fluid (a pipe beside one would join it), and the fluid-chain generator puts the second fluid's input on the east
  end of its manifold, opposite the raw fluid's (`generators.ts` `fluidChain`). The replay keeps the captured module
  geometry, so it is pinned as an expected failure on the sulfur crude line only.
- **Every plan with a pumped crude line was discarded** (latent since M7b; seen only once a ~900-tile line routed):
  a fluid route's pump poles are tagged `x:pump:<route>`, and the claim checks read every `x:` tag other than
  `x:poles:` as a module's interaction tile, so plan adoption rejected it ("invalid-layout-claims: missing interaction
  owner pump:route:..."). They are now a (non-evictable) pole line (`claims.ts` `occupancyClaim`). The T1 replays
  never caught it: a replay that finishes now checks the layout's claim owners too, ignoring problems the captured base
  already had (`r333968-second-power` has some).
- **With the chains planned and adopted (goal g61, first time on seed 11), three more blockers** (resumes from
  minutes 360, 480 and 510):
  - *No stone bricks*: the build stalled after 430 placements. Two oil refineries need 10 bricks each, and nothing
    made bricks: the bootstrap catalog leaves furnace recipes for building materials (stone → brick) out of its
    smelting, so stone only has chest sites. Such a recipe is now recorded (`Catalog.materialSmelts`), and a shortfall
    of its product queues a smelt site on the resource (`bootstrap.ts` `brickSite`: a burner drill feeding a furnace,
    whose output is a supply point). Catalogs saved before it are completed on first use. g61 was then built (430
    placements).
  - *A crash on the first refinery*: measurement read every ingredient with `get_item_count`, which throws on a fluid
    ("Unknown item name: petroleum-gas"). Fluid ingredients are read from the fluid boxes (`measure.ts`).
  - *The pumps had no power*: a probe found the refineries and plants out of fluid, the pumpjacks full, and the two
    pumps of the 900-tile crude line `no_power` with no pole beside them. A plan delta built only the poles the pole
    job added; pump poles are added when the pipe route is committed, so none was ever built. They are now part of the
    delta (`plan-delta.ts`), and a fluid edge's repair checks its pump poles too (`factory.ts`), for layouts built
    before.
  - *The far pump stayed unpowered*: resumed from minute 360 on that fix, g61 was built (767 placements) and both pumps
    got a pole, but the pump 330 tiles from the base stood alone on its own electric network (a network-map probe: the
    main network 803 poles, the pump pole an island of one). A fluid route's pumps share one pole line, and the pole
    planner counts a consumer as powered when any of its poles is: the pump beside the base powered the whole line.
    Each pump pole is now its own consumer (`power.ts` `layoutPoles`, `powerRoles`); T1 `power` pins it, and a
    replay that finishes checks that it leaves nothing new unpowered. Layouts built before keep the island until
    replanned.
  - *The first segment carried nothing*: with both pumps powered, a pipe probe found crude in every pipe from the field
    to the first pump at 29/100, the pumps empty and the pumpjacks full: the M7b engine finding (a segment longer
    than `default_pipeline_extent` carries nothing). The router counted the segment from the field's port (321 tiles
    to the pump); the field's own collector pipes made it longer. A search now starts its first segment with the
    source module's pipe tiles counted and must reach the consumer with room for its pipes (`PipeParams.startRun`,
    `goalRun`; `plan.ts` `moduleFluidRun`: every pipe tile of the module, pipe-to-ground spans included, an upper
    bound). T1 `pipe-router` pins it. The next resume pumped crude past the first pump (pumpjacks working, the pump
    at 400), then stopped again at a pump-to-pump segment the router had made exactly 320 tiles: the engine counts a
    little more than the router's path. The router now keeps `PIPE_EXTENT_MARGIN` (8) tiles under the extent; 16 made
    the sulfur chain's tap unroutable in two replays.
  - *A tap made the first segment too long*: with the margin, the first segment failed again although shorter: the
    sulfur chain's crude tap joined the trunk beside the field and ran its own pipes 600 tiles to its first pump, all
    one fluid segment with the trunk's first (a pipe probe found crude up to that pump, none past the trunk's). A tap
    now starts with the length of the trunk segment it joins counted (`plan.ts` `segmentLengths`, `PipeParams.starts
    [].run`), so it must put a pump at once or join a segment with room. T1 `pipe-router` pins it.
  - **Result: seed 11 makes blue packs** (`d5f4435`, resumed from the minute-360 save): goal g61 built at tick 1,742,760
    (525 placements), crude reached both refineries at once (200 each, the four pumps and three pumpjacks working),
    and by tick 1,846,800 (~min 513) the faction had made 82 chemical science packs, 266 advanced circuits, 1,514
    plastic bars and 1,038 sulfur, researching the blue throughput test. Pack output in that window ~3/game-min;
    plastic and sulfur back up (`full_output`) behind it. Saves: `out/saves/manual/tap-360-min-0510.zip`.
    Not run yet then: a fresh seed 11 run on this build (see below), the other M7 seeds, the M7e acceptance soaks.
  - **A fresh seed 11 run stopped at minute 366** (goal g42: belt ghosts unplaced for 20 rounds, "pathfinder found no
    path"): crew member 1 had been walled into a ~80-tile pocket since early on (the lake on three sides, the steam
    block's offshore pump and engines on the fourth; 717 escape retries), and every job it claimed failed. The B22
    escape only looked 3 tiles around the member, and its type list named "steam-engine" (the entity's name; its type
    is "generator") and had no offshore pump. Now a member with nothing in reach floods the tiles it can stand on (the
    engine's character check, up to `POCKET_MAX_TILES`); a closed pocket's own entity on its edge is picked up from a
    pocket tile beside it (small types first, then one that opens outward, then the nearest; engines before the
    offshore pump), and the pick-up's ghost waits `UNBOX_GHOST_DELAY` before it goes in: placed at once, the member
    took its place job from inside and walled itself in again. From the minute-360 save the member got out after
    two pick-ups and g42 was built (302 placements). Open: the planner still routes and grows into ground the crew
    cannot walk to (a copper growth later rerouted belts through the same pocket under the steam block; B20 abandoned
    it after 10 rounds). Treating walk-unreachable ground (water, cliffs and own buildings around it) as blocked
    needs a reachability flood per plan: not done.
  - **The fresh seed 11 lineage makes blue packs too** (resumed from that minute-360 save with the pocket escape):
    after a slow stage 2, exploration found crude after 12 radar outposts (~84 game-min); goals g97, g99 and g100 (the
    sulfur chain, 359 placements, built at tick 2,540,850) followed. First sulfur at tick 2,642,400 (~min 734), first
    chemical science pack at tick 2,685,600 (~min 746; 540 advanced circuits, 1,774 plastic, 458 sulfur by then). The
    earlier minute-360 resume (`tap-360` lineage, kept running as `sustain-510`) had made 868 packs by tick 2,476,800
    (~5/game-min over two game-hours). Both still short of stage 3's 10/min.
  - *Fluid edges read 0/s*: measurement had no probe for pipes, so a fluid edge was "no belt at the port: 0/s" whatever
    flowed (the reconciler's crude repairs said "nothing missing" while the pumps were unpowered). Fluids have no ids
    and the API no flow counter: a probe of an edge into a pipe port now samples how full the pipes at both ports are
    (`fullFrom`/`fullTo`, the share of samples at least `PIPE_FULL_SHARE` full) and takes as the edge's rate what the
    consumer used of the fluid in its measurement window, split over its feeds of that fluid by planned rate
    (`measure.ts` `fluidProbeTick`). From the minute-510 save the two crude edges read 5.0/s and 1.67/s (planned 1.88
    and 0.47). New debug remote `edge_debug(name, filter?)`: the live graph's edges with their measurements.
  - Open: from minute 510 the reconciler keeps repairing the coal edge from the `power~4` coal mine to the plastic
    chain (13 repair goals, several re-placing 250-520 route entities, five "nothing missing"): that route's splitter
    tap stands over an old belt ("picks up stale belts under"), and after the repairs the probe still sees no coal
    arrive. The plastic plants are fed by the chain's other coal edge (same port), so packs are not held up. Not
    diagnosed yet.
  - Open, fresh lineage after its first packs: 30 packs by ~min 793 (tick 2,854,800), sulfur flat at ~470. Probes on
    the minute-780 save (`out/saves/manual/pocket5-360-min-0780.zip`) show the chain fed piecewise. The sulfur belt is
    full up to the first pack column (x 386.5: four assemblers with sulfur and engines, almost no advanced circuits).
    The two grown pack assemblers (x 403.5/406.5) hold six advanced circuits each but get no sulfur: the sulfur belt
    ends at the first column. The advanced circuit column at x 393.5 has plastic and cable but no green circuits,
    while most green circuit and cable assemblers sit at `full_output`; two advanced circuit assemblers at x 411.5
    are full and never emptied. So growth units and later modules get only some of their inputs, and the plastic,
    sulfur and refinery modules back up behind them. The reconciler does not catch it: the sulfur edge's port probe
    reads the first column's port (0/s, not full). Not fixed yet.
  - One cause found there: the second chain's sulfur plant has had no water for over an hour. Its water route's
    pipe-to-ground entrance at (414.5, 37.5) connects to nothing: the exit tile holds a pipe-to-ground facing west,
    left by an older copy of the route (its pipes end in a dead end). The build check matched built pieces by name
    only, so repairs found "nothing missing". It now compares direction for pipe-to-ground and pumps too, and treats
    stray pipes under a route as stale pieces to pick up (`planner/conflicts.ts`, `141c68f`). Not proven in a run:
    resumed from minute 780, the reconciler never asked for a repair of that edge. The fluid probe gave it 0.50/s
    used (probably crafts from earlier in the window), with neither port pipe full, so it was not called broken. T2
    passed 170 of 171; the miss ("Too many forces" in a mining-arena crew test) passes alone.
  - The other gaps, traced on the same save (belt followers, the new `route_debug(name, x?, y?, item?)` remote: the
    layout routes on a tile or of an item, with their ends, port tiles and, up to 40, their steps). The two chains
    are "labs" (sulfur plant n294 at (410, 25), packs n291 at x 403.5/406.5, advanced circuits n292 at x 411.5) and
    "labs#2" (sulfur n321, packs n315 at x 386.5, advanced circuits n319 at x 393.5):
    - *The water route crosses itself (pipe router bug).* Its 13 steps are `pipe-ug-in@424,40 pipe-ug-out@414,40
      pipe@413,40 pipe@413,41 pipe@414,41 pipe-ug-in@414,40 pipe-ug-out@414,37 ...`: tile (414, 40) twice, as an exit
      facing west and then, after a three-pipe loop, as an entrance going north. One tile holds one pipe-to-ground, so
      the second was never built, and the build check counted it as built (same name there). The search state is
      tile plus heading, so a path may come back to a tile on another heading; nothing rejects a tile already on the
      path. That starves the "labs" chain's sulfur plant, so its packs (x 403.5/406.5) get no sulfur, its circuits
      (x 411.5) back up behind them, and plastic and the refineries back up further. Fixed: a found path that takes
      a tile twice (any step, a pump's both tiles) is skipped and the search goes on (`pipe-router.ts`
      `crossesItself`); T1 `pipe-router` rebuilds the seed 11 shape (the old router returned `ug-out@4,4 ... ug-in@4,4`).
      A first version also checked each expansion against its 32 nearest ancestors: 4x slower on the flooding search
      of the pocket test (0.86 s to 4.3 s) and +15% on the seed 11 replays, so only the arrival check stayed (pocket
      test back to base, replays 116 s against 120 s). A path whose cheapest state is a crossing one can still miss a
      dearer non-crossing path to the same tile and heading; not seen in the tests. Layouts planned before keep their
      crossing routes until replanned.
    - *A backed-up one-lane belt reads as broken.* An inserter loads one lane, and that lane stopped holds 4 items per
      tile, under the probe's full mark (`FULL_TILE_ITEMS` 7 of 8). A stopped line then reads 0/s and not full at both
      ends, and the reconciler asks for a repair that finds "nothing missing" (the "labs" circuits to packs edge three
      times at ~min 1470-1515 of log time; the coal edges into the plastic plants the same way in both lineages).
      Changed: a port tile also counts as backed up when one lane holds 4 items with the same ids as at the last
      sample (`measure.ts` `backedUp`; a compressed lane that moves changes ids between samples, so it stays "not
      full"). T2 reconciler and measurement tests pass. Minute-780 resume (`lane-780`, 54 game-min, against `ptgfix-780`):
      it did not remove the "labs#2" packs to labs repair (n315 to n31, "nothing missing" twice in both runs), so that
      edge is not a stopped one-lane belt; chem packs still rose 14 to 100 in the window. It newly flags the
      "labs~3" ore edge (n41 iron ore piled up, 0/s to the smelter n42): one repair re-placed an entity, a second
      found nothing missing. The coal edges did not come up in this window in either run. Open.
    - *The "labs#2" packs went into a buffer chest.* The reconciler's "repair n315 to n31 -> nothing missing" (twice
      per window) was real: the 57-tile pack belt holds no item at either end and measures 0/s. The pack row's head
      inserter lifts every pack off the output belt into its iron-chest buffer (14 packs at minute 780, 24 ten
      minutes later). Its 2 slots hold 400 packs, and the row is starved of advanced circuits (~0.06 packs/s), so
      nothing passes the chest for about 2 game-hours. D51 puts buffers on smelter columns, circuit blocks and gear
      rows; the design gave one to every assembler row. Fixed: only gear rows (`design.ts`, T1 `design` "D51").
      Rows built before keep their chest until replanned.
    - *A merge splitter left unbuilt over an ore branch.* The "labs~3" ore edge (n41 to smelter n42) that the lane fix
      newly flagged is cut: every ore route into n42 is empty at n42. The n41 branch runs south at x 525; route
      "labs~5" (n47) joins it with a merge splitter on its tile (525,-55). In game that splitter is missing, the
      branch's old belt stands under it, and the branch's belt at (525,-56) is missing. The branch's repair checked
      only its own routes and its trunk: it re-placed (525,-56), then found "nothing missing" while the flow still
      stopped at the merge (the merge route's own check sees the stale belt, but its edge never looked broken).
      Changed: a belt edge's repair also checks the pieces other routes stand on its tiles, the splitters of taps
      off it and merges onto it (`conflicts.ts` `routeCheck`, over B91's `dependentRoutes`); T2 `conflicts` "M7c.8:
      a branch's check takes in a merge splitter". In game (minute-780 resume `merge-780`): the repair picked up the stale belt and placed the merge splitter
      and the branch's belt (both standing by tick 2887200); n42's ore inputs then measured 1.50/s on three edges
      (labs~3, ~4, ~5), all 0/s before. A second repair, sampled before the build finished, said "nothing missing".
      Full T2: 172 passed. New debug remote `check_debug(name, filter)`:
      the build check of the belt edges whose role contains `filter`.
    - *A sixth steam block finds no shore.* The fresh lineage ended (min ~770-805) with power goals g114 and g115
      failing every attempt ("no feasible position", region radius 112 to 378). Replay `m7c-11-power6-nofit`: the
      search stays 96 tiles around its target whatever the region (the only lake in the 504-tile view is within it);
      of ~53k candidates whose 2x3 water strip fits, 33.6k are blocked only by water inside the 10x14 rectangle (the
      straight shore is taken, the rest of the coast curves) and the others by modules, routes or built entities.
      Changed: a shore module may list `anchor.wet`, entity-free footprint tiles that may stand in water; the steam
      block lists its pump column (every tile but the pump's). The replay then places it at 434,41 on the curved east
      shore (1 feasible of 24k at radius 24). A wider search (192, like outposts) found nothing more for 4x the work,
      so it was not kept. The plan then fails on its coal: the design taps `coal>power~3` (n28, ~130 tiles north),
      and the router's flood from its tap points is sealed after 13 tiles. In game (minute-780 resume `wet-780`, with
      the buffer fix below): power goal g116 places on its second attempt (region 168), plans its coal route, and is
      built at tick 2905200; chem packs made in the 54-min window went 14 to 212 (`lane-780`: 14 to 100). The
      replay's coal seal is therefore a capture artifact or depends on the region; not followed further.
    - *"labs#2" lacks copper upstream.* Its cable assemblers (x 459/467, y 12.5) are empty, so its green circuits are
      short of cable, its advanced circuit column (x 393.5) has plastic and cable but no green circuits, and its packs
      (x 386.5) get sulfur and engines but almost no advanced circuits. The reconciler found it: the copper smelter
      n329 runs flat out, and both attempts to grow it failed with "port in-fuel outside tile blocked". Diagnosed
      (the message now names the tile and its terrain): growing moves the fuel port 4 tiles east, onto (453,11), where
      the underground exit of another route (coal to steam block power#4, n168) stands; the smelter's own fuel route
      is ripped and freed, that one is not. The block is real. After `GROW_MAX_FAILS` (3) the design would plan a
      parallel copper provider, but in three 54-min resumes from minute 780 the third attempt never came (failure 2
      at the start of each, then no copper growth). Why: the reconciler's trace for the starved "labs#2" nodes stops at
      a broken edge downstream of copper (end of `wet-780`: 14 nodes on the packs to labs edge, the buffer chest above;
      end of `lane-780`: 14 on the advanced circuits to packs edge), so n329 is no longer a root cause and its grow
      remedy is not picked again. Rows built before the buffer fix keep their chest, so this save keeps showing it;
      a fresh lineage on the current build is the check.
    - *The "labs" circuit route was being rebuilt.* Its first pieces beside circuit module n287 (x 562, y -67) are
      belt ghosts with place jobs: growth goal g112 picked up 182 entities and is placing 189. Both crew members were
      busy with other jobs (refuels, inserts, walks), so the ghosts waited. Not a bug, but the chain's circuit supply
      is off while a growth reroutes it.
    - Not traced to the plan: two green circuit assemblers (x 463.5/467.5, y -23.5) put circuits on a belt that ends
      at (434.5, -27.5) with gears on its other lane, on no layout route; four others insert straight into
      neighbouring assemblers that are full. Neither is on the pack chain's routes.
- **Fresh run `fixes-360` (seed 11 from minute 360 on the fixes above): three more "nothing missing" loops.**
    - *A thin tap read as lost.* The labs#2 iron-plate tap (n35 → n33) was re-laid 3 times as "makes 0.033/s (… 0.48,
      2.65) but none reaches". A probe (`fe2-420`) saw single plates cross its port every few probes: the belt gets
      0.03–0.5/s, so a 10 s edge probe often sees none. B69's "none reaches" now needs at least `LOST_MIN_ITEMS` (3)
      items owed to the belt in one probe (its B96 share of the producer's output × the probe length); below that the
      edge is left to B96's "filling" verdict (`reconcile.ts`; T1 `reconcile` "M7c.8: a trickle too thin …").
    - *Jobless ghosts count as built.* Mine n176's 24 drills had no power for 15+ game-min; every power repair said
      "nothing missing (the layout's poles reach it)". Probes (`pw2-360`, `pw3-360`): the mine's poles are an island
      (network 142), joined to the base by a pole line with 6 small-pole ghosts and no active place job for any of them
      (their jobs had failed). `checkBuild` counted a ghost as present. With a faction it now counts a ghost whose job
      is failed, done or gone as missing (`orphans`), and `applyDiff` gives such a ghost a new job instead of reusing
      the dead job id (`conflicts.ts`; T2 `conflicts` "B56: … M7c.8: a jobless ghost is missing", folded into B56 because a T2 shard has at most 64 forces and a new faction test pushed one over).
    - *A reroute cut the base off its power plant (minute ~630).* After coal mine n20 retired, the coal repairs
      rerouted routes in place (B88: g98, g101, g103, 67–219 placements). `planReroute` uses the claim view, which
      reads the faction's own pole-line poles as free (B37: a plan evicts and re-lays those lines), but a reroute
      evicts and re-lays nothing: a coal belt was routed over main-line poles, g103 then picked up the pole at
      428.5,-5.5 as "not in the layout", and every module said "the layout's poles do not reach it". The run had no
      power from then on. A reroute now keeps pole-line tiles solid (`reroute.ts`). **Open:** a layout already cut
      this way has no recovery (the power repair only reports it); a pole-only plan from the repair would heal it.
- **Fresh run `fixes-360` continued (minute ~600–654): the crew and the planner slowed the game to a crawl.**
    - *2077 haul and deposit jobs open for 400 game-min (crew 21–43 ms/tick).* Probes on the minute-645 save
      (`crew-600-min-0645`): every open job was a self-job (haul, deposit: created and claimed by one member, never
      selected from the board) with reason "no-actions". A member boxed in by the steam block's shore pocket (below)
      hit `TRAPPED_NO_PATHS`; `pollActions` ran the unbox *before* handling the failed walk's job, and an unbox with
      nothing to clear keeps the member's actions, so a haul whose last take was that walk lost it with its claim
      still held. The "no-actions" safety net then released the claim and put the self-job back on the board, where
      nobody may claim it, and idle members scanned all of them every tick. Now the unbox runs after the action's job
      is handled, the safety net fails a claimed self-job instead of releasing it, and `dropDeadJobs` ends open
      self-jobs (old saves). T2 `jobs` "M7c.8: a member walled in with nothing to clear leaves no haul or deposit job
      open" (a member walled in by another force's walls, a stockpile with chest ghosts outside; on the old code it
      fails with "an open self-job: #5 haul no-actions").
    - *An idle member planned every tick.* Each plan reads every supply point's inventory (`availableItems`): 1.85
      ms/tick with an empty board and two members. After a plan finds nothing, the member now plans again after
      `IDLE_REPLAN_TICKS` (60) or as soon as the board changes (a job added, claimed, released, done or failed;
      `board.counters`). From the same save: crew 21–43 → 0.05–0.07 ms/tick, AI total 0.6–0.8 ms/tick.
    - *The planner took 76 s of one game minute (minute 654, goal g107).* The sulfur chain's water line ran its whole
      200000-expansion budget though its goal was 13 tiles from the start, and the advanced-circuit belt failed
      "route crosses itself" three times. Replayed from the captured input (T1 `m7-seed11-g107`): the goal sits in a
      pocket walled off on the south, and the cheapest way in went west under the wall, looped round four tiles to
      turn north and came back through its own underground exit. Both routers search (tile, heading) states and only
      check a found path for tiles used twice, so that loop owned the state, every path the search kept descended
      from it, and every one of its arrivals crossed itself. A move is now rejected when one of the last
      `PIPE_CROSS_DEPTH` / `BELT_CROSS_DEPTH` (24) nodes on its path holds its tile (`pipe-router.ts`, `router.ts`
      `heldBy`); the whole-path check stays. Both routes are found now; the plan still fails, on an ordinary rip-up
      limit (a later attempt re-places). Every other replay gives the same plan with slightly less work (`m7-seed11-crude`
      routing 8 % less).
    - *The crude line's pumps waited 85 game-min for engine units (resume `fixed3-645`, minute 657–743, stopped by the
      fail-fast stall check).* g108 (the blue chain's production, 780 placements) had 4 open pump place jobs and 4 open
      pump crafts, both crew members idle. A pump needs an engine unit, which only an assembler can make; the economy
      had no source for it (no hand recipe, no temporary cell, not smelted or mined). The faction's two engine
      assemblers had made 244 (226 on the belt to the chemical-pack row, which waits on the same oil chain, and the
      rest in their full output slots), but a production assembler was never a supply point. Now the output slots of
      built modules' assemblers are supply points (`module-out`, last) for products the crew can't hand-craft, and they
      count at any amount: the slot holds a few at most, under `supply-min-take` (5), and the first try still waited with
      4 in each slot (`bootstrap.ts` `registerSupplies`, `factory-report.ts` `moduleAssemblers`, `supply.ts`). Resumed
      from minute 720: the crew claimed the crafts at once and g108 was built at tick 2601270 (minute ~722.5). T2
      `bootstrap-sources` "M7c.8: a product the crew can't hand-craft (engine units) is taken from a module's assembler
      output, below the minimum take". **Approved by the user in-session (2026-11-02), SPEC D80:** taking from a
      production module only for products with no other source; B36's broader `supply-module-furnaces` stays off. The
      user added an engine supply point: engine-unit rows now get a buffer depot like gear rows (`design.ts`, new
      setting `module-buffer-rows`, default `iron-gear-wheel,engine-unit`; T1 `design` "M7c.8 (user, 2026-11-02): rows
      of the listed products get a buffer depot"). Rows built before keep no buffer until replanned or grown; the
      `module-out` source covers them.
    - *A second crude field was placed on the first one's wells, 8 plans in a row (resume `blue-720`, minute 736–747).*
      With the pumps fixed, the blue chain ran (10 chemical packs by minute 736), and the design asked for a parallel
      crude provider. `oil.ts` `fieldModule` picked the best known field without looking at its wells: the only field
      in reach, already fully taken by the first, so g112 and g113 each failed 4 attempts "no room at its fixed spot:
      occupied at -375,28" and D68 found no built producer with spare capacity. Wells carrying a pumpjack (built or a
      ghost, any force) are now left out; a known field with none free is no field, and the goal explores for crude
      (the existing D62 path). T2 `world` "M7c.8: wells that already carry a pumpjack are no field for a new crude
      provider". Resumed from minute 720 (`blue2-720`): 42 chemical packs by minute 736, then the faction explored for
      crude, and the run stopped on the open D62 problem below: radar outposts g112 and g113 (arms toward 484,936) fail
      "power: no pole path (window margin 112)" on all 4 attempts each (8 failed plans in a row: the harness fail-fast).
    - *Radar outposts on lake-cut arms spent 4 plans each (resume `blue2-720`, minute 736–747).* Diagnosed from the
      failed-plan inputs (replayed with a temporary trace of the pole search): both arms are cut by real water. The S
      arm (radar at 470,935) has a lake 120–300 tiles deep across its whole strip from y = 375; the pole search from the
      base's south edge stalls at 474,374, 563 tiles short. The E arm's centre (1472,-52) lies in a lake, so the radar
      took the nearest land, an island near 1473,27 behind a ~90-tile water band; the search stalls at 1248,28. No pole
      crosses either (a small pole reaches 7.5 tiles). The search and placement are right; the waste was the retry: the
      region-radius ladder (112 → 378) cannot change a pole line's ground, so each arm failed the same way 4 times,
      and 8 failed plans in a row tripped the harness fail-fast before the W arm was tried. An outpost goal whose only
      failures are pole lines (`power:<owner>`) now fails on its first attempt and the exploration moves to the next
      arm (`failure-rules.ts` `retryCannotHelp`; T1 `failure-rules`). Resumed from minute 720 (`blue3-720`): E and S
      failed once each, W and N5 were built, and blue science ran at a steady 5 chemical packs/min (896 by minute 907,
      research on to worker-robots-speed-2). The run stopped on the fail-fast again: every exploration round tried E and
      S once more (E11, S11: the same lakes), and with W11's 4 placement retries (each 12 tiles off: those can find
      land, so they stay) that made 8 failed plans in a row. An arm whose outpost found no pole path is now marked
      `cut` (`arms.cut`) and skipped from then on: every later outpost on it needs a line through the same water
      (`arms.ts` `nextArm`; T1 `arms`). With every arm cut the search waits. Not done (proposed): stepping an outpost
      back to the last land the base reaches, so a cut arm still explores up to its lake.
      Resumed from minute 900 (`arms-900`): E12 found no radar spot (4 attempts), and the next outposts on S, W and N
      each found no pole path, so all four arms were marked cut within 7 game-min. Checked with a traced replay (N13):
      genuine, the radar's land lies past a lake ~100 tiles deep across the strip (y ≈ -2790 northward). So on seed 11
      every arm ends at water by outpost 12-13. The harness fail-fast still stopped the run (8 failed plans in a row):
      it skipped plan failures only during a *required* search, and a resumed run never saw the search's start line.
      `soak.py` now resets the count during any D62 search (either tag, recognised from any `EXPLORING (D62)` line),
      in line with D62/D70: a search for ground is not the design failing. Both stopping logs (`blue3-720`,
      `arms-900`) pass the check now.
    - *Blue science stays at ~5 chemical packs/min: a free crude field read as none (root cause).* `blue3-720` probes:
      the plastic and sulfur chemical plants and two engine assemblers sit at `full_output`; the 2 chemical-pack
      assemblers and both advanced-circuit assemblers always work, so those are the cap, not crude. The chemical-pack
      cluster can't grow in place ("blocked at 528,-117"), so the design plans parallel providers, and the next
      production goal (g141, minute ~821) asked for a second crude field. D62 holds production goals while a search
      builds or scans an outpost, so from minute 821 to 907 the faction planned only radar goals (g142-g163), 2000+
      tiles out. The search should never have started: the log line just before it reads `pumpjack field at -366,47:
      entities overlap at 4,9: pumpjack@5.5,8.5 and pipe@4.5,9.5`. A probe of the minute-900 save found the first
      field's 7 wells split in two fields (`FIELD_JOIN` 12): 3 taken, and 4 free at (-353,50) (-350,51) (-361,55)
      (-363,58), whose box (from y = 47) is clear of the first field. The generator faced every pumpjack north; the
      north output of the well at (-363,58) is the tile (-362,56) inside the pumpjack at (-361,55), so it laid a pipe
      there and threw, and `fieldModule` caught the error and returned "no field". Fixed at both ends:
      - `pumpjackField` gives each pumpjack the first facing (N, E, S, W) whose output tile is free and reaches the
        collector, from the prototype's own per-facing positions (2.0 pumpjack: (1,-1) facing N or E, (-1,1) facing S
        or W: not a rotation of the north one; `FluidBoxFacts` connections now carry `positions`). A well with no such
        facing is left out. T1 `fluid-chain` "M7c.8: a pumpjack whose north output lies in its neighbour faces another
        way" (these 4 wells; fails on the old generator).
      - `fieldModule` tries the fields in order of preference and skips one it can't lay out, instead of reading one
        failure as no field.
      - With every arm cut (see above), the search now ends (`EXPLORE (D62) over`) and B53's pause holds the failed
        kind for `factory-site-retry-minutes`; before, it waited in its outpost phase and held production for good.
      P50 (SPEC §11) is withdrawn as framed: the hold only mattered because a free field read as none.
      Resumed from minute 900 (`field-900`): the 4-well field was found at once, the search ended ("EXPLORE (D62)
      over: goal g161 planned after 12 radar outposts"), g161 (9 modules) was built by minute ~927 and g162 by 947;
      no stall. Then g164 and g165 failed 4 plans each "no room at its fixed spot: occupied at -366,47": each goal
      had two crude providers (n483, n484), and both picked the same free field, because `wellTaken` sees only
      pumpjacks on the ground. Wells of the layout's pumpjack-field modules (planned or built) and of the goal's
      earlier fields now count as taken (`oil.ts` `moduleWells`, passed to `fieldModule`). T2 `world` "M7c.8: wells of
      a planned field (not built yet) are taken too".
    - *Power goals of 123 steam blocks (the crude edge split the design into 1250 clusters).* At minute ~980 g164 had
      246 nodes (123 steam blocks `power#6` … `power#128`, each with its own coal outpost of 0.058/s, ~230 kW) and
      g165 490; power#7 failed 8 plans "no feasible position" and the run stopped. A design log (temporary, not
      committed) showed `clusters=512` and then `1250`, from `crude-oil*>plastic-bar>…~3=>…~2.in-crude-oil=
      new-producer-cluster: belt over capacity (54.4/s > 14.85/s usable)`. Two faults:
      - `checkEdges` held every edge to a yellow belt's capacity, crude oil too, though a fluid edge is a pipe (~1000/s
        within the pipeline extent, M7b.1). Fluid edges are now skipped there.
      - The edge's rate did not shrink with more clusters (a cluster 1 group fed by providers every cluster taps; it
        rose from 54 to 65/s), and each attempt multiplied the cluster count by ⌈rate / usable⌉ = 4: 2 → 8 → 32 → 128
        → 512. An edge whose rate did not fall since the previous attempt no longer splits (overflow note "more
        clusters do not split it").
      T1 `design` "M7c.9: a crude edge over a belt's capacity is a pipe …" (on the old code: `parallel-route × 2` on
      the crude edge) and "M7c.9: an edge more clusters do not shrink stops the split" (`checkEdges` is exported for it).
    - *A steam block whose nearest shore is built out failed instead of trying another lake.* Placement's site search
      finds the site point nearest the request's centre and searches windows of `searchRadii` (24/48/96) around it,
      then fails; seed 11's base lake was built out by six steam blocks, and power#7 failed "no feasible position" with
      other lakes in the region. A site target whose windows found no room is now remembered (`deadSites`), and the
      ring search goes on to the next site point outside the searched windows, up to `MAX_SITE_TARGETS` targets
      (`placement.ts`). Replay of the captured g164 plan: power#7 placed at 739,187. T1 `planner` "placement M7c.8: a
      steam block whose nearest shore is built out goes on to the next lake" (on the old code: "no feasible position").
    - *A tree inside a pumpjack ghost could never be cleared.* After the two fixes above the run reached minute 1080
      (`clus-960`), but g163 left one ghost for 10 rounds: "pumpjack at -363,58: cannot-place". tree-08-brown at
      -361.875,59.25 stands inside the 3×3 ghost, and its clear job failed "not-minable: a ghost or another entity covers
      the target": the ghost is selected at every point of the tree's selection box, and the crew refuse to mine a
      selected ghost (a player's mining would cancel it). A tree under a leftover ghost that was already cleared once
      now lifts the ghost until the new clear job ends, then puts it back with its direction, recipe and belt type, as
      a player would (`strategy/lifted.ts`, `FactoryGoal.lifted`). T2 `controller` "M7c.9: a tree inside a 3×3 ghost
      can't be mined; lifted, it is, and the ghost goes back with its settings". Also: a build's clear phase skipped a
      tree that already had an open clear job (another goal's) and so did not wait for it before placing ghosts; it now
      waits on that job (`runtime.ts` `queueClear`, like the growth path already did). Whether that is how this tree
      was missed in the first place is not confirmed (the goal was planned in the earlier run).
    - *Long crude lines into the base exhausted the pipe router's budget (g160/g161, "budget exhausted, 200000
      expansions").* Captured as `m7-seed11-g160-crude` (an ~870-tile line from the field at -346,57 to a plastic chain
      at 521,21). Where the work went: ~20 nodes per 16 tiles over the 600 tiles of open ground, then 1437 → 56069 per
      16-tile column from x 240 to 415, at the base edge; nearest 110 tiles from the goal. Two faults:
      - The coarse pass counted any tile an underground may pass under as traversable, so a band of belts wider than a
        pipe-to-ground span read as open. The corridor ran north of a module block into ground closed by such bands;
        open ground just south of it (row 26 straight into the goal's pocket) was outside the corridor. A tile only an
        underground passes now counts when its run of unplaceable tiles on an axis fits one span between placeable
        tiles (`pipe-router.ts` `crossable`); every tile a real route uses still qualifies, so a coarse "no path"
        stays sound.
      - The corridor search could take the whole budget before the search dropped the corridor. It now gets half
        (`PIPE_CORRIDOR_SHARE`), then the search goes on without it.
      Ablation on the replay: the budget share is what makes the plan succeed (without it the plan fails whatever else
      changes); the coarse fix alone does not, but saves 24% of route work (378219 against 498614). Before both: failed,
      839636 route work, 91 s replay; after: done, 378219, 46 s. T1 `pipe-router` "M7c.9 a band of belts wider than a
      span is no coarse passage" (3341 expansions; 112297 with the old coarse check) and `plan-replay`
      "m7-seed11-g160-crude".
      Also tried, not kept (on `proto/pipeline-segments`, local): a ten-fold budget (still running after an hour per
      replay); a wider corridor (`corridorCells` 2: still failed); a segment move laying several longest
      pipe-to-ground pairs as one expansion (the user's prefab-pipeline idea: no change on g160, ±10% work and no CPU
      gain on synthetic 800-tile lines, where the router already needs ~3300-4200 work); and a dominance check that
      also compares the segment's length toward the pipeline extent (frontier nodes in the base had 256+ of 312 tiles
      used; no effect on the outcome, 2% less route work without it).
    - *After the router fix (soak `route-900`, from the minute-900 save):* g160 planned on its first attempt (5159
      ticks, 11 modules, 17 routes) and was built by minute 988, the first crude line. Two more findings:
      - *A long build's clear phase read as a stall.* Its 21 clear jobs lay along ~2000 tiles of routes; two members
        cleared about 7 trees per 5 game-min, mostly walking (probe `probe-930`, `board.lua`). Only finished crafts and
        placements counted as steps, so at minute 941 the stall check fired, and its recovery failed every open
        non-place job, the clears too: the build then stamped its ghosts over the standing trees and a tapped belt
        ("1 ghosts could not be created: … splitter@422.5,-69", and later a pumpjack ghost over a tree that the M7c.9
        lift had to clear). A finished clear is now a step too (`jobs/crew.ts`). A clear phase that finishes nothing
        within the stall window is still a stall and still recovers. **Open:** clearing is walk-bound
        (nearest-first, two members), and ghosts wait for every clear of their build, not only the ones under them.
      - *Bigger batches and trips (user decision in-session, 2026-11-03).* The user asked to keep the batching logic
        and double its limits: `batch-max-jobs` 12 → 24 (place jobs from one standing spot; the reach stays the
        engine's build distance), `trip-max-jobs` 20 → 40 and `trip-radius` 16 → 32 tiles (clear and wood trips; the
        bootstrap's wood jobs are crew × `trip-max-jobs`, so they double too).
      - *Batch tours (user request in-session, 2026-11-03: "let them walk to more batching spots").* A place or fuel
        batch walks on to further standing spots (`planTour`, `jobs/board.ts`): the first spot is the unchanged
        batch; each next spot serves the nearest ready job of the kind within `batch-spot-hop` tiles of the last spot,
        up to `batch-max-spots` spots, while the whole load fits the inventory (`trip-inventory-fill` of the free
        stacks) and the jobs past the first spot stay within the member's share of the ready jobs of that kind
        (ready / live crew, minus the first spot's `batch-max-jobs`). T2 `jobs` "a batch tours a long belt line": 90
        belt ghosts from a stockpile at one end took 10 batches from one spot each, 4 with tours. T1 `board` "planTour".
      - *Prefetch kept materials from the other member.* With 24-job batches the M2 two-crew build failed its idle bar
        (crew 3 idle 40%): the first member's batch plus the D66 prefetch reserved the whole bill from a stockpile a few
        tiles away, and the second member found 16 ready jobs whose materials were all taken. D66 was for far sources
        (a 500-tile walk); prefetch now runs only when the source is at least `prefetch-min-distance` tiles away.
      - *A second crude field's box took in the first field.* g166/g167 failed 8 plans in a row ("no room at its
        fixed spot: structure at -442,-169"): the free wells north of a one-well field (pumpjack at -437.5,-164.5)
        formed one field whose box (wells + 2-tile margin) covered that pumpjack and two of its poles (probe
        `probe-oil`), and a fixed module only claims open ground. `layField` (`strategy/oil.ts`) now leaves out the well
        nearest each structure (any force, or a module of the layout) inside the box until the box is clear. T2
        `world` "M7c.9: wells next to a structure in the field's box are left out until the box is clear".
    - *The steam block on a curved shore seals a land pocket.* The offshore pump at 422.5,93.5 plugs the pocket's only
      exit; a member walking in is trapped (the pocket escape, 6e29576, picks up a steam engine to get out). **Open,
      not redesigned:** the steam block's placement should keep a walkable exit.
    - *A rerouted tap left the trunk's belt under its new splitter.* The coal line n32 → power plant read "0/s reach
      n1" for several repairs: reroutes g101 and g103 "cannot place splitter@574,-25.5" (and 418,-4.5), and only the
      next repair (g104) found the trunk's belt there as stale, picked it up and placed the splitter; by minute 645 the
      edge carried 1.6/s (probes `split-645`, `split2-645`). The splitters could always be placed: a reroute or growth
      diffs only the routes it rips and lays, and a tap laid on a trunk it leaves alone replaces that trunk's belt
      (`routeEntities`), so nothing picked the belt up and the ghost could not be created; a tap moved off a trunk left
      a gap where its old splitter stood. `bystanderDiff` (`build-list.ts`) adds the untouched routes' changes to both
      plans' diffs (`reroute.ts`, `grow.ts`). T1 `grow` "M7c.8: a tap rerouted onto a trunk that stays …" (on the old
      code: "left standing: transport-belt@54.5,30.5"). The older "cannot place splitter@508.5,-100" lines (g56,
      minute ~400) are the same case.
    - T2: a shard that creates more than ~60 factions ran out of forces ("Too many forces"). Near the limit
      (`STALE_FORCE_LIMIT`, 56) a new lab merges the forces of destroyed factions into neutral (`test/lab.ts`); only
      near it, because the engine frees a merged force at the end of the tick and the reconciler tests recreate
      `rec-1` in the same tick.
- Captured plan inputs run-length encode their terrain rows (`exportPlanInput` `rle`, read by `plan-replay.test.ts`):
  the two seed 11 captures went from 12.8 MB to 2.5 MB each. (The first, unencoded copy of `m7-seed11-sulfur` is in
  the branch history.)
- Harness: the probes' on-tick handler was replaced by the speed-up script's `on_event(on_tick)`; it now uses
  `on_nth_tick(60)`. New remotes `milestones()` and `design_debug(name, filter?)`.

Open (not changed): a module buffer chest takes 200 plates before downstream modules get any; outposts N2/N3/S2/S3 fail
with "no pole path"; crew time reached 0.86 ms/tick late in the 731-min run. Two oil modules on one fixed spot are
possible in the design (the `labs#2` case above) once the lock is released for any reason.

#### M7c.9 follow-up: production plans on a grown base at 27 ms a tick (the routers' self-crossing check)

The fresh seed 11 run (current build, `m7c-fresh`) went from ~1 ms of AI time a tick to 25–33 ms for every
production plan after game minute 226 (g51, g52, g54, g55: 5–8 modules, 9–14 connections, region radius 384). The
planner still did its 400 work units a tick; each unit had become far dearer. Adopted plans of that size were never
captured (the export cap was a 400-tile side, the regions are 768²), so:
- **Slow-plan capture:** in soaks a plan still planning after a game-minute writes its input to `plans/slow/`
  (`SLOW_PLAN_TICKS`), and adopted plans are captured up to a 3,000-tile side like failed ones. The minute-180 save
  replayed with this build reached g51 at the same tick (809790 for the g50 growth before it) and captured it
  (`mod/unit/fixtures/m7-seed11-g51-slow.lua`).
- **Profile:** the replay, run with a new sampling profiler (`REPLAY_PROFILE=1` in `plan-replay`: a Lua count hook),
  spent 6.9M work units (6.3M routing, 158 searches, 18 rip-ups) in 179 s, 55% of it in the belt router's
  `heldBy`. That M7c.8 check walks up to 24 ancestors of the state for every move an expansion tries (3 belt moves
  plus 2 per underground length), about 240 steps an expansion.
- **Fix:** the ancestors' tiles are marked once per expansion in a scratch table under a stamp, and each move is one
  lookup (`router.ts` and `pipe-router.ts` `markHeld`). The search is unchanged: the replay makes the same 158
  searches and the same work in 101 s (−44%). The scratch table is not in `storage`; a stamp is only compared within
  one expansion.
- **Still open:** g51 itself fails (its copper feed's goal tile is sealed in by own ground), and the remaining cost is
  spread over the search (the A* loop, heap, seal check and underground spans each under 10%). A soak on the new build
  will show the in-game figure.

#### M7c.9 follow-up 2: the router's work units, and a dry mine's sealed fuel taps (seed 11 g73–g79)

The continued seed 11 soak (`m7c-cont`, from the fresh run's minute-300 save on the `markHeld` build) ran at ~0.6 ms of
AI time a tick until game minute 333, then at 21–27 ms for over an hour of game time. Production goals g73–g79 each
planned for minutes and failed the same way: coal for three iron smelter columns' fuel ports, "no path". The slow-plan
capture kept g78 (`mod/unit/fixtures/m7-seed11-g78-slow.lua`).
- **The budget's unit was wrong for the router.** The planner's 400 units a tick assume ~4–5 µs a unit (placement
  runs at ~4 µs in T1). The belt router counted one unit per expansion, but an expansion tries three turns and one move
  per underground length, each with its seal and span checks: 15 µs a unit for g51, ~30 µs for g78 in T1 (longer
  undergrounds by then), ~65 µs in game. The profile had no hotspot left: the cost is spread over the search.
  **Fix:** each move an expansion (or a seal step) tries adds half a unit (`router.ts` `ROUTER_MOVE_WORK`). All 36
  replays end as before; routing now runs at ~3–4 µs a unit in T1, so a slow plan takes longer in ticks rather than
  more time a tick. The pipe router still counts one unit per expansion (open: its searches are also capped in work
  units, so re-weighting it shrinks them; no soak has shown it slow).
- **Why every plan failed.** Coal mine n38 (dry, retiring under D76) fed the three columns through a tree of splitter
  taps; the last taps run between two 24-furnace columns, sealed in by the base. Every replacement merge (B79 turns a
  plain connection into a fed port into one) targeted those tap belts, and the seal check proved each enclosed. The
  nearest free coal is 530–600 tiles away (g70 had already found none nearer after 6 outposts).
  **Fix:** `mergeGoals` also offers the trunk above each tap's splitter, up to 8 taps up; `routesLand` and
  `checkLayout` accept a merge whose trunk reaches the port through its taps (`layout.ts` `routeFeedsPort`). T1 `merge`
  pins it. The g78 replay now feeds labs~6 through the trunk; the labs' own feed, from a mine 530 tiles west, is still
  sealed off, cheaply (0 expansions).
- **Design:** when a retiring provider's replacement group is split into one provider per consumer (B61), each kept the
  D76 merge into the old belt only by accident (B79 in the planner). The split now passes `mergePorts` on (T1 `design`).
- **Still open:** a base with no coal within ~500 tiles. Retrying placements far away is the only remedy the factory has
  now; electric smelting (or solar, D82 c) would remove the fuel need.
- **In game (`m7c-cont2`, the same save on `dd4ebaf`):** the planner took 17–25 s of AI time per game minute while g78
  planned (5–7 ms a tick), against 76–103 s on the old build: about 4× less. Every planner unit costs about the same in
  the game now, ~17 µs: radar goal g64 (placement and poles only, no routing) used 232k units and 4.0 s of planner time
  in its minute. T1's Lua runs the same code ~4× faster, so the T1 calibration (~4 µs) understates the game's cost. At
  full use the 400-unit budget (`planner-work-per-tick`, D58: "estimated 2–3 ms; not yet measured") costs ~7 ms a tick.
  **Open (proposed, the user decides):** the default stays 400. 150 would give the D58 estimate (~2.5 ms) at the cost
  of plans taking ~2.7× more game time.

#### M7c.9 follow-up 3: undergrounds under modules, and merging onto a replacement's belt (B121, B122)

On the faster planner the same goal still failed, now in about 10 game minutes per attempt: g78 attempts 1–3 in
`m7c-cont2`, "no path" to the fuel ports of three iron smelter columns (labs, labs~5, labs~6). Red and green research
was finished, and stage 3 (blue) waits for every stage-2 goal to be planned and built (`advanceGoals`). So the factory
idled on the throughput-test sink, and robotics, the M7c goal, was out of reach. The capture of attempt 3 is replay
`m7-seed11-g78-a3`.

- **Why (B121).** The dry mine n38 sits in the middle of the base, and its splitter tree fed nine fuel ports. Each
  port's merge goals lay in pockets of 330–680 tiles, closed by belt bundles 5–8 wide and by modules. A seal flood dump
  showed the pockets' edges were mostly built belts, which an underground can cross. But the router never put an
  underground under a module (`underModules: false`, from M4b), and with 7- and 9-tile undergrounds the pockets stayed
  closed too. With undergrounds under modules, yellow ones routed 2 of the 3 feeds and fast ones all 3. In Factorio an
  underground passes under anything. It only goes wrong next to another underground of its own kind on the same line,
  which could take its pair. Generated modules have no belt undergrounds; the three curated ones do, and so do the
  chemistry rows and the oil complex (pipe-to-ground).
  **Fix:** an underground may pass under a module that has no undergrounds of its own kind: belt undergrounds for
  belts, pipe-to-ground for the pipe router, including the module's growth unit (`router.ts` `underPassable`,
  `moduleHasUndergrounds`). `underModules: true` still opens every module. T1 `planner` "B121".
- **Then (B122).** With the base open, the three replacement mines (one per column, B61) each needed their own way in:
  the first one's belt blocked the others. That took 6 rip-ups and ~57M work units, and two feeds still failed. But
  the first belt already merges into the tree above the other two's taps, so it carries coal to them too.
  **Fix:** `mergeGoals` also offers the belts of routes that merge into a candidate trunk above the point where it
  serves the port, following chains of such merges. `routeFeedsPort` follows merges, so the layout check accepts the
  target. The attempt-3 replay now plans in 5 searches and ~0.6M work units, all three feeds routed (it failed after 77
  searches and ~4M before). T1 `merge` "B122".
- **Still open:** the design splits the replacement into one mine per consumer after early failures (B61). One mine
  merging into the tree would serve all of them; B122 gets most of that benefit in the planner.

#### M7c.9 follow-up 4: tunnel crossings (user request, 2026-11-03)

The user asked for this in-session: when one belt blocks part of a new route, turn just the blocking section into an
underground, so the other belt can pass there, instead of ripping up the whole belt or module. The motivating case was
seed 11 g91 attempt 1: the engine row's pipe input was "blocked by" the iron-plate belt after 3 rip-ups (attempt 2
planned, but only after 8 rip-ups and ~56,000 ticks of planning).

- **What it does.** The router has a new move, a *tunnel cross*: from tile P0 it crosses an adjacent tile T that
  another route occupies and lands on T2, with a belt on both P0 and T, at an extra cost (`RouterWeights.tunnel`, 12;
  a route's own underground pair is 8, so that is preferred where it fits). When the plan commits the route, the
  crossed route's steps i−1, i, i+1 (around T) become an underground entrance, the freed tile, and an exit. The crossed
  route keeps its path, items and tier; only its three tiles are rebuilt (`planner/tunnel.ts`).
- **Why a new move.** The route's own underground pair could already hop a straight crossing. A tunnel helps where it
  can't: an underground end is never a curve, so a route that must turn right before or right after the crossed belt
  (in a gap between modules, or onto a port) had no way across a *fixed* belt. Every built route is fixed under a plan
  on the faction's base, and a plan never rips it.
- **Edge cases handled** (each a reason `tunnelSite` refuses a site):
  - only a straight perpendicular crossing. The crossed run must be four straight steps (i−2..i+1) plus a fifth to
    output into: i−1, i, i+1 plain belts, i−2 a belt or an underground exit. So a port's tile or lane (the router
    reserves two tiles at each end), a curve, a splitter or an existing underground end is never rebuilt;
  - no route side-loads or merge-splits onto i−2..i+2, and no tap splitter stands there: an underground end changes what
    a side-load or a splitter does;
  - no reserved or otherwise occupied tile under the new pair, and no underground of another route on the same line
    over the new span (it could take the new pair's end);
  - not a pipe, not an external route, not the crossing route itself, and not a route another goal is still building
    (`PlanRequest.busyRoutes`, filled by the factory from building goals' plan parts and growth/rework entities: their
    ghosts are already out);
  - two tunnels on one route sit at least 3 steps apart; a later one may use the new exit as its feed;
  - span 2 (one freed tile) fits every belt tier, and there is no tunnel before underground belts are researched (the
    request's tier has no undergrounds then);
  - the seal check (the flood that proves "no path") follows tunnel crosses in both directions, so it never seals off a
    goal a tunnel could reach.
- **Building it.** The plan changes the crossed route in its own copy of the layout. `preparePlanDelta` reports every
  base route that gained tunnels in `delta.reworked`, as the diff of that route's own entities: three belts to pick up,
  two underground ends to place. Adoption queues the belts for clearing (as for a mine completion) and adds the
  undergrounds to the build after the clear phase. Growth and reroute builds already diff bystander routes, so a tunnel
  made there is rebuilt the same way.
- **Tests.** T1 `tunnel`, five tests:
  - a crossing that turns on both sides works only through a tunnel, and the layout, claim and index checks stay clean;
  - with the option off, a busy route or no undergrounds, it fails;
  - the accepted sites along a run (ends, side-loads, next to an existing tunnel);
  - the plan delta: exactly 3 belts out and 2 undergrounds in, and the crossed route is not re-added.

  The whole T1 suite passes, with replay times unchanged.
- **Not yet in game.** The running seed 11 soak (`m7c-cont3`) uses the build from before this change; the next soak is
  the first to show tunnels in a real base.
- **Limitations.**
  - One freed tile per crossing. A route crossing two parallel belts side by side would need two tunnels, but tunnels
    must be 3 steps apart, so it can't cross them that way.
  - No pipe crossings.
  - If the reconciler repairs the crossed route while its rebuild is in progress, both place the same entities, which
    is harmless.

#### M7c.9 follow-up 5: a module's belts must be able to leave together (seed 11 g104)

In `m7c-cont3` the blue-pack plan (g104: the chemical-science row, its advanced-circuit row, the plastic and sulfur
chains, a copper mine) planned for 42+ game minutes at the full planner budget. Chemical science was researched, so
robotics waited on it. Replay `m7-seed11-g104-slow` (the slow-plan capture) reproduced it: 51M work units, 103
searches, 13 rip-ups, 2 re-placements, all to plan successfully in the end.

- **Why.** Logging every search showed 92% of the work on four belts of the new row: its sulfur, advanced-circuit and
  engine-unit inputs and its pack output. They ripped each other up in a fixed cycle (the pack output ripped the
  circuit belt, engine units ripped the pack output, sulfur ripped engine units, circuits ripped sulfur), round after
  round. Each rip-up search cost 3.5–5.2M units, and the rounds were identical until the rip-up limit moved the row,
  twice. The inputs come from 150–350 tiles west and south-west, through a gap only three belts wide. Placement
  checked each port's lane on its own, and each could leave, so it accepted the spot.
- **Fix (root cause).** The placement search checks that all of the chosen spot's belt ports can leave *together*:
  a max-flow over tiles, each carrying at most one belt, from the ports' lane starts out of a box `portEgress` tiles
  around the module, or to within a tile of a connection's target. Undergrounds hop walls, as in the lane checks
  (`planner/egress.ts`). It runs only on the final best spot, in budgeted steps (the flow is plain data, resumable
  like the other searches). A spot that fails is marked crowded, and the radius is scanned again without spots
  overlapping it. After `EGRESS_RETRIES` crowded spots the best is taken unchecked, so placement never fails on it.
  - **Its ground** is what the router may use: anything but hard tiles and the candidate's own footprint. The first
    version used the lane checks' ground, which also excludes modules' margin rings. In a compact cluster those rings
    are the corridors belts run in, so the seed 11 production replay went from 0 rip-ups to failing with 17. With the
    router's ground it is back to 0.
  - **The box size matters.** At 10 and 25 tiles g104 is unchanged (the gap is farther out); at 50 the row goes
    where its belts fit: 2.8M work units, 17 searches, no rip-ups, no re-placements (15 s instead of 208 s in T1).
- **Safety net: rip-up loops.** A connection that would rip up the same route a second time (since the last
  re-placement) moves one of its modules at once rather than going round to the rip-up limit. If neither module can
  move, ripping goes on up to the limit as before, so no plan fails earlier than it did (`router.ripLoop`). Alone it
  takes g104 from 51M to 35M work units.
- **Results (T1, every replay).** Outcomes are unchanged except two that now plan: g104 and g107 (which failed on an
  ordinary rip-up limit). The old g51 capture drops from 21.5M to 12.7M work units (15 → 4 rip-ups), seed 3333's
  production replay from 9 to 5 rip-ups. Small compact plans spend 10–40% more on placement (the check itself), a few
  thousand to ~500k units. The replays shared with the previous run fall from 49.4M to 45.2M units in total, and g104
  from 51M to 2.8M. T1 `egress` (6 tests: disjoint corridors, a shared gap, the reverse step that reroutes an earlier
  path, underground hops, targets, stepping), and `plan-replay` g104 and g107.
- **Not done: a cheaper rip-up search.** A rip-up search that starts from the side the cheap "no path" check proved
  walled in would avoid flooding the whole 9× window (the 3.5–5.2M per search above). With the egress check g104 needs
  no rip-ups, so nothing here measures it. It needs the router to search backward from the goal, a larger change,
  so it is left as a proposal.
- **Not yet in game.** The running soak uses the build before this change.

#### M7c.9 follow-up 6: large plans route the same belts again (seed 11 g108, g90, g91)

After g104 the slowest captured plan was g108, the second blue line that `m7c-cont4` was planning (30.2M work units,
failed). A per-search trace (`REPLAY_SEARCHES=1`, with `REPLAY_ADHOC=<capture paths>` for captures outside the fixtures)
showed where it goes. Most of it is not finding routes but finding the same routes again:

- **52%: one 400-tile coal tap routed three times.** The new coal mine's belt to the base's logistic-pack smelters is a
  splitter tap on the coal trunk to the copper-plate smelter. That smelter moved twice. Each move ripped the trunk, and
  with it every tap, so the 400-tile belt was searched from scratch (~5M each round).
- **~6M: the narrow window first, every round.** The coal tap needs the 3× window. Each round's window-1 search failed
  first: its corridor search failed, then the whole window was searched to exhaustion (~2M). The retry after it proved
  the same "no path" with the uncapped seal check in ~16k.
- **The rest:** the circuit cluster's modules each moved twice, and every move re-routes every belt touching them.
  g90 and g91a2 show the same pattern (one belt routed 30 times in g91a2).

Three changes, which the user asked for in-session (2026-11-03). A fourth, moving modules less often or keeping more belts when one moves, is left open:

- **A tap keeps its belt when its trunk's consumer moves** (`layout.ts` `rerootTap`). The longest tap not ending at
  the moving module takes over the trunk's steps up to its splitter and becomes the route from the trunk's source. The
  splitter stays, with its trunk-side output left dead (that tile stays reserved and empty), so the splitter sends
  everything to the tap and no built entity of the kept part changes. Taps on the kept part hang off it; the trunk's
  tail goes with its other taps as before. The trunk's connection is then routed again as a short tap of the re-rooted
  route. Only a re-placement does this (a rip-up victim gives up its tiles, possibly the kept ones).
- **Each connection remembers the window, and rip mode, it was last found with** (`PlanJob.winMemo`, `ripMemo`). Routed
  again, it starts there; the ladder still widens from it. A first version started in non-rip mode at the remembered
  window: g91a2 then got worse (15.4M → 18.1M), because two belts that were only ever found by a rip search failed a
  ~420k non-rip search first each round. Running the uncapped seal check for remembered windows fixed g91a2 but cost
  g108 ~500k per successful 9× search (the floods run until they meet), so the rip mode is remembered instead.
- **A failed corridor search runs the uncapped seal check before searching the whole window** (`router.ts`
  `sealFull`). When that check proves "no path", the search fails at once; when the two floods meet, the window search
  runs as before.

No new tuning numbers. Results (T1 replays): g108 30.2M → 16.5M work units (routing 27.5M → 14.0M; 240 → 156
searches), g91a2 15.4M → 12.0M, g90 and g91a1 unchanged (no re-rooting chance, no remembered windows that help), g83
and g105 unchanged; the fixture replays fall from 45.2M to 42.6M units in total. Every outcome is unchanged: g108 still fails on the circuit cluster's rip-up limit. T1
`planner` "re-root" pins the re-root: the same entities minus the trunk's tail, the dead output reserved, layout checks
clean, and the trunk's connection routes again as a tap of the re-rooted route.

#### M7c.9 follow-up 7: a merge's next goal reuses the failed search (seed 11 g111)

The resumed soak (`m7c-cont5`, from minute 600 on the follow-up 6 build) stopped again at game minute 615. g111 (24
modules, the labs#2 supply) planned for ~13 game-minutes and placed nothing, so the run's second stall triggered the
fail-fast stop. Its replay costs 37.4M work units and fails. Most of the cost is coal joins (provider-group merges)
from new coal mines up to 550 tiles out into base smelters' fuel lines. Each tries up to 24 merge goals, one search
each. Most fail in a few thousand units, but some each exhaust a ~200×560 window (2–5M units): the seal check's two
floods meet there, though no route exists (it does not model the rule that a belt may not cross its own path).

- **Tried and reverted: one search for all goals.** It took the cheapest goal, which can be a side-load where the
  user's P44 rule prefers a splitter (T1 P44 and B91 failed), and on g111 it routed a merge that used to fail, which
  then ripped another merge in turn up to the rip-up limit (61M units).
- **Done: reuse the failed search** (the user asked for this in-session, 2026-11-03). A search's costs from the start do
  not depend on the goal, so a search that ran out of states has reached everything reachable in its window: the next
  goal was either reached (its route is known) or cannot be. `router.ts` `retargetSearch` points the search at the next
  goal and keeps its tree, reopening only the old goal tile's states (a splitter merge's goal is a free tile the search
  never expanded). The goals are still tried in their order, so P44 holds. "No path" carries over only when the new
  goal's own window lies inside the searched one. To make that hold, all of a merge's searches now share one window
  over every goal (`router.mergeReuse`, on in `early-compact`); each goal's window then contains the one it had alone,
  so no route is lost.
- **Results (T1).** g111 37.4M → 27.5M work units; it still fails (see below). Its iron-plate coal join now succeeds at
  goal 3 instead of 16. The g78 capture, which failed, now plans (its labs' own feed finds a goal in the shared window;
  the test expectation is updated). Fixture totals 42.6M → 43.0M (g78-a3 +0.4M, g51 +0.5M from the wider windows).
  No new tuning numbers.
- **Why g111 still fails**: (1) the new coal mine for the
  copper-plate logistic smelter's fuel is 550 tiles north, and every merge goal on that smelter's fuel line is sealed in
  by trees, its port reservation and built belts; (2) the copper-ore belt to the new copper smelter in the circuit
  cluster loses a rip-up contest with the steel smelter's ore belt after both of its re-placements.

#### M7c.9 follow-up 8: a retiring mine's heirs get one replacement; tiny top-ups get none (seed 11 g111)

The user asked for options B and C in-session (2026-11-03). g111's eight new coal mines (n271–n278) were one per
consumer. Four fed the new blue-line modules. The other four were merge top-ups (0.17, 0.14, 0.10 and 0.004 coal/s)
into the fuel lines of base smelters. Those lines are a tap tree fed by n38, a 4-drill coal mine that has been
retiring (worked out, 25 % depleted) since `m7c-fresh`. D76 put the consumers n38 still feeds into the same design
group as the new consumers (`coal*>steel-plate>…labs#2`). In g108, that one group could not be reached from one site,
because the blue line lies ~500 tiles from the base. The factory then split it per consumer, and each base smelter got
its own mine and its own long merge belt.

- **B (design, `expandShared`).** The consumers a retiring provider still feeds now form their own replacement group,
  one per retiring provider. It goes under a parallel role of the retiring one (`coal*>…labs#2~N`), with merge edges
  and a site of its own. New consumers are never mixed into it. The tap tree is compact, so one site can reach it. If
  even that group fails from one site, the existing `providerSplit` rule still splits it per consumer.
- **C (`factory-min-top-up`, proposed 0.05/s).** A merge edge below this rate gets no provider: a short provider's
  residual (B60) or a retiring provider's replacement (D76). For a retiring provider, such a consumer is planned again
  after the old mine is removed (its edge goes with the mine's routes).
- **B (planner).** A heir mine's merges into one tap tree need only one join, if it lands above the other ports' taps:
  - **Covered connections:** a merge connection whose own source already has a route that lands at its port gets no
    belt of its own (`PlanJob.covered`). `layout.ts` `landsDownstream` / `pointFeeds` check this by position: a join
    feeds the joined route's end, plus only the taps at or after the join. Its graph edge rides on that route
    (`plan-delta` `routesByConn`). If the covering route is ripped later, the connection routes again.
  - **Goal order:** `mergeGoals` takes a score (how many sibling ports a join there also feeds) and puts scoring points
    first, in up to half the slots. P44's order holds within each kind.
  - **Deferral:** a merge whose goals all fail waits once behind a queued sibling before rip mode.
- **B (design, again).** A heir whose port took no merge (`noMerge`, learned from a failed plan) gets no replacement. It
  keeps the retiring provider's belt until that provider is gone, then it is fed again like any consumer.
- **Soak `m7c-cont6`** (from minute 600, on the design part of B and C only) stopped at the same g111 stall. Its new
  design had 21 modules, not 24. The three base heirs (n34, n178, n36) shared one mine, n181's 0.004/s was dropped, and
  the blue line kept its four mines. Its replay costs 26.3M work units and fails on the same two connections:
  - **n36's fuel:** n36's fuel line taps the tree's root route 3 tiles from the old mine. The only join above that tap
    lies in those first tiles, and they have no free side. n36's own line is sealed in by the base. The next attempt
    learns `noMerge` for that port, and the design part above then leaves n36 on n38's belt.
  - **The circuit cluster's copper ore** (option D, not done).
- **Not done:** growing the retiring mine instead of replacing it. n38 is retiring because its patch has no ore left
  in its growth area.
- T1: new design tests (`M7 B` ×2, `M7 C`) and a planner test (`M7 B`, one join covers a tap). The g78 split test now
  names the heir group's role.

#### M7c.9 follow-up 9: g113 plans, then is torn down over one ghost (B123)

Soak `m7c-cont8` (fail-fast off, from minute 600) went on past the g111 stall:
- **g111** failed: the circuit cluster's copper-ore mine could not route; the factory split it and gave it a site.
- **g112** failed: the circuit and copper-cable belts into the advanced-circuit assembler ripped each other up.
- **g113 planned:** 22 modules and 27 routes, in 13.6M work units with 1 rip-up (g111 had cost 26–37M). It built 1196
  entities.

Then one underground-belt entrance could never be placed. After 10 rounds the goal gave up its location and 5653 built
entities were deconstructed. The cause is a turned cliff box the terrain scan read unturned (B123). The user asked
in-session (2026-11-04) for both fixes:
- **Scan:** turned boxes cover the tiles they really reach.
- **Recovery:** a build stuck only on route pieces reroutes those routes around the failing tiles before it gives up
  its location.

No new tuning numbers.

#### M7c.9 follow-up 10: the base jams on stranded items (B124)

The user asked for a labeled map render once blue packs start. They had not started by minute 770 of `m7c-cont9`, and
the graph dumps showed why: since about minute 610 the whole base made ~1 iron plate/s and no copper plates. The cause
is not g113. Probes of `min-0720` found stranded foreign items:
- iron ore on a copper smelter's coal lane;
- iron plates on a coal trunk lane;
- iron plates on an iron smelter's ore belt.

None of them had a source upstream, so they were left over from rebuilds. No inserter takes such an item off its
lane, so each lane stopped for good, and the stall spread through the shared trunks. Every repair said "nothing
missing".

Fix (B124), in two parts:
- **Diagnosis:** the reconciler had called these edges "intake-limited", which proposes no remedy: the port was full
  but 0/s went in. A starved consumer whose full port takes in fewer than `LOST_MIN_ITEMS` items per probe is now a
  stopped lane, and it gets a repair.
- **Repair:** the repair's clog check also picks up and re-places (empties) the belts that hold a foreign item.

The resumed soak (`m7c-cont10`) then emptied the same 65 coal belts three times, and they filled with iron plates again.
The source was a merge splitter. It joins an extra iron-plate provider onto the mall's iron trunk, and its branch-side
output faced a coal route. Merge splitters now get their item as filter and the trunk side as output priority, so
nothing leaves through the branch side (B125).

No new tuning numbers.

#### M7c.9 follow-up 11: false remedies and a dead merge outlet (B128-B130)

Found while soaking seed 11 from fresh (`m7s11a`, branch `m7-soak-fixes` on `615f8b7`):

- **B128 (a trickle is not a stopped lane).** The first blue line's lab port (`n2 in-chemical-science-pack`) was full
  while 0.1/s went in: the labs used packs faster than the provider made them. B124's `LOST_MIN_ITEMS` test called that
  "stopped" and spent an unclog repair that found nothing, repeatedly. Only zero arrivals now means the lane is held.
  T1 `reconcile` "B128".
- **B129 (a dead merge outlet gets no filter).** B125 filtered a merge splitter to its trunk side, so every item that was
  not the route's item left through the branch-side output. The planner never builds a belt there, so coal stuck in the
  splitter for good. A dead outlet must back up instead, which sends everything down the trunk. The filter is set only
  when a belt stands on the branch-side outlet, and a stale filter is cleared. T2 `conflicts` "B129".
- **B130 (a new feeder under construction).** Seed 11 minutes 100-110: n17's fifth copper-ore mine was still building,
  so `builtFor` returned undefined on every evaluation and the smelter stayed `unknown / warming up` for 70 game-min.
  Its four built mines backed up behind it with no status and no remedy. Only built feeders set the warm-up age now; an
  unbuilt one is ignored when the consumer already has a built feeder. T1 `reconcile` "B130".
- **B131 (a probe from before a status change).** Seed 11 minute 60: n22's iron tap was probed at 0/s just before its
  smelter began producing, and the reconciler repaired the intact tap twice on that sample. A probe is only usable when
  it is newer than the last status change of both ends; otherwise it is measured again before acting. T1 `reconcile`
  "B131".

No new tuning numbers. Validation: `m7s11a`/`m7s11b` (seed 11) and `m7s222a`/`m7s222b` (seed 222) on the fixed build.

#### M7c.9 follow-up 12: a masked feed, a bogus tap and a building module's output (B132-B134)

Found in `m7s11b` (seed 11, fresh, minutes 180-330):

- **B132 (a tap must start on its parent).** n25's tap to n22 had its steps reversed by a re-root: its first splitter was
  on another route and its last splitter was on the parent. `tapsReach` still followed it to n22, so the repair found
  "nothing missing". A tap now counts only when its first splitter is on a parent tile; `feedsDirect` uses the same rule.
  T1 `merge` "B132".
- **B133 (do not mask a blocked feed with an undersized one).** n22's iron came through four merged feeds. The trace took
  the first feed's "producer undersized" cause (n15, already flat out and unable to grow) and returned, so the backed-up
  smelters feeding the same port were never repaired. Physical blockages are now checked across every feed before any
  grow cause. T1 `reconcile` "B133".
- **B134 (a building module's output is a supply point).** The blue line's steel smelter stood and ran, but its module was
  still `building`, so `moduleFurnaces`/`moduleAssemblers` did not register its output. The same plan's pumpjack craft
  waited 44 game-min for 5 steel plates, so the oil field (and blue science) never started. A module being built is now a
  supply point for its furnace/assembler output too (unconditionally; the furnace setting still governs completed
  modules). T2 `bootstrap-sources` "B134".
- **B135 (a placed module is built before the whole plan).** A plan's modules become `built` only when the whole plan
  finishes, so the steel smelter was invisible to the reconciler while the pumpjack in the same plan waited for its
  steel. When a placement completes, a module with no still-valid ghost left in its rect is now marked built, even if
  another module's place job is still open. T1 `goal-lifecycle` "B135".

B135 was refined after `val11b141`: the check runs on every build think (a module can become usable between two
placements) and requires only the module's machines, not every internal belt/pole/buffer. On `val11b142` (from minute
360) n167 became `built` and visible to the reconciler for the first time; it is now starved by the retiring n37, which
is the open B141. No new tuning numbers. Validation: `val11blue5` and `val11b142` resumed from `m7s11b` on the fixed
build; full T2 193/193 on the B140 build, targeted factory/reconciler 31/31 after the B135 refinement.

#### M7c.9 follow-up 13: failed ghosts and pruned jobs (B138, B139)

Random-seed soaks (`m7r44444`, `m7r555555`, `m7r1212121`) exposed two structural bookkeeping bugs:

- **B138 (a failed ghost must not be a silent success).** Goal g16 logged `cannot place 2` route belts and then reported
  `grew`: `applyDiff` only logged failed ghosts, and the completion check looked only at created ghosts/jobs. A growth
  now retries the failed specs on the build-round cadence and abandons the growth (B20) after `build-stuck-rounds`; a
  plan build stays in its clear phase and the factory goal relocates after the same rounds.
- **B139 (active goals keep their job records).** `pruneBoard` deleted done/failed jobs after 1800 ticks even when an
  active goal’s build/grow lists still referenced them, producing hundreds of false `build-job-missing` invariants and
  stopping `placed` from advancing on long builds. Jobs referenced by a planning/building goal are now kept.

T2 itself was also made cheaper: one shard per core (445 s → 162 s solo) and a statistical steady-state tolerance for
low-rate lab modules (the two engine tests 147/120 s → ~19 s each). Full T2 193/193.

#### M7c.9 follow-up 14: a shared consumer port is one repair (B140)

Seed 11 n22 had four iron feeds into one port. The edge probe samples the consumer port, so every feed reported the
same total; a backed-up feed was repaired and `checkBuild` found "nothing missing" while the port received 0.9/s of
3.65/s planned. The reconciler now detects that shape and proposes one `shared:<node>:<item>` group repair; the repair
reroutes the whole merge tree in place once (B88). `val11b140` (from `m7s11b` minute 360) rerouted 12 routes
(233 pickups, 186 builds); n22 went from starved to `ok 0.283/0.275/s` and n25 from backed-up to `ok 1.23/0.978/s`.
T1 `reconcile` "B140".

#### M7c.9 follow-up 15: retried ghosts and a cliff inside an oil field (B142)

`m7r1212121c` (seed 1212121, minutes 600-660) failed two ways at once:

- Goal g109 was abandoned as `BUILD STUCK` with `1149 ghosts could not be created`. B138's retry re-stamped the whole
  plan; `stampModule`/`createSpec` returned nil on every ghost that already stood, so one real failure looked like 1149.
  Ghost stamping now reuses an existing ghost. A failed ghost owned by a module whose machines already stand (B135) is
  ignored too: one missing internal belt must not abandon a plan, and the reconciler can repair the edge it feeds.
- g111/g112 failed every attempt at `no room at its fixed spot: blocked (terrain cliff) at 570,-739`. `fieldModule`
  rejected wells whose own 3×3 touched a cliff, but a cliff between wells still fell inside the fixed module box. Cliff
  and water tiles inside the box now drop the nearest well, like a structure already does.

`val1212fix3` (from minute 660): g109 built instead of being abandoned, and g111 plans instead of failing immediately.
A follow-up makes route-only ghost failures reroute those routes around the failing tiles (B123) rather than abandon
the plan; `StampResult` now carries the failed specs. T2 `bootstrap-sources` "B142". `val1212fix4` shows the limit of
that recovery: every reroute of the iron-ore route to labs~7 fails `no path` because the plan's own placement seals the
lane (B144, open). The goal still builds 280 entities and then relocates. A `min-0660` probe found the exact blocker at
`346.5,47.5`: an underground-belt ghost over an **orphan transport-belt ghost** (unit 33568); `route_debug("1",346,47)`
returns `{}`, so no current layout route owns it and the planner's claims never saw it. At `520.5,-161.5` the tile is
buildable and `route_debug` is empty too: the plan job is not adopted, so the conflict is **inside the plan's own add
list** (one piece's belt ghost created before another piece wants the same tile). The proposed fix is a two-phase stamp (ghosts first, no
place jobs until they all stand) plus blocker-directed local rip and a bad-tile ledger; global rip mode stays off.
`m7r555555c` hit the same class in a grow (two underground-belt ghosts at `-42.5,423.5..424.5`, 19 stalls).

#### M7c.9 follow-up 16: seed 44444’s blue line has a design edge the graph never got (B143)

`m7r44444c` ran the full 960 game-min and finished with 28.8 red / 36.0 green / **0 chemical** packs per minute. The
blue line’s iron smelter n43 is `starved`, cause `external: no producer`, while the iron mine n16 is `backed-up` with
`nothing takes its output`. A `design_debug("1","iron-ore")` probe of `min-0900` shows the design *does* have the edge
`iron-ore*>iron-plate>automation-science-pack>labs~2 => iron-plate>logistic-science-pack>labs.in-ore` at 3.63/s, but the
live graph has no corresponding edge. The factory is busy building g80, a huge production plan (27k+ queued jobs, about
30 ms/tick in the run), planned before that demand appeared; a long-running build blocks planning the missing feed.
Power is short at the same time: power#3 growth is blocked at 435,-50, and the next power block finds no shore site
(B137). Fix direction for B143: allow a critical missing feed to be planned while another large build runs, or split
huge production goals into smaller ones.

**Still open after these fixes (seed 11, `m7s11b`/`val11b141`, minutes 180-390).** The blue line still waits on
its pumpjack craft because the steel smelter n167 taps n47, whose iron mine n37 is depleted and retiring. The retiring
provider's replacement group does not include n167, a consumer added in an unbuilt plan (B141, open). B135 makes a
fully placed module visible (n171 did become visible), but n167 still has ghosts. The power layer also defers repeated
`power#5: no shore site in the region` goals (B137, open). Neither is a tuning issue.

#### M7c.9 follow-up 17: review of the bugfix branch at its merge (B150)

`m7-soak-fixes` (B128-B144) was merged into the M7d.5 branch on 2026-11-05. The M7d.5 branch's own bugs, which had
taken the same numbers, are now B145-B149. A review of every fix kept all of them but two parts:

- **B135 marked modules built too early.** It ran in the clear phase, before the plan's ghosts exist, so every module of
  a plan still clearing (or retrying a failed stamp) read as placed. It now runs only in the place phase and needs all of
  the module's own entities placed, not only its machines (a smelter whose furnaces stand but whose inserters are still
  ghosts would draw reconciler remedies).
- **B142's "failed ghost of a built module" exit built nothing.** It set the plan's phase to `place` from the factory
  goal, which skipped the runtime's place-job creation, so the plan could finish with all its ghosts unbuilt. Together
  with the B135 defect any failed stamp took this exit. Removed: those failures go back to B138's retry, B142's route
  reroute and then relocation. `val1212fix3`'s "g109 built" result likely came from this path and should be re-checked.
- **B142's ghost reuse** now needs the ghost to face the spec's direction, so an orphan ghost (B144) is not adopted.

The other fixes (B128-B134, B136-B141, B143-B144 docs) read as root-cause fixes with T1/T2 tests. Notes for later:
B131's re-probe on any status change could keep an edge "measuring" if a node's status flips more often than a probe
takes; B129 clears the output priority as well as the filter on a dead-outlet splitter (keeping the trunk priority would
also work and leave fewer items on the dead side).

#### M7c.9 follow-up 18: ghost preflight and orphan ghosts (B144)

The fixed seed 1212121 resume from `min-0660` showed the B144 class on the current code: g109 failed ten rounds on 13
`transport-belt@357.5,11..16` ghosts and then relocated (0 built entities). B150 had already removed the old
"built module" exit that let `val1212fix3` report g109 as built, so this is the real outcome of that save.

A probe of the same save found 28 own `transport-belt` ghosts at `357.5,6..17` facing north with no live layout owner:
orphans of an abandoned route. A plan wanting the opposite direction could not reuse them, and creating its ghost on
those tiles did not work. The fix adds a preflight before any ghost is created:

- `planner/conflicts.ts` `preflightSpecs` sweeps own ghosts on the plan's tiles that no live layout part owns, and
  rejects two planned pieces on one tile (`overlappingSpecs`) or a tile another planned piece's ghost owns. A
  script-created ghost on a tile deletes the ghost already there, so this check must come before creation.
- `applyDiff` is two-phase: it creates no place jobs until every ghost of its list stands. It also matches a ghost by
  direction, looks for a blocker before creating, and treats an own stale belt as a pickup-and-retry (a foreign entity,
  structure or plan overlap is hard).
- `stepBuild` queues those stale pickups, and a hard blocker records its tile in `FactionState.buildBad`; the next plan
  for the role avoids it (`planner/bad-build.ts`).

In game, the same save with the fix logs `swept 28 orphan ghost(s) off its tiles` and g109 stamps without a ghost
failure. The 60-game-minute resume (`m7-b144-fix`, 660 → 720 game-min, `-j 1`) completed with **0 stalls**: g109
reached 1,376 placed entities and was still building at the end (it had failed and relocated within 50 s before the
fix), and g111's power growth built in 90 s. Tests: T2 `conflicts` (orphan, plan overlap, stale belt, wrong-direction
ghost in `applyDiff`, removal of a turned ghost); T1 `bad-build` (53/53 files). Full T2 on this commit: **208 passed,
0 failed** (2026-11-05). The seed-11 resume to the robot stage (`m7d5-robotsB`) then crashed at minute 1044: a repair
goal reuses `growBuild` without `growth`, so the hard-blocker branch read `g.growth.node`. Guarded (`d82c5f3`, T2
`factory` "B144: a repair goal…", which exits the shard without the guard); the run resumes from `min-1020`
(`m7d5-robotsC`).

## M7d: advanced oil, robots and the full mall

Plan (agent, from P45; the user approved starting M7d in-session on 2026-11-03):

1. **Engine tests first (P48): done.** Construction robots work for a force with no players, unlike radars (D62). A
   script-created force's roboport network built 11 ghosts from a storage chest and removed a tree marked for
   deconstruction in 526 ticks. A player-less character's personal roboport (modular armour, battery) built 8 ghosts
   from its inventory and removed a tree in 160 ticks. The player force did the same in both scenes. T2
   `engine-capabilities` "M7d (P48): …" (two tests).
2. **Oil complex (D81, user decision in-session 2026-11-03): generator done, not yet used by design.** Generator
   `oil-complex` (`modules/generators.ts` `oilComplex`, params `refineries`, `lubePlants`): advanced-oil refineries
   facing north at the bottom, chemical plants (light crackers, heavy crackers, lubricant plants) facing north above them,
   one manifold per fluid between and around the two rows (water and crude below the refineries; heavy, light, petroleum
   and lubricant between the rows; water, heavy and light again above the plants, fed by connector columns at x = 0, 2
   and 4). Every machine box connects by a riser: a pipe into the adjacent manifold, or a pipe-to-ground pair under the
   nearer ones, so only risers touch a machine and boxes a recipe does not use touch nothing. Crude enters from the east,
   water from the west, petroleum and lubricant leave east.
   - **Crackers are sized for every drop:** enough heavy crackers for all the heavy oil (as if no lubricant were drawn) and
     light crackers for all the light oil that makes. Unused lubricant then never backs heavy oil up into the refineries
     and stops their petroleum.
   - **Rates are the module's own** (`ModuleDraft.rates`, new): the generic rate balance cannot share one product between
     two consumers. Without circuits (stamped modules carry none) the engine splits heavy oil between the lubricant
     plants and the heavy crackers. The declared lubricant is the plants' share in proportion to their draw; T2 measured
     more (5.0/s against 3.33/s declared with 2 refineries, 1 lubricant plant and 1 heavy cracker). A design that needs
     more lubricant adds plants.
   - **Tests.** T1 `oil-complex` floods the pipe networks (pipes, pipe-to-ground pairs, machine boxes): every fluid's
     boxes and ports share one network, no network carries two fluids, unused boxes touch nothing, power reaches every
     machine on one pole network, for 1–6 refineries × 0–2 lubricant plants; a cut manifold and a joining pipe are caught.
     T2 `modules` "oil complex validation" runs it from infinity-pipe sources into pumped, drained outputs: 2 + 1:
     petroleum 36.6/s of 37.3 declared, lubricant 5.0/3.33; 4 + 0: petroleum 78.1/78.0.
3. **Chemistry rows fed by pipe** (plastic, sulfur, sulfuric acid, batteries) and an assembler row with a fluid input
   (electric engines take lubricant).
   - **Chemistry rows: done.** Generator `chem-row` (`recipe`, `chemPlants`): chemical plants facing south, fed from
     one or two fluid manifolds below them (the second through pipe-to-ground pairs under the first, its port on the
     opposite end, as M7c.8), up to two solids on one input belt (one per lane, the assembler-row tail), the product on
     a belt (long-handed inserters) or, for a fluid product, a manifold above the belt reached by pipe-to-ground risers.
     Unlike `fluid-chain` it has no refinery: the petroleum comes from the oil complex. T1 (`oil-complex` file): the
     network check (now for south-facing machines too), power and ports for the four recipes at 1–4 plants. T2
     validation lab, 2 plants each: plastic 2.40/2.40 bars/s, sulfur 2.40/2.40, sulfuric acid 12.79/12.60 per s
     (101.5%), batteries 0.50/0.50. The lab now measures fluid outputs: a pump (its own fluid segment) into a pipe
     drained every tick.
   - **Sulfuric acid is inserter-bound:** one inserter per plant feeds 6 items per craft, so a plant makes 6.3 acid/s of
     its 50. Enough for about one battery plant per acid plant (5 acid/s each); more input inserters need the pole and
     riser moved off the inserter row (later, if acid is short).
   - **Assembler rows with a fluid: done.** `assembler-row` takes a recipe with one fluid ingredient: the machines
     (assembling machine 2 by default) face south, so their fluid input is on the input side; a pipe-to-ground riser
     passes under the input belt to a manifold on row 8 (`pipe-in` at the west end), one input inserter beside it, and
     the lanes' first input belt starts on the bottom edge. The manifold is part of each unit's slice, so it grows with
     the row. T1: ports, pipe networks, power and rates for 2–6 machines with and without a buffer head. T2 validation:
     2 machines, electric engines 0.153/0.150 per s (102%).
4. **Design: done.** Once the `advanced-oil-processing` recipe is enabled, `generatorRule` (`strategy/design.ts`) picks:
   petroleum gas and lubricant from one `oil-complex` per cluster; every chemistry recipe that fits a `chem-row` (plastic,
   sulfur, sulfuric acid, batteries) from a pipe-fed row; a recipe with one fluid and one or two solids that an assembler
   makes (electric engines) from a fluid `assembler-row`. `expandOilComplex` sizes the complex for both outputs at once
   (the smallest refinery and lubricant-plant counts that cover both draws, up to 12 refineries and 6 lubricant plants)
   and wires each consumer to its output port. A built oil complex that is short keeps what it can feed; the rest goes to a
   parallel complex. A `fluid-chain` already built before the research keeps its role and generator (the design reads
   the built graph's generators, `stage.ts` `builtGenerators`), so the switch never rips a working chain. T1 `design`:
   three tests (one complex, pipe-fed rows and no fluid chains after the research; electric engines and plastic share
   one complex for lubricant and petroleum; a built fluid chain stays one). Not yet seen in a soak: no run has reached
   advanced oil processing.
5. **Robots (D77, P48, P49): in progress.** A roboport network over the base with chests the crew fills, about 50
   construction robots, modular armour with personal roboports for the crew. All of the design below is the agent's
   (proposed), not a user decision.
   - **Four-ingredient assembler rows: done.** A flying robot frame takes four solids (engine, battery, steel, circuit).
     `assembler-row` now takes 1–4 solids: a fourth input sideloads from the east end of the row-7 tail, beside the third
     (the row-6 merge column moves one tile east, the row gets one tile wider). T1 `fluid-chain` "M7d.5: assembler row,
     four ingredients": ports, power, rates. T2 validation `assembler-row flying-robot-frame 2`: 0.0733 of 0.075 frames/s
     (97.8%). `factory-row-inputs` now allows 4 (default 2; `m7.toml` sets 4).
   - **Robot stock: done.** Once `construction-robotics` is researched and the recipes are enabled, the design adds
     stock sinks (`strategy/design.ts` `robotStock`, role `stock:<item>`): a two-machine assembler row with a buffer for
     construction robots (50) and one for roboports (10), sized to fill in 30 game-min, as sinks the solver expands
     like the mall's (frames, engines, batteries and the rest of the chain follow). T1 `design` "M7d.5: construction
     robots and roboports stocked…".
   - **Roboport network goal: done, not yet seen in a soak.** Generator `roboport` (5×4: a roboport and a small pole; the
     hub variant adds two storage chests). A new goal kind `robots` (`strategy/robots.ts`): once the roboport stock row is
     built, a hub roboport goes near the base centre, then one roboport at a time on a square grid from the hub
     (`factory-roboport-spacing`, 36 tiles). Each new one takes a free cell next to the network (so the logistic areas
     touch) whose construction area reaches the most module area the network does not cover yet; ties go to the cell
     nearest the hub (`strategy/robot-grid.ts`, T1 `robot-grid`). A goal's plan region is 8 tiles around its grid point
     (24 for the hub), so a roboport lands within about 6 tiles of it: 36 + 12 stays within the vanilla roboport's
     logistic reach of 50. A failed cell is not tried again; the network stops at `factory-roboports-max` (10).
   - **Crew and robots: started.** The hub's storage chests become the crew's depot (`addStockpile`): robots build ghosts
     from whatever the crew leaves there. The crew puts construction robots from the stock into the hub roboport until
     the network has `factory-network-robots` (50). A place job whose ghost a robot built is done (`robot-built`), not
     failed `ghost-removed`, so its fuel jobs go on (T2 `jobs` "M7d.5: a place job whose ghost a construction robot
     builds…"). A robot-built buffer chest gets its slot limit. The crew leaves a new place job to the robots for
     `factory-robot-first-seconds` (60) when they can do it now: the ghost is in a network's construction range, the
     network has a free robot and its storage holds the item; after that the crew builds it as before (T2 `jobs` "M7d.5:
     the crew leaves place jobs…", which fails with the window at 0). Removals are Factorio's own deconstruction orders (user request in-session 2026-11-04: robots build
     and deconstruct "like normal", through ghosts and deconstruction orders). Once the faction has a roboport network,
     every clear job marks its target when it is made (`jobs/robot-orders.ts`), as a player's deconstruction planner
     does: robots in range take it down, the crew does the rest (and leaves targets in range to the robots for the same
     window). The job is done (`robot-removed`) once its target is gone, whoever removed it. A clear job that ends with
     its target standing (failed, or dropped by a replan) has its order cancelled, unless another live job wants the
     same target. Without a network nothing is marked: a marked machine stops working, and a retiring module keeps
     producing until the crew picks it up, as before. T2 `jobs` "M7d.5: robots take down a clear job's tree…" and
     "…a clear job is a deconstruction order at once; a dropped job's order is cancelled".
   - **Passive provider output chests (user decision in-session 2026-11-04: "yes output chests can be upgraded to
     passive providers").** Once `passive-provider-chest` is researched (construction robotics) and the faction has a
     network, new modules get passive providers as buffer heads (`strategy/provider-chests.ts` `bufferChest`), and built
     modules' output chests (buffer heads, the chest-out ports of the mall and stock rows) get Factorio upgrade orders,
     which the robots carry out in place (contents kept, like a player's upgrade planner). The crew brings the chests
     the orders wait for to the hub's storage chest. Once a chest in the world is a provider, the layout follows
     (module entities, canonical copy, growth params). Chest checks across buffers, measurement and the crew accept
     `logistic-container` too. T1 `modules` "M7d.5: a passive-provider buffer head…", T2 `jobs` "M7d.5: robots upgrade a
     buffer chest to a passive provider in place…".
   - **Bug found on the way (seed 11 g154, the robot chain plan).** The two-solid chem rows (battery, sulfuric acid)
     fed their first input port from a tile inside the module, so placement rejected every spot `own-lane-sealed`
     (17,903 times) and all 4 attempts failed. That first solid now sideloads from the east (the row is one tile wider).
     A new T1 invariant checks every generated module: every belt and pipe port leads to a tile outside it. The replay
     `m7-seed11-g154-a1` (new `regenerate` option: rebuild a captured module from its params) then placed the row and
     failed both oil complexes' water pipes (BUGS B146, hidden by the bad row). (1) A port's in-module run counted
     every pipe of the module (221 of the 312-tile extent for the water port), now only the pipes joined to the port
     (76). (2) The pipe search kept one node per (tile, heading) by cost, so every path with a pump was dropped where a
     pump-free one came first; a dearer node with a shorter run is kept now. The plan completes (route work +2%; no
     other replay moved more than 5%).
   - **In game (soak `m7d5-robots3`, seed 11):** g154 planned on its first attempt and built all but one pipe, which
     the game refused (BUGS B147). Its own crude line had turned right beside the second oil complex's water manifold
     on the module's edge, so crude flowed into the new water line, and its last pipe would have mixed the two. The
     stuck-build reroute then routed that pipe line as a belt and failed, and the goal gave up its whole site. Fixes:
     the pipe router keeps plain pipes away from other fluids' module pipes on a module edge, and a reroute keeps a
     route's fluid. Still open: a reroute cannot clean a segment that already holds the wrong fluid, and one stuck
     ghost still relocates a whole site; both proposed as follow-ups.
   - **Robots straight into a roboport (user request in-session 2026-11-04: "the output of the construction robots
     should be inserted directly into a roboport, and a supply chest can be kept for the engineers").** The
     construction-robot stock row gets a roboport head (`generators.ts` `rowRoboportHead`, 6 columns at its west end):
     the first inserter off its output belt fills a roboport, the second the buffer chest (a passive provider) that
     stays the crew's supply, and two storage chests sit beside the roboport. *Approved by the user in-session
     2026-11-04 ("roboport can be the new hub", an agent proposal):* that roboport is the network's hub (cell 0,0, the grid's origin, its storage chests the depot), so no separate hub goal is
     planned when the row has the head; a faction whose hub or robot row already exists keeps it. The crew no longer
     carries robots into that hub (the inserter does). The roboport keeps taking robots until its robot slots are full
     (up to 350), above the network's `factory-network-robots`; the user decided in-session 2026-11-04 that it needs no
     cap. Also: a stock row's chest is a new supply kind,
     `stock-out`, taken from in any amount (soak `m7d5-robots4`: the hub's roboport place job could not take the one
     roboport made, "below minimum 5", and queued a hand-craft needing 90 plastic). T1 `modules` "M7d.5 (user request
     in-session 2026-11-04): a roboport head…", T1 `design` (the robot row's params).
     **In game (soak `m7d5-robots5`, seed 11, from the robotics save):** the robot row was planned with its head, built
     at minute ~1120, its two storage chests became depots, and the next roboport goal (cell 0,-1) started from it.
     But g154 (which held both stock rows) took 86 game-min longer than on the old build: the stock row's chest only
     counted as `stock-out` once its node was built, which waited for the roboport the same goal needed, so the crew
     waited until 5 roboports piled up (minute 1080: 2 in the chest, the ghost unfilled). A stock row's chest now
     counts once it stands in the world. T2 `bootstrap-sources` "M7d.5: a stock row's chest supplies one roboport
     before its node is built…" (fails without the fix). The run ended 20 game-min after the hub was built, before
     robots could be seen working.
     **Then (soak `m7d5-robots6`, from minute 1080 on that fix):** g154 finished within 2 game-min of the load, and by
     minute 1200 the network had grown to 5 roboports (cells whose spot is taken by a module fail and are skipped).
     But no robot existed: the design had "no module makes sulfuric-acid" since the robot chain was first planned, so
     the battery plant never got acid (BUGS B148: the game's recipe lookup did not find fluid recipes). Fixed. The
     electric engine rows reported the same machine status as the acid-less battery plant (likely no lubricant; not
     traced yet), and the third oil complex's petroleum and crude pipes still find no path (next).
     **Soak `m7d5-robots7` (minute 1200–1260, on the B148 fix):** the design plans the acid row now
     (`sulfuric-acid>battery>…`), but no production plan finished: each failed on the third oil complex's petroleum
     line into the plastic row, a port the second complex already fed (BUGS B149: a second same-fluid line now joins
     the first beside the port). The replay of g198 still fails on its crude line from a pumpjack field ~1000 tiles
     away and on belt rip-up loops at the labs and the mall (open). **Follow-up (2026-11-05):** a T1 line on open ground routes ~1000 tiles with
      three pumps (T1 `fluid-route` "a 1000-tile line places pumps…"), so the remaining g198 failure is terrain or the
      field's egress (uncharted chunks, a cliff ring, or a sealed port), not distance. **g198 was the port (B151,
      fixed `a9b2ca9`):** the new oil complex was sited with its water port's outside tile beside a built crude route,
      so a pipe there would mix fluids. Placement now rejects `port-fluid` for a pipe port whose outside tile has
      another fluid's route beside it, and the router keeps the same one-tile moat. The replay `m7d5-g198-water`
      completes (63 searches, 11 rip-ups, 3,615 route tiles). g200 remains open for a different reason: its built
      complex's water port is 78 tiles short behind built infrastructure (`run 264+68 > 312`), which needs a pump/route
      decision rather than a placement rule.
      **The robot block's electric islands (B152, fixed `1b8e038`):** by minute 1380 the chain rows and five roboports
      were built, but each row was its own electric network while the base was net 6. `unpoweredModules` returned
      empty, so every power repair said "nothing missing". The new `power_debug` remote showed why: the connecting
      pole ghosts were in the layout but had **no place job** (`ghost job=none`, e.g. 407,-71; 408,-55; 386,-57). The
      layout's power graph counts a planned ghost as an edge, so the module looked powered while the world could never
      build it. Root cause: a partial stamp creates pole ghosts but no jobs; on the retry `stampParts` saw each existing
      ghost and skipped it instead of including it in the job loop, and `addPlaceJob` refused a ghost whose old mapping
      pointed at a finished job. `stampParts` now includes existing pole ghosts (the B41 live-pole skip stays) and
      `addPlaceJob` clears a stale/terminal mapping. A **one-time** `adoptPlannedPoles` migration (`poleAdoptDone`) fixes
      saves made before the change; it is not a recurring pass. On the min-1380 save it adopted 111.
      **The shared iron feed (B153, fixed `e28c816`):** once power held, the battery/frame row n464 still had two iron
      feeds and 0/s arrived; every repair failed `port n326.out already feeds a route (point-to-point topology; use
      splitter-tap)`. `planReroute` kept the plan's point-to-point policy even though another route still left the
      same port. It now switches to splitter-tap when a connection merges or its source port still feeds a route after
      the rip (T1 `planner`, fails with the old policy).
      **The sealed sulfur port (B154, fixed `6c4c35e`):** the robot chain's sulfur row had its petroleum pipe-in port at
      367,-145 boxed in (`open 4/25`), so every oil complex the design added failed `no pipe path`; the acid row had no
      sulfur, the battery no acid, and the frame/robot rows no engines. `openPortEnds`/`sealedInputs` only knew belt
      ports, so later placements were never stopped from walling in a pipe port. They now include pipe-in/pipe-out (and
      the existing `ownLanesOut`/`sealsPortLane` checks apply), T1 `planner` pins a chem row's pipe lane end. Existing
      saves keep their already-sealed port; the fix is validated by a plan from before the row was sited (min-1080).
      **Spare fluid providers were never offered (B155, fixed `655b59b`):** `expandShared` only offered a built
      provider's spare when one of its consumers was in the current design walk. A water/oil line whose old consumer sat
      in another goal therefore could not take the new sulfur row, so the design added a new provider and line through
      the built block. Fresh demands now try every spare provider of the item; the provider role is reused and the
      planner's B120 same-source tap attaches the consumer to the existing line (provider spare covers the draw, and
      the tap is downstream of the provider's pumps). T1 `design`.
      **Crude capacity was measured against the plan (B156, fixed `be9ca2f`):** on the min-1200 save, 15 built pumpjacks
      had ~209.6 crude/s of potential while the six crude edges planned 42.4/s, but the design added another oil complex
      because a pumpjack field's spare used its `planned` output. `sharing` now computes a pumpjack field's spare from
      `fieldPotential`: `wellRate` over its built pumpjacks' current resource amounts. It is potential, not production,
      so a backed-up pumpjack still counts; other providers keep the planned-output rule. T1 `design`.
      **Field siting (B156):** a generated field is placed at its wells' box exactly, and `placeFixed` rejects the whole
      plan at the first tile another part of the layout claims (`occupied`/`reserved`/`routed`; no entity need stand
      there). `layField` now treats those claims like cliffs (shrinking the box away from them, the generator routing
      around), and `planGoal` passes the boxes of a goal's earlier fields as avoid rects, so a second crude provider
      cannot lay its field over the first one's claim. `claim_debug` reports the claims and covering modules at a tile.
      T2 `world` "oil fields".
      **Pipe seals (B157):** the pipe router had no seal proof at all. A failed search was either `search exhausted`
      (a proof, but never turned into evidence) or `budget exhausted` (no proof at all), and the pipe failure path did
      not push `routeEvidence`, so `wideJoin`, B57 relocation and B106 re-placement could never fire for a pipe. A
      goal-side flood (`planner/route-seal.ts`, bounded by `router.sealCheck`, over-approximating the moves so it can
      only miss a seal, never invent one) now proves the pocket; `pipeStep` records it as evidence and re-places a
      plan's own sealed consumer. T1 `pipe-router`, `fluid-route`; replay `m7-seed11-edge` now plans.
      **Pipe retry and lane rules (B158):** a connected-but-expensive fluid route used to fail once at
      `PIPE_BUDGET = 200000` with no retry; it now resumes the same search once at ×2 (`PIPE_BUDGET_RETRY`). Pump
      moves require a free pole spot, so a planned pump is powerable. Placement lane checks now judge a pipe port with
      the pipe's own rules: another fluid's route or port moat blocks the lane (`planner/fluids.ts`), and a
      pipe-to-ground span reaches `PIPE_LANE_HOP = 10` (belt `LANE_HOP` 5). One `RouteFailure` shape and one
      `pushRouteEvidence` serve both transports; `wideJoin` is belt-only. The goal-side seal is a shared reverse flood
      over each transport's real moves (`route-seal.ts`): pipes use `pipeClear`, pipe-to-ground spans and pump/pole;
      belts use turns, undergrounds and tunnels. In game (`m7d5-seal1200b`, min-1200) it proves the run N water port
      sealed (`seal goal 15 tiles, 41 states`), and the seal is checked before the budget retry so a sealed port skips
      the doubled search. Alternative join tiles, the full driver hoist and plan-time pipe rip-up remain.
   - **Personal roboports: moved to item 8.** The engine test charges the equipment by script; a real crew member needs a
     power source in its armour grid (solar panels or a portable reactor), which belongs with the modular armour work.
6. **Full mall (D79):** a generated mall prototyped on a `proto/*` branch and compared with a curated one; the user picks.
7. **In-place upgrades (D82 a, user request in-session 2026-11-03).** Once a better entity is researched and the mall
   stockpile holds enough of it, existing modules are upgraded where they stand rather than rebuilt: red belts
   (30/s) along a belt whose flow needs them, steel furnaces in smelter columns, assembling machine 2 in assembler
   rows, fast inserters, medium (steel) power poles so the crew stops mining wood. Research: mining productivity
   (+10% per level for every mine) and research productivity. *Proposed approach:* an upgrade is a build job that
   swaps entity for entity (same position and direction; the old one goes back to the stockpile), so no plan or route
   changes; the module's declared rates are recomputed with the new entities; a belt is upgraded only where the
   measured or planned flow exceeds a yellow lane, a module only when its output is short.
   **User decision (in-session 2026-11-03):** "make it eligible for upgrade just like growth, so it also upgrades
   upstream and such or pulls in more input". An upgrade is one more way to grow in place: the design offers an
   upgradable module's extra output as in-place capacity (like its expansion units), and the raised draw goes up the
   chain through the supply pass, which grows, upgrades or forks the providers in turn.
8. **Modular armour, batteries and an exoskeleton (D82 b)** so the crew walks faster (and carries the personal
   roboport of item 5).
9. **Solar panels and accumulators (D82 c)** where adding or upgrading steam power costs more; panels are meant to be
   easy to move. *Proposed:* a solar-field module (panels, accumulators, poles) placed like other modules, picked up and
   re-placed when its ground is needed.
10. **Cliff explosives and landfill (D83, user request in-session 2026-11-04), at the end of M7d.** The faction
    researches `cliff-explosives` and `landfill`, and the mall makes both. Cliff explosives destroy cliffs that block a
    site or a route; landfill fills water under one (lake-cut arms, P51). *Proposed:*
    - **Engine tests first, as with robots (P48):** throwing a capsule and placing tiles are player actions. A
      player-less character may not be able to do them, and then a scripted equivalent is needed (a cliff-explosive
      projectile created at the cliff, `surface.set_tiles` for landfill paid from the crew's inventory).
    - **Cost:** the planner sees a cliff or water tile as passable at a cost, once the item can be made. A removal is
      planned when it is cheaper than the detour or the next site.

### Magic numbers for the user (M7)

| Name | Where | Value | Why | Setting? |
|---|---|---|---|---|
| Smallest top-up worth a provider | `settings.ts` `factory-min-top-up` | 0.05 items/s | Agent guess (M7c.9 follow-up 8, proposed): about two burner furnaces' coal; g111 planned a mine and a 550-tile belt for 0.004/s. | yes |
| Pipe-route heuristic weight | `planner/pipe-router.ts` `PIPE_HEURISTIC_WEIGHT` | 4 | Agent guess (B120): a remote crude route otherwise searched a broad area for minutes in a single tick; weighted A* trades the cheapest possible pipe path for a fast one. | no |
| Failed-plan capture side limit | `strategy/factory.ts` `exportPlanInput` | 3,000 tiles (was 800, then 1,200) | Includes a remote oil field and the home base in one replay fixture; 1,200 still skipped the seed 11 sulfur plan (its region was 2,478 × 2,169: the oil field ~900 tiles west of the hub). | no |
| Power job priority | `strategy/factory.ts` `POWER_JOB_PRIORITY` | 100 | Was the literal of burner refuels; B111: builds that restore the power supply get it too, so refuels cannot preempt them (the build priority setting is 90). | no (build priority is a setting) |
| Unreachable standing spot avoided for | `jobs/bad-spots.ts` `BAD_SPOT_TICKS` | 10 game-min | Agent guess (B111): long enough for the crew to move on, short enough that a cleared obstacle is tried again. | no |
| Unreachable spot avoided around | `jobs/bad-spots.ts` `BAD_SPOT_RADIUS` | 2.5 tiles | Agent guess (B111): the next spot nearest the member is usually a tile over in the same pocket; 2.5 clears a four-tile stretch of corridor. | no |
| Pumpjack field margin | `modules/generators.ts` `PUMPJACK_FIELD_MARGIN` | 2 tiles | Agent guess: room around the pumpjacks for the collector pipes and poles. | no |
| Pipe budget retry | `planner/plan.ts` `PIPE_BUDGET_RETRY` | ×2 | Agent guess (B158): one resume of the same search after `budget exhausted`; a second retry would double planner stalls. | no |
| Pipe-to-ground pair / pump route cost | `planner/policy.ts` `RouterWeights.pipeUnderground` / `pump` | 2 / 10 (defaults in `plan.ts`) | Agent guess: a pair costs two pipes' worth plus material; a pump is dearer and needs power, so the route only takes one where the extent forces it. | no |
| Pipe route search budget | `planner/plan.ts` `PIPE_BUDGET` | 200000 expansions | Agent guess: a 600-tile line needs a few thousand; the rest is room for detours. | no |
| Slow-plan capture | `planner/runtime.ts` `SLOW_PLAN_TICKS` | 3600 ticks (1 game-min) | Agent guess (diagnostics only, soaks with frame dumps): most plans finish well within a game-minute; one still planning then is captured to `plans/slow/` for a replay. Adopted plans are now captured up to a 3,000-tile side like failed ones (was 400: production regions are 768² and were never kept). | no |
| Oil complex size cap | `strategy/design.ts` `OIL_COMPLEX_MAX_REFINERIES`, `OIL_COMPLEX_MAX_LUBE` | 12 refineries, 6 lubricant plants | Agent guess (proposed): a 12-refinery complex makes ~230 petroleum/s (T2: 19.5/s per refinery with cracking), far above a first blue/robot base; a larger draw adds a parallel complex rather than one unbounded footprint. Lubricant: 6 plants can make 60/s, though heavy oil (5/s per refinery) limits it first; a 6-machine electric-engine row draws ~6.75/s. | no |
| Router work per move | `planner/router.ts` `ROUTER_MOVE_WORK` | 0.5 units per move an expansion or seal step tries (plus 1 per expansion) | Calibration (proposed): brings the router's unit to ~3–4 µs in T1, the scale of placement's (~4 µs) and of the planner budget (`planner-work-per-tick` 400). | no |
| Merge search up a tap tree | `planner/merge.ts` `MAX_TAP_DEPTH` | 8 taps | Agent guess (proposed): the deepest seed 11 tree was 4 taps; the bound only stops a pathological chain. | no |
| Tunnel crossing cost | `planner/policy.ts` `RouterWeights.tunnel` (EARLY_COMPACT) | 12 (0 turns it off) | Agent guess (proposed): above a route's own underground pair (8), so a route hops a crossing itself where it can and rebuilds another route's belts only where it cannot; well below a rip-up (25 per tile plus the reroute). | no (policy field) |
| Joint port egress box | `planner/policy.ts` `placement.portEgress` (EARLY_COMPACT) | 50 tiles (0 turns it off) | Agent guess (proposed): seed 11 g104's bottleneck was beyond 25 tiles; 50 caught it and 75 changed nothing. A larger box costs more and rejects more spots. | no (policy field) |
| Egress check retries | `planner/placement.ts` `EGRESS_RETRIES` | 6 crowded spots | Agent guess (proposed): bounds the rescans of one radius; after that the best spot is taken unchecked, as before the check. | no |
| Egress check work per node | `planner/placement.ts` `EGRESS_WORK` | 0.25 units | Calibration (proposed): a node's residual moves cost about a quarter of a placement unit. | no |
| Bad-build tile memory | `planner/bad-build.ts` `BAD_BUILD_TICKS` | 30 game-min | Agent guess (B144, proposed): long enough for the next attempt to start elsewhere, short enough to try the ground again later. | no |
| Bad-build tiles kept | `planner/bad-build.ts` `BAD_BUILD_CAP` | 32 entries | Agent guess (B144, proposed): a handful of failed plans per role; the entry expiring first is dropped. | no |
| Bad-build avoid radius | `planner/bad-build.ts` `BAD_BUILD_RADIUS` | 1 tile | Agent guess (B144, proposed): covers the blocked footprint and its edge without keeping a whole area free. | no |
| Robot stock | `strategy/design.ts` `ROBOT_STOCK`, `ROBOPORT_STOCK` | 50 construction robots, 10 roboports | Agent guess (M7d.5, proposed): 50 robots is D77's "about 50"; 10 roboports is the network's default size. | no |
| Robot stock fill time | `strategy/design.ts` `STOCK_FILL_SECONDS` | 1,800 s | Agent guess (proposed): the stock rows are sized to fill their buffers in 30 game-min, so they stay small. | no |
| Roboport grid spacing | `settings.ts` `factory-roboport-spacing` | 36 tiles | Agent guess (proposed): neighbours may each land 6 tiles off their point, and 36 + 12 = 48 keeps their logistic areas (reach 50 for the vanilla roboport) touching. | yes |
| Roboports per faction | `settings.ts` `factory-roboports-max` | 10 | Agent guess (proposed): about a 400 × 400 base at spacing 36. | yes |
| Robots in the network | `settings.ts` `factory-network-robots` | 50 | D77 ("about 50 construction robots"). | yes |
| Robot-first window | `settings.ts` `factory-robot-first-seconds` | 60 s | Agent guess (proposed): long enough for a robot to fly across a 110-tile construction area (~30 s), short enough that a job the robots miss is not held up for long. | yes |
| Hub storage chests | `strategy/robots.ts` `HUB_CHESTS` | 2 | Agent guess (proposed): room for a depot's worth of building materials beside the hub. | no |
| Robot row roboport head width | `modules/generators.ts` `ROW_ROBOPORT_W` | 6 | Layout geometry (proposed): a 4×4 roboport plus a column for the supply chest's inserter and a column for the storage chests. | no |
| Roboport plan window | `strategy/robots.ts` `CELL_WINDOW`, `HUB_WINDOW` | 8 / 24 tiles (half-size) | Agent guess (proposed): a cell's roboport stays near its grid point; the hub only fixes the grid's origin, so it may go farther from the centre. | no |
| Rip-up loop guard | `planner/policy.ts` `router.ripLoop` (EARLY_COMPACT) | 1 (on; 0 off) | Agent proposal: a connection ripping the same route twice moves a module at once; no threshold beyond "twice". | no (policy field) |
| Robot count per faction (P49) | not implemented yet | ~50 | Approved as "about 50" with P49; the exact number is set when robots are built (M7d). | no |
| Depot spot search radius | `strategy/bootstrap.ts` `DEPOT_SEARCH_RADIUS` | 64 tiles | Agent guess (B116): was 24; by game-minute 450 the factory filled the hub and no depot fit. | no |
| Depot spot search retry | `strategy/bootstrap.ts` `DEPOT_SEARCH_RETRY` | 3600 ticks | Agent guess (B116): a failed search scans the whole square, so it runs once a game-minute, not every think. | no |
| Whole-patch search work scale | `planner/mine-plan.ts` `FILL_TILES_PER_UNIT` / `OPS_PER_UNIT` | 4 tiles / 16 operations a unit | Measured (T1 replays, Lua 5.4) so a unit costs about what a placement or route unit does (~5 µs): a tile read ~1.5 µs, a drill position or stamped tile ~0.3 µs. | no |
| Whole-patch preparation work scale | `planner/whole-patch.ts` `CLAIM_TILE_WORK` / `LANE_STATES_PER_UNIT` | 3 units a claimed tile / 2 flood states a unit | Measured the same way: materialising and checking ~17 µs a claimed tile, a lane flood ~2.4 µs a state. | no |
| Mine tap life | `strategy/fuel.ts` `MINE_TAP_LIFE_LEADS` | 2 mine leads (`factory-mine-lead-minutes`; power mines `factory-power-fuel-minutes`) | Agent guess (fix a, user-approved 2026-11-01): a new consumer needs the mine to outlive the time to build its replacement, with one lead of margin. | no (the lead is a setting) |
| Measured-draw cache step | `strategy/stage.ts` `DRAW_KEY_STEPS` | 4 steps per item/s | Agent guess: the design is recomputed when an edge's overdraw moves by 0.25/s, not on every sample. | no |
| Pipe port distance weight | `planner/policy.ts` `PlacementWeights.pipePort` | 4 (× the belt `port` weight) | Agent guess (M7c.8): a fluid line cannot rip or side-load through a built block and its undergrounds cannot pass under modules; 4 was enough with the widened search on seed 11 (20 alone did not move the chain: the window, not the weight, was the limit). | no (policy weight) |
| Fluid segment margin | `planner/plan.ts` `PIPE_EXTENT_MARGIN` | 8 tiles under `default_pipeline_extent` | Agent guess (M7c.8): a 320-tile pump-to-pump segment carried nothing on seed 11; 16 left the sulfur tap unroutable in two replays. | no |
| Pocket search size | `jobs/crew.ts` `POCKET_MAX_TILES` | 900 tiles | Agent guess (M7c.8): a 30 × 30 enclosure; a larger walkable area is not treated as a pocket. | no |
| Escape ghost delay | `jobs/crew.ts` `UNBOX_GHOST_DELAY` | 1800 ticks (30 s) | Agent guess (M7c.8): time to walk out of a pocket before the picked-up entity's ghost (and its place job) appears. | no |
| Fluid probe full share | `strategy/measure.ts` `PIPE_FULL_SHARE` | 0.9 | Agent guess (M7c.8): a pipe this full counts as backed up for the edge verdicts (the belt probe's 7 of 8 items). | no |
| Fluid probe sample spacing | `strategy/measure.ts` `PIPE_PROBE_EVERY` | 30 ticks | Agent guess (M7c.8): pipe fill changes slowly; nothing has to be seen crossing. | no |
| Idle replan interval | `jobs/crew.ts` `IDLE_REPLAN_TICKS` | 60 ticks | Agent guess (M7c.8): an idle member's plan reads every supply point; once a second (or at once when the board changes) keeps idle crews cheap and a new job is still picked up at once. | no |
| Route self-crossing depth | `planner/pipe-router.ts` `PIPE_CROSS_DEPTH`, `planner/router.ts` `BELT_CROSS_DEPTH` | 24 nodes | Agent guess (M7c.8): the loops that owned states were a few tiles long; 24 catches those at a small cost per move, and the whole-path check catches longer ones. | no |
| Test force cleanup threshold | `test/lab.ts` `STALE_FORCE_LIMIT` | 56 forces | Test harness only: below Factorio's 64-force limit, high enough that ordinary shards never merge a force a test may recreate in the same tick. | no |
| Lost-items minimum | `strategy/reconcile.ts` `LOST_MIN_ITEMS` | 3 items per edge probe | Agent guess (M7c.8): a belt owed fewer items in one probe (600 ticks by default) can show none by chance; 3 keeps a real break (B69: 2/s lost) detected in one probe. | no |
| Pipe edge capacity | `strategy/measure.ts` `PIPE_CAPACITY` | 1000/s | From the M7b engine finding (~1000-1170/s within the extent); used for the "full" verdict. | no |
| Site targets per placement | `planner/placement.ts` `MAX_SITE_TARGETS` | 4 | Agent guess (M7c.8): each is a full window scan (radius 96); four shores before a placement fails. | no |
| Max jobs per place batch | `settings.ts` `batch-max-jobs` | 24 (was 12) | User decision in-session 2026-11-03: doubled. | yes |
| Max jobs per clear/wood trip | `settings.ts` `trip-max-jobs` | 40 (was 20) | User decision in-session 2026-11-03: doubled (bootstrap wood jobs = crew × this). | yes |
| Clear/wood trip radius | `settings.ts` `trip-radius` | 32 tiles (was 16) | User decision in-session 2026-11-03: doubled. | yes |
| Standing spots per batch tour | `settings.ts` `batch-max-spots` | 4 | Agent guess for the user's request (proposed): about 70 tiles of belt line per haul with 24-job spots. | yes |
| Batch tour hop | `settings.ts` `batch-spot-hop` | 32 tiles | Agent guess (proposed): twice the trip radius; a gap wider than this ends the tour. | yes |
| Prefetch minimum source distance | `settings.ts` `prefetch-min-distance` | 64 tiles | Agent guess (proposed): a source this near is a short round trip, so nothing is carried for unclaimed jobs. | yes |
| Pipe corridor budget share | `planner/pipe-router.ts` `PIPE_CORRIDOR_SHARE` | 0.5 of the pipe search budget | Agent guess (M7c.9): leaves the whole-area search half the budget after a corridor dead end; g160 routes with it. | no |
| Soak exploring limit (M7) | `tools/harness/m7.toml` `exploring_minutes` | 120 game-min | Was 60. Seed 11's nearest crude is ~830 tiles from the hub, at the 12th radar outpost in arm order (west arm, outpost 3). | harness config |
