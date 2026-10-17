// Parallel T2 runner: splits the in-game suite into shards and runs one `factorio-test run` per shard, each with its
// own Factorio write-data directory (.factorio-test/shards/<n>), then merges the results.
//
//   node tools/test-parallel.mjs [-j N] [--no-build] [--plan] [--save-timings] [-- "lua pattern" ...]
//
// Units: a test file (`test/<name>_test > ...`) runs as one unit unless tools/test-shards.json splits it (per test,
// or into groups of tests that share state). Units are packed into N shards by historical duration
// (out/test-timings.json, seeded from tools/test-timings.json). Every shard lists the whole suite (tests outside its
// patterns as skipped), so tests no shard selected (new tests in a split file) run in a second pass: nothing is lost.
// Filters are Lua patterns (as with factorio-test) and are matched here against known test paths.
import { spawn, execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { luaEscape, luaPatternToRegExp } from "./lua-pattern.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cli = join(root, "node_modules", ".bin", "factorio-test")
const shardsDir = join(root, ".factorio-test", "shards")
const outDir = join(root, "out")
const shardOutDir = join(outDir, "shards")
const timingsFile = join(outDir, "test-timings.json")
const seedTimingsFile = join(root, "tools", "test-timings.json")
const shardConfig = JSON.parse(readFileSync(join(root, "tools", "test-shards.json"), "utf8"))
const UNKNOWN_TEST_MS = 10_000 // a test with no recorded duration
const SHARD_OVERHEAD_MS = 6_000 // Factorio start-up and mod loading per shard

// ---- arguments ----
const argv = process.argv.slice(2)
let jobs = process.env.TEST_JOBS ? Number(process.env.TEST_JOBS) : undefined
let build = true
let planOnly = false
let saveTimings = false
const filters = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "-j" || a === "--jobs") jobs = Number(argv[++i])
  else if (a.startsWith("--jobs=")) jobs = Number(a.slice(7))
  else if (a === "--no-build") build = false
  else if (a === "--plan") planOnly = true
  else if (a === "--save-timings") saveTimings = true
  else if (a === "--") continue
  else if (a === "-h" || a === "--help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"))
    process.exit(0)
  } else if (a.startsWith("-")) {
    console.error(`unknown option ${a}`)
    process.exit(2)
  } else filters.push(a)
}
if (jobs !== undefined && !(Number.isInteger(jobs) && jobs >= 1)) {
  console.error("--jobs / TEST_JOBS must be a positive integer")
  process.exit(2)
}

let filterRes
try {
  filterRes = filters.map(luaPatternToRegExp)
} catch (e) {
  filterRes = undefined // can't evaluate the filter here: one shard runs it as given
  console.log(`(filter not understood by the shard planner: ${e.message}; running it in one shard)`)
}
const selectedByFilter = (path) => filters.length === 0 || filterRes.some((re) => re.test(path))

// ---- history ----
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
/** path -> duration in ms (null: seen, never timed). */
const history = readJson(timingsFile) ?? readJson(seedTimingsFile) ?? {}

/** Test files registered in control.ts (`init([...])`), for when the history doesn't know them yet. */
function registeredFiles() {
  const src = readFileSync(join(root, "mod", "src", "control.ts"), "utf8")
  const m = src.match(/init\(\[([^\]]*)\]/)
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
}
const fileOf = (path) => path.split(" > ")[0]

/** Units of work from known test paths. Each unit: { name, patterns, ms, paths }. */
function buildUnits(paths, { wholeFiles }) {
  const byFile = new Map()
  for (const p of paths) {
    const f = fileOf(p)
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(p)
  }
  const units = []
  const ms = (p) => history[p] ?? UNKNOWN_TEST_MS
  for (const [file, tests] of byFile) {
    const split = shardConfig.split?.[file]
    if (split === undefined) {
      // The file's tests stay together (they may share state). Whole file: also picks up tests added since.
      const patterns = wholeFiles ? [`^${luaEscape(file)} > `] : tests.map((p) => `^${luaEscape(p)}$`)
      units.push({ name: file, patterns, ms: tests.reduce((s, p) => s + ms(p), 0), paths: tests })
      continue
    }
    const groups = Array.isArray(split) ? split.map((g) => ({ g, re: luaPatternToRegExp(g), paths: [] })) : []
    for (const p of tests) {
      const group = groups.find((x) => x.re.test(p))
      if (group) group.paths.push(p)
      else units.push({ name: `${file}: ${p.split(" > ").pop().slice(0, 50)}`, patterns: [`^${luaEscape(p)}$`], ms: ms(p), paths: [p] })
    }
    for (const { g, paths: ps } of groups) {
      if (ps.length > 0) units.push({ name: `${file} [${g}]`, patterns: ps.map((p) => `^${luaEscape(p)}$`), ms: ps.reduce((s, p) => s + ms(p), 0), paths: ps })
    }
  }
  return units
}

