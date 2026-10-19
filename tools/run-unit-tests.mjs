// T1 runner: compiles mod/unit with TSTL and runs every *_test.lua with a plain Lua interpreter.
// Lua comes from $LUA, else the first of lua5.2 / lua on PATH. Factorio runs Lua 5.2; the compiled
// code also runs on 5.3+.
//
//   node tools/run-unit-tests.mjs [--no-build] [--out DIR] [-t TEXT] [FILE-FILTER]
//   --no-build   reuse the existing build (no delete + recompile; ~20-30 s saved)
//   --out DIR    build / run in DIR instead of mod/build-unit (also $UNIT_OUT): concurrent runs each get their own
//   -t TEXT      only tests whose name contains TEXT ($UNIT_TEST_FILTER, plain text)
//   FILE-FILTER  only test files whose name contains it (e.g. plan-replay)
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { checkSweepCombos } from "./replay-sweep-lib.mjs"
import { build, buildDir, findLua, luaInvocation, requireBuild } from "./unit-lib.mjs"

let noBuild = false
let outArg
let testFilter
const rest = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--no-build") noBuild = true
  else if (a === "--out") outArg = argv[++i]
  else if (a === "-t" || a === "--test") testFilter = argv[++i]
  else rest.push(a)
}
const filter = rest[0]
const out = buildDir(outArg)

if (noBuild) requireBuild(out)
else build(out)

// The sweep tool's pure parts (plain node, no test framework).
if (!filter || "replay-sweep".includes(filter)) {
  checkSweepCombos()
  console.log("PASS replay-sweep > combination expansion")
}

const lua = findLua()
const files = readdirSync(join(out, "unit")).filter((f) => f.endsWith("_test.lua") && (!filter || f.includes(filter)))
let failed = 0
for (const file of files) {
  const run = luaInvocation(lua, out, file, testFilter !== undefined ? { UNIT_TEST_FILTER: testFilter } : {})
  const result = spawnSync(run.cmd, run.args, { ...run.options, stdio: "inherit" })
  if (result.status !== 0) failed++
}
console.log(`${files.length - failed}/${files.length} unit test files passed (${lua}, build ${out})`)
process.exit(failed > 0 ? 1 : 0)
