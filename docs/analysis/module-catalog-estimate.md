# Module catalog estimate (napkin), Rival Engineers v1 and beyond

Numbers verified against base/prototypes/recipe.lua: red = 1 Cu + 1 gear, 5 s; green = 1 inserter + 1 belt, 6 s;
inserter = 1 circuit + 1 gear + 1 plate; belt = 1 plate + 1 gear -> 2 belts; circuit = 1 plate + 3 cable (cable = 1 Cu -> 2);
AM1 = 3 circuit + 5 gear + 9 plate; lab = 10 circuit + 10 gear + 4 belt; drill = 3 circuit + 5 gear + 10 plate;
boiler = furnace + 4 pipe; engine = 8 gear + 5 pipe + 10 plate. Speeds: AM1 0.5, stone furnace 1 (0.3125 plate/s).

## 1a. Demand at 30 red + 30 green SPM (0.5/s each)

| Stage | Machines (AM1) | Notes |
|---|---|---|
| Red | 5 science + share of gear | 0.5 gear/s, 0.5 Cu/s |
| Green | 6 science, 1 inserter, 1 belt, 1 circuit, 1 cable | 0.5 inserter/s, 0.5 belt/s (0.25 crafts), 0.5 circuit/s, 1.5 cable/s |
| Gears | 2 gear assemblers total (needs ~1.25 gear/s: 0.5 red + 0.5 inserter + 0.25 belt) | |
| Plates | about 3.75 Fe/s, 1.25 Cu/s before expansion margin | = 12 Fe + 4 Cu stone furnaces; with ~30% margin 16 + 6 |
| Labs | ~10-15 (30 SPM x 15-30 s tech units) | 60 kW each |
| Power | about 5 MW: 3 boilers + 6 engines | coal about 1.25/s power + about 0.5/s furnaces |
| Mining | about 8 Fe + 3 Cu drills (0.5/s each), ~4 coal, 1-2 stone | |

Key finding: at 30 SPM green, ONE cable assembler + ONE circuit assembler suffice (1.5 cable/s needs 0.75 of a cable AM1; 0.5 circuit/s needs 0.5 of a circuit AM1).
The 3:2 cable:circuit ratio only bites in circuit-heavy consumers (mall, drills, labs, later blue). So the 3:2 block is its own reusable generator, and green science instantiates the minimal 1:1 form of it.

Hand-crafted by crew vs automated:
- **Automate (mall):** transport-belt, inserter, underground-belt, splitter, assembling-machine-1, electric-mining-drill, stone-furnace, pipe, iron-gear-wheel, circuit, steam-engine, boiler (low volume but one boiler per 2 engines; cheap to include).
- **Hand-craft:** offshore-pump (1-2 per base), lab (about 10 per base, one-off, 10 circuits each; take circuits from the mall chest), small-electric-pole (needs wood, not a belt-able resource; crew chops trees), iron-chest, belts for routing bootstrap.
- **Skip in v1:** steel (needs research and a 5:1 furnace stage; steel-furnace, AM2, medium pole all need it), stone-brick, fast/filter inserters (filters not needed, see section 3).
- Wood is the odd resource: small poles need it and it is not a patch. The spec should assume the crew harvests it (or pre-seeds with the starting inventory), otherwise power-pole supply blocks expansion.

## 1b-d. Module table (v1)

Footprints are rough, in tiles, one throughput unit.

| Module | Recipes covered | Fused? | Variants / tiers | Parametric? | Footprint |
|---|---|---|---|---|---|
| Mine outpost (iron/copper/coal/stone) | mining only | n/a | ore-agnostic; drill rows N=2..12 | Yes, generator: rows x drills along a belt, fitted to patch shape by planner | 3 x 3N ... about 7 x 24 |
| Smelter column | ore -> plate / brick | Furnaces fed by mixed belt (ore one lane, coal other lane) and direct output | 12 furnaces = 3.75 Fe/s (exactly the v1 demand); 6, 12, 24 | Yes, N furnaces in two mirrored rows; same layout for Fe/Cu/stone (furnace picks recipe) | 12 x about 10 for 12 furnaces |
| Steam block (pump + boilers + engines) | power | Yes: pump -> boiler row -> 2 engines per boiler, coal inserters | 1-4 boilers (1.8-7.2 MW) | Yes, generator (N boilers). Must anchor at shore, so it is a "site" type; fusing the pump avoids long pipe routing | about 8 x (6N+4) |
| Red science line | gear + red science | Yes: gear asm direct-inserts into red asms | K = 1..5 red asms per gear asm (6-30 SPM) | Yes, row length K | about 9 x 14 |
| Green science line | cable? + circuit + gear + inserter + belt + green | Yes, strongly: whole chain in one block, inputs only Fe + Cu plates | 30 SPM = 6 green asm; feeder asms support up to 12 green | Template curated once, K green asms parametric (6/12/18/24 SPM...) | about 14 x 16 |
| Circuit block (cable + circuit) | copper-cable, electronic-circuit | Yes, 3:2 with direct insertion | n x (3 cable : 2 circuit) | Yes, generator n | about 6 x 8 per unit |
| Lab array | labs | Lab-to-lab inserter chain, 1 input belt with red on one lane and green on the other | N = 4..20 | Yes, generator | 3 x 3N-ish snake or 2 rows |
| Mall | belts, inserters, undergrounds, splitters, AM1, drill, furnace, pipe, engine, boiler, gears, circuits | Yes, internally fused (gear + circuit sub-blocks feed neighbours) | 1 | Mostly curated; output chest count param | about 20 x 24 |
| Crew depot (chests, coal/ore buffer) | none | n/a | 1 | trivial | 4 x 4 |
| Pole network, pipes, belts | planner, not modules | | | | |

