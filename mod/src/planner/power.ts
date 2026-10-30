// Pole network planner (SPEC §5.3 Power): connect every module that needs power to a module that makes it, with
// lines of small electric poles between them. Modules carry their own poles (M4a), so the network here joins pole
// *components*: poles within wire reach of each other are connected (the game links them on build), and a component
// is powered when it holds a generator's pole. Prim-style: repeatedly join the unpowered consumer component nearest to
// the powered set, by an A* over pole positions (hops up to the wire reach) on free tiles of the terrain and layout.
//
// Resumable and budgeted like the rest of the planner (§5.6): `stepPoles` does about `budget` work units. The result
// is a list of pole lines added to the LayoutState (`layout.poles`), so routes and later plans keep off them, and the
// build list stamps them. Pure: no Factorio globals.

import { moduleId, poleId, poleLineId } from "../shared/ids"
import type { ModuleId, PoleId, PoleLineId } from "../shared/ids"
import { ProtoFacts } from "../modules/facts"
import { claimPoleTile, poleClaimConflict, releasePoleTile } from "./claims"
import { FREE, ROCK, TerrainView, tkey, TREE } from "./grid"
import { bumpLayout, LayoutState, PlannedPole } from "./layout"
import { LayoutPolicy } from "./policy"

interface PoleNode {
  owner: string
  x: number
  y: number
  reach: number
}

export interface PoleJob {
  /** Pole entity to place. */
  pole: string
  reach: number
  phase: "init" | "connect" | "done"
  /** Id prefix of the poles and lines this job adds. */
  prefix: string
  nodes: PoleNode[]
  parent: number[]
  /** Component root → powered. */
  powered: Record<number, boolean>
  /** Owners (module ids) that still need joining, nearest first when picked. */
  pending: ModuleId[]
  current?: PoleSearch
  added: PoleId[]
  failures: Record<string, string>
  work: number
  /** Module ids that ended up powered (or were). */
  connected: ModuleId[]
}

interface PoleSearch {
  target: ModuleId
  /** Window margin around the endpoints; a failed search is retried with a wider one. */
  margin: number
  /** Target component poles. */
  goals: PoleNode[]
  gx1: number
  gy1: number
  gx2: number
  gy2: number
  x0: number
  y0: number
  w: number
  h: number
  g: Record<number, number>
  par: Record<number, number>
  closed: Record<number, boolean>
  hs: number[]
  hf: number[]
  from: Record<number, string>
  found?: number
  status: "running" | "found" | "failed"
  expansions: number
}

/** Neighbour offsets of a pole: every tile within wire reach, longest hops first (fewer poles). */
function offsets(reach: number): { dx: number; dy: number; d: number }[] {
  const out: { dx: number; dy: number; d: number }[] = []
  const r = math.floor(reach)
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const d2 = dx * dx + dy * dy
      // Hops shorter than 3 tiles never help (a 3-tile hop dominates them).
      if (d2 > reach * reach + 1e-9 || d2 < 9) continue
      out.push({ dx, dy, d: math.sqrt(d2) })
    }
  }
  out.sort((a, b) => (a.d !== b.d ? b.d - a.d : a.dx !== b.dx ? a.dx - b.dx : a.dy - b.dy))
  return out
}

const OFFSET_CACHE: Record<string, { dx: number; dy: number; d: number }[]> = {}
function offsetsFor(reach: number): { dx: number; dy: number; d: number }[] {
  const k = tostring(reach)
  let o = OFFSET_CACHE[k]
  if (o === undefined) {
    o = offsets(reach)
    OFFSET_CACHE[k] = o
  }
  return o
}

function find(job: PoleJob, i: number): number {
  let r = i
  while (job.parent[r] !== r) r = job.parent[r]
  // Path compression.
  let j = i
  while (job.parent[j] !== r) {
    const n = job.parent[j]
    job.parent[j] = r
    j = n
  }
  return r
}

function union(job: PoleJob, a: number, b: number): void {
  const ra = find(job, a)
  const rb = find(job, b)
  if (ra === rb) return
  const p = job.powered[ra] || job.powered[rb]
  job.parent[ra] = rb
  if (p) job.powered[rb] = true
}

function addNode(job: PoleJob, n: PoleNode): number {
  const i = job.nodes.length
  job.nodes.push(n)
  job.parent.push(i)
  for (let j = 0; j < i; j++) {
    const o = job.nodes[j]
    const dx = o.x - n.x
    const dy = o.y - n.y
    const r = math.min(o.reach, n.reach)
    if (dx * dx + dy * dy <= r * r + 1e-9) union(job, i, j)
  }
  return i
}

