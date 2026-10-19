#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const [runArg, seedArg, factionArg] = process.argv.slice(2)
if (!runArg) {
  console.error("usage: npm run diagnose -- <run-name-or-path> [seed] [faction]")
  process.exit(2)
}

const runDir = isAbsolute(runArg) || runArg.includes("/") ? resolve(runArg) : join(root, "out", "soak", runArg)
const manifestFile = join(runDir, "run.json")
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : undefined
const seed = seedArg ?? Object.keys(manifest?.seeds ?? {})[0]
if (!seed) {
  console.error(`no seed supplied and ${manifestFile} has no seeds`)
  process.exit(2)
}
const telemetryFile = join(runDir, `seed-${seed}`, "telemetry.json")
const failureFile = join(runDir, `seed-${seed}`, "failure.json")
const failure = existsSync(failureFile) ? JSON.parse(readFileSync(failureFile, "utf8")) : undefined
if (!existsSync(telemetryFile)) {
  if (failure) {
    console.error(`fatal artifact: ${failureFile}`)
    console.error(`${failure.reason}; return=${failure.returnCode ?? "unknown"}; last tick=${failure.lastTick ?? "unknown"}`)
    for (const line of failure.logs?.["factorio-stdout.log"]?.slice(-20) ?? []) console.error(`  ${line}`)
  }
  console.error(`telemetry not found: ${telemetryFile}`)
  process.exit(1)
}
const telemetry = JSON.parse(readFileSync(telemetryFile, "utf8"))
const factions = telemetry.factions ?? {}
const faction = factionArg ?? Object.keys(factions)[0]
const data = factions[faction]
if (!data) {
  console.error(`faction ${faction ?? "<none>"} not found; available: ${Object.keys(factions).join(", ") || "none"}`)
  process.exit(1)
}

console.log(`Run: ${runDir}`)
if (manifest) {
  console.log(`Code: ${manifest.repo?.commit?.slice(0, 12) ?? "unknown"}${manifest.repo?.dirty ? " (dirty)" : ""}`)
  console.log(`Run status: ${manifest.status}; seed ${seed}: ${manifest.seeds?.[seed]?.status ?? "unknown"}`)
} else console.log("Run manifest: missing (legacy run; code/config provenance unknown)")
console.log(`Telemetry tick: ${telemetry.tick}; faction: ${faction}`)
if (failure) console.log(`Fatal artifact: ${failureFile} (${failure.reason}; return ${failure.returnCode ?? "unknown"})`)

const factory = data.factory
if (factory) {
  console.log(`\nFactory stage ${factory.stage}${factory.idle ? " (idle)" : ""}`)
  for (const waiting of factory.waiting ?? []) console.log(`  waits: ${waiting}`)
  for (const goal of factory.goals ?? []) {
    if (["done", "failed", "deferred"].includes(goal.status)) continue
    console.log(`  ${goal.id} ${goal.kind}: ${goal.status}; attempt ${goal.attempts}, placed ${goal.placed}, rounds ${goal.rounds}${goal.reason ? `; ${goal.reason}` : ""}`)
  }
}

const diagnostic = data.diagnostics
if (diagnostic) {
  console.log(`\nInvariants: ${diagnostic.invariants?.length ? `${diagnostic.invariants.length} violation(s)` : "OK"}`)
  for (const item of diagnostic.invariants ?? []) console.log(`  ${item.code}: ${item.detail}`)
  console.log("Blocked/ready jobs:")
  for (const job of diagnostic.jobs ?? []) {
    const relation = job.relatedJob !== undefined ? ` → job ${job.relatedJob}` : ""
    console.log(`  #${job.id} ${job.kind}: ${job.blocker}${relation}${job.detail ? ` (${job.detail})` : ""}`)
    for (const material of job.materials ?? []) {
      const supply = material.takeable === undefined ? "supply not sampled" : `${material.takeable}/${material.raw} takeable/raw in ${material.sources} source(s)`
      console.log(`      ${material.item}: needs ${material.needed}; ${supply}`)
      for (const source of material.sourceDetail ?? []) console.log(`        unit ${source.unit}${source.depot ? " depot" : ""}: raw=${source.raw}, reserved=${source.reserved}, takeable=${source.takeable}${source.excluded ? ` (${source.excluded})` : ""}`)
    }
  }
  for (const goal of diagnostic.goals ?? []) {
    console.log(`Goal link ${goal.id}: plan=${goal.plan ?? "none"}, planner=${goal.plannerPhase ?? "none"}, build=${goal.buildPhase ?? "none"}, jobs=${(goal.jobs ?? []).join(",") || "none"}`)
    for (const [subject, reason] of Object.entries(goal.failures ?? {})) console.log(`    failure ${subject}: ${reason}`)
    for (const evidence of goal.evidence ?? []) {
      if (evidence.kind === "placement") {
        const rejected = Object.entries(evidence.rejections ?? {}).sort((a, b) => b[1].count - a[1].count).map(([why, item]) => `${why}=${item.count}@${item.sample.x},${item.sample.y}`).join(", ")
        console.log(`    placement ${evidence.subject}: ${evidence.reason}; ${evidence.candidates} candidates; ${rejected || "no candidate samples"}`)
      } else console.log(`    route ${evidence.subject}: ${evidence.reason}; rip=${evidence.rip}, window=${evidence.windowScale}, expansions=${evidence.expansions}`)
    }
  }
  console.log(`Churn: ${diagnostic.churn?.length ? `${diagnostic.churn.length} warning(s)` : "none"}`)
  for (const finding of diagnostic.churn ?? []) console.log(`  ${finding.code}: ${finding.detail}`)
  console.log("Recent decision events:")
  for (const [kind, events] of Object.entries(diagnostic.events ?? {})) {
    console.log(`  ${kind}:`)
    for (const event of events.slice(-8)) console.log(`    tick ${event.tick}${event.lastTick ? `–${event.lastTick}` : ""}${event.repeats ? ` ×${event.repeats}` : ""}: ${event.decision}${event.reason ? ` (${event.reason})` : ""} ${JSON.stringify(event.data ?? event.counts ?? {})}`)
  }
} else {
  console.log("\nStructured diagnostics are absent (legacy telemetry). Open-job sample:")
  for (const job of data.openJobs ?? []) console.log(`  #${job.id} ${job.kind}: ${job.reason ?? "open"}; deps/materials require in-game inspection`)
}

console.log(`\nCrew: ${(data.crew ?? []).length}; active job counts: ${JSON.stringify(data.activeJobs ?? {})}`)
for (const crew of data.crew ?? []) {
  const last = crew.lastAction ? `${crew.lastAction.kind}/${crew.lastAction.status}${crew.lastAction.reason ? `: ${crew.lastAction.reason}` : ""}` : "none"
  console.log(`  #${crew.id}${crew.dead ? " dead" : ""}: last=${last}`)
}
