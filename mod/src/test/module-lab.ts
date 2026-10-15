import { LuaEntity, LuaForce, LuaTransportLine, MapPosition } from "factorio:runtime"
import { portOutsideTile } from "../modules/geometry"
import { rateOf } from "../modules/rates"
import { stampModule, worldPos } from "../modules/stamp"
import { ModuleDef, Port } from "../modules/types"
import { createLab, Lab } from "./lab"

// Validation lab (SPEC §5.4 step 4, T2): stamps a module into a cleared lab, feeds every input port at exactly its
// declared rate (D33) by inserting items at the back of a feeder belt, collects every output (sink belts are
// emptied each tick, output chests periodically), keeps crew-fuelled burners topped up (as the crew would), powers
// the module from an electric-energy-interface (or loads a steam block with one), waits until the output rates reach
// a steady state (sliding windows agree within a tolerance, with a cap on the warm-up) and then measures. The module
// passes at ≥ 90% of its declared output rate.

export const LAB_FORCE = "re-module-lab"
const DEBUG_BELTS = false

export interface LabOptions {
  /** Minimum warm-up before steady-state detection may end it. */
  warmupTicks: number
  measureTicks: number
  /** Input feed = declared rate × feedFactor (default 1.0, D33). */
  feedFactor?: number
  /**
   * Steady-state detection (D33): after `warmupTicks`, the warm-up ends once the output rates of the last
   * `steadyWindows` windows of `steadyWindowTicks` each agree within `steadyTolerance` (relative to their mean), or
   * at `maxWarmupTicks` (then `steady` is false in the result). Without `maxWarmupTicks` the warm-up is exactly
   * `warmupTicks`.
   */
  maxWarmupTicks?: number
  steadyWindowTicks?: number
  steadyWindows?: number
  steadyTolerance?: number
  /** Judge steadiness on this weighted sum of the outputs (malls: plate value) instead of per output. */
  steadyWeights?: Record<string, number>
  /**
   * Malls: bar every output chest to this many slots and never empty it (the crew takes only what it needs), so
   * full chests stop their assemblers and the rest of the mall gets the intermediates. Measures what each chest got.
   */
  chestBar?: number
  /** Called once the force is set up and before the module runs (e.g. to start research). */
  setupForce?: (this: void, force: LuaForce) => void
}

export interface LabResult {
  declared: Record<string, number>
  measured: Record<string, number>
  /** measured / declared per output. */
  ratio: Record<string, number>
  problems: string[]
  /** Crafting machines and labs at the end: for diagnosing a failure. */
  machines: string[]
  /** Ticks of warm-up before measuring, and whether the outputs had reached a steady state by then. */
  warmupTicks: number
  steady: boolean
  /** Output rates of the warm-up windows (items/s, worst output relative to declared), for reports. */
  windowRatios: number[]
}

export function labForce(): LuaForce {
  let force = game.forces[LAB_FORCE]
  if (force === undefined) {
    force = game.create_force(LAB_FORCE)
    for (const [, recipe] of pairs(force.recipes)) recipe.enabled = true
  }
  return force
}

interface Feeder {
  item: string
  /** Items inserted so far. */
  inserted: number
  perTick: number
  credit: number
  lines: LuaTransportLine[]
  next: number
}

function lineContents(line: LuaTransportLine, into: Record<string, number>): void {
  for (const c of line.get_contents()) into[c.name] = (into[c.name] ?? 0) + c.count
}

/** World position (tile centre) outside the footprint closest to a power port, for the lab's own pole. */
function labPolePosition(def: ModuleDef, origin: MapPosition, port: Port, taken: Record<string, boolean>): MapPosition | undefined {
  const { w, h } = def.footprint
  const cands = [
    { x: -0.5, y: port.pos.y, ox: -2, oy: 0 },
    { x: w + 0.5, y: port.pos.y, ox: 2, oy: 0 },
    { x: port.pos.x, y: -0.5, ox: 0, oy: -2 },
    { x: port.pos.x, y: h + 0.5, ox: 0, oy: 2 },
  ]
  cands.sort((a, b) => math.abs(a.x - port.pos.x) + math.abs(a.y - port.pos.y) - (math.abs(b.x - port.pos.x) + math.abs(b.y - port.pos.y)))
  for (const c of cands) {
    for (const shift of [0, 1, -1, 2, -2]) {
      const p = { x: c.x + (c.ox === 0 ? shift : 0), y: c.y + (c.oy === 0 ? shift : 0) }
      const d = math.sqrt((p.x - port.pos.x) ** 2 + (p.y - port.pos.y) ** 2)
      if (d > 7) continue
      if (taken[`${p.x},${p.y}`]) continue
      return worldPos(origin, p)
    }
  }
  return undefined
}

