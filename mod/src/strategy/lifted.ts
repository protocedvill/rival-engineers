import { LuaEntity, MapPosition } from "factorio:runtime"
import { getJob } from "../jobs/board"
import type { FactionState } from "../jobs/types"
import { destroyEntity } from "../planner/terrain"

/**
 * M7c.9: a ghost taken off the ground while the tree or rock it covers is cleared. A ghost's selection wins over the
 * tree's, and the crew refuse to mine a selected ghost (a player's mining would cancel it), so a tree inside a 3×3
 * ghost can never be mined (seed 11: a pumpjack ghost over tree-08-brown, 10 build rounds). A player cancels the
 * ghost, mines the tree and places the ghost again; `FactoryGoal.lifted` does the same.
 */
export interface LiftedGhost {
  name: string
  position: MapPosition
  direction: defines.direction
  surface: string
  recipe?: string
  beltType?: "input" | "output"
  /** The clear job the ghost waits for. */
  clear: number
}

/** Records `gh` (what re-creating it needs) and removes it. */
export function liftGhost(gh: LuaEntity, clear: number): LiftedGhost {
  const l: LiftedGhost = { name: gh.ghost_name, position: { x: gh.position.x, y: gh.position.y }, direction: gh.direction, surface: gh.surface.name, clear }
  if (gh.ghost_type === "assembling-machine") l.recipe = gh.get_recipe()[0]?.name
  if (gh.ghost_type === "underground-belt") l.beltType = gh.belt_to_ground_type
  destroyEntity(gh)
  return l
}

/** Puts a lifted ghost back; undefined if it can't be created. */
export function restoreGhost(l: LiftedGhost, force: string): LuaEntity | undefined {
  const surface = game.surfaces[l.surface]
  if (surface === undefined) return undefined
  return surface.create_entity({ name: "entity-ghost", inner_name: l.name, position: l.position, direction: l.direction, force, recipe: l.recipe, type: l.beltType })
}

/**
 * Puts `owner`'s lifted ghosts back once their clear jobs have ended, into `ghosts` (the build's, so its next round
 * re-places them). Returns whether one still waits: the build is not done while it does.
 */
export function restoreLifted(owner: { id: string; lifted?: LiftedGhost[] }, faction: FactionState, ghosts: LuaEntity[]): boolean {
  if (owner.lifted === undefined) return false
  const keep: LiftedGhost[] = []
  for (const l of owner.lifted) {
    const j = getJob(faction.board, l.clear as never)
    if (j !== undefined && j.status !== "done" && j.status !== "failed") {
      keep.push(l)
      continue
    }
    const gh = restoreGhost(l, faction.force)
    if (gh !== undefined) ghosts.push(gh)
    else log(`[rival-engineers] faction ${faction.name}: goal ${owner.id}: could not put the ${l.name} ghost back at ${l.position.x},${l.position.y}`)
  }
  owner.lifted = keep.length > 0 ? keep : undefined
  return keep.length > 0
}
