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
| M5a planner + power | `m5-power-planner` → m4 | none yet | **done**, pushed (18ca1fd + report 39e257c) |
| M5b | same branch | opens PR m5 → m4 | **next** |

Leftover branches already merged into m4: `m4-parallel-tests`, `review-live` (can be deleted). `proto/module-sourcing`
is findings only.

## M5a result (docs/reports/M5-report.md)

- Acceptance on the final code (18ca1fd, `out/soak/m5-final3`): automated red science feeding labs with research
  progressing on **5/5 seeds** (bar ≥ 4/5): 11: 27.2, 222: 29.9, 3333: 43.7, 44444: 32.2, 555555: 40.7 game-min,
  no stalls. M3 soak still 5/5 (6.6–9.4 min). Full T2 78/78 locally on 39e257c. CI green.
- History: the first M5a agent's last commit tested 3/5 on re-run (222 routing deadlock before undergrounds, 3333 rock
  under an outpost). A second agent fixed both plus seed 77 (crew mined belts over ore), each with a regression test.
  Lesson: **always re-run acceptance on the final commit** before accepting a milestone.
- An earlier 10-seed round passed 9/10. The 5 extra seeds were not re-run on the final commit. Seed 7777 is slow
  (power + labs 37.9 min): worth a look in M5b/M6.
- CPU: ~0.1–0.2 ms/tick per faction outside plans, ~1 ms/tick while the layout planner runs (budget 100). For D13's
  2 factions × 2 crew: ~0.75 ms/tick average, ~1.5 ms worst minute (2 ms target). A shared planner budget across
  factions is not done.
- Proposals P9–P16 in SPEC §11, all **proposed** (not approved). P16: when a production/mall plan fails every attempt
  without undergrounds, `logistics` becomes a prerequisite (hand-fed packs); alternative is always researching it first.
- Earlier proposals P9–P15: crew craft triggers emulated, hand-fed research only
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
- The two M5a questions above, plus P16 (fallback vs always research `logistics` before production).

## Practical notes

- `npm test` runs T2 in 8 parallel shards (~155 s); `npm run test:serial` for one game. Re-save timings after
  test changes: `npm test -- --save-timings`.
- Performance numbers only from `-j 1` runs (concurrent instances halve speed on this laptop).
- M5 acceptance: `python3 tools/harness/soak.py -c tools/harness/m5.toml -j 5` then
  `python3 tools/harness/m5_scorecard.py out/soak/<name>` (prints failure reasons). `-j 5` beats `-j 10` by ~30%.
- **Fast debug loop** (README → Development, M5 report "Test workflow"): soaks fail fast on stalls, plan-failure
  streaks and stuck ghosts; `--snapshots N` saves during the run and `--from-save` resumes one with the current build
  (a fix is checked in 16 s–2.5 min); `--helper-lua tools/harness/probes/status.lua` injects debug probes; each failed
  plan dumps a graph plus a Lua input that `plan-replay.test.ts` replays in ~10 s. Briefs should require this loop,
  not "fix → 20-min soak → repeat" (the user complained about that).
- Wall times in the M5 report are inflated: the laptop ran on battery (~1 GHz) for much of the session.
- Side-branch merges into the stack were done in a temporary worktree in the scratchpad, then removed.
- Memory files for this project live in `~/.claude/projects/-home-louis-Documents-factorio-ai-mod/memory/`.
