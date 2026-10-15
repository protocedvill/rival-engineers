// Stamping a module into the world: as real entities (validation lab, tests) or as ghosts (planner → Job Board).
// `def` must already be transformed (geometry.ts transformModule); `origin` is the world tile of its top-left corner.

import { LuaEntity, LuaForce, LuaSurface, MapPosition, SurfaceCreateEntity } from "factorio:runtime"
import { ModuleDef, ModuleEntity, Port } from "./types"

export interface StampOptions {
  ghost?: boolean
  /** Raise script_raised_built for created entities. */
  raiseBuilt?: boolean
}

export function worldPos(origin: MapPosition, p: { x: number; y: number }): MapPosition {
  return { x: origin.x + p.x, y: origin.y + p.y }
}

function createParams(e: ModuleEntity, origin: MapPosition, force: LuaForce | string, ghost: boolean): SurfaceCreateEntity {
  const params: Record<string, unknown> = {
    name: ghost ? "entity-ghost" : e.name,
    position: worldPos(origin, e),
    direction: e.dir ?? defines.direction.north,
    force,
  }
  if (ghost) params.inner_name = e.name
  const type = prototypes.entity[e.name]?.type
  if (e.recipe !== undefined && type === "assembling-machine") params.recipe = e.recipe
  if (e.ioType !== undefined) params.type = e.ioType
  return params as unknown as SurfaceCreateEntity
}

/** Creates every entity of `def`; returns them in `def.entities` order (undefined where creation failed). */
export function stampModule(surface: LuaSurface, force: LuaForce | string, def: ModuleDef, origin: MapPosition, opts: StampOptions = {}): (LuaEntity | undefined)[] {
  // Indexed like def.entities, with holes where creation failed (push(undefined) is a no-op in Lua and would shift
  // every later entity onto the wrong spec). Iterate it with def.entities.length, not out.length.
  const out: (LuaEntity | undefined)[] = []
  for (let i = 0; i < def.entities.length; i++) {
    const params = createParams(def.entities[i], origin, force, opts.ghost === true)
    if (opts.raiseBuilt) (params as unknown as Record<string, unknown>).raise_built = true
    out[i] = surface.create_entity(params)
  }
  return out
}

/** World position of a port's tile. */
export function portWorld(origin: MapPosition, port: Port): MapPosition {
  return worldPos(origin, port.pos)
}
