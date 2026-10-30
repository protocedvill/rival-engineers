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

### Magic numbers for the user (M7)

| Name | Where | Value | Why | Setting? |
|---|---|---|---|---|
| Unreachable standing spot avoided for | `jobs/bad-spots.ts` `BAD_SPOT_TICKS` | 10 game-min | Agent guess (B111): long enough for the crew to move on, short enough that a cleared obstacle is tried again. | no |
| Pumpjack field margin | `modules/generators.ts` `PUMPJACK_FIELD_MARGIN` | 2 tiles | Agent guess: room around the pumpjacks for the collector pipes and poles. | no |
| Pipe-to-ground pair / pump route cost | `planner/policy.ts` `RouterWeights.pipeUnderground` / `pump` | 2 / 10 (defaults in `plan.ts`) | Agent guess: a pair costs two pipes' worth plus material; a pump is dearer and needs power, so the route only takes one where the extent forces it. | no |
| Pipe route search budget | `planner/plan.ts` `PIPE_BUDGET` | 200000 expansions | Agent guess: a 600-tile line needs a few thousand; the rest is room for detours. | no |
| Robot count per faction (P49) | not implemented yet | ~50 | Approved as "about 50" with P49; the exact number is set when robots are built (M7d). | no |
