# M4: Modules and routing

Branch `m4-modules-routing` → `m3-burner-bootstrap` (stacked). M4 is split in two halves on the same branch:
**M4a, the module library** (this part, done) and **M4b, belt router, real-terrain placement and the physical graph
layer** (TODO, see the end). The PR is opened when M4b is complete.

Status of the M4 acceptance (SPEC §8): module library pipeline, ≥ 10 modules, ≥ 1 curated module with `expand`, all
passing validation: **met** (M4a). Router, LayoutPolicy on real terrain, physical layer and capacity math: **M4b, TODO**.

## M4a: module library

### Built

- **ModuleDef format** (`mod/src/modules/types.ts`), TS types used at runtime and by T1 tests, plus the JSON format of
  `data/modules/*.json` (`CuratedModuleFile`: a ModuleDef without its computed fields). Module-local tile
  coordinates (top-left corner (0, 0), entity centres), canonical orientation, single-item ports (D23) with an
  optional lane `side`, `site` + `anchor` (water tiles for `shore`, drill mining areas for `resource-patch`),
  `expand`, `provenance`, `requiresTech`, `upkeep` (burners the crew must fuel), `notes`.
- **Rates are computed, never entered** (`rates.ts`). From prototypes: machine speed / recipe energy, drill speed /
  mining time, lab speed / unit time, inserter throughput (one item per full turn × a calibrated efficiency),
  burner fuel draw, steam (boiler, engine and pump limits), electric demand. Internal intermediates are balanced
  exactly: final machines run at a common fraction of capacity, intermediate makers share demand in proportion to
  capacity (a small LP; the graph inside a module is acyclic). One engine for generated and curated modules.
- **Prototype facts** behind an interface (`facts.ts`): `prototype-facts.ts` reads `prototypes` in game,
  `mod/unit/vanilla-facts.ts` is a hand table for T1. Nothing vanilla is hardcoded in the library itself except
  generator defaults (entity names), all overridable by parameters.
- **Geometry** (`geometry.ts`): footprints, occupancy (overlap check), transforms (mirror then rotate, in the
  module frame) for entities, ports (lane `side` swaps on mirror) and anchors; `portOutsideTile`.
- **Generators** (`generators.ts`, deterministic, from prototypes; parameters: count, belt, inserter, pole, machine):

  | Generator | Layout | Unit (expand) | Inputs → outputs |
  |---|---|---|---|
  | `smelter-column` | two mirrored furnace rows around one belt; ore and fuel enter on separate ports and merge onto the two lanes inside | 4 furnaces | ore, coal → plates/bricks |
  | `mining-outpost` | electric (3×3) or burner (2×2) drills on 1–2 sides of a belt; `site = resource-patch` | 2 rows (electric) / 1 row | → ore |
  | `steam-block` | offshore pump (west, water outside the footprint: `site = shore`), boilers with 2 engines each, burner inserters on a coal belt | 1 boiler | coal → electricity |
  | `assembler-row` | N assembling machines between an output belt and a two-lane input belt; 1–2 inserters per side sized from the recipe | 2 machines | any recipe with ≤ 2 solid ingredients |
  | `red-line` | units of red – gear – red, gears by direct insertion | 3 machines | iron, copper → red |
  | `circuit-block` | C K C K C (3 cable : 2 circuit), each circuit assembler fed cable by 2 inserters from each neighbour | 5 machines | iron, copper → circuits |
  | `lab-array` | pairs of labs, the second fed by the first (lab-to-lab inserter); red + green merged on one belt | 2 labs | packs → research units |

  Each generator places its own small poles in a periodic pattern (growing never moves a pole) and declares
  `expand`. T1 checks `expandModule(gen(n), k) ≡ gen(n + k)` entity for entity, for every generator.
