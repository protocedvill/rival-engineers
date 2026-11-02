import { BoundingBoxArray, LuaEntity, LuaInventory, LuaSurface, MapPosition } from "factorio:runtime"
import { cancel, cancelAll, enqueue, getAction } from "../character/controller"
import { ActionRecord, ActionStatus } from "../character/types"
import { Config, getConfig } from "../config"
import {
  claim,
  complete,
  anyReady,
  depsDone,
  distance,
  failJob,
  getJob,
  fitMaterials,
  ItemCount,
  Job,
  missingMaterials,
  planBatch,
  planTrip,
  Pos,
  prefetchJobs,
  Rect,
  isReady,
  release,
  releaseAllOf,
  selectJob,
  addJob,
  Board,
} from "./board"
import { addPlaceJob, clearJobFor, factionSurface } from "./faction"
import { Holding, reserveAt, takeable, unreserveAt } from "./supply"
import { recordCrewPlan, recordCrewSupply } from "./crew-diagnostics"

declare global {
  interface RivalEngineersStorage {
    /** M6: entities boxed-in crew members picked up, to re-place from ghosts once gone. */
    unboxGhosts?: { faction: string; params: Record<string, unknown>; tick: number }[]
  }
}
import { CrewMember, FactionState, JobPayload } from "./types"
import { badSpotRects, recordBadSpot } from "./bad-spots"
import { countEntities, countWork, findEntities } from "../work"
import { tkey } from "../planner/grid"

// Crew runtime (SPEC §5.2): every tick, each crew member of each faction turns its claimed jobs into
// Character Controller actions and watches them finish. An idle member claims the highest-priority ready
// job (nearest first) plus every same-kind job it can reach from one standing spot, hauls the missing
// materials from the faction's stockpiles and supply points (B32: straight from furnace outputs, buffers, the mall...),
// walks to the spot and works through the batch.
//
// Factions never share anything: each has its own board, stockpiles and crew, and a member only ever
// looks at its own faction.

type CrewJob = Job<JobPayload>

/** Unpenalised releases of one job before a blocked placement counts as a failed attempt after all. */
const MAX_DEFERRALS = 40
/**
 * M7c.8 (seed 11, minute 645): an idle member planned every tick, and each plan reads every supply point's inventory
 * (`availableItems`: 1.85 ms/tick with an empty board, 2 members). After a plan finds nothing, it plans again after
 * this many ticks, or at once when the board changes (a job added, claimed, released, done or failed).
 */
const IDLE_REPLAN_TICKS = 60

/** Changes whenever a job is added or changes hands (what an idle member's next plan could see differently). */
function boardChanges(board: Board<unknown>): number {
  const c = board.counters
  return c.added + c.claims + c.releases + c.completions + c.failures
}

/** Jobs a crew member creates and claims for itself (never selected from the board). */
function isSelfJob(job: CrewJob): boolean {
  return job.payload.kind === "haul" || job.payload.kind === "deposit"
}

/** Jobs whose actions may partly fail without failing the job: moving what is there is the point. */
function isLenientJob(job: CrewJob): boolean {
  return isSelfJob(job) || job.payload.kind === "transfer"
}

export function onCrewTick(): void {
  const order = storage.factionOrder
  if (order.length === 0) return
  const tick = game.tick
  let config: Config | undefined
  for (const name of order) {
    const faction = storage.factions[name]
    if (faction.crew.length === 0) continue
    config ??= getConfig()
    stepFaction(faction, config, tick)
  }
  if (tick % 60 === 0) {
    placeUnboxGhosts(tick)
    placePendingGhosts()
  }
}

/**
 * B17: like a player who abandons their ore trip to fetch the plates a furnace has been holding out, a member
 * with work in flight preempts itself for a *strictly higher-priority* ready job (B17 did it for the brain's
 * collect transfers; since B31 only for urgent refuels), drops the whole batch — `resetMember` releases the claims without
 * penalty — and plans again at once, with the preempting job as its anchor. Only a ready job can do it: a back-off
 * or claimed one never pulls a member off work it has already started.
 *
 * B30: only a job the member had no chance to take when it planned (not in `planSeen`: it became ready since)
 * and whose materials it can get. A job that was ready at plan time and not chosen (no coal for a fuel job, say)
 * would be passed over again by the next plan, and preempting for it every tick livelocked the crew.
 *
 * B31: preemption is for emergencies only, and one member per job:
 * - the job must be an urgent refuel (`isUrgent`): a running burner about to run out of fuel. Routine refuels, ore
 *   feeds and collect transfers (moving a furnace's plates to the depot) wait for the next normal plan: walking off
 *   work to shuffle part stacks to the depot wastes the walk (user, in-session 2026-10-19).
 * - no preemption while a member is idle (idle members plan every tick: one would take the job, or none can).
 * - only the nearest eligible busy member preempts, and its re-plan takes the job (`preemptFor`), so the others
 *   keep working.
 * - the re-plan skips the deposit brain factions do between jobs (the pocket goes along and is deposited after),
 *   so an interrupted trip goes straight to the job. Only a member with a free inventory slot is eligible.
 */
function preemptForUrgent(faction: FactionState, config: Config, tick: number): void {
  const board = faction.board
  const busy: CrewMember[] = []
  for (const id of faction.crew) {
    const m = storage.crew[id]
    if (m.dead || !m.character.valid) continue
    if (m.actions.length === 0) return
    busy.push(m)
  }
  if (busy.length === 0) return
  // Only a job above some busy member's own claimed batch can preempt it (`mayPreemptFor`): none such, no scan.
  let floor = math.huge
  for (const m of busy) {
    const anchor = board.jobs[m.claims[0] ?? -1]
    if (anchor !== undefined && anchor.status === "claimed" && anchor.claimedBy === m.id) floor = math.min(floor, anchor.priority)
  }
  if (floor === math.huge) return
  let jobs: CrewJob[] | undefined
  for (const id of board.active) {
    const job = board.jobs[id]
    if (job.priority <= floor || !canPreempt(job) || !isReady(board, job, tick)) continue
    // `isUrgent` reads the target's burner (game API calls) for every ready refuel every tick; it is only asked for a job
    // some busy member may still drop its batch for. A member reset below plans again and sees every job of this tick's
    // list as already seen (`notePlanSeen`), so filtering on the members as they are now changes nothing.
    let eligible = false
    for (const m of busy) if (!eligible && mayPreemptFor(board, m, job)) eligible = true
    if (!eligible || !isUrgent(faction, job, config)) continue
    jobs ??= []
    jobs.push(job)
  }
  if (jobs === undefined) return
  for (const job of jobs) {
    if (!isReady(board, job, tick)) continue
    let best: CrewMember | undefined
    let bestD = 0
    for (const m of busy) {
      if (m.actions.length === 0 || !canPreemptMember(faction, m, job, config)) continue
      const d = distance(m.character.position, job.pos)
      if (best === undefined || d < bestD) {
        best = m
        bestD = d
      }
    }
    if (best === undefined) continue
    resetMember(faction, best, tick)
    best.stats.preemptions = (best.stats.preemptions ?? 0) + 1
    best.preemptFor = job.id
    planNext(faction, best, config, tick)
  }
}

/** The cheap part of `canPreemptMember`: `member`'s batch is its own and below `job` (B17), and `job` is new to it (B30). */
function mayPreemptFor(board: FactionState["board"], member: CrewMember, job: CrewJob): boolean {
  const anchor = board.jobs[member.claims[0] ?? -1]
  if (anchor === undefined || anchor.status !== "claimed" || anchor.claimedBy !== member.id) return false
  return isPreemptable(anchor, job) && !seenSet(member)[job.id]
}

