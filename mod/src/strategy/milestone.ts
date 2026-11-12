// A faction milestone (first power, automated science, stages...): recorded once with its tick (split out of
// `factory.ts`, M7a: shared by the factory and lab feeding without a require cycle).

import { FactionState } from "../jobs/types"

export function mark(faction: FactionState, name: string): void {
  const brain = faction.brain
  if (brain === undefined || brain.milestones[name] !== undefined) return
  brain.milestones[name] = game.tick
  log(`[rival-engineers] faction ${faction.name}: milestone ${name} at tick ${game.tick}`)
}
