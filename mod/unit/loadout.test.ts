import { carryAllowance, nextEquip, parseLoadout, LoadoutFacts, Worn } from "../src/strategy/loadout"
import { eq, run, test } from "./harness"

// T1: M7d (D82 b, proposed): the crew's armour and equipment, item by item.

const CELLS: Record<string, number> = { "exoskeleton-equipment": 8, "personal-roboport-equipment": 4, "battery-equipment": 2, "solar-panel-equipment": 1 }
function facts(enabled: string[]): LoadoutFacts {
  return {
    enabled: (item) => enabled.indexOf(item) >= 0,
    kind: (item) => (item === "modular-armor" || item === "heavy-armor" ? "armor" : CELLS[item] !== undefined ? "equipment" : undefined),
    cells: (item) => CELLS[item] ?? 99,
  }
}
const LOADOUT = parseLoadout("modular-armor, exoskeleton-equipment,personal-roboport-equipment,battery-equipment,solar-panel-equipment*")

test("D82 b: the loadout setting parses items in order, * marks the filler", () => {
  eq(LOADOUT.map((e) => `${e.item}${e.fill ? "*" : ""}`).join(","), "modular-armor,exoskeleton-equipment,personal-roboport-equipment,battery-equipment,solar-panel-equipment*", "parsed")
  eq(parseLoadout("").length, 0, "empty: no loadout")
})

test("D82 b: armour first, then the big pieces, then panels fill the grid; nothing before it is researched", () => {
  const all = facts(["modular-armor", "exoskeleton-equipment", "personal-roboport-equipment", "battery-equipment", "solar-panel-equipment"])
  eq(nextEquip(LOADOUT, { grid: {}, freeCells: 0 }, facts([])) ?? "none", "none", "nothing enabled: nothing to wear")
  eq(nextEquip(LOADOUT, { grid: {}, freeCells: 0 }, all) ?? "none", "modular-armor", "armour first")
  eq(nextEquip(LOADOUT, { armor: "heavy-armor", grid: {}, freeCells: 0 }, all) ?? "none", "modular-armor", "a different armour is replaced")
  const w: Worn = { armor: "modular-armor", grid: {}, freeCells: 25 }
  const order: string[] = []
  for (let i = 0; i < 30; i++) {
    const item = nextEquip(LOADOUT, w, all)
    if (item === undefined) break
    order.push(item)
    w.grid[item] = (w.grid[item] ?? 0) + 1
    w.freeCells -= CELLS[item]
  }
  eq(order.slice(0, 3).join(","), "exoskeleton-equipment,personal-roboport-equipment,battery-equipment", "big pieces first")
  eq(order.filter((i) => i === "solar-panel-equipment").length, 11, "panels fill the 11 cells left")
  eq(w.freeCells, 0, "the grid is full")
})

test("D82 b: panels researched first leave room for the exoskeleton and roboport researched later", () => {
  const early = facts(["modular-armor", "battery-equipment", "solar-panel-equipment"])
  const w: Worn = { armor: "modular-armor", grid: {}, freeCells: 25 }
  for (let i = 0; i < 30; i++) {
    const item = nextEquip(LOADOUT, w, early)
    if (item === undefined) break
    w.grid[item] = (w.grid[item] ?? 0) + 1
    w.freeCells -= CELLS[item]
  }
  eq(w.grid["solar-panel-equipment"], 11, "panels fill only past the room the exoskeleton and roboport will need")
  eq(w.freeCells, 12, "8 + 4 cells kept")
  eq(nextEquip(LOADOUT, w, facts(["modular-armor", "exoskeleton-equipment", "battery-equipment", "solar-panel-equipment"])) ?? "none", "exoskeleton-equipment", "the exoskeleton fits once researched")
})

test("D82 b: robots are carried once the personal roboport is worn, and kept from deposits", () => {
  const lo = parseLoadout("modular-armor,exoskeleton-equipment,personal-roboport-equipment,construction-robot=10,battery-equipment,solar-panel-equipment*")
  eq(lo[3].item, "construction-robot", "carry entry")
  eq(lo[3].carry, 10, "carries 10")
  eq(lo[3].after, "personal-roboport-equipment", "after the roboport")
  const all = facts(["modular-armor", "exoskeleton-equipment", "personal-roboport-equipment", "construction-robot", "battery-equipment", "solar-panel-equipment"])
  const w: Worn = { armor: "modular-armor", grid: { "exoskeleton-equipment": 1 }, freeCells: 17, carried: { "construction-robot": 0 } }
  eq(nextEquip(lo, w, all) ?? "none", "personal-roboport-equipment", "no robots before the roboport")
  eq(carryAllowance(lo, w)["construction-robot"] ?? 0, 0, "and none kept")
  w.grid["personal-roboport-equipment"] = 1
  w.freeCells = 13
  eq(nextEquip(lo, w, all) ?? "none", "construction-robot", "robots next")
  eq(carryAllowance(lo, w)["construction-robot"], 10, "10 kept from deposits")
  w.carried!["construction-robot"] = 10
  eq(nextEquip(lo, w, all) ?? "none", "battery-equipment", "then the battery")
  eq(lo.filter((e) => e.carry !== undefined).length, 1, "one carry entry")
})

run("loadout")
