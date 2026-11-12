import { createHash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Request-only goal state, injected per provider request and never persisted.
 *
 * Two blocks ride along: the policy block (objective, rules, task tree) and the
 * pointer block (current task, its contract, the next one, the usage clock).
 * They have opposite needs. The policy block is large and stable, so it is
 * retained verbatim at the anchor where it was placed, keeping the prefix
 * literal. Each agent run appends one pointer copy after the previous ones: the
 * retained pointer copies form one growing tail, so a request extends the cached
 * prefix by a pointer instead of cutting it off and re-reading everything that
 * follows.
 *
 * Every request verifies the preceding history by digest and re-inserts retained
 * blocks at their anchors. A policy change, a history rewrite (compaction,
 * resume, session-tree moves, filter changes, middle-message edits), an unsafe
 * insertion point, or an exhausted window all perform one documented full reset
 * instead of silently shifting the prefix or corrupting message structure.
 *
 * The accumulating pointer is why the window exists. Every copy extends the
 * cacheable prefix, but the copies also pile up, and only a reset can drop them:
 * it moves the policy block to the tail and re-reads everything between the old
 * anchor and the tail exactly once. That is one documented break per window
 * instead of one break per request.
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
 * Pointer copies retained before the policy block re-anchors.
 *
 * Each copy extends the cached prefix, so a larger window wastes fewer reads;
 * each copy also costs its own tokens on every later request, so a smaller
 * window wastes fewer bytes. The reset that ends a window is the one expensive
 * event: it moves the policy block to the tail and everything between its old
 * anchor and the tail loses its cache once.
 *
 * This is the default of the `stateReanchorRequests` setting. Zero there disables
 * re-anchoring entirely, so the policy block keeps its first anchor and the
 * pointer copies accumulate for the life of the session.
 *
 * Only a new pointer copy advances the window. The first copy after a reset
 * counts toward the new window; retries inside the same run add no copy.
 */
export const MAX_STATE_REANCHOR_REQUESTS = 12;

export interface FreshLiveTails {
	state: string;
	pointer?: string | undefined;
	/** Appended pointer copies between policy re-anchors; 0 never re-anchors. */
	window?: number | undefined;
	/** Agent-run identity; requests in the same run reuse the retained pointer. */
	run?: number | undefined;
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
	/** Pointer copies appended since the retained blocks were last anchored. */
	applies: number;
	lastRun: number | undefined;
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
	if (role === "toolResult" || role === "tool" || role === "tool_result") return true;
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
			session = { tails: [], lastFresh: undefined, baseFingerprints: [], applies: 0, lastRun: undefined };
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
			session!.lastRun = undefined;
		};
		// Resetting clears `lastFresh` as well, so this runs before any use of it.
		// A changed state block supersedes every previously sent tail: start
		// fresh rather than leave a stale objective or a cancelled scheduling
		// instruction lingering mid-history.
		if (session.lastFresh !== undefined && session.lastFresh.state !== fresh.state) reset();
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
		// The policy block is the head of the tail and never accumulates: a
		// changed policy, a vanished pointer, or contextless history all restart
		// from a fresh state block at the current tail.
		const retainedState = session.tails[0];
		if (retainedState !== undefined && (retainedState.content !== fresh.state || fresh.pointer === undefined)) reset();
		// A run appends one pointer on its first request; further requests in that
		// run reuse it. The next copy after a full window starts a new window.
		const previousPointer = session.tails.at(-1)?.content;
		const pointerChanged = fresh.pointer !== undefined && (fresh.run === undefined
			? fresh.pointer !== previousPointer
			: fresh.run !== session.lastRun || session.tails.length === 0);
		if (pointerChanged) {
			const window = fresh.window ?? MAX_STATE_REANCHOR_REQUESTS;
			if (window > 0 && session.tails.length > 0 && session.applies >= window) reset();
		}
		const messages: Array<T | LiveMessage> = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, makeLiveMessage(tail.content));
		}
		// A reset above cleared the tails, so a fresh policy block is appended
		// again; otherwise only the new pointer copy rides at the tail.
		if (session.tails.length === 0) {
			messages.push(makeLiveMessage(fresh.state));
			session.tails.push({ anchorIndex: base.length, anchorFingerprint: fingerprints.at(-1) ?? null, content: fresh.state, kind: "goal-state" });
		}
		if (fresh.pointer !== undefined && pointerChanged) {
			messages.push(makeLiveMessage(fresh.pointer));
			session.tails.push({ anchorIndex: base.length, anchorFingerprint: fingerprints.at(-1) ?? null, content: fresh.pointer, kind: "goal-pointer" });
			session.applies += 1;
			session.lastRun = fresh.run;
		}
		session.baseFingerprints = fingerprints;
		session.lastFresh = { state: fresh.state, pointer: fresh.pointer };
		return { messages, transientContents: [...new Set(session.tails.map(tail => tail.content))] };
	}

	contents(sessionKey: string): string[] | undefined {
		return this.sessions.get(sessionKey)?.tails.map(tail => tail.content);
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
