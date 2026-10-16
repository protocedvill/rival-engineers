import { Color } from "factorio:runtime"
import { findModule, findPort, portTile } from "../planner/layout"
import { NodeStatus, rateIn } from "../planner/logical"
import { getFactory } from "../strategy/factory"
import { OverlayContext, registerOverlayLayer } from "./overlay"

// In-game Factory Graph overlay (SPEC §5.8 D29, M5b): each built module's box coloured by its reconciler status with
// its role, status and measured / planned output; each belt edge as a line between its ports with measured / planned
// items/s; a node's root cause under its box. Drawn for the inspecting player only (review/overlay.ts).

const STATUS_COLOR: Record<NodeStatus, Color> = {
  unknown: { r: 0.6, g: 0.6, b: 0.6 },
  ok: { r: 0.2, g: 0.9, b: 0.2 },
  // D49: crew-supplied by design (hand-fed labs): neutral, not a problem colour.
  expected: { r: 0.85, g: 0.85, b: 0.85 },
  starved: { r: 1, g: 0.75, b: 0.1 },
  "backed-up": { r: 0.3, g: 0.55, b: 1 },
  unpowered: { r: 0.85, g: 0.3, b: 1 },
  unfuelled: { r: 1, g: 0.25, b: 0.2 },
}

const MAX_NODES = 80
const MAX_EDGES = 120

function fmt(x: number | undefined): string {
  return x === undefined ? "?" : string.format("%.2g", x)
}

function drawGraph(ctx: OverlayContext): void {
  const f = getFactory(ctx.faction.name)
  if (f === undefined) return
  const players = [ctx.player]
  const surface = ctx.faction.surface
  const { ttl, add } = ctx
  let n = 0
  for (const id of f.graph.nodeOrder) {
    if (n++ >= MAX_NODES) break
    const node = f.graph.nodes[id]
    const m = findModule(f.layout, id)
    if (m === undefined) continue
    const built = node.lifecycle === "built"
    const color = built ? STATUS_COLOR[node.status] : { r: 0.5, g: 0.5, b: 0.5, a: 0.5 }
    add(rendering.draw_rectangle({ color, width: built ? 3 : 1, filled: false, left_top: { x: m.rect.x, y: m.rect.y }, right_bottom: { x: m.rect.x + m.rect.w, y: m.rect.y + m.rect.h }, surface, players, time_to_live: ttl }))
    const item = node.item ?? ""
    const out = node.measured !== undefined ? rateIn(node.measured.outputs, item) : undefined
    const planned = rateIn(node.planned.outputs, item)
    const rate = node.kind === "power" ? `load ${math.floor((node.measured?.load ?? 0) * 100)}%` : `${fmt(out)}/${fmt(planned)}/s`
    const text = built ? `${node.role}: ${node.status} · ${rate}` : `${node.role}: ${node.lifecycle}`
    add(rendering.draw_text({ text, surface, target: { x: m.rect.x + 0.2, y: m.rect.y - 0.9 }, color, scale: 1, players, time_to_live: ttl }))
    if (node.cause !== undefined) {
      add(rendering.draw_text({ text: `→ ${node.cause.kind}${node.cause.id !== undefined ? ` ${node.cause.id}` : ""}: ${node.cause.what}`, surface, target: { x: m.rect.x + 0.2, y: m.rect.y + m.rect.h + 0.1 }, color, scale: 0.9, players, time_to_live: ttl }))
    }
  }
  let k = 0
  for (const id of f.graph.edgeOrder) {
    if (k >= MAX_EDGES) break
    const e = f.graph.edges[id]
    if (e.kind !== "belt" || e.from === undefined) continue
    const a = findModule(f.layout, e.from)
    const b = findModule(f.layout, e.to)
    const pa = a !== undefined && e.fromPort !== undefined ? findPort(a, e.fromPort) : undefined
    const pb = b !== undefined && e.toPort !== undefined ? findPort(b, e.toPort) : undefined
    if (a === undefined || b === undefined || pa === undefined || pb === undefined) continue
    k++
    const ta = portTile(a, pa)
    const tb = portTile(b, pb)
    const from = { x: ta.x + 0.5, y: ta.y + 0.5 }
    const to = { x: tb.x + 0.5, y: tb.y + 0.5 }
    const measured = e.measuredRate !== undefined
    const low = measured && e.measuredRate! < 0.75 * e.plannedRate
    const color: Color = !measured ? { r: 0.7, g: 0.7, b: 0.7, a: 0.6 } : low ? { r: 1, g: 0.6, b: 0.1 } : { r: 0.3, g: 0.9, b: 0.9 }
    add(rendering.draw_line({ color, width: 2, gap_length: 0.5, dash_length: 0.8, from, to, surface, players, time_to_live: ttl }))
    add(rendering.draw_text({ text: `${e.item} ${fmt(e.measuredRate)}/${fmt(e.plannedRate)}/s`, surface, target: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, color, scale: 0.9, alignment: "center", players, time_to_live: ttl }))
  }
}

registerOverlayLayer("factory-graph", "Factory graph (status, measured/planned rates)", drawGraph)
