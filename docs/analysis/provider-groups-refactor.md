# Provider groups and parallel supply refactor

Status: **implementation continues in M6** (user decision 2026-10-23: do not defer the rest). This document is the
handoff/goalpost record for the full refactor. The current slice covers built design providers with a known fixed
capacity, side-load merges, and one parallel provider per consumer when a new shared provider cannot reach all
consumers.

## Why

The current strategy treats a producer as a singleton role (`coal>power`, `coal*>iron-plate*>mall`, ...). That causes:

- **B60**: an unexpandable provider reports `cannot grow` forever; there is no second provider.
- **B61 / old seed 2229258**: a replacement provider can reach some consumers but not others; the whole goal fails,
  or a provider is deconstructed before a replacement exists.
- The same shape applies to every shared item: coal, ore, plates, fuel, power.

The user's correction is the rule:

> The existing provider keeps feeding the consumers it can satisfy. Add another input to the tap, or create a
> parallel stream, for the rest. Do not remove the existing provider just because it cannot grow.

## Goalposts

1. A provider is never deconstructed before a replacement can serve its obligations.
2. Existing assignments are preserved; a short provider keeps its capacity and its consumers.
3. Unmet demand is assigned to a new provider or a merged input.
4. Every consumer assignment is route-feasible; an unreachable consumer is split out, not allowed to fail the group.
5. The mechanism is generic for all shared providers, not a `coal>power` special case.
6. Normal point-to-point layouts, old saves and existing acceptance seeds keep working.
7. No storage migration; group state is derived from the design/graph/layout or stored in an optional additive field.

## Chosen topology (user answer)

Primary:

- **Merge splitter / merged input upstream of the existing tap or trunk.**
- The existing provider keeps its route.
- A second provider feeds the merged input.

Fallback:

- **Parallel stream**: a second provider gets the consumers it can reach on a separate route group.

Scope (user answer): **all shared providers**, with initial integration focused on fuel/power, coal/ore and
multi-consumer trunks.

## Data model

Add a pure strategy module, `strategy/providers.ts`:

```ts
interface ConsumerObligation {
  module: ModuleId
  port: string
  rate: number
  priority: number
}

interface ProviderState {
  node: ModuleId
  role: string
  item: string
  capacity: number
  assigned: number
  expandable: boolean
  fixed?: boolean
}

interface SupplyGroup {
  item: string
  purpose: string
  consumers: ConsumerObligation[]
  providers: ProviderState[]
  distribution: {
    kind: "direct" | "trunk-taps" | "merge" | "parallel"
    trunk?: RouteId
    merge?: { tap?: RouteId; target?: PortRef }
  }
}
```

Pure operations:

- `assignProviders(providers, consumers, priority)` -> assignments + residual;
- `splitConsumers(consumers, cap)` -> kept/moved lists;
- `chooseProviderAction(group)` -> `grow | add-provider | merge | parallel | handover | defer`;
- `unservedConsumers(...)` for diagnostics.

Tests must not touch Factorio globals.

## Design / diff integration

`design.ts` still creates one design node per role. The refactor adds a provider-group pass:

1. Group design nodes by `(item, purpose)`.
2. Group their outgoing edges by consumer port.
3. Compare aggregate provider capacity with consumer demand.
4. Preserve the current provider assignments first.
5. Emit actions:
   - `grow` if an existing provider has units;
   - `add-provider` for a residual consumer subset;
   - `merge` if the residual consumer is structurally one port/trunk;
   - `parallel` if separate consumer ports exist;
   - `handover` only after replacement is verified.
6. New provider roles need stable unique names, e.g. `coal*>mall#2`, `coal>power#2`.

`DesignDiff` should carry provider actions rather than overloading `Growth.replace`.

## Routing

### Merge into an existing tap/trunk

Add a merge route form to `RouteRequest` / the router:

- target: an existing route tile or tap input;
- provider: a second route;
- end mode: side-load or merge splitter;
- capacity: sum of provider rates;
- the existing route is not ripped.

The first implementation should use a splitter merge at a free tile adjacent to the existing tap/trunk if possible;
fall back to side-load if the policy/geometry permits. If neither is possible, use a parallel stream.

### Parallel stream

A provider goal is planned with only the consumers assigned to it. Placement rejects a site unless every assigned
consumer is reachable, or returns the unreachable set for re-splitting.

