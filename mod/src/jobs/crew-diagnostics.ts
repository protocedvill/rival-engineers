import { recordDiagnostic } from "../diagnostic-events"
import type { CrewMember, FactionState } from "./types"

export function recordCrewPlan(
  faction: FactionState,
  member: CrewMember,
  tick: number,
  decision: "idle" | "batch",
  rejected: Record<number, string>,
  data: Record<string, unknown>,
): void {
  const counts: Record<string, number> = {}
  const samples: Record<string, number[]> = {}
  for (const [id, reason] of pairs(rejected)) {
    const key = reason as string
    counts[key] = (counts[key] ?? 0) + 1
    const list = (samples[key] ??= [])
    if (list.length < 3) list.push(id as number)
  }
  const signatureParts: string[] = []
  for (const [reason, count] of pairs(counts)) signatureParts.push(`${reason as string}:${count as number}`)
  signatureParts.sort()
  recordDiagnostic(
    faction,
    { tick, kind: "crew-plan", member: member.id, decision, counts, data: { ...data, rejectedSamples: samples } },
    // Only identical idle observations coalesce: a batch carries its own job ids, which a repeat would hide.
    decision === "idle" ? `crew-plan:${member.id}` : undefined,
    decision === "idle" ? `${decision}:${signatureParts.join(",")}` : undefined,
  )
}

export function recordCrewSupply(faction: FactionState, member: CrewMember, tick: number, data: Record<string, unknown>): void {
  recordDiagnostic(faction, { tick, kind: "crew-supply", member: member.id, decision: "haul", data })
}
