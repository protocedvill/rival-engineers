import { Color, LuaGuiElement, LuaPlayer, Tags } from "factorio:runtime"
import { getConfig } from "../config"
import { findModule } from "../planner/layout"
import { NodeStatus } from "../planner/logical"
import { getFactory, reconcileParams } from "../strategy/factory"
import { factionNames } from "./model"
import { GraphEdgeRow, GraphLayoutView, GraphNodeRow, graphLayout } from "./graph-layout"
import { MAX_EDGES, STATUS_COLOR } from "./graph-overlay"
import { playerState, refreshInterval } from "./inspector"
import { goTo } from "./sandbox"
import { PlayerReview, reviewStorage } from "./types"

// The factory-graph window (B16): a per-player screen frame next to the map overlay (hotkey Ctrl+Shift+G) that
// shows, per faction, the graph laid out by dataflow — sources left, consumers right, one chip per module with its
// reconciler status and measured / planned rate below it, and a table of every edge's planned vs measured flow
// with the probe verdict. It need not match real positions: clicking a chip takes your camera to the module in the
// base. Data comes from graph-layout.ts (pure, T1-tested); nothing here changes what the AI does.

export const GRAPH_INPUT = "rival-engineers-toggle-graph"
const ROOT = "re_graph"
const STATUS_ORDER: NodeStatus[] = ["ok", "starved", "backed-up", "unpowered", "unfuelled", "expected", "unknown"]

const VERDICT_TEXT: Record<NonNullable<GraphEdgeRow["verdict"]>, string> = {
  stale: "not probed",
  full: "at belt capacity",
  intake: "waiting at the consumer",
  broken: "piles up at the producer",
  sparse: "below plan while flowing",
}

const VERDICT_COLOR: Record<NonNullable<GraphEdgeRow["verdict"]>, Color> = {
  stale: { r: 0.7, g: 0.7, b: 0.7 },
  full: { r: 1, g: 0.6, b: 0.1 },
  intake: { r: 0.3, g: 0.55, b: 1 },
  broken: { r: 1, g: 0.25, b: 0.2 },
  sparse: { r: 0.3, g: 0.9, b: 0.9 },
}

function fmt(x: number | undefined): string {
  return x === undefined ? "?" : string.format("%.2g", x)
}

function pctLoad(load: number | undefined): string {
  return load === undefined ? "?" : string.format("%d%%", math.floor(load * 100 + 0.5))
}

function nodeColor(n: GraphNodeRow): Color {
  return n.lifecycle === "built" ? STATUS_COLOR[n.status] : { r: 0.5, g: 0.5, b: 0.5, a: 0.5 }
}

function rateLabel(n: GraphNodeRow): string {
  if (n.kind === "power") return `load ${pctLoad(n.load)}`
  return `${fmt(n.measuredOut)}/${fmt(n.plannedOut)}/s`
}

function chipTooltip(n: GraphNodeRow): string {
  const lines = [`#${n.id} ${n.role} (${n.kind})`, `item: ${n.item ?? "-"} · ${n.lifecycle}${n.machines !== undefined ? ` · ${n.machines} machines` : ""}`]
  lines.push(n.kind === "power" ? `load: ${pctLoad(n.load)} of ${fmt(n.plannedOut)} W` : `rate: ${rateLabel(n)} (measured/planned)`)
  if (n.status !== "ok" && n.statusReason !== undefined) lines.push(`status: ${n.status} (${n.statusReason})`)
  if (n.cause !== undefined) lines.push(`cause: ${n.cause}`)
  if (n.lifecycle !== "built") lines.push("Not built yet (grey chip).")
  return lines.join("\n")
}

function edgeNote(e: GraphEdgeRow): { text: string; color?: Color } {
  if (e.kind === "power") return { text: "power edge", color: { r: 0.85, g: 0.3, b: 1 } }
  const verdict = e.verdict
  if (verdict === undefined || verdict === "stale") return { text: "not probed yet (the probe visits edges round-robin)", color: VERDICT_COLOR.stale }
  let text = VERDICT_TEXT[verdict]
  if (e.measured !== undefined) text += ` · ${fmt(e.measured)} of ${fmt(e.planned)} /s`
  return { text, color: VERDICT_COLOR[verdict] }
}

function label(parent: LuaGuiElement, caption: string, tooltip?: string, bold?: boolean): LuaGuiElement {
  const l = parent.add({ type: "label", caption, tooltip })
  if (bold) l.style.font = "default-bold"
  l.style.single_line = false
  l.style.maximal_width = 640
  return l
}

