# Technical plan

Implementation status: appending pointer implemented 2026-11-12 on
`feat/goal-pointer-per-turn` (from `3e1cb35`).

Plan baseline: the verification/settings work below landed on `feat/long-goal-drift-guards`.
The sections §1 and §1.1 describe the *replaced* pointer state machine and are kept as
record; §1.3 describes what the branch now does. The plan's gate work (§3) and test plan
(§4) still apply, with the bounds restated for accumulation.

## 1. Current retention state machine

`extensions/goal-live-retention.ts` keeps one `SessionRetention` per session/model identity
(`MAX_TRACKED_SESSIONS = 16`):

```ts
interface SessionRetention {
  tails: RetainedTail[];        // { anchorIndex, anchorFingerprint, content, kind }
  baseFingerprints: Array<string | null>;
  lastFresh?: { state: string; pointer?: string };
  applies: number;              // fresh-content requests since the last reset
}
```

`apply(sessionKey, base, fresh)` runs, in order (as of the replaced-pointer model in §1.1;
see §1.3 for the current one):

1. Fingerprint every `base` message (`sha256` of a stable serialization; `null` when the
   message cannot be serialized).
2. Reset when: the state block changed; a retained pointer disappeared; tails are anchored
   on empty history but `base` is now non-empty; `base` shrank; any earlier fingerprint
   differs (in-place edits, compaction, filter changes); or a retained anchor is now unsafe
   (`splitsToolBatch(base[anchorIndex])` — `toolResult`/`tool`/`tool_result` roles or
   `toolCallId`/`toolUseId` content blocks).
3. `blocks = freshBlocks(fresh)` → `[state, pointer?]`; `shared` = length of the common
   prefix with `freshBlocks(lastFresh)`.
4. Window check (below), then `session.tails = session.tails.filter(t => t.kind === "goal-state")`
   when content is fresh, so only one pointer survives.
5. Splice retained tails at their anchors, push the remaining blocks at `base.length`,
   persist `baseFingerprints`/`lastFresh`, and return `transientContents` for
   `goal-prompt-cache.ts` marker relocation.

`reset()` clears `tails`, `lastFresh`, `baseFingerprints` and `applies`.

### 1.1 Window check as it was for a replaced pointer

```ts
if (shared < blocks.length) {
  if (session.tails.length > 0 && session.applies + 1 >= MAX_STATE_REANCHOR_REQUESTS) {
    reset();          // zeroes applies as well
    shared = 0;
  } else {
    session.applies += 1;
  }
}
```

`MAX_STATE_REANCHOR_REQUESTS = 128` at that time (12 → 24 → 128 across `2857c2f`,
`52b01c7`, `b95a23d`). The request that performs the reset does not consume window budget,
so a window is exactly 128 fresh requests (resets on requests 128, 256, …).
Counting the reset request as one made every window after the first only 23 requests long —
the branch shipped that off-by-one and the rewritten window test caught it. Only fresh
content advances the window, so an identical retry stays byte-identical (and warm).

### Run boundary correction (2026-11-12)

Track the agent run boundary per session. `agent_start` makes the next request eligible to append one pointer; subsequent requests freeze that pointer until the next run. The initial request appends one copy, and each new run appends one copy even if text is identical. Policy changes and unsafe history retain their existing reset precedence. Verify with multiple requests and tool results inside one run, a subsequent run, and the 12-copy boundary.

### 1.3 Accumulating pointer (historical; see correction above)

`MAX_STATE_REANCHOR_REQUESTS = 12`. `FreshLiveTails` drops the concept of "shared blocks";
`apply` now:

1. Fingerprints `base` and resets exactly as before (state changed, pointer vanished, anchor
   on empty history, history shrank or changed, anchor splits a tool batch).
2. Compares the newest retained copy with `fresh.pointer`:
   `const pointerChanged = fresh.pointer !== undefined && fresh.pointer !== session.tails.at(-1)?.content`.
   An identical retry appends nothing and returns the previous message array byte-for-byte.
