// Module entity → world entity spec. Pure.

import { ModuleEntity } from "../modules/types"
import { Vec } from "./grid"

export function worldEntity(e: ModuleEntity, origin: Vec, owner: string): { name: string; x: number; y: number; dir: number; recipe?: string; ioType?: "input" | "output"; owner: string } {
  return { name: e.name, x: origin.x + e.x, y: origin.y + e.y, dir: e.dir ?? 0, recipe: e.recipe, ioType: e.ioType, owner }
}
