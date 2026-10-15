// The planner's layout state: placed module instances, their reserved tiles and the routed belts (SPEC §5.3). It is an
// overlay on the terrain model (grid.ts): the router and placement read both. Plain tables, so it lives in `storage`.
// Pure: no Factorio globals.

import { ProtoFacts } from "../modules/facts"
import { portOutsideTile, Transform } from "../modules/geometry"
import { rotateVec } from "../modules/rates"
import { ModuleDef, Port } from "../modules/types"
import { CLIFF, DX, DY, FOREIGN, OWN, Rect, rectContains, TerrainView, tkey, UNKNOWN, Vec, WATER } from "./grid"

export interface PlacedModule {
  /** Instance id (unique in the layout). */
  id: string
  /** The module in its canonical orientation (for expansion), and as placed (transformed, module-local). */
  canonical: ModuleDef
  def: ModuleDef
  transform: Transform
  /** World tile of the placed module's top-left corner. */
  origin: Vec
  /** World footprint. */
  rect: Rect
  /** Built already (routes to it may not be ripped... and it never moves). */
  fixed?: boolean
}

export interface PortRef {
  module: string
  port: string
}

/** One piece of a route. `dir` is a direction index (0..3 = N, E, S, W). */
export interface RouteStep {
  kind: "belt" | "ug-in" | "ug-out" | "splitter"
  x: number
  y: number
  dir: number
  /** Splitter: the second tile (the first, x/y, is the tapped route's belt, which the splitter replaces). */
  x2?: number
  y2?: number
}

export interface UgSpan {
  /** Line coordinate range (inclusive) along the axis. */
  a: number
  b: number
  route: string
}

export interface Route {
  id: string
  /** Connection id this route serves. */
  conn: string
  item: string
  from?: PortRef
  to: PortRef
  steps: RouteStep[]
  /** Heading items enter the first step with (the producer port's direction). */
  startDir?: number
  /** Tiles this route occupies (belts, underground ends, a splitter's second tile, a side-load blocker). */
  tiles: number[]
  spans: { line: string; span: UgSpan }[]
  /** Splitter tap: the route whose belt the splitter replaces. */
  tapOf?: string
  belt: string
  underground: string
  splitter: string
  /** Belt tiles + underground ends (entities placed). */
  length: number
  undergrounds: number
  cost: number
  /** A one-tile stub into an input port fed from outside the layout (crew or another faction plan). */
  external?: boolean
  /** Side-loading: the unfed belt behind the port tile that makes the arrival a side-load, not a curve. */
  blocker?: RouteStep
  /** Times ripped up. */
  ripped: number
  /** Built already (part of the faction's base): never ripped up. */
  fixed?: boolean
}

/** A planned pole between modules (world tile; the entity sits at its centre). See power.ts. */
export interface PlannedPole {
  id: string
  name: string
  x: number
  y: number
  /** The pole line (network edge) it belongs to. */
  line: string
}

/** One edge of the pole network: poles from a powered component to a module. */
export interface PoleLine {
  id: string
  /** The module joined to the network, and the owner of the powered pole it was joined from. */
  to: string
  from: string
  poles: string[]
}

export interface LayoutState {
  modules: PlacedModule[]
  /** Module footprints ("m:<id>") and tiles module entities interact with outside their footprint ("x:<id>"). */
  occ: Record<number, string>
  /** Port outside tiles ("p:<module>.<port>"): only the route of that port may use them. */
  reserved: Record<number, string>
  /** Route tiles → route id. */
  routeOcc: Record<number, string>
  /** Reserved routing corridors around modules (routes prefer them; other modules stay out of `corridor.min`). */
  corridor: Record<number, boolean>
  /** Underground spans per line ("h<y>" or "v<x>"). */
  spans: Record<string, UgSpan[]>
  routes: Record<string, Route>
  routeOrder: string[]
  /** Poles between modules (power.ts), occupying `occ` tiles tagged "x:<line>". */
  poles?: PlannedPole[]
  poleLines?: PoleLine[]
}

export function newLayout(): LayoutState {
  return { modules: [], occ: {}, reserved: {}, routeOcc: {}, corridor: {}, spans: {}, routes: {}, routeOrder: [] }
}

