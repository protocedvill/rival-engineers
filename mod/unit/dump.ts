// T1 plan dumps (README → Development, "Debugging a failing soak seed"): a replayed plan's decisions as JSON plus a
// short text summary, from the planner's decision trace (src/planner/trace.ts). Plain Lua only (io, os).

import { newRouteLength, PlanJob } from "../src/planner/plan"
import { newTraceSink, PlanTraceSink, planTrace } from "../src/planner/trace"

declare const os: { getenv(this: void, name: string): string | undefined; execute(this: void, cmd: string): unknown }

/** REPLAY_DUMP=1: always write the dump; REPLAY_DUMP=0: no trace at all; unset: trace, write the dump on failure. */
export function dumpMode(): "always" | "off" | "on-failure" {
  const v = os.getenv("REPLAY_DUMP")
  if (v === undefined || v === "") return "on-failure"
  return v === "0" ? "off" : "always"
}

/** Turns the planner trace on for one replay (unless REPLAY_DUMP=0). */
export function startTrace(): void {
  planTrace.sink = dumpMode() === "off" ? undefined : newTraceSink()
}

export function stopTrace(): PlanTraceSink | undefined {
  const sink = planTrace.sink
  planTrace.sink = undefined
  return sink
}

/** The comparable numbers of a finished plan (one `REPLAY {json}` line per replay; `replay:sweep` tabulates them). */
export function replayMetrics(name: string, job: PlanJob, passed: boolean): Record<string, unknown> {
  const why: string[] = []
  for (const [k, v] of pairs(job.failures)) why.push(`${k as string}: ${v as string}`)
  why.sort()
  return {
    name,
    passed,
    phase: job.phase,
    work: math.floor(job.stats.work),
    placeWork: math.floor(job.stats.placeWork),
    routeWork: math.floor(job.stats.routeWork),
    compareWork: math.floor(job.stats.compareWork ?? 0),
    candidates: job.stats.candidates,
    searches: job.stats.searches,
    ripups: job.stats.ripups,
    replacements: job.stats.replacements,
    routeTiles: newRouteLength(job.layout, job.baseRoutes),
    failures: why.join("; "),
  }
}

// ---------------------------------------------------------------------------------------------------------
// JSON (sorted keys; an empty table is written as []).

function jsonString(s: string): string {
  const [e] = string.gsub(s, '[%c"\\]', (c: string) => {
    if (c === '"') return '\\"'
    if (c === "\\") return "\\\\"
    if (c === "\n") return "\\n"
    if (c === "\t") return "\\t"
    return string.format("\\u%04x", string.byte(c))
  })
  return `"${e}"`
}

function isArray(t: Record<string | number, unknown>): boolean {
  let n = 0
  for (const [k] of pairs(t)) if (k !== undefined) n++
  return n === (t as unknown as unknown[]).length
}

export function toJson(v: unknown, indent = ""): string {
  const t = type(v)
  if (t === "nil") return "null"
  if (t === "boolean") return v ? "true" : "false"
  if (t === "number") {
    const n = v as number
    if (n !== n || n === math.huge || n === -math.huge) return "null"
    return math.floor(n) === n && math.abs(n) < 1e15 ? string.format("%d", n) : string.format("%.10g", n)
  }
  if (t === "string") return jsonString(v as string)
  if (t !== "table") return jsonString(tostring(v))
  const tab = v as Record<string | number, unknown>
  const inner = indent + "  "
  if (isArray(tab)) {
    const a = tab as unknown as unknown[]
    if (a.length === 0) return "[]"
    // Short arrays of scalars on one line.
    let flat = true
    for (const x of a) if (type(x) === "table") flat = false
    if (flat) return `[${a.map((x) => toJson(x)).join(", ")}]`
    return `[\n${a.map((x) => inner + toJson(x, inner)).join(",\n")}\n${indent}]`
  }
  const entries: { k: string; v: unknown }[] = []
  for (const [k, val] of pairs(tab)) entries.push({ k: tostring(k), v: val })
  entries.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
  const parts = entries.map((e) => `${inner}${jsonString(e.k)}: ${toJson(e.v, inner)}`)
  return `{\n${parts.join(",\n")}\n${indent}}`
}

// ---------------------------------------------------------------------------------------------------------

function fmt(n: number): string {
  return string.format("%g", math.floor(n * 100 + 0.5) / 100)
}

