import { onHandCrafted } from "./triggers"
import { LuaEntity, LuaForce, LuaProfiler, MapPosition, Product } from "factorio:runtime"
import { Config, getConfig } from "../config"
import { distance } from "./steering"
import { ActionRecord, ActionSpec, ActionStatus, ControllerState, FailureReason, ReachGoal } from "./types"
import { newWalk, reachSatisfied, stepWalk, StepResult, stopWalking } from "./walk"

// Character Controller (SPEC §5.1): one per character body. Each controller runs a queue of actions;
// each action is a resumable state machine stepped once per tick from on_tick, under a per-tick budget.
// All state lives in storage.actions / storage.controllers, so a save/load resumes mid-action.

/** Finished actions kept per controller for status queries before they are dropped from storage. */
const FINISHED_KEPT = 64

// ---------------------------------------------------------------------------------------------------
// Queue API (used by M2's Job Board and the remote interface)

export function createController(character: LuaEntity): number {
  const id = storage.nextControllerId++
  storage.controllers[id] = { id, character, queue: [], finished: [], dead: false }
  storage.controllerOrder.push(id)
  return id
}

export function getController(id: number): ControllerState | undefined {
  return storage.controllers[id]
}

/** Cancels everything and forgets the controller and its actions. */
export function destroyController(id: number): void {
  const ctrl = storage.controllers[id]
  if (!ctrl) return
  cancelAll(id)
  for (const actionId of ctrl.finished) delete storage.actions[actionId]
  delete storage.controllers[id]
  const order = storage.controllerOrder
  const index = order.indexOf(id)
  if (index >= 0) order.splice(index, 1)
}

/** Queues an action and returns its id. A dead controller fails it immediately. */
export function enqueue(controllerId: number, spec: ActionSpec): number {
  const ctrl = storage.controllers[controllerId]
  assert(ctrl, `no controller ${controllerId}`)
  const id = storage.nextActionId++
  storage.actions[id] = {
    id,
    controller: controllerId,
    spec,
    status: "queued",
    queuedTick: game.tick,
    stats: { repaths: 0, teleports: 0, pathTiles: 0, walkTicks: 0, items: 0 },
  }
  ctrl.queue.push(id)
  if (ctrl.dead) finishAll(ctrl, "failed", "character-invalid")
  return id
}

export function getAction(id: number): ActionRecord | undefined {
  return storage.actions[id]
}

export function actionStatus(id: number): ActionStatus | undefined {
  return storage.actions[id]?.status
}

export function isIdle(controllerId: number): boolean {
  const ctrl = storage.controllers[controllerId]
  return !ctrl || ctrl.queue.length === 0
}

/**
 * Cancels a queued or running action. A running action stops walking and mining at once. A running
 * craft also cancels the crafts it queued, which returns their ingredients.
 */
export function cancel(actionId: number): boolean {
  const action = storage.actions[actionId]
  if (!action || (action.status !== "queued" && action.status !== "running")) return false
  const ctrl: ControllerState | undefined = storage.controllers[action.controller]
  if (ctrl !== undefined) finish(ctrl, action, "cancelled")
  return true
}

export function cancelAll(controllerId: number): void {
  const ctrl: ControllerState | undefined = storage.controllers[controllerId]
  if (ctrl !== undefined) finishAll(ctrl, "cancelled")
}

// ---------------------------------------------------------------------------------------------------
// Scheduler

let tickProfiler: { total: LuaProfiler; tick: LuaProfiler } | undefined

/** Measurement only: accumulate the controllers' on_tick time into `total` (no gameplay effect). */
export function setControllerProfiler(total: LuaProfiler | undefined): void {
  tickProfiler = total ? { total, tick: helpers.create_profiler(true) } : undefined
}

export function onControllerTick(): void {
  const order = storage.controllerOrder
  const n = order.length
  if (n === 0) return
  if (tickProfiler) tickProfiler.tick.reset() // reset() starts from zero; restart() would resume
  const config = getConfig()
  const tick = game.tick
  // Budget: at most controllerStepsPerTick busy controllers per tick, round-robin. Idle ones are free.
  const cursor = storage.schedulerCursor % n
  let stepped = 0
  let visited = 0
  while (visited < n && stepped < config.controllerStepsPerTick) {
    const ctrl = storage.controllers[order[(cursor + visited) % n]]
    visited++
    if (ctrl && !ctrl.dead && ctrl.queue.length > 0) {
      stepController(ctrl, config, tick)
      stepped++
    } else if (ctrl && !ctrl.dead && !ctrl.character.valid) {
      stepController(ctrl, config, tick) // marks it dead
    }
  }
  storage.schedulerCursor = (cursor + visited) % n
  if (tickProfiler) {
    tickProfiler.tick.stop()
    tickProfiler.total.add(tickProfiler.tick)
  }
}

