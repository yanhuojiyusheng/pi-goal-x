# Pointer retention: restore gate teeth and expose the re-anchor window

Status: in progress

Branch: `feat/goal-pointer-per-turn` (from `3e1cb35`, 0.34.1)

Superseded direction: the original campaign kept one replaced pointer per request. The
operator's follow-up (2026-11-12) replaced that with an accumulating pointer under
`## Product behavior` below; the historical sections are kept as record.

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
  context line. Small and must be read last. Appended once per stop, never replaced.

Invariant: the policy block appears once, and at most `stateReanchorRequests` pointer
copies ride behind it. An identical retry adds nothing and stays byte-identical.

### Run boundary clarification (2026-11-12)

A model stop means the end of an agent run (`agent_end`), after its tool loop, not each provider request or Pi `turn_end`. Freeze the pointer throughout each run; on the next run's first request append one fresh pointer after the existing history. The initial run also receives a pointer. Count appended copies towards the 12-copy default window. A changed policy, unsafe or rewritten history, and completion still take precedence and can reset the retained blocks during a run. Request retries within a run do not append pointers.

### Appending the pointer instead of replacing it (2026-11-12; clarified above)

The operator's direction, after the GPT fixed-cache investigation: the pointer is
appended once per model stop, the copies accumulate, and after `stateReanchorRequests`
copies the policy block and every copy are cleared and re-inserted at the newest history
position. Replacing the pointer ends the reusable prefix at the policy block on every
request, so the history accumulated after that anchor — model output and tool results —
is re-read with each stop. Appending keeps that history inside the shared prefix.

Consequences that the implementation must honour:

| Case | Behavior |
| --- | --- |
| First request of a new agent run | One copy appended at the tail; earlier copies stay in place |
| Identical retry | Nothing appended; the request stays byte-identical |
| Window full (`applies >= window`) | Policy block and all copies cleared, both re-inserted at the current tail |
| Policy text changed | Same reset; the new policy block anchors at the current tail |
| History rewritten, anchor unsafe | Same reset |
| `window === 0` | Never reset; copies accumulate for the whole session |
| Goal completes | A `[PI GOAL COMPLETE …]` state block keeps the completed goal visible and is re-anchored at the tail instead of the block disappearing |

The window counts appended copies, not requests. Once it contains `window` copies, the next append resets it and becomes the first copy of the new window.

### Re-anchor window becomes a setting

`stateReanchorRequests` (project/global settings, `.pi/pi-goal-x-settings.json`):

| Value | Behavior |
| --- | --- |
| absent | 12 appended pointer copies |
| `n >= 1` | re-anchor the policy block after `n` appended copies |
| `0` | never re-anchor; every copy stays for the session |

`0` is a deliberate cache-first choice: the policy block never moves, so nothing between
an old anchor and the tail is ever re-billed. It trades locality of instructions for a
strict cache prefix. Non-integer or negative values are rejected with the usual settings
diagnostic and fall back to the layer below (default 12).

The window advances at the first request of each agent run, including when the fresh pointer text is unchanged. Requests within the run do not advance it.

## Scope

| Item | Disposition |
| --- | --- |
| P1.1 window test is vacuous (`tests/goal-live-retention.test.ts`) | Fix the test: history must grow so anchor positions can move |
| P1.2 retention bounds still `<=32` blocks / `<=4096` bytes | Bound to the window plus one instead of a fixed `2` |
| P1.3 `breaks` mixes pointer replacement with policy re-anchor | Split into `pointerReplacements` and `policyAnchorMoves`; bound only the latter |
| P1.4 SDK worker asserts `<=31` counter copies | Assert exactly `1` live pointer |
| P3.1 `Then: none — this is the last pending task` can be false | Judge from the pending list, not from order-after |
| P3.2 task id truncated inside the `update_goal_task` example | Never excerpt ids; keep excerpting titles and contracts |
| P3.3 usage docstring overclaims per-request change | State that it holds once the goal has spent |
| P3.4 gate approves pointer body without checking it | Validate `Now`/`Done when`/`Then`/`Progress` prefixes; add a current-task fixture or justify its absence |
| P3.5 three `splitsToolBatch` wire shapes lost their tests | Restore `toolResult`, `tool`, `tool_result` cases |
| P3.6 gate docstring overclaims field-by-field approval | Correct the claim to match the checks |
| Process: no spec, empty changelog, stale baseline label | This directory, `CHANGELOG.md` `[Unreleased]`, relabelled baseline |
| Window 24 moved the policy block too often in long agentic turns | Default raised to 128, then superseded by the appending window of 12 |

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
