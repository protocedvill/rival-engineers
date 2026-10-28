// B33: growth geometry audit. Every expandable module type must grow where and by what its template says: the units
// `tryExpand` adds equal the generator's layout with more units, the new ground is exactly what `growthArea` /
// `growthUnitRects` (soft and hard claims, the near band, the in-game growth overlay) claim, on the same end, and the
// part that stays put does not move. Mines must grow only over their ore and their whole-patch plan (D52) must cover
// the patch part they claim at maximum drill coverage. Pure: generated modules, synthetic and captured ore patches.

import { expandModule } from "../src/modules/build"
import { connectionId } from "../src/shared/ids"
import { moduleId } from "../src/shared/ids"
import { assemblerRow, circuitBlock, labArray, miningOutpost, redLine, smelterColumn, steamBlock } from "../src/modules/generators"
import { transformEntity, transformModule, Transform } from "../src/modules/geometry"
import { CuratedModuleFile, ModuleDef, ModuleEntity } from "../src/modules/types"
import { FREE, Rect, TerrainView, tkey, UNKNOWN } from "../src/planner/grid"
import { commitModule, findModule, growthArea, growthUnitRects, LayoutState, newLayout, PlacedModule } from "../src/planner/layout"
import { beltDrillCap, candidateOk, connectedPatch, planWholePatch } from "../src/planner/mine-plan"
import { placeNow, prepareWholePatchPlacement, tryExpand } from "../src/planner/placement"
import { LayoutPolicy, selectPolicy } from "../src/planner/policy"
import { planGrowth } from "../src/planner/grow"
import { newRoutingJob, runJob } from "../src/planner/plan"
import { beltTiers } from "../src/planner/capacity"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

/** @noSelf */
declare function require(this: void, module: string): unknown
const curatedFiles = require("modules.curated_data") as Record<string, CuratedModuleFile>


const POLICY: LayoutPolicy = { ...selectPolicy("early-compact", {}), searchRadii: [0, 8, 16, 32] }
const P2P: LayoutPolicy = { ...POLICY, topology: "point-to-point" }
const TAP: LayoutPolicy = { ...POLICY, topology: "splitter-tap" }

function entKey(e: ModuleEntity): string {
  return string.format("%s@%g,%g:%g:%s", e.name, e.x, e.y, e.dir ?? 0, e.recipe ?? "")
}

function multiset(es: ModuleEntity[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of es) out[entKey(e)] = (out[entKey(e)] ?? 0) + 1
  return out
}

function sameEntities(a: ModuleEntity[], b: ModuleEntity[]): string | undefined {
  const ma = multiset(a)
  const mb = multiset(b)
  for (const [k, n] of pairs(ma)) if (mb[k as string] !== n) return `${k as string}: ${n as number} vs ${mb[k as string] ?? 0}`
  for (const [k, n] of pairs(mb)) if (ma[k as string] !== n) return `${k as string}: ${ma[k as string] ?? 0} vs ${n as number}`
  return undefined
}

interface Kind {
  name: string
  /** The module with `n` units of growth already in (n = 0: the base). */
  make: (this: void, extra: number) => ModuleDef
  mining?: string
}