function dirOffset(pole: MapPosition, origin: MapPosition, def: ModuleDef): { x: number; y: number } {
  // Push the energy interface one more tile away from the module.
  const lx = pole.x - origin.x
  const ly = pole.y - origin.y
  if (lx < 0) return { x: -2, y: 0 }
  if (lx > def.footprint.w) return { x: 2, y: 0 }
  if (ly < 0) return { x: 0, y: -2 }
  return { x: 0, y: 2 }
}

/**
 * Runs the lab asynchronously (call inside a factorio-test test): `onDone` receives the measurements after
 * warmupTicks + measureTicks.
 */
export function runModuleLab(def: ModuleDef, opts: LabOptions, onDone: (this: void, result: LabResult) => void): void {
  const problems: string[] = []
  const radius = math.ceil(math.max(def.footprint.w, def.footprint.h) / 2) + 12
  const lab: Lab = createLab(radius)
  const surface = lab.surface
  const force = labForce()
  opts.setupForce?.(force)
  const origin = { x: math.floor(lab.origin.x - def.footprint.w / 2), y: math.floor(lab.origin.y - def.footprint.h / 2) }

  // Site: water for shore modules, ore under the drills.
  if (def.anchor?.water) {
    const tiles = []
    for (const r of def.anchor.water) for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) tiles.push({ name: "water", position: { x: origin.x + x, y: origin.y + y } })
    surface.set_tiles(tiles)
  }
  if (def.anchor?.miningAreas) {
    const resource = (def.anchor.resource ?? def.params?.resource) as string
    const done: Record<string, boolean> = {}
    for (const r of def.anchor.miningAreas) {
      for (let x = r.x; x < r.x + r.w; x++) {
        for (let y = r.y; y < r.y + r.h; y++) {
          const k = `${x},${y}`
          if (done[k]) continue
          done[k] = true
          surface.create_entity({ name: resource, position: { x: origin.x + x + 0.5, y: origin.y + y + 0.5 }, amount: 1000000 })
        }
      }
    }
  }

  const placed = stampModule(surface, force, def, origin)
  for (let i = 0; i < placed.length; i++) {
    if (placed[i] === undefined) problems.push(`could not place ${def.entities[i].name} at ${def.entities[i].x},${def.entities[i].y}`)
  }
  const entities: LuaEntity[] = []
  for (const e of placed) if (e !== undefined) entities.push(e)

  // Feeders and sinks just outside the belt ports.
  const taken: Record<string, boolean> = {}
  const feeders: Feeder[] = []
  const sinks: LuaEntity[] = []
  const chests: LuaEntity[] = []
  const belt = (def.params?.belt as string | undefined) ?? "transport-belt"
  const feedFactor = opts.feedFactor ?? 1.0
  for (const port of def.ports) {
    if (port.kind === "belt-in" || port.kind === "belt-out") {
      const local = portOutsideTile(port)
      taken[`${local.x},${local.y}`] = true
      const b = surface.create_entity({ name: belt, position: worldPos(origin, local), direction: port.dir as defines.direction, force })
      if (b === undefined) {
        problems.push(`no room for the ${port.kind} belt of ${port.id}`)
        continue
      }
      if (port.kind === "belt-out") sinks.push(b)
      else {
        const rate = rateOf(def.rates.inputs, port.item!)
        feeders.push({ item: port.item!, inserted: 0, perTick: rate / 60, credit: 0, lines: [b.get_transport_line(1), b.get_transport_line(2)], next: 0 })
      }
    } else if (port.kind === "chest-out") {
      const c = surface.find_entities_filtered({ position: worldPos(origin, port.pos), type: "container" })[0]
      if (c === undefined) problems.push(`no chest at ${port.id}`)
      else {
        chests.push(c)
        if (opts.chestBar !== undefined) c.get_inventory(defines.inventory.chest)!.set_bar(opts.chestBar + 1)
      }
    }
  }

  // Power: an energy interface on a pole next to the power port. A steam block's interface is its load.
  const powerOut = rateOf(def.rates.outputs, "electricity")
  const engines: LuaEntity[] = []
  for (const e of entities) if (e.type === "generator") engines.push(e)
  for (const port of def.ports) {
    if (port.kind !== "power") continue
    const polePos = labPolePosition(def, origin, port, taken)
    if (polePos === undefined) {
      problems.push("no room for the lab pole")
      break
    }
    const pole = surface.create_entity({ name: "small-electric-pole", position: polePos, force })
    const off = dirOffset(polePos, origin, def)
    // The interface is 2×2 (centre on a tile corner): next to the pole, away from the module.
    const half = (o: number): number => (o < 0 ? 0.5 : o > 0 ? -0.5 : 0.5)
    const eei = surface.create_entity({ name: "electric-energy-interface", position: { x: polePos.x + off.x + half(off.x), y: polePos.y + off.y + half(off.y) }, force })
    if (pole === undefined || eei === undefined) {
      problems.push("could not place the lab power supply")
      break
    }
    if (powerOut > 0) {
      eei.power_production = 0
      eei.power_usage = powerOut / 60
      eei.electric_buffer_size = (powerOut / 60) * 2
    } else {
      eei.power_production = 1e7
      eei.power_usage = 0
      eei.electric_buffer_size = 1e8
      eei.energy = 1e8
    }
    break
  }

  const upkeep: Record<string, boolean> = {}
  for (const u of def.upkeep?.fuel ?? []) upkeep[u.name] = true
  const fuel = "coal"

  const declared: Record<string, number> = {}
  for (const r of def.rates.outputs) declared[r.item] = r.perSecond
  const measured: Record<string, number> = {}
  const researchUnits = (): number => {
    const tech = force.current_research
    if (tech === undefined) return 0
    return force.research_progress * tech.research_unit_count
  }

  // Cumulative output since the start (sinks, chests, power, research), for steady-state windows and measuring.
  const cumulative: Record<string, number> = {}
  const add = (item: string, n: number): void => {
    cumulative[item] = (cumulative[item] ?? 0) + n
  }
  const snapshot = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [k, v] of pairs(cumulative)) out[k] = v
    if (declared["research-unit"] !== undefined) out["research-unit"] = researchUnits()
    for (const f of feeders) out[`feed:${f.item}`] = f.inserted
    return out
  }

  const windowTicks = opts.steadyWindowTicks ?? 60 * 30
  const windowsNeeded = opts.steadyWindows ?? 3
  const tolerance = opts.steadyTolerance ?? 0.03
  const maxWarmup = opts.maxWarmupTicks ?? opts.warmupTicks
  const windowRatios: number[] = []
  const windowRates: Record<string, number>[] = []
  let lastSnap = snapshot()
  let warmupEnd: number | undefined = maxWarmup === opts.warmupTicks ? opts.warmupTicks : undefined
  let steady = maxWarmup === opts.warmupTicks
  let measureStart: Record<string, number> = {}

  // Steady (D33): the mean output rate of the last `windowsNeeded` windows is within `tolerance` of the mean of the
  // group before it (per output, or of the weighted sum), and over the last group every feeder delivered its
  // scheduled items (a backed-up input means the module is not yet, or never, consuming at its declared rate).
  const groupMean = (key: (this: void, rates: Record<string, number>) => number, from: number): number => {
    let sum = 0
    for (let i = from; i < from + windowsNeeded; i++) sum += key(windowRates[i])
    return sum / windowsNeeded
  }
  const isSteady = (): boolean => {
    const n = windowRates.length
    if (n < 2 * windowsNeeded) return false
    const keys: ((this: void, rates: Record<string, number>) => number)[] = []
    const weights = opts.steadyWeights
    if (weights !== undefined) {
      keys.push((rates) => {
        let v = 0
        for (const [item, w] of pairs(weights)) v += (rates[item] ?? 0) * w
        return v
      })
    } else for (const [item] of pairs(declared)) keys.push((rates) => rates[item] ?? 0)
    for (const key of keys) {
      const last = groupMean(key, n - windowsNeeded)
      const prev = groupMean(key, n - 2 * windowsNeeded)
      if (last <= 0 || math.abs(last - prev) > tolerance * last) return false
    }
    for (const f of feeders) {
      const scheduled = f.perTick * feedFactor * 60
      if (groupMean((rates) => rates[`feed:${f.item}`] ?? 0, n - windowsNeeded) < (1 - tolerance) * scheduled) return false
    }
    return true
  }

  let tick = 0
  async(maxWarmup + opts.measureTicks + 600)
  on_tick(() => {
    tick++
    for (const f of feeders) {
      f.credit = math.min(f.credit + f.perTick * feedFactor, 20)
      while (f.credit >= 1) {
        let inserted = false
        for (let k = 0; k < 2; k++) {
          const line = f.lines[(f.next + k) % 2]
          if (line.can_insert_at_back() && line.insert_at_back({ name: f.item, count: 1 })) {
            f.next = (f.next + k + 1) % 2
            f.inserted++
            inserted = true
            break
          }
        }
        if (!inserted) break
        f.credit -= 1
      }
    }
    for (const s of sinks) {
      for (const i of [1, 2]) {
        const line = s.get_transport_line(i)
        const c: Record<string, number> = {}
        lineContents(line, c)
        for (const [item, n] of pairs(c)) add(item, n)
        line.clear()
      }
    }
    if (opts.chestBar === undefined && tick % 60 === 0) {
      for (const c of chests) {
        const inv = c.get_inventory(defines.inventory.chest)!
        for (const it of inv.get_contents()) add(it.name, it.count)
        inv.clear()
      }
    }
    if (tick % 60 === 0) {
      for (const e of entities) {
        if (!e.valid || !upkeep[e.name]) continue
        const fi = e.get_fuel_inventory()
        if (fi !== undefined && fi.is_empty()) fi.insert({ name: fuel, count: 5 })
      }
    }
    for (const e of engines) add("electricity", e.energy_generated_last_tick)

    if (warmupEnd === undefined) {
      if (tick % windowTicks === 0) {
        const snap = snapshot()
        const rates: Record<string, number> = {}
        let worst = math.huge
        for (const [item, v] of pairs(snap)) rates[item] = ((v - (lastSnap[item] ?? 0)) / windowTicks) * 60
        for (const [item, d] of pairs(declared)) worst = math.min(worst, (rates[item] ?? 0) / d)
        windowRates.push(rates)
        windowRatios.push(worst)
        lastSnap = snap
        if (tick >= opts.warmupTicks && isSteady()) {
          warmupEnd = tick
          steady = true
        } else if (tick >= maxWarmup) warmupEnd = tick
        if (warmupEnd !== undefined) measureStart = snapshot()
      }
      return
    }
    if (tick === warmupEnd) measureStart = snapshot()
    if (tick < warmupEnd + opts.measureTicks) return
    for (const c of chests) for (const it of c.get_inventory(defines.inventory.chest)!.get_contents()) add(it.name, it.count)
    // A capped mall counts everything its chests got since the start.
    if (opts.chestBar !== undefined) measureStart = {}
    const end = snapshot()
    const seconds = opts.chestBar !== undefined ? tick / 60 : opts.measureTicks / 60
    for (const [item, n] of pairs(end)) measured[item] = (n - (measureStart[item] ?? 0)) / seconds
    const ratio: Record<string, number> = {}
    for (const [item, d] of pairs(declared)) ratio[item] = (measured[item] ?? 0) / d
    const machines: string[] = []
    const statusNames: Record<number, string> = {}
    for (const [k, v] of pairs(defines.entity_status)) statusNames[v as unknown as number] = k as string
    for (const e of entities) {
      if (!e.valid || (e.type !== "assembling-machine" && e.type !== "furnace" && e.type !== "lab" && e.type !== "mining-drill" && e.type !== "inserter")) continue
      const status = e.status !== undefined ? (statusNames[e.status as unknown as number] ?? tostring(e.status)) : "?"
      const finished = e.type === "assembling-machine" || e.type === "furnace" ? e.products_finished : 0
      machines.push(`${e.name}@${e.position.x - origin.x},${e.position.y - origin.y} done=${finished} status=${status}`)
    }
    if (DEBUG_BELTS) {
      for (const e of entities) {
        if (!e.valid || e.type !== "transport-belt") continue
        const c: Record<string, number> = {}
        lineContents(e.get_transport_line(1), c)
        const l = serpent.line(c)
        const c2: Record<string, number> = {}
        lineContents(e.get_transport_line(2), c2)
        machines.push(`belt@${e.position.x - origin.x},${e.position.y - origin.y} L=${l} R=${serpent.line(c2)}`)
      }
    }
    onDone({ declared, measured, ratio, problems, machines, warmupTicks: warmupEnd, steady, windowRatios })
    done()
    return false
  })
}
