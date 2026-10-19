import { LuaGuiElement, LuaPlayer, Tags } from "factorio:runtime"
import { toggleGraphWindow } from "./graph-window"
import { playerState, setOverlayOn, toggleInspector, toggleLayer } from "./inspector"
import { layerOn, overlayLayers } from "./overlay"
import { reportDialogOpen, toggleReportDialog } from "./report"

// B35: the review toolbar, a small always-visible bar at the top left (player.gui.top). A spectator has no
// shortcut bar, so this is where the sandbox's buttons live: inspector, factory graph, the overlay with one toggle
// per registered overlay layer (registerOverlayLayer, listed generically), and the B34 report. It appears in the
// sandbox scenario and for any spectating player; buttons show their window's open state.

const ROOT = "re_toolbar"

function wantsToolbar(player: LuaPlayer): boolean {
  return storage.review?.sandboxReady === true || player.controller_type === defines.controllers.spectator
}

function button(parent: LuaGuiElement, caption: string, tags: Tags, tooltip: string, toggled: boolean): void {
  const b = parent.add({ type: "button", caption, tags, tooltip, toggled })
  b.style.minimal_width = 0
  b.style.padding = [0, 6]
  b.style.height = 28
}

function fill(bar: LuaGuiElement, player: LuaPlayer): void {
  const state = playerState(player.index)
  button(bar, "Inspector", { re: "tb-inspector" }, "Crew, jobs and time accounting (Ctrl+Shift+I)", state.open)
  button(bar, "Graph", { re: "tb-graph" }, "Factory graph window (Ctrl+Shift+G)", state.graphOpen === true)
  button(bar, "Overlay", { re: "tb-overlay" }, "Draw the overlay layers with the inspector closed (they always show while it is open)", state.overlay === true)
  for (const l of overlayLayers()) button(bar, l.caption, { re: "tb-layer", v: l.name }, `Overlay layer: ${l.caption}`, layerOn(state, l.name))
  button(bar, "Report…", { re: "tb-report" }, "Report an issue: your description, a save and a diagnostic bundle (Ctrl+Shift+R)", reportDialogOpen(player))
}

/** Creates the toolbar if this player should have one and does not yet. Cheap enough for every tick. */
export function ensureToolbar(player: LuaPlayer): void {
  if (player.gui.top[ROOT] !== undefined || !wantsToolbar(player)) return
  const frame = player.gui.top.add({ type: "frame", name: ROOT, direction: "horizontal" })
  frame.style.padding = 4
  const bar = frame.add({ type: "flow", name: "re_bar", direction: "horizontal" })
  bar.style.horizontal_spacing = 4
  fill(bar, player)
}

/** Rebuilds the toolbar's buttons (their toggled states and the current overlay layers). */
export function refreshToolbar(player: LuaPlayer): void {
  const bar = player.gui.top[ROOT]?.re_bar
  if (bar === undefined) return
  bar.clear()
  fill(bar, player)
}

/** Handles the toolbar's clicks; returns false when the tags are not its own. */
export function onToolbarClick(player: LuaPlayer, tags: Tags): boolean {
  const what = tags.re as string | undefined
  if (what === undefined || !what.startsWith("tb-")) return false
  const state = playerState(player.index)
  switch (what) {
    case "tb-inspector":
      toggleInspector(player)
      break
    case "tb-graph":
      toggleGraphWindow(player)
      break
    case "tb-overlay":
      setOverlayOn(player, state.overlay !== true)
      break
    case "tb-layer":
      toggleLayer(player, tags.v as string)
      break
    case "tb-report":
      toggleReportDialog(player)
      break
  }
  return true
}
