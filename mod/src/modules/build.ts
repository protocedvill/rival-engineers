// Turning a layout (generated or curated) into a complete ModuleDef: computed rates, machines, recipes,
// required technologies, crew upkeep and per-unit expansion data. Also `expandModule`, the one implementation of
// `ModuleDef.expand` semantics. Pure: no Factorio globals.

import { ProtoFacts } from "./facts"
import { beltLeaks, occupancy, outsideFootprint } from "./geometry"
import { computeRates, RateOptions } from "./rates"
import { MachineCount, ModuleDef, ModuleEntity, ModuleExpand, ModuleRates, Port, Rate, Rect } from "./types"

/** A layout before its computed fields are filled in. */
export interface ModuleDraft {
  id: string
  source: "curated" | "generated"
  generator?: string
  provenance?: string
  description?: string
  footprint: { w: number; h: number }
  entities: ModuleEntity[]
  ports: Port[]
  recipe?: string
  rotatable: boolean
  mirrorable: boolean
  site?: "shore" | "resource-patch"
  anchor?: ModuleDef["anchor"]
  params?: Record<string, number | string>
  expand?: { unit: ModuleExpand["unit"]; axis: "x" | "y"; insertAt: number; maxUnits: number }
  notes?: string[]
}

/** Rate options a module carries in its params: `resource`, `unitTime`, `packs` (comma-separated). */
export function rateOptionsOf(params: Record<string, number | string> | undefined): RateOptions {
  const opts: RateOptions = {}
  if (!params) return opts
  if (typeof params.resource === "string") opts.resource = params.resource
  if (typeof params.unitTime === "number") opts.researchUnitTime = params.unitTime
  if (typeof params.packs === "string") {
    opts.researchPacks = params.packs.split(",")
  }
  return opts
}

function shiftEntity(e: ModuleEntity, axis: "x" | "y", d: number): ModuleEntity {
  return axis === "x" ? { ...e, x: e.x + d } : { ...e, y: e.y + d }
}

/**
 * Expands a layout by `k` units (ModuleExpand semantics, see types.ts): entities and ports at or beyond `insertAt`
 * on the axis shift by k × unit size, and k copies of the unit fill the gap.
 */
export function expandLayout(
  layout: { footprint: { w: number; h: number }; entities: ModuleEntity[]; ports: Port[] },
  spec: { unit: ModuleExpand["unit"]; axis: "x" | "y"; insertAt: number },
  k: number,
): { footprint: { w: number; h: number }; entities: ModuleEntity[]; ports: Port[] } {
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const d = k * size
  const entities: ModuleEntity[] = []
  for (const e of layout.entities) {
    const c = spec.axis === "x" ? e.x : e.y
    entities.push(c >= spec.insertAt ? shiftEntity(e, spec.axis, d) : { ...e })
  }
  for (let i = 0; i < k; i++) {
    for (const e of spec.unit.entities) entities.push(shiftEntity(e, spec.axis, spec.insertAt + i * size))
  }
  const ports = layout.ports.map((p) => {
    const c = spec.axis === "x" ? p.pos.x : p.pos.y
    if (c < spec.insertAt) return { ...p, pos: { ...p.pos } }
    return { ...p, pos: spec.axis === "x" ? { x: p.pos.x + d, y: p.pos.y } : { x: p.pos.x, y: p.pos.y + d } }
  })
  const footprint = spec.axis === "x" ? { w: layout.footprint.w + d, h: layout.footprint.h } : { w: layout.footprint.w, h: layout.footprint.h + d }
  return { footprint, entities, ports }
}

function diffRates(a: Rate[], b: Rate[]): Rate[] {
  const out: Rate[] = []
  const base: Record<string, number> = {}
  for (const r of b) base[r.item] = r.perSecond
  for (const r of a) {
    const v = r.perSecond - (base[r.item] ?? 0)
    if (Math.abs(v) > 1e-9) out.push({ item: r.item, perSecond: v, kind: r.kind })
  }
  return out
}

function diffMachines(a: MachineCount[], b: MachineCount[]): MachineCount[] {
  const base: Record<string, number> = {}
  for (const m of b) base[m.name] = m.count
  const out: MachineCount[] = []
  for (const m of a) if (m.count - (base[m.name] ?? 0) !== 0) out.push({ name: m.name, count: m.count - (base[m.name] ?? 0) })
  return out
}

/** Mining areas of the layout's drills (module-local, tile-aligned). */
export function miningAreas(entities: ModuleEntity[], facts: ProtoFacts): Rect[] {
  const out: Rect[] = []
  for (const e of entities) {
    const f = facts.entity(e.name)
    if (!f || f.type !== "mining-drill" || f.miningRadius === undefined) continue
    const rad = f.miningRadius
    const x = Math.floor(e.x - rad + 0.01)
    const y = Math.floor(e.y - rad + 0.01)
    out.push({ x, y, w: Math.ceil(e.x + rad - 0.01) - x, h: Math.ceil(e.y + rad - 0.01) - y })
  }
  return out
}

