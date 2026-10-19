// T1 build and run helpers shared by tools/run-unit-tests.mjs and tools/replay-sweep.mjs.
// A build is mod/unit (+ the pure src modules it imports) compiled by TSTL into one directory; any number of Lua
// processes can run from one build at once (they only read it).
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeCuratedLua } from "./curated-lua.mjs"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const mod = join(root, "mod")

/** The build dir: --out <dir>, else $UNIT_OUT, else mod/build-unit. Relative paths are relative to the cwd. */
export function buildDir(outArg) {
  const dir = outArg ?? process.env.UNIT_OUT
  return dir ? resolve(dir) : join(mod, "build-unit")
}

/** Deletes `out` and compiles mod/unit into it. */
export function build(out) {
  rmSync(out, { recursive: true, force: true })
  execFileSync(join(root, "node_modules", ".bin", "tstl"), ["-p", join(mod, "tsconfig.unit.json"), "--outDir", out], { stdio: "inherit" })
  // The curated module data, as the mod build ships it (`require("modules.curated_data")`).
  writeCuratedLua(root, join(out, "modules", "curated_data.lua"))
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
