import { migrateStorage } from "./storage-schema"

// All persistent state lives in `storage` (SPEC §5.6). Every base key is initialised here; subsystem-owned optional
// tables initialize lazily. Migrations run before defaults so they can distinguish an absent legacy field.
export function initStorage(): void {
  const migration = migrateStorage(storage)
  if (migration.applied.length > 0) log(`[rival-engineers] storage schema ${migration.from} -> ${migration.to} (tile keys rekeyed)`)
  storage.pathRequests ??= {}
  storage.configOverrides ??= {}
  storage.controllers ??= {}
  storage.controllerOrder ??= []
  storage.schedulerCursor ??= 0
  storage.nextControllerId ??= 1
  storage.actions ??= {}
  storage.nextActionId ??= 1
  storage.factions ??= {}
  storage.factionOrder ??= []
  storage.crew ??= {}
  storage.nextCrewId ??= 1
}
