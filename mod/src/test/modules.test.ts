import { LuaForce, LuaTechnologyPrototype } from "factorio:runtime"
import { CatalogEntry, catalogModule, generatedModule, V1_CATALOG } from "../modules/library"
import { prototypeFacts } from "../modules/prototype-facts"
import { ModuleDef } from "../modules/types"
import { LabOptions, LabResult, runModuleLab } from "./module-lab"

// M4 validation lab (SPEC §5.4 step 4, D33): every generator at representative parameters and every curated module is
// stamped into a lab, fed at exactly its declared input rates, and must deliver ≥ 90% of its declared output rates
// (malls: of their total plate throughput, plus product coverage) once its outputs reach a steady state. Slow modules (long craft cycles) carry "[slow]" in their test name, so a quick run can
// filter them out: npm test -- "validation fast".

const PASS_RATIO = 0.9
const SPEED = 100
/** Coal primed into each burner machine (`LabOptions.primeFuel`): the lab's own refuel amount (upkeep). */
const PRIME_FUEL = 5
/** The validation that starts its burners from empty (the rest are primed). */
const COLD_START = "smelter iron 12"

/** Writes the module as a tools/render dump: script-output/modules/<id>.json (ports drawn as small grey squares). */
function writeDump(def: ModuleDef): void {
  const entities: Record<string, unknown>[] = []
  for (const e of def.entities) {
    const p = prototypes.entity[e.name]
    const side = e.dir === 4 || e.dir === 12
    const tw = side ? p.tile_height : p.tile_width
    const th = side ? p.tile_width : p.tile_height
    entities.push({ name: e.name, type: p.type, x: e.x, y: e.y, direction: e.dir ?? 0, force: "player", w: tw - 0.2, h: th - 0.2, tw, th })
  }
  for (const port of def.ports) entities.push({ name: "port", type: "port", x: port.pos.x, y: port.pos.y, direction: port.dir, force: "player", w: 0.4, h: 0.4, tw: 1, th: 1 })
  const dump = { tick: 0, center: { x: def.footprint.w / 2, y: def.footprint.h / 2 }, radius: math.max(def.footprint.w, def.footprint.h) / 2 + 1, entities }
  helpers.write_file(`modules/${string.gsub(def.id, "[/+]", "_")[0]}.json`, helpers.table_to_json(dump))
}

function report(name: string, def: ModuleDef, r: LabResult): void {
  writeDump(def)
  const parts: string[] = []
  for (const [item, d] of pairs(r.declared)) parts.push(`${item} ${string.format("%.4f", r.measured[item] ?? 0)}/${string.format("%.4f", d)} (${string.format("%.1f", 100 * (r.ratio[item] ?? 0))}%)`)
  let worst = 1
  for (const [, ratio] of pairs(r.ratio)) worst = math.min(worst, ratio)
  if (worst < PASS_RATIO) for (const m of r.machines) log(`[module-lab-debug] ${name} ${m}`)
  const windows = r.windowRatios.map((w) => string.format("%.2f", w)).join(",")
  log(`[module-lab] ${name} | ${def.id} | ${parts.join(" ; ")} | warm-up ${string.format("%.1f", r.warmupTicks / 3600)} min, ${r.steady ? "steady" : "NOT steady"} [${windows}]${r.problems.length > 0 ? " | problems: " + r.problems.join(", ") : ""}`)
}

/** Plates (input-port items) per item, through the recipes made inside the module. */
function rawCost(def: ModuleDef, item: string, depth = 0): number {
  for (const p of def.ports) if (p.kind === "belt-in" && p.item === item) return 1
  const recipe = prototypeFacts.recipe(prototypeFacts.recipeForItem(item) ?? item)
  if (recipe === undefined || depth > 8) return 1
  let cost = 0
  for (const ing of recipe.ingredients) cost += ing.amount * rawCost(def, ing.name, depth + 1)
  return cost / (recipe.products[0]?.amount ?? 1)
}

function hasChests(def: ModuleDef): boolean {
  for (const p of def.ports) if (p.kind === "chest-out") return true
  return false
}

function check(name: string, def: ModuleDef, r: LabResult): void {
  report(name, def, r)
  assert(r.problems.length === 0, `${def.id}: ${r.problems.join(", ")}`)
  if (hasChests(def)) {
    // A mall's products share its intermediates, and which assembler gets them depends on belt order, so the
    // per-product split varies; its capacity is the plate throughput of all products together.
    let declared = 0
    let measured = 0
    for (const [item, d] of pairs(r.declared)) {
      const w = rawCost(def, item)
      declared += d * w
      measured += (r.measured[item] ?? 0) * w
    }
    log(`[module-lab] ${name} | aggregate (plates/s in products) ${string.format("%.3f/%.3f (%.1f%%)", measured, declared, (100 * measured) / declared)}`)
    assert(measured >= PASS_RATIO * declared, `${def.id}: products worth ${measured} plates/s, declared ${declared}`)
    return
  }
  let any = false
  for (const [item, ratio] of pairs(r.ratio)) {
    any = true
    assert(ratio >= PASS_RATIO, `${def.id}: ${item} at ${string.format("%.1f", 100 * ratio)}% of declared ${string.format("%.4f", r.declared[item])}/s (measured ${string.format("%.4f", r.measured[item] ?? 0)}/s)`)
  }
  assert(any, `${def.id} declares no outputs`)
}

