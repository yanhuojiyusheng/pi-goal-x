/**
 * Request-only goal state: one block, appended at the tail of every provider
 * request and never persisted.
 *
 * The block holds the policy text (objective, rules, task tree) followed by the
 * pointer (current step, what comes next, cumulative usage). Keeping them in one
 * message is deliberate: a request in a tool loop adds far more tokens than the
 * block holds, so re-emitting the block costs less than pinning any part of it —
 * a pin makes the next change re-read everything between the old anchor and the
 * tail, and that distance grows with how long the pin lives.
 *
 * Nothing is retained between requests, so history rewrites, compaction,
 * resumes and tool-call ordering need no special handling: the block is always
 * rebuilt from the goal and always lands last.
 */

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

/** A request-only tail message. Never persisted; the hook appends it per request. */
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
 * Retired: earlier releases re-anchored a pinned policy block every N requests.
 * One replaced block has nothing to re-anchor, so the setting is ignored; the
 * export stays so archived gates that compare against a released tree still link.
 */
export const MAX_STATE_REANCHOR_REQUESTS = 0;

export interface FreshLiveBlock {
	/** The complete request-only block: policy text followed by the pointer. */
	block: string;
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
	/** Last block per session, only so `contents()` can report what is injected. */
	private readonly blocks = new Map<string, string>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveBlock | null): { messages: Array<T | LiveMessage>; transientContents: string[] } {
		if (fresh === null) {
			this.blocks.delete(sessionKey);
			return { messages: [...base], transientContents: [] };
		}
		if (this.blocks.size >= MAX_TRACKED_SESSIONS && !this.blocks.has(sessionKey)) {
			const oldest = this.blocks.keys().next();
			if (!oldest.done) this.blocks.delete(oldest.value);
		}
		this.blocks.set(sessionKey, fresh.block);
		return { messages: [...base, makeLiveMessage(fresh.block)], transientContents: [fresh.block] };
	}

	contents(sessionKey: string): string[] | undefined {
		const block = this.blocks.get(sessionKey);
		return block === undefined ? undefined : [block];
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.blocks.clear();
		else this.blocks.delete(sessionKey);
	}
}
