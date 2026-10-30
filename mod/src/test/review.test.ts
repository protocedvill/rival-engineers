import { LuaRenderObject, PlayerIndex, Tags } from "factorio:runtime"
import { miningOutpost, smelterColumn } from "../modules/generators"
import { moduleId } from "../shared/ids"
import { prototypeFacts } from "../modules/prototype-facts"
import { FREE, TerrainView } from "../planner/grid"
import { commitModule, newLayout, PlacedModule } from "../planner/layout"
import { prepareWholePatchPlacement } from "../planner/placement"
import { selectPolicy } from "../planner/policy"
import { drawGrowthLayout } from "../review/growth-overlay"
import { enqueue, getAction } from "../character/controller"
import { clearConfigOverrides, getConfig } from "../config"
import { addJob } from "../jobs/board"
import { createFaction, destroyFaction } from "../jobs/faction"
import { FactionState } from "../jobs/types"
import { onInspectorClick, playerState, refreshInspector, setInspectorOpen } from "../review/inspector"
import { crewView, factionView } from "../review/model"
import { crewTime } from "../review/time"
import { TIME_CATEGORIES } from "../review/types"
import { at, createLab } from "./lab"

// Live review tools: per-crew time accounting (every observed tick lands in exactly one category), the data
// model behind the inspector, and the inspector window itself when the test run has a player.

function checkSums(id: number): void {
  const t = crewTime(id)!
  assert(t, `crew ${id} has time accounting`)
  for (const b of [t.total, t.recent]) {
    let sum = 0
    for (const c of TIME_CATEGORIES) sum += b.byCategory[c]
    assert(sum === b.ticks, `categories sum ${sum} = ticks ${b.ticks}`)
  }
  assert(storage.review!.time[id].ticks === t.total.ticks, "stored tick count matches")
  // Observed on every tick since it was first seen (±1: test handlers may run before or after the mod's tick).
  const elapsed = game.tick - t.start + 1
  assert(math.abs(t.total.ticks - elapsed) <= 1, `observed ${t.total.ticks} of ${elapsed} elapsed ticks`)
  assert(t.recent.ticks <= t.total.ticks, "recent window within total")
}