/** Technologies needed to build a layout: unlocks of the machines' recipes and of every placed item's recipe. */
export function requiredTech(entities: ModuleEntity[], facts: ProtoFacts): string[] {
  const techs: Record<string, boolean> = {}
  const seenRecipe: Record<string, boolean> = {}
  const need = (recipe: string | undefined): void => {
    if (recipe === undefined || seenRecipe[recipe]) return
    seenRecipe[recipe] = true
    const t = facts.unlockedBy(recipe)
    if (t !== undefined) techs[t] = true
  }
  for (const e of entities) {
    need(e.recipe)
    const item = facts.itemToPlace(e.name)
    if (item !== undefined) need(facts.recipeForItem(item))
  }
  const out: string[] = []
  for (const [t] of pairs(techs)) out.push(t)
  out.sort()
  return out
}

/**
 * `checkBelts` (B25): refuse a layout whose belts run out of the footprint with no belt-out port. Only growth of a
 * module that already leaks turns it off (a module planned before the B25 fix and kept in an old save's storage).
 */
export function finalizeModule(draft: ModuleDraft, facts: ProtoFacts, checkBelts = true): ModuleDef {
  occupancy(draft.entities, facts) // errors on overlaps
  const outside = outsideFootprint(draft, facts)
  if (outside !== undefined) error(`module ${draft.id}: ${outside} is outside the ${draft.footprint.w}×${draft.footprint.h} footprint`)
  // B25: no belt may spill items out of the module except through a belt-out port.
  const leaks = checkBelts ? beltLeaks(draft, facts) : []
  if (leaks.length > 0) error(`module ${draft.id}: ${leaks.join("; ")}`)
  const opts = rateOptionsOf(draft.params)
  const report = computeRates(draft.entities, draft.ports, facts, opts)
  const recipes: Record<string, boolean> = {}
  for (const e of draft.entities) if (e.recipe !== undefined) recipes[e.recipe] = true
  const recipeList: string[] = []
  for (const [r] of pairs(recipes)) recipeList.push(r)
  recipeList.sort()
  const def: ModuleDef = {
    id: draft.id,
    source: draft.source,
    generator: draft.generator,
    provenance: draft.provenance,
    description: draft.description,
    footprint: { ...draft.footprint },
    entities: draft.entities,
    ports: draft.ports,
    recipe: draft.recipe,
    recipes: recipeList,
    machines: report.machines,
    rates: report.rates,
    requiresTech: requiredTech(draft.entities, facts),
    rotatable: draft.rotatable,
    mirrorable: draft.mirrorable,
    site: draft.site,
    anchor: draft.anchor,
    params: draft.params,
    notes: draft.notes,
  }
  const areas = miningAreas(draft.entities, facts)
  if (areas.length > 0) def.anchor = { ...(def.anchor ?? {}), miningAreas: areas }
  if (report.upkeepFuel.length > 0) def.upkeep = { fuel: report.upkeepFuel }
  if (report.warnings.length > 0) def.notes = [...(def.notes ?? []), ...report.warnings.map((w) => `rates: ${w}`)]
  if (draft.expand) {
    const grown = expandLayout(draft, draft.expand, 1)
    const grownReport = computeRates(grown.entities, grown.ports, facts, opts)
    const perUnit: { rates: ModuleRates; machines: MachineCount[] } = {
      rates: { inputs: diffRates(grownReport.rates.inputs, report.rates.inputs), outputs: diffRates(grownReport.rates.outputs, report.rates.outputs) },
      machines: diffMachines(grownReport.machines, report.machines),
    }
    def.expand = { unit: draft.expand.unit, axis: draft.expand.axis, insertAt: draft.expand.insertAt, maxUnits: draft.expand.maxUnits, perUnit, ports: "shift" }
  }
  return def
}

/**
 * The module grown by `k` units at the HEAD (0 ≤ k ≤ maxUnits): the k new units fill the space before 0 on the
 * axis and every existing entity/ port shifts by +k × unit size. Mirror image of `expandModule` (which grows the
 * tail). Used for "grow in any direction" (D52/OutpostPlanner): a mine on the edge of an irregular patch grows back
 * toward the ore, not just away from it.
 *
 * B25: undefined when growing at the head would leave a belt pointing out of the module with no port there (row
 * modules and outposts keep a port or a closed belt end at the head: the new head units' belts would run off the edge).
 */
