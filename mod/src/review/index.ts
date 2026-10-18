import { LuaPlayer } from "factorio:runtime"
import { INSPECTOR_INPUT, onInspectorChecked, onInspectorClick, onInspectorTick, playerState, setInspectorOpen, toggleInspector } from "./inspector"
import { chartFactions, isSandbox, makeSpectator, onSandboxChunkGenerated, sandboxSetup } from "./sandbox"
import { onTimeTick } from "./time"
import "./overlay"
import "./graph-overlay"

// Live review tools (README "Watching the AI in game"): per-crew time accounting, the inspector window,
// world overlays and the sandbox scenario. `registerReview` is called once from control.ts; `onReviewTick` runs
// at the end of every tick (tick.ts). The Factory Graph overlay (M5b) is a layer in review/graph-overlay.ts.

const CHART_INTERVAL = 600

function anyInspectorOpen(): boolean {
  const players = storage.review?.players
  if (players === undefined) return false
  for (const [, player] of game.players) if (players[player.index]?.open) return true
  return false
}

export function onReviewTick(): void {
  const tick = game.tick
  onTimeTick()
  sandboxSetup()
  const review = storage.review
  if (review === undefined) return
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
}

function onPlayerCreated(player: LuaPlayer): void {
  if (!isSandbox()) return
  const state = playerState(player.index)
  makeSpectator(player, state)
  state.gotoFirstFaction = true
  setInspectorOpen(player, true)
  const gui = player.gui.screen.re_inspector !== undefined ? "open" : "missing"
  log(`[rival-engineers] sandbox: player ${player.name} controller ${player.controller_type}, inspector ${gui}`)
}

export function registerReview(): void {
  script.on_event(INSPECTOR_INPUT, (e) => toggleInspector(game.get_player(e.player_index)!))
  script.on_event(defines.events.on_lua_shortcut, (e) => {
    if (e.prototype_name === INSPECTOR_INPUT) toggleInspector(game.get_player(e.player_index)!)
  })
  script.on_event(defines.events.on_gui_click, (e) => {
    const element = e.element
    if (!element.valid || element.get_mod() !== "rival-engineers") return
    onInspectorClick(game.get_player(e.player_index)!, element.tags)
  })
  script.on_event(defines.events.on_gui_checked_state_changed, (e) => {
    const element = e.element
    if (!element.valid || element.get_mod() !== "rival-engineers") return
    onInspectorChecked(game.get_player(e.player_index)!, element)
  })
  script.on_event(defines.events.on_player_created, (e) => onPlayerCreated(game.get_player(e.player_index)!))
  script.on_event(defines.events.on_player_removed, (e) => {
    const players = storage.review?.players
    if (players !== undefined) delete players[e.player_index]
  })
  script.on_event(defines.events.on_chunk_generated, onSandboxChunkGenerated)
}
