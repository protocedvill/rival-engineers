# Provider-group refactor: the two remaining items

Date: 2026-10-24. Branch `m6-v1`. This note scopes items 1 (verified handover) and 2 (splitter/tap/trunk
augmentation). **It is a scoping record, not an approved design.** Item 1 needs a user decision because it changes a
core layout invariant.

Read first: `docs/analysis/provider-groups-refactor.md` (goalposts), `docs/analysis/provider-groups-handoff.md`
(current state), `docs/agent/architecture.md` (layer boundaries).

## Goalpost 1: verified handover — implemented, adopt branch unproven

**Status:** implemented on the working tree (see M6b.47 in `docs/reports/M6-report.md`); two-seed gate green; the
route-adoption branch has not yet been observed end to end.

All provider retirements used to funnel through `relocate` (`mod/src/strategy/fuel.ts`), which called
`abandonParts(... { modules: [n.id], routes: [], poles: [] })`, then:

```ts
// fuel.ts:155-171
for (const rid of r.routes) gone[rid] = true          // every route of the module
for (const eid of [...f.graph.edgeOrder]) {
  if (e.lost) { LG.removeEdge(...); consumers.push(e.to) }   // and its graph edges
}
```

So retirement is one atomic act: module, routes and graph edges all go at once, and only then does the design plan a
replacement. Observed on seed 2229258:

```
D55 coal>power#4 (n27) is worked out (...): 252 entities to deconstruct, 3 routes dropped,
1 aliased nodes dropped; the design plans a new one
```

That is a deconstruct-then-plan window in which `power#4` has no coal.

### Why it cannot be fixed inside `relocate`

`abandonParts` (`mod/src/planner/conflicts.ts:207-229`) does **not** respect a caller-supplied route list:

```ts
// conflicts.ts:210-214
const routes = [...parts.routes]
for (const rid of layout.routeOrder) {
  const r = layout.routes[rid]
  if ((mods[r.to.module] || (r.from !== undefined && mods[r.from.module])) && routes.indexOf(rid) < 0) routes.push(rid)
}
```

Abandoning a module therefore *always* rips every route whose `to` or `from` is that module. That is a deliberate
invariant, not an oversight: a route is bound to a `ConnectionId` (`Route.conn`) and to `PortRef`s (`Route.from`/`to`)
plus `startDir`, so a route whose producer is gone would dangle in the logical graph, the edge's `physical` list, the
reconciler's repair path and claim ownership.

This matters for handover specifically because the replacement must reach a consumer whose input port is already fed,
so its edge is a **merge** (`plan.ts:499-505`, `mergeGoals` at `plan.ts:434`): it side-loads into the *existing* route.
That existing route belongs to the retiring module. If it is ripped, the replacement's outlet disappears with it.

### What a real implementation needs: route adoption

1. `abandonParts` gains an explicit adopt list (routes that survive their module).
2. For each adopted route: re-home `Route.conn` to the replacement connection and `Route.from`/`startDir` to the
   replacement's out-port; append it to the replacement edge's `physical`.
3. Rip only the now-dead upstream stub, or leave it empty and document why.
4. Re-check the consumers of that invariant: `LogicalEdge.measured`/`capacityRate`, reconciler `repair` (it re-places
   `physical` route parts), `checkLayoutIndexes`, claim ownership (`route:` tags), and `sealedConsumers`.
5. T2 on a real surface: two producers, one consumer port, the first deconstructed, the consumer still fed.

Steps 2 and 4 are the risk: they change `Route`'s meaning from "one connection's belt" to "a belt that may be shared by
a retired and a live connection", which is exactly the provider-group model but is not what the current types say.

### What is already in place (no decision needed)

`mod/src/strategy/handover.ts` — the pure decision boundary, with T1 coverage in
`mod/unit/handover.test.ts` (7 tests):

- `HandoverRecord` / `beginHandover` — mark a role as retiring, once, keeping the first reason and tick.
- `HandoverFeed` / `servedPorts` / `handoverVerdict` — `complete` only when every consumer port the retiring role fed is
  fed by another **built** provider; `waiting` before that; `stalled` past a wait limit so a replacement that can never
  exist (no ore left anywhere) cannot starve the consumers forever.