function button(parent: LuaGuiElement, caption: string, tags: Tags, tooltip?: string, toggled?: boolean): LuaGuiElement {
  const b = parent.add({ type: "button", caption, tags, tooltip, toggled })
  b.style.minimal_width = 0
  b.style.padding = [0, 6]
  b.style.height = 26
  return b
}

function row(parent: LuaGuiElement): LuaGuiElement {
  const r = parent.add({ type: "flow", direction: "horizontal" })
  r.style.vertical_align = "center"
  r.style.horizontal_spacing = 6
  return r
}

// ---------------------------------------------------------------------------------------------------
// Open / close

export function setGraphOpen(player: LuaPlayer, open: boolean): void {
  const state = playerState(player.index)
  state.graphOpen = open
  player.set_shortcut_toggled(GRAPH_INPUT, open)
  const existing = player.gui.screen[ROOT]
  if (!open) {
    if (existing) existing.destroy()
    return
  }
  if (!existing) {
    const frame = player.gui.screen.add({ type: "frame", name: ROOT, direction: "vertical" })
    frame.auto_center = true
    const bar = frame.add({ type: "flow", direction: "horizontal" })
    bar.drag_target = frame
    bar.add({ type: "label", caption: "Rival Engineers factory graph", style: "frame_title", ignored_by_interaction: true })
    const filler = bar.add({ type: "empty-widget", style: "draggable_space_header", ignored_by_interaction: false })
    filler.drag_target = frame
    filler.style.horizontally_stretchable = true
    filler.style.height = 24
    filler.style.minimal_width = 24
    bar.add({ type: "sprite-button", sprite: "utility/close", style: "close_button", tags: { re: "graph-close" }, tooltip: "Close (Ctrl+Shift+G)" })
    frame.add({ type: "flow", name: "re_body", direction: "vertical" })
  }
  refreshGraphWindow(player)
}

export function toggleGraphWindow(player: LuaPlayer): void {
  setGraphOpen(player, playerState(player.index).graphOpen !== true)
}

/** Keeps state.faction pointing at an existing faction (the graph window shares the inspector's selection). */
function normalizeFaction(state: PlayerReview): void {
  const names = factionNames()
  if (names.length === 0) {
    state.faction = undefined
    return
  }
  if (state.faction === undefined || storage.factions[state.faction] === undefined) state.faction = names[0]
}

// ---------------------------------------------------------------------------------------------------
// Rendering the window

function addSummary(body: LuaGuiElement, v: GraphLayoutView): void {
  const r = row(body)
  label(r, "Nodes", "Reconciler status counts for the graph's nodes (the map overlay's status colours).", true)
  for (const s of STATUS_ORDER) {
    const n = v.statusCounts[s]
    if (n === 0) continue
    const l = label(r, `${s} ${n}`)
    l.style.font_color = STATUS_COLOR[s]
  }
}

/** The dataflow canvas: one column per depth level, one chip (button) per node with its rate below it. */
function addNodeCanvas(body: LuaGuiElement, v: GraphLayoutView): void {
  label(body, "Left → right: dataflow. Click a chip to see the module in the base.", undefined, true)
  const scroll = body.add({ type: "scroll-pane" })
  scroll.style.maximal_height = 320
  scroll.style.margin = [4, 0]
  const canvas = scroll.add({ type: "flow", name: "re_canvas", direction: "horizontal" })
  canvas.style.horizontal_spacing = 16
  let i = 0
  for (const level of v.levels) {
    const column = canvas.add({ type: "flow", name: `re_lvl_${i++}`, direction: "vertical" })
    column.style.vertical_spacing = 4
    for (const n of level) {
      const chip = column.add({ type: "button", name: `re_chip_${n.id}`, caption: n.role, tags: { re: "graph-node", v: n.id }, tooltip: chipTooltip(n) })
      chip.style.font = "default"
      chip.style.font_color = nodeColor(n)
      chip.style.minimal_width = 0
      chip.style.padding = [0, 4]
      chip.style.height = 24
      chip.style.maximal_width = 220
      const rate = column.add({ type: "label", caption: rateLabel(n), style: "caption_label", tooltip: chipTooltip(n) })
      rate.style.font_color = nodeColor(n)
    }
  }
}

