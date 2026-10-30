import { LuaEntity, LuaGuiElement, LuaPlayer, PlayerIndex } from "factorio:runtime"
import { clearConfigOverrides } from "../config"
import { createFaction, destroyFaction } from "../jobs/faction"
import { GRAPH_INPUT } from "../review/graph-window"
import { INSPECTOR_INPUT, playerState, setInspectorOpen } from "../review/inspector"
import { overlayLayers } from "../review/overlay"
import { REPORT_INPUT, reportSlug, writeReport } from "../review/report"
import { setGraphOpen } from "../review/graph-window"
import { at, createLab } from "./lab"

// B35 / B34 T2: the review hotkeys work for a spectator (the sandbox player), the shortcut buttons and the review
// toolbar open the same windows, and the report writes its bundle. Events are dispatched through the handlers the
// mod registered (script.get_event_handler), as the engine would on a key press or click.

const INPUTS = [INSPECTOR_INPUT, GRAPH_INPUT, REPORT_INPUT]
const WINDOW: Record<string, string> = {
  [INSPECTOR_INPUT]: "re_inspector",
  [GRAPH_INPUT]: "re_graph",
  [REPORT_INPUT]: "re_report",
}

type Handler = (this: void, e: unknown) => void

function handler(event: string | defines.events): Handler {
  const h = script.get_event_handler(event as never) as Handler | undefined
  assert(h !== undefined, `the mod registers a handler for ${tostring(event)}`)
  return h!
}

function testPlayer(): LuaPlayer | undefined {
  const player = game.get_player(1 as PlayerIndex)
  return player !== undefined && player.valid ? player : undefined
}

let saved: { type: defines.controllers; character?: LuaEntity } | undefined

/** Puts the test player in spectator mode, like the sandbox scenario does. */
function spectate(player: LuaPlayer): void {
  saved = { type: player.controller_type, character: player.character ?? undefined }
  if (player.controller_type !== defines.controllers.spectator) player.set_controller({ type: defines.controllers.spectator })
  // The engine raises on_player_controller_changed after this handler returns; dispatch it now (the test must
  // finish within the tick, see below).
  handler(defines.events.on_player_controller_changed)({
    name: defines.events.on_player_controller_changed,
    tick: game.tick,
    player_index: player.index,
    old_type: saved.type,
  })
}

function restore(player: LuaPlayer): void {
  for (const name of ["re_inspector", "re_graph", "re_report"]) player.gui.screen[name]?.destroy()
  player.gui.top.re_toolbar?.destroy()
  const state = playerState(player.index)
  state.open = false
  state.graphOpen = false
  state.overlay = undefined
  if (saved === undefined) return
  if (saved.type === defines.controllers.character && saved.character !== undefined && saved.character.valid) {
    player.set_controller({ type: defines.controllers.character, character: saved.character })
  } else if (saved.type === defines.controllers.god) player.set_controller({ type: defines.controllers.god })
  saved = undefined
}

function findButton(root: LuaGuiElement, re: string, v?: string): LuaGuiElement | undefined {
  for (const child of root.children) {
    const tags = child.tags
    if (tags.re === re && (v === undefined || tags.v === v)) return child
    const found = findButton(child, re, v)
    if (found !== undefined) return found
  }
  return undefined
}

function click(player: LuaPlayer, element: LuaGuiElement): void {
  handler(defines.events.on_gui_click)({
    name: defines.events.on_gui_click,
    tick: game.tick,
    element,
    player_index: player.index,
    button: defines.mouse_button_type.left,
    alt: false,
    control: false,
    shift: false,
  })
}

function pressKey(player: LuaPlayer, input: string): void {
  handler(input)({ name: prototypes.custom_input[input].event_id, tick: game.tick, player_index: player.index, input_name: input, cursor_position: { x: 0, y: 0 } })
}

function pressShortcut(player: LuaPlayer, shortcut: string): void {
  handler(defines.events.on_lua_shortcut)({ name: defines.events.on_lua_shortcut, tick: game.tick, player_index: player.index, prototype_name: shortcut })
}

