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

## High-risk coordinators

`strategy/factory.ts`, `strategy/bootstrap.ts` and `jobs/crew.ts` currently coordinate several responsibilities.
Before adding another branch to them, ask whether the decision can be a pure helper in a focused module. Avoid a
reverse import into a coordinator: Lua `require` cycles fail at load time, and TSTL creates one main-chunk local per
top-level declaration/import. `tools/build-mod.mjs` guards at 185 because Lua fails at 200.

## Completion checklist for architectural changes

- The owner of each new state field and transition is clear.
- Deterministic ordering is explicit.
- A pure regression covers the decision when the engine itself is not under test.
- A T2 test covers any claimed Factorio behaviour.
- Telemetry explains the new blocked/waiting state with a stable reason, not only prose.
- The relevant learned-rule document is updated when a new boundary surprise was found.