/**
 * `member.planSeen` as a set, rebuilt when the list is replaced (`notePlanSeen`). Every tick `preemptForUrgent` asks it
 * for each ready refuel; with ~800 of those and a list as long, `indexOf` cost ~1M comparisons a tick (seed 11, 30 min).
 * A derived cache only (not in `storage`): after a load it is rebuilt from the list.
 */
const seenSets: Record<number, { list: number[]; set: Record<number, boolean> }> = {}

function seenSet(member: CrewMember): Record<number, boolean> {
  const list = member.planSeen
  if (list === undefined) return {}
  const c = seenSets[member.id]
  if (c !== undefined && c.list === list) return c.set
  const set: Record<number, boolean> = {}
  for (const id of list) set[id] = true
  seenSets[member.id] = { list, set }
  return set
}

/** Whether busy member `member` may drop its batch for `job` (B17 priority, B30 novelty and materials, B31 room). */
function canPreemptMember(faction: FactionState, member: CrewMember, job: CrewJob, config: Config): boolean {
  if (!mayPreemptFor(faction.board, member, job)) return false
  const inv = member.character.get_main_inventory()
  if (!inv || inv.count_empty_stacks() < 1) return false
  if (!hasMaterials(job, availableItems(faction, heldItems(member.character), config))) return false
  return job.kind !== "fuel" || fuelTarget(faction, job) !== undefined
}

/**
 * B31: a refuel worth pulling a member off its work for: its running target has less than `preemptFuelSeconds` of
 * fuel left. A machine already out of fuel has stopped (no moment left to save; the job keeps its priority for the
 * next plan). Ore and lab feeds (fuel jobs of non-fuel items) never are.
 */
function isUrgent(faction: FactionState, job: CrewJob, config: Config): boolean {
  const p = job.payload
  if (p.kind !== "fuel" || (prototypes.item[p.item]?.fuel_value ?? 0) <= 0) return false
  const target = fuelTarget(faction, job)
  const burner = target?.burner
  if (target === undefined || burner === undefined) return false
  const perTick = target.prototype.get_max_energy_usage() ?? 0
  if (perTick <= 0) return false
  let energy = burner.remaining_burning_fuel
  for (const c of burner.inventory.get_contents()) energy += c.count * (prototypes.item[c.name]?.fuel_value ?? 0)
  return energy > 0 && energy < config.preemptFuelSeconds * 60 * perTick
}

/** Jobs that could ever preempt a batch, whatever its priority (B31: refuels only, never collect transfers). */
function canPreempt(job: CrewJob): boolean {
  return job.kind === "fuel" && job.payload.kind === "fuel"
}

/** Which jobs are worth abandoning a member's current batch for. */
function isPreemptable(anchor: CrewJob, job: CrewJob): boolean {
  // A strictly higher priority.
  if (job.priority <= anchor.priority) return false
  return canPreempt(job)
}

/** B30: remembers the ready jobs that could preempt, so only ones that become ready after this plan do. */
function notePlanSeen(faction: FactionState, member: CrewMember, tick: number): void {
  const board = faction.board
  const seen: number[] = []
  for (const id of board.active) {
    const job = board.jobs[id]
    if (canPreempt(job) && isReady(board, job, tick)) seen.push(id)
  }
  member.planSeen = seen
}

