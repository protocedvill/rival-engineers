import { LuaForce } from "factorio:runtime"
import { at, createLab, Lab } from "./lab"

function getOrCreateForce(name: string): LuaForce {
  return game.forces[name] ?? game.create_force(name)
}

/** A tiny burner line: drills on ore -> belt -> inserters -> furnaces. Used to exercise dump + render. */
function buildDemoLine(lab: Lab, force: LuaForce, dy: number): void {
  const s = lab.surface
  for (let x = -10; x <= -4; x++) for (let y = -2; y <= 1; y++) {
    s.create_entity({ name: "iron-ore", position: at(lab, x + 0.5, dy + y + 0.5), amount: 500 })
  }
  for (const x of [-9, -7, -5]) {
    const drill = s.create_entity({ name: "burner-mining-drill", position: at(lab, x, dy - 1), force, direction: defines.direction.south })!
    drill.insert({ name: "coal", count: 20 })
  }
  for (let x = -10; x <= 8; x++) {
    s.create_entity({ name: "transport-belt", position: at(lab, x + 0.5, dy + 0.5), force, direction: defines.direction.east })
  }
  for (const x of [0, 3, 6]) {
    s.create_entity({ name: "burner-inserter", position: at(lab, x + 0.5, dy + 1.5), force, direction: defines.direction.north })!
      .insert({ name: "coal", count: 5 })
    s.create_entity({ name: "stone-furnace", position: at(lab, x + 1, dy + 3), force })!.insert({ name: "coal", count: 20 })
  }
}

describe("remote interface", () => {
  test("dump_entities writes entities in an area", () => {
    const lab = createLab(8)
    lab.surface.create_entity({ name: "stone-furnace", position: at(lab, 0, 0), force: "player" })
    const count = remote.call("rival-engineers", "dump_entities", "rival-engineers/test-dump.json", lab.origin, 8)
    assert(count === 1, `dumped ${count}`)
  })

  test("demo scene timelapse frames for the renderer", () => {
    const lab = createLab(16)
    buildDemoLine(lab, getOrCreateForce("rival-demo-a"), -6)
    buildDemoLine(lab, getOrCreateForce("rival-demo-b"), 6)
    // Closures in TSTL for-loops share one loop variable, so capture the frame number via a call.
    const dumpFrameAt = (frame: number) =>
      after_ticks(1 + frame * 300, () => {
        const n = remote.call("rival-engineers", "dump_entities", `rival-engineers/demo/frame-${frame}.json`, lab.origin, 16)
        assert((n as number) > 40, `dumped ${n}`)
      })
    for (let frame = 0; frame < 6; frame++) dumpFrameAt(frame)
  })
})