3. Resets when `window > 0 && session.tails.length > 0 && session.applies >= window`. The
   reset does not consume budget, so a window is exactly `window` appended copies.
4. Replays all retained tails at their anchors, appends `fresh.state` only when the tails
   were just cleared, then appends the new copy and increments `applies` when the pointer
   changed.

`SessionRetention.applies` therefore counts appended copies, not requests. `transientContents`
returns every retained copy plus the fresh ones so `goal-prompt-cache.ts` still relocates
explicit markers past all of them.

`extensions/goal-events.ts` no longer returns early for a completed goal: it emits a
`[PI GOAL COMPLETE goalId=…]` state block, so the completed goal stays visible and is
re-anchored at the tail on the next request instead of vanishing.

Bounds in `experiments/context/cache-report.mjs` and `cache-compare.mjs` follow the model:
`blockBound = MAX_STATE_REANCHOR_REQUESTS + 1`, `maxRetainedMessages <= window + 1`,
`maxRetainedBytes <= window·1024 + 2048`, and both `pointerReplacements` and
`policyAnchorMoves` are bounded by `ceil(transitions / window) + 1`. The corpus asserts
`pointerReplacements > 0` so a silently frozen prefix still fails.

### 1.2 Window as a setting

- `MAX_STATE_REANCHOR_REQUESTS` stays the default constant (128); it becomes the default
  value of the new setting rather than the only value.
- `FreshLiveTails` gains `window?: number`. It is **not** part of `freshBlocks`, so it
  never participates in `shared` and never changes block content; changing the setting does
  not reset retention by itself.
- Local `const window = fresh.window ?? MAX_STATE_REANCHOR_REQUESTS;` and the check
  becomes `if (window > 0 && session.tails.length > 0 && session.applies + 1 >= window)`.
  `0` therefore means "never re-anchor": the policy block stays at the anchor where it was
  first placed.
- `extensions/goal-events.ts` already loads `loadGoalSettings(ctx.cwd)` around
  `liveRetention.apply(sessionKey, base, { state, pointer })`; pass
  `window: settings.stateReanchorRequests`.
- Shrinking the window below the current `applies` value costs exactly one reset on the next
  fresh request (`reset()` zeroes `applies`, then the same request counts as 1). Growing it
  can only delay the next reset. Neither case moves content, so no extra invalidation is
  introduced.

Edge cases covered by tests: `window: 0` with an advancing history keeps one policy anchor
forever; an explicit window equal to the default matches the omitted one; `window: 0` still
resets on state change, history rewrite and unsafe anchor (the window is not the only reset
source).

Implementation note: the resolved value stays `undefined` when unset, and the fallback is
applied at the consumption site (`fresh.window ?? MAX_STATE_REANCHOR_REQUESTS`) and in the
display rows. A `defaultValue: 24` would make every settings save materialize 24 into the
user's file and pin today's default forever, which is why `maxAutonomousRuns` uses the same
`undefined` shape.

Contract conflict (recorded, not silently resolved): the task text also asked for a
byte-identical default path. The branch's pre-setting behavior counted the reset request in
`applies`, so windows after the first were 23 fresh requests; t2 fixed that to exact 24
(resets on 24, 48, 72), which necessarily changes later reset points. The default still
produced 24-request windows originally, and no test assertion was relaxed to compensate.

## 2. Settings integration points

Six places in `extensions/goal-settings.ts`, following the `maxAutonomousRuns` pattern, plus
the interactive `/goal-settings` row:

