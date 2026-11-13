# Prompt caching

pi-goal-x preserves the provider's reusable prompt prefix during normal user turns, autonomous checkpoints, and tool loops. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. One request-only block beginning with an ACTIVE header containing the goal ID, actionable task ID when focused, and cumulative time/tokens. It then carries applicable lifecycle rules, the objective, current task details and ancestor contracts, the next pending task's title, finite limits, scheduling state and reminders. Missing task details must be retrieved before work starts. With no current task or no task list, the block also provides guidance for how to proceed. Its content and position are retained through an agent run, except when the displayed current task completes or another reset is needed.

Changing goal state never rewrites the system prompt or historical messages. The full goal-state message is not persisted into the session. Old checkpoints remain until Pi compacts history; retaining small markers avoids shifting the prefix on every continuation. Display-only auditor messages are consistently excluded, and tool calls stay adjacent to their results.

Goal context filtering and live-state tails use Pi's `context_with_system` event, preserving system and tool deltas in their original positions. Parent and delegated sessions use this hook from their first request.

For Anthropic-style explicit caching, the extension moves Pi's existing cache_control breakpoint from the transient state message onto the preceding cacheable history block. The Bedrock equivalent moves the cachePoint. Both preserve the configured TTL and do not add breakpoints. Payloads without an existing explicit marker—including caching disabled and implicit-cache providers—receive no marker changes. The extension does not set cache keys, enable paid extended retention, or replace provider defaults.

Execution tools already use an idempotent profile: goal progress, focus, and lifecycle changes do not change schemas. Explicit switches into/out of drafting and changes to disableTasks can change tools and legitimately rebuild the cache. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by Pi compaction, branch/session changes, model/provider switches, other extensions changing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction. The supported host range is Pi 1.4+ within 1.x, with Node 22.19 or newer. Development dependencies pin Pi 1.4.0.

Pi 1.4 prepares custom-triggered turns through the same public startup protocol as user prompts. The extension leaves structured prompt and tool deltas intact, including additional sections supplied by other extensions. Direct creation, drafting, resume and reload use the host's native prompt preparation from the first request. Explicit tool-profile changes can still rebuild the prefix.

Validation includes consecutive request-prefix regressions; actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention; Bedrock payload-shape checks; lifecycle/tool-pair safety tests; and full SDK parent/auditor/Oracle payload captures. These tests stop before HTTP dispatch. They verify request construction, not live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.

Active requests inject one block at the tail. Its first ACTIVE header carries the actionable task ID and cumulative usage. Regular mode omits default status/mode and unlimited limits; current task details agree with the header, inherited contracts remain visible, and the next task is shown by title. Retrieve omitted details and contracts before starting that task. Special-mode rules, finite limits and runtime reminders appear when applicable.

`stateReanchorRequests` is accepted and persisted for compatibility but has no effect. The block resets after an agent run; if its displayed actionable task completes, the next request resets and re-anchors it immediately, even within that run. History rewrites and unsafe tool boundaries also re-anchor it. These resets may reduce cache reuse.

### Interpreting cost comparisons

A smaller live block reduces the text submitted in each request. Comparing its billed cost with a retained policy also requires provider cache rules, output reuse, re-anchor frequency and actual usage counters. A pre-HTTP payload comparison cannot establish those savings.

For an idealized steady-state model, let S be the policy size, P the appended pointer size and C the re-anchor interval. If each ordinary retained request has N fresh tokens plus P, and re-anchoring additionally rereads the history since the old anchor, its average fresh input is `(2 - 1/C)N + S/C + P`. Replacing the whole block each request instead has `N + S` fresh input under the same assumptions. The difference, retained minus replaced, is `(1 - 1/C)(N - S) + P`. Accumulated cached pointers add their own cache-read charge.

If the retained layout can reuse previous model output, use the genuinely uncached tool/new-input tokens in that difference rather than all added history. DeepSeek V4.1 persists cache prefix units, including input and model-output boundaries, and cache availability is best effort. Arbitrary longest-common-prefix estimates and repriced sessions from another model do not establish its actual cache hits, latency or bill. Use provider usage counters for a matched comparison.

Explicit-marker relocation skips all retained live text and tolerates Pi's trailing effort-only messages. Another extension's content-bearing suffix is left alone. Changing models/providers starts a separate retention identity. Unknown session identities do not retain history between requests.

Validation now includes advancing SDK request chains, combined effort-marker/retention regressions, a 1,000-transition corpus that asserts bounded retained blocks while history grows, and a 64 KiB–4 MiB history-cost gate. These are request-construction and CPU measurements, not live provider hit-rate claims.
