# Prompt caching

pi-goal-x preserves the provider's reusable prompt prefix during normal user turns, autonomous checkpoints, and tool loops. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. One request-only block carrying the goal policy (objective, tasks, lifecycle rules, limits, scheduling state and applicable reminders) followed by the next-step pointer: the open step (the deepest pending task, named by id and title so a nested plan needs no phase line), the next task, progress, and the usage header. It is rebuilt from the goal and appended at the tail on every request, so the model always reads the current step last.

Changing goal state never rewrites the system prompt or historical messages. The full goal-state message is not persisted into the session. Old checkpoints remain until Pi compacts history; retaining small markers avoids shifting the prefix on every continuation. Display-only auditor messages are consistently excluded, and tool calls stay adjacent to their results.

Goal context filtering and live-state tails use Pi's `context_with_system` event, preserving system and tool deltas in their original positions. Parent and delegated sessions use this hook from their first request.

For Anthropic-style explicit caching, the extension moves Pi's existing cache_control breakpoint from the transient state message onto the preceding cacheable history block. The Bedrock equivalent moves the cachePoint. Both preserve the configured TTL and do not add breakpoints. Payloads without an existing explicit marker—including caching disabled and implicit-cache providers—receive no marker changes. The extension does not set cache keys, enable paid extended retention, or replace provider defaults.

Execution tools already use an idempotent profile: goal progress, focus, and lifecycle changes do not change schemas. Explicit switches into/out of drafting and changes to disableTasks can change tools and legitimately rebuild the cache. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by Pi compaction, branch/session changes, model/provider switches, other extensions changing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction. The supported host range is Pi 1.4+ within 1.x, with Node 22.19 or newer. Development dependencies pin Pi 1.4.0.

Pi 1.4 prepares custom-triggered turns through the same public startup protocol as user prompts. The extension leaves structured prompt and tool deltas intact, including additional sections supplied by other extensions. Direct creation, drafting, resume and reload use the host's native prompt preparation from the first request. Explicit tool-profile changes can still rebuild the prefix.

Validation includes consecutive request-prefix regressions; actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention; Bedrock payload-shape checks; lifecycle/tool-pair safety tests; and full SDK parent/auditor/Oracle payload captures. These tests stop before HTTP dispatch. They verify request construction, not live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.

Active requests inject a single block at the tail and keep nothing between requests. Pinning part of it costs more than re-sending it: on the request that moves a pin, everything accumulated since the old anchor is re-read, and that distance grows with the lifetime of the pin, while a re-emitted block only ever costs the block. The break-even is the block's own size — holding pays only when a request adds less text than the block carries, which a tool loop never does. Because nothing is retained, an identical retry stays byte-identical and rewrites of history need no repair.

`stateReanchorRequests` is still accepted and persisted, but it no longer changes behavior: a single replaced block has nothing to re-anchor.

### Why the pointer moves on every request

A prefix cache is a longest-common-prefix match: everything up to the first differing
byte is reused, everything after it is billed as fresh input. That gives one cost model
for every way of placing the pointer, parameterised by how often it moves.

Let `N` be the tokens a request adds (model output plus tool results), `P` the pointer
size, and `C` the number of requests the pointer survives before it is re-placed
(`C = 1` places it on every request; `C = k` places it once per turn of `k` requests).
On the request that moves it, the content accumulated since the old anchor, the new
content and the new pointer are all fresh; on the other `C - 1` requests everything but
the new content is cached:

```
cycle        = C·N + P                    (the moving request)
             + (C-1)·N                    (the requests that keep it in place)
per request  = ((2C-1)·N + P) / C
excess vs C=1 = (C-1)·(N - P)
```

The `C = 1` case reduces to `N + P`, which is what this extension pays today, and the
excess grows with `C - 1` on the left and with `N - P` on the right. Once `C > 1`, the
factor `C-1` immediately delivers nearly all of the penalty; pushing `C` higher only
smooths the remaining fraction.

Priced at DeepSeek's cache-hit/`miss` difference (`$0.294` per million tokens at the
`deepseek-flash` rates in `request_costs.snapshot`: `$0.3/M` input against `$0.006/M`
cache read), the net of moving less often is positive only when `N < 2P`:

```
net = requests × (1 - 1/C) × (2P - N) × $0.294/M
```

Measured on two real goal sessions (`N` ≈ 1,947 tokens per request, derived from an
observed 2,187-token average miss at `P = 240`), moving the pointer once per turn
instead of once per request costs `+$0.304` over 642 requests (`01a1c3ec`) and
`+$0.125` over 251 requests (`01a1c464`) — 46% and 34% of those sessions' input bills.
With the pointer already reduced to ≈90 tokens the same comparison is worse (`+$0.358`
and `+$0.146`), because the smaller `P` raises `N - P`. Bucketing the usage header so
the pointer text is byte-stable for several requests has the same trade-off at a smaller
`C`, so it is not worth doing either; the only lever that holds `C = 1` and still cuts
the bill is shrinking `P`, which is why the contract line is not repeated here.

Replacing the pointer is the one deliberate cache break: the shared prefix ends at the policy block and the cost is the pointer itself, which would have been new content either way. The window reset is the expensive one, because everything between the old anchor and the tail loses its cache. Policy changes (including budget/run-limit removal), rewritten history, unsafe tool-result boundaries and an exhausted window reset retention; at most 16 session/model identities are tracked and no full-state tails are persisted. Older copies are historical, and the current policy takes precedence over cache reuse.

Explicit-marker relocation skips all retained live text and tolerates Pi's trailing effort-only messages. Another extension's content-bearing suffix is left alone. Changing models/providers starts a separate retention identity. Unknown session identities do not retain history between requests.

Validation now includes advancing SDK request chains, combined effort-marker/retention regressions, a 1,000-transition corpus that asserts bounded retained blocks while history grows, and a 64 KiB–4 MiB history-cost gate. These are request-construction and CPU measurements, not live provider hit-rate claims.
