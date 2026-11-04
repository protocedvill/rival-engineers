import { expandHeadModule, expandModule, expandMoves, expandTail, finalizeModule } from "../src/modules/build"
import { assemblerRow, chemRow, chestCell, circuitBlock, labArray, miningOutpost, oilComplex, radarCell, redLine, roboportCell, smelterColumn, steamBlock } from "../src/modules/generators"
import { beltLeaks, occupancy, transformDir, transformModule, transformPoint } from "../src/modules/geometry"
import { placePoles, powerCheck } from "../src/modules/poles"
import { INSERTER_EFFICIENCY_FROM_BELT, INSERTER_EFFICIENCY_FROM_MACHINE, rateOf } from "../src/modules/rates"
import { CuratedModuleFile, EAST, ModuleDef, ModuleEntity, NORTH, SOUTH, WEST } from "../src/modules/types"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

/** @noSelf */
declare function require(this: void, module: string): unknown
// Written next to the compiled tests by tools/run-unit-tests.mjs, exactly as the mod build ships it.
const curatedFiles = require("modules.curated_data") as Record<string, CuratedModuleFile>

// Inserter throughput used by the rate engine: one item per full turn (yellow: 0.014 rev/tick).
const INS_BELT = 60 * 0.014 * INSERTER_EFFICIENCY_FROM_BELT
const INS_MACHINE = 60 * 0.014 * INSERTER_EFFICIENCY_FROM_MACHINE

function out(def: ModuleDef, item: string): number {
  return rateOf(def.rates.outputs, item)
}
function inp(def: ModuleDef, item: string): number {
  return rateOf(def.rates.inputs, item)
}

function entityKeys(def: ModuleDef): string[] {
  // %g: Lua 5.3+ prints 3 and 3.0 differently.
  const keys = def.entities.map((e) => `${e.name}@${string.format("%g,%g", e.x, e.y)}/${e.dir ?? 0}/${e.recipe ?? ""}/${e.ioType ?? ""}`)
  keys.sort()
  return keys
}

function sameLayout(a: ModuleDef, b: ModuleDef, what: string): void {
  eq(a.footprint.w, b.footprint.w, `${what} width`)
  eq(a.footprint.h, b.footprint.h, `${what} height`)
  const ka = entityKeys(a)
  const kb = entityKeys(b)
  eq(ka.length, kb.length, `${what} entity count`)
  for (let i = 0; i < ka.length; i++) eq(ka[i], kb[i], `${what} entity ${i}`)
  for (const p of a.ports) {
    let found = false
    for (const q of b.ports) if (q.id === p.id && q.pos.x === p.pos.x && q.pos.y === p.pos.y && q.dir === p.dir) found = true
    ok(found, `${what} port ${p.id} at ${p.pos.x},${p.pos.y}`)
  }
}

// --- Ratio sanity: rate math against hand-computed numbers --------------------------------------------------

test("stone furnace smelts 0.3125 iron plates/s; a 12-furnace column makes 3.75/s", () => {
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 12 })
  near(out(def, "iron-plate"), 12 / 3.2, 1e-9, "plates/s")
  near(out(def, "iron-plate"), 3.75, 1e-9, "plates/s")
  near(inp(def, "iron-ore"), 3.75, 1e-9, "ore/s")
  // 90 kW per furnace from 4 MJ coal.
  near(inp(def, "coal"), (12 * 90e3) / 4e6, 1e-9, "coal/s")
  near(inp(def, "electricity"), 24 * 245 * 60, 1e-6, "inserter power W")
  eq(def.footprint.w, 11, "width")
  eq(def.footprint.h, 16, "height")
})

test("stone bricks: 2 stone per brick, 0.3125 bricks/s per furnace", () => {
  const def = smelterColumn(F, { recipe: "stone-brick", furnaces: 4 })
  near(out(def, "stone-brick"), 4 * 0.3125, 1e-9, "bricks/s")
  near(inp(def, "stone"), 4 * 0.625, 1e-9, "stone/s")
  // A lane carries 7.5/s: 12 brick furnaces (0.625 stone/s each) per column, so 2 more units.
  eq(def.expand!.maxUnits, 2, "max units")
})

