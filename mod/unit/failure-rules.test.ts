import { eq, run, test } from "./harness"
import { FailedPlanFacts, idleProviderMoves, learnFromFailure, noFeedPorts, retryCannotHelp, SealEvidence, strongestReplan } from "../src/strategy/failure-rules"
import { EAST, ModuleDef, Port, WEST } from "../src/modules/types"
import { IDENTITY } from "../src/modules/geometry"
import { asciiTerrain } from "../src/planner/grid"
import { commitModule, LayoutState, newLayout } from "../src/planner/layout"
import { moduleId } from "../src/shared/ids"
import { vanillaFacts as F } from "./vanilla-facts"
import { planFailure } from "../src/shared/plan-failure"

// T1: D69 failure rule. What a failed plan teaches the design, from typed failures (was six detectors in
// `factory.ts` `updatePlanning`, two of them reading the failure text).

function facts(over: Partial<FailedPlanFacts>): FailedPlanFacts {
  return {
    failures: [],
    edges: [],
    nodes: [],
    provider: () => undefined,
    portFed: () => false,
    aliasOf: () => undefined,
    fallbackFor: () => false,
    ...over,
  }
}

function kinds(f: FailedPlanFacts): string {
  return learnFromFailure(f)
    .map((l) => `${l.kind}:${l.key}`)
    .join(" ")
}

const A = { role: "coal*>a=>a.in", from: "coal*>a", to: "a", toPort: "in" }
const B = { role: "coal*>a=>b.in", from: "coal*>a", to: "b", toPort: "in" }

test("B60/B61: a new shared provider that can't reach every consumer splits", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("other", "no path") }], edges: [A, B], nodes: [{ id: "n1", role: "coal*>a" }] })
  eq(kinds(f), "providerSplit:coal*>a")
  // Built already: it is a provider with taps, not a new shared one.
  eq(kinds({ ...f, provider: () => "built" }), "providerNoTap:coal*>a=>a.in noTap:coal*>a")
})

test("review fix (Layers14): a failed route from an idle built provider forks nothing; a connected one still does", () => {
  const failures = [{ key: A.role, failure: planFailure("other", "no path") }]
  const builtBoth = (role: string): "built" => (role === "coal*>a" || role === "a" ? "built" : (undefined as never))
  const idleFacts = facts({ failures, edges: [A], provider: builtBoth, connected: () => false })
  eq(kinds(idleFacts), "", "no noTap/providerNoTap for an idle provider")
  eq(idleProviderMoves(idleFacts).join(","), "coal*>a", "after the attempts, the idle provider moves toward its built consumer")
  eq(kinds({ ...idleFacts, connected: () => true }), "providerNoTap:coal*>a=>a.in noTap:coal*>a", "a provider with routes keeps the B19/B61 rules")
  eq(idleProviderMoves({ ...idleFacts, connected: () => true }).join(","), "", "a connected provider is not moved")
  const consumerNew = facts({ failures, edges: [A], provider: (role) => (role === "coal*>a" ? "built" : role === "a" ? "planned" : undefined), connected: () => false })
  eq(idleProviderMoves(consumerNew).join(","), "", "a consumer still being planned is the plan's to re-place")
  // TSTL: `{ ...x, connected: undefined }` would keep the old value (CLAUDE.md); clear it on a copy.
  const legacy = { ...idleFacts }
  legacy.connected = undefined
  eq(kinds(legacy), "providerNoTap:coal*>a=>a.in noTap:coal*>a", "without the fact: the old rules")
})

test("B71/B80: no merge target, or a port another belt feeds, takes no merge", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("no-merge-target", "no merge target for n1.in") }], edges: [A] })
  eq(kinds(f), "noMerge:a.in", "from the failure kind, not its text")
  eq(kinds({ ...f, failures: [{ key: A.role, failure: planFailure("other", "no merge target for n1.in") }] }), "", "the text alone does not count")
  eq(kinds({ ...f, failures: [{ key: A.role, failure: planFailure("other", "no path") }], portFed: () => true }), "noMerge:a.in")
})

test("D68: an unplaceable producer whose item has a built producer with capacity falls back to tapping it", () => {
  const f = facts({ failures: [{ key: "module:n7", failure: planFailure("no-position", "no feasible position", "coal") }], nodes: [{ id: "n7", role: "coal>power~2", item: "coal" }], fallbackFor: (item) => item === "coal" })
  eq(kinds(f), "fallback:coal")
  eq(kinds({ ...f, fallbackFor: () => false }), "")
})

