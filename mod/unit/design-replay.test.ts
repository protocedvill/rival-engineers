import { generate, GeneratorName } from "../src/modules/generators"
import { ModuleDef } from "../src/modules/types"
import { design, DesignContext, DesignTarget, MakeModule } from "../src/strategy/design"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1: B198. A design context captured in a soak (`design_debug(name, "dump:<file>")`, factory.ts) replays here with
// the vanilla facts and generators; its curated modules come with the capture. Copy a capture into mod/unit/fixtures/
// and list it below. DESIGN_REPLAY=<absolute path> replays any capture and prints its nodes and edges
// (DESIGN_FILTER=<text> keeps the roles containing it).

declare const os: { getenv(this: void, name: string): string | undefined }
declare function loadfile(this: void, path: string): ((this: void) => unknown) | undefined

interface Capture {
  ctx: Partial<DesignContext>
  target: DesignTarget
  curated: Record<string, ModuleDef>
}

function load(path: string): Capture {
  const full = string.sub(path, 1, 1) === "/" ? path : `${os.getenv("UNIT_SRC") ?? "../unit"}/fixtures/${path}.lua`
  const chunk = loadfile(full)
  if (chunk === undefined) error(`design capture ${full} not found`)
  return chunk() as Capture
}

function contextOf(c: Capture): DesignContext {
  // Captures from before the mall was exported: replay without the mall.
  if (c.target.mall !== undefined && c.curated[c.target.mall.id] === undefined) {
    print(`(capture has no ${c.target.mall.id}: replayed without the mall)`)
    c.target.mall = undefined
  }
  const make: MakeModule = (gen, params) => (gen === "curated" ? c.curated[params.id as string] : (generate(F, gen as GeneratorName, params) as ModuleDef))
  return { ...(c.ctx as DesignContext), facts: F, make }
}

/** Replays a capture's design. */
export function replayDesign(path: string): ReturnType<typeof design> {
  const c = load(path)
  return design(contextOf(c), c.target)
}

test("B199: cluster walks share a short built provider's capacity (seed 11, min 222)", () => {
  // Two clusters each walked half the target and both gave their consumers the built engine providers' full capacity:
  // the merged design asked them for twice what they make and planned no third provider. The factory idled.
  const c = load("m7-seed11-design-clusters")
  const d = design(contextOf(c), c.target)
  ok(d.clusters > 1, "the design has several clusters")
  const over: string[] = []
  for (const n of d.nodes) {
    const cap = c.ctx.providerCaps?.[n.role]
    // Labs and steam blocks are sized by their own rules (one power pool, M7d.5).
    if (n.kind === "labs" || n.kind === "power") continue
    if (cap !== undefined && c.ctx.providerShort?.[n.role] === true && n.need > cap + 1e-6) over.push(`${n.role} ${n.need}>${cap}`)
  }
  eq(over.join("; "), "", "no short built provider is asked for more than it makes")
  const engines = d.nodes.filter((n) => n.item === "engine-unit")
  ok(engines.some((n) => c.ctx.providerCaps?.[n.role] === undefined), "a new parallel engine provider")
  let made = 0
  let asked = 0
  for (const n of engines) made += math.max(n.need, 0)
  for (const e of d.edges) if (e.item === "engine-unit") asked += e.rate
  ok(made + 1e-6 >= asked, `the engine providers carry their edges: ${made} for ${asked}`)
})

const adhoc = os.getenv("DESIGN_REPLAY")
if (adhoc !== undefined) {
  test(`design replay ${adhoc}`, () => {
    const d = replayDesign(adhoc)
    const filter = os.getenv("DESIGN_FILTER") ?? ""
    const has = (r: string): boolean => filter === "" || string.find(r, filter, 1, true)[0] !== undefined
    for (const n of d.nodes) if (has(n.role)) print(string.format("node %s %s need=%.4g cap=%.4g", n.role, n.generator, n.need, n.capacity))
    for (const e of d.edges) if (has(e.role)) print(string.format("edge %s %s -> %s.%s %.4g", e.role, e.from, e.to, e.toPort, e.rate))
    print(`errors: ${d.errors.join("; ")}`)
    ok(d.nodes.length > 0, "a design")
  })
}

run("design-replay")
