# Single merged goal block on the 0.35.1 retention model

## Problem

`dev` carries the merged-block design: one request-only message holds the goal
policy, the task list and the run pointer, and it is re-emitted whenever any of
them changes. `main` replaced that layer with a split model (append-only policy
blocks, append-only task snapshots, never-retained ephemeral text).

The merged block keeps a single, unambiguous state in front of the model: there
is exactly one `[PI GOAL ...]` message per request, at one position, and nothing
in history can contradict it. That property is worth keeping.

Rewriting `dev` onto `main` is the work: the retention layer, the context hook
and the prompt splitter all changed on both sides.

## What the merged block must keep from `main`

These are not part of the merged-block idea and must survive:

- Incremental history verification (`Snapshot` / `LongString`, issue #175):
  comparing against the previous request instead of hashing every message.
  Measured 7 ms at 2.8 MiB of history against 27 ms.
- The five status branches (`paused`, `budget_limited`, `blocked`, `unfocused`,
  stale checkpoint) with their own steering text.
- `goalScope`: a changed objective, contract or sisyphus mode starts the
  retained prefix over instead of appending a contradicting block.
- Draft suppression, tool-batch safety, and the explicit-cache marker
  relocation.

## What the merged block changes

- One request-only message instead of one policy message plus N task
  snapshots plus a trailing ephemeral message.
- No `POLICY_SUPERSEDED_NOTE` and no `POLICY_RECENCY_NOTE`: with a single block
  at a single position there is nothing to supersede, so the model never has to
  resolve which block applies.
- The block is pinned for the length of one agent run: unchanged requests emit
  the identical block at the same anchor, so a tool loop or an idle re-request
  adds no growth. It is refreshed at the run boundary, and immediately when the
  subject changes (a different goal, a changed objective, contract or sisyphus
  mode, a different lifecycle state) or when it has to carry a one-shot note.
- Within a run the model sees the state as it was when the run began. A task
  that finishes during the run forces the refresh, so the block cannot advertise
  work that is already done.

## Cost statement

The merged block trades cache reuse for unambiguous state. Appending is cheaper
under the provider's prefix cache; a replaced block breaks the prefix from its
anchor. This spec does not claim the merged block is cheaper. It claims the
merged block is simpler to reason about, and it must be measured, not asserted.

## Acceptance

- One `pi-goal-live-context` message per provider request, always last, so the
  whole request is reusable prefix.
- Every request within one run is a strict prefix extension of the previous one.
- `npm test`, `npm run context:gate` and `npm run context:cache-gate` pass.
- `experiments/context/baseline-main.json` regenerated for the merged layout.
- A sent/resent/reuse comparison against `main` recorded in `MILESTONES.md`.