test("B72: a new provider folded into a shared mine whose route failed gets a site of its own", () => {
  const f = facts({ failures: [{ key: A.role, failure: planFailure("other", "no path") }], edges: [A], nodes: [{ id: "n9", role: "coal*>a" }], aliasOf: (id) => (id === "n9" ? "n3" : undefined) })
  eq(kinds(f), "ownSite:coal*>a")
})

test("the strongest replan wins, in the order the factory always reported", () => {
  eq(strongestReplan(["without taps", "without that merge"]), "without that merge")
  eq(strongestReplan(["without taps", "parallel providers"]), "parallel providers")
  eq(strongestReplan([]), undefined)
})

test("M7c.8: an outpost whose only failure is its pole line is not retried", () => {
  eq(retryCannotHelp(true, [{ key: "power:n351" }]), true, "outpost, pole line only")
  eq(retryCannotHelp(false, [{ key: "power:n351" }]), false, "not an outpost: the region ladder may help")
  eq(retryCannotHelp(true, [{ key: "power:n351" }, { key: "module:n351" }]), false, "a placement failure too")
  eq(retryCannotHelp(true, []), false, "no failure recorded")
})

function box(id: string, w: number, h: number, ports: Port[]): ModuleDef {
  return { id, source: "generated", footprint: { w, h }, entities: [], ports, recipes: [], machines: [], rates: { inputs: [], outputs: [] }, requiresTech: [], rotatable: true, mirrorable: true }
}

function place(state: LayoutState, def: ModuleDef, x: number, y: number): void {
  commitModule(state, { id: moduleId(def.id), canonical: def, def, transform: IDENTITY, origin: { x, y }, rect: { x, y, w: def.footprint.w, h: def.footprint.h } }, F, 0)
}

test("review fix (B57/B61 noFeed): only the named port, and only while the persistent layout still seals it", () => {
  // dst's west crude port `in` is walled in (two 1x1 walls and another fluid's port moat); its east port `in2` is open.
  const rows: string[] = []
  for (let y = 0; y < 30; y++) rows.push(string.rep(".", 30))
  const terrain = asciiTerrain(rows)
  const state = newLayout()
  place(state, box("dst", 5, 5, [
    { id: "in", kind: "pipe-in", pos: { x: 0.5, y: 2.5 }, dir: EAST as 0, item: "crude-oil" },
    { id: "in2", kind: "pipe-in", pos: { x: 4.5, y: 2.5 }, dir: WEST as 0, item: "crude-oil" },
  ]), 10, 10)
  place(state, box("other", 1, 1, [{ id: "out", kind: "pipe-out", pos: { x: 0.5, y: 0.5 }, dir: EAST as 0, item: "water" }]), 6, 12)
  place(state, box("wall-n", 1, 1, []), 8, 11)
  place(state, box("wall-s", 1, 1, []), 8, 13)
  const id = (role: string): string | undefined => (role === "dst" ? "dst" : undefined)
  const sealedRoute = (port: string, side: "start" | "goal" = "goal"): SealEvidence => ({ kind: "route", subject: `crude>dst=>dst.${port}`, sealed: { side, port: { module: moduleId("dst"), port } } })
  const keys = (ev: SealEvidence[]): string => noFeedPorts(state, terrain, ev, id, 32).map((p) => `${p.module}.${p.port}`).join(",")
  eq(keys([sealedRoute("in")]), "dst.in", "the sealed port is marked")
  // The failed plan proved `in2` sealed, but only its own (discarded) routes walled it: the base leaves it open.
  eq(keys([sealedRoute("in2")]), "", "a port the persistent layout leaves open is not marked")
  // A start-side seal naming in2 as the subject's consumer: another input of dst being sealed is no reason to mark in2.
  eq(keys([{ ...sealedRoute("in2", "start"), sealed: { side: "start", port: { module: moduleId("src"), port: "out" } } }]), "", "not the port of another sealed input")
  eq(noFeedPorts(state, terrain, [sealedRoute("in")], id, 0).length, 0, "no escape distance: no proof, no mark")
})

run("failure-rules")
