// B67/M7d.5 debug: compare the layout's pole graph with the built world for a module or role. The reconciler reads the
// layout; the game reads electric networks, and the two disagree when a connecting pole is in the layout but neither
// built nor a ghost. Plain data only (remote interface), no decisions.

import { LuaEntity } from "factorio:runtime"
import { getJob } from "../jobs/board"
import { factionSurface, getFaction } from "../jobs/faction"
import { prototypeFacts } from "../modules/prototype-facts"
import { unpoweredModules } from "../planner/power"
import type { LayoutState } from "../planner/layout"
import { getFactory } from "./factory"

function poleAt(surface: ReturnType<typeof factionSurface>, force: string, name: string, x: number, y: number): LuaEntity | undefined {
  return surface.find_entities_filtered({ name, position: { x: x + 0.5, y: y + 0.5 }, force, limit: 1 })[0]
}

function ghostAt(surface: ReturnType<typeof factionSurface>, force: string, name: string, x: number, y: number): LuaEntity | undefined {
  return surface.find_entities_filtered({ ghost_name: name, position: { x: x + 0.5, y: y + 0.5 }, force, limit: 1 })[0]
}

function poleText(surface: ReturnType<typeof factionSurface>, force: string, name: string, x: number, y: number, faction: ReturnType<typeof getFaction>): string {
  const built = poleAt(surface, force, name, x, y)
  const ghost = ghostAt(surface, force, name, x, y)
  if (built !== undefined) return `built net=${tostring(built.electric_network_id)}`
  if (ghost !== undefined) {
    // A ghost with no open place job will never be built (M7d.5 diagnosis).
    const id = ghost.unit_number !== undefined ? faction?.ghostJobs[ghost.unit_number] : undefined
    const job = id !== undefined && faction !== undefined ? getJob(faction.board, id) : undefined
    if (job !== undefined) return `ghost job=${job.status}`
    return id !== undefined ? `ghost job=STALE(${tostring(id)})` : "ghost job=none"
  }
  return "MISSING"
}

function boxDistance(m: { x: number; y: number; w: number; h: number }, x: number, y: number): number {
  const dx = math.max(m.x - x, x - (m.x + m.w - 1), 0)
  const dy = math.max(m.y - y, y - (m.y + m.h - 1), 0)
  return dx + dy
}

/** A text report for `power_debug`: the unpowered modules, a module's own poles/machines, and the nearby pole lines. */
export function factoryPowerDebug(name: string, filter = ""): string {
  const f = getFactory(name)
  const faction = getFaction(name)
  if (f === undefined || faction === undefined) return "no factory"
  const surface = factionSurface(faction)
  const force = faction.force
  const layout: LayoutState = f.layout
  const unpowered = unpoweredModules(layout, prototypeFacts)
  const out: string[] = [`unpowered=${unpowered.join(",")}`]
  const targets = layout.modules.filter((m) => {
    if (filter === "") return true
    if (string.find(m.id, filter, 1, true)[0] !== undefined) return true
    const role = f.graph.nodes[m.id]?.role ?? ""
    return string.find(role, filter, 1, true)[0] !== undefined
  })
  for (const m of targets) {
    const node = f.graph.nodes[m.id]
    out.push(`module ${m.id} role=${node?.role ?? "?"} rect=${m.rect.x},${m.rect.y},${m.rect.w}x${m.rect.h} lifecycle=${node?.lifecycle ?? "?"} unpowered=${unpowered.indexOf(m.id) >= 0}`)
    for (const e of m.def.entities) {
      if (prototypeFacts.entity(e.name)?.type !== "electric-pole") continue
      const x = math.floor(m.origin.x + e.x)
      const y = math.floor(m.origin.y + e.y)
      out.push(`  own ${e.name}@${x},${y} ${poleText(surface, force, e.name, x, y, faction)}`)
    }
    for (const e of m.def.entities) {
      const p = prototypeFacts.entity(e.name)
      if (p === undefined || (p.type !== "assembling-machine" && p.type !== "furnace" && p.type !== "lab" && p.type !== "mining-drill")) continue
      const x = math.floor(m.origin.x + e.x)
      const y = math.floor(m.origin.y + e.y)
      const built = surface.find_entities_filtered({ name: e.name, position: { x: x + 0.5, y: y + 0.5 }, force, limit: 1 })[0]
      if (built !== undefined) out.push(`  machine ${e.name}@${x},${y} net=${tostring(built.electric_network_id)} status=${tostring(built.status)}`)
    }
  }
  // Lines near a target: the connecting line is the prime suspect (a layout pole that is neither built nor a ghost).
  const near: Record<string, boolean> = {}
  for (const m of targets) for (const p of layout.poles ?? []) if (boxDistance(m.rect, p.x, p.y) <= 48) near[p.line] = true
  for (const line of layout.poleLines ?? []) {
    if (near[line.id] !== true) continue
    const poles = (layout.poles ?? []).filter((p) => p.line === line.id)
    const missing: string[] = []
    let built = 0
    let ghost = 0
    for (const p of poles) {
      const t = poleText(surface, force, p.name, p.x, p.y, faction)
      if (t === "MISSING") missing.push(`${p.name}@${p.x},${p.y}`)
      else if (string.sub(t, 1, 5) === "ghost") ghost++
      else built++
    }
    out.push(`line ${line.id} ${line.from}=>${line.to} poles=${poles.length} built=${built} ghost=${ghost} missing=${missing.length}${missing.length > 0 ? ` first=${missing.slice(0, 4).join(";")}` : ""}`)
    // The line's own poles: their built network names the island they actually joined.
    for (let i = 0; i < math.min(6, poles.length); i++) {
      const p = poles[i]
      const b = poleAt(surface, force, p.name, p.x, p.y)
      out.push(`  lp ${p.name}@${p.x},${p.y} ${poleText(surface, force, p.name, p.x, p.y, faction)}${b !== undefined ? ` wires=${tostring((b.get_wire_connector(defines.wire_connector_id.pole_copper, false)?.connection_count) ?? -1)}` : ""}`)
    }
  }
  // The built networks' sizes, to name the islands.
  const sizes: Record<string, number> = {}
  for (const p of surface.find_entities_filtered({ force, type: "electric-pole" })) {
    const n = tostring(p.electric_network_id ?? -1)
    sizes[n] = (sizes[n] ?? 0) + 1
  }
  const nets: string[] = []
  for (const [n, c] of pairs(sizes)) nets.push(`${n}:${c}`)
  nets.sort()
  out.push(`networks=${nets.join(",")}`)
  return out.join("\n")
}
