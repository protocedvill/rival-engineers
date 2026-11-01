import { eq, ok, run, test } from "./harness"
import { asciiTerrain, DX, DY, FREE, tkey } from "../src/planner/grid"
import { PipeRequest, PipeResult, PipeStep, routePipe } from "../src/planner/pipe-router"

// T1: M7b pipe router. One fluid from a pipe-out port to a pipe-in port, preferring pipe-to-ground pairs, never letting
// a plain pipe touch another fluid, with a pump at least every pipeline extent.

function request(rows: string[], start: PipeRequest["start"], goal: PipeRequest["goal"], over: Partial<PipeRequest> = {}, fluids: Record<number, boolean> = {}): PipeRequest {
  const t = asciiTerrain(rows)
  return {
    start,
    goal,
    maxUnderground: 10,
    extent: 320,
    cost: (x, y) => (t.block(x, y) === FREE ? 1 : -1),
    under: (x, y) => t.block(x, y) !== 7,
    fluidNear: (x, y) => fluids[tkey(x, y)] === true,
    minCost: 1,
    ugCost: 2,
    pumpCost: 10,
    budget: 100000,
    ...over,
  }
}

/** Follows the steps as the game connects them: each element joins the next through its connection. Returns the error. */
function connected(steps: PipeStep[], req: PipeRequest): string | undefined {
  let x = req.start.x
  let y = req.start.y
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.x !== x || s.y !== y) return `step ${i} (${s.kind}) at ${s.x},${s.y}, expected ${x},${y}`
    if (s.kind === "ug-in") {
      const out = steps[i + 1]
      if (out === undefined || out.kind !== "ug-out" || out.dir !== s.dir) return `step ${i}: entrance without its exit`
      const k = math.abs(out.x - s.x) + math.abs(out.y - s.y)
      if (k < 2 || k > req.maxUnderground) return `step ${i}: exit ${k} tiles away`
      x = out.x + DX[s.dir]
      y = out.y + DY[s.dir]
      i++
    } else if (s.kind === "pump") {
      x = s.x + 2 * DX[s.dir]
      y = s.y + 2 * DY[s.dir]
    } else {
      x = s.x + DX[s.dir]
      y = s.y + DY[s.dir]
    }
  }
  const last = steps[steps.length - 1]
  const into = { x: req.goal.x + DX[req.goal.dir], y: req.goal.y + DY[req.goal.dir] }
  if (last.kind === "pipe" && (last.x !== req.goal.x || last.y !== req.goal.y)) return "the last pipe is not on the goal tile"
  if (last.kind === "ug-out" && (last.x + DX[last.dir] !== into.x || last.y + DY[last.dir] !== into.y)) return "the last exit does not face the port"
  return undefined
}

function route(req: PipeRequest): PipeResult {
  const r = routePipe(req)
  ok(r !== undefined, "a route")
  const bad = connected(r!.steps, req)
  ok(bad === undefined, bad ?? "")
  return r!
}

const OPEN = [".".repeat(60), ".".repeat(60), ".".repeat(60), ".".repeat(60), ".".repeat(60)]

test("pipe router: a straight line is mostly pipe-to-ground pairs", () => {
  const req = request(OPEN, { x: 1, y: 2, dir: 1 }, { x: 40, y: 2, dir: 1 })
  const r = route(req)
  let pairs = 0
  for (const s of r.steps) if (s.kind === "ug-in") pairs++
  ok(pairs >= 3, `undergrounds carry the line (${pairs} pairs)`)
  ok(r.steps.length <= 12, `few entities (${r.steps.length})`)
})

test("pipe router: a plain pipe never stands next to another fluid", () => {
  // Another fluid's pipes run along row 1 from x = 5 to 50; this line passes right next to them along row 2 (only
  // underground ends may stand there), then turns down to its port on row 4.
  const fluids: Record<number, boolean> = {}
  for (let x = 5; x <= 50; x++) fluids[tkey(x, 1)] = true
  const req = request(OPEN, { x: 1, y: 2, dir: 1 }, { x: 55, y: 4, dir: 2 }, { under: (x, y) => y === 2 }, fluids)
  const r = route(req)
  for (const s of r.steps) {
    if (s.kind !== "pipe") continue
    for (let d = 0; d < 4; d++) ok(!fluids[tkey(s.x + DX[d], s.y + DY[d])], `pipe at ${s.x},${s.y} touches the other fluid`)
  }
})

