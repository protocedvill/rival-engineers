// M7d (D82 b): what a character wears, for the loadout rules in `strategy/loadout.ts`.
import { LuaEntity } from "factorio:runtime"
import { LoadoutEntry, Worn } from "../strategy/loadout"

export function wornBy(character: LuaEntity, loadout: LoadoutEntry[]): Worn {
  const worn: Worn = { grid: {}, freeCells: 0, carried: {} }
  const stack = character.get_inventory(defines.inventory.character_armor)![0]
  if (stack.valid_for_read) {
    worn.armor = stack.name
    const grid = stack.grid
    if (grid !== undefined) {
      let used = 0
      for (const eq of grid.equipment) {
        used += eq.shape.width * eq.shape.height
        const item = eq.prototype.take_result?.name ?? eq.name
        worn.grid[item] = (worn.grid[item] ?? 0) + 1
      }
      worn.freeCells = grid.width * grid.height - used
    }
  }
  const main = character.get_main_inventory()
  for (const e of loadout) if (e.carry !== undefined && main !== undefined) worn.carried![e.item] = main.get_item_count(e.item)
  return worn
}