test("assembling-machine-1 crafts at speed 0.5: one gear/s ideal, capped by two input inserters", () => {
  const def = assemblerRow(F, { recipe: "iron-gear-wheel", count: 4 })
  // Ideal: 0.5 / 0.5 s = 1 craft/s needs 2 plates/s; two belt inserters move 2 × 0.714/s.
  const perMachine = (2 * INS_BELT) / 2
  near(out(def, "iron-gear-wheel"), 4 * perMachine, 1e-9, "gears/s")
  near(inp(def, "iron-plate"), 4 * 2 * perMachine, 1e-9, "plates/s")
})

test("copper cable row: 2 cable/s ideal per machine, capped by two output inserters", () => {
  const def = assemblerRow(F, { recipe: "copper-cable", count: 2 })
  near(out(def, "copper-cable"), 2 * 2 * INS_MACHINE, 1e-9, "cable/s")
  near(inp(def, "copper-plate"), 2 * INS_MACHINE, 1e-9, "copper/s")
})

test("red line: 0.1 red/s per assembler (5 s at speed 0.5), gears made inside", () => {
  const def = redLine(F, { units: 1 })
  near(out(def, "automation-science-pack"), 0.2, 1e-9, "red/s")
  near(inp(def, "copper-plate"), 0.2, 1e-9, "copper/s")
  near(inp(def, "iron-plate"), 0.4, 1e-9, "iron/s")
  eq(inp(def, "iron-gear-wheel"), 0, "gears are internal")
  ok(def.requiresTech.indexOf("automation") >= 0, "needs automation")
})

test("circuit block 3:2, cable limited by direct-insertion inserters", () => {
  const def = circuitBlock(F, { units: 1 })
  // Outer cable assemblers pass cable through 2 inserters, the middle one through 4.
  const cable = 2 * (2 * INS_MACHINE) + 2
  const circuits = cable / 3
  near(out(def, "electronic-circuit"), circuits, 1e-9, "circuits/s")
  near(inp(def, "iron-plate"), circuits, 1e-9, "iron/s")
  near(inp(def, "copper-plate"), cable / 2, 1e-9, "copper/s")
})

test("steam block: 1.8 MW per boiler, two engines each, 0.45 coal/s per boiler", () => {
  const def = steamBlock(F, { boilers: 2 })
  near(out(def, "electricity"), 3.6e6, 1e-3, "W")
  near(inp(def, "coal"), 0.9, 1e-9, "coal/s")
  eq(def.upkeep, undefined, "burner inserters feed themselves from the coal they carry")
  eq(def.site, "shore", "site")
  eq(inp(def, "electricity"), 0, "no electric consumers")
  // One pump gives 1200 water/s = 20 boilers.
  eq(def.expand!.maxUnits, 18, "max units")
})

test("mining outposts: electric drill 0.5 ore/s, burner drill 0.25/s (crew-fuelled)", () => {
  const e = miningOutpost(F, { resource: "iron-ore", rows: 4, sides: 2 })
  near(out(e, "iron-ore"), 8 * 0.5, 1e-9, "electric ore/s")
  eq(e.site, "resource-patch", "site")
  eq(e.anchor!.miningAreas!.length, 8, "mining areas")
  const area = e.anchor!.miningAreas![0]
  eq(area.w, 5, "area width")
  eq(area.h, 5, "area height")
  const b = miningOutpost(F, { resource: "coal", rows: 3, drill: "burner-mining-drill" })
  near(out(b, "coal"), 6 * 0.25, 1e-9, "burner coal/s")
  eq(b.upkeep!.fuel[0].name, "burner-mining-drill", "upkeep")
  eq(b.upkeep!.fuel[0].count, 6, "upkeep count")
  eq(b.anchor!.miningAreas![0].w, 2, "burner area")
})

test("lab array: research units at 1/unitTime per lab, packs merged on one belt", () => {
  const def = labArray(F, { labs: 4, packs: ["automation-science-pack", "logistic-science-pack"], unitTime: 30 })
  near(out(def, "research-unit"), 4 / 30, 1e-9, "units/s")
  near(inp(def, "automation-science-pack"), 4 / 30, 1e-9, "red/s")
  near(inp(def, "logistic-science-pack"), 4 / 30, 1e-9, "green/s")
  // At 5 s per unit the belt-fed lab's one inserter can't carry packs for both labs.
  const fast = labArray(F, { labs: 2, packs: ["automation-science-pack", "logistic-science-pack"], unitTime: 5 })
  near(out(fast, "research-unit"), INS_BELT / 2, 1e-9, "inserter-limited units/s")
})

