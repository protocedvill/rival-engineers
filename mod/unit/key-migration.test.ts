import { CURRENT_STORAGE_SCHEMA, migrateStorage } from "../src/storage-schema"
import { keyX, keyY, tkey } from "../src/planner/grid"
import { rekeyLayout } from "../src/planner/rekey"
import { eq, ok, run, test } from "./harness"

// B159 follow-up: tile keys are small near the origin (Factorio's Lua 5.2 is ~27x slower on the old ~2e12 keys) and
// negative far out. Storage schema 2 rewrites every persisted key; old captures are rekeyed by the fixture loader.

const OFF = 1048576
const SPAN = 2097152
function oldKey(x: number, y: number): number {
  return (x + OFF) * SPAN + (y + OFF)
}

test("tkey: local keys are small, far keys are negative, and keyX/keyY invert every form", () => {
  const local = tkey(10, -20)
  ok(local >= 0 && local <= 4294967295, `local key small (${local})`)
  eq(keyX(local), 10)
  eq(keyY(local), -20)
  eq(tkey(-32768, -32768), 0, "the local box's low corner")
  eq(tkey(32767, 32767), 4294967295, "the local box's high corner")
  for (const [x, y] of [[-32768, -32768], [32767, 32767], [16384, -7], [-1, 1]]) {
    const k = tkey(x as number, y as number)
    eq(keyX(k), x as number)
    eq(keyY(k), y as number)
  }
  const far = tkey(50000, -40000)
  ok(far < 0, `far key negative (${far})`)
  eq(keyX(far), 50000)
  eq(keyY(far), -40000)
  // Captures and saves before schema 2: the old positive full-map key decodes with the same keyX/keyY.
  const old = oldKey(50000, -40000)
  eq(keyX(old), 50000)
  eq(keyY(old), -40000)
  eq(rekeyLayout === undefined, false, "the layout rekey is exported")
})

test("schema 2 rekeys layouts, routes, mine claims, terrain, claims and planner entries", () => {
  const layout = {
    revision: 3,
    modules: [{ id: "m1", minePlan: { claim: [oldKey(1, 2)], occupied: [oldKey(3, 4)], complete: false } }],
    occ: { [oldKey(10, 20)]: "m:m1" },
    reserved: { [oldKey(11, 21)]: "p:m1.in" },
    routeOcc: { [oldKey(12, 22)]: "route:r" },
    corridor: { [oldKey(13, 23)]: true },
    soft: { [oldKey(14, 24)]: "m:m1" },
    softUnit: { [oldKey(14, 24)]: 2 },
    mine: { [oldKey(15, 25)]: "m1" },
    routes: { "route:r": { tiles: [oldKey(16, 26)], spans: {} } },
    routeOrder: ["route:r"],
  }
  const laneBase = {
    revision: 3,
    modules: [],
    occ: { [oldKey(30, 40)]: "m:m1" },
    reserved: {},
    routeOcc: {},
    corridor: {},
    routes: {},
    routeOrder: [],
  }
  const job = {
    layout,
    laneBase,
    laneKeep: [oldKey(17, 27)],
    newLaneKeep: [oldKey(18, 28)],
    queue: [] as string[],
    current: { conn: "c1" },
    pipe: { conn: "p1" },
    placement: { phase: "scan" },
    wholePatch: { x: 1 },
    poleJob: { id: "poles" },
    phase: "route",
  }
  const terrain = { chunks: { [oldKey(0, 0)]: { block: {} } }, queue: [oldKey(1, 1)], queued: { [oldKey(2, 2)]: true }, resources: [], resourceIndex: {}, id: "t", surface: "nauvis", force: "rival-1", scans: 0 }
  const brain = { reserved: { [oldKey(7, 8)]: true }, reservedBy: { [oldKey(7, 8)]: "site:1" }, oreFields: { [oldKey(9, 9)]: true }, badPatches: { 0: true }, sites: [{ tiles: [oldKey(19, 29)] }] }
  const storage = {
    schemaVersion: 1,
    terrains: { t: terrain },
    factories: { f: { layout, radarChunks: { [oldKey(0, 0)]: true } } },
    factions: { a: { brain } },
    planner: { entries: { p: { job } }, order: ["p"] },
  }
  migrateStorage(storage as never)
  eq(storage.schemaVersion, CURRENT_STORAGE_SCHEMA)
  ok(layout.occ[tkey(10, 20)] === "m:m1", "occ rekeyed")
  ok(layout.reserved[tkey(11, 21)] === "p:m1.in", "reserved rekeyed")
  ok(layout.routeOcc[tkey(12, 22)] === "route:r", "route occupancy rekeyed")
  ok(layout.corridor[tkey(13, 23)] === true, "corridor rekeyed")
  ok(layout.soft[tkey(14, 24)] === "m:m1" && layout.softUnit[tkey(14, 24)] === 2, "soft claim rekeyed")
  ok(layout.mine[tkey(15, 25)] === "m1", "mine claim rekeyed")
  ok(layout.routes["route:r"].tiles[0] === tkey(16, 26), "route tiles rekeyed")
  ok(layout.modules[0].minePlan.claim[0] === tkey(1, 2) && layout.modules[0].minePlan.occupied[0] === tkey(3, 4), "mine plan rekeyed")
  ok(laneBase.occ[tkey(30, 40)] === "m:m1", "lane base rekeyed")
  ok(terrain.chunks[tkey(0, 0)] !== undefined && terrain.queue[0] === tkey(1, 1) && terrain.queued[tkey(2, 2)] === true, "terrain keys rekeyed")
  ok(brain.reserved[tkey(7, 8)] === true && brain.reservedBy[tkey(7, 8)] === "site:1" && brain.oreFields[tkey(9, 9)] === true, "world claims rekeyed")
  ok(brain.badPatches[0] === true, "patch ids untouched")
  ok(brain.sites[0].tiles[0] === tkey(19, 29), "site tiles rekeyed")
  ok((storage.factories.f as { radarChunks?: Record<number, boolean> }).radarChunks?.[tkey(0, 0)] === true, "radar chunks rekeyed")
  ok(job.laneKeep[0] === tkey(17, 27) && job.newLaneKeep[0] === tkey(18, 28), "lane keeps rekeyed")
  ok(job.current === undefined && job.pipe === undefined && job.placement === undefined && job.wholePatch === undefined && job.poleJob === undefined, "transient search state dropped")
  eq(job.queue.join(","), "p1,c1", "both transient connections are queued again")
  // Idempotent: a second pass (or a fixture already new) leaves the keys unchanged.
  rekeyLayout(layout as never)
  ok(layout.occ[tkey(10, 20)] === "m:m1" && layout.routes["route:r"].tiles[0] === tkey(16, 26), "rekeying is idempotent")
})

run("key-migration")