function addEdgeTable(body: LuaGuiElement, v: GraphLayoutView): void {
  label(body, `Edges (${v.edges.length}${v.edges.length >= MAX_EDGES ? ", capped on the map overlay" : ""})`, undefined, true)
  const table = body.add({ type: "table", column_count: 6, style: "bordered_table" })
  for (const h of ["From", "To", "Item", "Plan", "Measured", "Probe"]) {
    table.add({ type: "label", caption: h, style: "caption_label" })
  }
  const roles: Record<string, string | undefined> = {}
  for (const n of v.nodes) roles[n.id] = n.role
  let shown = 0
  for (const e of v.edges) {
    if (shown++ >= MAX_EDGES) break
    table.add({ type: "label", caption: `${e.from !== undefined ? (roles[e.from] ?? e.from) : "(outside)"}` })
    table.add({ type: "label", caption: roles[e.to] ?? e.to })
    table.add({ type: "label", caption: e.kind === "power" ? "electricity" : e.item })
    table.add({ type: "label", caption: `${fmt(e.planned)}${e.kind === "power" ? " W" : "/s"}` })
    table.add({ type: "label", caption: e.measured !== undefined ? fmt(e.measured) : "-" })
    const note = edgeNote(e)
    const cell = table.add({ type: "label", caption: note.text })
    cell.style.font_color = note.color ?? { r: 0.7, g: 0.7, b: 0.7 }
  }
  if (v.edges.length > shown) label(body, `… ${v.edges.length - shown} more edges (see the map overlay for their routes).`)
}

export function refreshGraphWindow(player: LuaPlayer): void {
  const state = playerState(player.index)
  state.graphLastRefresh = game.tick
  const frame = player.gui.screen[ROOT]
  if (state.graphOpen !== true || !frame) return
  normalizeFaction(state)
  const body = frame.re_body!
  body.clear()
  const head = row(body)
  button(head, "◀", { re: "graph-faction", v: -1 }, "Previous faction")
  label(head, `Faction ${state.faction ?? "-"}`, "Shares the inspector's faction selection (◀ ▶ here change both windows).", true)
  button(head, "▶", { re: "graph-faction", v: 1 }, "Next faction")
  const scroll = body.add({ type: "scroll-pane" })
  scroll.style.maximal_height = 640
  if (state.faction === undefined) {
    label(scroll, "No AI faction yet. Factions spawn on the first tick of a new map (setting \"Spawn AI factions on a new map\").")
    return
  }
  const f = getFactory(state.faction)
  if (f === undefined) {
    label(scroll, `Faction ${state.faction} has no factory yet (it starts with the first electricity materials).`)
    return
  }
  const stats = graphLayout(f.graph, game.tick, reconcileParams(getConfig()))
  if (stats.levels.length === 0) {
    label(scroll, "The factory's graph is empty so far.")
    return
  }
  addSummary(scroll, stats)
  scroll.add({ type: "line" })
  addNodeCanvas(scroll, stats)
  scroll.add({ type: "line" })
  addEdgeTable(scroll, stats)
}

// ---------------------------------------------------------------------------------------------------
// Input

function cycle<T>(list: T[], current: T | undefined, step: number): T | undefined {
  if (list.length === 0) return undefined
  const i = current !== undefined ? list.indexOf(current) : -1
  return list[(((i < 0 ? 0 : i + step) % list.length) + list.length) % list.length]
}

/** Handles the graph window's clicks; returns false when the tags are not its own (then the inspector acts). */
export function onGraphClick(player: LuaPlayer, tags: Tags): boolean {
  const what = tags.re as string | undefined
  if (what === undefined || !what.startsWith("graph-")) return false
  const state = playerState(player.index)
  const v = tags.v as number | undefined
  switch (what) {
    case "graph-close":
      setGraphOpen(player, false)
      return true
    case "graph-faction":
      state.faction = cycle(factionNames(), state.faction, v ?? 0)
      refreshGraphWindow(player)
      return true
    case "graph-node": {
      const f = state.faction !== undefined ? getFactory(state.faction) : undefined
      const id = tags.v as string | undefined
      if (f === undefined || id === undefined) return true
      const m = findModule(f.layout, id)
      const faction = storage.factions[f.faction]
      if (m !== undefined && faction !== undefined) goTo(player, { x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h / 2 }, faction.surface)
      return true
    }
    default:
      return true
  }
}

/** Periodic refresh of every open factory-graph window (same cadence as the inspector). */
export function onGraphTick(tick: number): void {
  const interval = refreshInterval()
  for (const player of game.connected_players) {
    const state: PlayerReview | undefined = reviewStorage().players[player.index]
    if (state === undefined || state.graphOpen !== true) continue
    const last = state.graphLastRefresh
    if (tick - (last ?? 0) >= interval) refreshGraphWindow(player)
  }
}
