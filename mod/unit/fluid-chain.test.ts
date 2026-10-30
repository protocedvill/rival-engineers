import { assemblerRow, fluidChain, labArray, pumpjackField, waterPump } from "../src/modules/generators"
import { powerCheck } from "../src/modules/poles"
import { occupancy } from "../src/modules/geometry"
import { rateOf } from "../src/modules/rates"
import { ModuleDef } from "../src/modules/types"
import { DX, DY } from "../src/planner/grid"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: M7b fluid-chain modules. Refineries under chemical plants; rates from the recipes (fluids piped, items by
// inserter); only risers touch a machine's fluid boxes, so unused boxes touch nothing and two fluids never meet.

/** Pipe-like entities: tile → name. */
function pipes(def: ModuleDef): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of def.entities) if (e.name === "pipe" || e.name === "pipe-to-ground") out[`${math.floor(e.x)},${math.floor(e.y)}`] = e.name
  return out
}

test("fluid chain: plastic from 2 refineries and 2 chemical plants; one plant is inserter-bound", () => {
  // One plant: its long-handed output inserter moves 1.2 bars/s (the plant could make 2/s).
  near(rateOf(fluidChain(F, { recipe: "plastic-bar", chemPlants: 1, refineries: 2 }).rates.outputs, "plastic-bar"), 1.2, 1e-6, "one plant")
  const def = fluidChain(F, { recipe: "plastic-bar", chemPlants: 2, refineries: 2 })
  // 2 refineries × 9 petroleum/s = 18/s; plastic: 20 petroleum per craft (2 bars) → 0.9 crafts/s, 1.8 bars/s.
  near(rateOf(def.rates.outputs, "plastic-bar"), 1.8, 1e-6, "plastic")
  near(rateOf(def.rates.inputs, "crude-oil"), 40, 1e-6, "crude")
  near(rateOf(def.rates.inputs, "coal"), 0.9, 1e-6, "coal")
  eq(def.rates.inputs.find((r) => r.item === "crude-oil")?.kind, "fluid", "crude is a fluid input")
  const kinds = def.ports.map((p) => `${p.kind}:${p.item ?? ""}`).sort().join(" ")
  eq(kinds, "belt-in:coal belt-out:plastic-bar pipe-in:crude-oil power:", "ports")
})

test("fluid chain: no two entities overlap; the refinery's unused boxes touch no pipe", () => {
  const def = fluidChain(F, { recipe: "plastic-bar", chemPlants: 1, refineries: 2 })
  // occupancy errors on overlap.
  occupancy(def.entities, F)
  const p = pipes(def)
  for (let i = 0; i < 2; i++) {
    const x0 = 1 + 5 * i
    // Water input (box 1) points at (x0 + 1, 14); heavy and light oil at (x0, 8) and (x0 + 2, 8).
    eq(p[`${x0 + 1},14`], undefined, "the unused water box's tile is empty")
    eq(p[`${x0},8`], undefined, "heavy oil's tile is empty")
    eq(p[`${x0 + 2},8`], undefined, "light oil's tile is empty")
    ok(p[`${x0 + 4},8`] === "pipe" && p[`${x0 + 3},14`] === "pipe", "petroleum and crude risers")
  }
})

test("fluid chain: sulfur gets water by pipe-to-ground to the plant's other box, apart from the petroleum", () => {
  const def = fluidChain(F, { recipe: "sulfur", chemPlants: 1, refineries: 1 })
  // 1 refinery: 9 petroleum/s; sulfur takes 30 → 0.3 crafts/s, 0.6 sulfur/s, 9 water/s.
  near(rateOf(def.rates.outputs, "sulfur"), 0.6, 1e-6, "sulfur")
  near(rateOf(def.rates.inputs, "water"), 9, 1e-6, "water")
  const p = pipes(def)
  // Water is the recipe's first fluid (box 1, at (3, 6) for the south-facing plant), petroleum box 2 at (1, 6).
  eq(p["3,6"], "pipe-to-ground", "water rises on a pipe-to-ground")
  eq(p["1,6"], "pipe", "petroleum riser")
  // No plain pipe of the water network sits next to a petroleum pipe: water only shows above ground at row 17.
  for (let x = 0; x < def.footprint.w; x++) eq(p[`${x},16`] === "pipe", false, `no plain pipe at ${x},16`)
  for (const [k, n] of pairs(p)) if (n === "pipe") for (let d = 0; d < 4; d++) {
    const [xs, ys] = string.match(k as string, "^(-?%d+),(-?%d+)$")
    const x = tonumber(xs)! + DX[d]
    const y = tonumber(ys)! + DY[d]
    if (y === 16) ok(p[`${x},${y}`] !== "pipe", "nothing plain below the crude manifold")
  }
})

test("water pump: an offshore pump on a shore puts 1200 water/s out of its pipe-out port", () => {
  const def = waterPump(F, {})
  near(rateOf(def.rates.outputs, "water"), 1200, 1e-6, "water")
  eq(def.rates.outputs[0]?.kind, "fluid", "water is a fluid output")
  eq(def.site, "shore")
  const port = def.ports[0]
  ok(port.kind === "pipe-out" && port.item === "water", "a water pipe-out port")
})

