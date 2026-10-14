# Rival Engineers

Factorio 2.0 mod: AI factions whose physical character crews build factories like players do.

**`docs/SPEC.md` is the source of truth.** Read it before starting work. §2 decisions are settled, §8 lists
the milestones, and §9 is the operating model (stacked PRs, `proto/*` branches, non-blocking questions).

## Working rules

- Work milestone by milestone on `mN-<slug>` branches, stacked on the previous milestone branch. One PR per
  milestone, with a report at `docs/reports/MN-report.md`.
- Throwaway experiments go on `proto/<topic>` branches. No PRs for them.
- Never touch the user's `~/.factorio` (saves, mods, blueprint storage) in place. Copy inputs into
  `tools/modules/input/` first. Test runs use the isolated install under `.factorio-test/` (git-ignored).
- Determinism rules in SPEC §5.6 are hard constraints. All persistent state goes in `storage`, use no
  `math.random`, and check `.valid` before using an entity.
- Prefer configurable settings over constants (SPEC §5.7).

## Commands

See `README.md` → Development. (Kept there so it stays next to the scripts it describes.)
