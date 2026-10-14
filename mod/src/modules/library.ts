// The module library at runtime (SPEC §5.4): curated modules from data/modules/*.json (compiled into the mod by
// tools/build-mod.mjs as modules/curated_data.lua) and the generators, both completed with prototype-derived
// rates. Results are memoised per session (derived from prototypes only, rebuilt on demand: no game state).
//
// How the planner (M4b/M5) consumes a module: see docs/reports/M4-report.md "Interface for M4b" and the
// comments in types.ts (ports, expand, anchor) and geometry.ts (transforms).

import { finalizeModule } from "./build"
import { generate, GeneratorName } from "./generators"
import { prototypeFacts } from "./prototype-facts"
import { CuratedModuleFile, ModuleDef } from "./types"

/** @noSelf */
declare function require(this: void, module: string): unknown

let curatedFiles: Record<string, CuratedModuleFile> | undefined
const curatedCache: Record<string, ModuleDef> = {}
const generatedCache: Record<string, ModuleDef> = {}

function files(): Record<string, CuratedModuleFile> {
  curatedFiles ??= require("modules.curated_data") as Record<string, CuratedModuleFile>
  return curatedFiles
}

export function curatedIds(): string[] {
  const ids: string[] = []
  for (const [id] of pairs(files())) ids.push(id)
  ids.sort()
  return ids
}

export function curatedModule(id: string): ModuleDef {
  let def = curatedCache[id]
  if (def === undefined) {
    const f = files()[id]
    if (f === undefined) error(`unknown curated module ${id}`)
    def = finalizeModule(
      {
        id: f.id,
        source: "curated",
        provenance: f.provenance,
        description: f.description,
        footprint: f.footprint,
        entities: f.entities,
        ports: f.ports,
        recipe: f.recipe,
        rotatable: f.rotatable ?? true,
        mirrorable: f.mirrorable ?? true,
        site: f.site,
        anchor: f.anchor,
        params: f.params,
        expand: f.expand,
        notes: f.notes,
      },
      prototypeFacts,
    )
    curatedCache[id] = def
  }
  return def
}

function paramsKey(name: string, params: Record<string, unknown>): string {
  const keys: string[] = []
  for (const [k] of pairs(params)) keys.push(k as string)
  keys.sort()
  let s = name
  for (const k of keys) {
    const v = params[k]
    s += `|${k}=${Array.isArray(v) ? (v as unknown[]).join(",") : tostring(v)}`
  }
  return s
}

/** A generated module (memoised by generator and parameters). */
export function generatedModule(name: GeneratorName, params: Record<string, unknown>): ModuleDef {
  const key = paramsKey(name, params)
  let def = generatedCache[key]
  if (def === undefined) {
    def = generate(prototypeFacts, name, params)
    generatedCache[key] = def
  }
  return def
}

/** A representative instance of every generator plus every curated module: the v1 catalog the validation lab runs. */
export interface CatalogEntry {
  name: string
  generator?: GeneratorName
  params?: Record<string, unknown>
  curated?: string
  /** Slow to validate (long craft cycles): tagged so test runs can filter them. */
  slow?: boolean
}

export const V1_CATALOG: CatalogEntry[] = [
  { name: "smelter iron 12", generator: "smelter-column", params: { recipe: "iron-plate", furnaces: 12 } },
  { name: "smelter copper 4", generator: "smelter-column", params: { recipe: "copper-plate", furnaces: 4 } },
  { name: "smelter stone-brick 4", generator: "smelter-column", params: { recipe: "stone-brick", furnaces: 4 } },
  { name: "mining iron 4x2 electric", generator: "mining-outpost", params: { resource: "iron-ore", rows: 4, sides: 2 } },
  { name: "mining coal 3x2 burner", generator: "mining-outpost", params: { resource: "coal", rows: 3, sides: 2, drill: "burner-mining-drill" } },
  { name: "steam 2 boilers", generator: "steam-block", params: { boilers: 2 } },
  { name: "assembler-row gear 4", generator: "assembler-row", params: { recipe: "iron-gear-wheel", count: 4 } },
  { name: "assembler-row cable 2", generator: "assembler-row", params: { recipe: "copper-cable", count: 2 } },
  { name: "assembler-row belt 2", generator: "assembler-row", params: { recipe: "transport-belt", count: 2 } },
  { name: "red-line 2", generator: "red-line", params: { units: 2 }, slow: true },
  { name: "circuit-block 1", generator: "circuit-block", params: { units: 1 } },
  { name: "lab-array 4", generator: "lab-array", params: { labs: 4, packs: ["automation-science-pack", "logistic-science-pack"] }, slow: true },
  { name: "curated red-tile-ramqvist", curated: "red-tile-ramqvist", slow: true },
  { name: "curated green-line-hellpet", curated: "green-line-hellpet", slow: true },
  { name: "curated mall-polse", curated: "mall-polse", slow: true },
]

export function catalogModule(entry: CatalogEntry): ModuleDef {
  if (entry.curated !== undefined) return curatedModule(entry.curated)
  return generatedModule(entry.generator!, entry.params ?? {})
}