const KINDS: Kind[] = [
  { name: "smelter-column iron", make: (n) => smelterColumn(F, { recipe: "iron-plate", furnaces: 4 + 4 * n }) },
  { name: "smelter-column copper burner", make: (n) => smelterColumn(F, { recipe: "copper-plate", furnaces: 8 + 4 * n, inserter: "burner-inserter" }) },
  { name: "smelter-column stone buffered", make: (n) => smelterColumn(F, { recipe: "stone-brick", furnaces: 4 + 4 * n, buffer: "wooden-chest" }) },
  { name: "mining-outpost iron electric 2 sides", make: (n) => miningOutpost(F, { resource: "iron-ore", rows: 2 + 2 * n, sides: 2 }), mining: "iron-ore" },
  { name: "mining-outpost iron electric 1 side", make: (n) => miningOutpost(F, { resource: "iron-ore", rows: 2 + 2 * n, sides: 1 }), mining: "iron-ore" },
  { name: "mining-outpost coal burner 2 sides", make: (n) => miningOutpost(F, { resource: "coal", rows: 1 + n, sides: 2, drill: "burner-mining-drill" }), mining: "coal" },
  { name: "mining-outpost stone burner 1 side", make: (n) => miningOutpost(F, { resource: "stone", rows: 2 + n, sides: 1, drill: "burner-mining-drill" }), mining: "stone" },
  { name: "steam-block", make: (n) => steamBlock(F, { boilers: 1 + n }) },
  { name: "assembler-row gears", make: (n) => assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 + 2 * n }) },
  { name: "assembler-row red science (2 inputs)", make: (n) => assemblerRow(F, { recipe: "automation-science-pack", count: 2 + 2 * n }) },
  { name: "assembler-row gears buffered", make: (n) => assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 + 2 * n, buffer: "wooden-chest" }) },
  { name: "red-line", make: (n) => redLine(F, { units: 1 + n }) },
  { name: "circuit-block", make: (n) => circuitBlock(F, { units: 1 + n }) },
  { name: "circuit-block buffered", make: (n) => circuitBlock(F, { units: 1 + n, buffer: "wooden-chest" }) },
  { name: "lab-array red", make: (n) => labArray(F, { labs: 2 + 2 * n, packs: ["automation-science-pack"] }) },
  { name: "lab-array red+green", make: (n) => labArray(F, { labs: 4 + 2 * n, packs: ["automation-science-pack", "logistic-science-pack"] }) },
]

// (1) The unit is the template's own unit: growing by k gives the generator's layout with k more units.
for (const kind of KINDS) {
  test(`B33 template: ${kind.name} grows into its generator's own layout`, () => {
    const base = kind.make(0)
    const spec = base.expand!
    ok(spec !== undefined && spec.maxUnits >= 1, "expandable")
    for (let k = 1; k <= math.min(3, spec.maxUnits); k++) {
      const grown = expandModule(base, k, F)
      const want = kind.make(k)
      eq(grown.footprint.w, want.footprint.w, `+${k} width`)
      eq(grown.footprint.h, want.footprint.h, `+${k} height`)
      const diff = sameEntities(grown.entities, want.entities)
      ok(diff === undefined, `+${k} entities match the generator (${diff})`)
      for (const p of want.ports) {
        const q = grown.ports.find((x) => x.id === p.id)
        ok(q !== undefined && q.pos.x === p.pos.x && q.pos.y === p.pos.y && q.dir === p.dir, `+${k} port ${p.id} where the generator puts it`)
      }
      eq(grown.expand?.maxUnits ?? 0, want.expand?.maxUnits ?? 0, `+${k} cap left`)
    }
  })
}

test("B33 template: a curated module's unit repeats the slice before its insertion line", () => {
  const def = curatedFiles["red-tile-ramqvist"]
  const spec = def.expand!
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  // The unit inserted at insertAt must be the slice just before it (the layout is periodic there).
  const before = def.entities
    .filter((e) => (spec.axis === "x" ? e.x : e.y) >= spec.insertAt - size && (spec.axis === "x" ? e.x : e.y) < spec.insertAt)
    .map((e) => (spec.axis === "x" ? { ...e, x: e.x - (spec.insertAt - size) } : { ...e, y: e.y - (spec.insertAt - size) }))
  const diff = sameEntities(before, spec.unit.entities)
  ok(diff === undefined, `unit = the slice before insertAt (${diff})`)
})

// (2) The claimed growth (growthUnitRects / growthArea) is exactly the ground tryExpand adds, on the same end, and the
// end that stays keeps every entity where it was.