export function expandHeadModule(def: ModuleDef, k: number, facts: ProtoFacts): ModuleDef | undefined {
  const spec = def.expand
  if (!spec) error(`module ${def.id} has no expand`)
  if (k < 0 || k > spec.maxUnits) error(`module ${def.id}: can grow by 0..${spec.maxUnits} units, not ${k}`)
  if (k === 0) return def
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const d = k * size
  const entities: ModuleEntity[] = []
  for (const e of def.entities) entities.push(shiftEntity(e, spec.axis, d))
  for (let i = 0; i < k; i++) for (const e of spec.unit.entities) entities.push(shiftEntity(e, spec.axis, i * size))
  const ports = def.ports.map((p) => (spec.axis === "x" ? { ...p, pos: { x: p.pos.x + d, y: p.pos.y } } : { ...p, pos: { x: p.pos.x, y: p.pos.y + d } }))
  const footprint = spec.axis === "x" ? { w: def.footprint.w + d, h: def.footprint.h } : { w: def.footprint.w, h: def.footprint.h + d }
  if (beltLeaks({ footprint, entities, ports }, facts).length > 0) return undefined
  const params = { ...(def.params ?? {}), expandedBy: ((def.params?.expandedBy as number | undefined) ?? 0) + k }
  return finalizeModule(
    {
      id: `${def.id}+h${k}`,
      source: def.source,
      generator: def.generator,
      provenance: def.provenance,
      description: def.description,
      footprint,
      entities,
      ports,
      recipe: def.recipe,
      rotatable: def.rotatable,
      mirrorable: def.mirrorable,
      site: def.site,
      anchor: def.anchor,
      params,
      notes: def.notes?.filter((n) => !n.startsWith("rates:")),
      expand: { unit: spec.unit, axis: spec.axis, insertAt: spec.insertAt + d, maxUnits: spec.maxUnits - k },
    },
    facts,
  )
}

/**
 * The module grown by `k` units (0 ≤ k ≤ maxUnits), as a complete ModuleDef with recomputed rates. The result's
 * `expand` allows maxUnits − k more. Entities at or beyond `insertAt` (the "tail") move: when growing a module that
 * is already built, the planner removes and re-places exactly those (see `expandTail`).
 */
export function expandModule(def: ModuleDef, k: number, facts: ProtoFacts): ModuleDef {
  const spec = def.expand
  if (!spec) error(`module ${def.id} has no expand`)
  if (k < 0 || k > spec.maxUnits) error(`module ${def.id}: can grow by 0..${spec.maxUnits} units, not ${k}`)
  if (k === 0) return def
  const grown = expandLayout(def, spec, k)
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const params = { ...(def.params ?? {}), expandedBy: ((def.params?.expandedBy as number | undefined) ?? 0) + k }
  return finalizeModule(
    {
      id: `${def.id}+${k}`,
      source: def.source,
      generator: def.generator,
      provenance: def.provenance,
      description: def.description,
      footprint: grown.footprint,
      entities: grown.entities,
      ports: grown.ports,
      recipe: def.recipe,
      rotatable: def.rotatable,
      mirrorable: def.mirrorable,
      site: def.site,
      anchor: def.anchor,
      params,
      notes: def.notes?.filter((n) => !n.startsWith("rates:")),
      expand: { unit: spec.unit, axis: spec.axis, insertAt: spec.insertAt + k * size, maxUnits: spec.maxUnits - k },
    },
    facts,
    beltLeaks(def, facts).length === 0,
  )
}

/** Entities that move when `def` grows (at or beyond insertAt): the planner removes and re-places them. */
export function expandTail(def: ModuleDef): ModuleEntity[] {
  const spec = def.expand
  if (!spec) return []
  return def.entities.filter((e) => (spec.axis === "x" ? e.x : e.y) >= spec.insertAt)
}

/**
 * How to grow a module that is already built by k units with the fewest entities moved. Either the tail (entities
 * at or beyond insertAt) moves forward and the origin stays, or the head (before insertAt) moves back and the
 * origin shifts by −k × unit size along the axis. `moved` is in `def`'s (pre-growth) local coordinates; place
 * `expandModule(def, k)` at `origin + originShift`. Coordinates are canonical (apply transforms afterwards).
 */
export function expandMoves(def: ModuleDef, k: number): { moved: ModuleEntity[]; originShift: { x: number; y: number } } {
  const spec = def.expand
  if (!spec) error(`module ${def.id} has no expand`)
  const size = spec.axis === "x" ? spec.unit.footprint.w : spec.unit.footprint.h
  const tail = expandTail(def)
  const head = def.entities.filter((e) => (spec.axis === "x" ? e.x : e.y) < spec.insertAt)
  if (head.length < tail.length) return { moved: head, originShift: spec.axis === "x" ? { x: -k * size, y: 0 } : { x: 0, y: -k * size } }
  return { moved: tail, originShift: { x: 0, y: 0 } }
}
