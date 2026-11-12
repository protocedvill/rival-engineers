// D69 (user decision in-session 2026-10-29, done in M7a): facts about a node that code used to read out of its role
// string (`power#2`, `coal>power~3`, `iron-plate>labs#2`, `...>mall`). The design mints a role and these facts together
// (`stampNodeFacts`); the graph node keeps them (`LogicalNode.cluster/family/serves`). Everything else asks this module.
// Only it parses roles, and only for nodes from a save made before the fields existed.
//
// Pure: no Factorio globals (T1: mod/unit/node-facts.test.ts).

/** What a node exists for besides its own product: the steam block and its fuel supply, or the mall and its supply. */
export type Serves = "power" | "mall"

export interface NodeFacts {
  role: string
  /**
   * The production cluster (1-based) its role was designed for. A design node's `cluster` is the walk that added it,
   * which differs for a provider shared across clusters (a cluster-1 provider tapped by cluster 2's consumers).
   */
  homeCluster?: number
  /** Provider family: parallel providers (`<role>~N`) share their first provider's family. */
  family?: string
  serves?: Serves
}

/** The provider family of a role (`coal>power~3` → `coal>power`). */
export function familyOfRole(role: string): string {
  // TSTL wraps `string.match`'s returns in a 0-based TS array; [0] is the first capture.
  const m = string.match(role, "^(.*)~%d+$")
  return m[0] ?? role
}

/** Whether a role is the power node or a fuel supply of it ("power", "power#2", "coal>power", "coal>power~2", ...). */
export function rolePower(role: string): boolean {
  const r = familyOfRole(role)
  return string.match(r, "^power#?%d*$")[0] !== undefined || string.match(r, ">power#?%d*$")[0] !== undefined
}

/** Whether a role is the mall or a supply of it. */
export function roleMall(role: string): boolean {
  const r = familyOfRole(role)
  return r === "mall" || string.match(r, ">mall$")[0] !== undefined
}

/** The cluster a role belongs to: `#N` is a consumer's cluster suffix (B68; `~N` marks parallel providers). */
export function roleCluster(role: string): number {
  const [n] = string.match(familyOfRole(role), "#(%d+)$")
  return n !== undefined ? (tonumber(n) ?? 1) : string.find(role, "#", 1, true)[0] !== undefined ? 2 : 1
}

/** Sets the facts of a freshly designed node from the role the design minted for it. */
export function stampNodeFacts(n: NodeFacts): void {
  n.homeCluster = roleCluster(n.role)
  n.family = familyOfRole(n.role)
  n.serves = rolePower(n.role) ? "power" : roleMall(n.role) ? "mall" : undefined
}

export function nodeFamily(n: NodeFacts): string {
  return n.family ?? familyOfRole(n.role)
}

export function nodeServes(n: NodeFacts): Serves | undefined {
  if (n.family !== undefined) return n.serves
  return rolePower(n.role) ? "power" : roleMall(n.role) ? "mall" : undefined
}

export function nodeHomeCluster(n: NodeFacts): number {
  return n.homeCluster ?? roleCluster(n.role)
}

/** Whether the node is a parallel provider (`<role>~N`, B68), not the first of its family. */
export function nodeParallel(n: NodeFacts): boolean {
  return nodeFamily(n) !== n.role
}

/** Whether a node (or, when the graph no longer has it, the role it had) is power or a fuel supply of it. */
export function servesPower(n: NodeFacts | undefined, role: string): boolean {
  return n !== undefined ? nodeServes(n) === "power" : rolePower(role)
}