function stepController(ctrl: ControllerState, config: Config, tick: number): void {
  if (ctrl.dead) return
  if (!ctrl.character.valid) {
    ctrl.dead = true
    finishAll(ctrl, "failed", "character-invalid")
    return
  }
  applyReachMultiplier(ctrl, config.debugReachMultiplier)
  const actionId = ctrl.queue[0]
  if (actionId === undefined) return
  const action = storage.actions[actionId]
  if (action.status === "queued") {
    action.status = "running"
    action.startedTick = tick
    action.phase = "start"
  }
  const result = stepAction(ctrl.character, action, config, tick)
  if (result === "running") return
  if (result === "done") finish(ctrl, action, "succeeded")
  else finish(ctrl, action, "failed", result.fail, result.detail)
}

function finish(ctrl: ControllerState, action: ActionRecord, status: ActionStatus, reason?: FailureReason, detail?: string): void {
  if (action.status === "running" && ctrl.character.valid) {
    stopCharacter(ctrl.character)
    // Crafting runs one action at a time, so every craft still queued was started by this action.
    if (action.spec.kind === "craft" && status !== "succeeded") cancelQueuedCrafts(ctrl.character)
  }
  action.status = status
  action.reason = reason
  action.detail = detail
  action.finishedTick = game.tick
  action.walk = undefined
  action.phase = undefined
  const index = ctrl.queue.indexOf(action.id)
  if (index >= 0) ctrl.queue.splice(index, 1)
  ctrl.finished.push(action.id)
  while (ctrl.finished.length > FINISHED_KEPT) delete storage.actions[ctrl.finished.shift()!]
}

function finishAll(ctrl: ControllerState, status: ActionStatus, reason?: FailureReason): void {
  // Copy: finish() removes from the queue.
  const ids = [...ctrl.queue]
  for (const id of ids) finish(ctrl, storage.actions[id], status, reason)
}

function cancelQueuedCrafts(character: LuaEntity): void {
  // Cancel from the back; a bounded loop in case the engine keeps an entry.
  for (let guard = 0; guard < 100 && character.crafting_queue_size > 0; guard++) {
    const queue = character.crafting_queue!
    const last = queue[queue.length - 1]
    character.cancel_crafting({ index: last.index, count: last.count })
  }
}

/**
 * Debug only (breaks player parity): scales the character's build, reach and resource reach through the
 * player-equivalent per-character bonuses. Applied lazily whenever the configured multiplier changes.
 */
function applyReachMultiplier(ctrl: ControllerState, multiplier: number): void {
  if ((ctrl.reachMultiplier ?? 1) === multiplier) return
  const character = ctrl.character
  const proto = character.prototype
  // The bonuses are whole tiles (uint), so round down.
  character.character_build_distance_bonus = math.floor((proto.build_distance ?? 0) * (multiplier - 1))
  character.character_reach_distance_bonus = math.floor((proto.reach_distance ?? 0) * (multiplier - 1))
  character.character_resource_reach_distance_bonus = math.floor((proto.reach_resource_distance ?? 0) * (multiplier - 1))
  ctrl.reachMultiplier = multiplier
}

function stopCharacter(character: LuaEntity): void {
  stopWalking(character)
  character.mining_state = { mining: false }
}

// ---------------------------------------------------------------------------------------------------
// Actions

function fail(reason: FailureReason, detail?: string): StepResult {
  return { fail: reason, detail }
}

function itemCount(character: LuaEntity, item: string): number {
  return character.get_main_inventory()!.get_item_count(item)
}

function stepAction(character: LuaEntity, action: ActionRecord, config: Config, tick: number): StepResult {
  const spec = action.spec
  switch (spec.kind) {
    case "walk":
      if (action.phase === "start") {
        action.walk = newWalk(spec.goal, Math.max(0.5, spec.radius ?? 1), undefined, tick)
        action.phase = "approach"
      }
      return stepWalk(character, action.walk!, action.stats, config, tick)
    case "mine":
      return stepMine(character, action, spec, config, tick)
    case "craft":
      return stepCraft(character, action, spec, config, tick)
    case "place":
      return stepPlace(character, action, spec, config, tick)
    case "insert":
    case "take":
      return stepTransfer(character, action, spec, config, tick)
    case "pickUp":
      return stepPickUp(character, action, spec, config, tick)
  }
}

