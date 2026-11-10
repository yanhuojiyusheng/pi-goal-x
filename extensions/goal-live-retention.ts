import { createHash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Request-only goal state, injected per provider request and never persisted.
 *
 * Two blocks ride along: the policy block (objective, rules, task tree) and the
 * pointer block (current task, its contract, the next one). They have opposite
 * needs. The policy block is large and stable, so it is retained verbatim at the
 * anchor where it was placed — replaying it costs nothing and keeps the prefix
 * literal. The pointer block is small and must sit where the model reads last,
 * so it is replaced rather than accumulated: each request drops the previous
 * copy and appends the current one at the tail.
 *
 * Every request verifies the preceding history by digest and re-inserts retained
 * blocks at their anchors. A policy change, a history rewrite (compaction,
 * resume, session-tree moves, filter changes, middle-message edits), an unsafe
 * insertion point, or an exhausted window all perform one documented full reset
 * instead of silently shifting the prefix or corrupting message structure.
 */

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

export type LiveTailKind = "goal-state" | "goal-pointer";

/** A request-only tail message. Never persisted; the hook replays it per request. */
export interface LiveMessage {
	role: "custom";
	customType: typeof LIVE_CONTEXT_TYPE;
	content: string;
	display: false;
	timestamp: 0;
}

/** Upper bound on concurrently tracked sessions (parent plus isolated runs). */
export const MAX_TRACKED_SESSIONS = 16;

/**
 * The retained policy block falls further behind the newest turn as history
 * grows, and moving it later costs a cache break from wherever it sits. Re-anchor
 * it once per window of requests; the pointer block needs no window because it
 * is replaced every request.
 */
export const MAX_STATE_REANCHOR_REQUESTS = 12;

export interface FreshLiveTails {
	state: string;
	counters?: string | undefined;
}

interface RetainedTail {
	anchorIndex: number;
	anchorFingerprint: string | null;
	content: string;
	kind: LiveTailKind;
}

interface SessionRetention {
	tails: RetainedTail[];
	lastFresh: FreshLiveTails | undefined;
	/** Digest of every base message at the last apply; any earlier rewrite resets. */
	baseFingerprints: Array<string | null>;
	/** Requests served since the retained blocks were last anchored. */
	applies: number;
}

function freshBlocks(fresh: FreshLiveTails): string[] {
	return fresh.counters === undefined ? [fresh.state] : [fresh.state, fresh.counters];
}

/** Full-message digest, or null (never a match) when serialization fails. */
function fingerprintMessage(message: unknown): string | null {
	try {
		const serialized = JSON.stringify(message) ?? "undefined";
		return createHash("sha256").update(serialized).digest("base64");
	} catch {
		return null;
	}
}

/**
 * Tool results must stay adjacent to the call they answer, so a retained tail
 * may never be inserted directly before one. Covers the Pi session role
 * (`toolResult`), the provider wire role (`tool`, as seen by marker
 * relocation), and result-bearing content blocks in either vocabulary — the
 * call side needs no guard since inserting before a call keeps the pair
 * adjacent.
 */
function splitsToolBatch(next: unknown): boolean {
	const record = asRecord(next);
	const role = record?.role;
	if (role === "toolResult" || role === "tool") return true;
	const content = record?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const entry = asRecord(block);
			if (!entry) continue;
			const type = typeof entry.type === "string" ? entry.type : "";
			if (type === "tool_result" || type === "toolResult") return true;
			if ("toolCallId" in entry || "toolUseId" in entry) return true;
		}
	}
	return false;
}

function makeLiveMessage(content: string): LiveMessage {
	return {
		role: "custom",
		customType: LIVE_CONTEXT_TYPE,
		content,
		display: false,
		timestamp: 0,
	};
}

