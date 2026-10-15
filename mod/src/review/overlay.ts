import { Color, LuaEntity, LuaPlayer, LuaRenderObject, MapPosition } from "factorio:runtime"
import { FactionState } from "../jobs/types"
import { describeCategory } from "./labels"
import { crewTime } from "./time"
import { PlayerReview } from "./types"

// Light world overlays for the live inspector, drawn with the `rendering` API for one player only
// (`players: [player]`), so they never affect other players or the game state.
//
// Overlays are layers. Each layer draws for one faction at a time. Built-in layers: "crew" (walk paths,
// targets, the action above each head) and "ghosts" (planned entities outlined in the faction's colour).
//
// HOOK for M5b (SPEC §5.8 D29, the in-game Factory Graph overlay): call `registerOverlayLayer("factory-graph",
// drawGraph)` at file scope in the graph overlay module and import that module from review/index.ts. The layer
// then gets a checkbox in the inspector and is redrawn with the others. Draw through `ctx.add(...)` so the
// objects are destroyed on the next redraw or when the layer is switched off.

export interface OverlayContext {
  player: LuaPlayer
  faction: FactionState
  color: Color
  /** Safety lifetime for drawn objects (they are also destroyed before the next redraw). */
  ttl: number
  add(this: void, obj: LuaRenderObject): void
}

export type OverlayLayer = (this: void, ctx: OverlayContext) => void

interface LayerEntry {
  name: string
  caption: string
  draw: OverlayLayer
  /** On for a player who has not chosen yet. */
  defaultOn: boolean
}

const layers: LayerEntry[] = []

/** Registers an overlay layer. Call at file scope (load time), never from an event. */
export function registerOverlayLayer(name: string, caption: string, draw: OverlayLayer, defaultOn = true): void {
  for (const l of layers) if (l.name === name) return
  layers.push({ name, caption, draw, defaultOn })
}

export function overlayLayers(): readonly LayerEntry[] {
  return layers
}

export function layerOn(state: PlayerReview, name: string): boolean {
  const v = state.layers[name]
  if (v !== undefined) return v
  for (const l of layers) if (l.name === name) return l.defaultOn
  return false
}

const PALETTE: Color[] = [
  { r: 1, g: 0.35, b: 0.2 },
  { r: 0.25, g: 0.6, b: 1 },
  { r: 0.3, g: 0.9, b: 0.3 },
  { r: 1, g: 0.85, b: 0.2 },
  { r: 0.85, g: 0.4, b: 1 },
  { r: 0.2, g: 0.95, b: 0.9 },
  { r: 1, g: 0.55, b: 0.75 },
  { r: 0.7, g: 0.7, b: 0.7 },
]

export function factionColor(name: string): Color {
  const i = storage.factionOrder.indexOf(name)
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]
}

export function clearOverlays(state: PlayerReview): void {
  for (const r of state.renders) if (r.valid) r.destroy()
  state.renders = []
}

/** Redraws every enabled layer for every faction for this player. */
export function drawOverlays(player: LuaPlayer, state: PlayerReview, ttl: number): void {
  clearOverlays(state)
  if (!state.open) return
  const add = (obj: LuaRenderObject): void => {
    state.renders.push(obj)
  }
  for (const name of storage.factionOrder) {
    const faction = storage.factions[name]
    const ctx: OverlayContext = { player, faction, color: factionColor(name), ttl, add }
    for (const l of layers) if (layerOn(state, l.name)) l.draw(ctx)
  }
}

// ---------------------------------------------------------------------------------------------------
// Built-in layers

const MAX_PATH_SEGMENTS = 80
const MAX_GHOSTS = 400

function targetOf(spec: Record<string, unknown>, action: Record<string, unknown>): LuaEntity | MapPosition | undefined {
  const e = (action.target ?? spec.target ?? spec.entity ?? spec.ghost) as LuaEntity | undefined
  if (e !== undefined && e.valid) return e
  return (spec.position ?? spec.goal) as MapPosition | undefined
}

function drawCrew(ctx: OverlayContext): void {
  const { player, faction, color, ttl, add } = ctx
  const players = [player]
  const surface = faction.surface
  for (const id of faction.crew) {
    const m = storage.crew[id]
    if (m === undefined || m.dead || !m.character.valid) continue
    const character = m.character
    const ctrl = storage.controllers[m.controller]
    const actionId = ctrl?.queue[0]
    const action = actionId !== undefined ? storage.actions[actionId] : undefined
    const t = crewTime(id)
    const now = t ? describeCategory(t.current) : "?"
    const secs = t ? math.floor((game.tick - t.currentSince) / 60) : 0
    const what = action ? action.spec.kind : "no action"
    add(
      rendering.draw_text({
        text: `#${id} ${what} · ${now} ${secs}s`,
        surface,
        target: { entity: character, offset: [0, -2.9] },
        color,
        scale: 1.1,
        alignment: "center",
        players,
        time_to_live: ttl,
      }),
    )
    if (!action) continue
    const walk = action.walk
    const waypoints = walk?.waypoints
    if (walk && waypoints && walk.phase === "follow") {
      let from: LuaEntity | MapPosition = character
      const last = math.min(waypoints.length - 1, walk.index + MAX_PATH_SEGMENTS)
      for (let i = walk.index; i <= last; i++) {
        add(rendering.draw_line({ color, width: 2, from, to: waypoints[i], surface, players, time_to_live: ttl, draw_on_ground: true }))
        from = waypoints[i]
      }
    }
    const target = targetOf(action.spec as never, action as never) ?? walk?.goal
    if (target !== undefined) {
      add(rendering.draw_circle({ color, radius: 0.6, width: 3, filled: false, target, surface, players, time_to_live: ttl }))
      add(rendering.draw_line({ color, width: 1, gap_length: 0.4, dash_length: 0.4, from: character, to: target, surface, players, time_to_live: ttl }))
    }
  }
  const base = faction.brain?.hub ?? faction.brain?.base
  if (base) {
    add(rendering.draw_text({ text: `Faction ${faction.name}`, surface, target: base, color, scale: 3, alignment: "center", players, time_to_live: ttl }))
  }
}

function drawGhosts(ctx: OverlayContext): void {
  const { player, faction, color, ttl, add } = ctx
  const players = [player]
  const board = faction.board
  let n = 0
  for (const id of board.active) {
    const job = board.jobs[id]
    const p = job.payload
    if (p.kind !== "place" || !p.ghost.valid) continue
    if (n++ >= MAX_GHOSTS) break
    const box = p.ghost.bounding_box
    const claimed = job.status === "claimed"
    add(
      rendering.draw_rectangle({
        color: claimed ? color : { r: (color.r ?? 1) * 0.6, g: (color.g ?? 1) * 0.6, b: (color.b ?? 1) * 0.6, a: 0.6 },
        width: claimed ? 3 : 1.5,
        filled: false,
        left_top: box.left_top,
        right_bottom: box.right_bottom,
        surface: faction.surface,
        players,
        time_to_live: ttl,
      }),
    )
  }
}

registerOverlayLayer("crew", "Crew paths and actions", drawCrew)
registerOverlayLayer("ghosts", "Planned entities", drawGhosts)