/** Factorio electric poles have five copper-wire connections. The API exposes wire reach but not this count. */
const MAX_WIRE_CONNECTIONS = 5

/** Existing copper wires a pole can still take (geometric neighbour count, conservative). */
function wireDegree(job: PoleJob, i: number): number {
  let n = 0
  const a = job.nodes[i]
  for (let j = 0; j < job.nodes.length; j++) {
    if (j === i) continue
    const b = job.nodes[j]
    const dx = a.x - b.x
    const dy = a.y - b.y
    const r = math.min(a.reach, b.reach)
    if (dx * dx + dy * dy <= r * r + 1e-9) n++
  }
  return n
}

/** Every pole of the layout (module poles and planned line poles), with what owns it. */
function layoutPoles(layout: LayoutState, facts: ProtoFacts, dropped?: Record<number, boolean>): PoleNode[] {
  const out: PoleNode[] = []
  for (const m of layout.modules) {
    for (const e of m.def.entities) {
      const f = facts.entity(e.name)
      if (f?.type !== "electric-pole") continue
      const x = m.origin.x + e.x
      const y = m.origin.y + e.y
      if (dropped !== undefined && dropped[tkey(math.floor(x), math.floor(y))] === true) continue
      out.push({ owner: m.id, x, y, reach: f.wireReach ?? 7.5 })
    }
  }
  for (const p of layout.poles ?? []) {
    if (dropped !== undefined && dropped[tkey(p.x, p.y)] === true) continue
    out.push({ owner: p.line, x: p.x + 0.5, y: p.y + 0.5, reach: facts.entity(p.name)?.wireReach ?? 7.5 })
  }
  return out
}

/** Modules that make electricity (a generator entity inside) and modules that need it (a power port). */
export function powerRoles(layout: LayoutState, facts: ProtoFacts): { sources: ModuleId[]; consumers: ModuleId[] } {
  const sources: ModuleId[] = []
  const consumers: ModuleId[] = []
  for (const m of layout.modules) {
    let gen = false
    for (const e of m.def.entities) if (facts.entity(e.name)?.type === "generator") gen = true
    let port = false
    for (const p of m.def.ports) if (p.kind === "power") port = true
    if (gen) sources.push(m.id)
    else if (port) consumers.push(m.id)
  }
  return { sources, consumers }
}

export function newPoleJob(prefix: string, pole: string, facts: ProtoFacts): PoleJob {
  return {
    pole,
    reach: facts.entity(pole)?.wireReach ?? 7.5,
    phase: "init",
    prefix,
    nodes: [],
    parent: [],
    powered: {},
    pending: [],
    added: [],
    failures: {},
    work: 0,
    connected: [],
  }
}

function init(job: PoleJob, layout: LayoutState, facts: ProtoFacts, dropped?: Record<number, boolean>): number {
  const roles = powerRoles(layout, facts)
  const poles = layoutPoles(layout, facts, dropped)
  // B39: one network. Only the first generator module (the first power plant) is powered; later ones join it like
  // consumers do, or a second plant stays an island that powers nothing.
  const main = roles.sources[0]
  for (const p of poles) {
    const i = addNode(job, p)
    if (p.owner === main) job.powered[find(job, i)] = true
  }
  // Without a generator there is nothing to connect to yet: a later plan (the steam block's) joins everything.
  if (roles.sources.length === 0) {
    job.phase = "done"
    return poles.length
  }
  job.pending = [...roles.sources.slice(1), ...roles.consumers]
  job.phase = "connect"
  return poles.length
}

function ownerPowered(job: PoleJob, owner: string): boolean {
  for (let i = 0; i < job.nodes.length; i++) if (job.nodes[i].owner === owner && job.powered[find(job, i)]) return true
  return false
}

function ownerHasPoles(job: PoleJob, owner: string): boolean {
  for (const n of job.nodes) if (n.owner === owner) return true
  return false
}

/** Free for a pole: buildable terrain (trees and rocks at a cost) and not used by the layout. Returns -1 if not. */
function poleCost(layout: LayoutState, terrain: TerrainView, policy: LayoutPolicy, x: number, y: number): number {
  const k = tkey(x, y)
  if (poleClaimConflict(layout, k) !== undefined) return -1
  const b = terrain.block(x, y)
  let c = 1
  if (b === TREE) {
    if (policy.obstacles.trees !== "clear") return -1
    c += policy.router.clearTree
  } else if (b === ROCK) {
    if (policy.obstacles.rocks !== "clear") return -1
    c += policy.router.clearRock
  } else if (b !== FREE) return -1
  // Corridors are for belts; ore stays minable.
  if (layout.corridor[k]) c += 0.5
  if (terrain.ore(x, y) !== undefined) c += 0.25
  return c
}

