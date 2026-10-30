import { moduleId } from "../shared/ids"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { tkey } from "../planner/grid"
import { commitModule, commitRoute, LayoutState, newLayout, PlacedModule, Route, RouteStep } from "../planner/layout"
import { stampLayout } from "../planner/runtime"
import { createLab } from "./lab"
import { labForce } from "./module-lab"
import { feed } from "./route-lab"

// B60 provider-group merge through a splitter (T2, engine): a second producer joins the belt of an existing route to
// the same consumer with a splitter that replaces the trunk tile. Pins the two things only the engine can show: the
// trunk belt is really replaced by the splitter, and both feeds then reach the consumer.
//
// The splitter's far output lane is left empty on purpose, so it backs up and every item goes into the trunk.

/** A one-tile module with a belt port: `belt-out` makes iron plates, `belt-in` consumes them. */
function beltBox(id: string, kind: "belt-in" | "belt-out"): ModuleDef {
  // Dir indices are N/E/S/W = 0/1/2/3; a belt entity faces east for `belt-out` and west for `belt-in`.
  const dir = kind === "belt-out" ? 4 : 12
  return {
    id,
    source: "generated",
    footprint: { w: 1, h: 1 },
    entities: [{ name: "transport-belt", x: 0.5, y: 0.5, dir }],
    ports: [{ id: kind === "belt-out" ? "out" : "in", kind, pos: { x: 0.5, y: 0.5 }, dir, item: "iron-plate" }],
    recipes: [],
    machines: [],
    rates: kind === "belt-out" ? { inputs: [], outputs: [{ item: "iron-plate", perSecond: 15 }] } : { inputs: [{ item: "iron-plate", perSecond: 15 }], outputs: [] },
    requiresTech: [],
    rotatable: true,
    mirrorable: true,
  }
}

const EAST = 1
const NORTH = 0

function belts(from: number, to: number, y: number, dir: number): RouteStep[] {
  const out: RouteStep[] = []
  for (let x = from; x <= to; x++) out.push({ kind: "belt", x, y, dir })
  return out
}

function route(id: string, conn: string, fromModule: string, toModule: string, toPort: string, steps: RouteStep[]): Route {
  return {
    id: id as never,
    conn: conn as never,
    item: "iron-plate",
    from: { module: moduleId(fromModule), port: "out" },
    to: { module: moduleId(toModule), port: toPort },
    steps,
    tiles: steps.map((s) => tkey(s.x, s.y)),
    spans: [],
    startDir: steps[0].dir,
    belt: "transport-belt",
    underground: "underground-belt",
    splitter: "splitter",
    length: steps.length,
    undergrounds: 0,
    cost: 1,
    ripped: 0,
  }
}

test("merge splitter: a splitter on the trunk joins a second producer, and both feeds reach the consumer", () => {
  const lab = createLab(40)
  const force = labForce()
  const s = lab.surface
  const ox = math.floor(lab.origin.x)
  const oy = math.floor(lab.origin.y)
  const layout: LayoutState = newLayout()
  const place = (def: ModuleDef, x: number, y: number): PlacedModule => {
    const m: PlacedModule = { id: moduleId(def.id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: 1, h: 1 } }
    commitModule(layout, m, prototypeFacts, 0)
    return m
  }
  place(beltBox("src1", "belt-out"), ox, oy)
  place(beltBox("src2", "belt-out"), ox, oy + 3)
  place(beltBox("dst", "belt-in"), ox + 12, oy)
  // The trunk: src1's outside tile east to the tile before the consumer, all heading east.
  const trunkSteps = belts(ox + 1, ox + 11, oy, EAST)
  const trunk = route("route:trunk", "trunk", "src1", "dst", "in", trunkSteps)
  commitRoute(layout, trunk)
  // The merge: src2 east along row oy+3, one step north, then east into the splitter beside the trunk.
  const sx = ox + 5
  // A splitter spans two ADJACENT tiles across the flow: (sx, oy) on the trunk and (sx, oy + 1) beside it.
  const mergeSteps: RouteStep[] = [...belts(ox + 1, sx - 3, oy + 3, EAST), { kind: "belt", x: sx - 2, y: oy + 3, dir: NORTH }, { kind: "belt", x: sx - 2, y: oy + 2, dir: NORTH }, { kind: "belt", x: sx - 2, y: oy + 1, dir: EAST }, { kind: "belt", x: sx - 1, y: oy + 1, dir: EAST }, { kind: "splitter", x: sx, y: oy, dir: EAST, x2: sx, y2: oy + 1 }]
  const merge = route("route:merge", "merge", "src2", "dst", "in", mergeSteps)
  merge.mergeSplitter = { x: sx, y: oy, dir: EAST, x2: sx, y2: oy + 1 }
  commitRoute(layout, merge)
  const built = stampLayout(s, force.name, layout, false)
  assert(built.failed.length === 0, built.failed.join("; "))
  // The splitter replaced the trunk's belt on that tile.
  const splitter = s.find_entities_filtered({ position: { x: sx + 0.5, y: oy + 1 }, type: "splitter" })[0]
  const leftover = s.find_entities_filtered({ position: { x: sx + 0.5, y: oy + 0.5 }, type: "transport-belt" })[0]
  assert(splitter !== undefined, "the splitter stands on the trunk tile")
  assert(leftover === undefined, "the trunk's belt on that tile was replaced by the splitter")
  // Feed both producers and count what the consumer's belt carries.
  const b1 = s.find_entities_filtered({ position: { x: ox + 1.5, y: oy + 0.5 }, type: "transport-belt" })[0]
  const b2 = s.find_entities_filtered({ position: { x: ox + 1.5, y: oy + 3.5 }, type: "transport-belt" })[0]
  const db = s.find_entities_filtered({ position: { x: ox + 11.5, y: oy + 0.5 }, type: "transport-belt" })[0]
  assert(b1 !== undefined && b2 !== undefined && db !== undefined, "both sources and the consumer belt exist")
  const fs = [
    { item: "iron-plate", lines: [b1.get_transport_line(1), b1.get_transport_line(2)], perTick: 6 / 60, credit: 0, next: 0 },
    { item: "iron-plate", lines: [b2.get_transport_line(1), b2.get_transport_line(2)], perTick: 6 / 60, credit: 0, next: 0 },
  ]
  let n = 0
  let t = 0
  on_tick(() => {
    feed(fs)
    t++
    for (const i of [1, 2]) {
      const line = db.get_transport_line(i)
      if (t > 1800) n += line.get_item_count()
      line.clear()
    }
    if (t < 3600) return
    const rate = (n / 1800) * 60
    log(`[b60-merge] consumer received ${string.format("%.2f", rate)}/s from two 6/s feeds`)
    // Both feeds arrive: one unmerged feed could only deliver about 6/s.
    assert(rate > 8, `merged flow carried ${string.format("%.2f", rate)}/s, expected both feeds`)
    done()
    return false
  })
  async(60 * 60 * 5)
})
