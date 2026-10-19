// T1: a tiny test harness for pure logic, compiled by TSTL and run with a plain `lua` outside the game
// (tools/run-unit-tests.mjs). Only modules that touch no Factorio globals can be imported here.

interface UnitTest {
  name: string
  fn: (this: void) => void
}

const tests: UnitTest[] = []

declare const os: { getenv(this: void, name: string): string | undefined; exit(this: void, code: number): never }

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
  let failed = 0
  let skipped = 0
  for (const t of tests) {
    if (filter !== undefined && filter !== "" && string.find(t.name, filter, 1, true)[0] === undefined) {
      skipped++
      continue
    }
    const [success, err] = pcall(t.fn)
    if (success) {
      print(`PASS ${suite} > ${t.name}`)
    } else {
      failed++
      print(`FAIL ${suite} > ${t.name}\n    ${tostring(err)}`)
    }
  }
  print(`${suite}: ${tests.length - failed - skipped} passed, ${failed} failed${skipped > 0 ? `, ${skipped} filtered out` : ""}`)
  if (failed > 0) os.exit(1)
}