const TRANSFORMS: Transform[] = []
for (const mirror of [false, true]) for (const rot of [0, 1, 2, 3]) TRANSFORMS.push({ rot, mirror })

function place(def: ModuleDef, t: Transform, x: number, y: number): PlacedModule {
  const d = t.rot === 0 && !t.mirror ? def : transformModule(def, t)
  return { id: moduleId("m"), canonical: def, def: d, transform: t, origin: { x, y }, rect: { x, y, w: d.footprint.w, h: d.footprint.h } }
}

function openTerrain(resource?: string): TerrainView {
  return { block: () => FREE, ore: () => resource }
}

function worldEntities(m: PlacedModule): ModuleEntity[] {
  return m.def.entities.map((e) => ({ ...e, x: e.x + m.origin.x, y: e.y + m.origin.y }))
}

function rectTiles(rects: Rect[]): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  for (const r of rects) for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) out[tkey(x, y)] = true
  return out
}

for (const kind of KINDS) {
  test(`B33 growth area: ${kind.name} claims exactly the ground tryExpand adds, in every orientation`, () => {
    const base = kind.make(0)
    const maxU = base.expand!.maxUnits
    for (const t of TRANSFORMS) {
      for (let k = 1; k <= math.min(4, maxU); k++) {
        const state = newLayout()
        const m = place(base, t, 200, 200)
        commitModule(state, m, F, POLICY.corridor.preferred)
        const claimed = growthUnitRects(m, k)
        const area = growthArea(m)!
        const all = rectTiles(growthUnitRects(m))
        const a = rectTiles([area])
        for (const [kk] of pairs(all)) ok(a[kk as number] === true, "growthArea covers every unit")
        for (const [kk] of pairs(a)) ok(all[kk as number] === true, "growthArea is only the units")
        const before = worldEntities(m)
        const oldRect = { ...m.rect }
        const r = tryExpand(state, openTerrain(kind.mining), F, POLICY, "m", k)
        ok(r.ok, `rot ${t.rot}${t.mirror ? " mirror" : ""} +${k}: grows (${r.reason})`)
        const grown = findModule(state, "m")!
        const want = rectTiles(claimed)
        let added = 0
        for (let x = grown.rect.x; x < grown.rect.x + grown.rect.w; x++) {
          for (let y = grown.rect.y; y < grown.rect.y + grown.rect.h; y++) {
            if (x >= oldRect.x && y >= oldRect.y && x < oldRect.x + oldRect.w && y < oldRect.y + oldRect.h) continue
            added++
            ok(want[tkey(x, y)] === true, `rot ${t.rot}${t.mirror ? " mirror" : ""} +${k}: new tile ${x},${y} is in the claimed units`)
          }
        }
        let wantN = 0
        for (const [_k] of pairs(want)) wantN++
        eq(added, wantN, `rot ${t.rot}${t.mirror ? " mirror" : ""} +${k}: new ground = claimed units`)
        // The end that stays: every entity that is gone from its world position is one of the moved end's.
        const after = multiset(worldEntities(grown))
        const moved = multiset(r.moved.map((e) => {
          const w = transformEntity(e, base.footprint.w, base.footprint.h, t)
          return { ...w, x: w.x + 200, y: w.y + 200 }
        }))
        for (const e of before) if ((after[entKey(e)] ?? 0) === 0) ok((moved[entKey(e)] ?? 0) > 0, `rot ${t.rot}${t.mirror ? " mirror" : ""} +${k}: ${entKey(e)} moved but is not on the moving end`)
      }
    }
  })
}

// (3) Mines (D52): every mine gets its whole-patch plan; the plan covers the claimed part of the patch at maximum
// drill coverage, as many drills as its one output belt carries; strips that can't take a plan grow only over ore.

const ELECTRIC = F.entity("electric-mining-drill")!

