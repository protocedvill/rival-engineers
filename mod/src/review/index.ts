import { LuaPlayer, PlayerIndex, Tags } from "factorio:runtime"
import { GRAPH_INPUT, onGraphClick, onGraphTick, toggleGraphWindow } from "./graph-window"
import { INSPECTOR_INPUT, onInspectorChecked, onInspectorClick, onInspectorTick, playerState, setInspectorOpen, toggleInspector } from "./inspector"
import { onReportClick, REPORT_INPUT, toggleReportDialog } from "./report"
import { chartFactions, isSandbox, makeSpectator, onSandboxChunkGenerated, sandboxSetup } from "./sandbox"
import { ensureToolbar, onToolbarClick, refreshToolbar } from "./toolbar"
import { onTimeTick } from "./time"
import "./overlay"
import "./graph-overlay"
import "./growth-overlay"

// Live review tools (README "Watching the AI in game"): per-crew time accounting, the inspector window,
// world overlays and the sandbox scenario. `registerReview` is called once from control.ts; `onReviewTick` runs
// at the end of every tick (tick.ts). The Factory Graph overlay (M5b) is a layer in review/graph-overlay.ts.

const CHART_INTERVAL = 600

function anyInspectorOpen(): boolean {
  const players = storage.review?.players
  if (players === undefined) return false
  for (const [, player] of game.players) if (players[player.index]?.open || players[player.index]?.graphOpen || players[player.index]?.overlay) return true
  return false
}

export function onReviewTick(): void {
  const tick = game.tick
  onTimeTick()
  sandboxSetup()
  const review = storage.review
  if (review === undefined) return
  // B35: the review toolbar for sandbox players and spectators (also appears in saves made before it existed).
  for (const player of game.connected_players) ensureToolbar(player)
  // Sandbox: jump new spectators to the first faction once it exists.
  if (storage.factionOrder.length > 0) {
    for (const [, player] of game.players) {
      const s = review.players[player.index]
      if (s?.gotoFirstFaction !== true) continue
      const f = storage.factions[storage.factionOrder[0]]
      const m = f.crew.length > 0 ? storage.crew[f.crew[0]] : undefined
      if (m !== undefined && m.character.valid) {
        s.gotoFirstFaction = false
        if (player.controller_type === defines.controllers.spectator) player.teleport(m.character.position, f.surface)
      }
    }
  }
  if ((isSandbox() || anyInspectorOpen()) && tick - (review.lastChart ?? -CHART_INTERVAL) >= CHART_INTERVAL) {
    review.lastChart = tick
    chartFactions()
  }
  onInspectorTick(tick)
  onGraphTick(tick)
}

function onPlayerCreated(player: LuaPlayer): void {
  if (!isSandbox()) return
  const state = playerState(player.index)
  makeSpectator(player, state)
  state.gotoFirstFaction = true
  setInspectorOpen(player, true)
  ensureToolbar(player)
  refreshToolbar(player)
  const gui = player.gui.screen.re_inspector !== undefined ? "open" : "missing"
  log(`[rival-engineers] sandbox: player ${player.name} controller ${player.controller_type}, inspector ${gui}`)
}

/** The review hotkeys and shortcut buttons (B35: same names for the custom input and the shortcut). */
const REVIEW_ACTIONS: Record<string, (this: void, player: LuaPlayer) => void> = {
  [INSPECTOR_INPUT]: toggleInspector,
  [GRAPH_INPUT]: toggleGraphWindow,
  [REPORT_INPUT]: toggleReportDialog,
}

function runAction(name: string, playerIndex: PlayerIndex): void {
  const action = REVIEW_ACTIONS[name]
  const player = game.get_player(playerIndex)
  if (action === undefined || player === undefined || !player.valid) return
  action(player)
  refreshToolbar(player)
}

export function registerReview(): void {
  for (const name of [INSPECTOR_INPUT, GRAPH_INPUT, REPORT_INPUT]) script.on_event(name, (e) => runAction(e.input_name, e.player_index))
  script.on_event(defines.events.on_lua_shortcut, (e) => runAction(e.prototype_name, e.player_index))
  script.on_event(defines.events.on_gui_click, (e) => {
    const element = e.element
    if (!element.valid || element.get_mod() !== "rival-engineers") return
    const player = game.get_player(e.player_index)!
    const tags = element.tags as Tags
    // Toolbar, report dialog and graph window answer their own tags first; everything else stays with the inspector.
    if (!onToolbarClick(player, tags) && !onReportClick(player, tags) && !onGraphClick(player, tags)) onInspectorClick(player, tags)
    refreshToolbar(player)
  })
  script.on_event(defines.events.on_gui_checked_state_changed, (e) => {
    const element = e.element
    if (!element.valid || element.get_mod() !== "rival-engineers") return
    const player = game.get_player(e.player_index)!
    onInspectorChecked(player, element)
    refreshToolbar(player)
  })
  script.on_event(defines.events.on_player_created, (e) => onPlayerCreated(game.get_player(e.player_index)!))
  // A player who starts spectating (the inspector's Spectate button) gets the toolbar.
  script.on_event(defines.events.on_player_controller_changed, (e) => {
    const player = game.get_player(e.player_index)
    if (player !== undefined && player.valid) ensureToolbar(player)
  })
  script.on_event(defines.events.on_player_removed, (e) => {
    const players = storage.review?.players
    if (players !== undefined) delete players[e.player_index]
  })
  script.on_event(defines.events.on_chunk_generated, onSandboxChunkGenerated)
}
