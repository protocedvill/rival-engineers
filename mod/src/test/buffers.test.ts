import { LuaEntity } from "factorio:runtime"
import { clearConfigOverrides, setConfigOverride } from "../config"
import { bufferSources, registerBuffer } from "../modules/buffers"
import { generatedModule } from "../modules/library"
import { stampModule } from "../modules/stamp"
import { at, createLab } from "./lab"

// D42 / B5: module buffer depots. A buffer chest's ghost is registered; when the crew builds it (revive, as the
// controller does) its usable slots are limited to `module-buffer-slots`, so it fills up and stops; the crew collects
// from it (bufferSources). Validation stamps (D33) bar every slot.

describe("D42 buffer depots", () => {
  after_each(() => clearConfigOverrides())

  test("a revived buffer ghost is limited to module-buffer-slots and listed as a collect source", () => {
    setConfigOverride("moduleBufferSlots", 2)
    const lab = createLab(8)
    const ghost = lab.surface.create_entity({ name: "entity-ghost", inner_name: "iron-chest", position: at(lab, 0.5, 0.5), force: "player" })!
    registerBuffer(lab.surface, "player", ghost)
    const [, revived] = ghost.revive({ raise_revive: true })
    const chest = revived as LuaEntity
    assert(chest !== undefined && chest.valid, "revived")
    const inv = chest.get_inventory(defines.inventory.chest)!
    assert(inv.get_bar() === 3, `bar ${inv.get_bar()} (2 usable slots)`)
    const inserted = chest.insert({ name: "iron-plate", count: 500 })
    assert(inserted === 200, `holds 2 stacks, took ${inserted}`)
    const src = bufferSources("player", "iron-plate").filter((s) => s.entity === chest)
    assert(src.length === 1 && src[0].amount === 200, "a collect source with 200 plates")
    assert(bufferSources("player", "copper-plate").filter((s) => s.entity === chest).length === 0, "nothing else")
    // A chest that is not a registered buffer keeps its slots.
    const other = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 3.5, 0.5), force: "player", raise_built: true })!
    assert(other.get_inventory(defines.inventory.chest)!.get_bar() === other.get_inventory(defines.inventory.chest)!.length + 1, "unrelated chest untouched")
  })

  test("validation stamps (D33) bar every slot of a module's buffer chest", () => {
    const lab = createLab(16)
    const def = generatedModule("smelter-column", { recipe: "iron-plate", furnaces: 4, buffer: "iron-chest" })
    const placed = stampModule(lab.surface, "player", def, at(lab, -6, -6))
    let found = 0
    for (let i = 0; i < def.entities.length; i++) {
      if (!def.entities[i].buffer) continue
      found++
      const inv = placed[i]!.get_inventory(defines.inventory.chest)!
      assert(inv.get_bar() === 1, "every slot barred")
      assert(placed[i]!.insert({ name: "iron-plate", count: 10 }) === 0, "takes nothing")
    }
    assert(found === 1, "one buffer chest")
  })

  test("a limited buffer fills up and stops: the inserter feeding it idles once its slots are full", () => {
    setConfigOverride("moduleBufferSlots", 1)
    const lab = createLab(8)
    const src = lab.surface.create_entity({ name: "iron-chest", position: at(lab, 0.5, 0.5), force: "player" })!
    src.insert({ name: "iron-plate", count: 400 })
    // A burner inserter (no power needed here) facing west: it picks from the source west of it.
    const ins = lab.surface.create_entity({ name: "burner-inserter", position: at(lab, 1.5, 0.5), direction: defines.direction.west, force: "player" })!
    ins.insert({ name: "coal", count: 5 })
    const ghost = lab.surface.create_entity({ name: "entity-ghost", inner_name: "iron-chest", position: at(lab, 2.5, 0.5), force: "player" })!
    registerBuffer(lab.surface, "player", ghost)
    const [, revived] = ghost.revive({ raise_revive: true })
    const chest = revived as LuaEntity
    // Most of the stack is there already (the test runs under factorio-test's 3600-tick limit).
    chest.insert({ name: "iron-plate", count: 90 })
    after_ticks(3000, () => {
      const n = chest.get_item_count("iron-plate")
      assert(n === 100, `the buffer holds one stack (${n})`)
      assert(src.get_item_count("iron-plate") >= 389, `the rest stays upstream (${src.get_item_count("iron-plate")})`)
    })
  })

  // D51 / B14: gear rows and circuit blocks carry a buffer at their head; it takes products off the output belt.
  for (const [name, gen, params, feed, item] of [
    ["gear row", "assembler-row", { recipe: "iron-gear-wheel", count: 2, buffer: "iron-chest" }, { "iron-plate": 100 }, "iron-gear-wheel"],
    ["circuit block", "circuit-block", { units: 1, buffer: "iron-chest" }, { "iron-plate": 50, "copper-plate": 50 }, "electronic-circuit"],
  ] as [string, string, Record<string, unknown>, Record<string, number>, string][]) {
    test(`B14: a ${name}'s buffer head collects its product from the output belt`, () => {
      const lab = createLab(30)
      const def = generatedModule(gen as never, params)
      for (const r of ["iron-gear-wheel", "copper-cable", "electronic-circuit"]) game.forces.player.recipes[r].enabled = true
      const origin = at(lab, -10, -4)
      const made = stampModule(lab.surface, "player", def, origin, { bufferSlots: 2 })
      let chest: LuaEntity | undefined
      for (let i = 0; i < def.entities.length; i++) {
        const e = made[i]
        if (e === undefined) continue
        if (def.entities[i].buffer) chest = e
        if (e.type === "assembling-machine") {
          const r = e.get_recipe()[0]
          // Feed the machines that take plates (cable assemblers take copper; circuit ones get cable by insertion).
          if (r !== undefined) for (const ing of r.ingredients) if (feed[ing.name] !== undefined) e.get_inventory(defines.inventory.assembling_machine_input)!.insert({ name: ing.name, count: feed[ing.name] })
        }
      }
      assert(chest !== undefined, "a buffer chest")
      // Power: an energy interface on a pole next to the module's power port.
      const pp = def.ports.filter((p) => p.kind === "power")[0].pos
      lab.surface.create_entity({ name: "small-electric-pole", position: { x: origin.x + pp.x - 2, y: origin.y + pp.y }, force: "player" })
      const eei = lab.surface.create_entity({ name: "electric-energy-interface", position: { x: origin.x + pp.x - 3.5, y: origin.y + pp.y + 0.5 }, force: "player" })!
      eei.power_production = 1e7
      eei.electric_buffer_size = 1e7
      after_ticks(2400, () => {
        const n = chest!.get_item_count(item)
        const states: string[] = []
        for (const e of made) if (e !== undefined && e.valid && e.type === "assembling-machine") {
          let st = tostring(e.status)
          for (const [k, v] of pairs(defines.entity_status)) if (v === e.status) st = k as string
          states.push(`${e.get_recipe()[0]?.name}:${st}:${e.products_finished}:${e.energy}`)
        }
        log(`[m6] B14 ${name}: ${n} ${item} in the buffer after 40 s`)
        assert(n > 0, `the buffer got ${item} (${n}); machines ${states.join(" ")}`)
      })
    })
  }
})