- **Curated modules** (`data/modules/`, built by `tools/modules/curate.py` from specs in `tools/modules/curated/`,
  blueprint strings cached in `data/modules/sources/`, attribution in `data/modules/ATTRIBUTION.md`):

  | Module | Source (factorioprints, licence: none stated) | Normalisation |
  |---|---|---|
  | `green-line-hellpet` | "Science Pack Logistic (green) - 0.18", HellPet | AM2 → AM1, fast → yellow inserters; the two inserters that took plates from the neighbouring tile's bus became belt ports; whole chain from plates (cable, circuit, gear, inserter, belt, 6 science assemblers) |
  | `red-tile-ramqvist` | "Tileable Science Production…" (Automation 1.5/s, gear input), Christoffer Ramqvist | AM2 → AM1, labels and bus undergrounds removed; **declares `expand`** (period 6 rows = 4 science assemblers, max 6 units) |
  | `mall-polse` | "Mall (Early game)", Pølse mølsen | AM2 → AM1, fast → yellow; lamps and two firearm assemblers removed; AM2 (steel) → gears, fast inserter → iron chest, gun turret → burner inserter; the chest buffer at the inlet replaced by iron and copper ports; 12 products into chests (`chest-out` ports) |

  The green line is **not** expandable: its feeder block is not periodic and every cut through it breaks a
  direct-insertion link (recorded in its notes). Grow it by placing another copy.
- **Validation lab** (T2, `mod/src/test/module-lab.ts`, `modules.test.ts`): stamps the module into a cleared lab
  (water and ore created from its anchor), powers it from an `electric-energy-interface` on a pole next to the power
  port (a steam block gets the interface as its load instead), feeds every input port by inserting items at the back
  of a feeder belt outside the port, empties sink belts every tick and output chests every second, refuels the
  crew-fuelled burners (`upkeep`), and measures after a warm-up. Feed: **1.1 × declared** while measuring; during
  warm-up 3 × declared, at least 1.5 items/s per port, to prime buffers (see "Findings"). Runs at `game.speed` 100.
  Test names carry `validation fast:` or `validation slow:` for filtering.
- `stampModule` (real entities or ghosts), `expandModule`, `expandTail`, `expandMoves`, `V1_CATALOG`,
  `curatedModule`, `generatedModule` (memoised per session; derived from prototypes only).

### Validation results (T2, game speed 100, measured / declared)

| Module (catalog entry) | Declared | Measured | % |
|---|---|---|---|
| smelter-column iron, 12 furnaces | 3.75 plates/s | 3.708 | 98.9 |
| smelter-column copper, 4 | 1.25 | 1.250 | 100.0 |
| smelter-column stone-brick, 4 | 1.25 bricks/s | 1.242 | 99.3 |
| mining-outpost iron, 4 rows × 2, electric | 4.0 ore/s | 4.000 | 100.0 |
| mining-outpost coal, 3 rows × 2, burner | 1.5 | 1.500 | 100.0 |
| steam-block, 2 boilers | 3.6 MW | 3.584 MW | 99.6 |
| assembler-row gears, 4 | 3.024 gears/s | 3.600 | 119.0 |
| assembler-row cable, 2 | 3.36 cable/s | 3.425 | 101.9 |
| assembler-row belts, 2 | 3.024 belts/s | 3.425 | 113.3 |
| red-line, 2 units | 0.4 red/s | 0.400 | 100.0 |
| circuit-block, 1 unit | 1.787 circuits/s | 1.800 | 100.7 |
| lab-array, 4 labs (researching the largest red+green tech) | 0.1333 units/s | 0.1333 | 100.0 |
| curated red-tile-ramqvist | 1.0 red/s | 1.000 | 100.0 |
| curated green-line-hellpet | 0.28 green/s | 0.283 | 101.2 |
| curated mall-polse (aggregate, plates/s in products) | 7.088 | 7.605 | 107.3 |
| curated mall-polse coverage (chests capped at 1 slot, 10 game-min) | every product | all 12 made | pass |

Times: the 16 validation tests take about 80 s (fast group ~30 s). Rendered modules: `docs/reports/m4/*.png`.

| Smelter column (12) | Steam block (2) | Circuit block | Red tile (curated) | Green line (curated) | Mall (curated) |
|---|---|---|---|---|---|
| ![](m4/smelter-column_iron-plate.png) | ![](m4/steam-block_2.png) | ![](m4/circuit-block_electronic-circuit.png) | ![](m4/red-tile-ramqvist.png) | ![](m4/green-line-hellpet.png) | ![](m4/mall-polse.png) |

### Tests

