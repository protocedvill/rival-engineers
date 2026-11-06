// T1: a tiny test harness for pure logic, compiled by TSTL and run with a plain `lua` outside the game
// (tools/run-unit-tests.mjs). Only modules that touch no Factorio globals can be imported here.

interface UnitTest {
  name: string
  fn: (this: void) => void
}

const tests: UnitTest[] = []

declare const os: { getenv(this: void, name: string): string | undefined; exit(this: void, code: number): never; clock(this: void): number }

export function test(name: string, fn: (this: void) => void): void {
  tests.push({ name, fn })
}

export function eq<T>(actual: T, expected: T, what = "value"): void {
  if (actual !== expected) error(`${what}: expected ${tostring(expected)}, got ${tostring(actual)}`, 2)
}

export function near(actual: number, expected: number, tolerance = 1e-9, what = "value"): void {
  if (math.abs(actual - expected) > tolerance) error(`${what}: expected ${expected} ± ${tolerance}, got ${actual}`, 2)
}

export function ok(condition: boolean, what = "condition"): void {
  if (!condition) error(`${what} is false`, 2)
}

/**
 * Runs every registered test, prints results and exits non-zero on any failure. `$UNIT_TEST_FILTER` (set by
 * `npm run test:unit -- -t <text>` and `replay:sweep`) runs only the tests whose name contains that text.
 */
export function run(suite: string): void {
  // UNIT_FILTER is the older name (B26), still accepted.
  const filter = os.getenv("UNIT_TEST_FILTER") ?? os.getenv("UNIT_FILTER")
  // $UNIT_TEST_SHARD "i/n": run every n-th registered test (the T1 runner shards one big file so its replays run on
  // several cores). Tests are independent; each shard still sees the same registration order, so the split is stable.
  const shardEnv = os.getenv("UNIT_TEST_SHARD")
  let shardIndex = 0
  let shardCount = 1
  if (shardEnv !== undefined && shardEnv !== "") {
    const [i, n] = string.match(shardEnv, "^(%d+)/(%d+)$")
    if (i !== undefined && n !== undefined && tonumber(n)! > 0) {
      shardIndex = tonumber(i)!
      shardCount = tonumber(n)!
    }
  }
  let failed = 0
  let skipped = 0
  let slot = 0
  for (const t of tests) {
    const mine = shardCount <= 1 || slot % shardCount === shardIndex
    slot++
    if (!mine) {
      skipped++
      continue
    }
    if (filter !== undefined && filter !== "" && string.find(t.name, filter, 1, true)[0] === undefined) {
      skipped++
      continue
    }
    const t0 = os.clock()
    const [success, err] = pcall(t.fn)
    // CPU seconds, shown from 1 s: which tests make T1 slow.
    const dt = os.clock() - t0
    const time = dt >= 1 ? ` (${string.format("%.1f", dt)} s)` : ""
    if (success) {
      print(`PASS ${suite} > ${t.name}${time}`)
    } else {
      failed++
      print(`FAIL ${suite} > ${t.name}${time}\n    ${tostring(err)}`)
    }
  }
  print(`${suite}: ${tests.length - failed - skipped} passed, ${failed} failed${skipped > 0 ? `, ${skipped} filtered out` : ""}`)
  if (failed > 0) os.exit(1)
}