function stepFaction(faction: FactionState, config: Config, tick: number): void {
  for (const id of faction.crew) {
    const member = storage.crew[id]
    if (member.dead) continue
    // Read finished actions first, even for a member that just died: a placement that succeeded on its last
    // tick must count as done, not be released.
    pollActions(faction, member, config, tick)
    if (!member.character.valid) {
      onDeath(faction, member, tick)
      continue
    }
    if (member.actions.length === 0) {
      if (member.claims.length > 0) {
        // Every action finished but a claim is left (should not happen): give it back.
        for (const jobId of [...member.claims]) {
          // M7c.8: a self-job (haul, deposit) belongs to this member: nobody else may claim it, so it ends here.
          const job = faction.board.jobs[jobId]
          if (job !== undefined && isSelfJob(job) && job.status === "claimed") failJob(faction.board, jobId, "no-actions", tick, member.id)
          else release(faction.board, jobId, member.id, tick, { reason: "no-actions", penalize: false, maxAttempts: config.jobMaxAttempts, retryTicks: 0 })
        }
        member.claims = []
      }
      member.spot = undefined
      const waiting = member.idleUntil !== undefined && tick < member.idleUntil && member.idleBoard === boardChanges(faction.board)
      if (!faction.paused && !waiting) planNext(faction, member, config, tick)
    }
  }
  if (!faction.paused) preemptForUrgent(faction, config, tick)
  // Idle accounting (M2 acceptance): a member is idle on a tick when it holds no claim while ready jobs exist. Whether
  // any job is ready is looked up only for a member without a claim (it scanned every active job every tick).
  let ready: boolean | undefined
  for (const id of faction.crew) {
    const member = storage.crew[id]
    if (member.dead) continue
    const stats = member.stats
    stats.ticks++
    if (member.claims.length > 0) {
      stats.busyTicks++
      const current = member.actions[0]
      const job = current?.job !== undefined ? faction.board.jobs[current.job] : undefined
      const kind = job ? job.payload.kind : "walk"
      stats.byKind ??= {}
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1
    } else {
      ready ??= anyReady(faction.board, tick)
      if (ready) stats.idleTicks++
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Death

function onDeath(faction: FactionState, member: CrewMember, tick: number): void {
  member.dead = true
  const board = faction.board
  for (const jobId of member.claims) {
    const job = board.jobs[jobId]
    // A haul belongs to the member; nobody else can finish it.
    if (isSelfJob(job) && job.status === "claimed") failJob(board, jobId, "crew-invalid", tick, member.id)
  }
  releaseAllOf(board, member.id, tick, "crew-invalid")
  for (const ca of member.actions) unreserve(faction, ca.reserve)
  member.claims = []
  member.actions = []
  member.spot = undefined
  cancelAll(member.controller)
}

// ---------------------------------------------------------------------------------------------------
// Following actions

function removeClaim(member: CrewMember, jobId: number): void {
  const index = member.claims.indexOf(jobId)
  if (index >= 0) member.claims.splice(index, 1)
}

function hasMoreActionsFor(member: CrewMember, jobId: number): boolean {
  for (const ca of member.actions) if (ca.job === jobId) return true
  return false
}

function pollActions(faction: FactionState, member: CrewMember, config: Config, tick: number): void {
  const board = faction.board
  // M7c.8: a member found boxed in is unboxed after this action's job is handled (see below).
  let trapped = false
  while (member.actions.length > 0 && !trapped) {
    const ca = member.actions[0]
    const action = getAction(ca.action)
    const status: ActionStatus = action?.status ?? "failed"
    if (status === "queued" || status === "running") break
    member.actions.shift()
    unreserve(faction, ca.reserve)
    if (ca.src !== undefined && action !== undefined && action.stats.items > 0) {
      const takes = (member.stats.takes ??= {})
      takes[ca.src] = (takes[ca.src] ?? 0) + action.stats.items
    }
    // M6/B22: a member that cannot get anywhere is boxed in. A "pathfinder found no path" walk counts, and so do
    // the stuck/unreachable re-path failures members used to loop in forever. Only a finished *walk* action resets
    // the count: a successful craft or transfer happens standing in one spot and says nothing about mobility.
    const reason = action?.reason
    if (
      reason === "no-path" ? action!.detail === "pathfinder found no path" : reason === "stuck" || reason === "unreachable"
    ) {
      member.noPaths = (member.noPaths ?? 0) + 1
    } else if (status === "succeeded" && ca.job === undefined) {
      member.noPaths = 0
    }
    // M7c.8 (seed 11, `fresh-11`: 2077 haul/deposit jobs open for 400 game-min): the unbox used to run here, before the
    // action's job was handled, and an unbox with nothing to clear keeps the actions. A haul whose last take was the
    // failed walk lost it with its claim still held; the "no-actions" release then put a self-job back on the board,
    // where nobody may claim it. Idle members scanned all of them every tick (crew 1 -> 21 ms/tick).
    if ((member.noPaths ?? 0) >= TRAPPED_NO_PATHS) {
      member.noPaths = 0
      trapped = true
    }
    if (ca.job === undefined) {
      // The walk to the standing spot. B111: no way there: the next plans pick another spot.
      if (ca.spot !== undefined && status !== "succeeded" && (reason === "no-path" || reason === "unreachable")) {
        recordBadSpot((faction.badSpots ??= {}), ca.spot, tick)
        log(string.format("[rival-engineers] crew %d: no way to the spot %.1f,%.1f (%s): avoided for a while (B111)", member.id, ca.spot.x, ca.spot.y, reason))
      }
      continue
    }
    const job = board.jobs[ca.job]
    if (job.status !== "claimed" || job.claimedBy !== member.id) continue
    if (isLenientJob(job)) {
      // Partial or failed takes don't fail the haul: a job short of materials fails on its own.
      if (status !== "succeeded" && action) job.reason = `${action.reason ?? status} ${action.detail ?? ""}`
      if (!hasMoreActionsFor(member, job.id)) finishJob(faction, member, job, action, tick)
      continue
    }
    if (status === "succeeded") {
      if (!hasMoreActionsFor(member, job.id)) finishJob(faction, member, job, action, tick)
      continue
    }
    // The job failed: drop its remaining actions and give it back.
    const rest = []
    for (const other of member.actions) {
      if (other.job === job.id) {
        cancel(other.action)
        unreserve(faction, other.reserve)
      } else rest.push(other)
    }
    member.actions = rest
    jobFailed(faction, member, job, action, status, config, tick)
  }
  if (trapped) unbox(faction, member, tick)
}

/** Walk failures in a row after which a member counts as boxed in (M6, seed 222): no-path walks, and stuck/unreachable loops (B22: a member that re-paths forever in place is just as stuck). */
const TRAPPED_NO_PATHS = 3
/** How far around a boxed-in member to look for own entities it may pick up. */
const UNBOX_RADIUS = 3
/** B22: how far around it to look for neutral trees and rocks to mine through. */
const UNBOX_TREE_RADIUS = 3
/** B22: most trees or rocks one escape mines before it gets back to work (the walk re-checks the rest). */
const UNBOX_TREES_PER_ESCAPE = 16
/** Entities a boxed-in member may pick up (and leave a ghost for), smallest first. */
const UNBOX_TYPES = ["inserter", "electric-pole", "pipe", "pipe-to-ground", "container", "transport-belt", "underground-belt", "splitter"]
/** B22: own structures big enough to trap a member (walls, machines); picked up like the small ones, last. */
// M7c.8: a steam engine's type is "generator" ("steam-engine" is its name); an offshore pump last (it feeds every boiler).
const UNBOX_BIG_TYPES = ["wall", "furnace", "lab", "mining-drill", "burner-generator", "generator", "assembling-machine", "storage-tank", "radar", "boiler", "offshore-pump"]
/** M7c.8: ticks before an escape pick-up's ghost goes in (agent guess: 30 s, enough to walk out of a pocket). */
const UNBOX_GHOST_DELAY = 1800
/** B22: after an escape attempt that found nothing the member could clear, wait this long before trying again. */
const UNBOX_RETRY_TICKS = 600

/** B22: one thing near a boxed-in member that blocks it: an own structure to pick up, or a neutral tree/rock to mine. */
interface EscapeTarget {
  entity: LuaEntity
  act: "pickUp" | "mine"
  rank: number
}

/**
 * B22: what a boxed-in member clears to get out. Own structures go one at a time (cheap first: small, then big;
 * a ghost re-places each once the member is out); if none stands in the way, it mines the trees and rocks in its
 * reach — all of them, up to `UNBOX_TREES_PER_ESCAPE`, so a ring of them actually opens. Only what the member can
 * *reach* counts — a walk out of the enclosure is exactly the thing that fails. Empty: nothing in reach at all.
 */
function escapePlan(faction: FactionState, member: CrewMember): EscapeTarget[] {
  const c = member.character
  const p = c.position
  const area: BoundingBoxArray = [[p.x - UNBOX_RADIUS, p.y - UNBOX_RADIUS], [p.x + UNBOX_RADIUS, p.y + UNBOX_RADIUS]]
  const surface = factionSurface(faction)
  let best: EscapeTarget | undefined
  const offer = (e: LuaEntity, slot: number): void => {
    if (!c.can_reach_entity(e)) return
    const d = (e.position.x - p.x) ** 2 + (e.position.y - p.y) ** 2
    const rank = slot * 100 + d
    if (best === undefined || rank < best.rank || (rank === best.rank && (e.unit_number ?? 0) < (best.entity.unit_number ?? 0))) {
      best = { entity: e, act: "pickUp", rank }
    }
  }
  for (const e of findEntities(surface, { force: faction.force, type: UNBOX_TYPES, area })) offer(e, UNBOX_TYPES.indexOf(e.type))
  for (const e of findEntities(surface, { force: faction.force, type: UNBOX_BIG_TYPES, area })) offer(e, UNBOX_TYPES.length + UNBOX_BIG_TYPES.indexOf(e.type))
  // Its own structures stand between it and the way out: open a hole one pick-up at a time.
  if (best !== undefined) return [best]
  const treeArea: BoundingBoxArray = [[p.x - UNBOX_TREE_RADIUS, p.y - UNBOX_TREE_RADIUS], [p.x + UNBOX_TREE_RADIUS, p.y + UNBOX_TREE_RADIUS]]
  const found = findEntities(surface, { type: ["tree", "simple-entity"], area: treeArea })
  const trees: EscapeTarget[] = []
  for (const e of found) {
    if (!e.minable || !e.prototype.mineable_properties.minable || !c.can_reach_entity(e)) continue
    trees.push({ entity: e, act: "mine", rank: (e.position.x - p.x) ** 2 + (e.position.y - p.y) ** 2 })
  }
  trees.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (a.entity.unit_number ?? 0) - (b.entity.unit_number ?? 0)))
  while (trees.length > UNBOX_TREES_PER_ESCAPE) trees.pop()
  return trees
}

/** M7c.8: most tiles the pocket search floods; a bigger open area is not a pocket (agent guess: a 30 × 30 enclosure). */
const POCKET_MAX_TILES = 900
const DX4 = [0, 1, 0, -1]
const DY4 = [-1, 0, 1, 0]

/** M7c.8: whether a character fits at tile (x, y)'s centre (the engine's own check: tiles, entities, cliffs). */
function walkableTile(surface: LuaSurface, x: number, y: number): boolean {
  countWork("entityScans")
  return surface.can_place_entity({ name: "character", position: { x: x + 0.5, y: y + 0.5 } })
}

/**
 * M7c.8: a member walled into a pocket (the tiles it can walk to, flooded up to `POCKET_MAX_TILES`): the own entity on
 * the pocket's edge to pick up — small types first, then the one whose far side is outside the pocket, then the
 * nearest — and the pocket tile beside it to stand on. Undefined when the flood is not closed (not a pocket) or no own
 * entity borders it.
 */
function pocketEscape(faction: FactionState, member: CrewMember): { entity: LuaEntity; stand: MapPosition } | undefined {
  const surface = factionSurface(faction)
  const p = member.character.position
  const sx = math.floor(p.x)
  const sy = math.floor(p.y)
  const seen: Record<number, boolean> = { [tkey(sx, sy)]: true }
  const queue: [number, number][] = [[sx, sy]]
  const edge: [number, number, number, number][] = []
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > POCKET_MAX_TILES) {
      log(`[rival-engineers] faction ${faction.name}: member ${member.id} at ${sx},${sy}: no pocket (more than ${POCKET_MAX_TILES} tiles to walk)`)
      return undefined
    }
    const [x, y] = queue[i]
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d]
      const ny = y + DY4[d]
      const k = tkey(nx, ny)
      if (seen[k]) continue
      if (walkableTile(surface, nx, ny)) {
        seen[k] = true
        queue.push([nx, ny])
      } else edge.push([nx, ny, x, y])
    }
  }
  let best: { entity: LuaEntity; stand: MapPosition; rank: number } | undefined
  for (const [bx, by, fx, fy] of edge) {
    for (const e of findEntities(surface, { force: faction.force, area: [[bx + 0.1, by + 0.1], [bx + 0.9, by + 0.9]] })) {
      let slot = UNBOX_TYPES.indexOf(e.type)
      if (slot < 0) slot = UNBOX_BIG_TYPES.indexOf(e.type) >= 0 ? UNBOX_TYPES.length + UNBOX_BIG_TYPES.indexOf(e.type) : -1
      if (slot < 0) continue
      const ox = bx + (bx - fx)
      const oy = by + (by - fy)
      const opens = !seen[tkey(ox, oy)] && walkableTile(surface, ox, oy)
      const rank = slot * 1000 + (opens ? 0 : 500) + math.abs(fx - sx) + math.abs(fy - sy)
      if (best === undefined || rank < best.rank) best = { entity: e, stand: { x: fx + 0.5, y: fy + 0.5 }, rank }
    }
  }
  if (best === undefined) {
    const types: Record<string, boolean> = {}
    for (const [bx, by] of edge) for (const e of findEntities(surface, { area: [[bx + 0.1, by + 0.1], [bx + 0.9, by + 0.9]] })) types[`${e.type}/${e.force.name}`] = true
    const names: string[] = []
    for (const [t] of pairs(types)) names.push(t as string)
    log(`[rival-engineers] faction ${faction.name}: member ${member.id} at ${sx},${sy}: a pocket of ${queue.length} tiles, nothing of its own to pick up on its edge (${names.join(", ")})`)
  }
  return best === undefined ? undefined : { entity: best.entity, stand: best.stand }
}

