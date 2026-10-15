# Handoff: Rival Engineers manager session (2026-10-15)

For a new Claude Code session that takes over as **manager** of this project. Read this first, then `CLAUDE.md`,
then `docs/SPEC.md` (§2 decisions, §8 milestones, §9 operating model, §11 open questions).

## What the project is

Factorio 2.0 mod (`rival-engineers`): AI factions whose physical character crews build factories with player parity.
Pure Lua brain (TSTL), no runtime LLM. v1 = red + green science, no biters, no steel/oil. Repo
`protocedvill/rival-engineers` (private). Spec = source of truth; milestone reports in `docs/reports/`.

## How the user wants to work

- Fully autonomous. The user checks in for progress reports and spec questions only. No handholding.
- The manager session **delegates milestone work to one subagent at a time** (self-contained brief: spec sections,
  branch, acceptance bar, report format, short summary as its return). Parallel only for clearly independent work,
  with worktree isolation. Don't spawn agents for small things; do them inline.
- **Usage matters.** If an agent stops on a usage limit, resume it with SendMessage after the reset rather than
  starting a new one. But if its context is huge and little work remains, finish the work inline instead (the user
  asked for exactly that at the end of M5a).
- PRs are stacked, one per milestone; experiments on `proto/*` with no PR.
- Config settings over constants.
- The user sometimes talks to subagents directly and approves things there. Those approvals are real. Agents must never
  mark their own proposals approved; proposals go to SPEC §11 as "proposed" (rule in `CLAUDE.md`).
- Never touch `~/.factorio` in place; tests use `.factorio-test/`, live review uses `.factorio-review/`. Never change
  Steam launch options.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (+ session line from the harness).

## State of the branches (all CI green, nothing merged to main)

| Milestone | Branch → base | PR | Status |
|---|---|---|---|
| M0 foundations, spike, renderer | `m0-foundations` → main | #1 | open |
| M1 character controller | `m1-body` → m0 | #2 | open |
| M2 crew + Job Board | `m2-crew-jobs` → m1 | #3 | open |
| M3 burner bootstrap | `m3-burner-bootstrap` → m2 | #4 | open |
| M4 modules + routing (+ parallel tests, live review merged in) | `m4-modules-routing` → m3 | #5 | open |
| M5a planner + power | `m5-power-planner` → m4 | none yet | **done**, pushed (4ebf208) |
| M5b | same branch | opens PR m5 → m4 | **next** |

Leftover branches already merged into m4: `m4-parallel-tests`, `review-live` (can be deleted). `proto/module-sourcing`
is findings only.

## M5a result (docs/reports/M5-report.md)

- Acceptance: automated red science feeding labs with research progressing on **5/5 seeds** (bar ≥ 4/5),
  25.8–45.8 game-min, no permanent stall. Full T2 suite passes; CI green.
- SOAK_RERUN_PLACEHOLDER
- CPU: ~0.1–0.2 ms/tick per faction outside plans, ~1 ms/tick while the layout planner runs (budget 100). For D13's
  2 factions × 2 crew: ~0.75 ms/tick average, ~1.5 ms worst minute (2 ms target). A shared planner budget across
  factions is not done.
- Proposals P9–P15 in SPEC §11, all **proposed** (not approved): crew craft triggers emulated, hand-fed research only
  for unblocking techs, stage-1 target 10 red/min, goal order, material supply via mall, the
  `automated-red-science` check, port approach tiles reserved.
- Questions for the user (non-blocking), from the report:
  1. Is 10 red/min fine as the stage-1 target (M6 adds 30 + 30)?
  2. Is hand-crafting the ~35 packs for `automation` + `electric-mining-drill` acceptable as player-like?

## Live review (user can run it now)

`npm run review` (flags `--factions N`, `--crew N`, `--space-age`, `--menu`, `--load NAME`, `--no-build`). Launches the
Steam Factorio into a sandbox scenario as spectator; inspector on Ctrl+Shift+I (speed, pause/step, per-faction goals,
per-crew time breakdown, overlays). It builds whatever the main checkout has checked out, which is now
`m5-power-planner` with the review setup merged in.

## Next: M5b (same branch, then open PR m5 → m4)

Scope (SPEC §5.8, §8 M5): measurement of planned vs measured rates per node/edge, reconciler classifying
ok / starved / backed-up / unpowered / unfuelled with upstream root cause and replanning goals, in-game graph overlay via
`registerOverlayLayer`, near-ore smelting LayoutPolicy option (D35, for M6 A/B). T2 tests: a deliberately starved module
is classified starved with the right upstream cause; a lab with an undersized belt. The M5 report's
"Interfaces for M5b" section lists exactly where everything plugs in. When done: add the M5b section to
`docs/reports/M5-report.md`, open the PR, report to the user.

After that: **M6 (v1)**: green science, all 42 D30 techs, multi-faction, seed sweeps (≥9/10 fixed, ≥18/20 random),
Space Age smoke test, A/B of layout policies, timelapses for the user's approval. v1 DoD is in SPEC §8/§10.

## Open questions still unanswered by the user

- Optional crew "think time" slowdown (bootstrap is faster than a human).
- Bootstrap drill counts are guesses (M5 sizes the factory, not the bootstrap).
- The two M5a questions above.

## Practical notes

- `npm test` runs T2 in 8 parallel shards (~155 s); `npm run test:serial` for one game. Re-save timings after
  test changes: `npm test -- --save-timings`.
- Performance numbers only from `-j 1` runs (concurrent instances halve speed on this laptop).
- M5 acceptance: `python3 tools/harness/soak.py -c tools/harness/m5.toml -j 5` then `tools/harness/m5_scorecard.py`.
- Side-branch merges into the stack were done in a temporary worktree in the scratchpad, then removed.
- Memory files for this project live in `~/.claude/projects/-home-louis-Documents-factorio-ai-mod/memory/`.
