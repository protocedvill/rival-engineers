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
- Captured plan inputs run-length encode their terrain rows (`exportPlanInput` `rle`, read by `plan-replay.test.ts`):
  the two seed 11 captures went from 12.8 MB to 2.5 MB each. (The first, unencoded copy of `m7-seed11-sulfur` is in
  the branch history.)
- Harness: the probes' on-tick handler was replaced by the speed-up script's `on_event(on_tick)`; it now uses
  `on_nth_tick(60)`. New remotes `milestones()` and `design_debug(name, filter?)`.

Open (not changed): a module buffer chest takes 200 plates before downstream modules get any; outposts N2/N3/S2/S3 fail
with "no pole path"; crew time reached 0.86 ms/tick late in the 731-min run. Two oil modules on one fixed spot are
possible in the design (the `labs#2` case above) once the lock is released for any reason.

### Magic numbers for the user (M7)

| Name | Where | Value | Why | Setting? |
|---|---|---|---|---|
| Pipe-route heuristic weight | `planner/pipe-router.ts` `PIPE_HEURISTIC_WEIGHT` | 4 | Agent guess (B120): a remote crude route otherwise searched a broad area for minutes in a single tick; weighted A* trades the cheapest possible pipe path for a fast one. | no |
| Failed-plan capture side limit | `strategy/factory.ts` `exportPlanInput` | 3,000 tiles (was 800, then 1,200) | Includes a remote oil field and the home base in one replay fixture; 1,200 still skipped the seed 11 sulfur plan (its region was 2,478 × 2,169: the oil field ~900 tiles west of the hub). | no |
| Power job priority | `strategy/factory.ts` `POWER_JOB_PRIORITY` | 100 | Was the literal of burner refuels; B111: builds that restore the power supply get it too, so refuels cannot preempt them (the build priority setting is 90). | no (build priority is a setting) |
| Unreachable standing spot avoided for | `jobs/bad-spots.ts` `BAD_SPOT_TICKS` | 10 game-min | Agent guess (B111): long enough for the crew to move on, short enough that a cleared obstacle is tried again. | no |
| Unreachable spot avoided around | `jobs/bad-spots.ts` `BAD_SPOT_RADIUS` | 2.5 tiles | Agent guess (B111): the next spot nearest the member is usually a tile over in the same pocket; 2.5 clears a four-tile stretch of corridor. | no |
| Pumpjack field margin | `modules/generators.ts` `PUMPJACK_FIELD_MARGIN` | 2 tiles | Agent guess: room around the pumpjacks for the collector pipes and poles. | no |
| Pipe-to-ground pair / pump route cost | `planner/policy.ts` `RouterWeights.pipeUnderground` / `pump` | 2 / 10 (defaults in `plan.ts`) | Agent guess: a pair costs two pipes' worth plus material; a pump is dearer and needs power, so the route only takes one where the extent forces it. | no |
| Pipe route search budget | `planner/plan.ts` `PIPE_BUDGET` | 200000 expansions | Agent guess: a 600-tile line needs a few thousand; the rest is room for detours. | no |
| Robot count per faction (P49) | not implemented yet | ~50 | Approved as "about 50" with P49; the exact number is set when robots are built (M7d). | no |
| Depot spot search radius | `strategy/bootstrap.ts` `DEPOT_SEARCH_RADIUS` | 64 tiles | Agent guess (B116): was 24; by game-minute 450 the factory filled the hub and no depot fit. | no |
| Depot spot search retry | `strategy/bootstrap.ts` `DEPOT_SEARCH_RETRY` | 3600 ticks | Agent guess (B116): a failed search scans the whole square, so it runs once a game-minute, not every think. | no |
| Whole-patch search work scale | `planner/mine-plan.ts` `FILL_TILES_PER_UNIT` / `OPS_PER_UNIT` | 4 tiles / 16 operations a unit | Measured (T1 replays, Lua 5.4) so a unit costs about what a placement or route unit does (~5 µs): a tile read ~1.5 µs, a drill position or stamped tile ~0.3 µs. | no |
| Whole-patch preparation work scale | `planner/whole-patch.ts` `CLAIM_TILE_WORK` / `LANE_STATES_PER_UNIT` | 3 units a claimed tile / 2 flood states a unit | Measured the same way: materialising and checking ~17 µs a claimed tile, a lane flood ~2.4 µs a state. | no |
| Mine tap life | `strategy/fuel.ts` `MINE_TAP_LIFE_LEADS` | 2 mine leads (`factory-mine-lead-minutes`; power mines `factory-power-fuel-minutes`) | Agent guess (fix a, user-approved 2026-11-01): a new consumer needs the mine to outlive the time to build its replacement, with one lead of margin. | no (the lead is a setting) |
| Measured-draw cache step | `strategy/stage.ts` `DRAW_KEY_STEPS` | 4 steps per item/s | Agent guess: the design is recomputed when an edge's overdraw moves by 0.25/s, not on every sample. | no |
| Pipe port distance weight | `planner/policy.ts` `PlacementWeights.pipePort` | 4 (× the belt `port` weight) | Agent guess (M7c.8): a fluid line cannot rip or side-load through a built block and its undergrounds cannot pass under modules; 4 was enough with the widened search on seed 11 (20 alone did not move the chain: the window, not the weight, was the limit). | no (policy weight) |
| Soak exploring limit (M7) | `tools/harness/m7.toml` `exploring_minutes` | 120 game-min | Was 60. Seed 11's nearest crude is ~830 tiles from the hub, at the 12th radar outpost in arm order (west arm, outpost 3). | harness config |