test("D42 / B5: a smelter column's buffer depot: an inserter off the west output belt into a chest; rates unchanged", () => {
  const plain = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4, buffer: "iron-chest" })
  eq(def.entities.length, plain.entities.length + 2, "one inserter and one chest more")
  const chest = def.entities.filter((e) => e.buffer === true)
  eq(chest.length, 1, "one buffer chest")
  eq(chest[0].name, "iron-chest", "the configured chest")
  eq(`${chest[0].x},${chest[0].y}`, "2.5,1.5", "in the gap row")
  const ins = def.entities.filter((e) => e.x === 1.5 && e.y === 1.5)[0]
  eq(ins.name, "inserter", "an inserter next to it")
  eq(ins.dir, WEST, "picks from the west output belt (0.5, 1.5)")
  const belt = def.entities.filter((e) => e.x === 0.5 && e.y === 1.5)[0]
  eq(belt.name, "transport-belt", "the output belt it picks from")
  near(out(def, "iron-plate"), out(plain, "iron-plate"), 1e-9, "the buffer is no demand: same output rate")
  near(inp(def, "iron-ore"), inp(plain, "iron-ore"), 1e-9, "same input")
  ok(def.id !== plain.id, "a different module id")
  eq(def.expand!.unit.entities.length, plain.expand!.unit.entities.length, "units unchanged (the buffer stays at the head)")
  const burner = smelterColumn(F, { recipe: "iron-plate", furnaces: 4, inserter: "burner-inserter", buffer: "iron-chest" })
  eq(burner.entities.filter((e) => e.buffer === true).length, 0, "no buffer with burner inserters (it would need fuel)")
})

test("D51 / B14: gear rows and circuit blocks get a buffer head at the output end; rates and units unchanged", () => {
  const cases: [ModuleDef, ModuleDef, string][] = [
    [assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }), assemblerRow(F, { recipe: "iron-gear-wheel", count: 2, buffer: "iron-chest" }), "iron-gear-wheel"],
    [circuitBlock(F, { units: 1 }), circuitBlock(F, { units: 1, buffer: "iron-chest" }), "electronic-circuit"],
  ]
  for (const [plain, def, item] of cases) {
    eq(def.footprint.w, plain.footprint.w + 2, `${def.id}: two columns wider`)
    const chest = def.entities.filter((e) => e.buffer === true)
    eq(chest.length, 1, "one buffer chest")
    eq(`${chest[0].x},${chest[0].y}`, "1.5,2.5", "at the head")
    const ins = def.entities.filter((e) => e.x === 1.5 && e.y === 1.5)[0]
    eq(ins.name, "inserter", "an inserter above it")
    eq(ins.dir, NORTH, "picks from the output belt (1.5, 0.5)")
    eq(def.entities.filter((e) => e.x === 1.5 && e.y === 0.5)[0].name, "transport-belt", "the output belt runs past it")
    const outPort = def.ports.filter((p) => p.kind === "belt-out")[0]
    eq(`${outPort.pos.x},${outPort.pos.y}`, "0.5,0.5", "output port at the head")
    near(out(def, item), out(plain, item), 1e-9, "the buffer is no demand: same output")
    eq(def.expand!.unit.entities.length, plain.expand!.unit.entities.length, "same unit")
    eq(def.expand!.insertAt, plain.expand!.insertAt + 2, "units go in at the same place")
    eq(def.expand!.maxUnits, plain.expand!.maxUnits, "same cap")
  }
})

test("D38: a chest cell (temporary factory): chest → inserter → assembler → inserter → chest, rates of one assembler", () => {
  const gear = chestCell(F, { recipe: "iron-gear-wheel" })
  eq(gear.footprint.w * 10 + gear.footprint.h, 73, "7 × 3")
  // The assembler could make 1 gear/s; one yellow inserter brings ~0.84 plates/s, so ~0.42 gears/s.
  ok(out(gear, "iron-gear-wheel") > 0.4 && out(gear, "iron-gear-wheel") < 0.5, `inserter-limited gears ${out(gear, "iron-gear-wheel")}/s`)
  near(inp(gear, "iron-plate"), 2 * out(gear, "iron-gear-wheel"), 1e-9, "2 plates per gear")
  const red = chestCell(F, { recipe: "automation-science-pack" })
  near(out(red, "automation-science-pack"), 0.1, 1e-9, "0.1 red/s")
  const ins = red.ports.filter((p) => p.kind === "chest-in").map((p) => p.item!).sort()
  eq(ins.join(","), "copper-plate,iron-gear-wheel", "one chest-in port per ingredient")
  eq(red.ports.filter((p) => p.kind === "chest-out")[0].item, "automation-science-pack", "chest-out: the product")
  eq(red.expand, undefined, "not expandable (temporary)")
})

