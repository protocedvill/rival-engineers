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
  collects output from a machine (furnace plates, a stone chest, a coal pair's surplus) into the depot. Fuel jobs
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
  - **H3** everything gathered, collected or crafted goes to the depot; crew empty their pockets there between
    jobs. Craft jobs take raw materials; the crafting queue makes intermediates.
  - **H4 demand-driven production:** the materials of active jobs and the goal's items are the demand. A
    shortfall is met by collecting from the faction's machines, then hand-crafting, then hand-mining (ore goes
    straight into a furnace of its kind), with at most one hand-mining job per crew member.
  - **H5** burners are refuelled below 2 minutes of fuel, up to 8 minutes. Outputs are collected on demand only.
  - **H6** sites go on the patch chosen by distance and size from the depot, on the patch tiles nearest it,
    facing it, one tile apart, on tiles free of trees, rocks and active hand-mining.
  - **H7 exploration:** when a needed resource (or trees) has no known patch, the area around the base is
    generated 64 tiles farther (up to 3 × `scan-radius`) and rescanned.
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
  distance from players and between factions (default 300 tiles) and a resource-richness check radius;
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
  Each crew member gets the freeplay starter items (read from the `freeplay` remote interface when present, else
  the freeplay defaults); factions start with no research.
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
traced upstream to the root cause), *backed up* (output blocked), *unpowered* or *unfuelled*. It then
emits replanning goals for the root cause, not the symptom.

**Horizon (D27): staged targets with headroom.** Plan and build for the current stage target (e.g.
30 SPM in v1), but size trunk belts and reserve space and corridor width for the next stage target (default
2×, configurable per policy). Build incrementally toward it.

**Disruption (D28):** deferred to P2. v1 assumes a static world: no ore-depletion relocation and no
rebuilding destroyed modules. The stored graph plus build plan is what P2's rebuild and relocate will use.
In v1, a stall caused by depletion just shows up as a starved node in telemetry.

**Visibility (D29):**
- **Graph export:** the graph (both layers, planned and measured rates, node status) is dumped to JSON
  next to entity dumps. `tools/render` overlays nodes and edges coloured by utilization (planned vs measured)
  and status.
- **In-game overlay:** a debug setting draws module boxes, edges, rates and node status using the
  `rendering` API in the live game.

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
| M6 | **v1** | Green science, full red/green research, multi-faction runs, all of §3 green on the seed sweep, Space Age smoke test, final timelapses for user approval. Factory Graph **scorecard metrics** (§5.8: utilization, starved/backed-up node counts, how often measured throughput falls short of plan). |

Later phases (spec them after v1): **P2** biters + defense (turrets, walls, ammo logistics) · **P3**
oil, blue science and bots (crew switches to construction robots) · **P4** inter-faction diplomacy and war
(Biter Battles-style arenas as test maps) · **P5** Space Age · optional **external strategist**
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
- Never use the user's `~/.factorio` directory, saves or blueprint file in place. Copy inputs into
  `/tools/modules/input/` first (ignored by git if it contains personal data).

## 10. Spec change process

Propose changes in a milestone report with evidence (scorecards, failing cases). The user approves by
merging the PR that edits this file. Bump the version and add an entry to the changelog below.

## 11. Open questions (for the user)

None open.

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