export function findModule(state: LayoutState, id: string): PlacedModule | undefined {
  for (const m of state.modules) if (m.id === id) return m
  return undefined
}

export function findPort(m: PlacedModule, id: string): Port | undefined {
  for (const p of m.def.ports) if (p.id === id) return p
  return undefined
}

export function portTag(module: string, port: string): string {
  return `p:${module}.${port}`
}

/** World tile (integer, top-left) of a port's own tile and of its outside tile. */
export function portTile(m: PlacedModule, p: Port): Vec {
  return { x: m.origin.x + math.floor(p.pos.x), y: m.origin.y + math.floor(p.pos.y) }
}

export function portOutside(m: PlacedModule, p: Port): Vec {
  const o = portOutsideTile(p)
  return { x: m.origin.x + math.floor(o.x), y: m.origin.y + math.floor(o.y) }
}

function isBelt(type: string | undefined): boolean {
  return type === "transport-belt" || type === "underground-belt" || type === "splitter"
}

/**
 * Module-local tiles outside the footprint that the module's entities interact with: where an edge belt points
 * (other than a belt-out port, whose outside tile is reserved for its route) and inserter pickup/drop tiles. Routes
 * must keep off them, or they would feed into or be fed by the module by accident.
 */
export function interactionTiles(def: ModuleDef, facts: ProtoFacts): Vec[] {
  const out: Vec[] = []
  const w = def.footprint.w
  const h = def.footprint.h
  const portOut: Record<string, boolean> = {}
  for (const p of def.ports) {
    if (p.kind === "belt-out" || p.kind === "belt-in") {
      const o = portOutsideTile(p)
      portOut[`${math.floor(o.x)},${math.floor(o.y)}`] = true
    }
  }
  const add = (x: number, y: number): void => {
    const tx = math.floor(x)
    const ty = math.floor(y)
    if (tx >= 0 && ty >= 0 && tx < w && ty < h) return
    if (portOut[`${tx},${ty}`]) return
    out.push({ x: tx, y: ty })
  }
  for (const e of def.entities) {
    const f = facts.entity(e.name)
    const d = math.floor((e.dir ?? 0) / 4)
    if (isBelt(f?.type) && f?.type !== "splitter") {
      if (f?.type === "underground-belt" && e.ioType === "input") continue
      add(e.x + DX[d], e.y + DY[d])
    } else if (f?.type === "inserter") {
      if (f.pickupVector) {
        const v = rotateVec(f.pickupVector, e.dir)
        add(e.x + v.x, e.y + v.y)
      }
      if (f.dropVectorIns) {
        const v = rotateVec(f.dropVectorIns, e.dir)
        add(e.x + v.x, e.y + v.y)
      }
    }
  }
  return out
}

/** Entity tiles of a placed module (world), for checks. */
export function moduleTiles(m: PlacedModule): number[] {
  const out: number[] = []
  for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++) for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++) out.push(tkey(x, y))
  return out
}

/** Adds a placed module's tiles to the layout: footprint, interaction tiles, port reservations, corridor ring. */
export function commitModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts, corridor: number): void {
  state.modules.push(m)
  markModule(state, m, facts, corridor)
}

export function markModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts, corridor: number): void {
  const tag = `m:${m.id}`
  for (const k of moduleTiles(m)) {
    state.occ[k] = tag
    delete state.corridor[k]
  }
  for (const t of interactionTiles(m.def, facts)) {
    const k = tkey(m.origin.x + t.x, m.origin.y + t.y)
    if (state.occ[k] === undefined) state.occ[k] = `x:${m.id}`
  }
  for (const p of m.def.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = portOutside(m, p)
    state.reserved[tkey(o.x, o.y)] = portTag(m.id, p.id)
  }
  const r = m.rect
  for (let x = r.x - corridor; x < r.x + r.w + corridor; x++) {
    for (let y = r.y - corridor; y < r.y + r.h + corridor; y++) {
      const k = tkey(x, y)
      if (!rectContains(r, x, y) && state.occ[k] === undefined) state.corridor[k] = true
    }
  }
}

