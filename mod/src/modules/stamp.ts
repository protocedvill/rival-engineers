// Stamping a module into the world: as real entities (validation lab, tests) or as ghosts (planner → Job Board).
// `def` must already be transformed (geometry.ts transformModule); `origin` is the world tile of its top-left corner.

import { LuaEntity, LuaForce, LuaSurface, MapPosition, SurfaceCreateEntity } from "factorio:runtime"
import { limitBuffer } from "./buffers"
import { ModuleDef, ModuleEntity, Port } from "./types"

export interface StampOptions {
  ghost?: boolean
  /** Raise script_raised_built for created entities. */
  raiseBuilt?: boolean
  /** D42: usable slots of buffer chests stamped as real entities (default 0: every slot barred, as D33 validation wants). */
  bufferSlots?: number
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
    // B142: a retried build re-stamps the same plan. A ghost that already stands is the wanted result, not a failed
    // creation; creating a second ghost on its tile returns nil and made every retry look like thousands of failures.
    if (opts.ghost === true) {
      const existing = surface.find_entities_filtered({ name: "entity-ghost", ghost_name: def.entities[i].name, position: worldPos(origin, def.entities[i]), force, limit: 1 })[0]
      if (existing !== undefined) {
        out[i] = existing
        continue
      }
    }
    const params = createParams(def.entities[i], origin, force, opts.ghost === true)
    if (opts.raiseBuilt) (params as unknown as Record<string, unknown>).raise_built = true
    out[i] = surface.create_entity(params)
    const made = out[i]
    if (made !== undefined && def.entities[i].buffer && opts.ghost !== true) limitBuffer(made, opts.bufferSlots ?? 0)
  }
  return out
}

/** World position of a port's tile. */
export function portWorld(origin: MapPosition, port: Port): MapPosition {
  return worldPos(origin, port.pos)
}
