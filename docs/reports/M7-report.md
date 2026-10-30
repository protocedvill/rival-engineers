# M7 report

M7 is blue science (SPEC §8, decisions D72–D79, phases P45). Each faction sustains ≥ 30 red + 30 green + 30 blue
science/min over 30 game-minutes within 16 game-hours and researches the D74 set, on ≥ 18/20 random seeds, ≥ 9/10 fixed
seeds and two factions. Phases: M7a refactor and hardening; M7b fluids; M7c a first blue line; M7d advanced oil,
robots and the full mall; M7e scale to 30 + 30 + 30 and acceptance.

## M7a: refactor and hardening

Scope (P45): remove verified handover (D76); the D69 refactors from the 2026-10-29 audit (a typed planner failure and
one constraint store, node fields instead of role-string parsing, one reconciler handler per remedy kind); split
`strategy/factory.ts`; D71 (a) and (b); check and close B29 and B65; triage SPEC §11. Gate before blue work: random20
≥ 18/20 on the refactored code.

### M7a.1: verified handover removed (D76)

The user approved removing verified provider handover in-session (2026-10-30). M6b.47's evidence: no route was ever
adopted in a soak, one handover completed at once because another built provider already fed the port, and one
stalled at the 10-minute valve and fell back to deconstruct-then-plan.

What replaced it (the provider-group rule, "build a parallel provider, then retire the old one"):

- `strategy/retire.ts` (pure, T1 `retire`): a retiring provider records which built providers already fed its consumer
  ports when it began. It is deconstructed once its drills run dry, or once every consumer port it feeds is also fed
  by a built provider that was not feeding that port then (its replacement). There is no time limit: a burner outpost
  (D54) whose replacement can never be built keeps producing instead of being torn down after 10 minutes.
  The replacement is judged by the ports, not by the provider family. A first draft retired a provider once any new
  member of its family (`role`, `role~N`) was built; fixed seed 222 (`m6-fixed10-845a46b`) shows why that is wrong:
  `iron-ore>…labs~2` (n25) fed the parallel smelter n29 while the family's new first mine (n49) fed n15, so the family
  rule would have torn n25 down and starved n29 (T1 `retire` pins the case).
- `strategy/fuel.ts` `beginRetire` / `serviceRetiring` replace `beginHandover` / `serviceHandovers`, checked once a
  game-minute like the ore. The entry points are unchanged: P36 (a) fuel running low, D67 mine lead time, D54
  burner outposts, D55 worked-out mines.
- The design still plans the replacement under a parallel role whose edge merges into the belt the retiring provider
  feeds (`DesignContext.retiring`, was `handover`), so both feed the consumer until the old one goes.
- Removed: `strategy/handover.ts`, `planner/adoption.ts` (`planAdoption`), `planner/layout.ts` `adoptRoute`,
  `abandonParts(..., adopt)`, the `HANDOVER_MAX_MINUTES` valve, T1 `handover`, `handover-route`, `adoption`.
  When the old provider goes, its routes go with it, and the replacement's merge onto that belt is routed again by the
  reconciler, as in every M6 soak (none adopted a route).

Tests: T1 (new `retire`, 5 tests); T2 `reconciler` P36 (a) and D67 rewritten for D76 (kept while the replacement is only
planned, retired once it is built and feeds the port; a mine with ore is kept with no time limit). Full T2 162/162 on the M7a
code (with the D71 (b) test).

### M7a.2: the D69 refactor (constraint store, typed failures, node facts, remedy handlers, first factory split)

The three refactors the user deferred to M7 (D69, from the 2026-10-29 audit), each kept behaviour-identical except
where noted:

1. **Typed planner failures and one constraint store.**
   - `shared/plan-failure.ts`: a failure has a `kind` (`no-patch`, `no-position`, `no-site`, `no-merge-target`,
     `other`) next to its text. The placer sets it where it gives up (`PlacementSearch.failure`); `routeRequest`
     returns a typed failure; `PlanJob.failed` holds them (all writes go through one `fail()` helper).
   - `strategy/constraints.ts`: one store (`FactoryState.constraints`) replaces ten flag maps on the factory state
     (`noTap`, `providerShort`, `providerSplit`, `ownSite`, `growFails`, `cluster1Caps`, `providerNoTap`, `noMerge`,
     `wideJoin`, `fallback`). Each kind has a scope (provider, feed, port, item); `dropRole` drops a provider's
     entries when it leaves the graph (was six hand-written deletes in `relocate`); the design cache key is built from
     it. Saves made before it are migrated on the first think (`adoptLegacy`).
   - `strategy/failure-rules.ts`: the six detectors of `updatePlanning`'s failure branch are one pure rule,
     `learnFromFailure`, over typed failures. "no merge target" and "no site in the region" are read from the kind,
     not the text; `EX.exhausted` takes the typed failures.
   - Behaviour changes: (a) a module that is not a mine and found no position is no longer read as an exhausted
     "patch" of its product (the old text pattern took `(iron-plate>labs): no feasible position` as a patch failure of
     `iron-plate` and started exploring for it); (b) dropping a role also drops its `ownSite` flag.
   - `stage.ts`: the tap eligibility test (`noTap || providerShort || retiring`), written twice, is one `tappable()`.
2. **Node facts instead of role strings.** `strategy/node-facts.ts`: the design stamps each node with `family`,
   `serves` (`power`/`mall`) and `homeCluster` when it mints the role; goal and graph nodes keep them. Goal grouping,
   growth power checks, the cluster-1 cap guard (was `!isPowerRole && no "#" && !isParallelRole`) and the retire family
   read the fields. Only `node-facts.ts` parses roles, for nodes from older saves and inside the design walk.
3. **One handler per remedy kind.** `applyRemedy` (≈270 lines, branching on the kind and on the key prefix
   `deplete:` four times) is a table `REMEDIES` with one handler per kind. A worked-out outpost is its own remedy kind
   (`deplete`) instead of a `grow` remedy recognised by its key; `grow` and `deplete` share `growNode`.

Also the first slice of the `factory.ts` split: research and hand-fed labs moved to `strategy/lab-feed.ts`.
`factory.lua` had reached 189 main-chunk locals with the new imports (build guard 185, Lua limit 200); it is at 178.

Tests: T1 42/42 files (new `constraints`, `failure-rules`, `node-facts`; `failed-mine` rewritten for typed failures;
`exhausted` folded into it). The new pure modules are in the architecture check's pure list.

### M7a.3: make before break for evicted poles (D71 b)

Two-faction seed 222 (M6): production goal g19 evicted 22 poles (B37) at 99 min; they were picked up in the build's
clear phase while their replacement line went up with the rest of a 153-entity build, and most of the factory was
dark until ~130 min. The user deferred the proposed remedy to M7 (D71 (b), 2026-10-30).

- `planner/runtime.ts`: a build that evicts poles (`startBuild(..., { breakAfter })`) starts in a new `poles` phase.
  `placeReplacementPoles` ghosts the plan's pole-line poles whose tiles nothing still has to be cleared from, with place
  jobs; once those are done the evicted poles get their clear jobs and the build goes on as before (`clear`, `place`).
  A pole standing where an obstacle or old entity goes first waits for the normal stamp; `stampParts` skips a pole whose
  ghost is already there.
- Growth builds (`startGrow`) do the same with `growBuild.phase = "poles"`: the old poles among `plan.remove` wait until
  the electric poles among `plan.add` stand. This covers B37 evictions by growths and a module's own poles that a growth
  moves (B67).
- Without an eviction nothing changes (no `poles` phase).

Test: T2 `factory` "D71 (b)": a build evicting a pole starts in `poles`, ghosts only the new pole on open ground, keeps
the old pole until the new one is placed, then queues its clear job; a build without an eviction starts in `clear`.

### Magic numbers for the user (M7)

| Name | Where | Value | Why | Setting? |
|---|---|---|---|---|
| Robot count per faction (P49) | not implemented yet | ~50 | Approved as "about 50" with P49; the exact number is set when robots are built (M7d). | no |