test("radar cell (D56): one radar and its pole, 4 × 3, powered, no belts", () => {
  const m = radarCell(F, {})
  eq(m.footprint.w * 10 + m.footprint.h, 43, "4 × 3")
  eq(m.ports.length, 1, "one port")
  eq(m.ports[0].kind, "power", "the power port")
  near(inp(m, "electricity"), 300000, 1e-6, "300 kW")
  eq(m.entities.filter((e) => e.name === "radar").length, 1, "one radar")
})

test("M7d.5: roboport cell: one roboport and its pole, 5 × 4; the hub holds two storage chests", () => {
  const m = roboportCell(F, {})
  eq(m.footprint.w * 10 + m.footprint.h, 54, "5 × 4")
  eq(m.ports.length, 1, "one port")
  eq(m.ports[0].kind, "power", "the power port")
  near(inp(m, "electricity"), 50000, 1e-6, "50 kW")
  eq(m.entities.filter((e) => e.name === "roboport").length, 1, "one roboport")
  eq(m.entities.filter((e) => e.name === "storage-chest").length, 0, "no chests")
  const hub = roboportCell(F, { chests: 2 })
  eq(hub.footprint.w * 10 + hub.footprint.h, 54, "same footprint")
  eq(hub.entities.filter((e) => e.name === "storage-chest").length, 2, "two storage chests")
  ok(hub.id !== m.id, "distinct ids")
})

test("M7d.5: a passive-provider buffer head is a chest like an iron one: same rates and buffer flag", () => {
  const iron = assemblerRow(F, { recipe: "iron-gear-wheel", count: 4, buffer: "iron-chest" })
  const prov = assemblerRow(F, { recipe: "iron-gear-wheel", count: 4, buffer: "passive-provider-chest" })
  near(rateOf(prov.rates.outputs, "iron-gear-wheel"), rateOf(iron.rates.outputs, "iron-gear-wheel"), 1e-9, "same output")
  const b = prov.entities.filter((e) => e.buffer === true)
  eq(b.length, 1, "one buffer")
  eq(b[0].name, "passive-provider-chest", "the provider")
})

test("M7d.5 (user request in-session 2026-11-04): a roboport head puts the row's robots into a roboport, the rest into the supply chest", () => {
  const plain = assemblerRow(F, { recipe: "construction-robot", count: 2, buffer: "passive-provider-chest" })
  const hub = assemblerRow(F, { recipe: "construction-robot", count: 2, buffer: "passive-provider-chest", roboport: "roboport", storageChest: "storage-chest", storage: 2 })
  near(rateOf(hub.rates.outputs, "construction-robot"), rateOf(plain.rates.outputs, "construction-robot"), 1e-9, "same output")
  eq(hub.footprint.w - plain.footprint.w, 4, "four columns wider than a buffer head")
  eq(hub.footprint.h, plain.footprint.h, "same height")
  const ports = hub.entities.filter((e) => e.name === "roboport")
  eq(ports.length, 1, "one roboport")
  eq(hub.entities.filter((e) => e.name === "storage-chest").length, 2, "two storage chests")
  const b = hub.entities.filter((e) => e.buffer === true)
  eq(b.length, 1, "one buffer (the supply chest)")
  eq(b[0].name, "passive-provider-chest", "the provider")
  // Each head inserter (facing north) picks from the output belt above it and drops on the tile below.
  const r = ports[0]
  const drops = hub.entities.filter((e) => e.name === "inserter" && e.y === 1.5 && e.x < 6).map((e) => ({ x: e.x, y: e.y + 1 }))
  eq(drops.length, 2, "two head inserters")
  ok(drops.some((d) => math.abs(d.x - r.x) < 2 && math.abs(d.y - r.y) < 2), "one drops into the roboport")
  ok(drops.some((d) => d.x === b[0].x && d.y === b[0].y), "one drops into the supply chest")
  const out = hub.ports.find((p) => p.kind === "belt-out")!
  eq(`${out.pos.x},${out.pos.y}`, "0.5,0.5", "the belt runs on to the west edge")
  ok(hub.id !== plain.id, "distinct ids")
  // Without a buffer chest (or an electric inserter) the head is left out.
  const none = assemblerRow(F, { recipe: "construction-robot", count: 2, roboport: "roboport", storage: 2 })
  eq(none.entities.filter((e) => e.name === "roboport").length, 0, "no buffer: no roboport head")
})