/**
 * M6/B22: like a player walled in by their own build, a boxed-in member clears a way out — picks up an own entity
 * around it, or mines the trees and rocks it reaches — then walks on; its dropped jobs go back to the board, so it
 * resumes after the escape. With nothing nearby it can clear, it drops nothing: the failed walk keeps running
 * through the board's own failure handling, and after `UNBOX_RETRY_TICKS` the escape is tried again.
 */
function unbox(faction: FactionState, member: CrewMember, tick: number): void {
  if (!member.character.valid) return
  let plan = escapePlan(faction, member)
  const p = member.character.position
  // M7c.8 (fresh seed 11): walled into a pocket wider than its reach (water on three sides, the factory's own modules on
  // the fourth, every blocker 5+ tiles away): it walks to the pocket's edge and picks up an own entity there.
  let stand: MapPosition | undefined
  if (plan.length === 0) {
    const pocket = pocketEscape(faction, member)
    if (pocket !== undefined) {
      plan = [{ entity: pocket.entity, act: "pickUp", rank: 0 }]
      stand = pocket.stand
    }
  }
  if (plan.length === 0) {
    if (tick < (member.unboxRetryAt ?? 0)) return
    member.unboxRetryAt = tick + UNBOX_RETRY_TICKS
    log(`[rival-engineers] faction ${faction.name}: member ${member.id} is stuck at ${math.floor(p.x)},${math.floor(p.y)} and nothing in reach to clear; retrying in ${UNBOX_RETRY_TICKS} ticks`)
    return
  }
  resetMember(faction, member, tick)
  member.stats.unboxed = (member.stats.unboxed ?? 0) + 1
  if (stand !== undefined) {
    member.actions.push({ action: enqueue(member.controller, { kind: "walk", goal: stand, radius: 0.4 }) })
    log(`[rival-engineers] faction ${faction.name}: member ${member.id} is walled into a pocket at ${math.floor(p.x)},${math.floor(p.y)}: walks to ${stand.x},${stand.y} at its edge`)
  }
  if (plan.length > 1 || (plan.length === 1 && plan[0].act === "mine")) {
    for (const t of plan) {
      member.actions.push({ action: enqueue(member.controller, { kind: "mine", target: t.entity }) })
    }
    const e = plan[0].entity
    log(`[rival-engineers] faction ${faction.name}: member ${member.id} is boxed in at ${math.floor(p.x)},${math.floor(p.y)}: mines ${plan.length} tree/rock around it (${e.name} at ${e.position.x},${e.position.y} first) to get out`)
    return
  }
  const e = plan[0].entity
  // B42: an entity the planner already wants gone (an obsolete route piece, a growth's pick-up) is not re-placed: the
  // pick-up does its clear job — claimed here when it is open, so it ends done — and no ghost brings it back.
  const clearId = clearJobFor(faction, e)
  if (clearId !== undefined) {
    const board = faction.board
    const job = board.jobs[clearId]
    const ownJob = job.status === "open" && claim(board, [clearId], member.id, tick)
    if (ownJob) member.claims.push(clearId)
    member.actions.push({ action: enqueue(member.controller, { kind: "pickUp", entity: e }), job: ownJob ? clearId : undefined })
    log(`[rival-engineers] faction ${faction.name}: member ${member.id} is boxed in at ${math.floor(p.x)},${math.floor(p.y)}: picks up ${e.name} at ${e.position.x},${e.position.y} (cleared for job ${clearId}, not re-placed)`)
    return
  }
  const params: Record<string, unknown> = { name: "entity-ghost", inner_name: e.name, position: e.position, direction: e.direction, force: faction.force }
  if (e.type === "underground-belt") params.type = e.belt_to_ground_type
  if (e.type === "assembling-machine") params.recipe = e.get_recipe()[0]?.name
  member.actions.push({ action: enqueue(member.controller, { kind: "pickUp", entity: e }) })
  // The ghost goes in once the entity is gone (a ghost can't overlap it): the next poll makes it.
  storage.unboxGhosts ??= []
  storage.unboxGhosts.push({ faction: faction.name, params, tick })
  log(`[rival-engineers] faction ${faction.name}: member ${member.id} is boxed in at ${math.floor(p.x)},${math.floor(p.y)}: picks up ${e.name} at ${e.position.x},${e.position.y} (re-placed from a ghost)`)
}

