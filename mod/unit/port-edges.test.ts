import { assemblerRow, circuitBlock, fluidChain, labArray, miningOutpost, pumpjackField, redLine, robotCell, smelterColumn, steamBlock, waterPump } from "../src/modules/generators"
import { portOutsideTile } from "../src/modules/geometry"
import { ModuleDef } from "../src/modules/types"
import { ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: every belt and pipe port of every generator sits on its module's footprint and its outside tile (where a route
// starts or arrives) lies outside it. A port whose outside tile is inside the module can never be routed to (the first
// M7 soak: the three-ingredient row's lane input moved inside when the row grew a ninth row; engines "no path").

const RED = "automation-science-pack"
const GREEN = "logistic-science-pack"
const BLUE = "chemical-science-pack"

const samples: [string, ModuleDef][] = [
  ["smelter", smelterColumn(F, { recipe: "iron-plate", furnaces: 4 })],
  ["mine", miningOutpost(F, { resource: "iron-ore", rows: 2, sides: 2 })],
  ["steam", steamBlock(F, { boilers: 1 })],
  ["row 1", assemblerRow(F, { recipe: "iron-gear-wheel", count: 2 })],
  ["row 2", assemblerRow(F, { recipe: "transport-belt", count: 2 })],
  ["row 3 engines", assemblerRow(F, { recipe: "engine-unit", count: 2, machine: "assembling-machine-2" })],
  ["row 3 advanced circuits", assemblerRow(F, { recipe: "advanced-circuit", count: 4, machine: "assembling-machine-2" })],
  ["red line", redLine(F, { units: 1 })],
  ["circuit block", circuitBlock(F, { units: 1 })],
  ["labs 2", labArray(F, { labs: 4, packs: [RED, GREEN] })],
  ["labs 3", labArray(F, { labs: 4, packs: [RED, GREEN, BLUE] })],
  ["plastic", fluidChain(F, { recipe: "plastic-bar", chemPlants: 2, refineries: 2 })],
  ["sulfur", fluidChain(F, { recipe: "sulfur", chemPlants: 1, refineries: 1 })],
  ["water", waterPump(F, {})],
  ["field", pumpjackField(F, { wells: [{ x: 0, y: 0, perSecond: 10 }, { x: 6, y: 1, perSecond: 10 }] })],
  ["robot cell", robotCell(F, { count: 2, buffer: "iron-chest", roboport: "roboport" })],
]

test("every belt and pipe port is on the footprint with its outside tile outside", () => {
  for (const [name, def] of samples) {
    const { w, h } = def.footprint
    for (const p of def.ports) {
      if (p.kind !== "belt-in" && p.kind !== "belt-out" && p.kind !== "pipe-in" && p.kind !== "pipe-out") continue
      const x = math.floor(p.pos.x)
      const y = math.floor(p.pos.y)
      ok(x >= 0 && y >= 0 && x < w && y < h, `${name} ${p.id}: port tile ${x},${y} inside ${w}x${h}`)
      const o = portOutsideTile(p)
      const ox = math.floor(o.x)
      const oy = math.floor(o.y)
      ok(ox < 0 || oy < 0 || ox >= w || oy >= h, `${name} ${p.id}: outside tile ${ox},${oy} is inside ${w}x${h}`)
    }
  }
})

run("port-edges")
