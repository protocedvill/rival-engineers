# Operating model: decisions, branches and reports

Read this before creating a branch, changing a setting, introducing a threshold, editing SPEC, or reporting that a
milestone passed.

## Authority

- `docs/SPEC.md` is the source of truth. §2 decisions are settled. §11 entries are proposals, not approvals.
- Only the user can approve a proposal. An agent may recommend and record a proposal, explicitly marked proposed.
- `docs/BUGS.md` is the review backlog and often contains a longer diagnosis than the issue title. Read the whole row.
- `npm run status` replaces the old hand-maintained `docs/HANDOFF.md`; Git and the ledgers are authoritative.

## Branches and experiments

Milestones use stacked `mN-<slug>` branches and one report/PR per milestone. Throwaway experiments use
`proto/<topic>` and do not receive PRs. Worktree isolation is required for concurrent agents or validation. Never
commit another worktree’s unrelated changes.

## Magic numbers

Every introduced tuning value—distance, count, timeout, threshold, weight or margin—goes into the milestone report’s
“Magic numbers for the user” table with its location, value, rationale and whether it is configurable. Guesses are
allowed during development but remain visible for a user decision. Values obtained directly from Factorio prototypes,
recipes or engine limits are exempt.

## Evidence and handoff

- Acceptance is run on the stated final code commit, not a nearby commit.
- Report targeted tests, full suite and soaks separately, including seeds and rounds.
- Say when a result is partial, concurrent, resumed from a snapshot, or measured on a dirty tree.
- Preserve regression fixtures and explain the root cause, not only the changed line.
- Leave pending decisions in SPEC §11 and the report; do not silently choose product behaviour.
