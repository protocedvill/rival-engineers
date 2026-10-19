import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

const root = resolve(import.meta.dirname, "..")
const read = (path) => readFileSync(resolve(root, path), "utf8")
const failures = []
const fail = (message) => failures.push(message)

// A setting is deliberately repeated at the two Factorio stages, but the keys must be identical: adding a Config
// field without a data-stage definition otherwise compiles and fails only after Factorio starts.
const config = read("mod/src/config.ts")
const configBody = config.match(/export interface Config \{([\s\S]*?)\n\}/)?.[1] ?? ""
const configKeys = [...configBody.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
const names = read("mod/src/shared/setting-names.ts")
const nameKeys = [...names.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):\s*"/gm)].map((match) => match[1])
const definitions = read("mod/src/settings.ts")
const definitionKeys = [...definitions.matchAll(/name:\s*Settings\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1])

function compare(label, expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((key) => !actualSet.has(key))
  const extra = actual.filter((key) => !expectedSet.has(key))
  const duplicates = actual.filter((key, index) => actual.indexOf(key) !== index)
  if (missing.length > 0) fail(`${label}: missing ${missing.join(", ")}`)
  if (extra.length > 0) fail(`${label}: unknown ${extra.join(", ")}`)
  if (duplicates.length > 0) fail(`${label}: duplicate ${[...new Set(duplicates)].join(", ")}`)
}

compare("setting names vs Config", configKeys, nameKeys)
compare("setting definitions vs Config", configKeys, definitionKeys)

// These modules promise replayable pure logic. Factorio globals here make T1 fixtures misleading even when TS builds.
for (const path of ["mod/src/diagnostics-core.ts", "mod/src/storage-schema.ts", "mod/src/strategy/goal-selection.ts"]) {
  const source = read(path)
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  for (const token of ["storage", "game", "prototypes", "settings", "remote", "script", "defines"]) {
    if (new RegExp(`\\b${token}\\s*[.[]`).test(code)) fail(`${path}: pure boundary references Factorio global '${token}'`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ARCHITECTURE: ${failure}`)
  process.exit(1)
}
console.log(`architecture: ${configKeys.length} settings aligned; pure boundaries clean`)
