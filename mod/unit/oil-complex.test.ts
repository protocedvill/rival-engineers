import { assemblerRow, chemRow, oilComplex } from "../src/modules/generators"
import { portOutsideTile, transformModule } from "../src/modules/geometry"
import { powerCheck } from "../src/modules/poles"
import { rateOf } from "../src/modules/rates"
import { ModuleDef } from "../src/modules/types"
import { DX, DY } from "../src/planner/grid"
import { eq, near, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: M7d oil complex (D81). Rates from the recipes with crackers sized to take all the oil; one fluid per pipe network
// (a flood over pipes, pipe-to-ground pairs and machine fluid boxes); every used box on its fluid's network.

/** Fluid in box `box` (1-based) of a recipe side: pinned `box`, else fluid order. */
function fluidInBox(list: { name: string; fluid?: boolean; box?: number }[], box: number): string | undefined {
  let n = 0
  for (const x of list) {
    if (x.fluid !== true) continue
    n++
    if ((x.box ?? n) === box) return x.name
  }
  return undefined
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

interface Net {
  /** Per fluid: the set of component roots its boxes and ports reach. */
  fluids: Record<string, Record<string, boolean>>
  /** Per component root: the fluids on it. */
  mixed: string[]
  unusedTouched: string[]
  unpaired: string[]
}

/** Flood the module's pipe networks (machines face north or south, as the generators place them). */
function networks(def: ModuleDef): Net {
  const kind: Record<string, { name: string; dir: number }> = {}
  for (const e of def.entities) if (e.name === "pipe" || e.name === "pipe-to-ground") kind[key(math.floor(e.x), math.floor(e.y))] = { name: e.name, dir: (e.dir ?? 0) / 4 }
  const parent: Record<string, string> = {}
  const find = (k: string): string => {
    let r = k
    while (parent[r] !== undefined && parent[r] !== r) r = parent[r]
    return r
  }
  const union = (a: string, b: string): void => {
    parent[a] ??= a
    parent[b] ??= b
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  // Which sides a pipe-like tile connects above ground (0 N, 1 E, 2 S, 3 W).
  const sides = (k: string): number[] => {
    const t = kind[k]
    if (t === undefined) return []
    return t.name === "pipe" ? [0, 1, 2, 3] : [t.dir]
  }
  const unpaired: string[] = []
  for (const [k, t] of pairs(kind)) {
    parent[k] ??= k
    const [xs, ys] = string.match(k, "^(-?%d+),(-?%d+)$")
    const x = tonumber(xs)!
    const y = tonumber(ys)!
    for (const d of sides(k)) {
      const n = key(x + DX[d], y + DY[d])
      if (sides(n).indexOf((d + 2) % 4) >= 0) union(k, n)
    }
    if (t.name === "pipe-to-ground") {
      // Underground: away from its connection, the first pipe-to-ground on the axis within 10 tiles must face back.
      const u = (t.dir + 2) % 4
      let paired = false
      for (let i = 1; i <= 10; i++) {
        const n = key(x + DX[u] * i, y + DY[u] * i)
        const o = kind[n]
        if (o === undefined || o.name !== "pipe-to-ground") continue
        if (o.dir === (t.dir + 2) % 4) {
          union(k, n)
          paired = true
        }
        break
      }
      if (!paired) unpaired.push(k)
    }
  }
  const labels: Record<string, Record<string, boolean>> = {}
  const fluids: Record<string, Record<string, boolean>> = {}
  const unusedTouched: string[] = []
  const label = (tile: string, fluid: string | undefined, toward: number): void => {
    // `toward`: the side of the tile facing the machine. The tile connects if it is a pipe or faces it.
    const connects = sides(tile).indexOf(toward) >= 0
    if (fluid === undefined) {
      if (connects) unusedTouched.push(tile)
      return
    }
    if (!connects) {
      ;(fluids[fluid] ??= {})[`missing ${tile}`] = true
      return
    }
    const r = find(tile)
    ;(labels[r] ??= {})[fluid] = true
    ;(fluids[fluid] ??= {})[r] = true
  }
  for (const e of def.entities) {
    const f = F.entity(e.name)
    if (f?.fluidBoxes === undefined || e.recipe === undefined) continue
    const r = F.recipe(e.recipe)!
    const counts: Record<string, number> = { input: 0, output: 0 }
    for (const b of f.fluidBoxes) {
      counts[b.production] = (counts[b.production] ?? 0) + 1
      const c = b.connections[0]
      // Facing north or south (the generators place no other): south turns offsets and directions by 180°.
      const south = (e.dir ?? 0) === 8
      const cx = south ? -c.x : c.x
      const cy = south ? -c.y : c.y
      const d = south ? (c.dir + 2) % 4 : c.dir
      const tile = key(math.floor(e.x) + cx + DX[d], math.floor(e.y) + cy + DY[d])
      const fluid = fluidInBox(b.production === "input" ? r.ingredients : r.products, counts[b.production])
      label(tile, fluid, (d + 2) % 4)
    }
  }
  for (const p of def.ports) {
    if ((p.kind !== "pipe-in" && p.kind !== "pipe-out") || p.item === undefined) continue
    const t = key(math.floor(p.pos.x), math.floor(p.pos.y))
    const r = find(t)
    ;(labels[r] ??= {})[p.item] = true
    ;(fluids[p.item] ??= {})[r] = true
  }
  const mixed: string[] = []
  for (const [r, set] of pairs(labels)) {
    const names: string[] = []
    for (const [n] of pairs(set)) names.push(n as string)
    if (names.length > 1) mixed.push(`${r as string}: ${names.sort().join("+")}`)
  }
  return { fluids, mixed, unusedTouched, unpaired }
}

function components(set: Record<string, boolean> | undefined): string[] {
  const out: string[] = []
  for (const [k] of pairs(set ?? {})) out.push(k as string)
  return out.sort()
}

test("oil complex: 2 refineries with lubricant: rates, crackers for all the oil, one fluid per network", () => {
  const def = oilComplex(F, { refineries: 2, lubePlants: 1 })
  // 2 refineries: 0.4 crafts/s → 10 heavy, 18 light, 22 petroleum per s; 40 crude, 20 water.
  near(rateOf(def.rates.inputs, "crude-oil"), 40, 1e-6, "crude")
  // Lubricant and the heavy cracker share the 10 heavy/s by draw (10/s against 20/s): 3.33 heavy → 3.33 lubricant/s.
  near(rateOf(def.rates.outputs, "lubricant"), 10 / 3, 1e-6, "lubricant")
  // The cracker: 6.67 heavy/s → 5 light/s; light 18 + 5 = 23/s → 15.33 petroleum; 22 + 15.33.
  near(rateOf(def.rates.outputs, "petroleum-gas"), 22 + 46 / 3, 1e-6, "petroleum")
  // Water: 20 (refineries) + 5 (heavy cracking) + 23 (light cracking).
  near(rateOf(def.rates.inputs, "water"), 48, 1e-6, "water")
  ok(rateOf(def.rates.inputs, "electricity") > 0, "electric demand")
  const machines: Record<string, number> = {}
  for (const e of def.entities) if (e.recipe !== undefined) machines[e.recipe] = (machines[e.recipe] ?? 0) + 1
  // All 10 heavy/s may go to cracking (20/s per plant): 1; light then 18 + 7.5 = 25.5/s (15/s per plant): 2.
  eq(machines["heavy-oil-cracking"], 1, "heavy crackers")
  eq(machines["light-oil-cracking"], 2, "light crackers")
  eq(machines["lubricant"], 1, "lubricant plants")
  const kinds = def.ports.map((p) => `${p.kind}:${p.item ?? ""}`).sort().join(" ")
  eq(kinds, "pipe-in:crude-oil pipe-in:water pipe-out:lubricant pipe-out:petroleum-gas power:", "ports")
  const net = networks(def)
  eq(net.unpaired.join(" "), "", "every pipe-to-ground has its partner")
  eq(net.mixed.join("; "), "", "no network carries two fluids")
  eq(net.unusedTouched.join(" "), "", "unused boxes touch nothing")
  for (const fl of ["crude-oil", "water", "heavy-oil", "light-oil", "petroleum-gas", "lubricant"]) {
    const c = components(net.fluids[fl])
    eq(c.length, 1, `${fl}: one network for every box and port (${c.join(" ")})`)
  }
  const power = powerCheck(def.entities, F)
  eq(power.unpowered.join(", "), "", "every machine powered")
  eq(power.networks, 1, "one pole network")
})

test("oil complex: sizes from 1 to 6 refineries stay one fluid per network; no lubricant plants means no lubricant port", () => {
  for (let r = 1; r <= 6; r++) {
    for (const lp of [0, 1, 2]) {
      const def = oilComplex(F, { refineries: r, lubePlants: lp })
      const net = networks(def)
      const tag = `${r} refineries, ${lp} lubricant`
      eq(net.unpaired.join(" "), "", `${tag}: pairs`)
      eq(net.mixed.join("; "), "", `${tag}: one fluid per network`)
      eq(net.unusedTouched.join(" "), "", `${tag}: unused boxes`)
      for (const fl of ["crude-oil", "water", "heavy-oil", "light-oil", "petroleum-gas"]) eq(components(net.fluids[fl]).length, 1, `${tag}: ${fl} connected`)
      eq(def.ports.some((p) => p.item === "lubricant"), lp > 0, `${tag}: lubricant port`)
      const power = powerCheck(def.entities, F)
      eq(power.unpowered.join(", "), "", `${tag}: powered`)
      eq(power.networks, 1, `${tag}: one pole network`)
      // With no lubricant drawn, petroleum is 11/s per refinery plus every cracked drop: 11 + 9 × 2/3 + 5 × 3/4 × 2/3.
      if (lp === 0) near(rateOf(def.rates.outputs, "petroleum-gas"), r * (11 + 6 + 2.5), 1e-6, `${tag}: petroleum`)
    }
  }
})

test("oil complex: the network check catches a cut manifold and a pipe joining two fluids", () => {
  const def = oilComplex(F, { refineries: 2, lubePlants: 1 })
  // Cut: drop the crude manifold's pipe next to its port.
  const crude = def.ports.find((p) => p.item === "crude-oil")!
  const cut = { ...def, entities: def.entities.filter((e) => !(e.name === "pipe" && math.floor(e.x) === math.floor(crude.pos.x) - 1 && math.floor(e.y) === math.floor(crude.pos.y))) }
  ok(cut.entities.length === def.entities.length - 1, "one pipe removed")
  ok(components(networks(cut).fluids["crude-oil"]).length > 1, "a cut crude manifold splits its network")
  // Join: one pipe between the water connector (column 0) and the heavy-oil manifold's start (2, 2).
  ok(!def.entities.some((e) => math.floor(e.x) === 1 && math.floor(e.y) === 2), "the join tile is free")
  const joined = { ...def, entities: [...def.entities, { name: "pipe", x: 1.5, y: 2.5 }] }
  ok(networks(joined).mixed.length > 0, "a pipe joining water and heavy oil is a mixed network")
})

test("chem row: plastic, sulfur, sulfuric acid and batteries fed by pipe, 1–4 plants", () => {
  const cases: [string, string, string][] = [
    // recipe, product port kind, the expected port list
    ["plastic-bar", "belt-out", "belt-in:coal belt-out:plastic-bar pipe-in:petroleum-gas power:"],
    ["sulfur", "belt-out", "belt-out:sulfur pipe-in:petroleum-gas pipe-in:water power:"],
    ["sulfuric-acid", "pipe-out", "belt-in:iron-plate belt-in:sulfur pipe-in:water pipe-out:sulfuric-acid power:"],
    ["battery", "belt-out", "belt-in:copper-plate belt-in:iron-plate belt-out:battery pipe-in:sulfuric-acid power:"],
  ]
  for (const [recipe, outKind, kinds] of cases) {
    let last = 0
    for (let c = 1; c <= 4; c++) {
      const def = chemRow(F, { recipe, chemPlants: c })
      const tag = `${recipe} × ${c}`
      eq(def.ports.map((p) => `${p.kind}:${p.item ?? ""}`).sort().join(" "), kinds, `${tag}: ports`)
      eq(def.ports.find((p) => p.item === recipe)?.kind, outKind, `${tag}: product port`)
      const net = networks(def)
      eq(net.unpaired.join(" "), "", `${tag}: pairs`)
      eq(net.mixed.join("; "), "", `${tag}: one fluid per network`)
      eq(net.unusedTouched.join(" "), "", `${tag}: unused boxes`)
      for (const [fl, set] of pairs(net.fluids)) eq(components(set).length, 1, `${tag}: ${fl as string} connected (${components(set).join(" ")})`)
      const power = powerCheck(def.entities, F)
      eq(power.unpowered.join(", "), "", `${tag}: powered`)
      eq(power.networks, 1, `${tag}: one pole network`)
      const out = rateOf(def.rates.outputs, recipe)
      ok(out > last, `${tag}: output ${out} grows with the plants (was ${last})`)
      last = out
      for (const p of def.ports) if (p.kind === "pipe-in") eq(def.rates.inputs.find((r) => r.item === p.item)?.kind, "fluid", `${tag}: ${p.item} is a fluid input`)
    }
  }
  // Batteries: 4 s per craft, no inserter limit: 0.25/s per plant, 5 acid/s.
  const bat = chemRow(F, { recipe: "battery", chemPlants: 2 })
  near(rateOf(bat.rates.outputs, "battery"), 0.5, 1e-6, "batteries")
  near(rateOf(bat.rates.inputs, "sulfuric-acid"), 10, 1e-6, "acid")
})

test("assembler row with lubricant: electric engines fed by pipe, 2–6 machines and a buffer head", () => {
  for (const count of [2, 4, 6]) {
    for (const buffer of ["", "iron-chest"]) {
      const def = assemblerRow(F, { recipe: "electric-engine-unit", count, buffer })
      const tag = `${count} machines${buffer !== "" ? " buffered" : ""}`
      eq(def.ports.map((p) => `${p.kind}:${p.item ?? ""}`).sort().join(" "), "belt-in:electronic-circuit belt-in:engine-unit belt-out:electric-engine-unit pipe-in:lubricant power:", `${tag}: ports`)
      const net = networks(def)
      eq(net.unpaired.join(" "), "", `${tag}: pairs`)
      eq(net.mixed.join("; "), "", `${tag}: one fluid per network`)
      eq(net.unusedTouched.join(" "), "", `${tag}: unused boxes`)
      eq(components(net.fluids["lubricant"]).length, 1, `${tag}: lubricant connected (${components(net.fluids["lubricant"]).join(" ")})`)
      const power = powerCheck(def.entities, F)
      eq(power.unpowered.join(", "), "", `${tag}: powered`)
      eq(power.networks, 1, `${tag}: one pole network`)
      // Assembling machine 2 (0.75): 0.075 engines/s each, 15 lubricant per engine.
      near(rateOf(def.rates.outputs, "electric-engine-unit"), 0.075 * count, 1e-6, `${tag}: engines`)
      near(rateOf(def.rates.inputs, "lubricant"), 0.075 * count * 15, 1e-6, `${tag}: lubricant`)
      // Every belt-in port's outside tile is outside the footprint.
      for (const p of def.ports) {
        if (p.kind !== "belt-in") continue
        const v = p.dir === 0 ? [0, -1] : p.dir === 4 ? [1, 0] : p.dir === 8 ? [0, 1] : [-1, 0]
        const ox = p.pos.x - v[0]
        const oy = p.pos.y - v[1]
        ok(ox < 0 || oy < 0 || ox > def.footprint.w || oy > def.footprint.h, `${tag}: ${p.id} enters from outside (${ox},${oy})`)
      }
    }
  }
})

test("M7d.5 g198: no pipe port's outside tile touches another fluid's port in any rotation", () => {
  // A plan rotates the complex (r3 here). A pipe stands on the port's outside tile and joins every neighbour, so another
  // fluid's port or outside tile next to it makes the port unreachable (B147: Factorio refuses to mix fluids).
  const def = oilComplex(F, { refineries: 1, lubePlants: 1 })
  const pipePorts = def.ports.filter((p) => (p.kind === "pipe-in" || p.kind === "pipe-out") && p.item !== undefined)
  ok(pipePorts.length >= 4, `${pipePorts.length} pipe ports`)
  for (let rot = 0; rot < 4; rot++) {
    const d = transformModule(def, { rot, mirror: false })
    const ports = d.ports.filter((p) => (p.kind === "pipe-in" || p.kind === "pipe-out") && p.item !== undefined)
    for (const p of ports) {
      const o = portOutsideTile(p)
      const ox = math.floor(o.x)
      const oy = math.floor(o.y)
      for (const q of ports) {
        if (q === p || q.item === p.item) continue
        const qx = math.floor(q.pos.x)
        const qy = math.floor(q.pos.y)
        const qo = portOutsideTile(q)
        const qox = math.floor(qo.x)
        const qoy = math.floor(qo.y)
        const near = (x: number, y: number): boolean => math.abs(x - ox) + math.abs(y - oy) === 1
        ok(!(qx === ox && qy === oy), `rot ${rot}: ${p.item} outside ${ox},${oy} is ${q.item}'s port tile`)
        ok(!(qox === ox && qoy === oy), `rot ${rot}: ${p.item} outside ${ox},${oy} is ${q.item}'s outside tile`)
        ok(!near(qx, qy), `rot ${rot}: ${p.item} outside ${ox},${oy} touches ${q.item}'s port ${qx},${qy}`)
        ok(!near(qox, qoy), `rot ${rot}: ${p.item} outside ${ox},${oy} touches ${q.item}'s outside ${qox},${qoy}`)
      }
    }
  }
})

run("oil-complex")