/** M6: ghosts for what boxed-in members picked up, once the entity is gone; each gets a place job. */
export function placeUnboxGhosts(tick: number): void {
  const list = storage.unboxGhosts
  if (list === undefined || list.length === 0) return
  const keep: typeof list = []
  for (const g of list) {
    const faction = storage.factions[g.faction]
    if (faction === undefined) continue
    const surface = factionSurface(faction)
    // M7c.8: not before the member had time to walk out through the gap: re-placed at once, the member that picked it up
    // (still beside it) took the place job and walled itself in again (fresh seed 11, steam engines, four rounds).
    if (tick - g.tick < UNBOX_GHOST_DELAY) {
      keep.push(g)
      continue
    }
    const pos = g.params.position as { x: number; y: number }
    const still = findEntities(surface, { name: g.params.inner_name as string, position: pos, force: faction.force, limit: 1 })[0]
    if (still !== undefined) {
      if (tick - g.tick < 3600) keep.push(g)
      continue
    }
    const ghost = surface.create_entity(g.params as never)
    if (ghost !== undefined) addPlaceJob(faction, ghost, { priority: 90 })
  }
  storage.unboxGhosts = keep
}

/** B102: each faction's `pendingGhosts` whose clear jobs are over get their ghost and place job. */
export function placePendingGhosts(): void {
  for (const name of storage.factionOrder) {
    const faction = storage.factions[name]
    const list = faction.pendingGhosts
    if (list === undefined || list.length === 0) continue
    const left: typeof list = []
    for (const p of list) {
      let waiting = false
      for (const id of p.after) {
        const j = getJob(faction.board, id)
        if (j !== undefined && j.status !== "done" && j.status !== "failed") waiting = true
      }
      if (waiting) {
        left.push(p)
        continue
      }
      const params: Record<string, unknown> = { name: "entity-ghost", inner_name: p.name, position: { x: p.x, y: p.y }, direction: p.dir, force: faction.force }
      if (p.ioType !== undefined) params.type = p.ioType
      const ghost = factionSurface(faction).create_entity(params as never)
      log(`[rival-engineers] faction ${faction.name}: B102 puts ${p.name} back at ${p.x},${p.y} under a picked-up splitter${ghost === undefined ? ": ghost failed" : ""}`)
      if (ghost !== undefined) addPlaceJob(faction, ghost, { priority: p.priority })
    }
    faction.pendingGhosts = left
  }
}

function finishJob(faction: FactionState, member: CrewMember, job: CrewJob, action: ActionRecord | undefined, tick: number): void {
  if (job.payload.kind === "place") {
    job.payload.built = action?.placed
    // The ghost became the entity (revive): forget the mapping.
    delete faction.ghostJobs[job.payload.ghostKey]
  }
  complete(faction.board, job.id, member.id, tick)
  countWork("jobsProcessed")
  removeClaim(member, job.id)
  if (job.kind !== "haul") member.stats.jobsDone++
  // A finished craft is a plan step for the strategy layer's stall detection.
  if (faction.brain && job.payload.kind === "craft") faction.brain.steps++
}

/**
 * Drops everything a member is doing: cancels its actions, gives back its claims (without penalty; its own
 * hauls and deposits fail) and its stockpile reservations. Used when the strategy layer replans.
 */
export function resetMember(faction: FactionState, member: CrewMember, tick: number): void {
  for (const ca of member.actions) {
    cancel(ca.action)
    unreserve(faction, ca.reserve)
  }
  member.actions = []
  const board = faction.board
  for (const jobId of member.claims) {
    const job = board.jobs[jobId]
    if (job === undefined || job.status !== "claimed") continue
    if (isSelfJob(job)) failJob(board, jobId, "reset", tick, member.id)
    else release(board, jobId, member.id, tick, { reason: "reset", penalize: false, maxAttempts: 1, retryTicks: 0 })
  }
  member.claims = []
  member.spot = undefined
}

function charactersIn(faction: FactionState, rect: Rect | undefined): boolean {
  if (!rect) return false
  const found = findEntities(factionSurface(faction), {
    type: "character",
    area: [
      [rect.x1, rect.y1],
      [rect.x2, rect.y2],
    ],
    limit: 1,
  })
  return found.length > 0
}

function jobFailed(
  faction: FactionState,
  member: CrewMember,
  job: CrewJob,
  action: ActionRecord | undefined,
  status: ActionStatus,
  config: Config,
  tick: number,
): void {
  const board = faction.board
  removeClaim(member, job.id)
  member.stats.jobsReleased++
  const reason = action ? `${action.reason ?? status}${action.detail ? ": " + action.detail : ""}` : "action-lost"
  if (status === "cancelled") {
    release(board, job.id, member.id, tick, { reason, penalize: false, maxAttempts: config.jobMaxAttempts, retryTicks: 0 })
    return
  }
  const payload = job.payload
  if (payload.kind === "place" && !payload.ghost.valid) {
    failJob(board, job.id, "ghost-removed", tick, member.id)
    return
  }
  // B66 (5387208): Factorio accepts a ghost on top of the same live entity, and that ghost can never be revived. The
  // entity it asks for already stands, so the job is done: drop the ghost instead of retrying it forever.
  if (payload.kind === "place" && action?.reason === "cannot-place") {
    const g = payload.ghost
    const twin = findEntities(factionSurface(faction), { name: g.ghost_name, position: g.position, force: faction.force, limit: 1 })[0]
    if (twin !== undefined && twin.direction === g.direction) {
      g.destroy()
      delete faction.ghostJobs[payload.ghostKey]
      payload.built = twin
      complete(board, job.id, member.id, tick)
      return
    }
  }
  // M7c (seed 11, agent design, proposed): a mining drill with no ore left in its mining area can never be placed by a
  // character (a script placement check still says it fits). Its ore was mined out after the plan; drop the ghost so the
  // goal finishes with the drills that stand, instead of retrying until it gives up its location (B20) and tears down
  // the whole module.
  if (payload.kind === "place" && action?.reason === "cannot-place" && payload.ghost.ghost_type === "mining-drill" && !oreUnder(payload.ghost)) {
    delete faction.ghostJobs[payload.ghostKey]
    payload.ghost.destroy()
    failJob(board, job.id, "no-ore-left", tick, member.id)
    return
  }
  // A character standing on the spot is temporary: retry soon, without spending an attempt.
  const blocked = payload.kind === "place" && action?.reason === "cannot-place" && charactersIn(faction, job.footprint)
  const penalize = !blocked || (job.deferrals ?? 0) >= MAX_DEFERRALS
  release(board, job.id, member.id, tick, {
    reason: blocked ? "blocked-by-character" : reason,
    penalize,
    maxAttempts: config.jobMaxAttempts,
    retryTicks: config.jobRetryTicks,
    delay: config.jobBlockedRetryTicks,
  })
}

/** Whether any resource lies in a drill ghost's mining area. */
function oreUnder(ghost: LuaEntity): boolean {
  const r = prototypes.entity[ghost.ghost_name].mining_drill_radius ?? 1
  const p = ghost.position
  const area = { left_top: { x: p.x - r, y: p.y - r }, right_bottom: { x: p.x + r, y: p.y + r } }
  return countEntities(ghost.surface, { area, type: "resource", limit: 1 }) > 0
}

// ---------------------------------------------------------------------------------------------------
// Materials

function addContents(into: Record<string, number>, inventory: LuaInventory | undefined, sign: number): void {
  if (!inventory) return
  for (const entry of inventory.get_contents()) into[entry.name] = (into[entry.name] ?? 0) + sign * entry.count
}

function heldItems(character: LuaEntity): Record<string, number> {
  const held: Record<string, number> = {}
  addContents(held, character.get_main_inventory() ?? undefined, 1)
  return held
}

function validStockpiles(faction: FactionState): LuaEntity[] {
  const valid: LuaEntity[] = []
  for (const chest of faction.stockpiles) if (chest.valid) valid.push(chest)
  if (valid.length !== faction.stockpiles.length) faction.stockpiles = valid
  return valid
}

/**
 * What the member can work with: its own inventory plus what the stockpiles and supply points hold (B32), minus what
 * others are about to take from each source.
 */
