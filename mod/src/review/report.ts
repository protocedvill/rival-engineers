import { LuaGuiElement, LuaPlayer, MapPosition, Tags } from "factorio:runtime"
import { getConfig } from "../config"
import { exportFactoryGraph } from "../strategy/factory-report"
import { dumpEntities, factionTelemetry } from "../telemetry"
import { workReport } from "../work"
import { playerState } from "./inspector"

// B34: the review "report" button (toolbar, shortcut, Ctrl+Shift+R). The user describes what they see; the mod
// writes a diagnostic bundle to script-output/rival-engineers/reports/<tick>-<slug>/ and saves the game as
// `_autosave-re-report-<tick>-<slug>` (game.auto_save: single player saves locally, a multiplayer server saves on the
// server, a headless --benchmark run ignores it). Files are written only on the reporting player's machine
// in multiplayer (helpers.write_file for_player). Nothing here changes what the AI does. docs/DEVELOPMENT.md "Reports" says how to read one.

export const REPORT_INPUT = "rival-engineers-report"
const ROOT = "re_report"
const TEXT = "re_report_text"
/** Longest slug taken from the message for the folder and save names. */
const SLUG_CHARS = 32

/** Lowercase words of the message joined by dashes, at most SLUG_CHARS long ("report" when empty). */
export function reportSlug(message: string): string {
  let [s] = string.gsub(string.lower(message), "[^%w]+", "-")
  ;[s] = string.gsub(s, "^%-+", "")
  s = string.sub(s, 1, SLUG_CHARS)
  ;[s] = string.gsub(s, "%-+$", "")
  return s === "" ? "report" : s
}

export interface ReportResult {
  /** script-output-relative folder of the bundle. */
  dir: string
  /** The save's file name (without .zip) in the saves folder. */
  save: string
  report: {
    message: string
    tick: number
    save: string
    surface: string
    camera: MapPosition
    zoom: number
    controller: string
    entitiesRadius: number
    entities: number
    graphs: string[]
    factions: Record<string, unknown>
  }
}

function controllerName(type: number): string {
  for (const [name, value] of pairs(defines.controllers)) if (value === type) return name as string
  return tostring(type)
}

/**
 * Writes the diagnostic bundle around the player's camera and saves the game. `save` false skips the save (tests).
 * Bundle: report.json (message, tick, save, surface, camera position and zoom, controller, the inspector's selected
 * faction/crew, each faction's brain/board/crew telemetry and the work report), message.txt, entities.json (a frame
 * dump around the camera, tools/render format, radius = the frame-dump-radius setting) and graph-<faction>.json
 * (each Factory Graph, as the soak's graph dumps).
 */
export function writeReport(player: LuaPlayer, message: string, save = true): ReportResult {
  const tick = game.tick
  const id = `${tick}-${reportSlug(message)}`
  const dir = `rival-engineers/reports/${id}`
  const saveName = `re-report-${id}`
  const saveFile = `_autosave-${saveName}`
  const surface = player.surface
  const camera = player.position
  const radius = getConfig().frameDumpRadius
  // Multiplayer: only the reporter's machine writes the bundle. Single player (and headless/test runs, whose player
  // is not the local one) writes normally.
  const who = game.is_multiplayer() ? (player.index as number) : undefined
  const entities = dumpEntities(`${dir}/entities.json`, camera, radius, surface, true, who)
  const graphs: string[] = []
  for (const name of storage.factionOrder) {
    const file = `graph-${name}.json`
    if (exportFactoryGraph(name, `${dir}/${file}`, who)) graphs.push(file)
  }
  const state = playerState(player.index)
  const report = {
    message,
    tick,
    save: saveFile,
    surface: surface.name,
    camera: { x: camera.x, y: camera.y },
    zoom: player.zoom,
    controller: controllerName(player.controller_type),
    physicalPosition: player.physical_position,
    physicalSurface: player.physical_surface.name,
    selectedFaction: state.faction,
    selectedCrew: state.crew,
    followedCrew: state.follow,
    gameSpeed: game.speed,
    modVersion: script.active_mods["rival-engineers"],
    entitiesRadius: radius,
    entities,
    graphs,
    factions: factionTelemetry(),
    work: workReport(),
  }
  helpers.write_file(`${dir}/report.json`, helpers.table_to_json(report as never), false, who)
  helpers.write_file(`${dir}/message.txt`, message + "\n", false, who)
  if (save) game.auto_save(saveName)
  log(`[rival-engineers] report at tick ${tick}: script-output/${dir}, save ${saveFile}: ${message}`)
  return { dir, save: saveFile, report }
}

// ---------------------------------------------------------------------------------------------------
// The dialog

export function reportDialogOpen(player: LuaPlayer): boolean {
  return player.gui.screen[ROOT] !== undefined
}

export function closeReportDialog(player: LuaPlayer): void {
  const frame = player.gui.screen[ROOT]
  if (frame) frame.destroy()
}

export function openReportDialog(player: LuaPlayer): void {
  const existing = player.gui.screen[ROOT]
  if (existing) {
    existing.bring_to_front()
    return
  }
  const frame = player.gui.screen.add({ type: "frame", name: ROOT, direction: "vertical", caption: "Report an issue (Rival Engineers)" })
  frame.auto_center = true
  frame.add({
    type: "label",
    caption: "What do you see? Saving writes the game and a diagnostic bundle (around your camera) for a later diagnosis.",
  }).style.single_line = false
  const text = frame.add({ type: "text-box", name: TEXT })
  text.style.width = 420
  text.style.height = 110
  text.word_wrap = true
  const buttons = frame.add({ type: "flow", direction: "horizontal" })
  buttons.add({ type: "button", caption: "Cancel", tags: { re: "report-cancel" } })
  const filler = buttons.add({ type: "empty-widget" })
  filler.style.horizontally_stretchable = true
  buttons.add({ type: "button", caption: "Save report", style: "confirm_button", tags: { re: "report-submit" } })
  text.focus()
}

export function toggleReportDialog(player: LuaPlayer): void {
  if (reportDialogOpen(player)) closeReportDialog(player)
  else openReportDialog(player)
}

/** Submits the open dialog: writes the report, closes it and tells the player where it went. */
export function submitReportDialog(player: LuaPlayer): ReportResult | undefined {
  const frame = player.gui.screen[ROOT]
  if (!frame) return undefined
  const text = frame[TEXT] as LuaGuiElement | undefined
  const message = text !== undefined ? ((text.text as string | undefined) ?? "") : ""
  frame.destroy()
  const result = writeReport(player, message)
  player.print(`Report saved: script-output/${result.dir}/ and save ${result.save}`)
  return result
}

/** Handles the dialog's clicks; returns false when the tags are not its own. */
export function onReportClick(player: LuaPlayer, tags: Tags): boolean {
  const what = tags.re as string | undefined
  if (what === undefined || !what.startsWith("report-")) return false
  if (what === "report-cancel") closeReportDialog(player)
  if (what === "report-submit") submitReportDialog(player)
  return true
}