## Handover

Never call `relocate` merely because a provider is unexpandable.

```text
provider short
→ plan replacement/parallel group
→ connect and verify all consumers
→ only then deconstruct the old provider
```

If no replacement site exists:

- keep the old provider;
- report `provider short: no replacement site`;
- use hand-feeding / current supply as backup;
- do not drop the provider.

This must replace the current B60 `replace` behavior, which increments `growFails` and (earlier) relocated immediately.

## Reconciler

Add group-level remedies:

- provider short -> grow/add/merge/parallel;
- consumer input sealed -> relocate consumer (B61 path), independent of provider capacity;
- provider depleted -> handover;
- replacement route failure -> re-split consumers or choose another site.

## Debug/soak infinite research

Implemented separately:

- hidden infinite technology `rival-engineers-throughput-test`;
- red + green packs, no effects;
- setting `debugInfiniteResearch` (default false);
- selected only when the normal research queue is empty and the flag is on;
- excluded from the v1 research count and telemetry;
- `tools/harness/m6-throughput.toml` enables it for soak-only throughput tests.

## Implementation order

1. [done] Pure `providers.ts` with assignment/splitting tests.
2. [done] Remove `Growth.replace`; a short provider is fixed at its real capacity and stays in service.
3. [done, first slice] Add the parallel-provider design/diff action when `providerShort` is set.
4. [done, first slice] Merge side-load route support with candidate retry and T1 geometry coverage.
5. [in progress] Integrate verified handover and full route-aware placement for every shared trunk.
6. [in progress] Reconcile group remedies for every shared trunk, not just the power/fuel path.
7. [in progress] Rerun targeted B60/B61 seeds, then the full fixed/random core.

## Required tests

- T1 provider assignment: existing provider keeps its capacity; residual goes to a new provider.
- T1 no replacement site: old provider remains, shortfall reported.
- T1 multi-consumer split: one consumer moved to a parallel provider.
- T1 merge selection: tap/trunk merge preferred over parallel when feasible.
- T1 provider roles: distinct roles for multiple instances; stable ordering.
- T2 splitter merge/side-load behavior on a real surface.
- Plan replay for the `g22` mall plan.
- Targeted seeds: `8646103`, `2229258`.
- Throughput soak with `m6-throughput.toml`; verify 42 v1 techs and continuous packs.

## Current state / implementation

- `eaa451f`: power growth scheduling and pole-saturation fixes.
- `a63dc00`: B60 unexpandable-provider replacement (rejected; replaced by the provider-group split below).
- `5dd8b34`: B61 sealed-consumer fallback.
- `cd4ed2f`: debug infinite research + parallel power fallback.
- Current B60/B61 status: open; targeted acceptance is still being rerun.
- Implemented provider-group slice:
  - `FactoryState.providerShort` records built providers with no expansion unit.
  - `design.ts` keeps the old provider at its real capacity (`providerCaps`) and gives the residual to a stable
    parallel role (`#2`, `#3`, ...).
  - The residual edge carries `merge` when it shares a consumer port. `planner/plan.ts` chooses a free side of the
    existing route, preferring the one nearest the new producer, and retries the other candidates before giving up.
  - `planner/router.ts` side-loads into the existing belt without a blocker; `checkLayout` validates that the merge
    target is another route to the same consumer.
  - `goal-selection.ts` holds a parallel power provider while the steam-block growth is rerouting the same port.
  - `Growth.replace` was removed: an unexpandable provider is no longer represented as a replacement.
  - A new shared provider whose plan cannot route every consumer is marked `providerSplit`; the next design gives
    each consumer its own parallel provider (`#2`, `#3`, ...), so one infeasible site cannot hold the whole group.
  - A failed feed from a **built** provider is marked `providerNoTap` for that exact provider→consumer port; the
    design reassigns just that consumer instead of retrying the same tap while the provider keeps serving its other
    consumers.
  - T1: `design` provider split, shared-provider split, router merge, goal-selection power wait, and the existing
    provider-model tests.
- **Still in progress:** general provider-group actions for every shared trunk and topology, splitter/tap/trunk
  augmentation, transactional handover of depleted providers, full merge/split route variants, and reconciler group
  remedies. The current slice keeps the existing provider and adds a parallel one where the current side-load path
  works; a new shared provider that cannot reach all consumers is now split into one provider per consumer.
