// Persistent storage versioning. Pure: migrations operate on plain tables and must not read game, prototypes or
// settings. Keep old fields readable until the migration that replaces them has shipped and been exercised by T2.

export const CURRENT_STORAGE_SCHEMA = 1

export interface StorageMigrationResult {
  from: number
  to: number
  applied: number[]
}

type VersionedStorage = { schemaVersion?: number }
type Migration = (this: void, value: VersionedStorage) => void

// Schema 1 names the legacy shape. It intentionally transforms nothing: saves written before versioning already
// have this shape, and all optional subsystem tables continue to be initialized by their owning adapters.
const migrations: Record<number, Migration> = {
  1: () => {},
}

/** Upgrade in ascending, one-version steps. Throws rather than loading a save written by newer code incorrectly. */
export function migrateStorage(value: VersionedStorage): StorageMigrationResult {
  const from = value.schemaVersion ?? 0
  if (from > CURRENT_STORAGE_SCHEMA) error(`storage schema ${from} is newer than supported schema ${CURRENT_STORAGE_SCHEMA}`)
  const applied: number[] = []
  let version = from
  while (version < CURRENT_STORAGE_SCHEMA) {
    const next = version + 1
    const migrate = migrations[next]
    if (migrate === undefined) error(`missing storage migration ${version} -> ${next}`)
    migrate(value)
    value.schemaVersion = next
    applied.push(next)
    version = next
  }
  return { from, to: version, applied }
}