/** Removes a module's tiles (before re-marking it grown). Routes are untouched. */
export function unmarkModule(state: LayoutState, m: PlacedModule, facts: ProtoFacts): void {
  const tag = `m:${m.id}`
  const xtag = `x:${m.id}`
  for (const k of moduleTiles(m)) if (state.occ[k] === tag) delete state.occ[k]
  for (const t of interactionTiles(m.def, facts)) {
    const k = tkey(m.origin.x + t.x, m.origin.y + t.y)
    if (state.occ[k] === xtag) delete state.occ[k]
  }
  for (const p of m.def.ports) {
    if (p.kind !== "belt-in" && p.kind !== "belt-out") continue
    const o = portOutside(m, p)
    const k = tkey(o.x, o.y)
    if (state.reserved[k] === portTag(m.id, p.id)) delete state.reserved[k]
  }
}

export function lineKey(x: number, y: number, dir: number): string {
  return dir % 2 === 1 ? `h${y}` : `v${x}`
}

export function commitRoute(state: LayoutState, route: Route): void {
  state.routes[route.id] = route
  state.routeOrder.push(route.id)
  for (const k of route.tiles) state.routeOcc[k] = route.id
  for (const s of route.spans) {
    let list = state.spans[s.line]
    if (list === undefined) {
      list = []
      state.spans[s.line] = list
    }
    list.push(s.span)
  }
}

/** Removes a route (and the splitter taps hanging off it). Returns the removed route ids. */
export function ripRoute(state: LayoutState, id: string): string[] {
  const route = state.routes[id]
  if (route === undefined) return []
  const removed = [id]
  for (const other of [...state.routeOrder]) {
    if (state.routes[other]?.tapOf === id) for (const r of ripRoute(state, other)) removed.push(r)
  }
  for (const k of route.tiles) if (state.routeOcc[k] === id) delete state.routeOcc[k]
  for (const s of route.spans) {
    const list = state.spans[s.line]
    if (list === undefined) continue
    const kept = list.filter((x) => x.route !== id)
    if (kept.length > 0) state.spans[s.line] = kept
    else delete state.spans[s.line]
  }
  delete state.routes[id]
  const i = state.routeOrder.indexOf(id)
  if (i >= 0) state.routeOrder.splice(i, 1)
  return removed
}

