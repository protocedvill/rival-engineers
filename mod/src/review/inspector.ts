import { LuaGuiElement, LuaPlayer, Tags } from "factorio:runtime"
import { categoryHelp, describeCategory } from "./labels"
import { crewView, CrewView, factionNames, factionView, FactionView } from "./model"
import { drawOverlays, factionColor, layerOn, overlayLayers } from "./overlay"
import { follow, goTo, toggleSpectator, unfollow } from "./sandbox"
import { TimeBreakdown } from "./time"
import { PlayerReview, reviewStorage, TIME_CATEGORIES } from "./types"

// The live inspector: a per-player window (hotkey Ctrl+Shift+I, or the shortcut-bar button) that shows, per
// faction, the brain's phase, the Job Board and stalls, and per crew member what it is doing and where its time
// goes. All state is per player in storage; clicks only change that player's view, the camera, and (admins only)
// the game speed. Nothing here changes what the AI does.

export const INSPECTOR_INPUT = "rival-engineers-toggle-inspector"
const ROOT = "re_inspector"
const SPEEDS = [1, 2, 4, 8, 16]
/** Refresh the window and overlays every this many ticks at ×1 (scaled with game speed). */
const REFRESH_TICKS = 30

export function playerState(index: number): PlayerReview {
  const players = reviewStorage().players
  let s = players[index]
  if (s === undefined) {
    s = { open: false, layers: {}, renders: [], lastRefresh: 0 }
    players[index] = s
  }
  return s
}

export function refreshInterval(): number {
  return math.max(REFRESH_TICKS, math.floor(REFRESH_TICKS * game.speed))
}

// ---------------------------------------------------------------------------------------------------
// Open / close

export function setInspectorOpen(player: LuaPlayer, open: boolean): void {
  const state = playerState(player.index)
  state.open = open
  player.set_shortcut_toggled(INSPECTOR_INPUT, open)
  const existing = player.gui.screen[ROOT]
  if (!open) {
    if (existing) existing.destroy()
    // Clears the overlays, or keeps them when the toolbar's Overlay button is on.
    drawOverlays(player, state, refreshInterval() + 10)
    return
  }
  if (!existing) {
    const frame = player.gui.screen.add({ type: "frame", name: ROOT, direction: "vertical" })
    frame.auto_center = true
    const bar = frame.add({ type: "flow", direction: "horizontal" })
    bar.drag_target = frame
    bar.add({ type: "label", caption: "Rival Engineers inspector", style: "frame_title", ignored_by_interaction: true })
    const filler = bar.add({ type: "empty-widget", style: "draggable_space_header", ignored_by_interaction: false })
    filler.drag_target = frame
    filler.style.horizontally_stretchable = true
    filler.style.height = 24
    filler.style.minimal_width = 24
    bar.add({ type: "sprite-button", sprite: "utility/close", style: "close_button", tags: { re: "close" }, tooltip: "Close (Ctrl+Shift+I)" })
    frame.add({ type: "flow", name: "re_body", direction: "vertical" })
  }
  refreshInspector(player)
}

export function toggleInspector(player: LuaPlayer): void {
  setInspectorOpen(player, !playerState(player.index).open)
}

/** Redraws what this player sees after a review setting changed: the inspector (and overlays), or just the overlays. */
export function redrawReview(player: LuaPlayer): void {
  const state = playerState(player.index)
  if (state.open) refreshInspector(player)
  else {
    drawOverlays(player, state, refreshInterval() + 10)
    state.lastRefresh = game.tick
  }
}

/** The toolbar's Overlay button: overlays without the inspector window (B35). */
export function setOverlayOn(player: LuaPlayer, on: boolean): void {
  playerState(player.index).overlay = on
  redrawReview(player)
}

/** The toolbar's layer buttons: the same switch as the inspector's checkboxes. */
export function toggleLayer(player: LuaPlayer, name: string): void {
  const state = playerState(player.index)
  state.layers[name] = !layerOn(state, name)
  redrawReview(player)
}

// ---------------------------------------------------------------------------------------------------
// Rendering the window

function pct(n: number, of: number): string {
  return of > 0 ? string.format("%d%%", math.floor((100 * n) / of + 0.5)) : "-"
}

function secs(ticks: number): string {
  return ticks >= 3600 ? string.format("%dm%02ds", math.floor(ticks / 3600), math.floor((ticks % 3600) / 60)) : string.format("%ds", math.floor(ticks / 60))
}

