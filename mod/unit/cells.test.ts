import { circuitBlock, engineCell, robotCell, smelterMaxFurnaces } from "../src/modules/generators"
import { rateOf } from "../src/modules/rates"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// M7d.5: self-contained production cells. A cell takes only its raw/other inputs through ports; the intermediate
// (copper cable, gears, pipes, robot frames) is made and consumed inside one module, so the design and planner see one
// provider and no intermediate route.

test("advanced-circuit block contains its copper cable", () => {
  const block = circuitBlock(F, { recipe: "advanced-circuit", units: 1 })
  ok(block.recipes.indexOf("copper-cable") >= 0, "the cable recipe runs inside the module")
  ok(block.recipes.indexOf("advanced-circuit") >= 0, "the final recipe runs inside the module")
  eq(rateOf(block.rates.inputs, "copper-cable"), 0, "no cable input port")
  eq(rateOf(block.rates.outputs, "copper-cable"), 0, "no cable output port")
  ok(rateOf(block.rates.inputs, "copper-plate") > 0, "copper plates feed the internal cable machines")
  ok(rateOf(block.rates.inputs, "electronic-circuit") > 0, "electronic circuits are an input")
  ok(rateOf(block.rates.inputs, "plastic-bar") > 0, "plastic is an input")
  ok(rateOf(block.rates.outputs, "advanced-circuit") > 0, "advanced circuits leave the module")
})

test("engine cell contains its gears and pipes", () => {
  const cell = engineCell(F, { count: 2 })
  ok(cell.recipes.indexOf("iron-gear-wheel") >= 0, "gears run inside the module")
  ok(cell.recipes.indexOf("pipe") >= 0, "pipes run inside the module")
  eq(rateOf(cell.rates.inputs, "iron-gear-wheel"), 0, "no gear input port")
  eq(rateOf(cell.rates.inputs, "pipe"), 0, "no pipe input port")
  eq(rateOf(cell.rates.outputs, "iron-gear-wheel"), 0, "no gear output port")
  eq(rateOf(cell.rates.outputs, "pipe"), 0, "no pipe output port")
  ok(rateOf(cell.rates.inputs, "iron-plate") > 0, "iron plates feed gears and pipes")
  ok(rateOf(cell.rates.inputs, "steel-plate") > 0, "steel plates feed engines")
  ok(rateOf(cell.rates.outputs, "engine-unit") > 0, "engines leave the module")
})

test("robot cell contains its flying robot frames", () => {
  const cell = robotCell(F, { count: 2 })
  ok(cell.recipes.indexOf("flying-robot-frame") >= 0, "frames run inside the module")
  eq(rateOf(cell.rates.inputs, "flying-robot-frame"), 0, "no frame input port")
  eq(rateOf(cell.rates.outputs, "flying-robot-frame"), 0, "no frame output port")
  ok(rateOf(cell.rates.inputs, "electric-engine-unit") > 0, "electric engines are an input")
  ok(rateOf(cell.rates.inputs, "battery") > 0, "batteries are an input")
  ok(rateOf(cell.rates.inputs, "steel-plate") > 0, "steel plates are an input")
  ok(rateOf(cell.rates.inputs, "electronic-circuit") > 0, "electronic circuits are an input")
  ok(rateOf(cell.rates.outputs, "construction-robot") > 0, "construction robots leave the module")
})

test("robot cell includes the first roboport and still rates its robots", () => {
  const cell = robotCell(F, { count: 2, buffer: "iron-chest", roboport: "roboport" })
  eq(cell.entities.filter((e) => e.name === "roboport").length, 1, "one roboport")
  eq(cell.entities.filter((e) => e.buffer === true).length, 2, "a buffer chest per robot assembler")
  ok(rateOf(cell.rates.outputs, "construction-robot") > 0, "robots still leave into the buffer chests")
  ok(rateOf(cell.rates.inputs, "electricity") > 0, "the roboport draws power")
})

test("a smelter's maximum is the input lane's ore rate, rounded to furnace units", () => {
  eq(smelterMaxFurnaces(F, "iron-plate", "stone-furnace"), 24, "yellow belt, stone furnace: 24")
  eq(smelterMaxFurnaces(F, "copper-plate", "stone-furnace"), 24, "copper: 24")
  eq(smelterMaxFurnaces(F, "steel-plate", "stone-furnace"), 24, "steel (5 plates per craft): 24")
})

run("cells")
