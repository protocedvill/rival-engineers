import { TimeCategory } from "./types"

// Short names and explanations of the time categories, shown in the inspector and the overlays.

const NAMES: Record<TimeCategory, string> = {
  walking: "walking",
  pathing: "stuck / pathing",
  mining: "mining",
  crafting: "crafting",
  placing: "placing",
  hauling: "hauling",
  waiting: "waiting for materials",
  idle: "idle",
  other: "other",
}

const HELP: Record<TimeCategory, string> = {
  walking: "Following a path to a job (standing spot, resource, machine). Walks for hauls count as hauling.",
  pathing: "Waiting for the pathfinder, re-pathing after getting stuck, or stepping out of a gap between machines.",
  mining: "Hand-mining resources, trees, rocks, or picking up a building.",
  crafting: "Hand-crafting.",
  placing: "Placing a building once in reach (includes the hand-speed delay).",
  hauling: "Logistics: haul, deposit and transfer jobs (walks included) and every insert/take.",
  waiting: "No job claimed although the board has ready jobs: none it could take (usually missing materials).",
  idle: "No job claimed and no ready job on the board (the brain waits on machines, or the faction is paused).",
  other: "Holds claims but has no running action this tick (between actions, controller budget).",
}

export function describeCategory(c: TimeCategory): string {
  return NAMES[c]
}

export function categoryHelp(c: TimeCategory): string {
  return HELP[c]
}
