// T1 runner: compiles mod/unit with TSTL and runs every *_test.lua with a plain Lua interpreter.
// Lua comes from $LUA, else the first of lua5.2 / lua on PATH. Factorio runs Lua 5.2; the compiled
// code also runs on 5.3+.
//
//   node tools/run-unit-tests.mjs [--no-build] [--out DIR] [-j N] [--timings] [-t TEXT] [FILE-FILTER]
//   --no-build   reuse the existing build (no delete + recompile; ~20-30 s saved)
//   --out DIR    build / run in DIR instead of mod/build-unit (also $UNIT_OUT): concurrent runs each get their own
//   -j N         test files to run at once (default: $TEST_JOBS, else the CPU count, capped at 8). Each file is a
//                separate Lua process over the same read-only build, so the wall time is the longest file, not the sum.
//   --timings    print the slowest files after the summary
//   -t TEXT      only tests whose name contains TEXT ($UNIT_TEST_FILTER, plain text)
//   FILE-FILTER  only test files whose name contains it (e.g. plan-replay)
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { checkSweepCombos } from "./replay-sweep-lib.mjs"
import { build, buildDir, findLua, luaInvocation, requireBuild, root, upToDate } from "./unit-lib.mjs"

let noBuild = false
let outArg
let testFilter
let timings = false
let jobs = process.env.TEST_JOBS !== undefined ? Number(process.env.TEST_JOBS) : Math.min(availableParallelism(), 8)
const rest = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--no-build") noBuild = true
  else if (a === "--out") outArg = argv[++i]
  else if (a === "-j" || a === "--jobs") jobs = Number(argv[++i])
  else if (a === "--timings") timings = true
  else if (a === "-t" || a === "--test") testFilter = argv[++i]
  else rest.push(a)
}
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error("--jobs / TEST_JOBS must be a positive integer")
  process.exit(2)
}
const filter = rest[0]
const out = buildDir(outArg)

if (noBuild) requireBuild(out)
else if (upToDate(out)) console.log(`unit build up to date (${out})`)
else build(out)

// The sweep tool's pure parts (plain node, no test framework).
if (!filter || "replay-sweep".includes(filter)) {
  checkSweepCombos()
  console.log("PASS replay-sweep > combination expansion")
}

const lua = findLua()
const files = readdirSync(join(out, "unit")).filter((f) => f.endsWith("_test.lua") && (!filter || f.includes(filter)))
if (files.length === 0) {
  console.log("no unit test files matched")
  process.exit(1)
}

// A few files (plan-replay) hold a whole suite of expensive, independent tests. Shard those over the job pool; every
// other file stays one task. `-t` keeps one process: its filter already narrows the work.
const shardConfig = existsSync(join(root, "tools", "unit-shards.json")) ? JSON.parse(readFileSync(join(root, "tools", "unit-shards.json"), "utf8")) : {}
const shardsFor = (file) => {
  if (testFilter !== undefined) return 1
  for (const [key, n] of Object.entries(shardConfig)) if (file.includes(key) && Number.isInteger(n) && n > 1) return n
  return 1
}
const tasks = []
for (const file of files) {
  const count = shardsFor(file)
  for (let shard = 0; shard < count; shard++) tasks.push({ file, shard, count })
}

/** Runs one file (or one shard of it) in its own Lua process, buffering output so parallel tests do not interleave. */
function runTask(task) {
  const env = testFilter !== undefined ? { UNIT_TEST_FILTER: testFilter } : {}
  if (task.count > 1) env.UNIT_TEST_SHARD = `${task.shard}/${task.count}`
  const run = luaInvocation(lua, out, task.file, env)
  const started = performance.now()
  return new Promise((resolve) => {
    const child = spawn(run.cmd, run.args, { ...run.options, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (e) => (stderr += `${e}\n`))
    child.on("close", (code) => resolve({ task, code: code ?? 1, stdout, stderr, ms: performance.now() - started }))
  })
}

const results = new Array(tasks.length)
const fileMs = {}
const failedFiles = {}
let next = 0
let active = 0
let finished = 0
const wall = performance.now()
await new Promise((resolve) => {
  const launch = () => {
    while (active < jobs && next < tasks.length) {
      const i = next++
      active++
      runTask(tasks[i]).then((r) => {
        results[i] = r
        active--
        finished++
        if (r.stdout !== "") process.stdout.write(r.stdout)
        if (r.stderr !== "") process.stderr.write(r.stderr)
        if (r.code !== 0) failedFiles[r.task.file] = true
        fileMs[r.task.file] = Math.max(fileMs[r.task.file] ?? 0, r.ms)
        launch()
        if (finished === tasks.length) resolve()
      })
    }
  }
  launch()
})
const elapsed = performance.now() - wall
const total = results.reduce((sum, r) => sum + r.ms, 0)
const failed = Object.keys(failedFiles).length
console.log(`${files.length - failed}/${files.length} unit test files passed (${lua}, build ${out})`)
console.log(`T1 wall ${(elapsed / 1000).toFixed(1)}s, test time ${(total / 1000).toFixed(1)}s, ${jobs} job(s), ${tasks.length} task(s)`)
if (timings) {
  const slow = Object.entries(fileMs).sort((a, b) => b[1] - a[1]).slice(0, 15)
  for (const [file, ms] of slow) console.log(`  ${(ms / 1000).toFixed(1).padStart(6)}s  ${file}`)
}
process.exit(failed > 0 ? 1 : 0)