function button(parent: LuaGuiElement, caption: string, tags: Tags, tooltip?: string, toggled?: boolean): LuaGuiElement {
  const b = parent.add({ type: "button", caption, tags, tooltip, toggled })
  b.style.minimal_width = 0
  b.style.padding = [0, 6]
  b.style.height = 26
  return b
}

function label(parent: LuaGuiElement, caption: string, tooltip?: string, bold?: boolean): LuaGuiElement {
  const l = parent.add({ type: "label", caption, tooltip })
  if (bold) l.style.font = "default-bold"
  l.style.single_line = false
  l.style.maximal_width = 620
  return l
}

function row(parent: LuaGuiElement): LuaGuiElement {
  const r = parent.add({ type: "flow", direction: "horizontal" })
  r.style.vertical_align = "center"
  r.style.horizontal_spacing = 4
  return r
}

function addControls(body: LuaGuiElement, player: LuaPlayer, state: PlayerReview): void {
  const r = row(body)
  label(r, "Speed", "Game speed (admins only). Time accounting counts game ticks, so speed does not change it.", true)
  for (const s of SPEEDS) button(r, `×${s}`, { re: "speed", v: s }, undefined, !game.tick_paused && math.abs(game.speed - s) < 0.01)
  button(r, game.tick_paused ? "Resume" : "Pause", { re: "pause" }, undefined, game.tick_paused)
  button(r, "Step", { re: "step" }, "Run one tick while paused")
  const spectating = player.controller_type !== defines.controllers.character
  button(r, spectating ? "Take body" : "Spectate", { re: "spectate" }, "Switch between your character and a free spectator camera")
  const layers = row(body)
  label(layers, "Overlays", "Drawn only for you", true)
  for (const l of overlayLayers()) {
    layers.add({ type: "checkbox", caption: l.caption, state: layerOn(state, l.name), tags: { re: "layer", v: l.name } })
  }
}

function addFaction(body: LuaGuiElement, v: FactionView): void {
  const head = row(body)
  button(head, "◀", { re: "faction", v: -1 }, "Previous faction")
  const title = label(head, `Faction ${v.name}  (${v.index}/${v.count})  ·  ${v.force}${v.paused ? "  ·  PAUSED" : ""}`, undefined, true)
  title.style.font_color = factionColor(v.name)
  button(head, "▶", { re: "faction", v: 1 }, "Next faction")
  if (v.base) button(head, "Go to base", { re: "goto-base" })
  label(body, `Phase: ${v.phase}   (goals ${v.goalsDone}/${v.goals}, plan steps ${v.steps}, crew ${v.alive}/${v.crew.length})`)
  if (v.waiting.length > 0) label(body, `Brain waiting on: ${v.waiting.join("; ")}`)
  const j = v.jobs
  label(
    body,
    `Jobs: ${j.ready} ready · ${j.claimed} claimed · ${j.deps} waiting on deps · ${j.backoff} in back-off   |   ${j.done} done · ${j.failed} failed · ${j.releases} releases (of ${j.added})`,
    "Ready: claimable now. Back-off: released after a failed attempt, retried later. Failed and releases are totals since the faction started.",
  )
  const o = v.oldest
  if (o) {
    label(body, `Oldest waiting job: #${o.id} ${o.kind}, ${o.state}, waiting ${secs(o.ageTicks)}${o.attempts > 0 ? `, ${o.attempts} failed attempts` : ""}${o.reason ? ` (last: ${o.reason})` : ""}`)
  } else label(body, "Oldest waiting job: none")
  let stalls = `Stalls detected: ${v.stalls}`
  if (v.stalled) stalls += `   STALLED now since ${secs(v.stalled.since)}: ${v.stalled.reason}${v.stalled.goal ? " (goal " + v.stalled.goal + ")" : ""}`
  else if (v.lastStall) stalls += `   (last at ${secs(v.lastStall.tick)}: ${v.lastStall.reason}, recovered)`
  label(body, stalls)
}

function share(b: TimeBreakdown | undefined, cats: (typeof TIME_CATEGORIES)[number][]): string {
  if (!b) return "-"
  let n = 0
  for (const c of cats) n += b.byCategory[c]
  return pct(n, b.ticks)
}

