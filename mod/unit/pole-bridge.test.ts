import { labArray, steamBlock } from "../src/modules/generators"
import { moduleId, poleId, poleLineId } from "../src/shared/ids"
import type { PoleId } from "../src/shared/ids"
import { tkey } from "../src/planner/grid"
import { checkClaimOwners } from "../src/planner/claims"
import { claimPoleTile } from "../src/planner/claims"
import { commitModule, findModule, LayoutState, newLayout, PlacedModule, removeModule } from "../src/planner/layout"
import { keepBridges, rehomeKeptPoles, removePoleLines, unpoweredModules } from "../src/planner/power"
import { eq, ok, run, test } from "./harness"
import { vanillaFacts as F } from "./vanilla-facts"

// T1, B63 (bridge rule): a pole that is the only power path to a module that stays is never removed with an abandoned
// module. Seed 3891760: a mall's demolition took a pole chain with it and 91 modules went dark on a 17-tile gap.

function place(l: LayoutState, id: string, def: ReturnType<typeof labArray>, x: number, y: number): PlacedModule {
  const m: PlacedModule = { id: moduleId(id), canonical: def, def, transform: { rot: 0, mirror: false }, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h }, fixed: true }
  commitModule(l, m, F, 2)
  return m
}

/** The tile of a module's own pole (module defs carry their poles, M4a). */
function ownPole(l: LayoutState, id: string): { x: number; y: number } {
  const m = findModule(l, id)
  if (m === undefined) return { x: 0, y: 0 }
  for (const e of m.def.entities) if (F.entity(e.name)?.type === "electric-pole") return { x: math.floor(m.origin.x + e.x), y: math.floor(m.origin.y + e.y) }
  return { x: 0, y: 0 }
}

/** A straight pole line from `a` to `b` (tiles), spaced so consecutive poles connect, ending near both. */
function lineBetween(l: LayoutState, a: { x: number; y: number }, b: { x: number; y: number }, prefix: string, to: string): string {
  const name = "small-electric-pole"
  const step = math.floor(F.entity(name)?.wireReach ?? 7.5) - 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const n = math.max(1, math.ceil(math.max(math.abs(dx), math.abs(dy)) / step))
  const line = poleLineId(prefix)
  l.poles ??= []
  l.poleLines ??= []
  const ids: PoleId[] = []
  for (let i = 1; i < n; i++) {
    const x = a.x + math.floor((dx * i) / n)
    const y = a.y + math.floor((dy * i) / n)
    const id = poleId(`${line}.${i}`)
    l.poles.push({ id, name, x, y, line })
    claimPoleTile(l, tkey(x, y), line)
    ids.push(id)
  }
  l.poleLines.push({ id: line, to: moduleId(to), from: "?", poles: ids })
  return line
}

/** steam --line1-- mid --line2-- east, both lines meeting at mid's own pole. */
function chain(): { l: LayoutState; line1: string; line2: string } {
  const l = newLayout()
  place(l, "steam", steamBlock(F, { boilers: 1 }), 2, 20)
  place(l, "mid", labArray(F, { labs: 2, packs: ["automation-science-pack"] }), 40, 20)
  place(l, "east", labArray(F, { labs: 2, packs: ["automation-science-pack"] }), 80, 20)
  const s = ownPole(l, "steam")
  const m = ownPole(l, "mid")
  const e = ownPole(l, "east")
  const line1 = lineBetween(l, s, m, "poles:a:", "mid")
  const line2 = lineBetween(l, m, e, "poles:b:", "east")
  return { l, line1, line2 }
}

test("B63: abandoning a module whose pole bridges two line ends keeps the bridge, and the far module stays powered", () => {
  const { l, line1, line2 } = chain()
  eq(unpoweredModules(l, F).length, 0, "the chain powers everything to start with")
  const k = keepBridges(l, F, [line1, line2], ["mid"])
  ok(k.keepPoles.length > 0, `the bridge poles are kept: ${k.keepPoles.length}`)
  eq(k.dropLines.length, 0, "no line that carries the far side is dropped")
  // The real sequence: the module goes, then the kept poles are put back into the layout.
  removePoleLines(l, k.dropLines)
  rehomeKeptPoles(l, k.keepPoles)
  eq(checkClaimOwners(l).length, 0, `the re-homed poles leave no orphan claims: ${checkClaimOwners(l).slice(0, 3).join("; ")}`)
  removeModule(l, moduleId("mid"), F)
  eq(checkClaimOwners(l).length, 0, `still none after the module goes: ${checkClaimOwners(l).slice(0, 3).join("; ")}`)
  eq(unpoweredModules(l, F).length, 0, "east is still powered through the kept pole")
})

test("B63: abandoning a leaf module removes its line (nothing depends on it)", () => {
  const { l, line2 } = chain()
  const k = keepBridges(l, F, [line2], ["east"])
  eq(k.keepPoles.length, 0, "a leaf line is no bridge")
  eq(k.dropLines.length, 1, "the leaf line may go")
})

test("B63: removing the generator is never guarded (losing power is the point)", () => {
  const { l, line1, line2 } = chain()
  const k = keepBridges(l, F, [line1, line2], ["steam"])
  eq(k.keepPoles.length, 0, "no pole kept when the plant itself is abandoned")
  eq(k.dropLines.length, 2, "both lines go with it")
})

run("pole-bridge")