test("pumpjack field: a pumpjack on every well, one pipe network to the pipe-out port, every pumpjack powered", () => {
  const wells = [
    { x: 100, y: 200, perSecond: 7.5 },
    { x: 106, y: 201, perSecond: 12 },
    { x: 102, y: 207, perSecond: 4.2 },
    { x: 110, y: 206, perSecond: 9 },
  ]
  const def = pumpjackField(F, { wells })
  near(rateOf(def.rates.outputs, "crude-oil"), 32.7, 1e-6, "crude: the wells' sum")
  eq(def.rates.outputs[0]?.kind, "fluid")
  occupancy(def.entities, F)
  const pc = powerCheck(def.entities, F)
  eq(pc.unpowered.length, 0, pc.unpowered.join(", "))
  eq(pc.networks, 1, "one pole network")
  // Every pumpjack's output tile is a pipe joined to the port through pipes.
  const p = pipes(def)
  const port = def.ports.find((x) => x.kind === "pipe-out")!
  const start = `${math.floor(port.pos.x)},${math.floor(port.pos.y)}`
  const seen: Record<string, boolean> = { [start]: true }
  const queue = [start]
  while (queue.length > 0) {
    const k = queue.shift()!
    const [xs, ys] = string.match(k, "^(-?%d+),(-?%d+)$")
    for (let d = 0; d < 4; d++) {
      const n = `${tonumber(xs)! + DX[d]},${tonumber(ys)! + DY[d]}`
      if (p[n] !== undefined && !seen[n]) {
        seen[n] = true
        queue.push(n)
      }
    }
  }
  for (const e of def.entities) {
    if (e.name !== "pumpjack") continue
    const out = `${math.floor(e.x) + 1},${math.floor(e.y) - 2}`
    ok(seen[out] === true, `pumpjack at ${e.x},${e.y}: its output ${out} reaches the port`)
  }
  ok(port.pos.x === def.footprint.w - 0.5, "the port is on the east edge")
})

test("assembler row, three ingredients: engines (steel, gear, pipe) with pipes on their own belt", () => {
  const def = assemblerRow(F, { recipe: "engine-unit", count: 2, machine: "assembling-machine-2" })
  // Assembler 2 (speed 0.75), 10 s: 0.075 engines/s each.
  near(rateOf(def.rates.outputs, "engine-unit"), 0.15, 1e-6, "two machines")
  near(rateOf(def.rates.inputs, "pipe"), 0.3, 1e-6, "pipe")
  near(rateOf(def.rates.inputs, "steel-plate"), 0.15, 1e-6, "steel")
  occupancy(def.entities, F)
  const ports: Record<string, string> = {}
  for (const p of def.ports) ports[p.id] = `${p.kind}@${p.pos.x},${p.pos.y}`
  // Pipe (2 per craft) is the third ingredient: its own belt-in port from below at the tail.
  eq(ports["in-pipe"], `belt-in@${def.footprint.w - 2 + 0.5},8.5`)
  ok(ports["in-steel-plate"] !== undefined && ports["in-iron-gear-wheel"] !== undefined, "the other two share the lanes")
  eq(def.footprint.h, 9)
  let longs = 0
  for (const e of def.entities) if (e.name === "long-handed-inserter") longs++
  eq(longs, 2, "a long-handed inserter per machine")
})

test("assembler row, three ingredients: advanced circuits and blue packs", () => {
  const ac = assemblerRow(F, { recipe: "advanced-circuit", count: 2, machine: "assembling-machine-2" })
  near(rateOf(ac.rates.outputs, "advanced-circuit"), 0.25, 1e-6, "advanced circuits")
  const blue = assemblerRow(F, { recipe: "chemical-science-pack", count: 4, machine: "assembling-machine-2" })
  // 24 s for 2 packs at 0.75: 0.0625 packs/s per machine.
  near(rateOf(blue.rates.outputs, "chemical-science-pack"), 0.25, 1e-6, "blue packs")
})

test("lab array, three packs: blue on a top belt with regular inserters, every port on the edge", () => {
  const def = labArray(F, { labs: 4, packs: ["automation-science-pack", "logistic-science-pack", "chemical-science-pack"] })
  occupancy(def.entities, F)
  for (const e of def.entities) ok(e.name !== "long-handed-inserter", "no long-handed inserter (nothing past electronics)")
  for (const p of def.ports) {
    if (p.kind !== "belt-in") continue
    const onEdge = p.pos.x < 1 || p.pos.y < 1 || p.pos.x > def.footprint.w - 1 || p.pos.y > def.footprint.h - 1
    ok(onEdge, `port ${p.id} at ${p.pos.x},${p.pos.y} is on the edge of ${def.footprint.w}x${def.footprint.h}`)
  }
  near(rateOf(def.rates.inputs, "chemical-science-pack"), rateOf(def.rates.inputs, "automation-science-pack"), 1e-9, "blue at the red rate")
  const pc = powerCheck(def.entities, F)
  eq(pc.unpowered.length, 0, pc.unpowered.join(", "))
})

run("fluid-chain")