- `pruneHandovers` — drop records for roles that left the graph.

This is the same shape as the accepted `relocation.ts` and `providers.ts` boundaries and is safe to wire in
independently of how the route-adoption question is answered.

## Item 2: splitter / tap / trunk augmentation

### What exists

- `mergeGoals` (`plan.ts:434-461`) collects free perpendicular tiles along **existing routes to the same consumer**,
  nearest the new producer first, and tries up to 12.
- `routeRequest` sets `req.merge` + `req.mergeGoals` (`plan.ts:499-505`); the router side-loads (`req.goal.side`,
  `router.ts:433`, `683`, `850`) and records `Route.merge` (`layout.ts:91`, `layout.ts:726-730`).
- Splitter **taps** exist in the opposite direction: one producer feeding several consumers through a splitter that
  replaces a belt tile of its route (`Route.tapOf`, `req.taps`, `sameSource`).

### What is missing

1. **Merge by splitter on the trunk**, instead of a side-load. The current merge needs a free perpendicular tile next
   to the old route; when the built factory surrounds the route there is none, and the plan fails with
   `no merge target for <module>.<port>` even though the trunk has a place for a splitter. This is the exact geometry
   that made `g19` fail on seed 8646103.
2. **Trunk taps for a provider** — a new provider joining an existing trunk mid-way rather than only at a consumer port.

### Shape of the work

- Planner: a new end mode on `RouteRequest` (`merge: "side" | "splitter"`), with the splitter occupying a tile of the
  existing route and the new belt entering it; `checkLayout` must validate that the splitter joins routes to the same
  consumer, as it already does for merge targets.
- The splitter must consume a tile of the existing route without ripping it, and `Route.tapOf`-style bookkeeping
  already models "this route replaced a belt tile of that route" — the mirror of what is needed.
- T2 is mandatory here: splitter input merging is engine behaviour (2.0 priorities), and the repo's rule is that a
  claimed Factorio behaviour needs a T2 test on a real surface.

## Recommended order

1. Wire `handover.ts` for the **detection and reporting** only: mark retiring roles, log `handover waiting: <port>`, and
   keep today's `relocate`. No invariant change, but the window becomes observable in soaks and telemetry.
2. Item 2 (splitter merge): self-contained in `planner/`, T1/T2 testable, and it addresses an observed plan failure.
3. Item 1 step 2 (route adoption): only after the user decides that `Route` may outlive its producing connection.

## Open decision for the user

Should `Route` be allowed to outlive the connection that created it (adopted by a replacement provider), or should
handover instead avoid sharing a route by re-planning the consumer's feed onto a fresh route before the old module
dies? The first is the provider-group model the refactor document describes; the second keeps the invariant and costs
a temporary double route per consumer.

## Magic numbers to surface

- `handoverVerdict` takes `maxMinutes` as a parameter (no value is committed yet). Whatever the caller passes is a new
  tuning number and must appear in the milestone report's "Magic numbers for the user" table.

## Implementation record (2026-10-24)

Route adoption was approved and implemented in M6b.47 (`docs/reports/M6-report.md`):

- `planner/layout.ts` `adoptRoute` re-homes a route; `planner/conflicts.ts` `abandonParts(..., adopt?)` keeps it.
- `strategy/fuel.ts` `relocate` finds the heir edge per consumer port, adopts its routes, and appends them to the heir
  edge's `physical`.
- `strategy/handover.ts` is the pure gate (`complete` / `waiting` / `stalled`); `beginHandover` + `serviceHandovers`
  drive the three retirement sites (`P36(a)`, `D54`, `D55`).
- `strategy/stage.ts` `handoverRoles` + `strategy/design.ts` plan the replacement under a `parallelRole` with `merge`
  edges.
- Safety valve: `HANDOVER_MAX_MINUTES = 10` (`strategy/fuel.ts`), surfaced to the user in M6b.47.

**Not yet proven:** `m6-b60v-handover` exercised only the "port already covered" branch (seed 2229258, completed in
75 ms) and the "no placeable replacement" stall (seed 8646103, `no feasible position (1 of 1 patches tried)`). Adopt a
survivor route in a targeted T2 before claiming goalpost 1 met.
