#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const strict = process.argv.includes("--strict")
const checks = []

function result(level, name, detail) {
  checks.push({ level, name, detail })
}

function command(name, args = ["--version"]) {
  const r = spawnSync(name, args, { encoding: "utf8" })
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : undefined
}

function newest(dir, accept = () => true) {
  if (!existsSync(dir)) return undefined
  let best
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const value = newest(path, accept)
      if (value !== undefined && (best === undefined || value > best)) best = value
    } else if (accept(path)) {
      const value = statSync(path).mtimeMs
      if (best === undefined || value > best) best = value
    }
  }
  return best
}

const gitStatus = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim()
result(gitStatus ? "warn" : "ok", "Git tree", gitStatus ? `${gitStatus.split("\n").length} changed path(s)` : "clean")
result("ok", "Node", process.version)
const lua = command(process.env.LUA || "lua5.2", ["-v"]) || command("lua", ["-v"])
result(lua ? "ok" : "error", "Lua", lua || "missing; T1 cannot run (install lua5.2 or set LUA)")
const hasTstl = existsSync(join(root, "node_modules", ".bin", "tstl"))
result(hasTstl ? "ok" : "error", "Dependencies", hasTstl ? "installed" : existsSync(join(root, "node_modules")) ? "node_modules exists but tstl is missing" : "node_modules missing; run npm ci or link the main checkout")
const factorio = join(root, ".factorio-test", "factorio", "bin", "x64", "factorio")
result(existsSync(factorio) ? "ok" : "warn", "Headless Factorio", existsSync(factorio) ? factorio : "missing in this worktree; T2/T3 unavailable")

const sourceTime = newest(join(root, "mod", "src"), (path) => path.endsWith(".ts"))
const buildFile = join(root, "mod", "build", "control.lua")
if (!existsSync(buildFile)) result("warn", "Build", "mod/build missing; build before T2, soak or review")
else if (sourceTime !== undefined && statSync(buildFile).mtimeMs < sourceTime) result("warn", "Build", "mod/build is older than mod/src; rebuild before Factorio")
else result("ok", "Build", "present and newer than TypeScript sources")

const ps = spawnSync("ps", ["-eo", "pid=,etime=,args="], { encoding: "utf8" })
const factorioLines = ps.status === 0 ? ps.stdout.split("\n").filter((line) => /\/factorio(?:\s|$)/.test(line) && !line.includes("ps -eo")) : []
result(factorioLines.length ? "warn" : "ok", "Running Factorio", factorioLines.length ? `${factorioLines.length} process(es):\n${factorioLines.map((line) => `           ${line.trim()}`).join("\n")}` : "none")

const locks = [join(root, ".factorio-review", ".lock")]
const presentLocks = locks.filter(existsSync)
result(presentLocks.length ? "warn" : "ok", "Known locks", presentLocks.length ? presentLocks.join(", ") : "none")

const soakRoot = join(root, "out", "soak")
const active = []
if (existsSync(soakRoot)) {
  for (const name of readdirSync(soakRoot)) {
    const manifest = join(soakRoot, name, "run.json")
    if (!existsSync(manifest)) continue
    try {
      const run = JSON.parse(readFileSync(manifest, "utf8"))
      if (run.status === "running" || run.status === "partial") active.push(`${name}:${run.status}`)
    } catch {
      result("warn", "Run manifest", `${manifest} is not valid JSON`)
    }
  }
}
result(active.length ? "warn" : "ok", "Active/partial runs", active.length ? active.join(", ") : "none")

for (const check of checks) {
  const mark = check.level === "ok" ? "OK  " : check.level === "warn" ? "WARN" : "ERR "
  console.log(`${mark} ${check.name}: ${check.detail}`)
}
const errors = checks.filter((check) => check.level === "error").length
const warnings = checks.filter((check) => check.level === "warn").length
console.log(`\n${errors} error(s), ${warnings} warning(s). Doctor never changes or stops processes.`)
if (errors > 0 || (strict && warnings > 0)) process.exitCode = 1
