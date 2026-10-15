# Bug backlog (from the user's run reviews)

The manager batches these into agent tasks. Each fix gets a regression test; tick it off with the commit hash.

| # | Reported | Bug | Status |
|---|---|---|---|
| B1 | 2026-10-15 | Crew fail to mine trees about 70% of the time: they reach the tree at an odd angle and can't mine it, or stop mining too early. Build a **tree/rock mining arena** (T2) covering trees and rocks of every kind, approach angles, off-grid positions, clusters, trees over ore and next to buildings, measuring success rate and time per target. Fix until it is reliable. | open |
| B2 | 2026-10-15 | Splitters follow the D36 rule too: when a plan with splitters is n tiles shorter (setting) than one without, research them first instead of building excessively long belts. Goes with the D36 underground work in M5b. | open |
| B3 | 2026-10-15 | Batch nearby work instead of a round trip per item: when deconstructing an area, a crew member keeps taking nearby deconstruction jobs until the inventory is nearly full (or a limit is hit) before returning to the depot. Same for wood: take all open tree-mining / wood requests nearby in one trip, up to a limit. Limits (job count, radius, inventory fill) go in the magic-numbers table. Pairs with B1 (same mining code). | open |
| B4 | 2026-10-15 | Bootstrap mines run out of ore and runs die. When a bootstrap mining site depletes (or is about to), deconstruct it and build a new one on remaining ore (D28 exception, see SPEC). | open |
| B5 | 2026-10-15 | Modules get small **buffer depots** where it makes sense: e.g. the end of a furnace stack has an inserter into a chest that counts as a depot the crew can pull from. Agents choose which modules get one and list the choices in the report for the user to verify (D42). | open |
