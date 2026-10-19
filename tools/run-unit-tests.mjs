// T1 runner: compiles mod/unit with TSTL and runs every *_test.lua with a plain Lua interpreter.
// Lua comes from $LUA, else the first of lua5.2 / lua on PATH. Factorio runs Lua 5.2; the compiled
// code also runs on 5.3+.
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { writeCuratedLua } from "./curated-lua.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const mod = join(root, "mod")
const out = join(mod, "build-unit")

function findLua() {
  if (process.env.LUA) return process.env.LUA
  for (const candidate of ["lua5.2", "lua"]) {
    if (spawnSync(candidate, ["-v"]).status === 0) return candidate
  }
  throw new Error("no Lua interpreter found: install lua5.2 or set $LUA")
}

rmSync(out, { recursive: true, force: true })
execFileSync(join(root, "node_modules", ".bin", "tstl"), ["-p", join(mod, "tsconfig.unit.json")], { stdio: "inherit" })
// The curated module data, as the mod build ships it (`require("modules.curated_data")`).
writeCuratedLua(root, join(out, "modules", "curated_data.lua"))

const lua = findLua()
const filter = process.argv[2]
const files = readdirSync(join(out, "unit")).filter((f) => f.endsWith("_test.lua") && (!filter || f.includes(filter)))
let failed = 0
for (const file of files) {
  const result = spawnSync(lua, ["-e", `package.path = "${out}/?.lua;" .. package.path`, join(out, "unit", file)], {
    cwd: out,
    stdio: "inherit",
  })
  if (result.status !== 0) failed++
}
console.log(`${files.length - failed}/${files.length} unit test files passed (${lua})`)
process.exit(failed > 0 ? 1 : 0)