### Totals (v1)

- **Distinct parametric generators: 7** (mine, smelter, steam block, red line, circuit block, lab array, depot) plus green-science line as a generator with a hand-built template.
- **Curated (non-generable) layouts: 2-3:** green-science template, mall, (optionally the steam block pipe geometry). The rest are procedurally generated from the same few primitives (row of machines + belt + inserters).
- Instances scale by replication, not by variant: instead of "small/medium/large" blueprints, define a base unit (smelter 12 furnaces, red line 5 asm, green 6 asm) and let the planner place k copies.
  Variants are only needed where granularity matters: smelter 6/12/24, steam 1-4 boilers. That gives about 3-4 parameter tiers per generator, but zero extra blueprints if parametric.
- Rotations/mirrors are free, as stated.
- If the user insists on pure curated blueprints (no generators): about 7 modules x about 3 sizes = about 20 blueprints. This is the cost of not parameterizing.

## 2. Scale check beyond v1 (ranges, not a table)

- Through blue science and oil: add oil outpost (pumpjacks + pipe), basic refinery (plus optional cracking), plastic, sulfur, advanced circuit, engine unit (steel + gear + pipe), steel smelting, blue science line, solid fuel/gas power option, stone brick, mall extensions (pumpjack, refinery, chem plant), second mall for steel buildings.
  Estimated +10 to +15 modules, total about 18-25 distinct units; curated about 6-9, rest generators.
- Through rocket launch: add purple (electric furnace, prod module, rail), yellow (processing unit with sulfuric acid, robot frame needing lubricant/batteries, low-density structure), rocket fuel, RCU, rocket silo, uranium optional, bots/trains if used.
  Total about 40-60 distinct units; curated about 15-25.
- Growth is roughly linear in the number of intermediate products (about 8-12 production units per science tier), not explosive, because fused units and generators cover tiers of throughput. Variants multiply only if throughput tiers are curated; parametric keeps it additive.
  Fluid logistics (pipe routing, tank/underground handling) is the one place that adds routing-complexity cost beyond count.

## 3. Mall recommendation

**Single mall module for v1, internally fused, not one module per building.**
- Routing is automatic, but each extra module adds 2-4 input ports to route and a footprint to find space for. A building mall needs iron, copper (via cables/circuits), gears: 7+ separate modules would need 20+ belt routes for a few items per minute of output.
- Mall demand is tiny (a few dozen items per expansion), so many assemblers do not need throughput. One mall of about 10 AM1 with gears and circuits produced inside (direct insertion) needs just 2 inputs (Fe, Cu belts) plus optionally stone (for furnaces/boilers) and outputs to chests that the crew empties (no bots).
- **No filter inserters needed:** assembler input inserters only pick up what the recipe needs, so shared belts with mixed items work. Filters are only needed for taking outputs, which chests do trivially. This removes the fast-inserter/filter tech dependency.
- Keep stone-furnace production as a hand-craft (5 stone) if stone is not worth routing.
- Allow the planner to place a second mall later; no spec change needed. Keep it separate from the science block so mall consumption never starves science (give mall input low priority via a splitter priority, or a dedicated smelter column).

## Insights that should change the spec

1. **Parametric generators, not curated blueprints, should be first-class in §5.4** (the `source: "generated"` already exists). Most v1 modules are rows + belts + inserters. Reserve curated only for green science and mall.
2. **Port "lanes" matter:** smelter inputs need mixed ore+coal belts, lab inputs need red/green lanes on one belt. The Port.lanes field is necessary, and the router must preserve lane assignment (it already says lane-aware).
3. **Site-anchored modules:** steam block (shore), mine (patch), oil (later). Add a `siteConstraint` to ModuleDef so the planner knows these are placed by terrain, not grid choice.
4. **Replication over size variants:** define one base unit per module and let the planner instantiate k copies. `rates` per instance already supports this.
5. **Wood for small poles** is outside the belt economy; spec needs a gather job for wood or an explicit list of hand-supplied items (pump, labs, poles, chests).
6. **Avoid steel in v1**: it forces a smelter second stage and research for AM2/medium poles/steel furnaces.
7. **Initial module requirement:** a lone circuit-less red line is the only module available before circuits, so burner-phase hand crafting must produce the first lab/assemblers.