/** Walks until the reach goal is satisfied. Returns "done" once in reach. */
function approach(character: LuaEntity, action: ActionRecord, reach: ReachGoal, goal: MapPosition, config: Config, tick: number): StepResult {
  if (!action.walk) {
    if (reachSatisfied(character, reach)) return "done"
    action.walk = newWalk(goal, 0, reach, tick)
  }
  const result = stepWalk(character, action.walk, action.stats, config, tick)
  if (result !== "running") action.walk = undefined
  return result
}

/** Stall detection for long-running work: `progress` must keep increasing. */
function stalled(action: ActionRecord, progress: number, config: Config, tick: number): boolean {
  if (action.lastProgressValue === undefined || progress > action.lastProgressValue + 1e-6) {
    action.lastProgressValue = progress
    action.lastProgressTick = tick
    return false
  }
  return tick - action.lastProgressTick! > config.actionStallTicks
}

function startWork(action: ActionRecord, tick: number): void {
  action.phase = "work"
  action.lastProgressTick = tick
  action.lastProgressValue = undefined
}

function primaryProduct(entity: LuaEntity): string | undefined {
  const products = entity.prototype.mineable_properties.products
  const first = products?.[0]
  return first?.type === "item" ? first.name : undefined
}

/**
 * Starts or continues mining `target`. Mining acts on whatever is selected at the mining position, so when something
 * else covers the target's centre, mine from a point of its box where the target itself is selected. False if there is
 * none and the other entity must not be mined: a ghost (a player would deconstruct it) or, over ore, a built entity
 * (a player would pick it up: seed 77 lost two belts of an ore route to a stale hand-mining job).
 */
function mineTick(character: LuaEntity, target: LuaEntity, action?: ActionRecord): boolean {
  character.update_selected_entity(target.position)
  const selected = character.selected
  if (!selected || !selected.valid || selected === target) {
    character.mining_state = { mining: true, position: target.position }
    return true
  }
  const box = target.bounding_box
  const corners = [
    { x: box.left_top.x + 0.1, y: box.left_top.y + 0.1 },
    { x: box.right_bottom.x - 0.1, y: box.left_top.y + 0.1 },
    { x: box.left_top.x + 0.1, y: box.right_bottom.y - 0.1 },
    { x: box.right_bottom.x - 0.1, y: box.right_bottom.y - 0.1 },
  ]
  for (const p of corners) {
    character.update_selected_entity(p)
    if (character.selected === target) {
      character.mining_state = { mining: true, position: p }
      return true
    }
  }
  if (selected.type === "entity-ghost") return false
  if (target.type === "resource" && selected.force.name !== "neutral" && selected.type !== "character") return false
  // A tree or rock over the target (or a character in the way): mined first, as by a player.
  if (action !== undefined && (selected.type === "tree" || selected.type === "simple-entity")) action.obstacle = selected
  character.mining_state = { mining: true, position: target.position }
  return true
}

function stepMine(character: LuaEntity, action: ActionRecord, spec: Extract<ActionSpec, { kind: "mine" }>, config: Config, tick: number): StepResult {
  if (action.phase === "start") {
    let target = spec.target
    if (!target && spec.position) {
      const found = character.surface.find_entities_filtered({ position: spec.position, type: "resource", limit: 1 })
      target = found[0]
    }
    if (!target || !target.valid) return fail("target-invalid")
    if (!target.minable || !target.prototype.mineable_properties.minable) return fail("not-minable", target.name)
    action.target = target
    action.item = primaryProduct(target)
    action.baseline = action.item ? itemCount(character, action.item) : 0
    action.goalCount = spec.count
    action.phase = "approach"
  }
  const target = action.target!
  const gained = action.item ? itemCount(character, action.item) - action.baseline! : 0
  action.stats.items = gained
  if (action.goalCount !== undefined && gained >= action.goalCount) return "done"
  if (!target.valid) return "done" // depleted or mined away
  const reach: ReachGoal = target.type === "resource" ? { kind: "resource", entity: target } : { kind: "entity", entity: target }

  if (action.phase === "approach") {
    const result = approach(character, action, reach, target.position, config, tick)
    if (result !== "done") return result
    startWork(action, tick)
  }
  if (!reachSatisfied(character, reach)) {
    action.phase = "approach"
    return "running"
  }
  if (action.item && !character.get_main_inventory()!.can_insert({ name: action.item, count: 1 })) {
    return fail("inventory-full", action.item)
  }
  if (action.obstacle !== undefined && !action.obstacle.valid) {
    // The character's mining stays on the mined-away obstacle: restart it so it picks the ore up next tick.
    action.obstacle = undefined
    action.cleared = (action.cleared ?? 0) + 1
    character.mining_state = { mining: false }
    return "running"
  }
  if (stalled(action, gained + (action.cleared ?? 0) + character.character_mining_progress, config, tick)) return fail("stalled", "mining made no progress")
  if (!mineTick(character, target, action)) return fail("not-minable", "a ghost or another entity covers the target")
  return "running"
}

