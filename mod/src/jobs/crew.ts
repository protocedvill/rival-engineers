import { LuaEntity, LuaInventory } from "factorio:runtime"
import { cancel, cancelAll, enqueue, getAction } from "../character/controller"
import { ActionRecord, ActionStatus } from "../character/types"
import { Config, getConfig } from "../config"
import {
  claim,
  complete,
  countReady,
  depsDone,
  distance,
  failJob,
  fitMaterials,
  ItemCount,
  Job,
  missingMaterials,
  planBatch,
  Pos,
  Rect,
  release,
  releaseAllOf,
  selectJob,
  addJob,
} from "./board"
import { factionSurface } from "./faction"
import { CrewMember, FactionState, JobPayload } from "./types"

// Crew runtime (SPEC §5.2): every tick, each crew member of each faction turns its claimed jobs into
// Character Controller actions and watches them finish. An idle member claims the highest-priority ready
// job (nearest first) plus every same-kind job it can reach from one standing spot, hauls the missing
// materials from the faction's stockpiles, walks to the spot and works through the batch.
//
// Factions never share anything: each has its own board, stockpiles and crew, and a member only ever
// looks at its own faction.

type CrewJob = Job<JobPayload>

/** Unpenalised releases of one job before a blocked placement counts as a failed attempt after all. */
const MAX_DEFERRALS = 40

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
          release(faction.board, jobId, member.id, tick, { reason: "no-actions", penalize: false, maxAttempts: config.jobMaxAttempts, retryTicks: 0 })
        }
        member.claims = []
      }
      member.spot = undefined
      if (!faction.paused) planNext(faction, member, config, tick)
    }
  }
  // Idle accounting (M2 acceptance): a member is idle on a tick when it holds no claim while ready jobs exist.
  const ready = countReady(faction.board, tick)
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
    } else if (ready > 0) stats.idleTicks++
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
  while (member.actions.length > 0) {
    const ca = member.actions[0]
    const action = getAction(ca.action)
    const status: ActionStatus = action?.status ?? "failed"
    if (status === "queued" || status === "running") break
    member.actions.shift()
    unreserve(faction, ca.reserve)
    if (ca.job === undefined) continue // the walk to the standing spot
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
}

