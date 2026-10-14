import { LuaTechnologyPrototype } from "factorio:runtime"
import { getConfig } from "../config"

// The v1 research goal (SPEC §3.2, D30): every technology reachable with only the configured science packs
// (red + green), without producing anything on the excluded list (steel, crude oil). Computed from prototypes
// at runtime, never hardcoded, so it follows mods and future Factorio versions.
//
// A technology is in the set when all of these hold:
//   1. it is not hidden;
//   2. it is researched with packs: every unit ingredient is one of the allowed packs; or it is a trigger
//      technology whose trigger needs nothing excluded (craft-item / build-entity / mine-entity / craft-fluid
//      on a non-excluded name). Other trigger kinds (orbit, space platform, spawner capture, scripted) are out;
//   3. every prerequisite is in the set (so anything behind an excluded technology is out too).

const PLAIN_TRIGGERS: Record<string, boolean> = { "craft-item": true, "build-entity": true, "mine-entity": true, "craft-fluid": true }

export function splitList(value: string): string[] {
  const out: string[] = []
  for (const [part] of string.gmatch(value, "[^,%s]+")) out.push(part)
  return out
}

function triggerTarget(tech: LuaTechnologyPrototype): string | undefined {
  const trigger = tech.research_trigger as unknown as { type: string; item?: unknown; entity?: unknown; fluid?: string }
  const ref = trigger.item ?? trigger.entity ?? trigger.fluid
  if (ref === undefined) return undefined
  if (typeof ref === "string") return ref
  return (ref as { name?: string }).name
}

function ownCondition(tech: LuaTechnologyPrototype, packs: Record<string, boolean>, excluded: Record<string, boolean>): boolean {
  if (tech.hidden) return false
  if (tech.research_trigger !== undefined) {
    if (!PLAIN_TRIGGERS[tech.research_trigger.type]) return false
    const target = triggerTarget(tech)
    return target === undefined || !excluded[target]
  }
  const ingredients = tech.research_unit_ingredients
  if (ingredients.length === 0) return false
  for (const ingredient of ingredients) if (!packs[ingredient.name]) return false
  return true
}

/** Names of the technologies in the research goal, sorted. */
export function computeResearchGoal(packList?: string[], excludedList?: string[]): string[] {
  const config = getConfig()
  const packs: Record<string, boolean> = {}
  for (const p of packList ?? splitList(config.researchSciencePacks)) packs[p] = true
  const excluded: Record<string, boolean> = {}
  for (const e of excludedList ?? splitList(config.researchExcludedTriggers)) excluded[e] = true

  const memo: Record<string, boolean> = {}
  const visiting: Record<string, boolean> = {}
  const inSet = (name: string): boolean => {
    const known = memo[name]
    if (known !== undefined) return known
    if (visiting[name]) return false // a cycle: treat as unreachable
    visiting[name] = true
    const tech = prototypes.technology[name]
    let ok = tech !== undefined && ownCondition(tech, packs, excluded)
    if (ok) {
      for (const [pre] of pairs(tech.prerequisites ?? {})) {
        if (!inSet(pre as string)) {
          ok = false
          break
        }
      }
    }
    visiting[name] = false
    memo[name] = ok
    return ok
  }
  const names: string[] = []
  for (const [name] of pairs(prototypes.technology)) if (inSet(name as string)) names.push(name as string)
  names.sort()
  return names
}
