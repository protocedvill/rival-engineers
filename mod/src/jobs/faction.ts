import { BoundingBox, LuaEntity, LuaEntityPrototype, LuaForce, LuaSurface, MapPosition } from "factorio:runtime"
import { createController, destroyController } from "../character/controller"
import { getConfig } from "../config"
import { addJob, newBoard, Rect } from "./board"
import { CrewMember, FactionState, JobPayload } from "./types"

// Factions (SPEC §2 D4, §5.7): each AI faction is its own LuaForce with its own crew, stockpiles and Job
// Board. Nothing here is shared between factions, so they cannot take each other's jobs or materials.

export const FORCE_PREFIX = "rival-"

export interface CreateFactionOptions {
  /** Spawn the crew here (near it, on free ground). Without it, add crew later with `addCrew`. */
  position?: MapPosition
  /** Crew size; default: the `crew-size` setting. */
  crew?: number
  /** Surface name; default: the first surface (nauvis). */
  surface?: string
  /** Give each crew member the freeplay starter items (D5). */
  starterItems?: Record<string, number>
}

export function getFaction(name: string): FactionState | undefined {
  return storage.factions[name]
}

export function factionForce(faction: FactionState): LuaForce {
  return game.forces[faction.force]
}

export function factionSurface(faction: FactionState): LuaSurface {
  return game.surfaces[faction.surface]
}

/** Neutral to everyone (D6): cease-fire both ways with every other force except the biters. */
function makeNeutral(force: LuaForce): void {
  for (const [, other] of game.forces) {
    if (other === force || other.name === "enemy") continue
    force.set_cease_fire(other, true)
    other.set_cease_fire(force, true)
    force.set_friend(other, false)
    other.set_friend(force, false)
  }
}

export function createFaction(name: string, options: CreateFactionOptions = {}): FactionState {
  assert(storage.factions[name] === undefined, `faction ${name} exists`)
  const forceName = FORCE_PREFIX + name
  const force = game.forces[forceName] ?? game.create_force(forceName)
  makeNeutral(force)
  const faction: FactionState = {
    name,
    surface: options.surface ?? game.surfaces[1].name,
    force: forceName,
    crew: [],
    stockpiles: [],
    board: newBoard<JobPayload>(),
    ghostJobs: {},
    paused: false,
    reserved: {},
  }
  storage.factions[name] = faction
  storage.factionOrder.push(name)
  if (options.position) {
    const count = options.crew ?? getConfig().crewSize
    for (let i = 0; i < count; i++) {
      const member = spawnCrew(faction, options.position)
      const items = options.starterItems
      if (items) for (const item in items) member.character.insert({ name: item, count: items[item] })
    }
  }
  return faction
}

/**
 * Forgets a faction: stops its crew's controllers and drops its crew, stockpiles and board. The force,
 * characters and entities stay in the world. Used by tests and the harness to reset.
 */
export function destroyFaction(name: string): void {
  const faction = storage.factions[name]
  if (!faction) return
  for (const id of faction.crew) {
    destroyController(storage.crew[id].controller)
    delete storage.crew[id]
  }
  delete storage.factions[name]
  const index = storage.factionOrder.indexOf(name)
  if (index >= 0) storage.factionOrder.splice(index, 1)
}

/** Creates a character for the faction on free ground near `position` and adds it to the crew. */
export function spawnCrew(faction: FactionState, position: MapPosition): CrewMember {
  const surface = factionSurface(faction)
  const at = surface.find_non_colliding_position("character", position, 32, 0.5) ?? position
  const character = surface.create_entity({ name: "character", position: at, force: faction.force })
  assert(character, "spawned a crew character")
  return addCrew(faction, character!)
}

/** Adds an existing character to the crew (it joins the faction's force). */
export function addCrew(faction: FactionState, character: LuaEntity): CrewMember {
  character.force = faction.force
  const id = storage.nextCrewId++
  const member: CrewMember = {
    id,
    faction: faction.name,
    character,
    controller: createController(character),
    claims: [],
    actions: [],
    dead: false,
    stats: { ticks: 0, idleTicks: 0, busyTicks: 0, batches: 0, jobsDone: 0, jobsReleased: 0, hauls: 0, plans: 0 },
  }
  storage.crew[id] = member
  faction.crew.push(id)
  return member
}

/** Registers a chest the crew may take materials from. It must belong to the faction. */
export function addStockpile(faction: FactionState, chest: LuaEntity): void {
  assert(chest.valid && chest.force.name === faction.force, "stockpile must be the faction's own chest")
  faction.stockpiles.push(chest)
}

/** The tiles an entity covers, from its bounding box. */
export function tileRect(box: BoundingBox): Rect {
  return {
    x1: math.floor(box.left_top.x + 0.01),
    y1: math.floor(box.left_top.y + 0.01),
    x2: math.ceil(box.right_bottom.x - 0.01),
    y2: math.ceil(box.right_bottom.y - 0.01),
  }
}

export interface PlanGhostsOptions {
  area?: BoundingBox
  /** Also add a fuel job (after the place job) for every entity with a burner. */
  fuel?: { item: string; count: number }
  priority?: number
}

/**
 * Turns the faction's entity ghosts (in `area`, or everywhere) into place jobs, once per ghost. Returns the
 * number of place jobs added. The ghosts stay as the visible plan until a crew member fills them.
 */
export function planGhosts(faction: FactionState, options: PlanGhostsOptions = {}): number {
  const surface = factionSurface(faction)
  const ghosts = surface.find_entities_filtered({ type: "entity-ghost", force: faction.force, area: options.area })
  let added = 0
  for (const ghost of ghosts) if (addPlaceJob(faction, ghost, options) !== undefined) added++
  return added
}

/**
 * Adds a place job for one ghost (once per ghost; returns the job id, or undefined if it already has one or nothing
 * places it), with optional dependencies (e.g. clear jobs on its tiles) and a fuel job for burners.
 */
export function addPlaceJob(faction: FactionState, ghost: LuaEntity, options: PlanGhostsOptions & { deps?: number[] } = {}): number | undefined {
  const key = ghost.unit_number!
  if (faction.ghostJobs[key] !== undefined) return undefined
  const proto = ghost.ghost_prototype as LuaEntityPrototype
  const toPlace = proto.items_to_place_this?.[0]
  if (!toPlace) return undefined
  const job = addJob(
    faction.board,
    {
      kind: "place",
      pos: { x: ghost.position.x, y: ghost.position.y },
      footprint: tileRect(ghost.bounding_box),
      materials: [{ item: toPlace.name, count: 1 }],
      deps: options.deps,
      priority: options.priority,
      payload: { kind: "place", item: toPlace.name, entity: proto.name, position: ghost.position, direction: ghost.direction, ghost, ghostKey: key },
    },
    game.tick,
  )
  faction.ghostJobs[key] = job.id
  const fuel = options.fuel
  if (fuel && proto.burner_prototype !== undefined) {
    addJob(
      faction.board,
      {
        kind: "fuel",
        pos: job.pos,
        materials: [{ item: fuel.item, count: fuel.count }],
        deps: [job.id],
        priority: options.priority,
        payload: { kind: "fuel", item: fuel.item, count: fuel.count, targetJob: job.id },
      },
      game.tick,
    )
  }
  return job.id
}

/** Adds a clear job: the crew mines a tree or rock (or picks up one of the faction's own entities). */
export function addClearJob(faction: FactionState, target: LuaEntity, priority?: number): number {
  const job = addJob(faction.board, { kind: "clear", pos: { x: target.position.x, y: target.position.y }, priority, payload: { kind: "clear", target } }, game.tick)
  return job.id
}