describe("review tools (B34, B35)", () => {
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })
  after_each(() => {
    const player = testPlayer()
    if (player !== undefined) restore(player)
  })

  test("review hotkeys fire for spectators and have shortcut buttons", () => {
    // B35 root cause: custom inputs default to enabled_while_spectating = false, so the sandbox's spectator never
    // got Ctrl+Shift+I / Ctrl+Shift+G.
    for (const name of INPUTS) {
      const input = prototypes.custom_input[name]
      assert(input !== undefined, `custom input ${name} exists`)
      assert(input.action === "lua", `${name} raises a Lua event`)
      assert(input.enabled_while_spectating, `${name} is enabled while spectating`)
      assert(prototypes.shortcut[name] !== undefined, `shortcut ${name} exists`)
    }
  })

  test("hotkeys and shortcut buttons toggle their windows for a spectator", () => {
    const player = testPlayer()
    if (player === undefined) {
      log("[review-tools] no player in this test run: GUI not exercised")
      return
    }
    spectate(player)
    assert(player.controller_type === defines.controllers.spectator, "player is a spectator")
    for (const name of INPUTS) {
      const window = WINDOW[name]
      assert(player.gui.screen[window] === undefined, `${window} starts closed`)
      pressKey(player, name)
      assert(player.gui.screen[window] !== undefined, `${name} hotkey opens ${window}`)
      pressKey(player, name)
      assert(player.gui.screen[window] === undefined, `${name} hotkey closes ${window}`)
      pressShortcut(player, name)
      assert(player.gui.screen[window] !== undefined, `${name} shortcut opens ${window}`)
      pressShortcut(player, name)
      assert(player.gui.screen[window] === undefined, `${name} shortcut closes ${window}`)
    }
  })

  test("a spectator gets the review toolbar; its buttons open the windows and list every overlay layer", () => {
    const player = testPlayer()
    if (player === undefined) {
      log("[review-tools] no player in this test run: GUI not exercised")
      return
    }
    const lab = createLab(16)
    createFaction("rt-bar", { position: at(lab, 0, 0), crew: 1 })
    // Synchronous: in the headless test run a spectating player across a tick ends the run (the test harness
    // exits), so every spectator test restores the character before the tick ends (after_each).
    spectate(player)
    {
      const bar = player.gui.top.re_toolbar
      assert(bar !== undefined && bar.valid, "the toolbar exists for a spectator")
      for (const [re, window] of [
        ["tb-inspector", "re_inspector"],
        ["tb-graph", "re_graph"],
        ["tb-report", "re_report"],
      ]) {
        click(player, findButton(bar!, re)!)
        assert(player.gui.screen[window] !== undefined, `${re} opens ${window}`)
        assert(findButton(bar!, re)!.toggled, `${re} shows as on`)
        click(player, findButton(bar!, re)!)
        assert(player.gui.screen[window] === undefined, `${re} closes ${window}`)
      }
      // Overlay without the inspector: drawn for the player, and every registered layer has its own toggle.
      const state = playerState(player.index)
      click(player, findButton(bar!, "tb-overlay")!)
      assert(state.overlay === true && state.renders.length > 0, `overlay on with the inspector closed (${state.renders.length} objects)`)
      for (const l of overlayLayers()) {
        const b = findButton(bar!, "tb-layer", l.name)
        assert(b !== undefined, `toolbar toggle for layer ${l.name}`)
        const before = b!.toggled
        click(player, b!)
        assert(findButton(bar!, "tb-layer", l.name)!.toggled === !before, `layer ${l.name} toggled`)
        click(player, findButton(bar!, "tb-layer", l.name)!)
      }
      click(player, findButton(bar!, "tb-overlay")!)
      assert(state.renders.length === 0, "overlay off clears the drawing")
      // The windows' own close buttons keep the toolbar in step.
      setInspectorOpen(player, true)
      setGraphOpen(player, true)
      click(player, findButton(player.gui.screen.re_graph!, "graph-close")!)
      assert(!findButton(bar!, "tb-graph")!.toggled, "graph button off after the window's close button")
    }
  })

  test("report: the dialog writes a bundle with the camera, factions and save name", () => {
    assert(reportSlug("Crew mines while furnaces hold 200 plates!") === "crew-mines-while-furnaces-hold-2", `slug ${reportSlug("Crew mines while furnaces hold 200 plates!")}`)
    assert(reportSlug("  ?? ") === "report", "empty slug")
    const lab = createLab(16)
    createFaction("rt-report", { position: at(lab, 0, 0), crew: 1 })
    const player = testPlayer()
    after_ticks(5, () => {
      if (player === undefined) {
        log("[review-tools] no player in this test run: report not exercised")
        return
      }
      spectate(player)
      player.teleport(at(lab, 0, 0), lab.surface)
      // Through the dialog: hotkey, type, submit.
      pressKey(player, REPORT_INPUT)
      const dialog = player.gui.screen.re_report!
      ;(dialog.re_report_text as { text: string }).text = "crew hand-mines while furnaces hold plates"
      click(player, findButton(dialog, "report-submit")!)
      assert(player.gui.screen.re_report === undefined, "submit closes the dialog")
      // Directly, to check the bundle's contents (the files themselves land in script-output; see the M6 report).
      const r = writeReport(player, "second report", false)
      const rep = r.report
      assert(r.dir === `rival-engineers/reports/${game.tick}-second-report`, `dir ${r.dir}`)
      assert(r.save === `_autosave-re-report-${game.tick}-second-report`, `save ${r.save}`)
      assert(rep.message === "second report" && rep.tick === game.tick && rep.surface === lab.surface.name, "message, tick, surface")
      assert(math.abs(rep.camera.x - at(lab, 0, 0).x) < 1 && math.abs(rep.camera.y - at(lab, 0, 0).y) < 1, "camera position")
      assert(rep.zoom > 0 && rep.controller === "spectator", `zoom ${rep.zoom}, controller ${rep.controller}`)
      assert(rep.entities > 0, `entities dumped around the camera: ${rep.entities}`)
      const f = rep.factions["rt-report"] as { crew: unknown[]; brain: unknown; activeJobs: unknown }
      assert(f !== undefined && f.crew.length === 1 && f.activeJobs !== undefined, "faction telemetry with board and crew")
      restore(player)
    })
  })
})