export class LiveTailRetention {
	private readonly sessions = new Map<string, SessionRetention>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveTails | null): { messages: Array<T | LiveMessage>; transientContents: string[] } {
		if (fresh === null) {
			this.sessions.delete(sessionKey);
			return { messages: [...base], transientContents: [] };
		}
		// Hash each message once per request. Extensions may reuse and mutate
		// message objects, so object identity cannot cache a digest across requests.
		const fingerprints = base.map(fingerprintMessage);
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = { tails: [], lastFresh: undefined, baseFingerprints: [], applies: 0 };
			if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.sessions.keys().next();
				if (!oldest.done) this.sessions.delete(oldest.value);
			}
			this.sessions.set(sessionKey, session);
		}
		const reset = () => {
			session!.tails = [];
			session!.lastFresh = undefined;
			session!.baseFingerprints = [];
			session!.applies = 0;
		};
		session.applies += 1;
		if (session.applies >= MAX_STATE_REANCHOR_REQUESTS && session.tails.length > 0) reset();
		// A changed state block supersedes every previously sent tail: start
		// fresh rather than leave a stale objective or a cancelled scheduling
		// instruction lingering mid-history.
		if (session.lastFresh !== undefined && (session.lastFresh.state !== fresh.state
			|| (session.lastFresh.counters !== undefined && fresh.counters === undefined))) reset();
		// Tails anchored while history was empty would linger at the head once
		// real history arrives. Reset once so fresh tails anchor at the tail.
		if (session.tails.length > 0 && session.baseFingerprints.length === 0 && base.length > 0) reset();
		// Any rewrite earlier than the anchors — middle-message edits, filter
		// changes, checkpoint normalization — breaks the prefix even when the
		// trailing message is identical, so verify the whole preceding history.
		if (session.baseFingerprints.length > base.length) reset();
		else {
			for (let i = 0; i < session.baseFingerprints.length; i++) {
				const current = fingerprints[i];
				if (current === null || current !== session.baseFingerprints[i]) {
					reset();
					break;
				}
			}
		}
		// An unsafe anchor invalidates the whole replay. Keeping an earlier
		// policy while re-appending fresh blocks would duplicate that policy.
		let valid = 0;
		while (valid < session.tails.length) {
			const tail = session.tails[valid]!;
			if (tail.anchorIndex > base.length) break;
			if (tail.anchorIndex > 0) {
				const current = fingerprints[tail.anchorIndex - 1];
				if (current === null || current !== tail.anchorFingerprint) break;
			}
			if (splitsToolBatch(base[tail.anchorIndex])) break;
			valid++;
		}
		if (valid < session.tails.length) reset();
		const blocks = freshBlocks(fresh);
		// Append only the suffix that differs from the last emitted tails, so
		// unchanged content across repeats, tool loops, and history advances
		// adds zero blocks while keeping the prefix literal.
		const previous = session.lastFresh === undefined ? [] : freshBlocks(session.lastFresh);
		let shared = 0;
		while (shared < blocks.length && shared < previous.length && blocks[shared] === previous[shared]) shared++;
		// The pointer is replaced, not accumulated: drop the previous copy so only
		// one rides at the tail. An unchanged request keeps what it already has.
		if (shared < blocks.length) session.tails = session.tails.filter(tail => tail.kind === "goal-state");
		const messages: Array<T | LiveMessage> = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, makeLiveMessage(tail.content));
		}
		for (let i = shared; i < blocks.length; i++) {
			const content = blocks[i]!;
			const kind: LiveTailKind = i === 0 ? "goal-state" : "goal-pointer";
			messages.push(makeLiveMessage(content));
			session.tails.push({ anchorIndex: base.length, anchorFingerprint: fingerprints.at(-1) ?? null, content, kind });
		}
		session.baseFingerprints = fingerprints;
		session.lastFresh = { state: fresh.state, counters: fresh.counters };
		return { messages, transientContents: [...new Set([...session.tails.map(tail => tail.content), ...blocks])] };
	}

	contents(sessionKey: string): string[] | undefined {
		return this.sessions.get(sessionKey)?.tails.map(tail => tail.content);
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
