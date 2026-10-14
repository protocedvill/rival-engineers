import { expandModule, expandTail } from "../src/modules/build"
import { assemblerRow, circuitBlock, labArray, miningOutpost, redLine, smelterColumn, steamBlock } from "../src/modules/generators"
import { occupancy, transformDir, transformModule, transformPoint } from "../src/modules/geometry"
import { placePoles, powerCheck } from "../src/modules/poles"
import { INSERTER_EFFICIENCY_FROM_BELT, INSERTER_EFFICIENCY_FROM_MACHINE, rateOf } from "../src/modules/rates"
import { EAST, ModuleDef, ModuleEntity, NORTH, SOUTH, WEST } from "../src/modules/types"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

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

// --- Layout invariants -------------------------------------------------------------------------------------

function allGenerated(): ModuleDef[] {
  return [
    smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }),
    smelterColumn(F, { recipe: "copper-plate", furnaces: 24 }),
    smelterColumn(F, { recipe: "iron-plate", furnaces: 8, inserter: "burner-inserter" }),
    miningOutpost(F, { resource: "iron-ore", rows: 6, sides: 2 }),
    miningOutpost(F, { resource: "copper-ore", rows: 2, sides: 1 }),
    miningOutpost(F, { resource: "stone", rows: 5, sides: 2, drill: "burner-mining-drill" }),
    steamBlock(F, { boilers: 1 }),
    steamBlock(F, { boilers: 4 }),
    assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }),
    assemblerRow(F, { recipe: "transport-belt", count: 6 }),
    assemblerRow(F, { recipe: "pipe", count: 2 }),
    redLine(F, { units: 3 }),
    circuitBlock(F, { units: 2 }),
    labArray(F, { labs: 6, packs: ["automation-science-pack"] }),
    labArray(F, { labs: 10, packs: ["automation-science-pack", "logistic-science-pack"] }),
  ]
}

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

test("expandModule(gen(n), k) is exactly gen(n + k): growth never moves a unit", () => {
  const pairsToCheck: [ModuleDef, number, ModuleDef][] = [
    [smelterColumn(F, { recipe: "iron-plate", furnaces: 4 }), 2, smelterColumn(F, { recipe: "iron-plate", furnaces: 12 })],
    [assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 }), 2, assemblerRow(F, { recipe: "iron-gear-wheel", count: 6 })],
    [assemblerRow(F, { recipe: "copper-cable", count: 2 }), 1, assemblerRow(F, { recipe: "copper-cable", count: 4 })],
    [redLine(F, { units: 1 }), 2, redLine(F, { units: 3 })],
    [circuitBlock(F, { units: 1 }), 1, circuitBlock(F, { units: 2 })],
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