function addCrewTable(body: LuaGuiElement, v: FactionView, selected: number | undefined, followed: number | undefined, tick: number): void {
  const table = body.add({ type: "table", column_count: 9, style: "bordered_table" })
  for (const h of ["Crew", "Doing now", "For", "Job", "Queue", "Idle+wait*", "Hauling*", "Walk+path*", ""]) {
    table.add({ type: "label", caption: h, style: "caption_label", tooltip: h.endsWith("*") ? "Share of the last minute of game time" : undefined })
  }
  for (const id of v.crew) {
    const c = crewView(id, tick)
    if (!c) continue
    const name = table.add({ type: "label", caption: `#${id}${id === selected ? " ◆" : ""}` })
    if (id === selected) name.style.font = "default-bold"
    if (c.dead) {
      table.add({ type: "label", caption: "dead" })
      for (let i = 0; i < 6; i++) table.add({ type: "label", caption: "" })
      table.add({ type: "flow" })
      continue
    }
    table.add({ type: "label", caption: c.category ? describeCategory(c.category) : "-", tooltip: c.action ? `${c.action} [${c.actionPhase}]` : "no action" })
    table.add({ type: "label", caption: secs(c.categoryTicks) })
    table.add({ type: "label", caption: c.job ?? (c.action ?? "-") })
    table.add({ type: "label", caption: `${c.queue}` })
    table.add({ type: "label", caption: share(c.recent, ["idle", "waiting"]) })
    table.add({ type: "label", caption: share(c.recent, ["hauling"]) })
    table.add({ type: "label", caption: share(c.recent, ["walking", "pathing"]) })
    const b = table.add({ type: "flow", direction: "horizontal" })
    button(b, "Inspect", { re: "select", v: id })
    button(b, id === followed ? "Unfollow" : "Follow", { re: id === followed ? "unfollow" : "follow", v: id })
  }
}

function addCrewDetail(body: LuaGuiElement, c: CrewView, followed: boolean): void {
  const head = row(body)
  button(head, "◀", { re: "crew", v: -1 }, "Previous crew member")
  label(head, `Crew #${c.id}${c.dead ? " (dead)" : ""}`, undefined, true)
  button(head, "▶", { re: "crew", v: 1 }, "Next crew member")
  button(head, followed ? "Unfollow" : "Follow", { re: followed ? "unfollow" : "follow", v: c.id }, "Remote view centred on this crew member")
  button(head, "Go to", { re: "goto-crew", v: c.id }, "Move your camera there (no following)")
  if (c.dead) return
  label(body, `Action: ${c.action ?? "none"}${c.actionPhase ? "  [" + c.actionPhase + "]" : ""}   ·   job: ${c.job ?? "-"}   ·   queue ${c.queue}, claims ${c.claims}`)
  if (c.category) label(body, `Now: ${describeCategory(c.category)} for ${secs(c.categoryTicks)}`)
  const table = body.add({ type: "table", column_count: 6, style: "bordered_table" })
  const total = c.total
  const recent = c.recent
  const headers = ["Time", `Since start (${total ? secs(total.ticks) : "-"})`, "%", "", `Last ${recent ? secs(recent.ticks) : "-"}`, "%"]
  for (const h of headers) table.add({ type: "label", caption: h, style: "caption_label" })
  for (const cat of TIME_CATEGORIES) {
    const n = total?.byCategory[cat] ?? 0
    const r = recent?.byCategory[cat] ?? 0
    table.add({ type: "label", caption: describeCategory(cat), tooltip: categoryHelp(cat) })
    table.add({ type: "label", caption: secs(n) })
    table.add({ type: "label", caption: pct(n, total?.ticks ?? 0) })
    const bar = table.add({ type: "progressbar", value: total && total.ticks > 0 ? n / total.ticks : 0 })
    bar.style.width = 90
    table.add({ type: "label", caption: secs(r) })
    table.add({ type: "label", caption: pct(r, recent?.ticks ?? 0) })
  }
  const kinds: string[] = []
  for (const k in c.byKind) kinds.push(k)
  kinds.sort()
  const parts: string[] = []
  for (const k of kinds) parts.push(`${k} ${secs(c.byKind[k])}`)
  label(body, `Jobs done ${c.jobsDone} · released ${c.jobsReleased} · hauls ${c.hauls} · deposits ${c.deposits} · plans ${c.plans}`)
  if (parts.length > 0) label(body, `Busy by job kind: ${parts.join(", ")}`, "Ticks holding a claim, by the kind of job being worked (crew telemetry).")
  if (c.lastFailure) label(body, `Last failed action: ${c.lastFailure}`)
}

/** Keeps the selection valid: an existing faction, and a crew member of it. */
function normalizeSelection(state: PlayerReview): void {
  const names = factionNames()
  if (names.length === 0) {
    state.faction = undefined
    state.crew = undefined
    return
  }
  if (state.faction === undefined || storage.factions[state.faction] === undefined) state.faction = names[0]
  const crew = storage.factions[state.faction].crew
  if (state.crew === undefined || crew.indexOf(state.crew) < 0) state.crew = crew[0]
}

