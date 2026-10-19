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
if (!existsSync(telemetryFile)) {
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
    }
  }
  for (const goal of diagnostic.goals ?? []) {
    console.log(`Goal link ${goal.id}: plan=${goal.plan ?? "none"}, planner=${goal.plannerPhase ?? "none"}, build=${goal.buildPhase ?? "none"}, jobs=${(goal.jobs ?? []).join(",") || "none"}`)
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