function availableItems(faction: FactionState, held: Record<string, number>, config: Config): Record<string, number> {
  const avail: Record<string, number> = {}
  for (const item in held) avail[item] = held[item]
  validStockpiles(faction)
  for (const h of takeable(faction, config.supplyMinTake)) avail[h.item] = (avail[h.item] ?? 0) + h.amount
  // Reservations from before B32 carry no source.
  for (const item in faction.reserved) avail[item] = (avail[item] ?? 0) - faction.reserved[item]
  return avail
}

function hasMaterials(job: CrewJob, avail: Record<string, number>): boolean {
  for (const m of job.materials) if ((avail[m.item] ?? 0) < m.count) return false
  return true
}

function unreserve(faction: FactionState, item: (ItemCount & { from?: number }) | undefined): void {
  if (!item) return
  if (item.from !== undefined) {
    unreserveAt(faction, item.from, item.item, item.count)
    return
  }
  const left = (faction.reserved[item.item] ?? 0) - item.count
  if (left > 0) faction.reserved[item.item] = left
  else delete faction.reserved[item.item]
}

// ---------------------------------------------------------------------------------------------------
// Planning a batch

/** The entity a fuel job fills, once known and valid. */
function fuelTarget(faction: FactionState, job: CrewJob): LuaEntity | undefined {
  const payload = job.payload
  if (payload.kind !== "fuel") return undefined
  if (payload.target) return payload.target.valid ? payload.target : undefined
  const placeJob = payload.targetJob !== undefined ? faction.board.jobs[payload.targetJob] : undefined
  const built = placeJob?.payload.kind === "place" ? placeJob.payload.built : undefined
  return built?.valid ? built : undefined
}

/** Fails ready jobs whose targets are gone, so nobody claims them. */
function dropDeadJobs(faction: FactionState, tick: number): void {
  const board = faction.board
  for (const id of [...board.active]) {
    const job = board.jobs[id]
    if (job.status !== "open") continue
    const payload = job.payload
    let gone: string | undefined
    // M7c.8: an open self-job can never be claimed again (saves from before the pollActions fix hold thousands).
    if (isSelfJob(job)) gone = "orphan-self-job"
    else if (payload.kind === "place" && !payload.ghost.valid) gone = "ghost-removed"
    else if ((payload.kind === "gather" || payload.kind === "clear") && !payload.target.valid) gone = "target-invalid"
    else if (payload.kind === "gather" && payload.deliverTo && !payload.deliverTo.valid) gone = "target-invalid"
    else if (payload.kind === "craft" && payload.deliverTo && !payload.deliverTo.valid) gone = "target-invalid"
    else if (payload.kind === "transfer" && (!payload.from.valid || !payload.to.valid)) gone = "target-invalid"
    else if (payload.kind === "fuel" && depsDone(board, job) && !fuelTarget(faction, job)) gone = "target-invalid"
    if (gone !== undefined) failJob(board, id, gone, tick)
  }
}

function otherSpots(faction: FactionState, member: CrewMember): Rect[] {
  const rects: Rect[] = []
  for (const id of faction.crew) {
    const other = storage.crew[id]
    if (other.id === member.id || other.dead || !other.character.valid) continue
    const p = other.spot ?? other.character.position
    rects.push({ x1: p.x - 0.6, y1: p.y - 0.6, x2: p.x + 0.6, y2: p.y + 0.6 })
  }
  // B111: spots no walk could reach lately.
  for (const r of badSpotRects(faction.badSpots, game.tick)) rects.push(r)
  return rects
}

/** The nearest stockpile or supply point the crew can take `item` from (B32). */
function nearestSource(faction: FactionState, from: Pos, item: string, config: Config): LuaEntity | undefined {
  let best: LuaEntity | undefined
  let bestD = 0
  for (const h of takeable(faction, config.supplyMinTake)) {
    if (h.item !== item) continue
    const d = distance(from, h.entity.position)
    if (best === undefined || d < bestD) {
      best = h.entity
      bestD = d
    }
  }
  return best
}

function planNext(faction: FactionState, member: CrewMember, config: Config, tick: number): void {
  const board = faction.board
  const character = member.character
  const pos = character.position
  dropDeadJobs(faction, tick)
  notePlanSeen(faction, member, tick)
  const held = heldItems(character)
  let avail = availableItems(faction, held, config)
  // B31: the urgent job this member just dropped its batch for (taken first, without depositing first).
  const forced = member.preemptFor !== undefined ? board.jobs[member.preemptFor] : undefined
  member.preemptFor = undefined
  // Brain-driven factions keep pockets empty between jobs, so every crew member sees the same materials.
  if (forced === undefined && (faction.brain || faction.depositBetweenJobs) && deposit(faction, member, held, tick, coveredItems(board, held, tick))) return
  const rejected: Record<number, string> = {}
  const accept = (job: CrewJob): boolean => {
    if (isSelfJob(job)) { rejected[job.id] = "self-job"; return false }
    if (!hasMaterials(job, avail)) { rejected[job.id] = "materials"; return false }
    if (job.kind === "fuel" && fuelTarget(faction, job) === undefined) { rejected[job.id] = "fuel-target"; return false }
    return true
  }
  let anchor = forced !== undefined && isReady(board, forced, tick) && accept(forced) ? forced : selectJob(board, pos, tick, accept)
  if (!anchor) {
    let claimed = 0
    let waiting = 0
    for (const id of board.active) {
      const job = board.jobs[id]
      if (job.status === "claimed") claimed++
      else if (!isReady(board, job, tick)) waiting++
    }
    recordCrewPlan(faction, member, tick, "idle", rejected, { forced: forced?.id, active: board.active.length, claimed, waiting })
    member.idleUntil = tick + IDLE_REPLAN_TICKS
    member.idleBoard = boardChanges(board)
    return
  }
  member.stats.plans++
  // D38 opportunistic crafting: a craft job is queued and runs while the member does other work, like a player who
  // queues crafts and walks on. A craft anchor takes the next other work along; other work takes open crafts along
  // when the member visits the depot anyway (it hauls materials there).
  const background = faction.brain !== undefined || faction.depositBetweenJobs === true ? config.crewBackgroundCrafts : 0
  const crafts: CrewJob[] = []
  if (background > 0 && anchor.kind === "craft") {
    const rest = withoutMaterials(avail, anchor.materials)
    const work = selectJob(board, pos, tick, (job) => job.kind !== "craft" && !isSelfJob(job) && hasMaterials(job, rest) && accept(job))
    if (work !== undefined) {
      crafts.push(anchor)
      anchor = work
      avail = rest
    }
  }

  let jobs: CrewJob[] = [anchor]
  let spot: Pos | undefined
  if (anchor.kind === "place" || anchor.kind === "fuel") {
    // Stand where every job of the batch is in reach. Plan from the stockpile when the member must fetch
    // materials first, since that is where it will walk from.
    let from: Pos = pos
    const missing = missingMaterials([anchor], held)
    if (missing.length > 0) from = nearestSource(faction, pos, missing[0].item, config)?.position ?? pos
    const reach = (anchor.kind === "place" ? character.build_distance : character.reach_distance) - 1.5
    const surface = character.surface
    const batch = planBatch(board, anchor, from, tick, {
      reach,
      maxJobs: config.batchMaxJobs,
      accept,
      isFree: (p) => surface.can_place_entity({ name: "character", position: p }),
      extraAvoid: otherSpots(faction, member),
    })
    jobs = []
    for (const id of batch.jobs) jobs.push(board.jobs[id])
    spot = batch.spot
  } else if (isTripJob(faction, anchor)) {
    // B3: chain nearby clears and wood gathers into one trip instead of a depot round trip per job.
    const inv = character.get_main_inventory()!
    const trip = planTrip(board, anchor, tick, {
      maxJobs: config.tripMaxJobs,
      radius: config.tripRadius,
      accept: (job) => accept(job) && isTripJob(faction, job),
      load: tripLoad,
      capacity: inv.count_empty_stacks() * config.tripInventoryFill,
    })
    jobs = []
    for (const id of trip) jobs.push(board.jobs[id])
  }
  jobs = fitMaterials(jobs, avail)
  if (background > crafts.length && anchor.kind !== "craft" && missingMaterials(jobs, held).length > 0) {
    let rest = avail
    for (const job of jobs) rest = withoutMaterials(rest, job.materials)
    while (crafts.length < background) {
      const left = rest
      const c = selectJob(board, pos, tick, (job) => job.kind === "craft" && crafts.indexOf(job) < 0 && hasMaterials(job, left) && accept(job))
      if (c === undefined) break
      crafts.push(c)
      rest = withoutMaterials(rest, c.materials)
    }
  }
  const ids: number[] = []
  for (const job of jobs) ids.push(job.id)
  for (const job of crafts) ids.push(job.id)
  if (!claim(board, ids, member.id, tick)) return
  member.claims = ids
  member.stats.batches++
  if (forced !== undefined && ids.indexOf(forced.id) >= 0) member.stats.preemptTaken = (member.stats.preemptTaken ?? 0) + 1

  let missing = missingMaterials([...jobs, ...crafts], held)
  // D66: a place batch whose source is far also brings what the ready place jobs nearer than that source need, so the
  // next batches there start from the member's inventory instead of another round trip (8646103: 10 belts a 500-tile walk).
  if (anchor.kind === "place" && missing.length > 0) {
    const source = nearestSource(faction, pos, missing[0].item, config)
    const to = spot ?? anchor.pos
    if (source !== undefined) {
      const slots = character.get_main_inventory()!.count_empty_stacks() * config.tripInventoryFill
      const extra = prefetchJobs(board, jobs, to, distance(source.position, to), tick, held, slots, stacksFor, accept)
      if (extra.length > 0) missing = missingMaterials([...jobs, ...extra, ...crafts], held)
    }
  }
  recordCrewPlan(faction, member, tick, "batch", rejected, { forced: forced?.id, anchor: anchor.id, jobs: ids, missing })
  // B32: the haul's sources are chosen for the detour on the way to where the batch is worked (a craft: anywhere).
  if (missing.length > 0) haul(faction, member, missing, spot ?? (anchor.kind === "craft" ? pos : anchor.pos), config, tick)
  for (const c of crafts) startCraft(member, c)
  if (spot && distance(pos, spot) > 0.5) {
    member.spot = spot
    member.actions.push({ action: enqueue(member.controller, { kind: "walk", goal: spot, radius: 0.4 }), spot })
  }
  if (jobs.length > 1 && isTripJob(faction, jobs[0])) enqueueTrip(faction, member, jobs)
  else for (const job of jobs) enqueueWork(faction, member, job)
  for (const c of crafts) finishCraft(member, c)
}