/** The short text summary: outcome, failures, every placement with its score terms, route failures, events. */
export function summary(name: string, job: PlanJob, sink: PlanTraceSink | undefined): string {
  const m = replayMetrics(name, job, true)
  const L: string[] = []
  L.push(`${name}: ${job.phase}; work ${m.work} (placement ${m.placeWork}, routing ${m.routeWork}, comparison ${m.compareWork}); ${m.searches} searches, ${m.ripups} rip-ups, ${m.replacements} replacements; ${m.routeTiles} route tiles`)
  if (m.failures !== "") L.push(`failures: ${m.failures}`)
  L.push("", "modules (new):")
  for (const pm of job.layout.modules) {
    if (job.baseModules[pm.id]) continue
    L.push(`  ${pm.id} ${pm.canonical.id} r${pm.transform.rot}${pm.transform.mirror ? "m" : ""} at ${pm.rect.x},${pm.rect.y} ${pm.rect.w}x${pm.rect.h}`)
  }
  for (const [rid, e] of pairs(job.expanded)) L.push(`  ${rid as string} → ${e.module} (+${e.units})`)
  if (job.layout.soft !== undefined) {
    const owners: Record<string, number> = {}
    for (const [, o] of pairs(job.layout.soft)) owners[o as string] = (owners[o as string] ?? 0) + 1
    const parts: string[] = []
    for (const [o, n] of pairs(owners)) parts.push(`${o as string} ${n as number}`)
    parts.sort()
    if (parts.length > 0) L.push(`soft claims (tiles): ${parts.join(", ")}`)
  }
  if (sink === undefined) {
    L.push("", "(no decision trace: REPLAY_DUMP=0)")
    return L.join("\n") + "\n"
  }
  L.push("", "placements (in order; score terms: lower is better):")
  for (const p of sink.placements) {
    L.push(`  ${p.module} (${p.def}): ${p.phase}${p.reason !== undefined ? ` (${p.reason})` : ""}; radius ${p.radius ?? "?"} around ${p.target !== undefined ? `${p.target.x},${p.target.y}` : "?"}, centre ${p.center.x},${p.center.y}; ${p.candidates} candidates, ${p.feasible} feasible`)
    const show = (label: string, c: (typeof p.top)[number]): void => {
      const terms: string[] = []
      for (const k of ["center", "port", "facing", "clear", "adjacent", "exactGap", "coverage", "growthCoverage", "softClaim"]) {
        const v = c.terms[k] ?? 0
        if (v !== 0) terms.push(`${k} ${fmt(v)}`)
      }
      L.push(`    ${label} ${c.transform} at ${c.origin.x},${c.origin.y}: score ${fmt(c.score)} = ${terms.length > 0 ? terms.join(" + ") : "0"}`)
    }
    if (p.chosen !== undefined) show("chosen  ", p.chosen)
    let shown = 0
    for (const c of p.top) {
      if (shown >= 3) break
      if (p.chosen !== undefined && c.transform === p.chosen.transform && c.origin.x === p.chosen.origin.x && c.origin.y === p.chosen.origin.y) continue
      show("runner-up", c)
      shown++
    }
    const reasons: { why: string; count: number; example?: string }[] = []
    for (const [why, r] of pairs(p.rejected)) reasons.push({ why: why as string, count: r.count, example: r.examples[0]?.blocker })
    reasons.sort((a, b) => b.count - a.count)
    for (const r of reasons) L.push(`    rejected ${r.why}: ${r.count}${r.example !== undefined ? ` (nearest: ${r.example})` : ""}`)
  }
  if (sink.routeFailures.length > 0) {
    L.push("", "route failures:")
    for (const f of sink.routeFailures) {
      L.push(`  ${f.conn} [${f.branch}]: ${f.reason}${f.window !== undefined ? `; ${f.rip ? "rip pass, " : ""}window ${f.window.x},${f.window.y} ${f.window.w}x${f.window.h}, ${f.expansions} expansions, ${f.explored} tiles reached` : ""}`)
      if (f.start !== undefined || f.goal !== undefined) L.push(`    start ${f.start ?? "(taps)"} → goal ${f.goal ?? "?"}`)
      for (const w of f.walls ?? []) L.push(`    walled by ${w.blocker}: ${w.tiles} tiles (e.g. ${w.example})`)
      for (const a of f.around ?? []) L.push(`    ${a}`)
    }
  }
  if (sink.events.length > 0) {
    L.push("", "events:")
    for (const e of sink.events) L.push(`  ${e}`)
  }
  return L.join("\n") + "\n"
}

function writeFile(path: string, text: string): void {
  const [f, err] = io.open(path, "w")
  if (f === undefined) error(`cannot write ${path}: ${err}`)
  f.write(text)
  f.close()
}

/** The dump directory root: $REPLAY_DUMP_DIR, else <repo>/out/replay-dumps ($UNIT_ROOT is set by the T1 runner). */
function dumpRoot(): string {
  return os.getenv("REPLAY_DUMP_DIR") ?? `${os.getenv("UNIT_ROOT") ?? "../.."}/out/replay-dumps`
}

/** Writes <root>/<name>/plan.json and summary.txt; returns the directory. */
export function writeDump(name: string, job: PlanJob, sink: PlanTraceSink | undefined, passed: boolean): string {
  const dir = `${dumpRoot()}/${name}`
  os.execute(`mkdir -p '${dir}'`)
  const modules: unknown[] = []
  for (const pm of job.layout.modules) {
    modules.push({ id: pm.id, def: pm.canonical.id, transform: `r${pm.transform.rot}${pm.transform.mirror ? "m" : ""}`, rect: pm.rect, base: job.baseModules[pm.id] === true })
  }
  const data = {
    replay: replayMetrics(name, job, passed),
    failures: job.failures,
    alias: job.alias,
    expanded: job.expanded,
    wholeFail: job.wholeFail,
    modules,
    compare: job.compare?.results,
    placements: sink?.placements,
    routeFailures: sink?.routeFailures,
    events: sink?.events,
  }
  writeFile(`${dir}/plan.json`, toJson(data) + "\n")
  writeFile(`${dir}/summary.txt`, summary(name, job, sink))
  return dir
}

/**
 * The end of a replay: prints its metrics line, writes the dump when it failed (or REPLAY_DUMP=1). Call before the
 * assertions, with whether they will pass.
 */
export function finishReplay(name: string, job: PlanJob, passed: boolean): void {
  const sink = stopTrace()
  print(`REPLAY ${string.gsub(toJson(replayMetrics(name, job, passed)), "\n%s*", " ")[0]}`)
  const mode = dumpMode()
  if (mode === "always" || (!passed && mode !== "off")) print(`  dump: ${writeDump(name, job, sink, passed)}/summary.txt`)
}
