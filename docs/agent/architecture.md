# Architecture map: read this before deciding where code belongs

Read SPEC §5 for the normative design. This page is the implementation map and the boundary checklist.

## Runtime flow

```text
control.ts events
  → tick.ts deterministic scheduler
    → strategy/ bootstrap or factory coordinator
      → planner/ pure-ish layout, placement and routing jobs
      → jobs/ persistent Job Board and crew scheduling
        → character/ Factorio action adapter
```

`modules/` describes reusable physical factory modules. `world/` owns resource discovery, claims and spawning.
`review/` and `telemetry.ts` observe the simulation and must not change decisions. `tools/` builds, tests, replays,
renders and runs long acceptance experiments.

`diagnostic-events.ts` is the save-safe decision-history boundary. Before adding ad-hoc `log()` calls to crew,
supply, goal or planner code, use its category bucket and stable reason fields. Events must remain plain data—never
store a `LuaEntity`—because telemetry, saves and host-side diagnosis all consume the same record.

## Choose the lowest valid layer

- A fact about recipes, entities or module geometry belongs in `modules/`.
- A decision about physical placement or belt/pole routing belongs in `planner/` and should be T1-testable.
- A dependency or unit of crew work belongs in `jobs/`; the Job Board itself stays free of Factorio globals.
- Walking, mining, crafting and placement mechanics belong in `character/`.
- Which factory capability to build next belongs in `strategy/`; it should not duplicate placement logic.
- Reading `game`, `defines`, `settings`, `remote` or mutable `storage` is an adapter responsibility. Keep decision
  functions pure when possible so failures can become T1 fixtures.

## Persistent-state warning

Factorio saves retain `storage` across code changes. Storage interfaces are augmented from several modules. A new
persistent field therefore needs a deterministic default, save/reload consideration, and usually an optional read
until a migration boundary exists. Never retain a `LuaEntity` without checking `.valid` on later use.

Diagnostic history is optional compatible state and is retained independently per category. A noisy crew-planning
stream therefore cannot evict the last planner failure; new categories need their own explicit bucket.

The migration boundary now lives in `storage-schema.ts`. **Before adding or changing a persisted field**, decide
whether old saves can use an optional/defaulted read or need the next numbered migration. Never edit an old migration
after release; append one version step and add a pure regression. A save from a newer schema fails closed.

## High-risk coordinators

`strategy/factory.ts`, `strategy/bootstrap.ts` and `jobs/crew.ts` currently coordinate several responsibilities.
Before adding another branch to them, ask whether the decision can be a pure helper in a focused module. Avoid a
reverse import into a coordinator: Lua `require` cycles fail at load time, and TSTL creates one main-chunk local per
top-level declaration/import. `tools/build-mod.mjs` guards at 185 because Lua fails at 200. A single new named import
can push a coordinator over the guard: import the module as a namespace, or re-export the helper through a module the
coordinator already imports, instead of adding a local.

Factory goal lifecycle rules live in the pure `strategy/goal-lifecycle.ts` boundary. Existing goals change status
only through `transitionGoal` in `strategy/factory.ts`; terminal goals cannot be reopened accidentally. Planner work
captures the base layout's monotonic revision and must be rejected at adoption if that revision has changed. Structural
layout mutations advance the revision, while `checkLayoutIndexes` verifies that canonical modules, routes and pole
lines still agree with their derived occupancy indexes. Old saves and captures without a revision read as revision 0.
`planner/plan-delta.ts` is the pure boundary for a completed plan: it checks the revision and indexes and derives the
ordered physical additions/removals plus the plan's logical evidence (routes per connection, pole lines), claim
evidence (the ground the plan takes, new whole-patch mine claims) and completed-mine evidence (the entities a built
mine the plan completed adds) before `strategy/factory.ts` changes persistent state or creates Factorio work. The
adapter consumes that prepared evidence instead of re-deriving it from the layout; its phase order is documented on
`adoptPlan`, and every persistent or engine effect happens after validation.
`strategy/adoption-intent.ts` is the pure vocabulary for a persisted adoption record (`FactoryState.adoption`): the
phase name and the resume/stale decision. `strategy/adoption-runtime.ts` writes the diagnostics and the idempotency
helpers; `factory.ts` advances the record and clears it at the commit point (the goal becoming `building`). Adoption is
safe to repeat: graph additions replace by id, evictions and reservations are idempotent, `entry.build` is reused and
completed-mine entities are deduped, so a Lua error part-way resumes on the next tick instead of double-applying.
`world/claim-index.ts` is the typed owner/kind boundary for a faction's world claims: `BrainState.reserved` gains a
paired `reservedBy` tag (`site:`, `module:`, `route:`, `pole:`, `mine:`) maintained by `syncWorldClaims`, and
`factoryDiagnostics` reports tagged reservations whose owner is gone or whose tag is one-sided. Ore fields use the same
module's typed helpers. Old saves have no `reservedBy`; their untagged tiles stay compatible and are not reported.
`planner/claims.ts` is the typed read/check/write boundary for spatial ownership. Router, power and placement policy
ask it for conflicts instead of interpreting the raw occupancy tables independently, while `checkClaimOwners` rejects
orphaned occupancy, reservation, mine and soft-growth claims before a plan is adopted. Its paired add/remove helpers
own the tag spelling (from the leaf `planner/claim-tags.ts`) and make every removal conditional on the caller still
owning the claim, so a stale cleanup cannot free another owner's tile. The underlying indexes remain separate because
they have different persistence and cost semantics. A tile may carry both a mine and a soft claim only when both name
the same module (a mine's own growth area): `claimMineTile` releases another owner's stale soft claim and
`claimSoftTile` refuses another owner's mine ground, so the rule holds at the write boundary; `checkClaimOwners`
still reports a persisted disagreement.
`shared/ids.ts` declares the branded identifiers for values that cross layers. A brand is erased at runtime, so saves
and Lua comparisons keep their old shape. `GoalId` is migrated end to end (`FactoryGoal.id`, the goal lifecycle, the
adoption record and diagnostic events); module, route, pole-line, job and claim brands are declared for the same
incremental migration. Construct at the owner and read old saves through the constructor; do not cast at use sites.
Stable outcome codes stay separate from prose: `DiagnosticDecision` types every telemetry decision
(`adoption-resumed`, `stale-plan-rejected`, …) and `PlanDeltaRejectionCode` names the plan-delta rejections, with the
human explanation in `reason`/`detail`. `mod/unit/model-sequences.test.ts` chains the boundaries in the order the
runtime meets them (plan → interleaving → replan, adopt → abandon → replan, claims → abandon → reclaim) and asserts
revision, indexes, claims and prepared evidence after each step.

## Completion checklist for architectural changes

- The owner of each new state field and transition is clear.
- Deterministic ordering is explicit.
- A pure regression covers the decision when the engine itself is not under test.
- A T2 test covers any claimed Factorio behaviour.
- Telemetry explains the new blocked/waiting state with a stable reason, not only prose.
- The relevant learned-rule document is updated when a new boundary surprise was found.

Run `npm run check:architecture` when changing `Config`, setting names/definitions, or a module marked pure. It is
also part of `npm run typecheck`, specifically because these three-way drifts otherwise survive code review and fail
only when Factorio loads the mod.