/** Longest-processing-time-first packing into at most n shards. */
function pack(units, n) {
  const shards = Array.from({ length: Math.min(n, units.length) }, () => ({ units: [], ms: SHARD_OVERHEAD_MS }))
  for (const u of [...units].sort((a, b) => b.ms - a.ms)) {
    const s = shards.reduce((best, x) => (x.ms < best.ms ? x : best))
    s.units.push(u)
    s.ms += u.ms
  }
  return shards.filter((s) => s.units.length > 0).map((s) => ({ ...s, patterns: s.units.flatMap((u) => u.patterns) }))
}

// ---- shard execution ----
function prepareDataDir(dir) {
  const mods = join(dir, "mods")
  mkdirSync(mods, { recursive: true })
  for (const zip of readdirSync(join(root, "ci", "mods")).filter((f) => f.endsWith(".zip"))) {
    const src = join(root, "ci", "mods", zip)
    const dst = join(mods, zip)
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst)
  }
}

const shortPath = (p) => relative(process.cwd(), p) || "."

const SHARD_OUTPUT_TIMEOUT_S = 900

function runShard(shard, id) {
  const dataDir = join(shardsDir, String(id))
  prepareDataDir(dataDir)
  const resultsFile = join(shardOutDir, `shard-${id}.json`)
  const logFile = join(shardOutDir, `shard-${id}.log`)
  rmSync(resultsFile, { force: true })
  // A shard runs next to the others, so a long on_tick test without a heartbeat (module validation waits 15-23
  // game-min for steady state) can be silent far longer than factorio-test.json's 180 s alone allows.
  const args = ["run", "-d", dataDir, "--output-file", resultsFile, "--output-timeout", String(SHARD_OUTPUT_TIMEOUT_S), "--no-frozen-lockfile", "--no-reorder-failed-first", "--", ...shard.patterns]
  const started = Date.now()
  return new Promise((resolve) => {
    const log = []
    const shown = new Set() // the CLI prints a failure live and again in its summary
    const proc = spawn(cli, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let partial = ""
    const onData = (buf) => {
      const text = buf.toString()
      log.push(text)
      partial += text
      const lines = partial.split("\n")
      partial = lines.pop()
      for (const line of lines) {
        if (!/^(FAIL|ERROR)\b/.test(line) || shown.has(line)) continue
        shown.add(line)
        console.log(`  [shard ${id}] ${line}`)
      }
    }
    proc.stdout.on("data", onData)
    proc.stderr.on("data", onData)
    proc.on("close", (code, signal) => {
      writeFileSync(logFile, log.join(""))
      resolve({ id, shard, code: code ?? 1, signal, seconds: (Date.now() - started) / 1000, logFile, resultsFile, dataDir, results: readJson(resultsFile) })
    })
  })
}

async function runShards(shards, firstId) {
  shards.forEach((s, i) => console.log(`shard ${firstId + i}: ${s.units.length} unit(s), ~${Math.round(s.ms / 1000)} s: ${s.units.map((u) => u.name).join("; ")}`))
  return Promise.all(
    shards.map((s, i) =>
      runShard(s, firstId + i).then((r) => {
        const tests = r.results?.tests ?? []
        const n = (k) => tests.filter((t) => t.result === k).length
        console.log(`shard ${r.id} done in ${r.seconds.toFixed(1)} s: ${n("passed")} passed, ${n("failed") + n("error")} failed${r.code !== 0 ? ` (exit ${r.code}${r.signal ? " " + r.signal : ""})` : ""}`)
        return r
      }),
    ),
  )
}

// ---- main ----
const t0 = Date.now()
if (build && !planOnly) execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] })

const cores = availableParallelism()
const known = Object.keys(history)
let firstShards
if (filterRes === undefined) {
  firstShards = [{ units: [{ name: `filters ${filters.join(" ")}`, patterns: filters, ms: 0 }], ms: 0, patterns: filters }]
} else {
  let units
  if (filters.length === 0) {
    units = buildUnits(known, { wholeFiles: true })
    const files = new Set(known.map(fileOf))
    for (const f of registeredFiles()) if (!files.has(f)) units.push({ name: f, patterns: [`^${luaEscape(f)} > `], ms: UNKNOWN_TEST_MS, paths: [] })
  } else {
    units = buildUnits(known.filter(selectedByFilter), { wholeFiles: false })
  }
  // With a filter that matches no known test, run it as given in one shard (it lists the suite for next time).
  if (units.length === 0) units = [{ name: `filters ${filters.join(" ")}`, patterns: filters, ms: 0 }]
  const n = jobs ?? Math.max(1, Math.min(Math.floor(cores / 2), units.length))
  firstShards = pack(units, n)
}
console.log(`T2: ${firstShards.length} shard(s) on ${cores} cores${jobs ? ` (jobs ${jobs})` : ""}`)
if (planOnly) {
  firstShards.forEach((s, i) => console.log(`shard ${i}: ~${Math.round(s.ms / 1000)} s\n  ${s.patterns.join("\n  ")}`))
  process.exit(0)
}
mkdirSync(shardOutDir, { recursive: true })
for (const f of readdirSync(shardOutDir)) rmSync(join(shardOutDir, f), { force: true })