/** Inventory stacks `need` takes (D66). */
function stacksFor(this: void, need: ItemCount[]): number {
  let n = 0
  for (const m of need) n += math.ceil(m.count / (prototypes.item[m.item]?.stack_size ?? 1))
  return n
}

function withoutMaterials(avail: Record<string, number>, materials: ItemCount[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item in avail) out[item] = avail[item]
  for (const m of materials) out[m.item] = (out[m.item] ?? 0) - m.count
  return out
}

/** D38: queue a craft job's crafts (they run in the background of the batch). */
function startCraft(member: CrewMember, job: CrewJob): void {
  const p = job.payload
  if (p.kind !== "craft") return
  member.actions.push({ action: enqueue(member.controller, { kind: "craft", recipe: p.recipe, count: p.count, mode: "start" }), job: job.id })
  member.stats.backgroundCrafts = (member.stats.backgroundCrafts ?? 0) + 1
}

/** D38: after the batch, wait for the background crafts (usually done by then) and deliver them. */
function finishCraft(member: CrewMember, job: CrewJob): void {
  const p = job.payload
  if (p.kind !== "craft") return
  member.actions.push({ action: enqueue(member.controller, { kind: "craft", recipe: p.recipe, count: p.count, mode: "await" }), job: job.id })
  if (p.deliverTo && p.item) {
    member.actions.push({ action: enqueue(member.controller, { kind: "insert", entity: p.deliverTo, item: p.item, count: p.count * craftYield(p.recipe, p.item), allowPartial: true }), job: job.id })
  }
}

/**
 * Trip jobs (B3): mining whose products go back to the depot. Clears (trees, rocks, the faction's own entities to
 * pick up) and gathers from trees or rocks delivered to a stockpile (wood). Ore gathers feed furnaces one by one.
 */
function isTripJob(faction: FactionState, job: CrewJob): boolean {
  const p = job.payload
  if (p.kind === "clear") return p.target.valid
  if (p.kind !== "gather" || !p.target.valid || p.target.type === "resource") return false
  return p.deliverTo === undefined || faction.stockpiles.indexOf(p.deliverTo) >= 0
}

/** Inventory slots a trip job's products take (fractions of a stack add up). */
function tripLoad(this: void, job: CrewJob): number {
  const p = job.payload
  if (p.kind !== "clear" && p.kind !== "gather") return 0
  if (!p.target.valid) return 0
  let slots = 0
  for (const product of p.target.prototype.mineable_properties.products ?? []) {
    if (product.type !== "item") continue
    const amount = product.amount ?? product.amount_max ?? 1
    slots += amount / prototypes.item[product.name].stack_size
  }
  return slots
}

/** A trip: every mining action in order, then one delivery per depot for the gathers (the brain deposits the rest). */
function enqueueTrip(faction: FactionState, member: CrewMember, jobs: CrewJob[]): void {
  const deliveries: { to: LuaEntity; item: string; count: number; job: number }[] = []
  for (const job of jobs) {
    const p = job.payload
    if (p.kind === "gather") {
      member.actions.push({ action: enqueue(member.controller, { kind: "mine", target: p.target, count: p.count }), job: job.id })
      if (p.deliverTo === undefined) continue
      let d: { to: LuaEntity; item: string; count: number; job: number } | undefined
      for (const other of deliveries) if (other.to === p.deliverTo && other.item === p.item) d = other
      if (d === undefined) deliveries.push({ to: p.deliverTo, item: p.item, count: p.count, job: job.id })
      else {
        d.count += p.count
        d.job = job.id
      }
    } else enqueueWork(faction, member, job)
  }
  // The delivery belongs to the last gather to that depot: earlier gathers finish when their mining does.
  for (const d of deliveries) {
    member.actions.push({ action: enqueue(member.controller, { kind: "insert", entity: d.to, item: d.item, count: d.count, allowPartial: true }), job: d.job })
  }
  member.stats.trips = (member.stats.trips ?? 0) + 1
}

/**
 * B117: items the member keeps between jobs: every material of an open, ready job that its pocket alone covers. A member
 * carrying poles to an outpost 600 tiles out walked home to deposit them before each pole job, then took them back.
 * Materials split across pockets (13 and 10 wood for a craft of 14, B116) are still deposited, so they pool.
 */
function coveredItems(board: FactionState["board"], held: Record<string, number>, tick: number): Record<string, boolean> {
  const keep: Record<string, boolean> = {}
  for (const id of board.active) {
    const job = board.jobs[id]
    if (job.materials.length === 0 || isSelfJob(job) || !isReady(board, job, tick) || !hasMaterials(job, held)) continue
    for (const m of job.materials) keep[m.item] = true
  }
  return keep
}

