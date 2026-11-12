// T1 build and run helpers shared by tools/run-unit-tests.mjs and tools/replay-sweep.mjs.
// A build is mod/unit (+ the pure src modules it imports) compiled by TSTL into one directory; any number of Lua
// processes can run from one build at once (they only read it).
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeCuratedLua } from "./curated-lua.mjs"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const mod = join(root, "mod")

/** The build dir: --out <dir>, else $UNIT_OUT, else mod/build-unit. Relative paths are relative to the cwd. */
export function buildDir(outArg) {
  const dir = outArg ?? process.env.UNIT_OUT
  return dir ? resolve(dir) : join(mod, "build-unit")
}

/** Every input of a T1 build: mod/src and mod/unit TypeScript, the unit tsconfigs, and the curated-data writer. */
function unitSources() {
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === "build" || e.name === "build-unit" || e.name === "node_modules") continue
        walk(p)
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".json")) files.push(p)
    }
  }
  walk(join(mod, "src"))
  walk(join(mod, "unit"))
  for (const f of [join(mod, "tsconfig.unit.json"), join(mod, "tsconfig.settings.json"), join(root, "tools", "curated-lua.mjs")]) if (existsSync(f)) files.push(f)
  return files.sort()
}

const BUILD_STAMP = ".unit-build.json"

function writeBuildStamp(out) {
  const files = {}
  for (const f of unitSources()) files[relative(root, f)] = statSync(f).mtimeMs
  writeFileSync(join(out, BUILD_STAMP), JSON.stringify({ files }))
}

/**
 * Whether `out` was built from exactly the current sources (same file set, same mtimes). The T1 runner skips the
 * 20–30 s recompile on an unchanged tree; any edit, addition or deletion rebuilds.
 */
export function upToDate(out) {
  const stamp = join(out, BUILD_STAMP)
  if (!existsSync(stamp)) return false
  let saved
  try {
    saved = JSON.parse(readFileSync(stamp, "utf8"))
  } catch {
    return false
  }
  const files = unitSources()
  if (Object.keys(saved.files).length !== files.length) return false
  for (const f of files) {
    const key = relative(root, f)
    if (saved.files[key] !== statSync(f).mtimeMs) return false
  }
  return true
}

/** Deletes `out` and compiles mod/unit into it. */
export function build(out) {
  rmSync(out, { recursive: true, force: true })
  execFileSync(join(root, "node_modules", ".bin", "tstl"), ["-p", join(mod, "tsconfig.unit.json"), "--outDir", out], { stdio: "inherit" })
  // The curated module data, as the mod build ships it (`require("modules.curated_data")`).
  writeCuratedLua(root, join(out, "modules", "curated_data.lua"))
  writeBuildStamp(out)
}

/** Fails with a clear message when `out` holds no build (for --no-build). */
export function requireBuild(out) {
  if (!existsSync(join(out, "unit")) || !existsSync(join(out, "modules", "curated_data.lua"))) {
    console.error(`no T1 build in ${out}: run once without --no-build (or point --out / $UNIT_OUT at a build)`)
    process.exit(2)
  }
}

export function findLua() {
  if (process.env.LUA) return process.env.LUA
  for (const candidate of ["lua5.2", "lua"]) {
    if (spawnSync(candidate, ["-v"]).status === 0) return candidate
  }
  throw new Error("no Lua interpreter found: install lua5.2 or set $LUA")
}

/** Command line and environment that run one compiled test file (e.g. "plan-replay_test.lua") from `out`. */
export function luaInvocation(lua, out, file, env = {}) {
  return {
    cmd: lua,
    args: ["-e", `package.path = "${out}/?.lua;" .. package.path`, join(out, "unit", file)],
    options: { cwd: out, env: { ...process.env, UNIT_ROOT: root, UNIT_SRC: join(mod, "unit"), ...env } },
  }
}