/** Whether a span overlaps any on its line (other than `except`'s); returns the owners it overlaps. */
export function spanConflicts(state: LayoutState, line: string, a: number, b: number): string[] {
  const out: string[] = []
  const list = state.spans[line]
  if (list === undefined) return out
  for (const s of list) if (s.a <= b && a <= s.b) out.push(s.route)
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Independent checker: what the acceptance tests assert about a finished layout.

export interface LayoutCheck {
  problems: string[]
}

function hardTerrain(b: number): boolean {
  return b === WATER || b === CLIFF || b === UNKNOWN || b === OWN || b === FOREIGN
}

/**
 * Checks a layout: module footprints are disjoint and on placeable terrain; every route is continuous from its
 * producer's outside tile into its consumer's port tile from the required side, stays out of every footprint,
 * water, cliffs and other structures, shares no tile with another route, and its undergrounds respect the tier's
 * maximum and do not interleave with others on the same line.
 */
export function checkLayout(state: LayoutState, terrain: TerrainView, maxUnderground: (this: void, ug: string) => number): LayoutCheck {
  const problems: string[] = []
  const foot: Record<number, string> = {}
  for (const m of state.modules) {
    for (const k of moduleTiles(m)) {
      if (foot[k] !== undefined) problems.push(`modules ${foot[k]} and ${m.id} overlap`)
      foot[k] = m.id
    }
  }
  const used: Record<number, string> = {}
  const claim = (route: Route, x: number, y: number, what: string): void => {
    const k = tkey(x, y)
    if (used[k] !== undefined && used[k] !== route.id) problems.push(`${route.id}: ${what} at ${x},${y} shares a tile with ${used[k]}`)
    used[k] = route.id
    if (foot[k] !== undefined) problems.push(`${route.id}: ${what} at ${x},${y} inside module ${foot[k]}`)
    if (hardTerrain(terrain.block(x, y))) problems.push(`${route.id}: ${what} at ${x},${y} on blocked terrain`)
  }
  const lines: Record<string, { a: number; b: number; route: string }[]> = {}
  for (const id of state.routeOrder) {
    const r = state.routes[id]
    const to = findModule(state, r.to.module)
    const toPort = to ? findPort(to, r.to.port) : undefined
    if (!to || !toPort) {
      problems.push(`${id}: unknown target ${r.to.module}.${r.to.port}`)
      continue
    }
    const target = portTile(to, toPort)
    const portDir = math.floor(toPort.dir / 4)
    // The first tile: a belt-out's outside tile (or a splitter tap / an external stub).
    let expect: Vec | undefined
    let heading = -1
    if (r.from !== undefined && r.tapOf === undefined) {
      const fm = findModule(state, r.from.module)
      const fp = fm ? findPort(fm, r.from.port) : undefined
      if (!fm || !fp) problems.push(`${id}: unknown source`)
      else {
        expect = portOutside(fm, fp)
        heading = math.floor(fp.dir / 4)
      }
    }
    for (let i = 0; i < r.steps.length; i++) {
      const s = r.steps[i]
      if (expect !== undefined && (s.x !== expect.x || s.y !== expect.y)) problems.push(`${id}: step ${i} (${s.kind}) at ${s.x},${s.y}, expected ${expect.x},${expect.y}`)
      if (s.kind === "splitter") {
        claim(r, s.x2!, s.y2!, "splitter")
        expect = { x: s.x2! + DX[s.dir], y: s.y2! + DY[s.dir] }
        heading = s.dir
        continue
      }
      claim(r, s.x, s.y, s.kind)
      if (heading >= 0 && s.kind !== "belt" && s.dir !== heading) problems.push(`${id}: ${s.kind} at ${s.x},${s.y} not entered straight`)
      if (heading >= 0 && s.kind === "belt" && s.dir === (heading + 2) % 4) problems.push(`${id}: belt at ${s.x},${s.y} turns back`)
      if (s.kind === "ug-in") {
        const out = r.steps[i + 1]
        if (out === undefined || out.kind !== "ug-out" || out.dir !== s.dir) {
          problems.push(`${id}: underground entrance at ${s.x},${s.y} has no exit`)
          continue
        }
        const dist = math.abs(out.x - s.x) + math.abs(out.y - s.y)
        if (out.x !== s.x + DX[s.dir] * dist || out.y !== s.y + DY[s.dir] * dist) problems.push(`${id}: underground exit off line at ${out.x},${out.y}`)
        if (dist > maxUnderground(r.underground)) problems.push(`${id}: underground ${dist} > max ${maxUnderground(r.underground)}`)
        const line = lineKey(s.x, s.y, s.dir)
        const a = s.dir % 2 === 1 ? math.min(s.x, out.x) : math.min(s.y, out.y)
        const b = s.dir % 2 === 1 ? math.max(s.x, out.x) : math.max(s.y, out.y)
        lines[line] ??= []
        for (const o of lines[line]) if (o.a <= b && a <= o.b) problems.push(`${id}: underground span ${line} ${a}..${b} interleaves with ${o.route}`)
        lines[line].push({ a, b, route: id })
        expect = { x: out.x, y: out.y }
        heading = s.dir
        continue
      }
      expect = { x: s.x + DX[s.dir], y: s.y + DY[s.dir] }
      heading = s.dir
    }
    if (r.blocker) claim(r, r.blocker.x, r.blocker.y, "side-load blocker")
    // Arrival: into the port tile with the port's direction, or from the required side.
    const want = toPort.side === undefined ? portDir : toPort.side === "left" ? (portDir + 1) % 4 : (portDir + 3) % 4
    if (expect === undefined || expect.x !== target.x || expect.y !== target.y) problems.push(`${id}: does not end at ${to.id}.${toPort.id} (${target.x},${target.y})`)
    else if (heading !== want) problems.push(`${id}: arrives at ${to.id}.${toPort.id} heading ${heading}, needs ${want}`)
  }
  return { problems }
}