function finishJob(faction: FactionState, member: CrewMember, job: CrewJob, action: ActionRecord | undefined, tick: number): void {
  if (job.payload.kind === "place") {
    job.payload.built = action?.placed
    // The ghost became the entity (revive): forget the mapping.
    delete faction.ghostJobs[job.payload.ghostKey]
  }
  complete(faction.board, job.id, member.id, tick)
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
  const found = factionSurface(faction).find_entities_filtered({
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

/** What the member can work with: its own inventory plus the stockpiles minus what others are about to take. */
function availableItems(faction: FactionState, held: Record<string, number>): Record<string, number> {
  const avail: Record<string, number> = {}
  for (const item in held) avail[item] = held[item]
  for (const chest of validStockpiles(faction)) addContents(avail, chest.get_inventory(defines.inventory.chest) ?? undefined, 1)
  for (const item in faction.reserved) avail[item] = (avail[item] ?? 0) - faction.reserved[item]
  return avail
}

function hasMaterials(job: CrewJob, avail: Record<string, number>): boolean {
  for (const m of job.materials) if ((avail[m.item] ?? 0) < m.count) return false
  return true
}

function reserve(faction: FactionState, item: ItemCount): void {
  faction.reserved[item.item] = (faction.reserved[item.item] ?? 0) + item.count
}

function unreserve(faction: FactionState, item: ItemCount | undefined): void {
  if (!item) return
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
    if (payload.kind === "place" && !payload.ghost.valid) gone = "ghost-removed"
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
  return rects
}

function nearestStockpile(faction: FactionState, from: Pos, item: string): LuaEntity | undefined {
  let best: LuaEntity | undefined
  let bestD = 0
  for (const chest of validStockpiles(faction)) {
    if (chest.get_item_count(item) <= 0) continue
    const d = distance(from, chest.position)
    if (best === undefined || d < bestD) {
      best = chest
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
  const held = heldItems(character)
  const avail = availableItems(faction, held)
  // Brain-driven factions keep pockets empty between jobs, so every crew member sees the same materials.
  if (faction.brain && deposit(faction, member, held, tick)) return
  const accept = (job: CrewJob): boolean => {
    if (isSelfJob(job) || !hasMaterials(job, avail)) return false
    if (job.kind === "fuel") return fuelTarget(faction, job) !== undefined
    return true
  }
  const anchor = selectJob(board, pos, tick, accept)
  if (!anchor) return
  member.stats.plans++

  let jobs: CrewJob[] = [anchor]
  let spot: Pos | undefined
  if (anchor.kind === "place" || anchor.kind === "fuel") {
    // Stand where every job of the batch is in reach. Plan from the stockpile when the member must fetch
    // materials first, since that is where it will walk from.
    let from: Pos = pos
    const missing = missingMaterials([anchor], held)
    if (missing.length > 0) from = nearestStockpile(faction, pos, missing[0].item)?.position ?? pos
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
  }
  jobs = fitMaterials(jobs, avail)
  const ids: number[] = []
  for (const job of jobs) ids.push(job.id)
  if (!claim(board, ids, member.id, tick)) return
  member.claims = ids
  member.stats.batches++

  const missing = missingMaterials(jobs, held)
  if (missing.length > 0) haul(faction, member, missing, tick)
  if (spot && distance(pos, spot) > 0.5) {
    member.spot = spot
    member.actions.push({ action: enqueue(member.controller, { kind: "walk", goal: spot, radius: 0.4 }) })
  }
  for (const job of jobs) enqueueWork(faction, member, job)
}

/** Item types a crew member keeps on itself instead of depositing (its own weapons and armour). */
const KEEP_TYPES: Record<string, boolean> = { gun: true, ammo: true, armor: true }

/**
 * Puts what the member carries into the faction's stockpiles (whatever fits). Returns whether it queued
 * anything. Creates a deposit job the member claims for itself, like a haul.
 */
function deposit(faction: FactionState, member: CrewMember, held: Record<string, number>, tick: number): boolean {
  const piles = validStockpiles(faction)
  if (piles.length === 0) return false
  const names: string[] = []
  for (const item in held) if (held[item] > 0 && !KEEP_TYPES[prototypes.item[item]?.type ?? ""]) names.push(item)
  if (names.length === 0) return false
  names.sort()
  const board = faction.board
  let job: CrewJob | undefined
  for (const item of names) {
    let chest: LuaEntity | undefined
    let bestD = 0
    for (const pile of piles) {
      if (!pile.can_insert({ name: item, count: 1 })) continue
      const d = distance(member.character.position, pile.position)
      if (chest === undefined || d < bestD) {
        chest = pile
        bestD = d
      }
    }
    if (!chest) continue
    if (!job) {
      job = addJob(board, { kind: "haul", pos: chest.position, payload: { kind: "deposit", forMember: member.id } }, tick)
      claim(board, [job.id], member.id, tick)
      member.claims.push(job.id)
    }
    const action = enqueue(member.controller, { kind: "insert", entity: chest, item, count: held[item], allowPartial: true })
    member.actions.push({ action, job: job.id })
  }
  if (!job) return false
  member.stats.deposits = (member.stats.deposits ?? 0) + 1
  return true
}

function haul(faction: FactionState, member: CrewMember, missing: ItemCount[], tick: number): void {
  const board = faction.board
  const from = member.character.position
  const first = nearestStockpile(faction, from, missing[0].item)
  const job = addJob(board, { kind: "haul", pos: first?.position ?? from, payload: { kind: "haul", forMember: member.id } }, tick)
  claim(board, [job.id], member.id, tick)
  member.claims.push(job.id)
  member.stats.hauls++
  const piles = validStockpiles(faction)
  for (const need of missing) {
    let left = need.count
    for (const chest of piles) {
      if (left <= 0) break
      const there = chest.get_item_count(need.item)
      if (there <= 0) continue
      const count = math.min(there, left)
      left -= count
      const take = { item: need.item, count }
      reserve(faction, take)
      // Partial: grab what is there when we arrive, like a player.
      const action = enqueue(member.controller, { kind: "take", entity: chest, item: need.item, count, allowPartial: true })
      member.actions.push({ action, job: job.id, reserve: take })
    }
  }
  if (!hasMoreActionsFor(member, job.id)) {
    complete(board, job.id, member.id, tick)
    removeClaim(member, job.id)
  }
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
