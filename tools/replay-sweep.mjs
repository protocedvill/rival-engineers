// T1 plan-replay sweeps: compile once, then run the matching replays under every combination of REPLAY_* env knobs,
// each combination its own Lua process, in parallel, and tabulate the metrics each replay prints (`REPLAY {json}`).
//
//   npm run replay:sweep -- <test-filter> "VAR=a,b" "VAR2=x,y" [-j N] [--no-build] [--out DIR] [--name NAME] [--file F]
//   <test-filter>  plain text in the test name (e.g. "seed11-production-ok"; "" = every test of the file)
//   VAR=a,b        values to try (split on "|" instead when one contains a comma; an empty value = unset)
//   -j N           parallel Lua processes (default: half the cores, or $SWEEP_JOBS)
//   --no-build / --out DIR   as in tools/run-unit-tests.mjs ($UNIT_OUT)
//   --name NAME    output dir out/replay-sweep/NAME/ (default: from the filter); --file: test file (plan-replay)
// Per combination: out/replay-sweep/NAME/<combo>/output.log, and dumps/ (failed replays, or all with REPLAY_DUMP=1).
import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { comboDir, comboEnv, comboLabel, expandCombos, formatTable, parseOutput, parseVar } from "./replay-sweep-lib.mjs"
import { build, buildDir, findLua, luaInvocation, requireBuild, root } from "./unit-lib.mjs"

let noBuild = false
let outArg
let name
let file = "plan-replay"
let jobs = Number(process.env.SWEEP_JOBS) || Math.max(1, Math.floor(availableParallelism() / 2))
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--no-build") noBuild = true
  else if (a === "--out") outArg = argv[++i]
  else if (a === "--name") name = argv[++i]
  else if (a === "--file") file = argv[++i]
  else if (a === "-j" || a === "--jobs") jobs = Math.max(1, Number(argv[++i]))
  else positional.push(a)
}
if (positional.length === 0) {
  console.error('usage: npm run replay:sweep -- <test-filter> "VAR=a,b" ["VAR2=x,y" ...] [-j N] [--no-build] [--out DIR] [--name NAME]')
  process.exit(2)
}
const filter = positional[0]
const vars = positional.slice(1).map(parseVar)
const combos = expandCombos(vars)
name ??= (filter || "all").replace(/[^A-Za-z0-9._-]+/g, "_")
const sweepDir = join(root, "out", "replay-sweep", name)

const out = buildDir(outArg)
if (noBuild) requireBuild(out)
else build(out)
const testFile = `${file.replace(/\.test\.ts$|_test\.lua$/, "")}_test.lua`
if (!existsSync(join(out, "unit", testFile))) {
  console.error(`no ${testFile} in ${out}/unit`)
  process.exit(2)
}
rmSync(sweepDir, { recursive: true, force: true })
mkdirSync(sweepDir, { recursive: true })

const lua = findLua()
console.log(`${combos.length} combination(s) of "${filter}" in ${testFile}, ${Math.min(jobs, combos.length)} at a time → ${sweepDir}`)

function runCombo(combo, index) {
  const dir = join(sweepDir, comboDir(combo, index))
  mkdirSync(dir, { recursive: true })
  const run = luaInvocation(lua, out, testFile, { UNIT_TEST_FILTER: filter, REPLAY_DUMP_DIR: join(dir, "dumps") })
  run.options.env = comboEnv(run.options.env, combo)
  const started = Date.now()
  return new Promise((done) => {
    const log = createWriteStream(join(dir, "output.log"))
    let text = ""
    const child = spawn(run.cmd, run.args, { ...run.options, stdio: ["ignore", "pipe", "pipe"] })
    const take = (chunk) => {
      text += chunk
      log.write(chunk)
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    child.on("close", (code) => {
      log.end()
      const seconds = (Date.now() - started) / 1000
      const parsed = parseOutput(text)
      const passed = parsed.tests.filter((t) => t.passed).length
      console.log(`  [${index + 1}/${combos.length}] ${comboLabel(combo)}: ${passed}/${parsed.tests.length} tests passed, ${seconds.toFixed(0)} s`)
      done({ combo, label: comboLabel(combo), dir, code, seconds, ...parsed })
    })
  })
}

const results = new Array(combos.length)
let next = 0
async function worker() {
  while (next < combos.length) {
    const i = next++
    results[i] = await runCombo(combos[i], i)
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, combos.length) }, worker))

const header = ["combination", "replay", "result", "phase", "work", "place", "route", "compare", "searches", "rip-ups", "re-placed", "route tiles", "failures"]
const rows = []
for (const r of results) {
  if (r.metrics.length === 0) {
    const t = r.tests.length > 0 ? `${r.tests.filter((t) => t.passed).length}/${r.tests.length} tests` : `no output (exit ${r.code})`
    rows.push([r.label, "-", t])
    continue
  }
  for (const m of r.metrics) {
    const failures = m.failures ?? ""
    rows.push([r.label, m.name, m.passed ? "pass" : "FAIL", m.phase, m.work, m.placeWork, m.routeWork, m.compareWork, m.searches, m.ripups, m.replacements, m.routeTiles, failures.length > 70 ? failures.slice(0, 67) + "..." : failures])
  }
}
const table = formatTable(header, rows)
const tally = results.map((r) => {
  const failed = r.tests.filter((t) => !t.passed)
  return `${r.label}: ${r.tests.length - failed.length}/${r.tests.length} tests passed in ${r.seconds.toFixed(0)} s${failed.map((t) => `\n    FAIL ${t.name}: ${t.error ?? ""}`).join("")}`
})
const report = `${table}\n\n${tally.join("\n")}\n\noutput and dumps: ${sweepDir}/<combination>/{output.log,dumps/}\n`
console.log("\n" + report)
writeFileSync(join(sweepDir, "summary.txt"), report)
writeFileSync(join(sweepDir, "summary.json"), JSON.stringify({ filter, file: testFile, vars, results: results.map(({ combo, label, dir, code, seconds, tests, metrics }) => ({ combo, label, dir, code, seconds, tests, metrics })) }, null, 2) + "\n")
process.exit(results.every((r) => r.code === 0) ? 0 : 1)
