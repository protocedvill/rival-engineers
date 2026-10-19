# Read the expensive lesson before repeating it

Rival Engineers sits behind two abstraction boundaries an agent cannot infer reliably from the TypeScript alone:
TSTL changes some JavaScript semantics during transpilation, and Factorio exposes engine behaviour that often differs
from player intuition. This directory routes work to the smallest set of prior lessons that prevents a repeat.

## Which guide is mandatory?

| If your task touches… | Read before code | What skipping it has caused |
|---|---|---|
| Architecture, strategy, planner, jobs, storage | [`architecture.md`](architecture.md) | State split across the wrong layer, runtime-only logic that could not be replayed, and import cycles that break Lua loading. |
| Tests, shards, logs, snapshots, soak runs, performance | [`testing-and-soaks.md`](testing-and-soaks.md) | False test failures, state shared across separate games, stale builds, 20-minute reruns for bugs reproducible in seconds, and invalid concurrent performance numbers. |
| Branches, reports, proposals, settings, magic numbers | [`operating-model.md`](operating-model.md) | Stale handoffs, proposals recorded as decisions, changes on the wrong stacked branch, and unreviewed tuning constants. |
| Any TypeScript/TSTL code | [`CLAUDE.md`](../../CLAUDE.md), “TSTL gotchas” | Code that typechecks but shifts callback arguments, shares loop indices, retains supposedly-cleared fields, or exceeds Lua’s local limit. |
| Paths, mining, ghosts, entities, belts, inserters, terrain, saves, research triggers | [`CLAUDE.md`](../../CLAUDE.md), “Factorio engine gotchas” | The same engine bugs being rediscovered after long T2/soak runs. |

## The rule for new discoveries

A surprising engine behaviour is not merely a comment near one fix. Add it to the shared ledger, cite the regression
test that pins it, and link it from a subsystem guide if it applies to a common task. Future agents commonly begin
with code because that usually works; the headings and routing must therefore say **when the code is insufficient**.

## Before handing work off

- Run `npm run status` and `npm run doctor`.
- State the exact commit used for every acceptance result.
- Separate targeted tests, the full suite, and soaks in the report.
- Report partial or interrupted runs as partial; never infer missing seeds passed.
- List new tuning values and pending user decisions explicitly.