/** Window margins tried in turn (detours around lakes need room). */
const MARGINS = [16, 48, 112]

/** Picks the pending owner nearest the powered set and starts a search for it. */
function startNext(job: PoleJob, retry?: { owner: ModuleId; margin: number }): boolean {
  let best: { owner: ModuleId; d2: number; src: PoleNode } | undefined
  const keep: ModuleId[] = []
  for (const owner of retry !== undefined ? [retry.owner] : job.pending) {
    if (ownerPowered(job, owner)) {
      job.connected.push(owner)
      continue
    }
    if (!ownerHasPoles(job, owner)) {
      job.failures[owner] = "module has no pole"
      continue
    }
    keep.push(owner)
    for (let i = 0; i < job.nodes.length; i++) {
      const a = job.nodes[i]
      if (a.owner !== owner) continue
      for (let j = 0; j < job.nodes.length; j++) {
        if (!job.powered[find(job, j)] || wireDegree(job, j) >= MAX_WIRE_CONNECTIONS) continue
        const b = job.nodes[j]
        const d2 = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
        if (best === undefined || d2 < best.d2 || (d2 === best.d2 && owner < best.owner)) best = { owner, d2, src: b }
      }
    }
  }
  if (retry === undefined) job.pending = keep
  if (best === undefined) return false
  job.pending = job.pending.filter((o) => o !== best!.owner)
  // The target: every pole of the owner's component(s). B43: that includes line poles joined to it, e.g. a line to a
  // mine whose trunk line a plan evicted (B37): the mine's own pole may sit where no new pole can reach it.
  const roots: Record<number, boolean> = {}
  for (let i = 0; i < job.nodes.length; i++) if (job.nodes[i].owner === best.owner) roots[find(job, i)] = true
  const goals: PoleNode[] = []
  let gx1 = math.huge
  let gy1 = math.huge
  let gx2 = -math.huge
  let gy2 = -math.huge
  for (let i = 0; i < job.nodes.length; i++) {
    const n = job.nodes[i]
    // A saturated pole cannot accept the new wire; choose another pole in the target component.
    if (!roots[find(job, i)] || wireDegree(job, i) >= MAX_WIRE_CONNECTIONS) continue
    goals.push(n)
    gx1 = math.min(gx1, n.x)
    gy1 = math.min(gy1, n.y)
    gx2 = math.max(gx2, n.x)
    gy2 = math.max(gy2, n.y)
  }
  if (goals.length === 0) {
    job.failures[best.owner] = "every pole has all wire connections in use"
    return false
  }
  const margin = retry?.margin ?? MARGINS[0]
  const x0 = math.floor(math.min(gx1, best.src.x) - margin)
  const y0 = math.floor(math.min(gy1, best.src.y) - margin)
  const x1 = math.ceil(math.max(gx2, best.src.x) + margin)
  const y1 = math.ceil(math.max(gy2, best.src.y) + margin)
  const s: PoleSearch = {
    target: moduleId(best.owner),
    margin,
    goals,
    gx1,
    gy1,
    gx2,
    gy2,
    x0,
    y0,
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    g: {},
    par: {},
    closed: {},
    hs: [],
    hf: [],
    from: {},
    status: "running",
    expansions: 0,
  }
  // Sources: powered poles inside the window (they exist already: g = 0).
  for (let j = 0; j < job.nodes.length; j++) {
    if (!job.powered[find(job, j)]) continue
    const n = job.nodes[j]
    const tx = math.floor(n.x)
    const ty = math.floor(n.y)
    if (tx < s.x0 || ty < s.y0 || tx >= s.x0 + s.w || ty >= s.y0 + s.h) continue
    const st = (ty - s.y0) * s.w + (tx - s.x0)
    if (s.g[st] !== undefined) continue
    s.g[st] = 0
    s.from[st] = n.owner
    push(s, job, st, 0, tx, ty)
  }
  job.current = s
  return true
}

function hdist(s: PoleSearch, job: PoleJob, x: number, y: number): number {
  const cx = x + 0.5
  const cy = y + 0.5
  const dx = math.max(s.gx1 - cx, 0, cx - s.gx2)
  const dy = math.max(s.gy1 - cy, 0, cy - s.gy2)
  const d = math.sqrt(dx * dx + dy * dy)
  return math.max(0, d - job.reach) / job.reach
}

