# Milestones

## 2026-11-25

- Started from `main` `073277b` (0.35.1) on `feat/single-block-on-new-main`
  rather than rebasing `dev`: `dev` is 35 commits ahead of the merge base and
  `main` is 45, and the merge has 20 conflicting files including a
  modify/delete on the old `extensions/goal-settings.ts` (now split into
  `extensions/settings/`). Rewriting the design onto `main` keeps #175, the
  five status branches and the settings split instead of re-resolving them.
- `goal-live-retention.ts` rewritten around one `RetainedBlock`
  (`anchorIndex`, `anchorSnapshot`, `state`, `taskId`, `scope`). Deleted
  `MAX_RETAINED_LIVE_TAILS`, `MAX_RETAINED_POLICY_BLOCKS`,
  `MAX_RETAINED_COUNTER_BYTES`, `POLICY_SUPERSEDED_NOTE` and
  `POLICY_RECENCY_NOTE`: with one block there is nothing to supersede and
  nothing to cap. Kept `Snapshot` / `LongString` / `splitsToolBatch` from #175.
- `stableLength` now equals `messages.length` because the block is always last.
  The whole request is reusable prefix; the old value let the marker relocation
  skip the trailing counters.
- Scope had to carry more than the goal identity. Two bugs found by tests:
  - A paused or blocked state did not re-anchor, because `goalScope(goal)` is
    the same for every lifecycle state of one goal. Fixed by prefixing the
    branch tag (`paused:`, `blocked:`, `budget:`).
  - The one-time `[TOKEN BUDGET REACHED]` reminder stayed pinned for the rest of
    the run, because consuming it did not change the block. Fixed by putting the
    reminder into the scope and setting `reanchor`, so the request after it
    replaces the block instead of repeating the note.
- `agent_end` clears the retained block. Without it a run boundary kept the
  previous run's snapshot in front of the model. `before_agent_start` clears
  continuation state for the same reason; the two now agree.
- `taskListBlock` was lost when the prompt splitter was rewritten; three
  `goal-prompts` tests caught it. It belongs in `buildGoalPrompt`, not in
  `goalPromptParts`: the cache key already covers the task index, the
  completion toggle and `currentTaskId`, so a task change rebuilds the policy
  text rather than emitting a second message.
- `tests/goal-widget.test.ts` shows 5 failures on a clean `main` worktree too.
  Cause is not code: the git-ignored `.pi/pi-goal-x-settings.json` remaps
  `keybindings.dashboard.toggleExpand` to `ctrl+alt+d`, and the tests assert the
  default `ctrl+shift+t`. Every suite run below moved that file aside first.
- `experiment harness shell tests pass` fails on untouched `main` as well
  (`bash tests/shell/harness.test.sh`: `FAIL - supported case id resolves`).
  Pre-existing, not touched here.

### Cost, measured not asserted

`experiments/prompt-cache/simulate.ts`, `run(splitStrategy())` against
`run(productionStrategy())`, seed 7, 128-token blocks, cache reads at 1/10 the
input price. `sent` is every character written to the wire; `uncached` is what
the provider does not read from cache; `cost` is the weighted total.

| scenario | cost (split → one block) | uncached | sent |
| --- | --- | --- | --- |
| steady 60 turns | 2,747,092 → 2,166,342 (−21.1%) | 183,393 → 279,980 | 25,820,385 → 19,143,596 |
| typical tasks+waits | 2,460,309 → 1,931,913 (−21.5%) | 174,165 → 263,382 | 23,035,605 → 16,948,694 |
| three pauses | 2,030,975 → 1,594,653 (−21.5%) | 156,837 → 236,074 | 18,898,213 → 13,821,866 |
| heavy tool output | 17,491,871 → 16,819,892 (−3.8%) | 756,972 → 1,384,359 | 168,105,964 → 155,739,687 |
| 150 turns | 8,299,783 → 5,514,428 (−33.6%) | 309,985 → 440,405 | 80,207,969 → 51,180,629 |

Reading: the one block writes 20–36% fewer characters, and pays for it with
roughly 50–80% more uncached input, because every run start re-anchors the block
and re-reads the tail behind it. At 1/10 cache pricing that still comes out
ahead. The reason is the split layout's real cost: every policy change and every
task snapshot is appended permanently, so the prefix the provider can reuse
grows monotonically and each append breaks it from that point on. The one block
never leaves a stale copy in history, so its prefix only breaks at run
boundaries — a constant, not a debt that accumulates with the number of turns.

