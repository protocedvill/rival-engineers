import { CURRENT_STORAGE_SCHEMA, migrateStorage } from "../src/storage-schema"
import { eq, run, test } from "./harness"

test("an unversioned save is adopted without changing its fields", () => {
  const old = { marker: "kept" } as { schemaVersion?: number; marker: string }
  const result = migrateStorage(old)
  eq(result.from, 0)
  eq(result.to, CURRENT_STORAGE_SCHEMA)
  eq(result.applied[0], 1)
  eq(old.schemaVersion, 1)
  eq(old.marker, "kept")
})

test("the current schema is idempotent", () => {
  const current = { schemaVersion: CURRENT_STORAGE_SCHEMA }
  const result = migrateStorage(current)
  eq(result.applied.length, 0)
  eq(result.to, CURRENT_STORAGE_SCHEMA)
})

test("a newer save fails closed", () => {
  let message = ""
  const [ok, failure] = pcall(() => migrateStorage({ schemaVersion: CURRENT_STORAGE_SCHEMA + 1 }))
  if (!ok) message = tostring(failure)
  eq(ok, false)
  eq(string.find(message, "newer than supported", 1, true)[0] !== undefined, true)
})

run("storage-schema")
