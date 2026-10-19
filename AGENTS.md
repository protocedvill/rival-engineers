# Rival Engineers: stop before editing

This is not an ordinary TypeScript project. TypeScript is transpiled to Lua and runs inside Factorio, whose
pathfinder, entity selection, ghosts, inventories, saves and test harness have behaviours that are not apparent from
the source. The project has already lost many hours by rediscovering them.

**Do not start from a code search alone. Before editing, read the routed documents below.** “The code is clear” is
not a substitute: most of the traps are properties of Factorio or TSTL, not properties of this repository.

## Mandatory first five minutes

1. Run `npm run status`. It reports the real branch, commit, dirty state, open bugs and current milestone without a
   hand-maintained handoff document.
2. Read [`docs/agent/README.md`](docs/agent/README.md). Its table tells you which short guide is mandatory for the
   files and behaviour you will touch.
3. Read the relevant part of [`docs/SPEC.md`](docs/SPEC.md): §2 decisions are settled, §5 is architecture, §8 is
   milestones, §9 is the operating model, and §11 contains proposals that are **not approved**.
4. For a bug, read its complete row in [`docs/BUGS.md`](docs/BUGS.md), including prior diagnoses and required tests.
5. Run `npm run doctor` before a test or soak. It catches stale builds, missing runtimes, locks and already-running
   Factorio processes that otherwise create misleading results.

## Read-before-touch routing

- **Any `.ts` change, build error, callback, optional value, or unit test:** read the “TSTL gotchas” section of
  [`CLAUDE.md`](CLAUDE.md). It includes silent semantic differences such as shared loop variables, shifted callback
  arguments and object spreads that fail to clear fields.
- **Character movement, mining, placement, ghosts, paths, inventories, inserters, belts, terrain, saves, or runtime
  tests:** read the “Factorio engine gotchas” section of [`CLAUDE.md`](CLAUDE.md). These are observed engine facts;
  guessing from normal game intuition has repeatedly produced regressions.
- **Tests, a failed shard, a soak, snapshots, or performance:** read
  [`docs/agent/testing-and-soaks.md`](docs/agent/testing-and-soaks.md) before running anything expensive.
- **Strategy, planner, jobs, storage, or a new subsystem:** read
  [`docs/agent/architecture.md`](docs/agent/architecture.md) before choosing where the change belongs.
- **Branching, decisions, reports, constants, or user approval:** read
  [`docs/agent/operating-model.md`](docs/agent/operating-model.md).

If you discover a new Factorio or TSTL surprise, the fix is incomplete until the learned rule is added to the
appropriate guide and pinned by the cheapest useful regression test.

## Non-negotiable rules

- Never read or write the user's `~/.factorio` in place. Tests use `.factorio-test/`; live review uses
  `.factorio-review/`. Copy explicit inputs into the repository first.
- Preserve determinism: persistent state lives in `storage`, iteration order is deliberate, no `math.random`, and
  every retained `LuaEntity` is checked with `.valid` before use.
- Do not mark a proposal as user-approved. Only an actual user decision can move it into SPEC §2; agent proposals
  remain explicitly proposed in §11.
- Surface every new tuning number to the user in the milestone report’s “Magic numbers for the user” table. Values
  derived from game prototypes or mechanics are exempt.
- Prefer a T1 pure regression. Use T2 only for Factorio semantics. Use a targeted snapshot/replay before a full soak.
- Generated `mod/build/` output is not source. Edit `mod/src/` and rebuild.
- In a git worktree, `node_modules` and `.factorio-test/factorio` are symlinks to the main checkout. Stage only your
  own files (no `git add -A` / `git add .`): a committed `node_modules` link once replaced the main checkout's real one.
- Subagents never run or wait on anything longer than about 5 minutes. The full `npm test` (about 10 min), soaks and
  benchmarks belong to the manager: run `npm run test:unit` and filtered T2, and hand back the command for the rest
  (SPEC §9).
- When a plan, placement or route misbehaves, read its dump (`REPLAY_DUMP=1`, or the failure dump in
  `out/replay-dumps/`) before running variants; sweep variants with `npm run replay:sweep`.

Commands live in [`README.md`](README.md). The short path is: `npm run typecheck`, `npm run test:unit -- [--no-build] [-t <test>] <file>`,
targeted `npm test -- "Lua pattern"`, then the relevant acceptance run only after cheap checks pass.
