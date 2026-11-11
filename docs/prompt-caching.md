# Prompt caching

pi-goal-x preserves the provider's reusable prompt prefix during normal user turns, autonomous checkpoints, and tool loops. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. Request-only goal policy plus the next-step pointer that carries the open step (the deepest pending task, named by id and title so a nested plan needs no phase line), that step's completion contract, the next task and the usage header. The policy block is replayed at a verified history anchor; the pointer is replaced at the tail on every request.

Changing goal state never rewrites the system prompt or historical messages. The full goal-state message is not persisted into the session. Old checkpoints remain until Pi compacts history; retaining small markers avoids shifting the prefix on every continuation. Display-only auditor messages are consistently excluded, and tool calls stay adjacent to their results.

Goal context filtering and live-state tails use Pi's `context_with_system` event, preserving system and tool deltas in their original positions. Parent and delegated sessions use this hook from their first request.

For Anthropic-style explicit caching, the extension moves Pi's existing cache_control breakpoint from the transient state message onto the preceding cacheable history block. The Bedrock equivalent moves the cachePoint. Both preserve the configured TTL and do not add breakpoints. Payloads without an existing explicit marker—including caching disabled and implicit-cache providers—receive no marker changes. The extension does not set cache keys, enable paid extended retention, or replace provider defaults.

Execution tools already use an idempotent profile: goal progress, focus, and lifecycle changes do not change schemas. Explicit switches into/out of drafting and changes to disableTasks can change tools and legitimately rebuild the cache. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by Pi compaction, branch/session changes, model/provider switches, other extensions changing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction. The supported host range is Pi 1.4+ within 1.x, with Node 22.19 or newer. Development dependencies pin Pi 1.4.0.

Pi 1.4 prepares custom-triggered turns through the same public startup protocol as user prompts. The extension leaves structured prompt and tool deltas intact, including additional sections supplied by other extensions. Direct creation, drafting, resume and reload use the host's native prompt preparation from the first request. Explicit tool-profile changes can still rebuild the prefix.

Validation includes consecutive request-prefix regressions; actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention; Bedrock payload-shape checks; lifecycle/tool-pair safety tests; and full SDK parent/auditor/Oracle payload captures. These tests stop before HTTP dispatch. They verify request construction, not live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.

Active requests split two request-only blocks with opposite needs. The policy block (objective, tasks, lifecycle rules, limits, scheduling state and applicable recovery/auditor reminders) is large and stable, so it is retained verbatim at a verified history anchor and re-anchored once per `stateReanchorRequests` requests that carry fresh content (default 128; `0` keeps the first anchor for the session). The pointer block (current task, its contract, the next task, progress, and the usage header) must be read last, so it is replaced rather than accumulated: each request drops the previous copy and appends the current one at the tail. An identical request adds nothing and stays byte-identical, which keeps retries warm.

Replacing the pointer is the one deliberate cache break: the shared prefix ends at the policy block and the cost is the pointer itself, which would have been new content either way. The window reset is the expensive one, because everything between the old anchor and the tail loses its cache. Policy changes (including budget/run-limit removal), rewritten history, unsafe tool-result boundaries and an exhausted window reset retention; at most 16 session/model identities are tracked and no full-state tails are persisted. Older copies are historical, and the current policy takes precedence over cache reuse.

Explicit-marker relocation skips all retained live text and tolerates Pi's trailing effort-only messages. Another extension's content-bearing suffix is left alone. Changing models/providers starts a separate retention identity. Unknown session identities do not retain history between requests.

Validation now includes advancing SDK request chains, combined effort-marker/retention regressions, a 1,000-transition corpus that asserts bounded retained blocks while history grows, and a 64 KiB–4 MiB history-cost gate. These are request-construction and CPU measurements, not live provider hit-rate claims.