describe("review tools", () => {
  // Leftover factions keep planning (and slow every later test in the shard).
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
    const config = getConfig()
    assert(!config.debugTeleportWhenStuck && !config.debugInstantCraft && config.debugReachMultiplier === 1, "debug parity toggles must be off")
  })

  test("time accounting: a walking crew member accrues walking time and categories sum to elapsed ticks", () => {
    const lab = createLab(48)
    const faction = createFaction("rv-walk", { position: at(lab, -36, 0), crew: 1 })
    const member = storage.crew[faction.crew[0]]
    const actionId = enqueue(member.controller, { kind: "walk", goal: at(lab, 36, 0) })
    async(1800)
    on_tick(() => {
      const action = getAction(actionId)!
      if (action.status === "queued" || action.status === "running") return
      assert(action.status === "succeeded", `walk ${action.status} ${action.reason ?? ""}`)
      checkSums(member.id)
      const t = crewTime(member.id)!
      const walking = t.total.byCategory.walking
      // ~70 tiles at ~8.9 tiles/s is ~480 ticks of walking; the rest is the path request and idle ticks.
      assert(walking >= 300, `walking ${walking} ticks`)
      assert(walking / t.total.ticks > 0.6, `walking share ${walking}/${t.total.ticks}`)
      assert(t.total.byCategory.mining === 0 && t.total.byCategory.placing === 0, "no work accrued")
      const view = crewView(member.id, game.tick)!
      assert(view.total !== undefined && view.total.byCategory.walking === walking, "crew view carries the breakdown")
      done()
    })
  })

  test("time accounting: idle without ready jobs, waiting when ready jobs lack materials", () => {
    const lab = createLab(16)
    const faction: FactionState = createFaction("rv-wait", { position: at(lab, 0, 0), crew: 1 })
    const id = faction.crew[0]
    let phase = 0
    let jobAt = 0
    async(200)
    on_tick(() => {
      const t = crewTime(id)
      if (t === undefined) return
      if (phase === 0 && t.total.ticks >= 30) {
        assert(t.total.byCategory.idle >= 29, `idle ${t.total.byCategory.idle} of ${t.total.ticks}`)
        // A ready craft job whose materials nobody has: the member can't claim it.
        addJob(faction.board, { kind: "craft", pos: at(lab, 0, 0), materials: [{ item: "iron-plate", count: 999 }], payload: { kind: "craft", recipe: "iron-gear-wheel", count: 1 } }, game.tick)
        jobAt = game.tick
        phase = 1
      } else if (phase === 1 && game.tick - jobAt >= 30) {
        assert(t.total.byCategory.waiting >= 28, `waiting ${t.total.byCategory.waiting}`)
        assert(t.current === "waiting", `now ${t.current}`)
        checkSums(id)
        const v = factionView(faction.name, game.tick)!
        assert(v.jobs.ready === 1 && v.jobs.claimed === 0, `jobs ${v.jobs.ready} ready, ${v.jobs.claimed} claimed`)
        assert(v.oldest !== undefined && v.oldest.kind === "craft" && v.oldest.state === "ready", "oldest waiting job is the craft")
        assert(v.alive === 1 && v.crew.length === 1, "crew counted")
        done()
      }
    })
  })

  test("inspector opens, refreshes, handles clicks and closes", () => {
    const lab = createLab(16)
    createFaction("rv-gui-a", { position: at(lab, -4, 0), crew: 2 })
    createFaction("rv-gui-b", { position: at(lab, 4, 0), crew: 1 })
    after_ticks(5, () => {
      const player = game.get_player(1 as PlayerIndex)
      if (player === undefined || !player.valid) {
        // Headless runs without a player: the data model (tested above and here) is what the GUI renders.
        for (const name of storage.factionOrder) assert(factionView(name, game.tick) !== undefined, `view of ${name}`)
        log("[review] no player in this test run: GUI not exercised")
        return
      }
      setInspectorOpen(player, true)
      const frame = player.gui.screen.re_inspector
      assert(frame !== undefined && frame.valid, "inspector window open")
      const state = playerState(player.index)
      for (const tags of [{ re: "faction", v: 1 } as Tags, { re: "crew", v: 1 }, { re: "select", v: storage.factions["rv-gui-a"].crew[0] }, { re: "pause" }, { re: "pause" }]) {
        onInspectorClick(player, tags)
      }
      refreshInspector(player)
      assert(state.renders.length > 0, "overlays drawn for the player")
      setInspectorOpen(player, false)
      assert(player.gui.screen.re_inspector === undefined, "inspector window closed")
      assert(state.renders.length === 0, "overlays cleared")
      assert(!game.tick_paused, "left unpaused")
    })
  })

  test("B33 growth overlay draws a smelter's next units and a whole-patch mine's plan, built drills and patch", () => {
    const lab = createLab(48)
    const ox = math.floor(lab.origin.x)
    const oy = math.floor(lab.origin.y)
    const policy = selectPolicy("early-compact", {})
    const layout = newLayout()
    // A 4-furnace iron column: its growth units on the end tryExpand uses.
    const col = smelterColumn(prototypeFacts, { recipe: "iron-plate", furnaces: 4 })
    const sm: PlacedModule = { id: moduleId("s"), canonical: col, def: col, transform: { rot: 0, mirror: false }, origin: { x: ox - 40, y: oy - 40 }, rect: { x: ox - 40, y: oy - 40, w: col.footprint.w, h: col.footprint.h } }
    commitModule(layout, sm, prototypeFacts, policy.corridor.preferred)
    // An iron patch (also on the surface, for the outline) and a mine planned over it.
    const ore = { x: ox, y: oy, w: 18, h: 15 }
    for (let x = ore.x; x < ore.x + ore.w; x++) for (let y = ore.y; y < ore.y + ore.h; y++) lab.surface.create_entity({ name: "iron-ore", position: { x: x + 0.5, y: y + 0.5 }, amount: 1000 })
    const view: TerrainView = { block: () => FREE, ore: (x, y) => (x >= ore.x && y >= ore.y && x < ore.x + ore.w && y < ore.y + ore.h ? "iron-ore" : undefined) }
    const raw = miningOutpost(prototypeFacts, { resource: "iron-ore", rows: 2, sides: 1 })
    const mine: PlacedModule = { id: moduleId("mine"), canonical: raw, def: raw, transform: { rot: 0, mirror: false }, origin: { x: ox + 2, y: oy + 2 }, rect: { x: ox + 2, y: oy + 2, w: raw.footprint.w, h: raw.footprint.h } }
    prepareWholePatchPlacement(mine, view, prototypeFacts, { x: ox - 48, y: oy - 48, w: 96, h: 96 }, policy, layout)
    assert(mine.minePlan !== undefined, "the mine has its whole-patch plan")
    commitModule(layout, mine, prototypeFacts, policy.corridor.preferred)
    const objs: LuaRenderObject[] = []
    const n = drawGrowthLayout(layout, lab.surface, undefined, 60, (o) => objs.push(o))
    log(`[b33] growth overlay: ${n.modules} modules, ${n.units} units, ${n.builtDrills} built + ${n.plannedDrills} planned drills, ${n.oreEdges} ore edges, ${objs.length} objects`)
    assert(n.modules === 2, `two modules drawn (${n.modules})`)
    assert(n.units === col.expand!.maxUnits, `every planned smelter unit drawn (${n.units} of ${col.expand!.maxUnits})`)
    assert(n.builtDrills === 2 && n.plannedDrills > 0, `built ${n.builtDrills} and planned ${n.plannedDrills} drills`)
    assert(n.oreEdges === 2 * (ore.w + ore.h), `patch outline ${n.oreEdges} edges`)
    for (const o of objs) assert(o.valid, "render objects exist")
    for (const o of objs) o.destroy()
  })
})

