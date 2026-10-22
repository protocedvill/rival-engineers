import { IDENTITY } from "../src/modules/geometry"
import { connectionId, moduleId, poleId, poleLineId, routeId, worldClaimTag as asWorldClaimTag } from "../src/shared/ids"
import { ModuleDef } from "../src/modules/types"
import { tkey } from "../src/planner/grid"
import { commitModule, commitRoute, newLayout, PlacedModule, Route } from "../src/planner/layout"
import { checkWorldClaimOwners, ClaimSite, releaseWorldTile, reserveWorldTile, syncWorldClaims, WorldClaimTable, worldClaimTag } from "../src/world/claim-index"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

function box(id: string): ModuleDef {
  return {
    id,
    source: "generated",
    footprint: { w: 1, h: 1 },
    entities: [],
    ports: [],
    recipes: [],
    machines: [],
    rates: { inputs: [], outputs: [] },
    requiresTech: [],
    rotatable: true,
    mirrorable: true,
  }
}

function module(state: ReturnType<typeof newLayout>, id: string, x: number, y: number): PlacedModule {
  const def = box(id)
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: IDENTITY, origin: { x, y }, rect: { x, y, w: 1, h: 1 } }
  commitModule(state, m, F, 0)
  return m
}

function route(id: string, tiles: number[]): Route {
  return { id: routeId(id), conn: connectionId(id), item: "iron-plate", to: { module: "m1", port: "in" }, steps: [], tiles, spans: [], belt: "transport-belt", underground: "underground-belt", splitter: "splitter", length: tiles.length, undergrounds: 0, cost: 0, ripped: 0 }
}

test("a world reservation and its owner are added and removed together", () => {
  const table: WorldClaimTable = { reserved: {} }
  const k = tkey(3, 4)
  reserveWorldTile(table, k, "site:7")
  eq(table.reserved[k], true)
  eq(table.reservedBy?.[k], "site:7")
  eq(worldClaimTag(table, k), "site:7")
  ok(releaseWorldTile(table, k), "the reservation was held")
  eq(table.reserved[k], undefined)
  eq(table.reservedBy?.[k], undefined)
  ok(!releaseWorldTile(table, k), "releasing twice does nothing")
})

test("sync tags site and factory ground and drops stale reservations", () => {
  const layout = newLayout()
  module(layout, "m1", 2, 2)
  commitRoute(layout, route("r1", [tkey(5, 5)]))
  layout.poles = [{ id: poleId("p1"), name: "small-electric-pole", x: 8, y: 2, line: poleLineId("poles:g1:0") }]
  layout.mine = { [tkey(7, 2)]: moduleId("m1") }
  const table: WorldClaimTable = { reserved: {}, reservedBy: {} }
  // A stale reservation with its owner, and a direct delete that left an owner behind.
  reserveWorldTile(table, tkey(40, 40), "site:9")
  table.reservedBy![tkey(41, 41)] = asWorldClaimTag("site:9")
  const sites: ClaimSite[] = [
    { id: 3, status: "built", tiles: [tkey(-5, -5)] },
    { id: 4, status: "retired", tiles: [tkey(-6, -6)] },
  ]
  eq(syncWorldClaims(table, sites, layout), 1, "the stale reservation is dropped")
  eq(worldClaimTag(table, tkey(2, 2)), "module:m1")
  eq(worldClaimTag(table, tkey(5, 5)), "route:r1")
  eq(worldClaimTag(table, tkey(8, 2)), "pole:p1")
  eq(worldClaimTag(table, tkey(7, 2)), "mine:m1")
  eq(worldClaimTag(table, tkey(-5, -5)), "site:3")
  eq(table.reserved[tkey(-6, -6)], undefined, "a retired site gives its ground up")
  eq(table.reserved[tkey(40, 40)], undefined)
  eq(table.reservedBy![tkey(41, 41)], undefined, "an orphaned owner is cleared")
  ok(table.reservedBy![tkey(2, 2)] === "module:m1", "the footprint carries its owner")
})

test("owner checks report orphans, one-sided entries and malformed tags", () => {
  const table: WorldClaimTable = { reserved: {}, reservedBy: {} }
  reserveWorldTile(table, tkey(1, 1), "module:gone")
  reserveWorldTile(table, tkey(2, 1), "site:2")
  reserveWorldTile(table, tkey(3, 1), "bogus:1")
  table.reservedBy![tkey(4, 1)] = asWorldClaimTag("site:3") // no reservation
  table.reserved[tkey(5, 1)] = true // legacy, no owner
  const problems = checkWorldClaimOwners(table, { "site:2": true })
  ok(problems.some((p) => p.indexOf("names absent module:gone") >= 0), problems.join("; "))
  ok(problems.some((p) => p.indexOf("unknown owner tag bogus:1") >= 0), problems.join("; "))
  ok(problems.some((p) => p.indexOf("has no reservation") >= 0), problems.join("; "))
  ok(!problems.some((p) => p.indexOf("site:2") >= 0), "a live owner is fine")
  ok(!problems.some((p) => p.indexOf("5,1") >= 0), "untagged legacy tiles are compatible")
})

run("world-claim-index")
