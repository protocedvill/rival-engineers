import { LuaGuiElement, PlayerIndex, Tags } from "factorio:runtime"
import { clearConfigOverrides, getConfig, setConfigOverride } from "../config"
import { moduleId } from "../shared/ids"
import { createFaction, destroyFaction } from "../jobs/faction"
import { addEdge, addNode } from "../planner/logical"
import { startBootstrap } from "../strategy/bootstrap"
import { onGraphClick, setGraphOpen } from "../review/graph-window"
import { graphLayout } from "../review/graph-layout"
import { FactoryState, getFactory, reconcileParams, startFactory } from "../strategy/factory"
import { at, createLab } from "./lab"

// B16 T2: the factory-graph window on real storage — the pure layout is asserted headless and, when the run has a
// player, the window opens, renders one chip per node with its rate, and closes (review.test.ts's pattern).

/** An outpost → smelter chain with one probed belt edge; the smelter is only planned, so the window sees both lives. */
function addChain(f: FactoryState): void {
  const tick = game.tick
  addNode(f.graph, {
    id: moduleId("n1"),
    role: "mine",
    kind: "outpost",
    item: "iron-ore",
    capacity: { inputs: [], outputs: [{ item: "iron-ore", perSecond: 6 }] },
    planned: { inputs: [], outputs: [{ item: "iron-ore", perSecond: 4 }] },
    powerW: 0,
    lifecycle: "built",
    status: "ok",
    createdTick: tick,
    builtTick: tick,
    measured: { tick, window: 60, inputs: [], outputs: [{ item: "iron-ore", perSecond: 4 }], machines: 4, states: { working: 0.9, starved: 0, blocked: 0, unpowered: 0, unfuelled: 0, idle: 0.1 } },
  })
  addNode(f.graph, {
    id: moduleId("n2"),
    role: "smelt",
    kind: "module",
    item: "iron-plate",
    capacity: { inputs: [{ item: "iron-ore", perSecond: 4 }], outputs: [{ item: "iron-plate", perSecond: 4 }] },
    planned: { inputs: [{ item: "iron-ore", perSecond: 4 }], outputs: [{ item: "iron-plate", perSecond: 2 }] },
    powerW: 0,
    lifecycle: "planned",
    status: "unknown",
    createdTick: tick,
  })
  addEdge(f.graph, {
    id: "e1",
    role: "mine>smelt",
    kind: "belt",
    item: "iron-ore",
    from: moduleId("n1"),
    to: moduleId("n2"),
    plannedRate: 4,
    physical: ["route:e1"],
    belt: "transport-belt",
    measuredRate: 1,
    measuredTick: tick,
    capacityRate: 15,
    measuredFull: { from: 0.2, to: 0.1 },
  })
}

function countChips(el: LuaGuiElement): number {
  let n = (el.tags as { re?: string } | undefined)?.re === "graph-node" ? 1 : 0
  for (const child of el.children) {
    if (child !== undefined) n += countChips(child)
  }
  return n
}

describe("factory-graph window", () => {
  after_all(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
  })
  before_each(() => {
    for (const name of [...storage.factionOrder]) destroyFaction(name)
    clearConfigOverrides()
  })

  test("the window lays a graph out by dataflow and opens, renders and closes", () => {
    const lab = createLab(16)
    const faction = createFaction("gw-a", { position: at(lab, 0, 0), crew: 1, starterItems: {} })
    // The factory planner ticks on its own cadence (onFactoryTick() does not look at the brain's nextThink), so a
    // merged-in planner tries to goal-plan during the tick window and mutates the hand-built graph. Freeze it.
    setConfigOverride("factoryEnabled", false)
    const brain = startBootstrap(faction, at(lab, 0, 0))
    brain.nextThink = math.huge // the test drives the graph; the brain stays idle
    const f = startFactory(faction)
    addChain(f)
    after_ticks(5, () => {
      const params = reconcileParams(getConfig())
      const view = graphLayout(f.graph, game.tick, params)
      assert(view.levels.length === 2, `levels ${view.levels.length}`)
      assert(view.levels[0].length === 1 && view.levels[0][0].id === "n1", `level 0 = [${view.levels[0].map((n) => n.id)}]`)
      assert(view.levels[1].length === 1 && view.levels[1][0].id === "n2", `level 1 = [${view.levels[1].map((n) => n.id)}]`)
      assert(view.statusCounts.ok === 1 && view.statusCounts.unknown === 1, "one built ok node, one planned unknown")
      const e = view.edges[0]
      assert(e !== undefined && e.verdict === "sparse" && e.planned === 4 && e.measured === 1, `edge ${e?.verdict}`)
      const factory = getFactory(faction.name)
      assert(factory !== undefined && factory.graph.nodeOrder.length === 2, "the factory carries the graph")
      const player = game.get_player(1 as PlayerIndex)
      if (player === undefined || !player.valid) {
        log("[graph-window] no player in this test run: GUI not exercised")
        return
      }
      setGraphOpen(player, true)
      const frame = player.gui.screen.re_graph
      assert(frame !== undefined && frame.valid, "graph window open")
      const shown = frame!
      assert(countChips(shown) === 2, `chips ${countChips(shown)} of 2`)
      // Facet cycling keeps both windows on the same faction.
      onGraphClick(player, { re: "graph-faction", v: 1 } as Tags)
      assert(shown.valid, "still valid after a faction cycle")
      setGraphOpen(player, false)
      assert(player.gui.screen.re_graph === undefined, "graph window closed")
    })
  })

  test("a faction without a factory gets the no-factory note, not a crash", () => {
    const lab = createLab(16)
    const faction = createFaction("gw-b", { position: at(lab, 4, 0), crew: 1, starterItems: {} })
    void faction
    after_ticks(5, () => {
      const player = game.get_player(1 as PlayerIndex)
      if (player === undefined || !player.valid) {
        log("[graph-window] no player in this test run: GUI not exercised")
        return
      }
      setGraphOpen(player, true)
      const frame = player.gui.screen.re_graph
      assert(frame !== undefined && frame.valid, "graph window opens without a factory")
      assert(countChips(frame!) === 0, "no chips without a graph")
      setGraphOpen(player, false)
    })
  })
})
