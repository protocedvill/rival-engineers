// Builds the mod into mod/build: transpiles both TS stages and copies static files.
import { execFileSync } from "node:child_process"
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { writeCuratedLua } from "./curated-lua.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const mod = join(root, "mod")
const tstl = join(root, "node_modules", ".bin", "tstl")

rmSync(join(mod, "build"), { recursive: true, force: true })
for (const project of ["tsconfig.json", "tsconfig.settings.json"]) {
  execFileSync(tstl, ["-p", join(mod, project)], { stdio: "inherit" })
}
cpSync(join(mod, "static"), join(mod, "build"), { recursive: true })

// Curated modules (data/modules/*.json, SPEC §5.4) become one Lua table: modules/curated_data.lua.
writeCuratedLua(root, join(mod, "build", "modules", "curated_data.lua"))
// Lua allows at most 200 local variables in a chunk's main function: TSTL makes one per imported name and per
// top-level declaration. A file over it fails to load with no build error (M6a: factory.lua did, twice). Fail here.
const LOCAL_LIMIT = 185
function luaFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...luaFiles(p))
    else if (e.name.endsWith(".lua")) out.push(p)
  }
  return out
}
const tooMany = []
for (const f of luaFiles(join(mod, "build"))) {
  let n = 0
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^local (?:function )?([^=(]+?)\s*(?:=|\(|$)/.exec(line)
    if (m) n += m[1].split(",").length
  }
  if (n > LOCAL_LIMIT) tooMany.push(`${f}: ${n} main-chunk locals (Lua's limit is 200; keep under ${LOCAL_LIMIT})`)
}
if (tooMany.length > 0) {
  console.error(tooMany.join("\n"))
  process.exit(1)
}
console.log("built mod/build")
