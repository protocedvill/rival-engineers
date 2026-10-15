import { LuaPlayer, LuaSurface, MapPosition, OnChunkGeneratedEvent } from "factorio:runtime"
import { getConfig } from "../config"
import { PlayerReview, reviewStorage } from "./types"

// The "Rival Engineers sandbox" scenario (mod/static/scenarios/sandbox) and camera helpers. The scenario's own
// script is empty: the mod detects it through `script.level` and sets the map up here. Players there start as
// spectators (free camera, no body to look after), biters are off unless `sandbox-enemies` is set, and it is always
// day. Factions spawn through the normal auto-spawn settings (SPEC §5.7, D32).

export function isSandbox(): boolean {
  const level = script.level
  return level.mod_name === "rival-engineers" && level.level_name === "sandbox"
}

function removeEnemies(surface: LuaSurface, area?: { left_top: MapPosition; right_bottom: MapPosition }): void {
  for (const e of surface.find_entities_filtered({ force: "enemy", area })) if (e.valid) e.destroy()
}

/** One-time sandbox map setup, on the first tick (after the factions' starting areas are registered). */
export function sandboxSetup(): void {
  const review = reviewStorage()
  if (review.sandboxReady || !isSandbox()) return
  review.sandboxReady = true
  const surface = game.surfaces[1]
  surface.always_day = true
  if (!getConfig().sandboxEnemies) {
    const mgs = surface.map_gen_settings
    const controls = (mgs.autoplace_controls ?? {}) as Record<string, { frequency?: number; size?: number; richness?: number }>
    controls["enemy-base"] = { frequency: 0, size: 0, richness: 0 }
    ;(mgs as { autoplace_controls?: unknown }).autoplace_controls = controls
    surface.map_gen_settings = mgs
    surface.peaceful_mode = true
    ;(game.map_settings.enemy_expansion as { enabled: boolean }).enabled = false
    removeEnemies(surface)
  }
  log(`[rival-engineers] sandbox ready (enemies ${getConfig().sandboxEnemies ? "on" : "off"})`)
}

export function onSandboxChunkGenerated(e: OnChunkGeneratedEvent): void {
  if (!isSandbox() || getConfig().sandboxEnemies) return
  removeEnemies(e.surface, e.area)
}

// ---------------------------------------------------------------------------------------------------
// Camera and controller

/** Character ⇄ spectator. The body stays where it is and is taken back on return. */
export function toggleSpectator(player: LuaPlayer, state: PlayerReview): void {
  if (player.controller_type === defines.controllers.remote) player.exit_remote_view()
  if (player.controller_type === defines.controllers.character) {
    state.body = player.character ?? undefined
    player.set_controller({ type: defines.controllers.spectator })
    return
  }
  let body = state.body
  if (body === undefined || !body.valid) {
    const pos = player.surface.find_non_colliding_position("character", player.position, 32, 0.5) ?? player.position
    body = player.surface.create_entity({ name: "character", position: pos, force: player.force })
  }
  state.body = undefined
  if (body) player.set_controller({ type: defines.controllers.character, character: body })
}

export function makeSpectator(player: LuaPlayer, state: PlayerReview): void {
  if (player.controller_type === defines.controllers.character) toggleSpectator(player, state)
}

/** Moves the camera to `position`: a spectator or god flies there; otherwise remote view opens there. */
export function goTo(player: LuaPlayer, position: MapPosition, surface: string): void {
  const type = player.controller_type
  if (type === defines.controllers.spectator || type === defines.controllers.god) player.teleport(position, surface)
  else player.set_controller({ type: defines.controllers.remote, position, surface })
}

/** Remote view centred on the crew member's character, following it. */
export function follow(player: LuaPlayer, state: PlayerReview, crewId: number): void {
  const m = storage.crew[crewId]
  if (m === undefined || !m.character.valid) return
  player.centered_on = m.character
  state.follow = crewId
}

export function unfollow(player: LuaPlayer, state: PlayerReview): void {
  state.follow = undefined
  if (player.controller_type === defines.controllers.remote) player.exit_remote_view()
}

/** Charts the area around each faction for the players' forces, so map and remote view show it. */
export function chartFactions(): void {
  // In player order (deterministic; `pairs` over a name set is not).
  const forces: string[] = []
  for (const [, player] of game.players) if (forces.indexOf(player.force.name) < 0) forces.push(player.force.name)
  for (const name of storage.factionOrder) {
    const f = storage.factions[name]
    const points: MapPosition[] = []
    const base = f.brain?.hub ?? f.brain?.base
    if (base) points.push(base)
    for (const id of f.crew) {
      const m = storage.crew[id]
      if (m !== undefined && !m.dead && m.character.valid) points.push(m.character.position)
    }
    for (const p of points) {
      const area = { left_top: { x: p.x - 64, y: p.y - 64 }, right_bottom: { x: p.x + 64, y: p.y + 64 } }
      for (const force of forces) game.forces[force].chart(f.surface, area)
    }
  }
}
