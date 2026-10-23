# Provider-group implementation handoff

Date: 2026-10-23 (late)
Branch: `m6-v1`
HEAD at handoff: `35cf352 feat: split infeasible shared providers per consumer` (plus the working-tree changes listed below)
No push, no PR. This is a WIP handoff, not an acceptance claim.

Read first: `AGENTS.md`, `docs/agent/README.md`, the TSTL/Factorio gotchas in `CLAUDE.md`, and
`docs/analysis/provider-groups-refactor.md`.

## Goal

Finish the provider/supplier refactor in M6 (the user explicitly reversed an earlier “defer to M7” decision):

- existing providers keep serving what they can;
- unmet demand gets parallel providers or merged inputs;
- every consumer assignment is route-feasible;
- no provider is deconstructed before a replacement is connected.

B60/B61 are the tracked failures. B61 now passes its target seed; B60 still fails on a later shared provider.

## What is already committed

- `acce7fb` — pure provider assignment model and refactor goalposts.
- `8a06148` — provider-group parallel supplies and merge side-loads.
  - `providerShort`, design split at real capacity, merge side-load router support, power-grow wait.
  - removed `Growth.replace`.
- `35cf352` — split infeasible shared providers per consumer.
  - `providerSplit`, one parallel provider per consumer after a failed shared plan.
- `fe97e01` — earlier docs commit that briefly said “defer to M7”. **The working tree removes that deferral**
  (D64/M7 row removed again); do not reintroduce it.

Space Age/harness work is committed separately in `4a45313`.

## Current uncommitted changes (important)

```text
M docs/BUGS.md
M docs/SPEC.md
M docs/analysis/provider-groups-refactor.md
M docs/reports/M6-report.md
M mod/src/strategy/design.ts
M mod/src/strategy/factory.ts
M mod/src/strategy/fuel.ts
M mod/src/strategy/stage.ts
M mod/unit/design.test.ts
```

They contain:

1. **`providerNoTap`** (`FactoryState.providerNoTap`): exact failed feed key
   `providerRole=>consumerRole.toPort`. `stage.sharing` exposes both
   `item@consumer@toPort` and the older `item@consumer`; the exact key is omitted for a failed feed.
   `design.expandShared` looks up the exact key first.
   `factory.updatePlanning` marks this for failed feeds from an already-built provider and forces a replan;
   the provider keeps serving its other consumers.
2. **`parallelRole` suffix fix**: splitting a role such as `coal*>...labs#3` used to produce `#3` again
   because the base role’s next free suffix collided with the original role. It now treats the original role as
   used. T1 regression: “splitting a cluster-suffixed role does not reuse that role”.
3. Docs: B61 marked fixed, B60 updated, M6 report/analysis updated, M7 deferral removed.
4. Temporary debug log in `factory.designNow`:
   `design split ... -> coal*>...` (remove before final acceptance).

## Last validated results

- `npm run typecheck`: pass after the latest `providerNoTap` + `parallelRole` changes.
- Full T1: **31/31 files** before the final `parallelRole` suffix test; the new targeted B61 design tests pass.
  Run full T1 again after the working tree is finalized.
- Build pass before the current `m6-b60k-debug` run.
- T2 has **not** been rerun since these provider changes. Earlier T2 was 151/151 on the prior slice.
- `m6-b60g-provider` (2 seeds):
  - seed **2229258 PASS**, v1-done **185.2 game-min**, 0 stalls. B61’s shared-coal/mall route failure is gone.
  - seed **8646103 FAIL** at ~128 game-min: power split/merge worked, but shared provider
    `coal*>iron-plate*>logistic-science-pack>labs#3` could not reach both consumers from one site.
- `m6-b60h-provider`: same result (2229258 pass, 8646103 fail at ~127).
- `m6-b60i-provider`: aborted after showing the design was not actually splitting the cluster-suffixed role.
  The `parallelRole` fix addresses that.
- `m6-b60k-debug` (single seed 8646103, **currently running** at handoff): last observed tick 320400 (~89 game-min),
  no final result yet. It was built with the `parallelRole` fix but before the `providerNoTap` working-tree commit.

## Likely next failure to inspect

If 8646103 still fails around 128 game-min, inspect the `design split ...` debug line and the failed-plan graph:

```bash
grep -n "design split\|cannot reach every consumer\|not tapped again\|goal g" \
  out/soak/m6-b60k-debug/seed-8646103/factorio-stdout.log | tail -40
```

The expected split output is a fresh role such as `...#4`/`...#5`, **not** the old `...#3`. If the old role
reappears, `providerSplit`/`parallelRole` is still wrong.

If the failure moves to a built provider feeding a new consumer, `providerNoTap` should remove only that exact
feed from `sharing.keep`; the next design should create a separate provider for that consumer while the old provider
keeps its existing consumers.

## Commands to resume

```bash
cd /home/louis/Documents/factorio-ai-mod
npm run typecheck
npm run test:unit
npm run build

# targeted two-seed gate (about 10–15 min wall with -j 2)
python3 tools/harness/soak.py -c tools/harness/m6-random20.toml \
  --seeds 8646103,2229258 -j 2 --name m6-b60l-provider
```

If a run is stuck or superseded:

```bash
pkill -f m6-b60k-debug
# verify no stale factorio remains
ps -o pid,etime,pcpu,cmd -C factorio
```

Inspect a finished run with:

```bash
tail -60 out/soak/m6-b60l-provider.log
head -40 out/soak/m6-b60l-provider/scorecard.md
```

## What remains after B60 passes

1. Remove the temporary `design split` log.
2. Full T1 and full T2 on the final tree.
3. B61 already passes 2229258, but rerun it in the final two-seed gate.
4. The rest of the provider-group scope:
   - verify/replace handover for depleted providers (D55/P36 still deconstructs before a replacement is connected);
   - splitter/tap/trunk augmentation beyond side-load merge;
   - provider-group reconciler remedies for every shared trunk;
   - route-aware placement/reassignment for existing providers, not only new groups.
5. Full M6 acceptance: fixed 10 + random 20, two factions, Space Age smoke, determinism, timelapses, exact-commit
   validation, then report/PR. Do not claim acceptance from the targeted runs.

## Current gate

- **B60: open.** Needs seed 8646103 to reach v1-done.
- **B61: fixed** on `m6-b60g/h` (seed 2229258 v1-done 185.2), pending final rerun.
- **Full refactor: not complete.** The current slice is providerShort capacity splitting, merge side-loads,
  providerSplit per consumer, and providerNoTap exact feed reassignment.