- **T1** (`mod/unit/modules.test.ts`, 15 tests; 40 T1 tests in total): ratio sanity against hand-computed numbers
  (stone furnace 0.3125 plates/s, 12 furnaces = 3.75/s and 0.27 coal/s; AM1 speed 0.5 → 1 gear craft/s capped by two
  inserters; cable; red line 0.1/s per assembler; circuit block; steam 1.8 MW and 0.45 coal/s per boiler; electric
  drill 0.5/s, burner 0.25/s; labs 1/unit time and the inserter-limited case), layout invariants for 15 generator
  instances (no overlaps, inside the footprint, every powered entity covered, one pole network, single-item
  ports on the edge), expansion ≡ regeneration for every generator, `expandTail`/`expandMoves`, transforms (all
  4 rotations × mirror stay valid and powered; port side swaps on mirror; 4 quarter turns are the identity).
- **T2**: 16 new tests (15 catalog entries + mall coverage). Full suite: see "CI".

### Findings

- **Inserter direction in 2.0 = the side it picks up from** (direction north: pickup north, drop south). Verified
  with `pickup_position`/`drop_position`.
- **Yellow inserter throughput** measured ≈ 0.90–0.95 items/s from belts and ≈ 0.84–0.86 from machines, i.e. about
  one item per full turn (60 × 0.014 = 0.84) or a little better. The engine uses 0.9 (belt) and 1.0 (machine) of
  0.84/s; every declared rate is within 0–19% below measurement (conservative).
- **A burner furnace's inserter does not insert ore while the furnace has no fuel.** Fed exactly at the declared
  coal rate, the first furnaces on a fuel lane hoard coal into their fuel slots for minutes and the last ones never
  start (the 12-furnace column measured 40% before priming). Real builds should prime fuel lanes (or saturate them);
  the lab primes during warm-up. Worth knowing for M5's bootstrap of the first smelter column.
- **Mall throughput is not per-product.** Products share gears and circuits; the assemblers nearest the trunk inlet
  take most of them, so per-product rates range from 0% to 300% of the proportional split while the total is 107%.
  The validation therefore checks the plate value of all products together (≥ 90%) plus a coverage run with chests
  capped at one slot (every product made in 10 min). See proposal P1.
- **3:2 cable:circuit with AM1 and yellow inserters is inserter-limited**: the outer cable assemblers pass cable
  through two inserters only, so a unit makes 1.79 circuits/s, not 2. Declared honestly.
- Factorio only allows `require` while control.lua is parsed: the curated data (`modules/curated_data.lua`,
  generated by `tools/build-mod.mjs`) loads at file scope.

### Deviations and assumptions

- **Modules contain their own small poles**; the `power` port is one of them, for the planner's pole network to
  connect (SPEC §5.4 says pole networks between modules belong to the planner, which still holds).
- **Schema additions** to SPEC §5.4's ModuleDef (proposal P2): port kind `chest-out` (malls), `generator`,
  `recipes`, `mirrorable`, `anchor`, `upkeep`, `notes`, `Rate.kind` (item / power / research), and
  `ModuleExpand.insertAt` (needed to say where units go).
- **Generator counts are quantised** so poles stay periodic: furnaces in fours, assemblers and labs in pairs,
  electric drills in pairs of rows.
- The **green line takes plates** (not circuits) and is not expandable; the curated module with `expand` is the
  red-science tile. A tileable green design (Ramqvist) needs circuits from the bus and was not used.
- The **steam block uses burner inserters** (no power bootstrap problem; they fuel themselves from the coal they
  carry). Electric inserters there are not supported.
- **Lab array rates depend on the technology**: the module declares them for `unitTime` (default 30 s); the
  validation lab regenerates it for the technology it researches.
- Save harvesting was not used for M4a: factorioprints gave clean early-game sources for the three layouts that
  need curation, and generators cover the rest (SPEC §5.4 sourcing recommendation, online first).
- Blueprint strings are cached in the repo (`data/modules/sources/`) for reproducibility, with attribution; the
  site states no licence.

### Proposals (not decisions; also in SPEC §11)

- **P1 (validation criterion for malls):** for modules whose outputs go to chests, replace "each output ≥ 90% of
  declared" by "plate value of all outputs ≥ 90%" plus "every product made with capped chests". This changes how an
  acceptance threshold is applied, so it needs the user's approval; the tests implement it today.