export function refreshInspector(player: LuaPlayer): void {
  const state = playerState(player.index)
  state.lastRefresh = game.tick
  const frame = player.gui.screen[ROOT]
  if (!state.open || !frame) return
  normalizeSelection(state)
  const body = frame.re_body!
  body.clear()
  addControls(body, player, state)
  body.add({ type: "line" })
  const scroll = body.add({ type: "scroll-pane" })
  scroll.style.maximal_height = 640
  const tick = game.tick
  const v = state.faction !== undefined ? factionView(state.faction, tick) : undefined
  if (!v) {
    label(scroll, "No AI faction yet. Factions spawn on the first tick of a new map (setting \"Spawn AI factions on a new map\").")
  } else {
    addFaction(scroll, v)
    scroll.add({ type: "line" })
    addCrewTable(scroll, v, state.crew, state.follow, tick)
    const c = state.crew !== undefined ? crewView(state.crew, tick) : undefined
    if (c) {
      scroll.add({ type: "line" })
      addCrewDetail(scroll, c, state.follow === c.id)
    }
  }
  drawOverlays(player, state, refreshInterval() + 10)
}

// ---------------------------------------------------------------------------------------------------
// Input

function cycle<T>(list: T[], current: T | undefined, step: number): T | undefined {
  if (list.length === 0) return undefined
  const i = current !== undefined ? list.indexOf(current) : -1
  return list[(((i < 0 ? 0 : i + step) % list.length) + list.length) % list.length]
}

export function onInspectorClick(player: LuaPlayer, tags: Tags): void {
  const state = playerState(player.index)
  const what = tags.re as string | undefined
  if (what === undefined) return
  const v = tags.v as number | string | undefined
  switch (what) {
    case "close":
      setInspectorOpen(player, false)
      return
    case "speed":
      if (player.admin) {
        game.speed = v as number
        game.tick_paused = false
      }
      break
    case "pause":
      if (player.admin) game.tick_paused = !game.tick_paused
      break
    case "step":
      if (player.admin) {
        game.tick_paused = true
        game.ticks_to_run = 1
      }
      break
    case "spectate":
      toggleSpectator(player, state)
      break
    case "faction":
      state.faction = cycle(factionNames(), state.faction, v as number)
      state.crew = undefined
      break
    case "crew": {
      if (state.faction === undefined) break
      state.crew = cycle(storage.factions[state.faction].crew, state.crew, v as number)
      if (state.follow !== undefined && state.crew !== undefined) follow(player, state, state.crew)
      break
    }
    case "select":
      state.crew = v as number
      break
    case "follow":
      state.crew = v as number
      follow(player, state, v as number)
      break
    case "unfollow":
      unfollow(player, state)
      break
    case "goto-crew": {
      const m = storage.crew[v as number]
      if (m !== undefined && m.character.valid) {
        state.follow = undefined
        goTo(player, m.character.position, m.character.surface.name)
      }
      break
    }
    case "goto-base": {
      const f = state.faction !== undefined ? storage.factions[state.faction] : undefined
      const base = f?.brain?.hub ?? f?.brain?.base
      if (f && base) goTo(player, base, f.surface)
      break
    }
    default:
      return
  }
  refreshInspector(player)
}

export function onInspectorChecked(player: LuaPlayer, element: LuaGuiElement): void {
  const tags = element.tags
  if (tags.re !== "layer") return
  const state = playerState(player.index)
  state.layers[tags.v as string] = element.state === true
  refreshInspector(player)
}

/** Periodic refresh of every open inspector (window and overlays). */
export function onInspectorTick(tick: number): void {
  const interval = refreshInterval()
  for (const player of game.connected_players) {
    const state = storage.review?.players[player.index]
    if (state === undefined) continue
    if (!state.open) {
      // Overlays alone (toolbar Overlay button), same cadence.
      if (state.overlay === true && tick - state.lastRefresh >= interval) redrawReview(player)
      continue
    }
    if (state.follow !== undefined) {
      // Stop following a crew member that died (the remote view stays where it was).
      const m = storage.crew[state.follow]
      if (m === undefined || !m.character.valid) state.follow = undefined
      // The player left the remote view (or centred on something else) by hand.
      else if (player.centered_on !== m.character) state.follow = undefined
    }
    if (tick - state.lastRefresh >= interval) refreshInspector(player)
  }
}