`bigBreaks === 0` in all five scenarios. Boundary re-reads (characters paid at
each run start): 162,357 / 153,390 / 140,265 / 712,667 / 274,552.

The claim this supports is narrow: on this simulator, trading reuse for
unambiguous state does not cost money. It says nothing about live provider hit
rates, TTLs or routing.

### Validation

- `npx tsc --noEmit -p .` clean.
- `npm test`: 1300 pass, 1 fail (`experiment harness shell tests pass`,
  pre-existing on `main`).
- `npm run context:gate`: PASS over 24 fixtures after regenerating
  `experiments/context/baseline-main.json`.
- `npm run context:cache-gate`: PASS — `408 adapter scenarios; 408 exact
  approved display deltas; 1,000 bounded transitions`. Every scenario's delta is
  `single-request-only-goal-block`, sum −6,498 bytes, per scenario −223…+34,
  live blocks per request ∈ {0, 1}.

## Porting the `dev` design onto this branch

The user's decision (`"冲突的地方应该采用我的设计标准"`) settled conflicts in
favour of the `dev` design; the UI keeps `main`'s `Box` + `i18n` skeleton, and
`stateReanchorRequests` survives as a compatibility shell. `main`'s 9-commit
widgets rewrite between `111855c` and `main` turned out to be i18n, module
splits and a speed-up only — `0138f98` states "Rendered output is unchanged" and
no `fix`/`bug`/`crash` commit touches `extensions/widgets/`. So the bug `dev`
does fix is still unfixed on `main`: after a phase's children all complete, the
cursor never returns to the parent, the block says "no task is marked current",
and the model has no reason to call `update_goal_task(parent, status:"complete")`.

Landed:

- `extensions/prompts/goal-prompts.ts` carries the `dev` task cursor:
  `workUnits` (post-order, parent after its children), `awaitingWrapUp`,
  `taskCursor` (wraps back to an earlier ready phase with
  `wrapUpIndex >= 0 ? wrapUpIndex : currentIndex`), `derivedTaskCursor`,
  `focusedTask`, `actionableTask`, `taskAncestors`, `compactTaskList`. The
  single block is `[state, pointer]`: the header carries the derived
  `taskId=`, the pointer (`nextStepBlock`) carries "Now: …" and the usage line.
- `taskListBlock` uses `compactTaskList` unless `promptProfile() === "legacy-v1"`.
- `extensions/goal-context-parts.ts` joins `policy` + `pointer` into one block;
  `goal-dashboard-model.deriveCurrentTask` and
  `goal-status.renderTaskTreeVerbose` both read `derivedTaskCursor`, so the
  dashboard highlight and the `▸` marker agree with the prompt.
- `stateReanchorRequests` accepted, persisted, listed in the settings menu as
  `state re-anchor window (retired)`, and has no runtime effect.

Verified cursor behaviour with a phase whose children are all complete and a
persisted focus on one of those children: the header renders `taskId=phase1`,
the task list renders `Current: phase1 · Phase one` with
`Next pending: p2a · Child C`, and the block closes with
`Now: no task is marked current.` / `Start with the first pending task: phase1`.
Before the port the same state produced a child id (or nothing) and no route to
the parent's completion.

Gate status after the port: `tsc` clean, `npm test` 1301 pass with only
`experiment harness shell tests pass` failing (reproduced on `main` `073277b`
via `bash tests/shell/harness.test.sh` → `FAIL - supported case id resolves`),
`context:gate` PASS over 24 fixtures after regenerating the baseline, and
`context:cache-gate` PASS. Two `dev`-only test files were kept
(`goal-phase-completion`, `goal-compact-prompt`); the other seven were dropped
because they target modules `main` removed or split
(`buildCompactionSummary`, `MAX_PROMPT_FRAGMENT_CHARS`, `tests/tui-test-utils.ts`,
`tests/stabilization-utils.ts`, `extensions/goal-settings.ts`) and porting them
would mean porting code this branch deliberately does not have.

Note for anyone running the suite: `.pi/pi-goal-x-settings.json` overrides
`keybindings.dashboard.toggleExpand` to `ctrl+alt+d`, which fails five
`tests/goal-widget.test.ts` cases. Move it aside before `npm test`.