- **P2 (ModuleDef schema):** adopt the additions listed above into SPEC §5.4.
- **P3 (validation feed):** feed 1.1 × declared while measuring after a primed warm-up (3 ×, ≥ 1.5 items/s per port),
  instead of exactly the declared rates throughout, which measures the fill-up rather than the module.

## Interface for M4b (how the planner consumes modules)

Everything below is in `mod/src/modules/` and is pure unless marked (runtime).

1. **Getting a module.** `curatedModule(id)`, `generatedModule(generator, params)` (runtime, memoised) or the pure
   generator functions with a `ProtoFacts` (`prototypeFacts` in game). `V1_CATALOG` lists representative instances.
   Choose by `recipe`/`rates.outputs`, `requiresTech` (all must be researched) and `site`.
2. **Coordinates.** A ModuleDef is canonical: footprint `w × h`, entities and ports in module-local coordinates
   (top-left (0, 0), entity centres). Place it with an integer world `origin` (its top-left tile):
   `world = origin + local` (`stamp.ts` `worldPos`). Every entity lies inside the footprint; routes must not enter
   it except at ports.
3. **Rotation and mirroring.** `transformModule(def, { rot, mirror })` returns the module as placed, again with its
   top-left at (0, 0) (footprint swapped for odd `rot`). Mirror happens before rotation. Check `rotatable` and
   `mirrorable`. Do this after any expansion (transforms drop `expand`).
4. **Ports** (single item, D23), after the transform:
   - `belt-in`: `pos` is the module's first belt tile (on the footprint edge), `dir` its flow direction. The router's
     last belt must sit on `portOutsideTile(port)` (= `pos − dirVector(dir)`) facing `dir`.
   - `belt-out`: `pos` is the last belt tile; items leave onto `portOutsideTile(port)` (= `pos + dirVector(dir)`),
     where the router's first belt goes (any direction but back into the module).
   - `side` (absent on every v1 module): the lane the items must be on, relative to `dir`; mirroring swaps it.
     Satisfy it by side-loading onto the port tile from that side.
   - `power`: a small pole inside the module; connect the pole network to it (small pole wire reach 7.5).
   - `chest-out` (mall): a chest the crew empties (Job Board collect jobs).
5. **Site.** `site = "shore"`: `anchor.water` rectangles (module-local, outside the footprint) must be water and the
   footprint land (the steam block's pump sits on the west edge facing west). `site = "resource-patch"`:
   `anchor.miningAreas` (one per drill) should cover ore of `anchor.resource`; a mining module may overlap ore,
   nothing else should.
6. **Expand.** `def.expand` = unit (entities, footprint), `axis`, `insertAt`, `maxUnits`, `perUnit` (rates and
   machines), `ports: "shift"`. `expandModule(def, k, facts)` returns the grown module (recomputed rates; ports
   beyond `insertAt` shift). To grow a built module: `expandMoves(def, k)` says which entities to remove and
   re-place and the origin shift (either the tail moves forward or the head moves back), then place the grown
   module at `origin + originShift`. Plan the space for `maxUnits` when reserving room (D27 headroom).
7. **Rates.** `rates.inputs` / `rates.outputs` in items/s at full speed, with `kind`: `item`, `power` (`electricity`
   in W: an input is the module's maximum electric demand, an output is a steam block's production) and `research`
   (`research-unit`/s). `upkeep.fuel` lists burners the crew must refuel. `laneCapacity(facts, belt)` gives items/s
   per lane for edge capacity math (§5.8).
8. **Ghosts.** `stampModule(surface, force, def, origin, { ghost: true })` creates the ghosts the Job Board builds
   (assembler recipes and underground types are set on the ghost).

## M4b (TODO)

- Belt router (A* with undergrounds, turns, rip-up and reroute; no crossings through footprints; respect
  `Port.side`).
- Real-terrain placement and the early-game compact `LayoutPolicy` (cliffs, water, trees, existing structures).
- Factory Graph physical layer and capacity math (§5.8), T1 capacity/overflow tests, T2 lab with an undersized belt.
- Report sections: router acceptance (5 modules in a lab), real-terrain runs, renders, CI.
