// Greedy small-pole placement inside a module footprint: cover every electric entity, keep the poles connected
// (each new pole within wire reach of an earlier one). Deterministic (candidates scanned in row-major order).
// Pure: no Factorio globals.

import { ProtoFacts } from "./facts"
import { entityRect, tileKey } from "./geometry"
import { ModuleEntity } from "./types"

interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Approximate collision box: 1×1 entities are small (±0.15 around the centre), bigger ones fill their tiles less 0.3. */
function collisionBox(e: ModuleEntity, facts: ProtoFacts): Box {
  const r = entityRect(e, facts)
  if (r.w === 1 && r.h === 1) return { x1: e.x - 0.15, y1: e.y - 0.15, x2: e.x + 0.15, y2: e.y + 0.15 }
  return { x1: r.x + 0.3, y1: r.y + 0.3, x2: r.x + r.w - 0.3, y2: r.y + r.h - 0.3 }
}

function covers(cx: number, cy: number, d: number, b: Box): boolean {
  return b.x2 > cx - d && b.x1 < cx + d && b.y2 > cy - d && b.y1 < cy + d
}

/** Entities that need a pole: electric consumers and generators. */
export function needsPower(e: ModuleEntity, facts: ProtoFacts): boolean {
  const f = facts.entity(e.name)
  if (!f) return false
  return f.electric === true || f.type === "generator"
}

/**
 * Returns new pole entities (in module-local coordinates) covering every powered entity of `entities` inside
 * `footprint`, or errors if it can't. `blocked` tiles (keys "x,y") are never used.
 */
export function placePoles(
  footprint: { w: number; h: number },
  entities: ModuleEntity[],
  facts: ProtoFacts,
  pole = "small-electric-pole",
  blocked: Record<string, boolean> = {},
): ModuleEntity[] {
  const pf = facts.entity(pole)
  const d = pf?.supplyDistance ?? 2.5
  const reach = pf?.wireReach ?? 7.5
  const occupied: Record<string, boolean> = {}
  for (const e of entities) {
    const r = entityRect(e, facts)
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) occupied[tileKey(x, y)] = true
  }
  const consumers: Box[] = []
  for (const e of entities) if (needsPower(e, facts)) consumers.push(collisionBox(e, facts))
  const covered: boolean[] = consumers.map(() => false)
  // Consumers already covered by poles present in the layout.
  const poles: { x: number; y: number }[] = []
  for (const e of entities) {
    if (facts.entity(e.name)?.type === "electric-pole") {
      poles.push({ x: e.x, y: e.y })
      const pd = facts.entity(e.name)?.supplyDistance ?? d
      for (let i = 0; i < consumers.length; i++) if (covers(e.x, e.y, pd, consumers[i])) covered[i] = true
    }
  }
  const candidates: { x: number; y: number }[] = []
  for (let y = 0; y < footprint.h; y++) {
    for (let x = 0; x < footprint.w; x++) {
      const k = tileKey(x, y)
      if (!occupied[k] && !blocked[k]) candidates.push({ x: x + 0.5, y: y + 0.5 })
    }
  }
  const placed: ModuleEntity[] = []
  const used: Record<string, boolean> = {}
  const remaining = (): number => {
    let n = 0
    for (const c of covered) if (!c) n++
    return n
  }
  for (let guard = 0; guard < 1000 && remaining() > 0; guard++) {
    let best: { x: number; y: number } | undefined
    let bestGain = -1
    let bestDist = math.huge
    for (const c of candidates) {
      const k = tileKey(c.x, c.y)
      if (used[k]) continue
      if (poles.length > 0) {
        let connected = false
        for (const p of poles) {
          const dx = p.x - c.x
          const dy = p.y - c.y
          if (dx * dx + dy * dy <= reach * reach + 1e-9) {
            connected = true
            break
          }
        }
        if (!connected) continue
      }
      let gain = 0
      let nearest = math.huge
      for (let i = 0; i < consumers.length; i++) {
        if (covered[i]) continue
        const b = consumers[i]
        if (covers(c.x, c.y, d, b)) gain++
        else {
          const dx = Math.max(b.x1 - c.x, 0, c.x - b.x2)
          const dy = Math.max(b.y1 - c.y, 0, c.y - b.y2)
          nearest = Math.min(nearest, dx * dx + dy * dy)
        }
      }
      if (gain > bestGain || (gain === bestGain && gain === 0 && nearest < bestDist)) {
        best = c
        bestGain = gain
        bestDist = nearest
      }
    }
    if (best === undefined) error(`placePoles: no connected free tile left; ${remaining()} consumers unpowered`)
    used[tileKey(best.x, best.y)] = true
    poles.push(best)
    placed.push({ name: pole, x: best.x, y: best.y })
    for (let i = 0; i < consumers.length; i++) if (!covered[i] && covers(best.x, best.y, d, consumers[i])) covered[i] = true
  }
  if (remaining() > 0) error(`placePoles: gave up with ${remaining()} consumers unpowered`)
  return placed
}

/**
 * Power check for a layout: powered entities no pole covers, and the number of separate pole networks
 * (poles connect within wire reach). A well-formed module has no unpowered entities and at most one network.
 */
export function powerCheck(entities: ModuleEntity[], facts: ProtoFacts): { unpowered: string[]; networks: number } {
  const poles: { x: number; y: number; d: number; reach: number }[] = []
  for (const e of entities) {
    const f = facts.entity(e.name)
    if (f?.type === "electric-pole") poles.push({ x: e.x, y: e.y, d: f.supplyDistance ?? 2.5, reach: f.wireReach ?? 7.5 })
  }
  const unpowered: string[] = []
  for (const e of entities) {
    if (!needsPower(e, facts)) continue
    const b = collisionBox(e, facts)
    let ok = false
    for (const p of poles) if (covers(p.x, p.y, p.d, b)) ok = true
    if (!ok) unpowered.push(`${e.name}@${e.x},${e.y}`)
  }
  // Union-find over poles.
  const parent: number[] = poles.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i]
    return i
  }
  for (let i = 0; i < poles.length; i++) {
    for (let j = i + 1; j < poles.length; j++) {
      const dx = poles[i].x - poles[j].x
      const dy = poles[i].y - poles[j].y
      const r = Math.min(poles[i].reach, poles[j].reach)
      if (dx * dx + dy * dy <= r * r + 1e-9) parent[find(i)] = find(j)
    }
  }
  let networks = 0
  for (let i = 0; i < poles.length; i++) if (find(i) === i) networks++
  return { unpowered, networks }
}