function patchTerrain(region: Rect, ore: (this: void, x: number, y: number) => string | undefined, blocked?: (this: void, x: number, y: number) => number | undefined): TerrainView {
  return {
    block: (x, y) => {
      if (x < region.x || y < region.y || x >= region.x + region.w || y >= region.y + region.h) return UNKNOWN
      return blocked?.(x, y) ?? FREE
    },
    ore: (x, y) => ore(x, y),
  }
}

function drillCount(def: ModuleDef): number {
  return def.entities.filter((e) => F.entity(e.name)?.type === "mining-drill").length
}

function placeMine(state: LayoutState, view: TerrainView, region: Rect, policy: LayoutPolicy, id: string, center: { x: number; y: number }, rows = 2, sides = 1): PlacedModule {
  const raw = miningOutpost(F, { resource: "iron-ore", rows, sides })
  const s = placeNow({ id, def: raw, targets: {}, center, region }, state, view, policy)
  eq(s.phase, "done", `${id} placed (${s.reason})`)
  const m = s.result!
  // Shared (splitter-tap) mines come with splitters researched (P44 b: several rows need them).
  prepareWholePatchPlacement(m, view, F, region, policy, state, policy.topology === "splitter-tap")
  commitModule(state, m, F, policy.corridor.preferred)
  return m
}

test("B33 a point-to-point mine gets its whole-patch plan (D52 (1)), not a strip", () => {
  const region = { x: 0, y: 0, w: 80, h: 80 }
  const view = patchTerrain(region, (x, y) => (x >= 20 && x < 44 && y >= 20 && y < 40 ? "iron-ore" : undefined))
  const state = newLayout()
  const m = placeMine(state, view, region, P2P, "mine", { x: 25, y: 25 })
  ok(m.minePlan !== undefined, "whole-patch plan attached under point-to-point")
  eq(growthArea(m), undefined, "no strip growth area: the claim is the plan")
})

test("B33 a whole-patch mine claims one output belt's worth of drills, on the full plan's grid", () => {
  const region = { x: 0, y: 0, w: 120, h: 120 }
  const view = patchTerrain(region, (x, y) => (x >= 20 && x < 90 && y >= 20 && y < 90 ? "iron-ore" : undefined))
  const state = newLayout()
  const m = placeMine(state, view, region, TAP, "mine", { x: 25, y: 25 })
  ok(m.minePlan !== undefined, "whole-patch plan")
  const cap = beltDrillCap(F, "transport-belt", ELECTRIC, "iron-ore")
  const n = drillCount(m.minePlan!.full)
  print(`  full plan: ${n} drills, cap ${cap}`)
  ok(n <= cap, `${n} drills fit one belt (${cap})`)
  ok(n >= cap - 4, `${n} drills: the belt is nearly filled (${cap})`)
  // Max coverage: every claimed drill is one of the whole patch's grid positions.
  const patch = connectedPatch(view, "iron-ore", [{ x: 30, y: 30 }], region)!
  const grid: Record<string, boolean> = {}
  for (const d of planWholePatch(view, patch, ELECTRIC).drills) grid[string.format("%g,%g", d.x, d.y)] = true
  for (const e of m.minePlan!.full.entities) {
    if (e.name !== "electric-mining-drill") continue
    ok(grid[string.format("%g,%g", e.x + m.origin.x, e.y + m.origin.y)] === true, `drill ${e.x + m.origin.x},${e.y + m.origin.y} on the whole-patch grid`)
  }
})