test("pipe router: a wall is passed under, a long wall is gone around", () => {
  const rows = [".".repeat(40), ".".repeat(40), "....................#...................", ".".repeat(40), ".".repeat(40)]
  route(request(rows, { x: 1, y: 2, dir: 1 }, { x: 35, y: 2, dir: 1 }))
  // Water too wide to pass under (12 tiles): the line goes around.
  const wide = [".".repeat(40), "..........~~~~~~~~~~~~..................", "..........~~~~~~~~~~~~..................", "..........~~~~~~~~~~~~..................", ".".repeat(40)]
  const r = route(request(wide, { x: 1, y: 2, dir: 1 }, { x: 35, y: 2, dir: 1 }, { under: () => true }))
  for (const s of r.steps) ok(!(s.y >= 1 && s.y <= 3 && s.x >= 10 && s.x <= 21), `nothing placed on the water (${s.kind} at ${s.x},${s.y})`)
})

test("pipe router: a pump at least every extent; none on a short line", () => {
  const long = [".".repeat(400), ".".repeat(400), ".".repeat(400)]
  const r = route(request(long, { x: 1, y: 1, dir: 1 }, { x: 390, y: 1, dir: 1 }, { extent: 100 }))
  // The path between pumps (or from the source) stays within the extent.
  let pumps = 0
  let from = 1
  for (const s of r.steps) {
    if (s.kind !== "pump") continue
    pumps++
    ok(s.x - from <= 100, `segment from ${from} to the pump at ${s.x} within the extent`)
    from = s.x + 2
  }
  ok(390 - from <= 100, "the last segment within the extent")
  ok(pumps >= 3, `pumps on a 390-tile line with extent 100 (${pumps})`)
  eq(route(request(OPEN, { x: 1, y: 2, dir: 1 }, { x: 40, y: 2, dir: 1 }, { extent: 100 })).steps.filter((s) => s.kind === "pump").length, 0, "no pump within the extent")
})

test("pipe router: B120 a tap starts beside an existing line of the same fluid", () => {
  // The line runs along row 1 (x 2..30); a tap may start on row 2 below any of its pipes, heading south.
  const starts: PipeRequest["starts"] = []
  for (let x = 2; x <= 30; x++) starts.push({ x, y: 2, dir: 2 })
  const rows = [".".repeat(40), ".".repeat(40), ".".repeat(40), ".".repeat(40), ".".repeat(40), ".".repeat(40)]
  const req = request(rows, { x: 0, y: 0, dir: 1 }, { x: 25, y: 5, dir: 2 }, { starts })
  const r = routePipe(req)
  ok(r !== undefined, "a route")
  const first = r!.steps[0]
  ok(first.y === 2 && first.x >= 2 && first.x <= 30, `starts beside the line (${first.x},${first.y})`)
  ok(r!.steps.length <= 4, `a short tap (${r!.steps.length} steps)`)
})

test("pipe router: a remote 800-tile field has a bounded search", () => {
  const rows: string[] = []
  for (let y = 0; y < 16; y++) rows.push(".".repeat(820))
  const req = request(rows, { x: 2, y: 8, dir: 1 }, { x: 810, y: 8, dir: 1 }, { extent: 320, budget: 200000 })
  const r = routePipe(req)
  ok(r !== undefined, "the remote field routes")
  ok(r!.expansions < 1000, `remote line is found without a broad search (${r!.expansions} expansions)`)
})

test("pipe router: no route when the goal is walled in", () => {
  const rows = [".".repeat(20), ".........###........", ".........#.#........", ".........###........", ".".repeat(20)]
  eq(routePipe(request(rows, { x: 1, y: 2, dir: 1 }, { x: 10, y: 2, dir: 0 }, { under: () => false, budget: 20000 })), undefined)
})

run("pipe-router")
