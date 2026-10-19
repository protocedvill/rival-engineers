// Pure parts of tools/replay-sweep.mjs (checked by `checkSweepCombos`, run as part of T1).
import assert from "node:assert/strict"

/**
 * "VAR=a,b" → { name: "VAR", values: ["a", "b"] }. Values are split on "|" when the spec has one (for values that
 * contain commas, e.g. REPLAY_ROUTER="maxRipups=6,rip=10|maxRipups=8"), else on ",". An empty value means "unset".
 */
export function parseVar(spec) {
  const eq = spec.indexOf("=")
  if (eq <= 0) throw new Error(`bad variable spec "${spec}": expected VAR=a,b`)
  const name = spec.slice(0, eq)
  const body = spec.slice(eq + 1)
  const values = body.split(body.includes("|") ? "|" : ",")
  return { name, values }
}

/** Every combination of the variables' values, first variable slowest: [{ VAR: "a", VAR2: "x" }, ...]. */
export function expandCombos(vars) {
  let combos = [{}]
  for (const v of vars) {
    const next = []
    for (const c of combos) for (const value of v.values) next.push({ ...c, [v.name]: value })
    combos = next
  }
  return combos
}

/** A combination as a label ("REPLAY_UG=1 REPLAY_SOFT_PLACE=-") and a directory name. */
export function comboLabel(combo) {
  const parts = Object.entries(combo).map(([k, v]) => `${k}=${v === "" ? "-" : v}`)
  return parts.length > 0 ? parts.join(" ") : "(baseline)"
}

export function comboDir(combo, index) {
  const slug = Object.entries(combo)
    .map(([k, v]) => `${k.replace(/^REPLAY_/, "").toLowerCase()}-${v === "" ? "unset" : v}`)
    .join("_")
    .replace(/[^A-Za-z0-9._=-]+/g, "_")
  return `${String(index + 1).padStart(2, "0")}${slug ? "_" + slug : ""}`.slice(0, 120)
}

/** Environment for a combination: set values, delete unset ones (the replays test REPLAY_* for presence). */
export function comboEnv(base, combo) {
  const env = { ...base }
  for (const [k, v] of Object.entries(combo)) {
    if (v === "") delete env[k]
    else env[k] = v
  }
  return env
}

/** Test results (PASS/FAIL lines) and replay metrics (`REPLAY {json}` lines) from a test file's output. */
export function parseOutput(text) {
  const tests = []
  const metrics = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(PASS|FAIL) [^>]+> (.*)$/.exec(line)
    if (m) {
      const t = { name: m[2], passed: m[1] === "PASS" }
      if (!t.passed && lines[i + 1]?.startsWith("    ")) t.error = lines[i + 1].trim()
      tests.push(t)
    } else if (line.startsWith("REPLAY ")) {
      try {
        metrics.push(JSON.parse(line.slice(7)))
      } catch {
        // a truncated line (crashed run): skip it
      }
    }
  }
  return { tests, metrics }
}

/** A plain-text table (columns padded). */
export function formatTable(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)))
  const line = (r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n")
}

export function checkSweepCombos() {
  assert.deepEqual(parseVar("REPLAY_UG=,1"), { name: "REPLAY_UG", values: ["", "1"] })
  assert.deepEqual(parseVar("REPLAY_ROUTER=maxRipups=6,rip=10|maxRipups=8").values, ["maxRipups=6,rip=10", "maxRipups=8"])
  assert.throws(() => parseVar("=1"))
  const combos = expandCombos([parseVar("A=1,2"), parseVar("B=x,y,z")])
  assert.equal(combos.length, 6)
  assert.deepEqual(combos[0], { A: "1", B: "x" })
  assert.deepEqual(combos[5], { A: "2", B: "z" })
  assert.deepEqual(expandCombos([]), [{}])
  assert.equal(comboLabel({ REPLAY_UG: "", B: "2" }), "REPLAY_UG=- B=2")
  assert.equal(comboDir({ REPLAY_ROUTER: "maxRipups=6,rip=10" }, 0), "01_router-maxRipups=6_rip=10")
  const env = comboEnv({ REPLAY_UG: "1", PATH: "/bin" }, { REPLAY_UG: "", REPLAY_SOFT_PLACE: "0.25" })
  assert.equal("REPLAY_UG" in env, false)
  assert.equal(env.REPLAY_SOFT_PLACE, "0.25")
  const parsed = parseOutput('REPLAY {"name":"a","phase":"done"}\nPASS plan-replay > replay a\nFAIL plan-replay > replay b\n    boom is false\n')
  assert.deepEqual(parsed.metrics, [{ name: "a", phase: "done" }])
  assert.deepEqual(parsed.tests[1], { name: "replay b", passed: false, error: "boom is false" })
}