test("B33 a shared mine on a small patch covers the whole patch", () => {
  const region = { x: 0, y: 0, w: 60, h: 60 }
  const view = patchTerrain(region, (x, y) => ((x - 30) * (x - 30) + (y - 30) * (y - 30) < 64 ? "iron-ore" : undefined))
  const state = newLayout()
  const m = placeMine(state, view, region, TAP, "mine", { x: 30, y: 30 })
  ok(m.minePlan !== undefined, "whole-patch plan")
  const patch = connectedPatch(view, "iron-ore", [{ x: 30, y: 30 }], region)!
  const reach: Record<number, boolean> = {}
  for (const e of m.minePlan!.full.entities) {
    if (e.name !== "electric-mining-drill") continue
    for (let x = math.floor(e.x + m.origin.x - 2.49 + 0.01); x < math.ceil(e.x + m.origin.x + 2.49 - 0.01); x++) {
      for (let y = math.floor(e.y + m.origin.y - 2.49 + 0.01); y < math.ceil(e.y + m.origin.y + 2.49 - 0.01); y++) reach[tkey(x, y)] = true
    }
  }
  let covered = 0
  for (const k of patch.tiles) if (reach[k]) covered++
  print(`  small patch: ${covered}/${patch.tiles.length} tiles under a planned drill`)
  eq(covered, patch.tiles.length, "every ore tile under a planned drill")
})

test("B33 a point-to-point mine claims one lane of the grid, up to its template's cap", () => {
  const region = { x: 0, y: 0, w: 80, h: 80 }
  const view = patchTerrain(region, (x, y) => (x >= 20 && x < 50 && y >= 20 && y < 50 ? "iron-ore" : undefined))
  const state = newLayout()
  const m = placeMine(state, view, region, P2P, "mine", { x: 25, y: 25 })
  ok(m.minePlan !== undefined, "whole-patch plan")
  const raw = miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 1 })
  const cap = drillCount(raw) + raw.expand!.maxUnits * 2
  const n = drillCount(m.minePlan!.full)
  print(`  point-to-point: ${n} drills (cap ${cap}), footprint ${m.minePlan!.full.footprint.w}x${m.minePlan!.full.footprint.h}`)
  ok(n <= cap && n >= cap - 2, `${n} drills, the template's cap ${cap}`)
  ok(math.min(m.minePlan!.full.footprint.w, m.minePlan!.full.footprint.h) <= 11, "one lane wide (2 drills + belt + poles)")
})

test("B33 a second point-to-point mine on the same field takes the unclaimed part", () => {
  const region = { x: 0, y: 0, w: 120, h: 120 }
  const view = patchTerrain(region, (x, y) => (x >= 20 && x < 90 && y >= 20 && y < 60 ? "iron-ore" : undefined))
  const state = newLayout()
  const a = placeMine(state, view, region, P2P, "a", { x: 25, y: 25 })
  const b = placeMine(state, view, region, P2P, "b", { x: 85, y: 55 })
  ok(a.minePlan !== undefined && b.minePlan !== undefined, "both mines have whole-patch plans")
  const ca: Record<number, boolean> = {}
  for (const k of a.minePlan!.claim) ca[k] = true
  for (const k of b.minePlan!.claim) ok(ca[k] !== true, "claims never overlap")
})

test("B33 a strip mine that can't take a plan claims growth only over its ore", () => {
  const region = { x: 0, y: 0, w: 80, h: 120 }
  // A 9-wide, 20-deep patch; a water cross over it (x 34 below the strip, y 20) keeps the whole-patch plan from
  // fitting: a lane belt in either direction would have to cross water.
  const view = patchTerrain(region, (x, y) => (x >= 30 && x < 39 && y >= 10 && y < 30 ? "iron-ore" : undefined), (x, y) => (y === 20 || (x === 34 && y >= 17) ? 5 : undefined))
  const state = newLayout()
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 }), rotatable: false, mirrorable: false }
  const m: PlacedModule = { id: moduleId("mine"), canonical: raw, def: raw, transform: { rot: 0, mirror: false }, origin: { x: 30, y: 9 }, rect: { x: 30, y: 9, w: raw.footprint.w, h: raw.footprint.h } }
  prepareWholePatchPlacement(m, view, F, region, P2P, state)
  eq(m.minePlan, undefined, "no whole-patch plan (blocked)")
  commitModule(state, m, F, P2P.corridor.preferred)
  const g = growthArea(m)!
  print(`  strip ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h}: growth ${g.x},${g.y} ${g.w}x${g.h} (cap ${raw.expand!.maxUnits} units)`)
  ok(g.y + g.h <= 30 + 3, `growth claim stops at the ore's end (y ${g.y + g.h})`)
  let claimed = 0
  for (const [, owner] of pairs(state.mine ?? {})) if (owner === "mine") claimed++
  ok(claimed <= g.w * g.h, "hard claim within the clipped area")
})

