import { eq, run, test } from "./harness"
import * as NF from "../src/strategy/node-facts"

// T1: D69 node facts. The design mints a role and its facts together; graph nodes keep them, and only nodes from saves
// made before the fields existed fall back to reading the role.

test("node facts: the family of a role ignores its parallel suffix only", () => {
  eq(NF.familyOfRole("coal>power~3"), "coal>power")
  eq(NF.familyOfRole("coal>power"), "coal>power")
  // `#N` is a consumer's suffix, not a parallel provider's (B68).
  eq(NF.familyOfRole("coal>power#2"), "coal>power#2")
})

test("node facts: stamped from the role once, then read from the fields", () => {
  const n: NF.NodeFacts = { role: "coal>power~2" }
  NF.stampNodeFacts(n)
  eq(n.family, "coal>power")
  eq(n.serves, "power")
  eq(n.homeCluster, 1)
  eq(NF.nodeParallel(n), true)
  const mall: NF.NodeFacts = { role: "iron-gear-wheel>mall" }
  NF.stampNodeFacts(mall)
  eq(mall.serves, "mall")
  const c2: NF.NodeFacts = { role: "iron-plate>labs#2" }
  NF.stampNodeFacts(c2)
  eq(c2.homeCluster, 2)
  eq(c2.serves, undefined)
  // The fields win over the role once set.
  const set: NF.NodeFacts = { role: "power", family: "power", serves: undefined, homeCluster: 3 }
  eq(NF.nodeServes(set), undefined)
  eq(NF.nodeHomeCluster(set), 3)
})

test("node facts: nodes from older saves fall back to the role", () => {
  eq(NF.nodeServes({ role: "power#2" }), "power")
  eq(NF.nodeServes({ role: "coal>power#2~3" }), "power")
  eq(NF.nodeServes({ role: "power-armor>labs" }), undefined)
  eq(NF.nodeHomeCluster({ role: "iron-plate>labs" }), 1)
  eq(NF.nodeHomeCluster({ role: "iron-plate>labs#3" }), 3)
  eq(NF.servesPower(undefined, "coal>power"), true)
  eq(NF.servesPower(undefined, ""), false)
})

run("node-facts")
