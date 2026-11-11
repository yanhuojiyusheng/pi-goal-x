# Pointer retention: restore gate teeth and expose the re-anchor window

Status: in progress

Branch: `feat/long-goal-drift-guards` (10 commits ahead of `main` at `b0fc15e`, 0.34.1; 21 files, +680/−357)

## Approved update: one compact active block (2026-11-11)

This update supersedes the shorter-pointer experiment and historical split-block design below.
Keep one request-only block at the tail. Its FIRST `[PI GOAL ACTIVE ...]` header carries
the full actionable task id and cumulative time/tokens; remove the final NOW header.
Explain that usage is cumulative rather than context occupancy and that this state
supersedes earlier snapshots.

In regular automatic mode, show the approved six RULES: automatic continuation without
a scheduling declaration and without opting into waits; audited completion; the same
blocker recurring on three consecutive turns; immediate pause and user controls;
immutable objective; direct work plus retrieval of omitted/changed/compacted requirements.
Omit running status, regular mode and unlimited limits. Show finite limits, disabled
continuation, Sisyphus discipline, strict scheduling, waits and context usage only when
applicable. Preserve auditor rejection and post-compaction reminders.

Replace the default bounded pending list with current actionable task + its contract,
necessary ancestor contracts, and the next actionable pending task's title only. Keep
ids intact and excerpts bounded with retrieval hints; explicitly require retrieving
omitted details/contracts before starting. Report complete/total/skipped and omitted
pending entry counts accurately, retaining the task completion gate. Preserve the
legacy task-list profile and tiny persisted checkpoint marker.

No new dependencies or README changes. Prompt size reduction is not a provider billing
claim. Cache comparison must approve only exact reviewed text changes while retaining
history, provider options, tools and marker checks.

## Experiment: remove the three task summary lines

On `experiment/merged-live-block`, when a task is current, remove the pointer's
`Now:`, `Then:`, and `Progress:` lines. Keep its goal/task/usage header, optional
run and context information, and the existing guidance for cases with no current
or no task list. The state section still shows the focused task, pending task
excerpts and progress. It can name a parent rather than its open child, and its
bounded list does not always show the next task; this experiment accepts those
visibility limits without changing the task-list layout. The sections below record
the original split-block feature design, not the experimental retention layout.

## Why

The branch replaces the accumulated `Goal snapshot:` counter tails with one replaced
pointer block. The product change is sound: the policy block stays anchored, the pointer
is small and always last, and no snapshot ever accumulates.

A review of the branch against `main` found that the behavior change shipped with
verification that no longer has teeth. Four assertions became tautologies, so the very
invariants this refactor is supposed to protect — "the pointer is never accumulated",
"the policy block is re-anchored once per window" — can regress without any gate turning
red. Six smaller prompt-text and coverage defects were found in the same review.

This campaign fixes the verification first, then makes the re-anchor window an explicit
user setting, without relaxing any existing exact-string comparison in the cache gate.

## Product behavior

### Two request-only blocks

Active requests carry two request-only blocks, never persisted into the session:

- **Policy block** — objective, lifecycle rules, task tree, limits. Large and stable.
  Retained verbatim at a verified history anchor.
- **Pointer block** — `[PI GOAL NOW …]`: the open step (id and title), the step's
  completion contract, the next pending step, progress, usage header, and the optional
  context line. Small and must be read last. Replaced every request, never accumulated.

Invariant: at most **two** live blocks ride on any request — one policy block and at most
one pointer. An identical retry adds nothing and stays byte-identical.

### Re-anchor window becomes a setting

`stateReanchorRequests` (project/global settings, `.pi/pi-goal-x-settings.json`):

| Value | Behavior |
| --- | --- |
| absent | 128 requests of fresh content, i.e. the current behavior |
| `n >= 1` | re-anchor the policy block after `n` requests that carry fresh content |
| `0` | never re-anchor; the policy block stays at the anchor where it was first placed |

`0` is a deliberate cache-first choice: the policy block never moves, so nothing between
an old anchor and the tail is ever re-billed. It trades locality of instructions for a
strict cache prefix. Non-integer or negative values are rejected with the usual settings
diagnostic and fall back to the layer below (default 128).

The window only advances on requests whose content actually changed. An identical retry
never advances it, so a retry stays warm.

## Scope

| Item | Disposition |
| --- | --- |
| P1.1 window test is vacuous (`tests/goal-live-retention.test.ts`) | Fix the test: history must grow so anchor positions can move |
| P1.2 retention bounds still `<=32` blocks / `<=4096` bytes | Tighten to `2` in the report, compare and retention checks |
| P1.3 `breaks` mixes pointer replacement with policy re-anchor | Split into `pointerReplacements` and `policyAnchorMoves`; bound only the latter |
| P1.4 SDK worker asserts `<=31` counter copies | Assert exactly `1` live pointer |
| P3.1 `Then: none — this is the last pending task` can be false | Judge from the pending list, not from order-after |
| P3.2 task id truncated inside the `update_goal_task` example | Never excerpt ids; keep excerpting titles and contracts |
| P3.3 usage docstring overclaims per-request change | State that it holds once the goal has spent |
| P3.4 gate approves pointer body without checking it | Validate `Now`/`Done when`/`Then`/`Progress` prefixes; add a current-task fixture or justify its absence |
| P3.5 three `splitsToolBatch` wire shapes lost their tests | Restore `toolResult`, `tool`, `tool_result` cases |
| P3.6 gate docstring overclaims field-by-field approval | Correct the claim to match the checks |
| Process: no spec, empty changelog, stale baseline label | This directory, `CHANGELOG.md` `[Unreleased]`, relabelled baseline |
| Window 24 moved the policy block too often in long agentic turns | Default raised to 128 (see `TECH.md` §Scope boundaries and `MILESTONES.md`) |

## Out of scope

- Removing the window.
- Live provider hit-rate measurement or a new cost study. The gate reports anchor moves
  because they are the quantity the window controls, not as a cost claim.
- Reintroducing accumulated snapshots, or persisting the pointer into the session.
- `README.md` changes. AGENTS.md restricts it to the existing overview sections.

## Constraints

- Default behavior (no setting) must stay byte-identical to the current branch.
- No new dependencies.
- The cache gate keeps its exact string comparison and its explicit approved-delta list;
  a new allowance must be a named, reviewed delta, never a loosened comparison.
- Type checking cannot run on this workstation (`@typescript/typescript-linux-x64` fails
  to resolve from the global npm install). The campaign must say so instead of claiming a
  passing type check, and must rely on `node --experimental-strip-types` suites.
- AGENTS.md ordering: this file, then `TECH.md`, then implementation, tests and
  `MILESTONES.md`.

## Verification contract

- `npm test` — zero failures.
- `npm run lint` — clean.
- `npm run context:gate` — PASS.
- `npm run context:cache-gate` — PASS, with the new anchor-move bound enforced.
- Mutation evidence for each restored assertion: revert one production behavior locally,
  confirm the intended assertion fails, restore, and record it in `MILESTONES.md`.
