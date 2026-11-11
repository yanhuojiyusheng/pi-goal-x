/** Request-only goal state retained at its first position for one agent run. */
import { createHash } from "node:crypto";

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

/** A request-only message. Never persisted; retained during an agent run. */
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
	private readonly blocks = new Map<string, { block: string; length: number; fingerprint: string }>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveBlock | null): { messages: Array<T | LiveMessage>; transientContents: string[] } {
		if (fresh === null) {
			this.blocks.delete(sessionKey);
			return { messages: [...base], transientContents: [] };
		}
		if (this.blocks.size >= MAX_TRACKED_SESSIONS && !this.blocks.has(sessionKey)) {
			const oldest = this.blocks.keys().next();
			if (!oldest.done) this.blocks.delete(oldest.value);
		}
		const fingerprint = (messages: readonly T[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
		let retained = this.blocks.get(sessionKey);
		const nextRole = retained && (base[retained.length] as { role?: string } | undefined)?.role;
		if (!retained || retained.length === 0 || retained.length > base.length ||
			fingerprint(base.slice(0, retained.length)) !== retained.fingerprint ||
			(nextRole !== undefined && ["toolResult", "tool", "tool_result"].includes(nextRole))) {
			retained = { block: fresh.block, length: base.length, fingerprint: fingerprint(base) };
			this.blocks.set(sessionKey, retained);
		}
		return { messages: [...base.slice(0, retained.length), makeLiveMessage(retained.block), ...base.slice(retained.length)], transientContents: [retained.block] };
	}

	contents(sessionKey: string): string[] | undefined {
		const block = this.blocks.get(sessionKey);
		return block === undefined ? undefined : [block.block];
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.blocks.clear();
		else this.blocks.delete(sessionKey);
	}
}