function push(s: PoleSearch, job: PoleJob, st: number, g: number, x: number, y: number): void {
  const f = g + hdist(s, job, x, y)
  const hs = s.hs
  const hf = s.hf
  let i = hs.length
  hs.push(st)
  hf.push(f)
  while (i > 0) {
    const p = math.floor((i - 1) / 2)
    if (hf[p] <= f) break
    hs[i] = hs[p]
    hf[i] = hf[p]
    i = p
  }
  hs[i] = st
  hf[i] = f
}

function pop(s: PoleSearch): number {
  const hs = s.hs
  const hf = s.hf
  const top = hs[0]
  const lastS = hs[hs.length - 1]
  const lastF = hf[hf.length - 1]
  hs.pop()
  hf.pop()
  const n = hs.length
  if (n > 0) {
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= n) break
      let c = l
      if (l + 1 < n && hf[l + 1] < hf[l]) c = l + 1
      if (hf[c] >= lastF) break
      hs[i] = hs[c]
      hf[i] = hf[c]
      i = c
    }
    hs[i] = lastS
    hf[i] = lastF
  }
  return top
}

function reachesGoal(s: PoleSearch, job: PoleJob, x: number, y: number): boolean {
  const cx = x + 0.5
  const cy = y + 0.5
  for (const gl of s.goals) {
    const r = math.min(gl.reach, job.reach)
    const dx = gl.x - cx
    const dy = gl.y - cy
    if (dx * dx + dy * dy <= r * r + 1e-9) return true
  }
  return false
}

function stepSearch(job: PoleJob, layout: LayoutState, terrain: TerrainView, policy: LayoutPolicy, budget: number): number {
  const s = job.current!
  const offs = offsetsFor(job.reach)
  const unit = 1 + offs.length / 40
  let used = 0
  while (s.status === "running" && used < budget) {
    if (s.hs.length === 0) {
      s.status = "failed"
      break
    }
    const cur = pop(s)
    if (s.closed[cur]) continue
    s.closed[cur] = true
    s.expansions++
    used += unit
    const x = s.x0 + (cur % s.w)
    const y = s.y0 + math.floor(cur / s.w)
    // A new pole (not a source pole) that reaches the target ends the search.
    if (s.from[cur] === undefined && reachesGoal(s, job, x, y)) {
      s.found = cur
      s.status = "found"
      break
    }
    const g = s.g[cur]
    for (const o of offs) {
      const nx = x + o.dx
      const ny = y + o.dy
      if (nx < s.x0 || ny < s.y0 || nx >= s.x0 + s.w || ny >= s.y0 + s.h) continue
      const nst = (ny - s.y0) * s.w + (nx - s.x0)
      if (s.closed[nst]) continue
      const c = poleCost(layout, terrain, policy, nx, ny)
      if (c < 0) continue
      const ng = g + c
      const old = s.g[nst]
      if (old !== undefined && old <= ng) continue
      s.g[nst] = ng
      s.par[nst] = cur
      push(s, job, nst, ng, nx, ny)
    }
  }
  return used
}

/** Commits a found pole line to the layout and the job's union-find. */
function commitLine(job: PoleJob, layout: LayoutState): void {
  const s = job.current!
  const tiles: number[] = []
  let st = s.found!
  let from: string | undefined
  for (;;) {
    if (s.from[st] !== undefined) {
      from = s.from[st]
      break
    }
    tiles.push(st)
    st = s.par[st]
  }
  // B37: evicted lines leave gaps in the numbering; the next free id keeps line ids unique.
  const used: Record<string, boolean> = {}
  for (const l of layout.poleLines ?? []) used[l.id] = true
  for (const p of layout.evictedPoles ?? []) used[p.line] = true
  let n = layout.poleLines?.length ?? 0
  while (used[`${job.prefix}${n}`]) n++
  const lineId: PoleLineId = poleLineId(`${job.prefix}${n}`)
  layout.poles ??= []
  layout.poleLines ??= []
  const ids: PoleId[] = []
  for (let i = tiles.length - 1; i >= 0; i--) {
    const x = s.x0 + (tiles[i] % s.w)
    const y = s.y0 + math.floor(tiles[i] / s.w)
    const id = poleId(`${lineId}.${tiles.length - 1 - i}`)
    layout.poles.push({ id, name: job.pole, x, y, line: lineId })
    claimPoleTile(layout, tkey(x, y), lineId)
    ids.push(id)
    job.added.push(id)
    addNode(job, { owner: lineId, x: x + 0.5, y: y + 0.5, reach: job.reach })
  }
  layout.poleLines.push({ id: lineId, to: s.target, from: from ?? "?", poles: ids })
  bumpLayout(layout)
  job.connected.push(s.target)
}