| Purpose | Landed anchor |
| --- | --- |
| Interface field + doc comment | `interface GoalSettings`, next to `showContextUsage` (~124) |
| Allowed key list (unknown-key diagnostics) | key array entry next to `"maxAutonomousRuns"` (~356) |
| Parsing and validation | `case "stateReanchorRequests"` in the value switch (~443): nonnegative safe integer, `0` allowed, diagnostic text "stateReanchorRequests must be a nonnegative safe integer (0 disables re-anchoring)" |
| Resolution across layers | `resolveLeaf<number | undefined>` next to `maxAutonomousRuns` (~866), `defaultValue: undefined` |
| Exported snapshot | the returned object (~934) |
| Persistence | only when defined (`buildPersistedLayer`, ~1302) |
| Settings summary row | effective-settings list (~1353): label "policy re-anchor window (0 = never)", `undefined` → `"128 requests (default)"`, `0` → `"never"`, else `"<n> requests"` |
| Interactive settings row | `SETTING_ROWS` in `extensions/goal-commands.ts` (~391): `positiveInteger`, 0 allowed by the row-driven lower bound, help text explains the cache cost |

`goal-live-retention.ts` imports only `node:crypto` and `./goal-record.ts`, so importing the
constant into `goal-settings.ts` adds no cycle. The retention module must not import settings.

Docs synced: `docs/prompt-caching.md` describes the window as configurable, and the README
Settings table gains one row next to the autonomous-run allowance.

Public documentation: one row in the existing README Settings table (a factual addition
inside an existing section, per AGENTS.md) plus the `docs/prompt-caching.md` paragraph and
`docs/architecture.md` where the two-block layout is described.

## 3. Gate rework

The branch's cache gate still measures the release retention model. Four changes:

### 3.1 Bounds

`experiments/context/cache-report.mjs:79-80`, `cache-compare.mjs:121-122`,
`retention-check.mjs:24-25` asserted `<= 32` blocks and `<= 4096` bytes of retained text.
Measured candidate values are 2 blocks and 59 bytes, so all three assertions were
tautologies.

`cache-report.mjs` cannot hard-code `2`: `cache-gate.mjs` copies that driver into the
archived release tree, whose accumulative retention legitimately keeps up to 32 counter
tails. The driver therefore takes `buildReport({blockBound = 2})` and its CLI accepts
`--retention=legacy` (bound 32), which `cache-gate.mjs` passes only on the baseline run. So
the candidate run asserts `<= 2` itself, and the tightened candidate-only bounds also live
in `cache-compare.mjs` (`candidate.corpus.maxRetainedMessages <= 2`,
`maxRetainedBytes <= 2048`) and `retention-check.mjs` (`<= 2`, that gate imports this tree
only). Keep a byte bound as a sanity limit on a single block (the corpus pointer is under
100 bytes; `2048` is enough).

### 3.2 `breaks` split

`breaks` counts requests whose message array is not an extension of the previous one. With
the pointer replaced on every request that becomes ~999/1000 for the candidate (release:
32/1000), so the metric no longer distinguishes a routine pointer swap from a policy
re-anchor. The corpus now counts two additional signals:

- `pointerReplacements` — the previous request's last live block text is gone from the new
  request.
- `policyAnchorMoves` — the index of the first live block differs from the previous
  request's.

Measured after the change: candidate `{pointerReplacements: 999, policyAnchorMoves: 41}`,
release `{pointerReplacements: 32, policyAnchorMoves: 32}`. `cache-compare.mjs` asserts on
the candidate only:

- `maxRetainedMessages <= 2`, `maxRetainedBytes <= 2048`;
- `pointerReplacements === transitions - 1`;
- `policyAnchorMoves <= Math.ceil(transitions / REANCHOR_WINDOW) + 1` (9 for 1000 transitions at window 128);
- `breaks > 0` as a liveness check (the upper bound is gone: it was always satisfied).

### 3.3 Pointer body validation

`approvePointer` checks the header shape and then the body line for line. Exactly one of
the three shapes is approved; a missing, reordered or extra body line is not:

- current task: `Now: …`, optional `Done when: …`, `Then: …`, `Progress: n/m`;
- pending task, none current: `Now: no task is marked current.`,
  `Start with the first pending task: …`,
  `Mark it current with update_goal_task({task_id:"…", status:"start"}).`, `Progress: n/m`;
