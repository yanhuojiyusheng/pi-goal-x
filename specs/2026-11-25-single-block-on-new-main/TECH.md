# Tech: one request-only goal block on the 0.35.1 retention model

Branch `feat/single-block-on-new-main`, based on `main` at `073277b`
(0.35.1). `dev` keeps its own history; this branch carries only the merged-block
design rewritten onto the current tree.

## Shape

Three files carry the design:

| File | Role |
| --- | --- |
| `extensions/prompts/goal-prompts.ts` | Builds the block text: rules, objective, contract, limits, task list, next step. |
| `extensions/goal-context-parts.ts` | Picks the block for the goal's lifecycle state, plus the `scope` and `reanchor` signals. |
| `extensions/goal-live-retention.ts` | Keeps one block at one anchor for the run and verifies the prefix. |

`extensions/goal-events.ts` wires them into the `context_with_system` hook.

## The block

`goalPromptParts(goal, settings, contextUsage)` returns `{ state }`:

```
[PI GOAL ACTIVE goalId=…]
<lifecycle rules>                       buildGoalPrompt: cached by policy fingerprint
Status: Active
Mode: regular
<untrusted_objective>
[TASK LIST …]                           taskListBlock, now inside the cached policy
<verification contract>
<scheduling instructions>               cleared by omission
Limits: lifetime tokens=…; runs=…
Now: … / Goal snapshot: …               nextStepBlock
```

`taskListBlock` moved into `buildGoalPrompt` so `cachedPrompt` covers it: the
cache key already includes `taskIndex(tasks)`, `blockCompletion` and
`currentTaskId`, so a task change rebuilds the policy text instead of emitting a
second message.

Scheduling instructions (`schedulerSummaryParts(...).instructions`) moved into
the block rather than trailing each request. They are cleared by omission, so a
copy that outlives the decision would keep issuing a cancelled order. They change
rarely, and a change re-anchors once rather than trailing every request.

Usage and run counts also live in the block (`nextStepBlock`), so "what now" is
never a stale second message.

## Scope

`goalScope(goal)` hashes `[objective, verificationContract ?? null, sisyphus]`
into 12 hex characters and returns `` `${goal.id}:${digest}` ``. Each branch
prefixes its own lifecycle tag:

| Branch | scope |
| --- | --- |
| active | `` `${goalScope}:` `` or `` `${goalScope}:note` `` while a one-shot note rides |
| paused | `paused:${goalScope}` |
| blocked | `blocked:${goalScope}` |
| budget_limited | `` `budget:${goalScope}:${reminder ? "reminder" : ""}` `` |
| unfocused | `unfocused` |
| stale checkpoint | `` `stale:${checkpoint}` `` |

A scope change is a different subject, so the retained block is dropped and the
new one anchors at the tail. Lifecycle changes and one-shot notes therefore reach
the model in the request that follows them, not one run later.

## Retention

`LiveTailRetention.apply(sessionKey, base, fresh)` returns
`{ messages, transientContents, stableLength }`.

- First call in a run: the block anchors at `base.length` and
  `stableLength === messages.length` — nothing follows the block, so the whole
  request is reusable prefix.
- Later calls in the same run: the block is spliced back at its recorded anchor
  with the text it was emitted with, so request N stays a literal prefix of
  request N+1.
- `reanchor: true` (a stall note, a post-compaction resync, or the one-time
  budget reminder) drops the retained copy so the note is visible now.

Reset conditions, each collapsing to "drop the retained block, anchor at tail":

1. Scope changed.
2. The block was anchored on empty history and history has arrived.
3. History got shorter, or any message before the anchor differs from its
   snapshot (middle-message edits, filter changes, compaction, resume,
   session-tree moves).
4. The anchor is past the end, its preceding message changed, or the message at
   the anchor is a tool result / result-bearing content block
   (`splitsToolBatch`) — a block must never split a call/answer pair.
5. `reanchor` is set.
6. The focused task finished: `goal-events.ts` compares
   `liveRetention.taskId(sessionKey)` against
   `taskIndex(tasks).byId.get(id)?.status === "complete"` before applying.
7. The run ended: `agent_end` calls `liveRetention.clear(sessionKeyFor(ctx))`
   unless the context was superseded by a newer session.

## History verification

Kept verbatim from `main` (#175): `copyForComparison` builds a `Snapshot` per
message once, when it is first seen; later requests compare the copy instead of
re-hashing. Strings up to `RAW_STRING_MAX = 4096` stay raw, longer ones become
`LongString(length, sha256)`. `MAX_DEPTH = 64`; an uncopyable message snapshots
to `null`, and `null` never matches, so the block cannot sit on history it could
not verify. Measured 7 ms at 2.8 MiB against 27 ms for the hash-everything
approach.

## Marker relocation

`goal-live-retention.ts` keeps `contents(sessionKey)` and `transientContents` so
`cacheGoalHistory` can skip the replayed block when it moves explicit
`cache_control` markers. `stableLength` replaces the old "one retained message"
assumption in `experiments/context/cache-compare.mjs`.

## What changed in the gates

- `experiments/context/cache-report.mjs`: the 1,000-transition corpus is a single
  block; assertions are "one transient, one extra message, `stableLength ===
  messages.length`, identical retry", `breaks === 0`.
- `experiments/context/cache-compare.mjs`: `stable()` slices at `stableLength`;
  `appendedCounters` became `refreshedBlocks`; `liveCount(a) <= 1`.
- `experiments/context/retention-check.mjs`: no retained-tail caps to assert; one
  transient, one extra message, full stable length.
- `experiments/context/cache-gate.mjs`: `ref` moved to `073277b` (the split layout
  it compared against no longer exists on this tree).
- `experiments/context/baseline-main.json`: regenerated for the merged layout.
- `experiments/prompt-cache/simulate.ts`: `productionStrategy()` is the merged
  block with `endRun: () => retention.clear("s")`; `splitStrategy()` emulates the
  0.35.1 layout locally so the before/after column keeps its meaning.

## Left alone, and why

- `extensions/goal-session-safety.ts` still folds checkpoints to the trigger
  prompt. The trigger message still starts the turn; it stays in the transcript
  only as the turn marker `goalEventMessageId` reads from `details.goalId`.
- The `agent_end` clear is the only place the block is dropped on a boundary.
  `before_provider_request` still only worries about the explicit-cache marker.
- `MAX_STATE_REANCHOR_REQUESTS` stays exported at `0` so archived gates that
  compare against a released tree still link.