/** Advances the job by about `budget` work units. Returns true when it has finished. */
export function stepPoles(job: PoleJob, layout: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, budget: number): boolean {
  let used = 0
  while (used < budget && job.phase !== "done") {
    if (job.phase === "init") {
      used += init(job, layout, facts) / 4 + 1
      continue
    }
    if (job.current === undefined) {
      if (!startNext(job)) {
        job.phase = "done"
        break
      }
      used += 1
      continue
    }
    used += stepSearch(job, layout, terrain, policy, budget - used)
    const s = job.current
    if (s.status === "found") {
      commitLine(job, layout)
      job.current = undefined
    } else if (s.status === "failed") {
      job.current = undefined
      const i = MARGINS.indexOf(s.margin)
      if (i >= 0 && i + 1 < MARGINS.length) startNext(job, { owner: s.target, margin: MARGINS[i + 1] })
      else job.failures[s.target] = `no pole path (window margin ${s.margin})`
    }
  }
  job.work += used
  return job.phase === "done"
}

/** Runs a pole job to completion (tests, tools). */
export function polesNow(layout: LayoutState, terrain: TerrainView, facts: ProtoFacts, policy: LayoutPolicy, prefix = "poles:", pole = "small-electric-pole"): PoleJob {
  const job = newPoleJob(prefix, pole, facts)
  while (!stepPoles(job, layout, terrain, facts, policy, 1000)) {
    // budgeted steps
  }
  return job
}

/**
 * Independent check: the pole components of a layout (module poles and line poles joined within wire reach), and the
 * modules not on the first generator module's network: consumers, and (B39) later generator modules.
 */
export function unpoweredModules(layout: LayoutState, facts: ProtoFacts): string[] {
  return unpoweredWith(layout, facts, undefined)
}

/** `unpoweredModules` as it would be if the poles on the listed tiles were gone (B63: simulate a removal). */
export function unpoweredWith(layout: LayoutState, facts: ProtoFacts, dropped: Record<number, boolean> | undefined): string[] {
  const job = newPoleJob("check:", "small-electric-pole", facts)
  init(job, layout, facts, dropped)
  const out: string[] = []
  const roles = powerRoles(layout, facts)
  // B39: a generator module off the first plant's network counts too (an island powers nothing).
  for (const owner of [...roles.sources.slice(1), ...roles.consumers]) if (!ownerPowered(job, owner)) out.push(owner)
  return out
}

/** A pole that must survive a removal because it is the only path from a generator to something (B63). */
export interface KeptPole {
  /** Tile key of the pole. */
  key: number
  name: string
  /** Layout tile (integers, like LayoutState.poles). */
  x: number
  y: number
  /** The kept line it belongs to, when it is a line pole (a module's own pole has none and is re-homed). */
  line?: string
  /** A module this pole is the only power path for: the line it is re-homed into serves it. */
  forModule: string
}

/**
 * B63 (bridge rule): a pole is a bridge when removing it disconnects a module that was powered. `abandonParts` takes a
 * module's own poles and its lines' poles with it, and a line that merely *passes through* the abandoned ground can be
 * the only link for everything behind it (seed 3891760: 91 modules went dark on a 17-tile gap).
 * Returns the lines that may still be removed, and the poles that must be kept with the module each protects.
 */