// --- Layout invariants -------------------------------------------------------------------------------------

function allGenerated(): ModuleDef[] {
  return [
    roboportCell(F, { chests: 2 }),
    assemblerRow(F, { recipe: "construction-robot", count: 2, buffer: "passive-provider-chest", roboport: "roboport", storage: 2 }),
    smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }),
    smelterColumn(F, { recipe: "copper-plate", furnaces: 24 }),
    smelterColumn(F, { recipe: "iron-plate", furnaces: 8, inserter: "burner-inserter" }),
    smelterColumn(F, { recipe: "iron-plate", furnaces: 4, buffer: "iron-chest" }),
    smelterColumn(F, { recipe: "copper-plate", furnaces: 12, buffer: "iron-chest" }),
    miningOutpost(F, { resource: "iron-ore", rows: 6, sides: 2 }),
    miningOutpost(F, { resource: "copper-ore", rows: 2, sides: 1 }),
    miningOutpost(F, { resource: "stone", rows: 5, sides: 2, drill: "burner-mining-drill" }),
    steamBlock(F, { boilers: 1 }),
    steamBlock(F, { boilers: 4 }),
    assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }),
    assemblerRow(F, { recipe: "transport-belt", count: 6 }),
    assemblerRow(F, { recipe: "pipe", count: 2 }),
    assemblerRow(F, { recipe: "iron-gear-wheel", count: 4, buffer: "iron-chest" }),
    assemblerRow(F, { recipe: "transport-belt", count: 2, buffer: "iron-chest" }),
    circuitBlock(F, { units: 2, buffer: "iron-chest" }),
    radarCell(F, {}),
    redLine(F, { units: 3 }),
    circuitBlock(F, { units: 2 }),
    labArray(F, { labs: 6, packs: ["automation-science-pack"] }),
    labArray(F, { labs: 10, packs: ["automation-science-pack", "logistic-science-pack"] }),
    chestCell(F, { recipe: "iron-gear-wheel" }),
    chestCell(F, { recipe: "transport-belt" }),
    chestCell(F, { recipe: "automation-science-pack" }),
  ]
}

test("M7d.5 (seed 11 g154): every belt and pipe port is fed from (or leads to) a tile outside its module", () => {
  const defs = [...allGenerated()]
  for (const recipe of ["battery", "plastic-bar", "sulfur", "sulfuric-acid"]) for (const c of [1, 2, 4]) defs.push(chemRow(F, { recipe, chemPlants: c }))
  defs.push(assemblerRow(F, { recipe: "flying-robot-frame", count: 2 }), assemblerRow(F, { recipe: "electric-engine-unit", count: 2 }))
  defs.push(oilComplex(F, { refineries: 2, lubePlants: 1 }))
  const D = [[0, -1], [1, 0], [0, 1], [-1, 0]]
  for (const def of defs) {
    for (const p of def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out" && p.kind !== "pipe-in" && p.kind !== "pipe-out") continue
      const [dx, dy] = D[math.floor(p.dir / 4)]
      const sign = p.kind === "belt-in" || p.kind === "pipe-in" ? -1 : 1
      const x = math.floor(p.pos.x) + sign * dx
      const y = math.floor(p.pos.y) + sign * dy
      ok(x < 0 || y < 0 || x >= def.footprint.w || y >= def.footprint.h, `${def.id} port ${p.id}: its outside tile ${x},${y} is inside the ${def.footprint.w}x${def.footprint.h} footprint`)
    }
  }
})

