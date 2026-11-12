import { cellHasRoom, cellKey, cellPoint, cellRole, nextCell, parseCellRole } from "../src/strategy/robot-grid"
import { eq, ok, run, test } from "./harness"

const O = { x: 10, y: 20 }
const base = (rects: [number, number, number, number][]) => rects.map(([x, y, w, h]) => ({ x, y, w, h }))

test("M7d.5: roboport roles round-trip, negative cells too", () => {
  eq(cellRole({ i: -2, j: 3 }), "roboport:-2,3")
  const c = parseCellRole("roboport:-2,3")!
  eq(cellKey(c), "-2,3")
  eq(parseCellRole("radar"), undefined, "another role")
  eq(parseCellRole("roboport:x"), undefined, "malformed")
  const p = cellPoint(O, 36, { i: -1, j: 2 })
  eq(`${p.x},${p.y}`, "-26,92")
})

test("M7d.5: the hub first, then the neighbour cell covering the most uncovered base", () => {
  const modules = base([[0, 0, 20, 20], [100, 10, 30, 30], [10, 120, 10, 10]])
  const input = { modules, cells: [], failed: {}, origin: O, spacing: 36, constructionRadius: 55, max: 10 }
  eq(cellKey(nextCell(input)!), "0,0", "the hub")
  // The hub (10, 20) covers x -45..65, y -35..75: the module at (115, 25) and the one at (15, 125) are open.
  // Cell 1,0 (46, 20) reaches x to 101: not 115; cell 0,1 (10, 56) reaches y to 111: not 125. Nothing next to the hub
  // reaches either, so the network is done although the base is not covered (it only grows by touching cells).
  eq(nextCell({ ...input, cells: [{ i: 0, j: 0 }] }), undefined, "no neighbour reaches the open modules")
  const near = base([[0, 0, 20, 20], [80, 10, 30, 30], [10, 100, 10, 10]])
  // Now cell 1,0 reaches the 900-tile module (centre x 95), cell 0,1 the 100-tile one (centre y 105): the bigger wins.
  eq(cellKey(nextCell({ ...input, modules: near, cells: [{ i: 0, j: 0 }] })!), "1,0", "most uncovered area")
  eq(cellKey(nextCell({ ...input, modules: near, cells: [{ i: 0, j: 0 }], failed: { "1,0": true } })!), "0,1", "a failed cell is skipped")
  eq(nextCell({ ...input, modules: near, cells: [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }] }), undefined, "covered")
  eq(nextCell({ ...input, modules: near, cells: [{ i: 0, j: 0 }], max: 1 }), undefined, "network full")
  eq(nextCell({ ...input, failed: { "0,0": true } }), undefined, "the hub failed")
})

test("M7d.5: equal coverage goes to the cell nearest the hub, then the lowest i, then the lowest j", () => {
  // Two equal modules west and east of the hub, just outside its area.
  const modules = base([[-60, 15, 10, 10], [70, 15, 10, 10]])
  const input = { modules, cells: [{ i: 0, j: 0 }], failed: {}, origin: O, spacing: 36, constructionRadius: 55, max: 10 }
  eq(cellKey(nextCell(input)!), "-1,0", "lowest i")
  ok(nextCell({ ...input, cells: [{ i: 0, j: 0 }, { i: -1, j: 0 }] }) !== undefined, "the east one next")
  eq(cellKey(nextCell({ ...input, cells: [{ i: 0, j: 0 }, { i: -1, j: 0 }] })!), "1,0")
})

test("B192: a cell whose window has no room for the roboport among the modules is skipped", () => {
  const room = { w: 5, h: 4, window: 8 }
  // Window around (46, 20): x 38..54, y 12..28. A module covering it (and the hub's coverage, so it is not "open").
  const blocker: [number, number, number, number] = [36, 10, 20, 20]
  eq(cellHasRoom({ x: 46, y: 20 }, room, base([blocker])), false, "covered window")
  eq(cellHasRoom({ x: 46, y: 20 }, room, base([[36, 10, 20, 13]])), true, "rows 24..28 are clear past the margin row 23: 4 rows fit")
  eq(cellHasRoom({ x: 46, y: 20 }, room, base([[36, 10, 20, 14]])), false, "3 clear rows: neither rotation fits")
  eq(cellHasRoom({ x: 46, y: 20 }, room, []), true, "empty")
  const near = base([[0, 0, 20, 20], [80, 10, 30, 30], [10, 100, 10, 10], blocker])
  const input = { modules: near, cells: [{ i: 0, j: 0 }], failed: {}, origin: O, spacing: 36, constructionRadius: 55, max: 10 }
  eq(cellKey(nextCell(input)!), "1,0", "without the check: the blocked cell")
  eq(cellKey(nextCell({ ...input, room })!), "0,1", "with it: the next best cell")
})

run("robot-grid")
