import { EntitySpec, allParts, partEntities } from "../planner/build-list"
import { specKey } from "../planner/conflicts"
import { getJob } from "../jobs/board"
import { factionSurface } from "../jobs/faction"

/**
 * B158/B159 debug probe: every ghost of a faction with the plan key it matches (or none) and its place job (or none).
 * This is the cheap way to answer "are those leftover ghosts leaks?": `planned=no` is an orphan (no plan part), and
 * `job=none` is a planned ghost nothing will build (B152). Ghosts of a build still stamping are expected to be planned.
 */
export function factoryGhostDebug(name: string): string {
  const f = storage.factories?.[name]
  const faction = storage.factions?.[name]
  if (f === undefined || faction === undefined) return "no factory"
  const planned: Record<string, string> = {}
  for (const e of partEntities(f.layout, allParts(f.layout))) planned[specKey(e)] = e.owner
  const ghosts = factionSurface(faction).find_entities_filtered({ force: faction.force, type: "entity-ghost" })
  const out: string[] = [`ghosts=${ghosts.length}`]
  for (const g of ghosts) {
    const spec: EntitySpec = { name: g.ghost_name, x: g.position.x, y: g.position.y, dir: g.direction, owner: "" }
    const owner = planned[specKey(spec)]
    const jobId = g.unit_number !== undefined ? faction.ghostJobs[g.unit_number] : undefined
    const job = jobId !== undefined ? getJob(faction.board, jobId) : undefined
    out.push(
      `ghost ${g.ghost_name}@${g.position.x},${g.position.y} dir=${g.direction} type=${g.ghost_type ?? "-"} planned=${owner !== undefined ? `yes(${owner})` : "no"} job=${jobId !== undefined ? `${jobId}:${job?.status ?? "gone"}` : "none"}`,
    )
  }
  return out.join("\n")
}