function productAmount(product: Product): number {
  if (product.amount !== undefined) return product.amount
  return product.amount_min ?? 1
}

/** Debug only (breaks player parity): craft at once when every direct ingredient is in the inventory. */
function instantCraft(character: LuaEntity, recipeName: string, count: number): boolean {
  const recipe = prototypes.recipe[recipeName]
  for (const ing of recipe.ingredients) {
    if (ing.type !== "item" || itemCount(character, ing.name) < ing.amount * count) return false
  }
  for (const ing of recipe.ingredients) character.remove_item({ name: ing.name, count: ing.amount * count })
  for (const product of recipe.products) {
    if (product.type === "item") character.insert({ name: product.name, count: productAmount(product) * count })
  }
  return true
}

function stepCraft(character: LuaEntity, action: ActionRecord, spec: Extract<ActionSpec, { kind: "craft" }>, config: Config, tick: number): StepResult {
  if (action.phase === "start") {
    const recipe = prototypes.recipe[spec.recipe]
    if (!recipe) return fail("unknown-recipe", spec.recipe)
    if (!character.force.recipes[spec.recipe].enabled) return fail("recipe-locked", spec.recipe)
    const categories = character.prototype.crafting_categories
    if (!categories || !categories[recipe.category]) return fail("not-handcraftable", recipe.category)
    const product = recipe.main_product ?? recipe.products[0]
    if (!product || product.type !== "item") return fail("not-handcraftable", "no item product")
    action.item = product.name
    action.baseline = itemCount(character, product.name)
    action.goalCount = productAmount(product) * spec.count
    const craftable = character.get_craftable_count(spec.recipe)
    if (craftable < spec.count) return fail("missing-ingredients", `can craft ${craftable} of ${spec.count}`)
    if (config.debugInstantCraft && instantCraft(character, spec.recipe, spec.count)) {
      action.stats.items = action.goalCount
      return "done"
    }
    const started = character.begin_crafting({ recipe: spec.recipe, count: spec.count, silent: true })
    if (started < spec.count) return fail("missing-ingredients", `started ${started} of ${spec.count}`)
    startWork(action, tick)
  }
  const gained = itemCount(character, action.item!) - action.baseline!
  action.stats.items = gained
  if (gained >= action.goalCount!) {
    onHandCrafted(character.force as LuaForce, action.item!, gained)
    return "done"
  }
  if (character.crafting_queue_size === 0) return fail("craft-interrupted", `got ${gained} of ${action.goalCount}`)
  // Progress counts finished queue entries too: intermediates (a lab's circuits, gears, belts) each restart
  // crafting_queue_progress at 0, so a long chain of them must not look stalled.
  let queued = 0
  for (const q of character.crafting_queue ?? []) queued += q.count
  if (stalled(action, gained * 1000 - queued + character.crafting_queue_progress, config, tick)) return fail("stalled", "crafting made no progress")
  return "running"
}

function stepPlace(character: LuaEntity, action: ActionRecord, spec: Extract<ActionSpec, { kind: "place" }>, config: Config, tick: number): StepResult {
  const itemProto = prototypes.item[spec.item]
  const entityName = itemProto?.place_result?.name
  if (!entityName) return fail("not-placeable", spec.item)
  if (itemCount(character, spec.item) < 1) return fail("missing-item", spec.item)
  if (action.phase === "start") action.phase = "approach"
  if (action.phase === "approach") {
    const result = approach(character, action, { kind: "build", position: spec.position }, spec.position, config, tick)
    if (result !== "done") return result
    action.phase = "work"
    // Hand speed (SPEC §5.7): a placement takes a moment once in reach, like a player aiming and clicking.
    // Belts are drag-placed, so they go faster.
    const belt = prototypes.entity[entityName].type === "transport-belt"
    action.readyTick = tick + (belt ? config.beltPlaceDelayTicks : config.placeDelayTicks)
  }
  if (tick < (action.readyTick ?? 0)) return "running"
  const direction = spec.direction ?? defines.direction.north
  // The player's build check: reach, collisions and placement rules.
  if (!character.can_place_entity({ name: entityName, position: spec.position, direction })) {
    return fail("cannot-place", `${entityName} at ${spec.position.x},${spec.position.y} (distance ${distance(character.position, spec.position)})`)
  }
  const ghost = spec.ghost
  if (ghost && !ghost.valid) return fail("target-invalid", "ghost removed")
  character.remove_item({ name: spec.item, count: 1 })
  let entity: LuaEntity | undefined
  if (ghost) {
    // Like a player building over a ghost: the ghost becomes the entity and keeps its settings.
    const [, revived] = ghost.revive({ raise_revive: true })
    entity = revived ?? undefined
  } else {
    entity = character.surface.create_entity({
      name: entityName,
      position: spec.position,
      direction,
      force: character.force,
      raise_built: true,
    })
  }
  if (!entity) {
    character.insert({ name: spec.item, count: 1 })
    return fail("cannot-place", ghost ? "ghost revive failed" : "create_entity failed")
  }
  action.placed = entity
  action.stats.items = 1
  return "done"
}