/** The technology researched with exactly `packs` with the most units (a lab run never finishes it). */
function researchTarget(packs: string[] = ["automation-science-pack", "logistic-science-pack"]): LuaTechnologyPrototype {
  let best: LuaTechnologyPrototype | undefined
  const names: string[] = []
  for (const [n] of pairs(prototypes.technology)) names.push(n as string)
  names.sort()
  for (const n of names) {
    const t = prototypes.technology[n]
    const ing = t.research_unit_ingredients
    if (ing.length !== packs.length || t.research_unit_count_formula !== undefined) continue
    const set: Record<string, boolean> = {}
    for (const i of ing) set[i.name] = true
    if (packs.some((pk) => !set[pk])) continue
    if (best === undefined || t.research_unit_count > best.research_unit_count) best = t
  }
  return best!
}

function researchPrerequisites(force: LuaForce, tech: string): void {
  for (const [name] of pairs(prototypes.technology[tech].prerequisites)) {
    if (!force.technologies[name as string].researched) {
      researchPrerequisites(force, name as string)
      force.technologies[name as string].researched = true
    }
  }
}

function timing(slow: boolean): LabOptions {
  // Minimum warm-up, then steady-state detection (D33): 3 windows agreeing within 3%, capped. Measurement: ≥ 20
  // cycles of the slowest machine.
  return slow
    ? { warmupTicks: 60 * 90, maxWarmupTicks: 60 * 60 * 60, steadyWindowTicks: 60 * 60, measureTicks: 60 * 300 }
    : { warmupTicks: 60 * 45, maxWarmupTicks: 60 * 60 * 15, steadyWindowTicks: 60 * 30, measureTicks: 60 * 120 }
}

function labTest(entry: CatalogEntry): void {
  const tag = entry.slow ? "validation slow" : "validation fast"
  test(`${tag}: ${entry.name}`, () => {
    let def = catalogModule(entry)
    let setupForce: ((this: void, force: LuaForce) => void) | undefined
    if (entry.generator === "lab-array") {
      // Declare the lab array for the technology it will research.
      const packs = ((entry.params?.packs as string[] | undefined) ?? []).length > 0 ? (entry.params!.packs as string[]) : undefined
      const tech = researchTarget(packs)
      def = generatedModule("lab-array", { ...(entry.params ?? {}), unitTime: tech.research_unit_energy / 60 })
      setupForce = (force) => {
        researchPrerequisites(force, tech.name)
        force.cancel_current_research()
        force.add_research(tech.name)
      }
    }
    let steadyWeights: Record<string, number> | undefined
    if (hasChests(def)) {
      steadyWeights = {}
      for (const r of def.rates.outputs) steadyWeights[r.item] = rawCost(def, r.item)
    }
    const opts: LabOptions = { ...timing(entry.slow === true), setupForce, steadyWeights, primeFuel: entry.name === COLD_START ? undefined : PRIME_FUEL, measureSteady: true }
    // A mall's products are lumpy (an assembler is worth ~22 plates): measure its plate value over 15 minutes.
    if (steadyWeights !== undefined) {
      opts.measureTicks = 60 * 60 * 15
      opts.measureSteady = false
    }
    runModuleLab(def, opts, (r) => check(entry.name, def, r))
  })
}

describe("module validation lab", () => {
  let speed = 1
  before_all(() => {
    speed = game.speed
    game.speed = SPEED
  })
  after_all(() => {
    game.speed = speed
  })
  for (const entry of V1_CATALOG) labTest(entry)

  test("validation slow: the mall makes every product (chests capped, 20 game-min)", () => {
    const def = catalogModule({ name: "mall", curated: "mall-polse" })
    runModuleLab(def, { warmupTicks: 0, measureTicks: 60 * 60 * 20, chestBar: 1 }, (r) => {
      report("mall coverage (chests capped at 1 slot, 20 min)", def, r)
      assert(r.problems.length === 0, r.problems.join(", "))
      const missing: string[] = []
      for (const p of def.ports) if (p.kind === "chest-out" && (r.measured[p.item!] ?? 0) <= 0) missing.push(p.item!)
      assert(missing.length === 0, `never made: ${missing.join(", ")}`)
    })
  })
})
