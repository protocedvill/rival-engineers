import { LuaForce } from "factorio:runtime"

// Emulated craft-item research triggers (SPEC §5.1 parity): the engine fires `craft-item` technology triggers for a
// player's hand-crafting, but not for a player-less character's (pinned by an engine-capabilities test). So, like the
// place action, the controller emulates it: items a crew member hand-crafts are counted per force, and a trigger
// technology whose prerequisites are researched completes once the count reaches the trigger's.

declare global {
  interface RivalEngineersStorage {
    /** Force name → item → items hand-crafted by its crew. */
    handCrafted?: Record<string, Record<string, number>>
  }
}

export function onHandCrafted(force: LuaForce, item: string, count: number): void {
  if (count <= 0) return
  storage.handCrafted ??= {}
  const byItem = (storage.handCrafted[force.name] ??= {})
  byItem[item] = (byItem[item] ?? 0) + count
  for (const [name, tech] of pairs(force.technologies)) {
    if (tech.researched || !tech.enabled) continue
    const trigger = tech.prototype.research_trigger as unknown as { type: string; item?: unknown; count?: number } | undefined
    if (trigger === undefined || trigger.type !== "craft-item") continue
    const target = typeof trigger.item === "string" ? trigger.item : (trigger.item as { name?: string } | undefined)?.name
    if (target !== item || byItem[item] < (trigger.count ?? 1)) continue
    let ready = true
    for (const [pre] of pairs(tech.prerequisites)) if (!force.technologies[pre as string].researched) ready = false
    if (!ready) continue
    tech.researched = true
    log(`[rival-engineers] force ${force.name}: trigger technology ${name as string} completed by the crew's hand-crafted ${item} (emulated craft-item trigger)`)
  }
}