let runs = await runShards(firstShards, 0)

/** Every test seen, merged across shards: the shard that ran it wins over the ones that skipped it. */
function merge(runsSoFar) {
  const merged = new Map()
  for (const r of runsSoFar) {
    for (const t of r.results?.tests ?? []) {
      const prev = merged.get(t.path)
      if (prev === undefined || (prev.result === "skipped" && t.result !== "skipped")) merged.set(t.path, { ...t, shard: r.id })
    }
  }
  return merged
}

// Second pass: tests that every shard skipped and no shard pattern selected (new tests in split files, or tests the
// history didn't know when a filter was given).
if (filterRes !== undefined) {
  const merged = merge(runs)
  const shardRes = runs.flatMap((r) => r.shard.patterns.map(luaPatternToRegExp))
  const leftover = [...merged.values()].filter((t) => t.result === "skipped" && selectedByFilter(t.path) && !shardRes.some((re) => re.test(t.path))).map((t) => t.path)
  if (leftover.length > 0) {
    const units = buildUnits(leftover, { wholeFiles: false })
    console.log(`second pass: ${leftover.length} test(s) the shard plan didn't know`)
    runs = runs.concat(await runShards(pack(units, jobs ?? Math.max(1, Math.min(Math.floor(cores / 2), units.length))), runs.length))
  }
}

// ---- report ----
const merged = merge(runs)
const tests = [...merged.values()]
const count = (...k) => tests.filter((t) => k.includes(t.result)).length
const failed = tests.filter((t) => t.result === "failed" || t.result === "error")
const shardOf = (id) => runs.find((r) => r.id === id)

writeFileSync(join(outDir, "test-results.json"), JSON.stringify({ tests, shards: runs.map((r) => ({ id: r.id, exitCode: r.code, seconds: r.seconds, patterns: r.shard.patterns, log: relative(root, r.logFile), factorioLog: relative(root, join(r.dataDir, "factorio-current.log")) })) }, null, 1))

// Timings: every test seen this run (the suite as it is now), with its new duration, or the old one if not run.
if (tests.length > 0 && runs.every((r) => r.results)) {
  const timings = {}
  for (const t of tests.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    timings[t.path] = t.durationMs !== undefined && t.result === "passed" ? Math.round(t.durationMs) : (history[t.path] ?? null)
  }
  writeFileSync(timingsFile, JSON.stringify(timings, null, 1) + "\n")
  if (saveTimings) writeFileSync(seedTimingsFile, JSON.stringify(timings, null, 1) + "\n")
}

console.log("")
for (const t of failed) {
  const r = shardOf(t.shard)
  console.log(`FAIL ${t.path}`)
  for (const e of t.errors ?? []) console.log("  " + String(e).split("\n").join("\n  "))
  console.log(`  shard ${t.shard}: ${shortPath(r.logFile)} (Factorio log: ${shortPath(join(r.dataDir, "factorio-current.log"))})`)
}
// A shard can fail without a failed test: a crash, a timeout, or a Lua error while loading.
const badShards = runs.filter((r) => r.code !== 0 && !failed.some((t) => t.shard === r.id))
for (const r of badShards) {
  console.log(`SHARD ${r.id} exited ${r.code}${r.signal ? " " + r.signal : ""} with no failed test recorded. Log: ${shortPath(r.logFile)}`)
  const tail = readFileSync(r.logFile, "utf8").trimEnd().split("\n").slice(-15)
  console.log("  " + tail.join("\n  "))
}
const wall = (Date.now() - t0) / 1000
const testSeconds = tests.reduce((s, t) => s + (t.durationMs ?? 0), 0) / 1000
const ran = count("passed", "failed", "error")
console.log(
  `\n${failed.length === 0 && badShards.length === 0 ? "PASSED" : "FAILED"}: ${count("passed")} passed, ${failed.length} failed, ${tests.length - ran} skipped` +
    ` | ${runs.length} shard(s), ${wall.toFixed(1)} s wall (${testSeconds.toFixed(1)} s of test time) | out/test-results.json`,
)
if (ran === 0 && failed.length === 0) console.log("No test matched.")
process.exit(failed.length === 0 && badShards.length === 0 ? 0 : 1)