test("B33 strip growth refuses a drill with no ore under it", () => {
  const region = { x: 0, y: 0, w: 60, h: 60 }
  // The patch body ends at y = 20. The 7-tall mine at y 1 grows in 6-tall units: units 1 and 2 (y 8..19) sit on ore.
  // Below, only two thin ore columns run on (x 10 and 18), outside the drill bodies (x 11..13, 15..17) but inside
  // their mining areas: unit 3's drills would only graze them.
  const view = patchTerrain(region, (x, y) => ((x >= 10 && x < 19 && y >= 1 && y < 20) || ((x === 10 || x === 18) && y >= 1 && y < 40) ? "iron-ore" : undefined))
  const raw = { ...miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 }), rotatable: false, mirrorable: false }
  const state = newLayout()
  const m: PlacedModule = { id: moduleId("mine"), canonical: raw, def: raw, transform: { rot: 0, mirror: false }, origin: { x: 10, y: 1 }, rect: { x: 10, y: 1, w: raw.footprint.w, h: raw.footprint.h } }
  commitModule(state, m, F, P2P.corridor.preferred)
  ok(tryExpand(state, view, F, P2P, "mine", 1).ok, "the first unit (on ore) grows")
  ok(tryExpand(state, view, F, P2P, "mine", 1).ok, "the second unit (on ore) grows")
  const r = tryExpand(state, view, F, P2P, "mine", 1)
  print(`  graze: ${r.reason}`)
  ok(!r.ok, `a unit whose drills only graze the ore is refused (${r.reason})`)
})

// Real terrain: every captured patch (soak plan inputs) is planned at (near) full coverage against an upper bound that
// lets every drill sit anywhere on a 1-tile grid: the regular lane grid gives up a few edge tiles (between lanes and
// where a drill would have no ore under it; 96-100% on the captures). Every planned drill sits on its ore.
declare function loadfile(this: void, path: string): ((this: void) => unknown) | undefined
const ORES: Record<string, string> = { i: "iron-ore", c: "copper-ore", k: "coal", s: "stone" }
const BLOCKS: Record<string, number> = { ".": 0, T: 1, R: 2, "#": 3, X: 4, "~": 5, C: 6, "?": 7 }