/** Item types a crew member keeps on itself instead of depositing (its own weapons and armour). */
const KEEP_TYPES: Record<string, boolean> = { gun: true, ammo: true, armor: true }

/**
 * Puts what the member carries into the faction's stockpiles (whatever fits). Returns whether it queued
 * anything. Creates a deposit job the member claims for itself, like a haul.
 */
function deposit(faction: FactionState, member: CrewMember, held: Record<string, number>, tick: number, keep: Record<string, boolean>): boolean {
  const piles = validStockpiles(faction)
  if (piles.length === 0) return false
  const names: string[] = []
  for (const item in held) if (held[item] > 0 && !keep[item] && !KEEP_TYPES[prototypes.item[item]?.type ?? ""]) names.push(item)
  if (names.length === 0) return false
  names.sort()
  const board = faction.board
  let job: CrewJob | undefined
  for (const item of names) {
    let chest: LuaEntity | undefined
    let bestD = 0
    let fits = 0
    for (const pile of piles) {
      const room = pile.get_inventory(defines.inventory.chest)!.get_insertable_count(item)
      if (room <= 0) continue
      const d = distance(member.character.position, pile.position)
      if (chest === undefined || d < bestD) {
        chest = pile
        bestD = d
        fits = room
      }
    }
    // Only what fits: a member must never keep walking back to a full depot with the same items.
    if (!chest) continue
    if (!job) {
      job = addJob(board, { kind: "haul", pos: chest.position, payload: { kind: "deposit", forMember: member.id } }, tick)
      claim(board, [job.id], member.id, tick)
      member.claims.push(job.id)
    }
    const action = enqueue(member.controller, { kind: "insert", entity: chest, item, count: math.min(held[item], fits), allowPartial: true })
    member.actions.push({ action, job: job.id })
  }
  if (!job) return false
  member.stats.deposits = (member.stats.deposits ?? 0) + 1
  return true
}

/**
 * B32: takes the batch's missing materials straight from wherever the faction holds them (stockpiles and supply
 * points), possibly from several sources in one trip. Sources are picked greedily from where the member is: first
 * one that holds the whole remaining need of an item it has (one stop beats several), the smallest detour on the way
 * to `toward` among those (or among all, if none covers a whole need); ties by unit number. Each take is reserved at
 * its source until it finishes, so other members don't count the same stack.
 */
function haul(faction: FactionState, member: CrewMember, missing: ItemCount[], toward: Pos, config: Config, tick: number): void {
  const board = faction.board
  const left: Record<string, number> = {}
  for (const need of missing) left[need.item] = (left[need.item] ?? 0) + need.count
  // Sources by entity, in the deterministic holdings order.
  const groups: { entity: LuaEntity; items: Holding[] }[] = []
  const byId: Record<number, number> = {}
  for (const h of takeable(faction, config.supplyMinTake)) {
    if ((left[h.item] ?? 0) <= 0) continue
    const id = h.entity.unit_number ?? -1
    let g = byId[id]
    if (g === undefined) {
      g = groups.length
      byId[id] = g
      groups.push({ entity: h.entity, items: [] })
    }
    groups[g].items.push(h)
  }
  let cur: Pos = member.character.position
  const used: Record<number, boolean> = {}
  const selected: { unit: number; depot: boolean; item: string; available: number; taken: number; detour: number }[] = []
  let job: CrewJob | undefined
  for (;;) {
    let best = -1
    let bestFull = false
    let bestCost = 0
    for (let i = 0; i < groups.length; i++) {
      if (used[i]) continue
      const g = groups[i]
      let covers = false
      let full = false
      for (const h of g.items) {
        const want = left[h.item] ?? 0
        if (want <= 0) continue
        covers = true
        if (h.amount >= want) full = true
      }
      if (!covers) continue
      const p = g.entity.position
      const cost = distance(cur, p) + distance(p, toward) - distance(cur, toward)
      if (best < 0 || (full && !bestFull) || (full === bestFull && cost < bestCost - 1e-9)) {
        best = i
        bestFull = full
        bestCost = cost
      }
    }
    if (best < 0) break
    used[best] = true
    const g = groups[best]
    if (job === undefined) {
      job = addJob(board, { kind: "haul", pos: g.entity.position, payload: { kind: "haul", forMember: member.id } }, tick)
      claim(board, [job.id], member.id, tick)
      member.claims.push(job.id)
      member.stats.hauls++
    }
    for (const h of g.items) {
      const want = left[h.item] ?? 0
      if (want <= 0) continue
      const count = math.min(h.amount, want)
      left[h.item] = want - count
      reserveAt(faction, g.entity, h.item, count)
      // Partial: grab what is there when we arrive, like a player.
      const action = enqueue(member.controller, { kind: "take", entity: g.entity, item: h.item, count, allowPartial: true })
      member.actions.push({ action, job: job.id, reserve: { item: h.item, count, from: g.entity.unit_number }, src: h.kind })
      selected.push({ unit: g.entity.unit_number ?? -1, depot: h.depot, item: h.item, available: h.amount, taken: count, detour: bestCost })
    }
    cur = g.entity.position
  }
  const unfilled: Record<string, number> = {}
  for (const [item, count] of pairs(left)) if ((count as number) > 0) unfilled[item as string] = count as number
  recordCrewSupply(faction, member, tick, { missing, candidateSources: groups.length, selected, unfilled, toward })
}

function enqueueWork(faction: FactionState, member: CrewMember, job: CrewJob): void {
  const ctrl = member.controller
  const push = (action: number): void => {
    member.actions.push({ action, job: job.id })
  }
  const payload = job.payload
  switch (payload.kind) {
    case "place":
      push(enqueue(ctrl, { kind: "place", item: payload.item, position: payload.position, direction: payload.direction, ghost: payload.ghost }))
      break
    case "fuel":
      push(enqueue(ctrl, { kind: "insert", entity: fuelTarget(faction, job)!, item: payload.item, count: payload.count, allowPartial: payload.partial }))
      break
    case "gather":
      push(enqueue(ctrl, { kind: "mine", target: payload.target, count: payload.count }))
      if (payload.deliverTo) push(enqueue(ctrl, { kind: "insert", entity: payload.deliverTo, item: payload.item, count: payload.count, allowPartial: true }))
      break
    case "craft":
      push(enqueue(ctrl, { kind: "craft", recipe: payload.recipe, count: payload.count }))
      if (payload.deliverTo && payload.item) {
        push(enqueue(ctrl, { kind: "insert", entity: payload.deliverTo, item: payload.item, count: payload.count * craftYield(payload.recipe, payload.item), allowPartial: true }))
      }
      break
    case "transfer":
      push(enqueue(ctrl, { kind: "take", entity: payload.from, item: payload.item, count: payload.count, allowPartial: true }))
      push(enqueue(ctrl, { kind: "insert", entity: payload.to, item: payload.item, count: payload.count, allowPartial: true }))
      break
    case "clear":
      if (payload.target.force.name === faction.force) push(enqueue(ctrl, { kind: "pickUp", entity: payload.target }))
      else push(enqueue(ctrl, { kind: "mine", target: payload.target }))
      break
    case "haul":
    case "deposit":
      break
  }
}

/** Items of `item` one craft of `recipe` yields. */
export function craftYield(recipe: string, item: string): number {
  for (const p of prototypes.recipe[recipe].products) {
    if (p.type === "item" && p.name === item) return p.amount ?? p.amount_min ?? 1
  }
  return 1
}