export function keepBridges(layout: LayoutState, facts: ProtoFacts, dropLines: string[], dropModules: string[]): { dropLines: string[]; keepPoles: KeptPole[] } {
  const none = { dropLines, keepPoles: [] as KeptPole[] }
  const lineDrop: Record<string, boolean> = {}
  for (const id of dropLines) lineDrop[id] = true
  const modDrop: Record<string, boolean> = {}
  for (const id of dropModules) modDrop[id] = true
  const roles = powerRoles(layout, facts)
  const isSource: Record<string, boolean> = {}
  for (const id of roles.sources) isSource[id as string] = true
  for (const id of dropModules) if (isSource[id] === true) return none
  // Only modules that stay matter: the ones being abandoned are meant to go dark.
  const orphans = (dropped: Record<number, boolean> | undefined): string[] => {
    const out: string[] = []
    for (const id of unpoweredWith(layout, facts, dropped)) if (modDrop[id] !== true) out.push(id)
    return out
  }
  if (orphans(undefined).length > 0) return none
  const cands: { key: number; name: string; x: number; y: number; line: string | undefined }[] = []
  for (const m of layout.modules) {
    if (modDrop[m.id] !== true) continue
    for (const e of m.def.entities) {
      if (facts.entity(e.name)?.type !== "electric-pole") continue
      const x = math.floor(m.origin.x + e.x)
      const y = math.floor(m.origin.y + e.y)
      cands.push({ key: tkey(x, y), name: e.name, x, y, line: undefined })
    }
  }
  for (const p of layout.poles ?? []) if (lineDrop[p.line] === true) cands.push({ key: tkey(p.x, p.y), name: p.name, x: p.x, y: p.y, line: p.line })
  if (cands.length === 0) return none
  const all: Record<number, boolean> = {}
  for (const c of cands) all[c.key] = true
  if (orphans(all).length === 0) return none
  const keep: KeptPole[] = []
  for (const c of cands) {
    const without: Record<number, boolean> = {}
    for (const k in all) without[k as unknown as number] = true
    delete without[c.key]
    const lost = orphans(without)
    if (lost.length === 0) continue
    keep.push({ key: c.key, name: c.name, x: c.x, y: c.y, line: c.line, forModule: lost[0] })
  }
  const finalDrop: Record<number, boolean> = {}
  for (const k in all) finalDrop[k as unknown as number] = true
  for (const k of keep) delete finalDrop[k.key]
  // Two bridges that only work together: rather than risk a cut, keep every candidate.
  if (orphans(finalDrop).length > 0) {
    keep.length = 0
    for (const c of cands) keep.push({ key: c.key, name: c.name, x: c.x, y: c.y, line: c.line, forModule: roles.consumers[0] ?? roles.sources[0] })
  }
  const keptLines: Record<string, boolean> = {}
  for (const c of cands) if (c.line !== undefined && keep.some((k) => k.key === c.key)) keptLines[c.line] = true
  const out: string[] = []
  for (const id of dropLines) if (keptLines[id] !== true) out.push(id)
  return { dropLines: out, keepPoles: keep }
}

/**
 * B63: a kept pole that belonged to an abandoned module is put back into the layout as its own one-pole line, re-homed
 * to the module it protects, so the graph still shows the path that survived.
 */
export function rehomeKeptPoles(layout: LayoutState, keep: KeptPole[]): void {
  let any = false
  for (const k of keep) {
    if (k.line !== undefined) continue
    // The id must keep the `poles:` prefix: `poleTag` marks a pole's `occ` as `x:<line>` in the same space as an
    // interaction claim (`x:<module>`), and `isPoleTag` tells them apart by the prefix. A line id without it decodes as
    // an interaction claim owned by a module that does not exist, so every later plan is rejected as
    // `invalid-layout-claims` (measured: a 4-tile leak looping the goal forever).
    const line = poleLineId(`poles:kept:${k.key}`)
    const id = poleId(`${line}.0`)
    layout.poles ??= []
    layout.poleLines ??= []
    layout.poles.push({ id, name: k.name, x: k.x, y: k.y, line })
    claimPoleTile(layout, tkey(k.x, k.y), line)
    layout.poleLines.push({ id: line, to: moduleId(k.forModule), from: "?", poles: [id] })
    any = true
  }
  if (any) bumpLayout(layout)
}

/** Removes the pole lines whose ids are listed (a plan rolled back), from the layout. */
export function removePoleLines(layout: LayoutState, lineIds: string[]): void {
  const drop: Record<string, boolean> = {}
  for (const id of lineIds) drop[id] = true
  let removed = 0
  const kept: PlannedPole[] = []
  for (const p of layout.poles ?? []) {
    if (drop[p.line]) {
      removed++
      releasePoleTile(layout, tkey(p.x, p.y), p.line)
    } else kept.push(p)
  }
  const oldLines = layout.poleLines?.length ?? 0
  layout.poles = kept
  layout.poleLines = (layout.poleLines ?? []).filter((l) => !drop[l.id])
  if (removed > 0 || (layout.poleLines?.length ?? 0) !== oldLines) bumpLayout(layout)
}

export function poleTileKeys(layout: LayoutState): number[] {
  const out: number[] = []
  for (const p of layout.poles ?? []) out.push(tkey(p.x, p.y))
  return out
}