function stepTransfer(
  character: LuaEntity,
  action: ActionRecord,
  spec: Extract<ActionSpec, { kind: "insert" | "take" }>,
  config: Config,
  tick: number,
): StepResult {
  const entity = spec.entity
  if (!entity.valid) return fail("target-invalid")
  if (action.phase === "start") action.phase = "approach"
  if (action.phase === "approach") {
    const result = approach(character, action, { kind: "entity", entity }, entity.position, config, tick)
    if (result !== "done") return result
    action.phase = "work"
  }
  if (!character.can_reach_entity(entity)) {
    action.phase = "approach"
    return "running"
  }
  const item = spec.item
  if (spec.kind === "insert") {
    const have = itemCount(character, item)
    if (spec.allowPartial ? have === 0 : have < spec.count) return fail("missing-item", `${item}: have ${have} of ${spec.count}`)
    const want = math.min(have, spec.count)
    const removed = character.remove_item({ name: item, count: want })
    const inserted = removed > 0 ? entity.insert({ name: item, count: removed }) : 0
    if (inserted < removed) character.insert({ name: item, count: removed - inserted })
    action.stats.items = inserted
    if (spec.allowPartial) return "done"
    return inserted < spec.count ? fail("target-full", `inserted ${inserted} of ${spec.count}`) : "done"
  }
  const available = entity.get_item_count(item)
  let want = spec.count
  if (spec.allowPartial) {
    if (available === 0) return fail("not-enough", `${item}: none available`)
    want = math.min(available, spec.count)
  } else if (available < spec.count) {
    return fail("not-enough", `${item}: ${available} of ${spec.count} available`)
  }
  if (!character.can_insert({ name: item, count: spec.allowPartial ? 1 : want })) return fail("inventory-full", item)
  const removed = entity.remove_item({ name: item, count: want })
  const inserted = removed > 0 ? character.insert({ name: item, count: removed }) : 0
  if (inserted < removed) entity.insert({ name: item, count: removed - inserted })
  action.stats.items = inserted
  if (spec.allowPartial) return inserted > 0 ? "done" : fail("inventory-full", item)
  return inserted < want ? fail("inventory-full", `took ${inserted} of ${want}`) : "done"
}

function stepPickUp(character: LuaEntity, action: ActionRecord, spec: Extract<ActionSpec, { kind: "pickUp" }>, config: Config, tick: number): StepResult {
  const entity = spec.entity
  if (action.phase === "start") {
    if (!entity.valid) return fail("target-invalid")
    if (!entity.minable || !entity.prototype.mineable_properties.minable) return fail("not-minable", entity.name)
    action.item = primaryProduct(entity)
    action.baseline = action.item ? itemCount(character, action.item) : 0
    action.phase = "approach"
  }
  if (!entity.valid) {
    // Picked up if the item arrived; otherwise something else removed the entity.
    const gained = action.item ? itemCount(character, action.item) - action.baseline! : 1
    action.stats.items = gained
    return gained > 0 ? "done" : fail("target-invalid", "entity vanished")
  }
  if (action.phase === "approach") {
    const result = approach(character, action, { kind: "entity", entity }, entity.position, config, tick)
    if (result !== "done") return result
    startWork(action, tick)
  }
  if (!character.can_reach_entity(entity)) {
    action.phase = "approach"
    return "running"
  }
  if (action.item && !character.can_insert({ name: action.item, count: 1 })) return fail("inventory-full", action.item)
  if (stalled(action, character.character_mining_progress, config, tick)) return fail("stalled", "pick-up made no progress")
  if (!mineTick(character, entity)) return fail("not-minable", "a ghost covers the target")
  return "running"
}