test("every generated module: no overlaps, inside its footprint, all powered on one pole network", () => {
  for (const def of allGenerated()) {
    occupancy(def.entities, F)
    const pc = powerCheck(def.entities, F)
    eq(pc.unpowered.length, 0, `${def.id} unpowered ${pc.unpowered.join(" ")}`)
    ok(pc.networks <= 1, `${def.id} has ${pc.networks} pole networks`)
    for (const n of def.notes ?? []) ok(string.sub(n, 1, 6) !== "rates:", `${def.id}: ${n}`)
    let powerPort = false
    for (const p of def.ports) {
      if (p.kind === "power") powerPort = true
      if (p.kind === "belt-in" || p.kind === "belt-out") {
        ok(p.item !== undefined, `${def.id} port ${p.id} is single-item`)
        // Belt ports sit on the footprint edge, pointing across it.
        const onEdge = p.pos.x === 0.5 || p.pos.y === 0.5 || p.pos.x === def.footprint.w - 0.5 || p.pos.y === def.footprint.h - 0.5
        ok(onEdge, `${def.id} port ${p.id} on the edge`)
      }
    }
    ok(powerPort === pc.networks > 0, `${def.id} power port iff it has poles`)
  }
})

// --- B25: belts never run out of a module except at a belt-out port -------------------------------------------

/** Every module layout the library can produce: generated (base, grown at the tail by 1–2 units) and curated. */
function everyLayout(): ModuleDef[] {
  const out: ModuleDef[] = []
  for (const def of allGenerated()) {
    out.push(def)
    const max = def.expand?.maxUnits ?? 0
    for (let k = 1; k <= math.min(2, max); k++) out.push(expandModule(def, k, F))
  }
  for (const [, f] of pairs(curatedFiles)) {
    // Geometry only: the curated recipes need prototypes the T1 facts table doesn't have (the T2 lab finalizes them).
    out.push({ ...f, source: "curated", recipes: [], machines: [], rates: { inputs: [], outputs: [] }, requiresTech: [], rotatable: f.rotatable ?? true, mirrorable: f.mirrorable ?? true, expand: undefined } as ModuleDef)
  }
  return out
}

test("B25: no module belt feeds out of its footprint except at a belt-out port, in every orientation", () => {
  let curated = 0
  for (const def of everyLayout()) {
    if (def.source === "curated") curated++
    for (let rot = 0; rot < 4; rot++) {
      for (const mirror of [false, true]) {
        if ((rot > 0 && !def.rotatable) || (mirror && !def.mirrorable)) continue
        const t = transformModule(def, { rot, mirror })
        const leaks = beltLeaks(t, F)
        eq(leaks.length, 0, `${def.id} rot ${rot} mirror ${tostring(mirror)}: ${leaks.join("; ")}`)
      }
    }
  }
  ok(curated >= 3, `curated modules checked (${curated})`)
})

test("B25: beltLeaks flags a belt, an underground exit or a splitter half pointing out with no port; finalize refuses it", () => {
  const box = { w: 4, h: 4 }
  const leaks = (entities: ModuleEntity[], ports: ModuleDef["ports"] = []): number => beltLeaks({ footprint: box, entities, ports }, F).length
  eq(leaks([{ name: "transport-belt", x: 1.5, y: 0.5, dir: NORTH }]), 1, "belt out of the north edge")
  eq(leaks([{ name: "transport-belt", x: 0.5, y: 2.5, dir: WEST }]), 1, "belt out of the west edge")
  eq(leaks([{ name: "transport-belt", x: 1.5, y: 0.5, dir: EAST }]), 0, "belt along the edge")
  eq(leaks([{ name: "transport-belt", x: 1.5, y: 0.5, dir: NORTH }], [{ id: "out", kind: "belt-out", pos: { x: 1.5, y: 0.5 }, dir: NORTH, item: "iron-plate" }]), 0, "belt-out port")
  eq(leaks([{ name: "transport-belt", x: 1.5, y: 0.5, dir: NORTH }], [{ id: "in", kind: "belt-in", pos: { x: 1.5, y: 0.5 }, dir: NORTH, item: "iron-plate" }]), 1, "a belt-in port doesn't excuse it")
  eq(leaks([{ name: "transport-belt", x: 1.5, y: 0.5, dir: NORTH }], [{ id: "out", kind: "belt-out", pos: { x: 1.5, y: 0.5 }, dir: WEST, item: "iron-plate" }]), 1, "port pointing elsewhere")
  eq(leaks([{ name: "underground-belt", x: 1.5, y: 0.5, dir: NORTH, ioType: "output" }]), 1, "underground exit")
  eq(leaks([{ name: "underground-belt", x: 1.5, y: 0.5, dir: NORTH, ioType: "input" }]), 0, "underground entrance (goes under)")
  eq(leaks([{ name: "splitter", x: 2, y: 0.5, dir: NORTH }]), 2, "both splitter halves")
  eq(leaks([{ name: "splitter", x: 2, y: 0.5, dir: NORTH }], [{ id: "out", kind: "belt-out", pos: { x: 2.5, y: 0.5 }, dir: NORTH, item: "iron-plate" }]), 1, "one splitter half has a port")
  eq(leaks([{ name: "splitter", x: 3.5, y: 2, dir: EAST }]), 2, "east splitter halves")
  const [built, err] = pcall(() =>
    finalizeModule({ id: "leaky", source: "generated", footprint: box, entities: [{ name: "transport-belt", x: 1.5, y: 0.5, dir: NORTH }], ports: [], rotatable: true, mirrorable: true }, F),
  )
  ok(!built && string.find(tostring(err), "no belt-out port", 1, true)[0] !== undefined, `finalize refuses a leaking layout: ${tostring(err)}`)
})

