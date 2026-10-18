import { LuaForce, LuaTechnologyPrototype } from "factorio:runtime"
import { computeResearchGoal } from "./research"

// Research queue (SPEC §5.5): technologies that unblock the factory's goals first (and the prerequisites they need),
// then the rest of the research goal (D30), cheapest first. Only technologies whose packs the faction can supply now
// (hand-fed or automated) are queued; trigger technologies complete on their own. Everything is read from prototypes.

let goalCache: string[] | undefined

/** The research goal (D30), computed once per session from prototypes and config. */
export function researchGoal(): string[] {
  goalCache ??= computeResearchGoal()
  return goalCache
}

/** Units × seconds per unit × pack kinds: a crude cost to order technologies by. */
export function techCost(t: LuaTechnologyPrototype): number {
  return t.research_unit_count * (t.research_unit_energy / 60) * math.max(1, t.research_unit_ingredients.length)
}

/** Mean seconds per research unit over the research goal's pack technologies (sizes the labs). */
export function meanUnitTime(): number {
  let sum = 0
  let n = 0
  for (const name of researchGoal()) {
    const t = prototypes.technology[name]
    if (t.research_trigger !== undefined || t.research_unit_ingredients.length === 0) continue
    sum += t.research_unit_energy / 60
    n++
  }
  return n > 0 ? sum / n : 30
}

/** Researchable now: not researched, not a trigger technology, prerequisites done, every pack available. */
export function researchable(force: LuaForce, name: string, packs: Record<string, boolean>): boolean {
  const tech = force.technologies[name]
  if (tech === undefined || tech.researched || !tech.enabled) return false
  const proto = prototypes.technology[name]
  if (proto.research_trigger !== undefined) return false
  for (const ing of proto.research_unit_ingredients) if (!packs[ing.name]) return false
  for (const [pre] of pairs(proto.prerequisites ?? {})) if (!force.technologies[pre as string].researched) return false
  return true
}

/** The unresearched technologies `name` needs (itself included), prerequisites first. */
function closure(force: LuaForce, name: string, out: string[], seen: Record<string, boolean>): void {
  if (seen[name]) return
  seen[name] = true
  const tech = force.technologies[name]
  if (tech === undefined || tech.researched) return
  const pres: string[] = []
  for (const [pre] of pairs(prototypes.technology[name].prerequisites ?? {})) pres.push(pre as string)
  pres.sort()
  for (const pre of pres) closure(force, pre, out, seen)
  out.push(name)
}

function cheapest(names: string[]): string | undefined {
  let best: string | undefined
  let bestCost = math.huge
  for (const n of names) {
    const c = techCost(prototypes.technology[n])
    if (c < bestCost || (c === bestCost && best !== undefined && n < best)) {
      best = n
      bestCost = c
    }
  }
  return best
}

export interface ResearchPick {
  tech: string
  reason: string
}

/**
 * The next technology to research: unblocking `wanted` first (with `packs`, hand-fed ones included), then the research
 * goal (with `goalPacks`: automated packs only, so the crew don't hand-craft packs for research nothing waits on).
 */
export function pickResearch(force: LuaForce, wanted: string[], packs: Record<string, boolean>, goalPacks: Record<string, boolean> = packs): ResearchPick | undefined {
  const sorted = [...wanted].sort()
  for (const w of sorted) {
    const need: string[] = []
    closure(force, w, need, {})
    const ready = need.filter((n) => researchable(force, n, packs))
    const pick = cheapest(ready)
    if (pick !== undefined) return { tech: pick, reason: `unblocks ${w}` }
  }
  const ready = researchGoal().filter((n) => researchable(force, n, goalPacks))
  const pick = cheapest(ready)
  return pick !== undefined ? { tech: pick, reason: "research goal" } : undefined
}

/** Starts the picked research if the force has none running. Returns what was started. */
export function startResearch(force: LuaForce, wanted: string[], packs: Record<string, boolean>, goalPacks: Record<string, boolean> = packs): ResearchPick | undefined {
  if (force.current_research !== undefined) return undefined
  const pick = pickResearch(force, wanted, packs, goalPacks)
  if (pick === undefined) return undefined
  return force.add_research(pick.tech) ? pick : undefined
}
