// Builds the mod into mod/build: transpiles both TS stages and copies static files.
import { execFileSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const mod = join(root, "mod")
const tstl = join(root, "node_modules", ".bin", "tstl")

rmSync(join(mod, "build"), { recursive: true, force: true })
for (const project of ["tsconfig.json", "tsconfig.settings.json"]) {
  execFileSync(tstl, ["-p", join(mod, project)], { stdio: "inherit" })
}
cpSync(join(mod, "static"), join(mod, "build"), { recursive: true })
console.log("built mod/build")