test("B25: row modules' input belts end at the first machine's inserter; head growth that would open a belt is refused", () => {
  const row = assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })
  let head: ModuleEntity | undefined
  for (const e of row.entities) if (e.name === "transport-belt" && e.y === 6.5 && (head === undefined || e.x < head.x)) head = e
  eq(head?.x, 1.5, "the input belt's last tile is under the first input inserter")
  // Growing at the head puts new units' belts at the west edge, where nothing closes them.
  for (const def of allGenerated()) {
    if ((def.expand?.maxUnits ?? 0) < 1) continue
    const grown = expandHeadModule(def, 1, F)
    if (grown !== undefined) eq(beltLeaks(grown, F).length, 0, `${def.id} grown at the head`)
  }
  eq(expandHeadModule(labArray(F, { labs: 2, packs: ["automation-science-pack"] }), 1, F), undefined, "lab array head growth refused")
})

test("expandModule(gen(n), k) is exactly gen(n + k): growth never moves a unit", () => {
  const pairsToCheck: [ModuleDef, number, ModuleDef][] = [
    [smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 2, smelterColumn(F, { recipe: "iron-plate", furnaces: 12 })],
    [assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }), 2, assemblerRow(F, { recipe: "iron-gear-wheel", count: 6 })],
    [assemblerRow(F, { recipe: "copper-cable", count: 2 }), 1, assemblerRow(F, { recipe: "copper-cable", count: 4 })],
    [redLine(F, { units: 1 }), 2, redLine(F, { units: 3 })],
    [circuitBlock(F, { units: 1 }), 1, circuitBlock(F, { units: 2 })],
    [assemblerRow(F, { recipe: "iron-gear-wheel", count: 2, buffer: "iron-chest" }), 2, assemblerRow(F, { recipe: "iron-gear-wheel", count: 6, buffer: "iron-chest" })],
    [circuitBlock(F, { units: 1, buffer: "iron-chest" }), 1, circuitBlock(F, { units: 2, buffer: "iron-chest" })],
    [labArray(F, { labs: 2, packs: ["automation-science-pack", "logistic-science-pack"] }), 3, labArray(F, { labs: 8, packs: ["automation-science-pack", "logistic-science-pack"] })],
    [miningOutpost(F, { resource: "iron-ore", rows: 2 }), 2, miningOutpost(F, { resource: "iron-ore", rows: 6 })],
    [miningOutpost(F, { resource: "coal", rows: 1, drill: "burner-mining-drill" }), 4, miningOutpost(F, { resource: "coal", rows: 5, drill: "burner-mining-drill" })],
    [steamBlock(F, { boilers: 1 }), 2, steamBlock(F, { boilers: 3 })],
  ]
  for (const [base, k, target] of pairsToCheck) {
    const grown = expandModule(base, k, F)
    sameLayout(grown, target, `${base.id} + ${k}`)
    for (const r of target.rates.outputs) near(out(grown, r.item), r.perSecond, 1e-9, `${base.id} + ${k} ${r.item}`)
    // Per-unit rates add up.
    const perUnit = rateOf(base.expand!.perUnit.rates.outputs, target.rates.outputs[0].item)
    near(out(base, target.rates.outputs[0].item) + k * perUnit, out(target, target.rates.outputs[0].item), 1e-6, `${base.id} per-unit rate`)
  }
})

