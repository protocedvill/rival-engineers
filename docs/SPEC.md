# Rival Engineers — Spec

Status: **Draft v0.11** (2026-10-14). Mod internal name / repo / remote interface: `rival-engineers`. This document is the source of truth for the buildout.
Agents: if the code and this spec disagree, either fix the code or propose a spec change in your
milestone report. Never silently diverge.

---

## 1. Vision

AI factions that play Factorio the way players do: physical characters that walk, mine, hand-craft
and place entities, cooperating as a crew to build a real factory from a burner start. Later phases add
defense, biters, and war between factions (inspiration: Biter Battles).

Two layers, by analogy:

- **Micro (the "baritone" layer):** a deterministic controller that drives a character body. It moves along a
  path, mines a rock, crafts 10 gears, and places a belt at (x, y) facing east.
- **Macro (the "player brain"):** a recipe-graph planner that decides *what* the faction needs next. A base
  planner places **modules** (smelter array, gear line, science line) compactly on the real terrain and
  **auto-routes belts** between their ports through narrow corridors.

## 2. Decisions (from interview, 2026-10-14)

| # | Topic | Decision |
|---|-------|----------|
| D1 | Brain location | **Pure Lua in-mod.** Deterministic, no runtime LLM, no RCON dependency. LLMs are used only to *develop* the mod. |
| D2 | Body | **Physical character entities** with **strict player parity**: real pathfinding and walking, vanilla reach distances, real mining and hand-craft times, inventory limits. Teleport exists only as a debug option. |
| D3 | Crew | Each faction has a **fixed, configurable crew** (default 2, range 1–8) of characters sharing one factory. |
| D4 | Multi-faction | Multiple AI factions from v1 (default 2), each its own `LuaForce` with its own separate factory. All systems are per-faction from day one. |
| D5 | Start | **Player-like start** for each faction: vanilla starter items, burner phase, no head-start kit. |
| D6 | World (v1) | **No biters** (v1 test maps disable enemy bases). AI factions are **neutral** to the human player and each other. |
| D7 | v1 scope | Vanilla Nauvis progression **through red + green science** (automation + logistic science packs fully automated). |
| D8 | Layout | **Modules + routed belts.** Modules placed compactly on the real terrain (§5.3), with belts A*-routed between tagged ports through corridors. No main bus. Layout style is a pluggable `LayoutPolicy` per game stage (§5.3). |
| D9 | Module source | **Both**: curated modules (from the user's library, saves and online) with tagged ports, plus **procedurally generated** fallback modules for any recipe without a curated one. |
| D10 | Strategy | **Recipe-graph planner** driven by prototype data (recipes, techs, entities read at runtime), not a hardcoded build order. |
| D11 | Language | **TypeScript → Lua** (TypeScriptToLua + `typed-factorio`). |
| D12 | Hard constraints | **Multiplayer-safe** (deterministic, save/load-safe, no desyncs). **Must not break with Space Age enabled**, though v1 plays only Nauvis and vanilla tech. |
| D13 | UPS | Soft target, not a gate: all AI work combined should average under 2 ms/tick for 2 factions × 2 characters. Measure and report it. |
| D14 | Dev host | **Both**: cloud agents for code and fast tests, this machine for long soak simulations. |
| D15 | Visuals | **Custom map renderer**: the mod dumps entity JSON and a Python tool renders top-down PNGs and timelapse GIFs. |
| D16 | VCS | **Private GitHub repo**. Agents commit freely on branches and open **one PR per milestone** with a report. Milestone PRs are **stacked**, and prototypes live on unmerged `proto/*` branches (§9). The user merges. |
| D17 | Reporting | **Per-milestone reports** with renders and timelapses. No other routine check-ins. |
| D18 | Configurability | **Config over constants.** Anything a player or tester might reasonably want to vary (faction count, crew size, spawn placement, targets, budgets, debug toggles) is a mod setting or a scenario/remote-interface parameter, not a hardcoded value. See §5.7. |
| D19 | Module sourcing | Agents choose the sources (§5.4). Usable: any of the user's saves not modded in a way that changes early-game recipes, the user's blueprint library, and online blueprints (attribution required). Modules are prototype-grade. The user may replace them with custom modules later, so the module format must make swapping cheap. |
| D20 | Steel (2026-10-14) | **v1 does not build steel production.** Steel smelting and every module or building that needs steel belong to a higher research tier (post-v1, P3). v1 still *researches* `steel-processing` (a pack technology) as part of the research goal (§3.2, D30). |
| D21 | Solver (2026-10-14) | Recursive **ratio solver** for v1 behind a `Solver` interface; an in-Lua LP solver can replace it in P3. Resumable and tick-budgeted (§5.8). |
| D22 | Topology | How one producer feeds many consumers is a **LayoutPolicy** decision: point-to-point belts early, per-item trunks with splitter taps later; A/B-tested (§5.8). |
| D23 | Belts between nodes | **One item type per belt between graph nodes.** Mixed lanes only inside a module/generator; ports are single-item; no lane-preserving routing between modules (§5.8). |
| D24 | Capacity overflow | When demand exceeds an edge's capacity: upgrade belt tier, add parallel belts/routes, or build a new producer cluster sized for growth. The choice is a policy decision (§5.8). |
| D25 | Utilization target | Edges are planned up to a configurable fraction of nominal capacity, **default 99%**, tuned from soak evidence (§5.8). |
| D26 | Plan vs reality | Nodes and edges store planned and **measured** per-module rates; a reconciler classifies nodes (ok/starved/backed up/unpowered/unfuelled) and replans the root cause (§5.8). |
| D27 | Horizon | **Staged targets with headroom:** build for the current stage target, size trunks, space and corridors for the next (default 2×, per policy) (§5.8). |
| D28 | Disruption | Deferred to P2: v1 assumes a static world (no depletion relocation, no rebuilding destroyed modules) (§5.8). |
| D29 | Visibility | Graph export to JSON with a `tools/render` overlay, plus an in-game `rendering` debug overlay (§5.8). |
| D30 | Research goal (2026-10-14) | v1 researches **only the red/green technologies reachable without steel production or crude oil** (§3.2). No one-off steel smelt, so `steel-axe` is out, and nothing behind `oil-processing`. The set is computed from prototypes at runtime: **42** technologies in vanilla 2.0.77. |
| D31 | Hand speed (2026-10-14) | Crew place entities at a **configurable human pace**: `place-delay-ticks` (default 8) per entity once in reach, `belt-place-delay-ticks` (default 3) for belts, which players drag (§5.1, §5.7). |
| D32 | Faction starting areas (2026-10-14) | With `spawn-mode = auto-distance`, each faction's spawn is registered as a **map-gen starting point** (`MapGenSettings.starting_points`, as the vanilla PvP scenario does for teams) before its surroundings are generated, so it gets starting-area resources like a player. Setting `spawn-starting-area` (default on); off = search naturally generated land only. Proposed during M3 and confirmed by the user on 2026-10-14 (default on). Later milestones assume it. |
| D33 | Module validation (2026-10-14, user decision on M4a proposals P1 and P3) | Modules are fed **exactly 1.0× their declared input rates** throughout (no over-feeding, no priming) and measured only once they reach a **steady state** (detected automatically, with a generous cap on the warm-up; the detection rule is an implementation parameter, §7). A module that never stabilises is reported as a finding, not papered over. Each output must then reach **≥ 90% of declared**. **Malls** (outputs into chests) are judged on the **plate value of all products together (≥ 90% of declared)** plus a **product-coverage run** (chests capped at one slot, every product appears). Decided by the user via the manager; P1 accepted as proposed, P3 changed from "1.1× after a 3× primed warm-up" to this rule. |
| D34 | M4b proposals (2026-10-14, user decision via manager) | **Approved: P4** LayoutPolicy fields (`topology`, `protectOre`, `minOreCoverage`, `searchRadii`, `utilization`, `overflow { order, maxParallel }`, `headroom`, router/placement weights; `mod/src/planner/policy.ts`); **P5** every belt port keeps 2 free tiles straight out; **P6** module footprints never cover needed ore (mining modules excepted) but belts may cross ore at a policy cost; **P7** `planner-work-per-tick` default 100 (≈1 ms/tick while planning); **P8** optional `Port.lanes` (1 \| 2, default 2) for edge capacity. |
| D35 | Smelter placement (2026-10-14, user decision via manager) | "Smelting near its ore patch" vs "compact core" is a **LayoutPolicy option**, not a fixed rule. Both are implemented, and **M6 soak runs A/B them** to pick the early-game default. The M4 real-terrain bar (lab 5 modules + steam block, 5/5 seeds) is accepted. |
| D36 | Undergrounds (2026-10-15, user decision on P16, changed) | Research `logistics` (hand-fed packs, like the other unblocking techs) **before** a production/mall plan only when a route using underground belts would be **at least 50 tiles shorter** in total than the best plan without them (setting, default 50). Otherwise it waits for the normal research order. A plan that has no routing at all without undergrounds counts as infinitely longer, so the seed-222 case still researches it first. **Same rule for splitters** (user, 2026-10-15): if a plan using splitters (e.g. one producer feeding several consumers through splits instead of separate long belts) is at least n tiles shorter (own setting), research the technology that unlocks them first instead of building the long belts. |
| D37 | Stage 1 target (2026-10-15, user decision) | P11 approved: default `factory-targets` = 10 red/min, labs sized for the research goal's mean unit time. M6 adds the 30 + 30 stage. |
| D38 | Bootstrap intermediates (2026-10-15, user decision on P10, changed) | Hand-crafting everything before the mall is discouraged. Once assemblers are available, factions build **temporary factories**: simple chest-fed assemblers (a chest feeding an assembler making gears, another making belts, and so on, including packs while hand-feeding labs) that are **marked for deconstruction once the real mall covers their product**. The crew also **hand-craft opportunistically** (queue crafts while walking or waiting). Hand-feeding labs for unblocking techs (P10) stays; before `automation` (no assemblers yet) the packs are still hand-crafted. B18: cells are **kept stocked proactively** — every think tops the input chests up to the same buffer the demand feed uses (`bootstrap-factory-wait-seconds` of output) from the depot's surplus, so an output chest always holds a buffer that serves any later request; `bootstrap-temp-cell-feed-priority` (0 = off) decides how the refills compete with other work. |
| D39 | Crew pace (2026-10-15, user) | No artificial "think time" slowdown: the crews are already slower than a human because they work inefficiently. Efficiency improvements (batching, crafting while walking) are wanted, not throttling. |
| D40 | Bootstrap sizing (2026-10-15, user) | Bootstrap drill/furnace counts are **settings**, with the current values as defaults. |
| D41 | "Module" (2026-10-15, user) | **Module** means both kinds: hand-made / imported (curated) modules and generated ones (§5.4 `source`). Code and docs use "module" for either and say "curated" or "generated" only when the difference matters. |
| D42 | Buffer depots on modules (2026-10-15, user) | Modules may carry a small **buffer**: an inserter into a chest at the end of a line (e.g. a furnace stack) that the crew treats as a depot to collect from. Not every module gets one; agents use judgement and list each module's choice in the milestone report for the user to verify. A buffer is **not** an extra demand in the factory graph or module rates (it fills up and stops). For throughput validation (D33) the buffer chest starts full or its slots are blocked (chest bar) so it takes nothing. |
| D43 | Bootstrap depletion (2026-10-15, user; exception to D28) | Bootstrap mining sites that deplete (or are about to) are deconstructed and rebuilt on remaining ore, so runs don't die. D28's static-world assumption still holds for the planned factory. |
| D44 | Spawn distance (2026-10-15, user decision on P17, changed) | Factions spawn as far out as the config says (`spawn-min-distance`), **default 450+ tiles**, which is beyond the chunks a new game queues around the origin, so starting points get their lakes from normal map generation. The lake repair from M5a.2 stays only as a fallback for configs that spawn inside the queued area. |
| D45 | Ground claims (2026-10-15, user decision on P18) | P18 approved, **including the 1-tile margins** for other factions, provided it costs no noticeable performance (measure it). |
| D46 | Ore fields (2026-10-15, user) | **Factions never share an ore field.** A patch (connected ore field) that another faction mines or has claimed is off limits for bootstrap sites, mining modules and growth; spawn placement must give each faction its own fields. |
| D47 | Conflict repair (2026-10-15, user decision on P19) | P19 approved as built: blocked routes are rerouted, a blocked module or pole moves its whole goal, at most `conflict-max-repairs` (3) per goal. **M6:** relocate only the blocked module (and its routes) instead of the whole goal. |
| D48 | Growth by belts, upgrades, soft claims (2026-10-15, user direction; later stage) | (1) Plan raw-material modules in **whole belts of I/O** (e.g. 48 stone furnaces fill one yellow belt; ratios as in https://factoriocheatsheet.com/#material-processing): an expandable module (`ModuleDef.expand`) has a full size of N belts. (2) Early on, build only **part** of a module for current needs, and **finish it** later when demand grows. (3) Prefer **in-place upgrades** of existing modules when more is needed (stone → steel furnaces, yellow → red belts, other same-footprint replacements) before building new ones; this extends D24's `upgrade-tier`. (4) **Soft claims:** when an expandable module is placed, the area it can grow into gets a placement/routing cost for anything else (a weight, not a hard block). Schedule: soft claims with the planner work (backlog B9); partial-then-finish and in-place upgrades after M5 (M6 where in v1 scope; steel furnaces need steel, so post-v1 per D20). |
| D49 | Reconciler remedies (2026-10-15, user decision on P21) | P21 approved, including the D28 exception: the crew re-place missing **belts and poles** (never machines). **Belt capacity** (D24 tier upgrade / parallel route) is decided **only in planning**, and only when adding a consumer or producer would take an edge above its limit (D25); the reconciler never upgrades a belt at runtime. The reconciler **runs from the start**, but nodes supplied by the crew by design (hand-fed labs before automated science) are expected: neither reported as problems nor remedied. |
| D50 | Planner weights as settings (2026-10-16, user decisions via the manager) | (1) The placement soft-claim weight (B9, D48 (4)) is a setting, **default 0.5** (`planner-placement-soft-claim`); the planner must work at 0.5. (2) Also settings, current values as defaults: the least comparison work `planner-compare-min-work` (5,000), router `planner-router-bundle-factor` (0.9) and router `planner-router-soft-claim` (0.5). The work-count tolerance (15%) and the reference-base size stay tooling, not settings. (3) P23 approved: the D36 / B2 comparison reroutes the same placement. (4) The splitter comparison (B2) gets an enable setting `logistics-splitter-compare`, **default off**; the code stays. |
| D51 | Buffers, D36 per attempt, bootstrap on production patches (2026-10-16, user decisions via the manager) | (1) P25 changed: module buffer depots hold **2 slots** (`module-buffer-slots` default 2) and go on **smelter columns, circuit blocks and gear rows** (change their layouts as needed). (2) P29 approved: a plan that fails to route without undergrounds but routes the same placement with them defers to `logistics` at once. (3) Bootstrap mining sites **may be placed on a production outpost's ore patch**, as long as they can be deconstructed when something more important needs that ground (as D43 does for depleted sites). P26 (temporary factories on by default?) is pending: the user is checking it in game. |
| D52 | Whole-patch mines (2026-10-17, user decision via the manager; approved) | User: "mines should be designed in a way to be maximally efficient, covering the entire patch, always. its still fine to only build a part of it first, but it should be expamdable. sometimes I see power poles blocking mine expansion". (1) Every mining outpost's planned layout covers the whole ore patch (or the part of it the outpost claims) at maximum drill coverage. (2) It may be built partially first, then expanded in place. (3) Nothing else may be placed on the unbuilt part of that planned footprint: no poles, no routes, no other modules, no bootstrap sites (D51 (3) eviction still applies to bootstrap sites). Poles must avoid the reserved footprint, or be moved when expansion needs the ground (a user-observed bug). Supersedes L3 (now B21). |
| D53 | Factory-graph navigation (2026-10-19, user decision) | The in-game factory graph is an **exact module-to-module topology**, not an item-level aggregate. Every logical node remains individually identifiable even when several nodes have the same role or output item, and every displayed relationship preserves its actual `from` and `to`; the GUI must never imply a shared stream or all-to-all connectivity that is absent from the logical graph. The primary view is a deterministic left-to-right topology with explicit fan-in/fan-out, plus selection-based focus: selecting a node highlights only that node, its direct neighbours and their exact edges, while an inspector lists each incoming and outgoing edge separately and lets the user traverse to the neighbour. “Show all” restores the full topology; “Locate selected” opens the physical base context. Initial implementation does not collapse nodes. Any later collapsing may combine only structurally equivalent nodes with identical neighbour sets and must remain expandable. See B40. |
| D54 | Steam-block coal: hand-fed, then electric mines (2026-10-19, user decision, approved in-session) | User: "the burner miners should be replaced by the electric miner system … when power plants lack coal, they should be fueled by hand, putting in an entire stack. We can skip the burner mine and belt going to the power plant." Answers to the follow-up questions: (1) **Plant fuel:** "Hand-feed until electric. However, if power goes out, that would create a spiral, so hand feeding is the backup." A steam block gets **no coal outpost or fuel belt before electric mining drills are researched**; the crew hand-feeds its boilers. Once electric drills are researched, the design plans the steam block's coal supply as an electric mine with a belt, and hand-feeding stays on as the backup (an outage stops the electric mine that would refuel the boilers). (2) **Scope:** factory outposts only; bootstrap burner sites (D43) stay. Once electric drills are researched, a built factory outpost that uses burner drills is replaced, one at a time and only while no plan runs, by an electric one (the P36 relocation path: given up, out of the layout and graph, re-planned by the design). (3) **Trigger:** a boiler is refuelled only when its fuel slot is **empty**, with a **whole stack** of the fuel item (stack size from game data). (4) **Coal source:** the existing haul sourcing (depot or any supply). Supersedes P36 (a)'s hand-fuelling rule (no longer skipped while the fuel producer grows; boilers no longer use the FUEL_LOW/TOP thresholds). |
| D55 | Depleted mines (2026-10-20, user decision, approved in-session; exception to D28) | Asked how a worked-out factory mine should be handled, the user chose "Claim more of same field": "A worked-out mine claims the next free part of its own patch and is rebuilt/extended there, keeping its output route; only when the patch is exhausted does it move to another patch." A strip outpost still first expands in place (D52). A completed whole-patch mine whose ore under its drills is used up re-plans its mine over the free part of the same patch it can reach (at most as many drills as its whole-patch plan, its output port kept and its route re-laid); this is accepted only when the new drills cover more ore tiles than the current ones still do. When the patch has nothing better left (or a strip has no ore left in its growth area), the mine is given up (the P36/D54 relocation path: deconstructed, out of the layout and graph) and the design plans the producer again on fresh ore. A relocation waits while a plan is in flight or a goal builds a connection from the mine. |
| D56 | Radar (2026-10-20, user decision, approved in-session; was P41) | The user: "We can keep the existing chunk generation exploration system, and just have them place a radar for realism for a human player observing." Plans keep using the chunks the planner asks the engine to generate; once a radar can be built and the faction has power, it places one radar at its base. The radar is for show (a player-like base): no plan depends on what it charts. |
| D57 | Faster mine site search (2026-10-20, user decision, approved in-session; was P42) | The user approved P42 (a)-(d): "Go with the proposed spec to make the mine search faster. 1, 2, 3, 4." (a) A **patch index** of free ore (not built over, not in a drill area or mine claim) ranks the patches a new mine may use; the window search runs only over a patch's box plus a margin. (b) A summed-area pre-check skips patches and windows without enough free ore for one drill area. (c) A patch found to have no room is remembered until the ground near it changes (terrain rescan). (d) A new patch's mine is laid out by the D52 whole-patch planner. Ranking (asked in-session, the user chose "New field costs +50"): a patch where the faction already has a mine is preferred over opening a fresh field unless the fresh field is 50+ tiles closer (setting, magic-numbers table). Each consumer still gets its own mine (point-to-point, B33). |
| D58 | Long routes and the planner budget (2026-10-20, user decision, approved in-session) | Shown that seed 3333's far-mine routes took ~3.6M router expansions, the user chose: "Let's do two-level routing for long distances and do (3), but in a flexible way where any planning entry can take the entire mod's budget if there is nothing competing. Otherwise, they share." (1) A connection whose ends are `longRoute` (128) tiles or more apart is routed over `coarseCell` (8) tile cells first, then tile by tile inside a corridor of those cells (`corridorCells` 1 around the path, one more at the ends) with a weighted heuristic (`corridorWeight` 1.5); with no way through the corridor, the whole window is searched. (2) `planner-work-per-tick` is the whole mod's planner budget: the plans running share it equally, work one leaves passes to the next, and one plan alone gets all of it (default raised 100 → 400). |
| D59 | Soft-claim cost by growth unit (2026-10-20, user decision, approved in-session) | B52: a route crossed the steam block's next growth unit for 0.5 a tile. The user: "I would set it to 10 or so depending on testing which can be done later. What would be even better, is have it diminish a bit every after every single expansion unit, so there more incentive to not block the most immediate and closest to expansion units." The router's soft-claim cost (`planner-router-soft-claim`) defaults to **10** (was 0.5, D50) for a tile in another module's next growth unit, multiplied by `planner-router-soft-claim-decay` for each unit farther out. The decay's default **0.5** is the agent's choice from a replay sweep (proposed; the user asked for "a bit"): an underground crossing pays only its ends, and on seed 3333's g20 replay 10 / 0.55–0.8 still put 4 underground ends in the next unit. Placement's soft-claim weight is unchanged. |
| D60 | Site-retry pause (2026-10-20, user decision, approved in-session) | B53: a goal whose module finds no site in its region (e.g. no shore for a steam block) failed all its plans and an identical goal started at once, forever, spinning the planner. Proposed a back-off; the user: "Yeah the 5 minute backoff is fine" and "it should also log pretty clearly so we aren't surprised later". After a goal fails all its plans with "no … site in the region", goals of its kind wait `factory-site-retry-minutes` (default **5**, 0 = retry at once); the pause and its end are logged as "SITE RETRY PAUSE (B53)" and shown in the factory's waiting list. |
| D61 | Power first (2026-10-21, user decision, approved in-session) | B54: a goal that re-laid a built module's pole line placed the new poles among its other work and left the module unpowered for 25–30 game-min. The user: "make placing any new power networks the first priority". A factory build's electric-pole place jobs (new, re-laid and module poles), hand-crafts of poles and the gathering of their materials (wood) get `factory-power-build-priority` (default **150**; the bootstrap's highest is fuel 100), never below the build's own priority. |
| D62 | Radar exploration arms (2026-10-21, user decision, approved in-session; extends D56) | Seed 46464 failed at ~115 game-min: the only copper patch within 384 tiles was mined out and nothing looked farther. The user: "what should happen in a case like this is what a normal human player would do. They would string a power line out into the distance, placing down a radar so the area is explored." (1) **Home zone:** within 3 × `scan-radius` (384 tiles) of the hub, plans and the bootstrap keep generating and scanning chunks themselves ("Keep the cheaty scan for the home base, since failures would be unrecoverable at that stage of the game"); the plan region ladder is capped at the same radius. Beyond it, the planner knows only chunks the faction's force has charted (radars, `on_sector_scanned`) and ground its crew explores while building (2). (2) **Trigger and arms:** when a mine module finds no free patch of its ore, the faction builds a **radar outpost**: one radar module plus a pole line from the base network, on one arm (N, E, S, W round robin, one outpost at a time). The first outpost of an arm goes ~400 tiles from the hub, each later one ~200 tiles farther along the arm. The crew explores the strip of the pole line and the radar site as it builds ("The player should just explore the terrain while building it"); a cliff or water at the spot moves the radar a little. (3) **Next arm:** once the new radar's nearby square is charted and scanned and still shows no usable patch, the next arm gets an outpost; earlier radars keep sector-scanning and a patch they find later is used by the next retry. Outposts stay (a later mine reuses the pole line). (4) **Search:** one mine search over the home square plus all charted ground, patches still ranked by distance from the hub. Ore found far away gets a plain mine with a long belt to the existing smelters ("Keep using belts for this implementation even though pathfinding will be rough"); remote outposts with trains are a later phase. (5) **Waiting:** the blocked goal waits on "exploring" and does not count toward fail-fast; in a normal game exploration goes on forever ("shouldn't fail in a normal game, just go forever, since eventually it will run into a success"). Soaks fail fast after 1 game-hour stuck exploring. Distances are agent guesses the user accepted ("Spacing is fine"); listed in the M6 report's magic numbers. **Radars (P43 → (a), the user in-session 2026-10-21: "go with (a)"):** a radar charts nothing for a force with no players (our factions), but its sector scan still runs and raises `on_sector_scanned`: each scanned chunk becomes known ground for the faction's plans, and a powered outpost radar's nearby square counts as explored at once. |

## 3. v1 Definition of Done

All three must hold:

1. **Sustained throughput:** from a fresh random seed (vanilla, biters off), each faction with the default crew
   reaches **≥ 30 red + 30 green science/min sustained over 30 game-minutes** within **8 game-hours**.
   The target must pass on **≥ 9 of 10 fixed CI seeds** and **≥ 18 of 20 random seeds**.
2. **Research:** each faction autonomously researches **every red/green technology reachable without steel
   production or crude oil** (D30). The set is derived from prototypes at runtime, never hardcoded
   (`mod/src/strategy/research.ts`). A technology is in it when it is not hidden, all its prerequisites are in
   it, and either (a) every research-unit ingredient is one of the configured packs (`research-science-packs`,
   default red + green), or (b) it is a trigger technology whose trigger is a plain craft/build/mine trigger on
   something not in `research-excluded-triggers` (default `steel-plate`, `crude-oil`). Orbit, space-platform,
   spawner-capture and scripted triggers are out. In vanilla 2.0.77 that is **42** technologies: 39 researched
   with packs plus the `steam-power`, `electronics` and `automation-science-pack` triggers. It excludes
   `steel-axe` (craft 50 steel plates), `oil-processing` (mine crude oil) and the 22 pack technologies behind
   it. A T2 test pins the count.
3. **Looks like a player base:** timelapse renders are approved by the user in the final v1 milestone report.
   Modules should be recognisable, belts tidy, and there should be no belt spaghetti through other modules.

Also required throughout:
- **No permanent stalls.** A stall is no planner progress for 15 game-minutes. Any stall must be detected,
  logged with a reason, and recovered from by re-planning.
- **Determinism:** the same seed and config produce an identical state hash at tick N. Save, load and
  continue produces the same hash as an uninterrupted run.
- **Space Age smoke test:** with the DLC mods enabled on Nauvis, the mod loads and an AI crew reaches first
  electricity.

All numbers in §3 are initial guesses. Tune them via the spec-change process (§10) with evidence.

## 4. Non-goals for v1

Out of scope for v1: biters, turrets, walls, combat, faction diplomacy, trains, bots
(construction and logistic), oil and anything past green science, Space Age planets, modded recipe support
(it should be data-driven but is untested), LLM strategist, human–AI interaction UI beyond a debug overlay,
and recruiting new crew members.

## 5. Architecture

```
┌────────────────────────────── per faction (LuaForce) ─────────────────────────────┐
│ Strategy   recipe graph + tech tree → Goals ("12 red sci/min", "research X")        │
│     ↓                                                                               │
│ Base Planner   goals → ModuleInstances on real terrain + belt/pole/pipe routes      │
│     ↓          (LayoutPolicy, module library, sites, A* router, power planner)      │
│ Build Plan     ordered entity placements + deps + material bill                     │
│     ↓                                                                               │
│ Job Board      decomposes into Jobs: gather, craft, haul, place, fuel, clear        │
│     ↓          assigns to crew members (claims, priorities, reach-aware batching)   │
│ Character Controllers (one per body): Action state machines                         │
│                walk(path) · mine(target) · craft(recipe,n) · place(item,pos,dir)    │
│                insert/take(entity,item,n) · pick-up(entity)                         │
└─────────────────────────────────────────────────────────────────────────────────────┘
Shared services: Scheduler (tick budget), Telemetry, Debug overlay, Prototype index
```

### 5.1 Character Controller (the baritone layer)

There are no `LuaPlayer`s. Each crew member is a bare `character` entity on the faction's force.
The controller drives it only through player-equivalent APIs:

- **Walk:** `surface.request_path` (async, the result arrives via `on_script_path_request_finished`). Follow
  waypoints by setting `character.walking_state` each tick. Detect stuck movement and re-path. If the pathfinder finds no path from where the character stands
  (e.g. wedged in the 0.6-tile gap between two machines, which the grid pathfinder treats as blocked), step
  straight to a free spot about a tile away and ask again, up to 3 times, as a player would.
- **Mine:** set `character.update_selected_entity` and `character.mining_state`. Resources, trees and rocks
  are mined at real speed, and products go to the character inventory.
- **Craft:** `character.begin_crafting` uses the real crafting queue and real times.
- **Place:** validate with `surface.can_place_entity` and `character.can_reach`/`build_distance` and the
  inventory count, then remove the item and `surface.create_entity{..., force, raise_built=true}`.
  This is the one place we emulate the player "build" action. Its rule checks must match the player's.
  Filling a ghost runs the same check (ghosts don't collide), then consumes the item and `revive`s the ghost,
  so the entity keeps the ghost's settings, as when a player builds over a ghost.
- **Hand speed:** a placement takes `place-delay-ticks` (default 8) once in reach, `belt-place-delay-ticks`
  (default 3) for belts (D31). Insert, take and pick-up have no extra delay (mining has its real time).
- **Insert / take / pick up:** reach-checked inventory transfers. `take` is strict by default; with
  `allowPartial` it takes whatever is there up to the count, like a player grabbing a stack. Pick-up (mining a
  placed entity) returns the item. Cancelling a craft also cancels the crafts it queued (ingredients return).

M0 is a spike to verify that every one of these works on a character with no attached player.
Fallbacks must still respect parity: the same timing and reach.

Debug options (off by default, never used in acceptance runs): teleport-when-stuck, instant craft, and a
reach multiplier (scales build, reach and resource reach through the character's
`character_*_distance_bonus` fields, the same per-character bonuses research grants).

### 5.2 Job Board (multi-agent)

- A job has `kind`, `target`, `materials`, `deps[]`, `priority`, `claimedBy`, and a `status`.
- Crew members claim the nearest highest-priority ready job. Jobs are batched by locality: a crew
  member places all reachable ghosts from one standing spot.
- Material flow: haul jobs move items between crew inventories and factory chests. In the burner phase,
  gather/craft jobs feed build jobs.
- Planned entities are shown as **ghosts on the faction's force** so humans and renders can see intent.
  Crew members fill them physically.
- Claims are exclusive and all-or-nothing per batch. A failed attempt releases the job with exponential back-off
  and fails it with a reason after `job-max-attempts` (dependents fail too). Transient blocks (a character
  standing in the footprint) and crew death release without spending an attempt. Stockpile takes in flight are
  reserved so crew members don't plan with the same items.
- (M3) Haul jobs come in three payloads: a member's own **haul** of materials for its batch, a **deposit** of what
  it carries into the depot (brain-driven factions empty their pockets between jobs), and a **transfer** that
  moves items from one entity to another. B32 (user, 2026-10-19): a haul takes the batch's materials straight from
  the depot and the faction's **supply points** (bootstrap furnace outputs and chests, a coal pair's surplus, the
  factory's output chests, module buffers), several in one trip, reserved per source; the brain no longer creates
  transfers that shuffle machine output to the depot. Fuel jobs
  also feed ore into furnaces. Deliveries (gather → furnace, craft → depot) insert what fits; leftovers are
  deposited.

### 5.3 Base Planner

- **Real-terrain, compact placement** (replaces the coarse 8×8 grid of ≤ v0.5): placement works on the real
  map and respects obstructions: **cliffs, water, resource patches** (never build over ore the faction will
  need; mining modules are the exception), **trees and rocks** (clearable, at a cost: crew time plus the
  clear job), and the faction's **own existing structures**. Bases are **compact like real play**, grown
  outward from existing production, not modules floating in empty space. The gap between neighbouring
  modules is a reserved **routing corridor** whose width is a **policy parameter** (`LayoutPolicy.corridor`):
  about 1–2 tiles early game, growing later (4, 6, …). The best values are found empirically by tests and
  soak runs (§7), not fixed here.
- **Layout policies (pluggable strategy).** Different game stages and conditions need different layout
  designs, so layout is a `LayoutPolicy` chosen per faction from the stage and conditions (terrain, free
  space, researched tech):

  ```ts
  interface LayoutPolicy {
    id: string;                          // "early-compact", "mid-blocks", …
    applies(ctx: LayoutContext): number; // suitability score for stage/terrain/free space/tech; highest wins
    corridor: { min: number; preferred: number };      // tiles between modules
    moduleSelection: { preferGenerated: boolean; variants?: string[] }; // generator vs curated, variants
    packing: "compact-cluster" | "blocks" | string;    // packing strategy (registered function)
    expansion: "expand-first" | "new-module-first";    // grow an existing module (ModuleDef.expand) vs place a copy
    obstacles: { trees: "clear" | "avoid"; rocks: "clear" | "avoid"; maxClearCost: number };
  }
  ```

  Policies are **data plus small registered strategy functions** (packing, scoring), selected through config
  (§5.7: a per-faction `layout-policy` setting, `auto` by default, or a remote-interface override), so new
  policies can be added without touching the planner and **A/B-tested in soak runs** whose scorecards
  compare policies (§7). v1 ships at least an **early-game compact policy** (compact cluster around existing
  production, 1–2-tile corridors, expand-first, clear trees/rocks under a cost cap).
- **Sites:** modules with `site` set are anchored by terrain (steam block at the shore, mines on a patch).
  Resource patches get mining modules (drills → belt) sized to the needed rate. The smelting and
  production core sits near the patches and grows outward.
- **Router:** A* on tiles with belts, undergrounds (respecting max length) and turns. Belts between modules carry
  one item type (D23, §5.8), so the router does not preserve lane assignment between modules. It only respects
  which side of a port a belt must arrive on (`Port.side`). Rip-up-and-reroute when a route fails. Routes must not cross module footprints.
- **Power:** steam power module(s) sized to the demand, plus a pole-network planner (MST over consumers,
  pole reach-aware).
- **Splitting and merging:** splitters for fan-out to multiple consumers.
- **Incremental expansion:** existing modules are never torn down in v1, only added. Growth either
  **expands an existing module** along its declared axis (`ModuleDef.expand`, e.g. lengthen a smelter column)
  or places a new copy; the active `LayoutPolicy.expansion` decides which is tried first.

### 5.4 Module Library

Module = a blueprint plus metadata:

```ts
interface ModuleDef {
  id: string;                  // "smelt-iron-24f-yellow"
  source: "curated" | "generated";
  provenance?: string;         // save name / URL / author, for attribution
  footprint: { w: number; h: number };
  entities: BlueprintEntity[]; // normalized to origin, north-facing
  ports: Port[];               // where belts/pipes/power attach
  recipe?: string; machines: { name: string; count: number }[];
  rates: { inputs: Rate[]; outputs: Rate[] }; // items/s at full speed
  requiresTech: string[];      // must be researched before use
  rotatable: boolean;
  site?: "shore" | "resource-patch"; // terrain-anchored modules (steam block at the shore, mines on a patch)
  params?: Record<string, number>;   // generator parameters (e.g. furnace count) for source = "generated"
  expand?: ModuleExpand;             // makes the module auto-expandable (a curated module promoted to a generator)
}
interface ModuleExpand {
  unit: { footprint: { w: number; h: number }; entities: BlueprintEntity[] }; // the repeatable slice
  axis: "x" | "y" | ("x" | "y")[];   // growth direction(s), in module-local coordinates
  maxUnits: number;                  // cap (belt throughput, corridor length, …)
  perUnit: { rates: { inputs: Rate[]; outputs: Rate[] }; machines: { name: string; count: number }[] };
  ports: "shift" | Port[];           // ports move with the far end ("shift") or are given per unit
}
interface Port { id: string; kind: "belt-in"|"belt-out"|"pipe-in"|"pipe-out"|"power"|"chest-out";
  pos: {x:number;y:number}; dir: Direction; item?: string; // single-item (D23)
  side?: "left"|"right"; } // which side a belt must arrive on (side-loading), if it matters
```

Fields added in M4a (accepted by the user 2026-10-14, M4a proposal P2; the code's `mod/src/modules/types.ts` is
the reference):

- **Port kind `chest-out`:** a chest the crew empties (malls). `power` is a small pole *inside* the module: **modules
  carry their own small poles** (periodic, so growing never moves one), and the planner's pole network connects to
  the `power` port.
- `generator` (generator name for generated modules), `recipes` (every recipe run inside), `mirrorable` (false when
  the layout depends on handedness), `notes` (normalisation notes).
- **`anchor`** for site modules: `water` rectangles (shore: must be water, the footprint land) and `miningAreas` +
  `resource` (patch: drill mining areas that must cover ore).
- **`upkeep.fuel`:** burners the crew must refuel by hand (not fed from a port).
- **`Rate.kind`:** `item`, `power` (`electricity` in W) or `research` (`research-unit`/s).
- **`ModuleExpand.insertAt`:** the coordinate on the axis where units are inserted (entities and ports beyond it shift).

Pipelines (`tools/modules/`, Python or TS, run offline):
1. **Import** from three kinds of source. Every module records `provenance`.
   - **Blueprint library:** `~/.factorio/blueprint-storage-2.dat` is an undocumented binary format. No 2.0
     parser decodes blueprint bodies (a Go decoder reads the book structure and labels only). A mod can export
     the library through `LuaPlayer.blueprints` / `LuaRecord.export_record()`, but **only in the graphical
     client**: headless has no player library. The export mod exists on `proto/module-sourcing`
     (`tools/modules/library-export-mod`). The library holds 195 blueprints (5 large late-game builds plus a
     ~190-blueprint balancer book) and **no early-game modules**, so it is not a module source. The balancer
     book may help the router later.
   - **Built bases in saves:** load the save with a dump mod, export entities, and cluster them into candidate
     modules (connected components of machines + inserters + belts by recipe). Proven on
     `proto/module-sourcing` for furnace columns, assembler rows and direct-insertion chains.
     **2.0.77 refuses saves older than 1.0** (its minimum map input version is 1.0.0). Pre-1.0 saves need
     conversion through official 1.1 headless first (and maybe 0.18 before that, if 1.1's own minimum input
     version is above 0.17). Old headless builds are downloadable from factorio.com; no Steam beta is needed.
     Save inventory (versions verified by loading where marked ✓, 2026-10-14):

     | Save(s) | Version | Mods | Use? |
     |---|---|---|---|
     | `My First Base*`, `My First Based1–13*`, `MyFirstBase14/15/15.2` | 0.16–0.17 (`MyFirstBase15.2` is **0.17.43** ✓) | vanilla | yes after 1.1 conversion (latest of the series first) |
     | `Caden`, `Mazeorio` | 0.16–0.17 (unverified) | vanilla | yes after 1.1 conversion |
     | `1.17 Base` (**0.17.34** ✓), `Kevins Base` (**0.17.68** ✓), `Multiplayer`, `Campain` | 0.17.x | vanilla | yes after 1.1 conversion |
     | `FactorySimulator2024` | 1.1.109 ✓ | QoL only (YARM, helmod, Bottleneck…) | yes: loads directly, 131k entities (megabase-ish; machine tiers need downgrading) |
     | `minecraft` | 2.0.47 ✓ | aai-loaders + QoL | **no**: it has no crafting machines |
     | `space-exploration` (actually Space Age) | 2.0.28 ✓ | Space Age | yes, loads without `space-age`; Nauvis early-game builds only |
     | `The modded planet` | 0.16–0.17 (unverified) | alien-biomes (cosmetic) | yes after 1.1 conversion |
     | `warptorio`, `warp drive` | 2.0.47 | warp gameplay mods | no |
     | `py`, `_autosave1–3` | 2.0.76 | Pyanodon | no (recipes changed) |
     | tutorial/campaign autosaves | 0.17 | campaign | no |

     The dump format is version-independent JSON. Old layouts need **normalization to 2.0** (entity renames,
     which 2.0's own migration does on load, plus recipe and ratio checks) and to v1 tech (AM1, stone
     furnaces), which changes rates. Validation (step 4) is the final judge.
   - **Online:** factorioprints, factoriobin and similar sites are fine for prototype modules. **Attribution is
     mandatory** (author, URL, licence if stated) in `provenance` and in `data/modules/ATTRIBUTION.md`.
2. **Tag:** infer ports automatically: belts leaving the footprint and the item type from the recipe. A
   human-readable review file is produced for anything ambiguous.
3. **Filter:** drop modules that need tech beyond v1 (bots, beacons, modules, oil).
4. **Validate:** every module gets an in-game test. It is stamped into a lab, fed exactly its declared input rates,
   and once its outputs reach a steady state it must reach ≥ 90% of its declared output rate (malls: of the plate
   value of all products, plus a product-coverage run). See D33.

**Sourcing recommendation for M4** (from `docs/reports/proto-module-sourcing.md` on `proto/module-sourcing`):
curated modules come mostly from **curated early-game blueprints on factorioprints** (small, tileable,
designed ports; attribution recorded, licence "none stated"), plus **smelting columns and intermediates
harvested from saves**, plus the **parametric generators** below. Everything goes through the same
tag → filter → in-game validation gate.

**Module catalog** (estimate: `docs/analysis/module-catalog-estimate.md`):

- A module is a **production unit**, and it may fuse several recipes: smelter column, steam block
  (pump + boilers + engines), red science line (gear → red), green science line (the whole chain from plates),
  circuit block (cable + circuit, 3:2), lab array, mall. Pole networks, pipes and belts between modules belong
  to the planner, not to modules.
- **Parametric generators are first-class**, not just a fallback: about 7–8 for v1 (mine outpost, smelter
  column, steam block, red line, circuit block, lab array, crew depot, and the green line on a template). Only
  about 2–3 layouts are curated: the green-science template, the mall and maybe the steam-block pipework.
  A generic "N assemblers in a row, input belt / inserters / output belt" generator still covers any recipe
  without a module. Generated modules go through the same validation.
- **Generators vs curated modules:** generators are the **default for simple recipes at any stage**, early or
  late. Curated modules are used where a generator can't express the layout (the green-science template, the
  mall, tricky pipework). During planning a curated module can be **promoted to a generator**: when it declares
  `expand` (a repeatable unit plus expansion axis/axes, a unit cap and per-unit rates and ports), the planner
  can grow it in place (e.g. extend a column) instead of placing another copy.
- **Scale by replication, not size variants:** each module defines one base unit (e.g. 12 furnaces, 5 red
  assemblers, 6 green assemblers) and the planner places k copies. Parameter tiers exist only where
  granularity matters (smelter 6/12/24, steam 1–4 boilers).
- The **mall is one fused module** (about 10 AM1 with gears and circuits made inside, fed by iron and copper
  belts) that outputs to **chests the crew empties**. No filter inserters are needed.
- **Belt lanes:** mixed lanes (ore + coal for a smelter column, red + green for a lab array) exist only **inside** a
  module or generator, which merges single-item inputs at its boundary. Ports are single-item and belts between
  modules carry one item (D23, §5.8).
- **Site-anchored modules:** `ModuleDef.site` says where terrain fixes the placement (§5.3 Sites), so the planner
  places them by terrain rather than by the packing strategy.
- **Wood** for small electric poles is not a belt resource. The crew gathers it (gather job on trees).
- **Growth after v1 is roughly linear:** about 18–25 distinct modules through blue science, and about 40–60
  through the rocket.
- **No steel production in v1** (D20): steel and everything that needs it are modules of a later tier.

### 5.5 Strategy

- **Prototype index:** read recipes, techs and entities from `prototypes` at init. No hardcoded vanilla names
  except in tests and config defaults.
- **Goal graph:** from the target (e.g. 30 red + green/min) compute the needed rates and walk the recipe graph
  back to raw resources. Then diff against the current production and emit build goals.
- **Phases:** burner bootstrap → first electricity → automated smelting → automated red → labs and
  research → green. These phases come out of the graph and current tech, not a script. Scripted heuristics
  are allowed only for the burner bootstrap if the planner can't express it cleanly. Document them if used.
- **Research queue:** choose techs that unblock goals first, then the remaining red/green techs.
- **Burner bootstrap (M3, `mod/src/strategy/bootstrap.ts`):** the first, simple strategy layer. Each faction's
  brain runs every `brain-interval-ticks` (30) and turns goals into Job Board jobs; the crew does everything
  physically. Entities and items come from prototypes (`strategy/catalog.ts`: the cheapest hand-craftable burner
  drill, burner furnace and chest, the fuel = a resource product with a fuel value, ore → plate furnace recipes).
  Scripted heuristics (allowed here, documented):
  - **H1 goal list:** a depot chest, then burner sites interleaved by resource (lowest built/target ratio first,
    targets from `bootstrap-sites`, default `iron-ore=8,coal=4,stone=2,copper-ore=4`). A fuel resource gets
    self-feeding drill **pairs**, an ore gets a drill feeding a **furnace**, anything else a drill feeding a
    **chest**. The first-electricity kit (`first-electricity-items`, default offshore pump, boiler, steam engine,
    10 small poles) comes once every resource has half its sites; the remaining sites follow.
  - **H2** at most 2 goals in progress, so materials go to the earliest goals.
  - **H3** everything gathered or crafted goes to the depot; crew empty their pockets there between
    jobs. Craft jobs take raw materials; the crafting queue makes intermediates.
  - **H4 demand-driven production:** the materials of active jobs and the goal's items are the demand. A
    shortfall beyond what the depot and the supply points hold (B32: the crew takes from them directly) is met by
    temporary cells, then hand-crafting, then hand-mining (ore goes
    straight into a furnace of its kind), with at most one hand-mining job per crew member.
  - **H5** burners are refuelled below 2 minutes of fuel, up to 8 minutes. Outputs are taken by the jobs that need them (B32), never moved to the depot.
  - **H6** sites go on the patch chosen by distance and size from the depot, on the patch tiles nearest it,
    facing it, one tile apart, on tiles free of trees, rocks and active hand-mining.
  - **H7 exploration:** when a needed resource (or trees) has no known patch, the area around the base is
    generated 64 tiles farther (up to 3 × `scan-radius`) and rescanned. Past that home zone, radar outposts explore (D62).
- **World knowledge:** crew don't chart. At start the chunks within `scan-radius` (128) of the base are generated,
  as for a player exploring, and scanned into resource patches (clusters of one resource, tiles within 2 of each
  other); exploration (H7) and replanning rescan.
- **Stall detection:** progress = plan steps (a goal done, a site part placed, a plan craft done). No progress for
  `stall-ticks` (54000 = 15 game-minutes) logs a stall with a reason (current goal, what the plan waits for,
  failure reasons since the last progress, job counts) and **replans**: every job is dropped, unbuilt site ghosts
  are removed (partly built sites keep their built part and re-plan the rest), the surroundings are rescanned and
  planning starts again from what exists. A stall counts as recovered at the next progress.
- **Space Age compatibility (verified against 2.0.77 data, 2026-10-14):** Space Age does **not** change the
  ingredients of any red/green-chain recipe. It does move belts, undergrounds and splitters into a
  `pressing` category, and electronic circuits and electric poles into `electronics`. So the planner must
  resolve "which machine can craft this" through recipe category → entity `crafting_categories` (and the
  character's own categories for hand-crafting). It must never assume `crafting`.

### 5.7 Configuration

Default to configurable (D18). Settings live in three places:

- **Map/startup settings** (`settings.lua`, startup or runtime-global): faction count; crew size per faction;
  spawn placement mode (`auto-distance` | `fixed-offsets` | `random-ring` | `scenario-defined`) with a minimum
  distance from players and between factions (default 450 tiles, D44) and a resource-richness check radius;
  faction names and colours; diplomacy defaults (neutral in v1); player-parity toggles (debug only:
  teleport-when-stuck, instant-craft, reach multiplier); planner targets (SPM goal, which science packs);
  layout policy per faction (`auto` or a policy id, §5.3) and policy parameters such as corridor widths;
  per-tick CPU budget; telemetry and render-dump interval; **hand speed** (`place-delay-ticks` 8,
  `belt-place-delay-ticks` 3, D31); the **research goal** inputs (`research-science-packs`,
  `research-excluded-triggers`, D30).
- **Spawning (M3):** `auto-spawn` (default on, never under factorio-test) creates `faction-count` factions on the
  first tick. `spawn-mode`: `auto-distance` (default; with `spawn-starting-area`, the first not-yet-generated spot
  on rings from `spawn-min-distance` becomes a map-gen starting point (D32); otherwise generated regions are
  searched for a spot with iron, copper, coal and stone within `spawn-resource-radius`, 96), `fixed-offsets`
  (`spawn-fixed-offsets`), `scenario-defined` (only the `spawn_faction` remote). `random-ring` is not implemented.
  With a starting area, a spawn also needs water within `spawn-water-radius` (96), and a starting lake the engine
  generated before the point existed is repainted from the elevation noise (`spawn-lake-repair`,
  `spawn-lake-repair-min-tiles` 50; P17).
  Each crew member gets the freeplay starter items (read from the `freeplay` remote interface when present, else
  the freeplay defaults); factions start with no research.
- **Measurement and reconciler (M5b, §5.8):** `measure-interval-ticks` (300), `measure-window-samples` (12: a 1-min
  window), `measure-probe-ticks` (600), `reconcile-remedies` (on), `reconcile-warmup-ticks` (18000), `reconcile-confirm`
  (3), `reconcile-shortfall` (0.25), `reconcile-cooldown-ticks` (18000), `reconcile-max-remedies` (3). **D35:**
  `layout-smelting` (`compact-core` | `near-ore`; empty = the policy's choice, `compact-core` in `early-compact`).
- **Logistics first (M5c, D36 / B2):** `logistics-underground-min-saving` (50 tiles; 0 = off),
  `logistics-splitter-min-saving` (50; 0 = off), `planner-compare-work-factor` (2: each comparison may use at most twice
  the plan's own routing work).
- **Planner weights (M5d, D50; D59):** `planner-placement-soft-claim` (0.5), `planner-router-soft-claim` (10, D59; was 0.5),
  `planner-router-soft-claim-decay` (0.5 per growth unit, D59),
  `planner-router-bundle-factor` (0.9), `planner-compare-min-work` (5,000), `logistics-splitter-compare` (off).
  B26 (proposed, P38): `planner-placement-growth-band` (4), `planner-placement-growth-band-units` (2),
  `planner-placement-growth-blocked` (3).
- **M6 (v1 target):** `factory-design-margin` (1.1), `factory-lab-sizing` (`mean;max`), `factory-sustain-minutes` (30),
  `factory-shared-providers` (1), `logistics-share-min-modules` (1), `build-stuck-rounds` (10),
  `factory-site-retry-minutes` (5, D60), `factory-power-build-priority` (150, D61).
- **Buffers and bootstrap factories (M5d, D42 / D38):** `module-buffer` (`iron-chest`; empty = no buffers),
  `module-buffer-slots` (2, D51), `bootstrap-factories` (`iron-gear-wheel=1,transport-belt=1,automation-science-pack=1`; empty
  = none), `bootstrap-factory-wait-seconds` (60), `bootstrap-temp-cell-feed-priority` (40, B18; 0 = off),
  `crew-background-crafts` (1; 0 = craft standing).
- **Remote interface** (`remote.call("rival-engineers", ...)`): everything the test harness needs, including spawning
  a faction at a position with a config, pausing a faction, forcing goals, dumping state and reading the
  state hash. Tests and soak runs drive the mod only through this, plus settings.
- **Harness config** (`tools/harness/*.toml`): seeds, map-gen settings, run length, mod config overrides.

Every setting has a documented default that the v1 acceptance runs use. Settings must be read through one
typed config module so tests can override them.

### 5.6 Determinism and engine rules

- All persistent state lives in `storage`. No upvalue or local caches that survive across ticks unless they
  can be rebuilt in `on_load`.
- No `os`, `io`, or wall-clock time. No `math.random`; use `game.create_random_generator` with a seed in storage.
  Lua coroutines are unavailable in Factorio, so long computations are **resumable state machines** run by the
  Scheduler under a per-tick budget.
- Entity references are re-validated (`.valid`) before every use.
- Telemetry output goes through `helpers.write_file` (server-side only, no gameplay effect).

### 5.8 Factory Graph and throughput (interview 2026-10-14)

The planner tracks the whole factory of each faction as a **two-layer graph** stored in `storage`.

**Logical layer: what flows.** Nodes are production units (module instances, each running one or more
recipes; mining outposts; power; labs; sinks such as crew-supplied chests). Edges are item flows with
**planned rate** and **measured rate** (items/s). The planner reasons here: targets, ratios, deficits.

**Physical layer: how it's built.** Nodes are module instances with their **ports**, plus belt
infrastructure: belt segments, splitters, undergrounds and side-load points. Edges are physical connections
with **capacity**, derived from belt tier (yellow 15/s, red 30/s, blue 45/s, so 7.5/15/22.5 per lane) and
from the rates of inserters at the endpoints. Every logical edge maps to one or more physical paths. The
router and throughput checks work here.

**Solver (D21):** a recursive **ratio solver** for v1. The red/green chain has no byproducts or loops.
It sits behind a `Solver` interface so an in-Lua **LP solver** (cf. the Factory Solver mod) can replace it in
P3, when oil cracking and byproducts arrive. Solving is a resumable, tick-budgeted job like all heavy work
(§5.6).

**Topology (D22):** how one producer feeds many consumers is decided by the **LayoutPolicy**. Early
policies use short point-to-point belts. Later policies use per-item trunk lines with splitter taps between
blocks. Policies are A/B-tested in soak runs.

**One item per belt between nodes (D23):** belts transiting **between** graph nodes carry exactly one
item type. Mixed lanes (ore + coal for a smelter column, red + green for labs) are allowed only **inside** a
module or generator, which may merge single-item inputs at its boundary. So module ports are single-item,
and the router does not need lane-preserving routing between modules. It only respects which side of
a port a belt must arrive on. (This replaces the earlier "router must preserve lane assignment" note.)

**Capacity overflow (D24):** when planned demand on an edge exceeds its usable capacity, the planner may:
(1) **upgrade the belt tier** once researched, (2) **add parallel belts / routes**, or (3) **create new
producers and new connections**, building another production cluster sized for future growth rather
than stretching one supply line. Picking between them is a policy decision. Fused modules still use
direct insertion internally; that's a module design choice, not an overflow remedy.

**Utilization target (D25):** edges are planned up to a configurable fraction of nominal capacity,
**default 99%**. Measurement plus reconciliation (below) catches the cases where real throughput
(compression gaps, inserter timing) falls short. Soak scorecards report how often that happens, so the default
can be tuned with evidence.

**Plan vs reality (D26):** nodes and edges store planned and **measured** rates. Measurements are sampled
every few game-seconds (configurable) from machine output counters (`products_finished` deltas), inserter
and belt sampling at ports, and input/output buffer fullness. Per-faction flow statistics are too coarse;
we need per-module numbers. The reconciler classifies each node: *ok*, *starved* (input shortfall,
traced upstream to the root cause), *backed up* (output blocked), *unpowered* or *unfuelled*. A node short only of what the crew
supplies by design (hand-fed labs before their pack is automated) is *expected* (D49): neutral, no root cause, no
remedy. It then
emits replanning goals for the root cause, not the symptom.

**Horizon (D27): staged targets with headroom.** Plan and build for the current stage target (e.g.
30 SPM in v1), but size trunk belts and reserve space and corridor width for the next stage target (default
2×, configurable per policy). Build incrementally toward it.

**Disruption (D28):** deferred to P2. v1 assumes a static world: no rebuilding destroyed modules. The stored graph
plus build plan is what P2's rebuild will use. Exceptions: bootstrap sites are rebuilt on remaining ore (D43), and
worked-out factory mines expand, move within their patch, or are relocated (D52, D55).

**Visibility (D29):**
- **Graph export:** the graph (both layers, planned and measured rates, node status) is dumped to JSON
  next to entity dumps. `tools/render` overlays nodes and edges coloured by utilization (planned vs measured)
  and status.
- **In-game overlay:** a debug setting draws module boxes, edges, rates and node status using the
  `rendering` API in the live game.
- **Factory-graph window (B16, B40, D53):** a per-player GUI screen (`Ctrl+Shift+G`) beside the overlay: an exact
  module-to-module topology laid out by dataflow depth (not real positions). Distinct logical nodes and their
  actual directed edges remain distinct even when their roles or items match. Explicit fan-in/fan-out shows which
  providers feed which consumers. Selecting a node focuses its immediate neighbourhood and fills an exact
  incoming/outgoing edge inspector; neighbour rows traverse the graph, “Show all” restores the full topology and
  “Locate selected” jumps to the module in the physical base. Nodes and edges retain reconciler status,
  measured/planned rates, probe verdicts and cause information.
- **Review toolbar and reports (B35, B34):** the review hotkeys (Ctrl+Shift+I/G/R) are enabled while spectating;
  a top-left toolbar (sandbox and spectators) opens the inspector, the graph window, the overlay with one toggle per
  registered layer, and the report dialog, which writes a diagnostic bundle (`script-output/rival-engineers/reports/`)
  and saves the game (`_autosave-re-report-*`) for a later diagnosis.

**Testing:** T1 tests cover the solver (ratios for the red/green chain against hand-computed values,
e.g. 30+30 SPM → 3.75 Fe/s, 1.25 Cu/s), capacity math and overflow decisions. T2 tests cover measurement
(a deliberately starved module gets classified *starved* with the right upstream cause), and so does a
lab with a deliberately undersized belt.

**Milestones:** the solver and logical graph come with **M5** (planner). The physical layer and capacity
math come with **M4** (routing). Measurement, the reconciler and the overlay come with **M5**, with scorecard
metrics in **M6**.

## 6. Repository layout (target)

```
/docs/SPEC.md            this file
/docs/reports/           milestone reports (Mx-report.md + renders)
/CLAUDE.md               agent operating instructions (points here)
/mod/                    the mod (TSTL src → build/)
  src/{control,strategy,planner,router,jobs,character,modules,telemetry}/
  test/                  factorio-test integration tests
/tools/
  modules/               blueprint import/tag/filter
  harness/               headless runner, seed sweeps, scorecards
  render/                JSON dump → PNG/GIF renderer
/data/modules/           module library (JSON)
/ci/                     GitHub Actions workflows
```

## 7. Test and autonomy infrastructure

| Tier | What | Where | Runtime |
|------|------|-------|---------|
| T0 | Typecheck and lint (TSTL) | cloud + local | seconds |
| T1 | Pure-logic unit tests (router, planner math, job board) compiled to Lua and run outside the game | cloud + local | seconds |
| T2 | In-game integration tests with **factorio-test** on headless Factorio: character actions, module validation, routing in a real world | cloud + local | minutes |
| T3 | **Soak runs**: fresh seeds, N factions, run at high `game.speed` for up to 8 game-hours. Outputs telemetry JSON, a scorecard, a state hash and render frames | local (long), cloud (short) | ~tens of min |
| T4 | **Determinism**: run the same seed twice and compare hashes. Save at tick N, load, run to M and compare against the uninterrupted run | local + nightly | minutes |

- **Headless binary:** use the official headless Linux build in CI (free, no DLC needed for v1). Locally,
  the Steam install at `~/.steam/steam/steamapps/common/Factorio` (2.0.77, Space Age owned) is used for the
  Space Age smoke test. The user's `~/.factorio` is **never** used for test runs. Use an isolated
  `--config`/write-data dir.
- **Soak harness (M3, `tools/harness/soak.py`, `npm run soak`):** per seed it creates a map (`--create`, biters
  off), runs it with `--benchmark` (as fast as the CPU allows) in an isolated write-data dir
  (`.factorio-test/soak/`), stops early once every faction is done, and writes `out/soak/<run>/scorecard.{md,json}`
  plus entity frames for `tools/render/render.py --gif`. Config overrides reach the mod through a generated
  helper mod calling `set_config_override` at map init; telemetry (`telemetry-interval-ticks`) and frame dumps
  (`frame-dump-interval-ticks`) are mod settings, off by default.
- **Scorecard** (per run, JSON + markdown): SPM over time, research completed, stall events and reasons,
  per-job-type time breakdown, ms/tick (avg and p99), entity counts, router failures.
- **Layout policies:** T1 tests for each policy's pure parts (selection by stage/conditions, packing on
  synthetic obstacle grids, corridor widths, expand-vs-new decisions). T2 tests place and route on **real
  generated terrain** (cliffs, water, trees, existing structures). T3 **policy A/B soak runs**: the same seeds
  with different policies (or corridor widths), scorecards compared side by side (time-to-milestone, SPM,
  router failures, clearing cost, base area).
- **Module validation (D33):** fed at 1.0× declared; steady state = after a minimum warm-up, two consecutive groups
  of 3 sampling windows (30 s, 60 s for slow modules) agree within 3% on each output rate (malls: on their plate
  value) and every input port took its full feed over the last group. Warm-up cap 15 game-min (fast) / 60 (slow).
  Then ≥ 90% per output; malls: ≥ 90% of total plate value (measured over 15 min) plus product coverage (20 min,
  chests capped at one slot). Long warm-ups are tagged `validation slow`.
- **Renderer:** top-down schematic with a colour per entity category (belts show direction) and per
  faction. One frame every 5 game-minutes, assembled into a GIF.
- **Regression gate:** a PR can't merge if T0–T2 fail. T3 scorecards are compared to `main`. A >10%
  regression in time-to-milestone must be explained in the PR.

## 8. Milestones

Each milestone ends with a PR and a report (§9). Acceptance criteria are tests, not prose.

| M | Name | Acceptance |
|---|------|-----------|
| M0 | **Foundations and spike** | Repo, TSTL build, factorio-test running headless in CI. Spike proves walk, mine, craft, place, insert and pick-up on a player-less character, or documents the fallback. Renderer produces a PNG from a dump. |
| M1 | **Body** | Character Controller with all actions, path following and stuck recovery. T2 tests: a crew member walks 200 tiles around obstacles, mines 50 iron ore, crafts 10 gears, places a burner drill on ore and fuels it. |
| M2 | **Crew and jobs** | Job Board with claims and batching. Two characters jointly build a ghost layout of 40 entities from a material stockpile, with no double-claims and no idle time over 10% while jobs exist. |
| M3 | **Burner bootstrap** | From a vanilla start, one faction reaches self-sustaining burner mining of iron, copper, coal and stone plus stone furnaces. Done when the "first electricity" materials have been gathered. |
| M4 | **Modules and routing** | Module library pipeline: generators for simple recipes plus curated modules where needed (≥ 10 modules total), at least one curated module with `expand`, all passing validation. The router connects 5 modules in a lab with no crossings through footprints, **and** the early-game compact `LayoutPolicy` places and routes them on **real generated terrain with cliffs, water, trees and existing structures** (not only clean labs). Factory Graph **physical layer** and **capacity math** (§5.8): T1 capacity/overflow tests and a T2 lab with a deliberately undersized belt. |
| M5 | **Power and planner** | Steam power + pole planner. Recipe-graph planner drives a faction from first electricity to automated red science feeding labs, placing and routing on **real generated terrain with cliffs, water and existing structures** through the active `LayoutPolicy`. Factory Graph **solver** and **logical layer**, **measurement**, **reconciler** and **in-game overlay** (§5.8): T1 solver ratio tests, and a T2 test where a deliberately starved module is classified *starved* with the right upstream cause. |
| M6 | **v1** | Green science, full red/green research, multi-faction runs, all of §3 green on the seed sweep, Space Age smoke test, final timelapses for user approval. Conflict repair relocates only the blocked module and its routes (D47). Factory Graph **scorecard metrics** (§5.8: utilization, starved/backed-up node counts, how often measured throughput falls short of plan). |

Later phases (spec them after v1): **P2** biters + defense (turrets, walls, ammo logistics) · **P3**
oil, blue science and bots (crew switches to construction robots) · **P4** inter-faction diplomacy and war
(Biter Battles-style arenas as test maps) · **remote outposts** (trains to far fields, on-site smelting; D62 uses
long belts in v1) · **P5** Space Age · optional **external strategist**
(LLM over RCON) for server-only experiments.

## 9. Agent operating model

- Work milestone by milestone, on branch `mN-<slug>`. Commit freely. Open one PR per milestone.
- **Stack the PRs.** Each milestone branch starts from the previous milestone's branch, not from `main`, and
  its PR targets that branch. Work can continue on M(N+1) while the M(N) PR waits for review. When a lower PR
  merges, rebase the stack onto `main` yourself and retarget the next PR. The user should only ever need to
  review and merge, never resolve conflicts. Keep at most one open PR per milestone. No side PRs for small
  fixes: fold them into the current milestone branch.
- **Prototypes go on separate branches** named `proto/<topic>` (e.g. `proto/headless-character-api`,
  `proto/router-astar`), branched from wherever is convenient. They are throwaway: no PR, no review. Write up
  the findings in the milestone report, and re-implement whatever survives cleanly on the milestone branch
  rather than merging the prototype. Delete stale `proto/*` branches once their findings are recorded.
- **Milestone report** (`docs/reports/MN-report.md`, linked in the PR) contains: what was built, acceptance
  test results, the scorecard summary, renders and timelapse, deviations from spec, **questions for the user**,
  and the plan for the next milestone.
- **Questions don't block.** When the spec is ambiguous, pick the most conservative reasonable option, record
  it under "Assumptions" in the report and keep going. Stop and wait only for decisions that are hard to
  reverse or that change §2 or §3.
- Never weaken an acceptance test to make it pass. Changing an acceptance threshold is a spec change.
- **Long runs belong to the manager (user, 2026-10-19).** A subagent's prompt cache expires after 5 minutes, the
  manager's after an hour, so a subagent never runs or waits on anything that can take longer than about 5 minutes:
  soaks, acceptance rounds, the full T2 suite (parallel or serial, over 5 min since 2026-10-19), benchmarks. It may
  run unit tests and filtered T2 tests (`npm test -- "pattern"`) covering what it changed. For a longer run it commits, returns the exact command and what to look for, and the manager runs
  it and briefs a **new** agent with the result. The manager never resumes a finished agent (user, 2026-10-19).
- **Finishing a task (user, 2026-10-15; amended 2026-10-19).** The working agent runs the unit tests and the filtered T2 tests for
  what it changed on its final code commit, writes its report, pushes and hands off. The **manager** then runs the
  full T2 suite and the single-faction acceptance soak, checks the work-count gate (below), starts the next agent and, in parallel, does the final
  validation: GitHub CI on the pushed commit and the **two-faction soak**. A failure there becomes the first item of the running or next
  agent's work (or a new agent if it is small). Wall-clock numbers from runs that overlap are not
  performance evidence.
- **Performance gates (user, 2026-10-15).** (1) **Work counts** (planner work units, path requests, entity scans,
  jobs, candidates scored, per tick and per run) are deterministic per seed and act as a **soft gate** in every
  validation: a rise beyond a tolerance is flagged in the report, not a hard failure. (2) **Benchmarks** measure AI
  time as a percentage of the update time of a fixed reference vanilla save, benchmarked in the same session, to
  confirm whether a flagged regression is real. The manager runs them when there is time, on an idle machine.
  Absolute ms/tick is informational only.
- Never use the user's `~/.factorio` directory, saves or blueprint file in place. Copy inputs into
  `/tools/modules/input/` first (ignored by git if it contains personal data).

## 10. Spec change process

Propose changes in a milestone report with evidence (scorecards, failing cases). The user approves by
merging the PR that edits this file. Bump the version and add an entry to the changelog below.

## 11. Open questions (for the user)

M5a proposals (P9, P12–P15 still **proposed**; P10, P11, P16 decided 2026-10-15; details and evidence in `docs/reports/M5-report.md`):

- **P9, crafting triggers for the crew (proposed):** the engine does not fire `craft-item` research triggers for a
  player-less character's hand-crafting (pinned by a T2 engine test), so `automation-science-pack` (craft a lab) never
  completes. The controller emulates the trigger for crew crafts, as it already emulates the build action (§5.1).
- **P10, research before automated science (resolved → D38, changed):** until a pack is automated, the crew hand-craft it and put it
  into the labs, but only for technologies that unblock a goal (`automation`, `electric-mining-drill`); the rest of the
  D30 set waits for automated packs (`factory-hand-feed-labs`).
- **P11, stage 1 target and lab sizing (approved → D37):** default `factory-targets` = 10 red/min; labs sized for the mean
  unit time of the research goal's pack technologies (4 labs). M6 adds the 30 + 30 stage.
- **P12, build order of goals (proposed):** power (steam block + its burner-drill coal outpost) → labs → production
  (gated on the research it needs) → mall → growth; one goal planned at a time on top of the faction's layout, any
  number building.
- **P13, material supply (proposed):** the bootstrap economy keeps supplying every build (hand-craft, collect,
  hand-mine); once science is automated, the curated mall joins the design at `factory-mall-utilization` (0.25) and
  its output chests become the first collect source.
- **P14, M5 acceptance milestone (proposed):** "automated red science feeding labs with research progressing" =
  after hand-feeding stops, the labs complete more research units than the hand-fed packs left in them (+5), and the
  red producer made ≥ 10 packs (`automated-red-science`).
- **P15, port approach tiles (proposed, extends D34/P5):** the tile beyond each belt port's outside tile stays reserved
  for that port's route after placement, so later plans cannot box in an unconnected port of a built module.
- **P16, undergrounds when boxed in (resolved → D36, changed):** when a production or mall goal fails every plan attempt
  without undergrounds (belts can't cross; seed 222 rip-up cycled for 2 game-hours), the technology that unlocks the
  underground belt (`logistics`) becomes a prerequisite of those goals and is researched with hand-fed packs like the
  other unblocking techs. Alternative: always research it before the first production plan (shorter, simpler routes
  on every seed, at about 3–5 game-minutes of extra hand-crafting and research).

M5a.2 proposals (2026-10-15, all **proposed**; evidence in `docs/reports/M5-report.md` "M5a.2"):

- **P17, starting-lake repair (resolved → D44, changed):** a new game queues ~10 chunks around the origin for background
  generation before any script runs, so a faction starting point appended there gets its starting ores but not its
  lake. After generating a starting-area spawn, tiles the surface's own elevation noise makes water but that are land
  are repainted (water/deepwater, as map generation would), only when at least `spawn-lake-repair-min-tiles` (50)
  disagree. A starting-area spawn also needs water within `spawn-water-radius` (96), else the next spot is tried.
  Alternative: register starting points only beyond the queued area (spawns ~450+ tiles out instead of ~336).
- **P18, ground claims (approved → D45):** a faction's reserved tiles (bootstrap sites + 1-tile margin, every adopted plan's
  modules + 1-tile margin, routes, poles) are its claim; other factions' planners, bootstrap site placement and growth
  treat them, and other factions' ghosts, as foreign structures. First come, first served. A finished plan whose tiles
  another faction claimed meanwhile (or a foreign entity stands on) counts as a failed attempt. Open: whether margins
  should count for other factions (they cost space where two factions share an ore field).
- **P19, conflict repair (approved → D47):** before a build's retry
  round and before it counts as built, its parts are checked against the world. A route blocked by another force's
  entity is rerouted (old pieces the crew picks up first, then new ghosts); a blocked module or pole gives up the whole
  goal's location (built entities deconstructed, parts dropped from the layout and graph, the design plans it again).
  At most `conflict-max-repairs` (3) per goal. Refinement left for M6: relocate only the blocked module.

M5a.3 proposals (2026-10-15, **proposed**; evidence in `docs/reports/M5-report.md` "M5a.3"):

- **P20, mixed-ore drill spots (proposed, B6):** today a drill whose mining area holds a second ore is never placed
  (mining modules, growth and bootstrap drills; the minimum fix). Proposal for later: allow a mixed spot when the
  module gets a sorting stage (filter inserters or a splitter filter off the line into a belt to a consumer or a
  chest) and its placement cost includes that extra belt length; pure spots win otherwise. Not built: no seed in
  the M5 acceptance set needed a mixed spot.

M5b proposals (2026-10-15, **proposed**; evidence in `docs/reports/M5-report.md` "M5b"):

- **P21, reconciler remedies (approved → D49):** the reconciler acts on three root causes only: an **undersized producer**
  (it runs flat out, everything it makes arrives, its consumer still starves) grows by one `expand` unit; a **broken
  route or pole line** (items pile up at the producer and don't arrive; a consumer without power while the steam block
  has spare capacity) gets its missing pieces re-placed by the crew (a `repair` goal); a **crew-fuelled burner** without
  fuel gets an upkeep pass at once. Belts at their capacity, modules whose own inserters limit intake, depleted ore (D28)
  and low demand are classified and reported but not remedied (D24 remedies stay design-time). Each root cause gets at
  most `reconcile-max-remedies` (3) remedies, `reconcile-cooldown-ticks` (5 game-min) apart, and only after a warm-up of
  `reconcile-warmup-ticks` (5 game-min) since the node and its feeders were built. Re-placing missing route pieces
  touches D28 (no rebuilding destroyed modules in v1): it is limited to belts and poles, never machines.
- **P22, edge flow probes (proposed, extends D26):** a belt edge's measured rate is the flow arriving at the consumer's
  port, counted from belt items' unique ids on that tile (one edge probed at a time per faction, 10 s each), not derived
  from machine counters; node rates come from `products_finished` (crafting machines) or the working share (drills, labs).

M5d proposals (2026-10-16, **proposed**; evidence in `docs/reports/M5-report.md` "M5d"):

- **P25, which modules get a buffer (changed by the user → D51, 2026-10-16: 2 slots; smelter columns, circuit blocks and gear rows):** only **smelter columns**: an inserter in the column's head
  takes plates off the west output belt into an iron chest the crew collects from (before hand-mining or hand-crafting),
  limited to `module-buffer-slots` (1 slot = 100 plates) so it fills up and stops. Not mining outposts (the crew needs
  ore only to hand-feed bootstrap furnaces), not the red line (its packs go to the labs by belt), not the circuit block,
  gear rows or the mall (no free tile on the output belt's side without changing their layouts; the mall already outputs
  to chests), not the steam block or labs. The buffer competes with the column's consumer until it is full (at 1 slot a
  few minutes of half the west row's output). Later: fill it only from surplus with a priority splitter once `logistics`
  is researched.
- **P26, temporary factories (proposed, D38):** a "chest cell" (chest → inserter → assembler → inserter → chest, two
  small poles, 7×3) per product of `bootstrap-factories` (gears, belts, red packs), planned as a goal of its own once the
  steam block is built and assemblers are enabled, joined to the power network by the pole planner. The crew fills the
  input chest and empties the output chest through the bootstrap economy: collect first, then feed the cell (it waits
  for at most `bootstrap-factory-wait-seconds` of the cell's output), then hand-craft the rest. A cell is deconstructed
  (its small poles stay, as later pole lines may run through them) once the mall's chest makes its product, or for packs
  once the pack is automated; it is never rebuilt.
- **P27, opportunistic crafting (proposed, D38):** a crew member that hauls materials at the depot for a batch also
  claims up to `crew-background-crafts` open craft jobs, queues them, does the batch and only then waits for the queue
  (usually empty by then) and delivers the products; a craft job picked first takes the next other work along.
- **P28, soft claims and partners (proposed, D50):** at placement, a module ignores the soft claims of the modules it
  connects to (their ports sit at their growing end, and growth reroutes the connection anyway). With it, 0.5 plans both
  replays that failed in M5c.
- **P29, D36 per attempt (approved → D51, 2026-10-16):** a production or mall plan that fails to route without undergrounds routes the same
  placement with them; if that works, it counts as infinitely shorter and the goal defers to the technology at once
  (instead of after four failed attempts; the four-attempt rule stays as a fallback).

M5c proposals (2026-10-16, **proposed**; evidence in `docs/reports/M5-report.md` "M5c"):

- **P23, how D36 / B2 compare (approved → D50, 2026-10-16):** a production or mall plan made without undergrounds / splitters (their
  technology not researched) routes its *same placement* again with them (routing only, no new placement: at most
  `planner-compare-work-factor` × its routing work, at least 5,000 units). Length = entities placed (belt tiles,
  underground ends, +1 per splitter). Splitter alternative: per item made by several new point-to-point producers, the
  producer nearest to all their consumers is kept and feeds the others' consumers through splitter taps; the dropped
  producers and their own supply chains vanish (the kept one is not re-sized: an estimate). The power node's fuel is
  never tapped (the power goal must not wait for production). When an alternative is at least the setting shorter, the
  goal is given up as *deferred* (not a failure), the technology becomes a prerequisite of production and mall goals
  (hand-fed packs), and after it the goal is planned from scratch (with undergrounds; splitter taps for the recorded
  consumers). A capped or failed alternative counts as no evidence. Alternative: compare full plans (placement too),
  ~10× the extra work.
- **P24, bundling and soft-claim weights (decided → D50, 2026-10-16: settings; placement soft-claim default 0.5, not 0.1):** `RouterWeights.bundleFactor` 0.9 (a tile next to
  another route's belt costs 0.9×); soft claims (D48 (4)) cost 0.5 per tile for routes (a module's own routes are exempt:
  its ports move when it grows) and 0.1 per footprint tile for placement. At 0.5 the placement weight made production
  clusters 10–30% longer in belts and broke two no-underground plan replays; 0.1 is a mild preference.

M6a proposals (2026-10-16/17, all **proposed**; evidence in `docs/reports/M6-report.md` "M6a"):

- **P30, the 30 + 30 stage (proposed, D37):** default `factory-targets` = `automation-science-pack=10;automation-science-pack=30,logistic-science-pack=30`,
  every stage designed at `factory-design-margin` (1.1) × its target so the measured rate reaches it. Green science
  comes from the curated green line (an inserter has three ingredients, no generator makes it); one line makes 0.28/s, so
  the stage splits into two **production clusters** (D24). Cluster 1 keeps the stage-1 roles (its modules grow in place:
  labs, red line, smelters), cluster 2 is new; one steam block serves both. Labs are sized per stage by
  `factory-lab-sizing` (`mean;max`: stage 1 the mean unit time as D37 says, stage 2 the slowest, 30 s, so the labs never
  cap the 30 + 30 rate). Cluster 1's goals come first (power growth, its green chain, its grows), then cluster 2's labs and
  production.
- **P31, how "30 + 30 sustained" is measured (proposed, §3):** packs **consumed by the labs** (force item statistics),
  sampled every game-minute; the bar holds once every pack of the last stage averaged at least its target over
  `factory-sustain-minutes` (30) consecutive minutes (`science-sustained`). With `research-goal-done` that is `v1-done`.
  The scorecard recomputes it from the samples.
- **P32, shared providers (proposed, B19):** from stage `factory-shared-providers` (1) on and once splitters can be built,
  a new consumer of an item first taps a built producer of it that has spare capacity (its planned output minus what its
  edges carry; the steam block's coal outpost included), else the new consumers of a cluster share one new producer; a
  tap on a built route has the crew pick up the belt under the splitter first. Splitters are researched before production
  when sharing saves at least `logistics-share-min-modules` (1) modules (like D36). No distance check yet: a tap may run a
  long belt.
- **P33, when the factory can't grow a module (proposed):** a growth whose expansion fails 3 times no longer holds its
  stage; a steam block that can't grow gets a second one (`power#2`) for the excess, labs a second array (`labs+`).
- **P34, stuck builds and boxed-in crews (proposed, B20):** a build whose leftover ghosts placed nothing for
  `build-stuck-rounds` (10, 30 s apart) gives up its location (a growth is abandoned with what stands); a crew member that
  finds no path 3 times in a row picks up the nearest small entity around it and leaves a ghost for it (a player walled in
  by their own build does the same).
- **P35, bootstrap eviction (proposed, B15, implements D51 (3)):** plans see the faction's bootstrap mining sites as
  clearable ground (like trees); a plan or growth that takes their tiles evicts them: built sites are retired and picked
  up before the build, planned ones dropped, and the bootstrap gets a replacement goal elsewhere. M6a.2 (seed 222):
  the depot is evicted too (an extra depot built over a factory port's approach tiles read as unevictable OWN ground and
  walled the port in for good; the bootstrap rebuilds the depot near the hub), and a retired site releases its tiles as
  soon as it is picked up.
- **P36, coal running out for power and the green clusters (proposed, M6a close-out; hand-off to M6b):** two of the five
  acceptance seeds fail on coal, not on planning. Seed 555555: the first steam block's coal outpost depletes at ~150
  game-min and the steam block starves (D28 defers relocation to P2). Seed 3333: the only coal patch within 168 tiles of
  the hub is ~70% built over (power, bootstrap pairs, earlier outposts) and the new cluster's shared coal outpost has no
  feasible position on four region sizes. Proposed: (a) a depleted (or nearly depleted) coal supply of a steam block
  gets a replacement outpost elsewhere, like D43 for bootstrap sites (an exception to D28 limited to power fuel);
  (b) when a fuel producer can't be placed, the consumers tap the nearest built coal producer and that producer grows
  (or the cluster waits) instead of failing the goal. Not implemented. M6a.2 (seed 222): (a)'s hand-fuelling skips a
  steam block whose fuel producer is currently being grown (the built drills run through the growth) — at the build
  priority it starved the growth's own craft jobs and stalled the stage.
- **P37, no mine-site credit for head growth (proposed, B25):** since B25, `tryExpand(..., "head")` refuses growth that
  would run a belt out of the module, and that covers every mining outpost: its head holds the output port. Placement's
  D52 site check (`firstGrowthCoverage`) still accepts a mine whose only ore-bearing growth unit is at the head.
  Proposed: count the tail only for modules that can't grow at the head. This changes mine placement, so it needs
  replays first. Not implemented (M6 report, M6b.3).
- **P38, growth bands at placement (proposed, B26; M6 report M6b.6):** (a) a module placed in the **near band** of another
  expandable module (its first `planner-placement-growth-band-units` = **2** growth units, on the end `tryExpand` grows)
  pays `planner-placement-growth-band` = **4** per footprint tile on top of the 0.5 soft claim (D50 unchanged); a direct
  partner stays exempt, as from the soft claim (P28): applying it to partners pushed feeders off the smelter's input side
  and broke the seed 11 replay. (b) An expandable non-mining module scores each candidate site by its own near band:
  `planner-placement-growth-blocked` = **3** per near unit that `tryExpand` would refuse there (terrain, ore, other
  modules and their corridor ring, routes, port reservations, interaction tiles, mine and soft claims; units past the
  first refused one count too). Only the near band counts: checking every unit up to the cap (a smelter's band is 20
  tiles deep) and 8 per unit pulled the seed 222 cluster apart and its iron feed failed even with undergrounds. Cost:
  with (b) on, the seed 11 and 3333 stage-1 clusters no longer route **without** undergrounds (a smelter's growth end is
  its input side, which now turns away from ore, so feeds wrap round it); they do route with them, and both seeds decide
  "undergrounds first" under D36 / D51 anyway. Values are guesses tuned on six replays; a soak decides.
- **P39, take from smelter modules' furnaces (decided by the user in-session 2026-10-19: keep the implemented setting, default off, no further work; B36; M6 report M6b.8):** with `supply-module-furnaces` on
  (default **off**), the result slots of built smelter modules' furnaces are supply points too (registered last, after
  buffers and bootstrap furnaces). Their plates pile up when the output belt backs up, but taking them can starve the
  module's belt and its consumers, and the buffer head (D42/D51) already holds the surplus the crew should take. Open
  question for the user: turn it on, or rather raise `module-buffer-slots` (2)?
- **P40, the part of a patch a mine claims (proposed, B33; M6 report M6b.9):** D52 whole-patch plans now apply in every
  plan topology (before, only splitter-tap plans got them, so point-to-point mines stayed strips whose growth claim ran
  off the patch). "The part it claims" (D52 (1)) is: (a) a **shared** (splitter-tap) mine: as many drills of the
  whole-patch grid as its one output belt carries (both lanes; 30 electric drills on iron with yellow belts; a starting
  iron patch holds 67-69), whole lanes nearest the consumer first; (b) a **point-to-point** mine (it only ever feeds
  one consumer): **one lane** of the grid, at most the drills its strip template could grow to (14 for a 1-side
  electric 2-row outpost). Two lanes or more made the second coal outpost of the seed 11 / 3333 stage-1 clusters
  unplaceable (one small coal field). (c) A mine whose plan does not fit (its entities on water, cliffs, other modules'
  ground or claims, its output port facing built structures) stays a strip, and its growth claim stops at the last unit
  whose drills all have ore under them (was: the belt-limited cap, 36 tiles for an electric strip). (d) Strip growth
  needs ore under each new drill's body, not just in its mining area (the whole-patch plan's own test). (e) A partial
  stage starts with drills whose mining area meets `minOreCoverage` (0.6), not on the thin edge nearest the consumer.
  (f) A route that crossed itself is retried with that tile blocked, not just costed. Not done:
  balancing the two lanes of the collector belt (the part is capped at the belt's total).
- **P41, radar exploration (resolved → D56, 2026-10-20):** once a radar can be
  built, the faction places one to discover more of the map passively, like a player. Open: (a) whether plans may
  only use charted chunks (the radar is then the only way to find far fields; today the planner asks the engine to
  generate the chunks of its search region, which is free exploration), or the radar only adds to that; (b) whether
  one radar goes up early at the base or only when the home fields run low.
- **P43, faction radars don't chart (resolved → D62 (a), 2026-10-21):** in 2.0 a radar charts nothing for a force with
  no players: no chart, no chunk generation, and `force.chart` only marks chunks requested. The radar still sector-scans
  (`on_sector_scanned`, one chunk per ~33 s at full power, nearest first in rings, no chunk twice: 53 scans in 30
  game-min reached ring 4). The user chose (a), the scan event as the faction's exploration, over emulating the radar
  in script or counting an outpost's whole reach at once.
- **P42, faster mine site search (resolved → D57, 2026-10-20):** a mine's placement now goes on from a dead ore
  site to the next one (B50), but each site still costs a window search of up to ~430² tiles, 4 plan attempts per
  goal (seed 3333: ~200 s wall per attempt). Proposed: (a) a per-faction **patch index** (connected patches from
  `world/resources.ts` with their free ore: not built over, not in a drill area) ranked by free ore and distance, the
  window search only over a patch's box plus a margin; (b) a summed-area pre-check that skips windows without enough
  free ore for one drill area; (c) remember patches with no room until the ground near them changes (`markDirty`);
  (d) lay out a new patch's mine with the D52 whole-patch planner instead of sliding a template.

Resolved 2026-10-16 (user, via the manager): P23 → D50 (approved), P24 → D50 (weights are settings; placement soft claim default 0.5), splitter comparison off by default (D50).

Resolved 2026-10-15 (user, via the manager): P21 → D49 (belt capacity only in planning, when a new consumer/producer exceeds the limit; belt/pole re-placement OK).

Resolved 2026-10-15 (user, via the manager): P17 → D44 (spawn 450+ tiles out, repair only a fallback), P18 → D45 (margins count if cheap), shared ore fields → D46 (never), P19 → D47 (approved; blocked-module-only relocation in M6).

Resolved 2026-10-15 (user, via the manager): P10 → D38 (changed: temporary chest-fed factories, opportunistic crafting), P11 → D37, P16 → D36 (changed: 50-tile rule), think time → D39 (no slowdown), bootstrap counts → D40 (settings), terminology → D41.

Resolved 2026-10-14 (user, via the manager): M4b proposals P4–P8 → D34; smelter placement question → D35 (policy option, A/B in M6); M4 real-terrain bar accepted.

Resolved 2026-10-14 (user, via the manager): M4a proposals P1 (mall validation) and P3 (validation feed, changed)
→ D33; P2 (ModuleDef schema) → §5.4.

Resolved 2026-10-14: blueprint sources → D19 and §5.4 (agents decide, attribution required). Online sources
are OK. Spawn placement → configurable (§5.7). §3 numbers accepted. CI runner choice → agent decides
(GitHub-hosted for T0–T2, local for T3/T4). Steel in v1 → D20 (no steel production; still researched).

## 12. References

- Factorio Learning Environment (LLM agents via RCON/Python, NeurIPS 2025): https://arxiv.org/abs/2503.09617.
  Lesson: LLMs struggle with spatial layout, so spatial work stays deterministic here.
- Proliferation mod (economy-driven machine faction stamping staged base blueprints): https://mods.factorio.com/mod/proliferation
- AutoPrint (A* belt autorouter with undergrounds plus rip-up-and-reroute): https://mods.factorio.com/mod/autoprint
- BeltRouter: https://mods.factorio.com/mod/BeltRouter
- Towards Automatic Design of Factorio Blueprints: https://research-portal.st-andrews.ac.uk/en/publications/towards-automatic-design-of-factorio-blueprints/
- factorio-test (GlassBricks): https://mods.factorio.com/mod/factorio-test
- Finite Biter Battles: https://mods.factorio.com/mod/finite-biter-battles · Biter Clash: https://mods.factorio.com/mod/biter-clash
- Factorio Lua API: https://lua-api.factorio.com/latest/

## Changelog

- v0.30 (2026-10-21, user decision in-session): P43 → D62 (a): faction radars explore through `on_sector_scanned` (they chart nothing: no players on the force).
- v0.29 (2026-10-21, user decision in-session): D62 (radar outposts on N/E/S/W arms explore past the 384-tile home zone when a mine finds no ore; the home zone keeps chunk generation).
- v0.22 (2026-10-19, user decision in-session): D54 (steam-block boilers hand-fed with a whole stack when empty; electric coal mines for power once electric drills are researched; factory burner outposts replaced by electric ones).
- v0.28 (2026-10-21, user decision in-session): D61 (a factory build's poles are placed and crafted before every other job).
- v0.27 (2026-10-20, user decision in-session): D60 (a goal with no site in its region pauses its kind for 5 game-minutes, logged).
- v0.26 (2026-10-20, user decision in-session): D59 (router soft-claim cost 10 next to a module, lower for each growth unit farther out).
  The router's seal check (a cost-free flood from both ends that proves "no path" when one end is boxed in) is the
  approach the user picked in-session the same day. A retry after "no path" runs it to the end (the user: "if either
  end are enclosed, then consider it done and a fail"); the first search's cap `router.sealCheck` (2000 states) is
  proposed.
- v0.25 (2026-10-20, user decision in-session): D58 (two-level routing for long connections; one planner budget for the whole mod, shared by the plans running).
- v0.24 (2026-10-20, user decisions in-session): D56 (a radar for realism; chunk-generation exploration stays), D57 (faster mine site search: patch index, pre-check, dead-patch memory, whole-patch layout; a fresh field costs +50 tiles).
- v0.23 (2026-10-20, user decision in-session): D55 (a worked-out whole-patch mine moves to the next free part of its own patch; with none left, the mine is relocated and re-planned on fresh ore).
- v0.21 (2026-10-17, user decision via the manager): D52 (whole-patch mining outposts, built partially and expanded in place; nothing else on their unbuilt footprint).
- v0.20 (2026-10-16/17, M6a): §11 P30–P36 proposed (30 + 30 stage and clusters, sustained-throughput measure, shared
  providers, second steam block / lab array, stuck builds and boxed-in crews, bootstrap eviction); §5.7 M6 settings.
- v0.19 (2026-10-16, user decisions via the manager): D51 (buffers 2 slots on smelter columns, circuit blocks and gear rows; P29 approved; bootstrap sites allowed on production patches, deconstructible); P26 pending the user's in-game check.
- v0.18 (2026-10-16, M5d): §11 P25–P29 proposed (buffers on smelter columns, temporary factories, opportunistic
  crafting, soft claims and partners, D36 per attempt); §5.7 planner weight, buffer and bootstrap-factory settings; D49 "expected"
  node status implemented.
- v0.17 (2026-10-16, user decisions via the manager): D50 (planner weights as settings, placement soft claim 0.5, splitter
  comparison off by default); §11 P23 approved, P24 decided.
- v0.14 (2026-10-15, user): §9 task hand-off (manager runs CI + two-faction soak) and performance gates (work counts soft gate, reference-save benchmarks).
- v0.16 (2026-10-16, M5c): §11 P23–P24 proposed (D36 / B2 comparison, bundling and soft-claim weights); §5.7
  logistics-first settings.
- v0.15 (2026-10-15, M5b): §11 P21–P22 proposed (reconciler remedies, edge flow probes); §5.7 measurement, reconciler
  and `layout-smelting` (D35) settings.
- v0.13 (2026-10-15, user decisions on M5a.2 questions): D44–D47; §11 P17–P19 resolved.
- v0.12 (2026-10-15, M5a.2): §11 P17–P19 proposed (starting-lake repair, ground claims, conflict repair); §5.7 spawn water settings.
- v0.11 (2026-10-15, user decisions on M5a questions): D36–D41; §11 P10, P11, P16 resolved.
- v0.10 (2026-10-14, user decisions on M4a proposals): D33 module validation (1.0× feed, steady-state detection,
  mall plate value + coverage); ModuleDef schema additions in §5.4 (chest-out, anchor, upkeep, mirrorable, insertAt,
  Rate.kind, modules carry their own poles); §11 P1–P3 resolved.

- v0.1 (2026-10-14): initial draft from research + interview.
- v0.2 (2026-10-14): stacked milestone PRs; prototypes on throwaway `proto/*` branches (§9, D16).
- v0.3 (2026-10-14): D18 config-first + §5.7; D19 module sourcing + save inventory; Space Age recipe-category note; resolved open questions.
- v0.4 (2026-10-14): project named **Rival Engineers** (`rival-engineers`).
- v0.5 (2026-10-14): §5.4 save inventory corrected from the module-sourcing prototype (verified versions,
  2.0.77 refuses pre-1.0 saves, `minecraft` save unusable, blueprint library is GUI-only and has no early-game
  modules) and M4 sourcing recommendation; module catalog summary (fused production units, first-class
  parametric generators, replication over size variants, lane-preserving router, `ModuleDef.site`, crew
  gathers wood, one fused mall); D20: no steel production in v1 (steel-processing is still researched).
- v0.6 (2026-10-14, user guidance): generators are the default for simple recipes at any stage; curated modules
  can be promoted to generators via `ModuleDef.expand` (§5.4). §5.3 grid replaced by real-terrain compact
  placement (cliffs, water, ore, trees/rocks, own structures) with policy-defined corridor widths. New pluggable
  `LayoutPolicy` (§5.3, §5.7) with policy tests and soak A/B comparison (§7). M4/M5 acceptance now requires
  placement and routing on real generated terrain (§8).
- v0.9 (2026-10-14, M3): burner bootstrap documented in §5.5 (heuristics H1–H7, world knowledge, stall
  detection and replanning); spawning settings in §5.7; D32 faction starting areas via map-gen starting
  points; soak harness in §7.
- v0.8 (2026-10-14, user decisions): D30 research goal = red/green technologies reachable without steel or crude
  oil, computed from prototypes (42 in vanilla 2.0.77; §3.2 rewritten). D31 configurable hand speed (§5.1, §5.7).
- v0.7 (2026-10-14): factory graph + throughput, from interview. New §5.8 (two-layer Factory Graph, ratio solver
  behind a `Solver` interface, topology by policy, one item per belt between nodes, capacity overflow remedies,
  99% utilization target, measured vs planned rates with a reconciler, staged targets with headroom, disruption
  deferred to P2, graph export and in-game overlay); decisions D21–D29; lane-preserving routing between modules
  removed (`Port.lanes` → single-item ports with `Port.side`); M4/M5/M6 acceptance reference the graph work.
- v0.11 (2026-10-14): D34 (M4b proposals P4–P8 approved), D35 (smelter placement as A/B policy option; M4 bar accepted).