- no task list: `Now: keep advancing the objective above.`,
  `When it is actually met, call update_goal({status:"complete"}) …`.

`Goal snapshot:` / `Autonomous runs:` lines are release-only and rejected everywhere, and
the optional `Context snapshot:` line must be reproduced verbatim as the last line. A
line grammar (rather than a loose prefix allow-list) is what keeps the comparison an exact
string match: the only approved change is a counter block whose replacement is one
well-formed pointer.

### 3.4 Current-task coverage

Correction (t5): the gate corpus already contains current-task goals, so no new fixture
and no `baseline-main.json` regeneration are needed.
`experiments/context/fixtures.mjs:70` `"current-contracted-task"` sets
`currentTaskId: "t3"` on a six-task contracted tree with a verification contract, and
`experiments/context/fixtures.mjs:119` `"get-goal-default-and-verbose"` uses
`currentTaskId: "t2"` (fixtures.mjs:217). Every `buildReport` run covers 4 flavors × 3
cache tiers; the current gate evidence has 288 pointer rows, and 12 of them carry
`Done when:` — the `current-contracted-task` fixture in each flavor/tier pair. The
approved-delta count stays 288 because the validation tightened without changing which
rows are approved.

`baseline-main.json` still records the release's counter blocks; t6 regenerates it only to
relabel the baseline, not to add a fixture.

## 4. Test plan

Unit tests (`tests/goal-live-retention.test.ts`):

- Window test grows `base` each request, asserts the policy anchor index follows the tail,
  and that it jumps back to `base.length` exactly on the 24th fresh request (and never on an
  identical retry).
- Restored `splitsToolBatch` shapes: `role: "toolResult"`, `role: "tool"` and a
  content-block `tool_result` result, each appended after an unchanged history.
- Window setting: default (128), custom value, `0` (no re-anchor),
  and `1`.

Settings tests: parse/persist/round-trip, invalid values (negative, fractional, string
garbage) produce the diagnostic and fall back, `0` survives as `0` rather than `undefined`.

Prompt tests (`tests/goal-prompts*.test.ts`): `Then: none` only when nothing is pending
anywhere; a pending task before the current one keeps `Then:` pointing at it; a long task id
stays intact in the header and in the `update_goal_task` example while a long title is
excerpted.

Gate tests: `npm run context:gate`, `npm run context:cache-gate`,
`npm run context:cache-report`.

### 4.1 Mutation evidence

For every restored assertion, one local revert must make the intended assertion fail:

| Revert | Must fail |
| --- | --- |
| keep every tail kind when content is fresh | retained block bound (`<= 2`) |
| drop the window reset call | window test anchor jump |
| drop the `splitsToolBatch` guard | restored wire-shape tests |
| `Then:` from order-after only | pending-before-current test |
| truncate the id with `excerpt` | long-id header/example test |

Record each revert, the failing assertion and the restore in `MILESTONES.md`.

## 5. Risks and non-goals

- Type checking cannot run on this workstation (`@typescript/typescript-linux-x64` fails to
  resolve from the global npm install). Every suite here runs under
  `node --experimental-strip-types`; `MILESTONES.md` must record the limitation rather than
  claim a passing `tsc`.
- `cache-report.mjs` runs the same driver against the archived 0.34.1 tree, whose
  `apply()` ignores unknown fields. Keep passing both `counters` and `pointer` so one driver
  measures either retention model; add `window` only to the candidate-side call sites.
- No live provider measurement is added. `policyAnchorMoves` is a statement about request
  construction, not a hit-rate claim.
- The default value is 128 (raised from the original 24 after measuring a real agentic turn:
  128 requests at window 24 moved the anchor 5 times and forced 0.87 MB of re-reads, 4.3% of
  all prompt bytes; window 128 moved it once, 0.31 MB, 1.5%). Changing the default further, removing the window, or persisting the
  pointer into the session is out of scope for this campaign.