test("expandTail lists only the entities that move (the tail beyond insertAt)", () => {
  const base = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const tail = expandTail(base)
  eq(tail.length, 5, "the merge belts and the two input port belts")
  for (const e of tail) ok(e.y >= base.expand!.insertAt, "tail entity beyond insertAt")
  eq(expandTail(miningOutpost(F, { resource: "iron-ore", rows: 2 })).length, 0, "outposts grow at the far end")
  const m = expandMoves(base, 2)
  eq(m.moved.length, 5, "the tail is smaller than the head")
  eq(m.originShift.y, 0, "origin stays")
})

test("expandMoves: moving the head instead keeps every tail entity in place in the world", () => {
  // A module whose head is small: one belt before insertAt, three after.
  const base = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  const def: ModuleDef = { ...base, expand: { ...base.expand!, insertAt: 1 } }
  const m = expandMoves(def, 1)
  eq(m.originShift.y, -4, "origin moves back one unit")
  for (const e of m.moved) ok(e.y < 1, "only head entities move")
})

// --- Transforms ----------------------------------------------------------------------------------------------

test("transforms: directions, points, footprints, port sides", () => {
  eq(transformDir(NORTH, { rot: 1, mirror: false }), EAST, "N rot 1")
  eq(transformDir(WEST, { rot: 1, mirror: false }), NORTH, "W rot 1")
  eq(transformDir(EAST, { rot: 0, mirror: true }), WEST, "E mirrored")
  eq(transformDir(NORTH, { rot: 0, mirror: true }), NORTH, "N mirrored")
  eq(transformDir(EAST, { rot: 2, mirror: true }), EAST, "E mirrored + 180")
  // A 4 × 2 box rotated clockwise becomes 2 × 4; its top-left corner goes to the top-right.
  const p = transformPoint({ x: 0, y: 0 }, 4, 2, { rot: 1, mirror: false })
  eq(p.x, 2, "corner x")
  eq(p.y, 0, "corner y")
  const def = smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })
  for (let rot = 0; rot < 4; rot++) {
    for (const mirror of [false, true]) {
      const t = transformModule(def, { rot, mirror })
      eq(t.footprint.w, rot % 2 === 1 ? def.footprint.h : def.footprint.w, "footprint w")
      occupancy(t.entities, F)
      for (const e of t.entities) ok(e.x > 0 && e.y > 0 && e.x < t.footprint.w && e.y < t.footprint.h, `entity inside after rot ${rot}`)
      const pc = powerCheck(t.entities, F)
      eq(pc.unpowered.length, 0, `powered after rot ${rot} mirror ${tostring(mirror)}`)
    }
  }
  // Four quarter turns are the identity.
  let t = def
  for (let i = 0; i < 4; i++) t = transformModule(t, { rot: 1, mirror: false })
  sameLayout(t, def, "rot 4")
  // Mirroring swaps the lane a port expects.
  const withSide: ModuleDef = { ...def, ports: [{ id: "x", kind: "belt-in", pos: { x: 0.5, y: 3.5 }, dir: EAST, item: "coal", side: "left" }] }
  eq(transformModule(withSide, { rot: 0, mirror: true }).ports[0].side, "right", "mirrored side")
  eq(transformModule(withSide, { rot: 0, mirror: true }).ports[0].dir, WEST, "mirrored dir")
  eq(transformModule(withSide, { rot: 2, mirror: false }).ports[0].dir, WEST, "rot 2 dir")
  eq(transformModule(withSide, { rot: 1, mirror: false }).ports[0].dir, SOUTH, "rot 1 dir")
})

test("placePoles covers a row of inserters with connected poles", () => {
  const ents: ModuleEntity[] = []
  for (let x = 0; x < 20; x += 2) ents.push({ name: "inserter", x: x + 0.5, y: 0.5, dir: NORTH })
  const poles = placePoles({ w: 20, h: 2 }, ents, F)
  const pc = powerCheck([...ents, ...poles], F)
  eq(pc.unpowered.length, 0, "unpowered")
  eq(pc.networks, 1, "one network")
  ok(poles.length <= 4, `${poles.length} poles`)
})

run("modules")