for (const name of ["seed11-green-boxed", "m6a2-seed222-mall-iron", "m6a2-seed222-green-line"]) {
  test(`B33 captured patches (${name}): whole-patch plans reach every minable ore tile`, () => {
    const chunk = loadfile(`../unit/fixtures/${name}.lua`)
    if (chunk === undefined) error(`fixture ${name} not found (run from mod/build-unit)`)
    const fx = chunk() as { origin: { x: number; y: number }; blocks: string[]; ores: string[] }
    const at = (rows: string[], x: number, y: number): string | undefined => {
      const row = rows[y - fx.origin.y]
      const i = x - fx.origin.x
      return row === undefined || i < 0 || i >= row.length ? undefined : row.substring(i, i + 1)
    }
    const view: TerrainView = {
      block: (x, y) => {
        const c = at(fx.blocks, x, y)
        return c === undefined ? UNKNOWN : (BLOCKS[c] ?? FREE)
      },
      ore: (x, y) => {
        const c = at(fx.ores, x, y)
        return c === undefined ? undefined : ORES[c]
      },
    }
    // Terrain only: the capture's own structures (OWN) count as free ground here, the planner sees the patch bare.
    const bare: TerrainView = { block: (x, y) => (view.block(x, y) === 3 ? FREE : view.block(x, y)), ore: (x, y) => view.ore(x, y) }
    const region = { x: fx.origin.x, y: fx.origin.y, w: fx.ores[0].length, h: fx.ores.length }
    const seen: Record<number, boolean> = {}
    let patches = 0
    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        const ore = bare.ore(x, y)
        if (ore === undefined || seen[tkey(x, y)]) continue
        const patch = connectedPatch(bare, ore, [{ x, y }], region)!
        for (const k of patch.tiles) seen[k] = true
        if (patch.tiles.length < 40) continue
        patches++
        const plan = planWholePatch(bare, patch, ELECTRIC)
        // The upper bound: ore tiles some legal drill position (1-tile grid) reaches.
        const reachable: Record<number, boolean> = {}
        let nReach = 0
        for (let cx = patch.bounds.x - 2; cx < patch.bounds.x + patch.bounds.w + 2; cx++) {
          for (let cy = patch.bounds.y - 2; cy < patch.bounds.y + patch.bounds.h + 2; cy++) {
            if (!candidateOk(bare, ore, ELECTRIC, cx + 0.5, cy + 0.5)) continue
            for (let tx = cx - 2; tx <= cx + 2; tx++) {
              for (let ty = cy - 2; ty <= cy + 2; ty++) {
                if (bare.ore(tx, ty) === ore && !reachable[tkey(tx, ty)]) {
                  reachable[tkey(tx, ty)] = true
                  nReach++
                }
              }
            }
          }
        }
        print(string.format("  %s %d tiles at %d,%d: %d drills cover %d of %d minable", ore, patch.tiles.length, patch.bounds.x, patch.bounds.y, plan.drills.length, plan.covered.length, nReach))
        ok(plan.covered.length >= 0.95 * nReach, `${ore} patch at ${patch.bounds.x},${patch.bounds.y}: ${plan.covered.length}/${nReach} minable tiles covered`)
        for (const d of plan.drills) ok(candidateOk(bare, ore, ELECTRIC, d.x, d.y), `drill ${d.x},${d.y} on its ore and buildable ground`)
      }
    }
    ok(patches > 0, "the capture has patches")
  })
}

// D55 (user, 2026-10-20): a completed whole-patch mine whose ore is used up claims the next free part of its patch.
function workedOut(m: PlacedModule, ore: (this: void, x: number, y: number) => string | undefined): (this: void, x: number, y: number) => string | undefined {
  const gone: Record<number, boolean> = {}
  for (const e of m.def.entities) {
    if (e.name !== "electric-mining-drill") continue
    for (let x = math.floor(m.origin.x + e.x - 2.5); x < m.origin.x + e.x + 2.5; x++) for (let y = math.floor(m.origin.y + e.y - 2.5); y < m.origin.y + e.y + 2.5; y++) gone[tkey(x, y)] = true
  }
  return (x, y) => (gone[tkey(x, y)] ? undefined : ore(x, y))
}

test("D55: a worked-out mine re-claims the next part of its patch; a spent patch has none", () => {
  const region = { x: 0, y: 0, w: 120, h: 80 }
  const ore = (x: number, y: number): string | undefined => (x >= 20 && x < 100 && y >= 20 && y < 34 ? "iron-ore" : undefined)
  const view = patchTerrain(region, ore)
  const state = newLayout()
  const m = placeMine(state, view, region, P2P, "mine", { x: 22, y: 24 })
  ok(m.minePlan !== undefined, "whole-patch plan")
  ok(tryExpand(state, view, F, P2P, "mine", 1).ok, "completed")
  ok(m.minePlan!.complete, "complete")
  const oldDrills: Record<string, boolean> = {}
  let n = 0
  for (const e of m.def.entities) if (e.name === "electric-mining-drill") { oldDrills[string.format("%g,%g", e.x + m.origin.x, e.y + m.origin.y)] = true; n++ }
  const done = patchTerrain(region, workedOut(m, ore))
  ok(!tryExpand(state, done, F, P2P, "mine", 1).ok, "a completed mine can't grow")
  const r = tryExpand(state, done, F, P2P, "mine", 1, "auto", true)
  ok(r.ok, `re-claimed: ${r.reason}`)
  let fresh = 0
  let drills = 0
  for (const e of m.def.entities) {
    if (e.name !== "electric-mining-drill") continue
    drills++
    if (!oldDrills[string.format("%g,%g", e.x + m.origin.x, e.y + m.origin.y)]) fresh++
    ok(candidateOk(done, "iron-ore", ELECTRIC, e.x + m.origin.x, e.y + m.origin.y), `drill ${e.x + m.origin.x},${e.y + m.origin.y} on ore that is left`)
  }
  print(`  ${n} drills before, ${drills} after (${fresh} on new ground), rect ${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h}`)
  ok(drills > 0 && drills <= n, `as many drills at most (${drills}/${n})`)
  ok(fresh === drills, "every drill on fresh ground")
  ok(m.minePlan!.complete, "the new part is built whole")
  // The same mine on a patch it has used up entirely: nothing better is left, it stays where it is.
  const spent = patchTerrain(region, workedOut(m, (x, y) => (x >= m.rect.x && x < m.rect.x + m.rect.w && y >= m.rect.y && y < m.rect.y + m.rect.h ? ore(x, y) : undefined)))
  const at = { ...m.rect }
  const r2 = tryExpand(state, spent, F, P2P, "mine", 1, "auto", true)
  ok(!r2.ok, "no better part of a spent patch")
  print(`  spent: ${r2.reason}`)
  ok(m.rect.x === at.x && m.rect.y === at.y && findModule(state, "mine") === m, "the mine is unchanged")
  ok(state.occ[tkey(m.origin.x + 1, m.origin.y + 1)] !== undefined || state.mine !== undefined, "still marked in the layout")
})

test("D55: planGrowth moves a worked-out mine to the next part of its patch and reroutes its output", () => {
  const region = { x: 0, y: 0, w: 120, h: 90 }
  const ore = (x: number, y: number): string | undefined => (x >= 20 && x < 100 && y >= 50 && y < 64 ? "iron-ore" : undefined)
  const view = patchTerrain(region, ore)
  const state = newLayout()
  placeMine(state, view, region, P2P, "mine", { x: 22, y: 54 })
  ok(tryExpand(state, view, F, P2P, "mine", 1).ok, "completed")
  const smelt = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const sm: PlacedModule = { id: moduleId("smelt"), canonical: smelt, def: smelt, transform: { rot: 0, mirror: false }, origin: { x: 30, y: 10 }, rect: { x: 30, y: 10, w: smelt.footprint.w, h: smelt.footprint.h }, fixed: true }
  commitModule(state, sm, F, 2)
  const job = runJob(newRoutingJob({ modules: [], connections: [{ id: connectionId("ore"), from: { module: moduleId("mine"), port: "out" }, to: { module: moduleId("smelt"), port: "in-ore" } }], center: { x: 40, y: 40 }, region }, beltTiers(F)[0], state), view, F, P2P)
  eq(job.phase, "done", "routed")
  const done = patchTerrain(region, workedOut(findModule(job.layout, "mine")!, ore))
  const g = planGrowth(job.layout, done, F, P2P, beltTiers(F)[0], "mine", 1, "small-electric-pole", "poles:t:", true)
  ok(g.ok, `moved: ${g.reason}`)
  eq(g.rerouted.join(","), "ore", "its output rerouted")
  let added = 0
  let removed = 0
  for (const e of g.add) if (e.name === "electric-mining-drill") added++
  for (const e of g.remove) if (e.name === "electric-mining-drill") removed++
  print(`  ${removed} drills picked up, ${added} placed`)
  ok(added > 0 && removed > 0, "old drills go, new ones come")
})

run("growth-geometry")
