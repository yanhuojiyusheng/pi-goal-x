import { hash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Prefix-stable retention for one request-only goal block.
 *
 * The context hook appends live goal state to every provider request without
 * persisting it. When the next request arrives, the completed assistant turn
 * occupies the position where the previous block sat, so request N would no
 * longer be a prefix of request N+1 and implicit prompt caches (OpenAI
 * Responses / Chat Completions, which carry no explicit marker) freeze at the
 * first injection point.
 *
 * This module keeps one block at one position for the whole agent run: the block
 * is re-inserted verbatim at its recorded anchor (the session length when it was
 * emitted) and the preceding history is verified unchanged, so every later
 * request of the run is a literal prefix extension of the earlier one. Tool
 * loops, idle re-requests and multi-turn work inside one run therefore add
 * nothing to the block and reuse the whole cached prefix.
 *
 * One block, one position. The block carries the goal policy, the task list and
 * the per-turn pointer together, so there is exactly one `[PI GOAL ...]` message
 * in the request and nothing in history can contradict it. The trade is that the
 * block's content is frozen for the run: the model sees the state as it was when
 * the run started, refreshed at the next run boundary. A change of scope (a
 * different goal, or a changed objective, contract or sisyphus mode), a one-shot
 * steering message, a finished task, any history rewrite (compaction, resume,
 * session-tree moves, filter changes, middle-message edits), an unsafe insertion
 * point or a new run drops the retained copy and re-anchors at the tail.
 *
 * History verification is incremental: every message is copied once, when it is
 * first seen, and later requests only compare the copy with the current message.
 * Long strings are kept as a length and a hash so big tool results are not held
 * twice.
 */

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

/** A request-only block message. Never persisted; the hook replays it per request. */
export interface LiveMessage {
	role: "custom";
	customType: typeof LIVE_CONTEXT_TYPE;
	content: string;
	display: false;
	timestamp: 0;
}

/**
 * Upper bound on tracked sessions (parent plus isolated runs). Evicting the
 * oldest identity only costs that session one re-anchor.
 */
export const MAX_TRACKED_SESSIONS = 16;

/**
 * Retired: earlier releases re-anchored a pinned block every N requests. One
 * replaced block has nothing to re-anchor, so the setting is ignored; the export
 * stays so archived gates that compare against a released tree still link.
 */
export const MAX_STATE_REANCHOR_REQUESTS = 0;

export interface FreshLiveBlock {
	/** The complete request-only block: policy text, task list and pointer. */
	state: string;
	/** The focused task, so the hook can drop a block whose task just finished. */
	taskId?: string | undefined;
	/** What the block is about. A different scope starts the retained prefix over. */
	scope: string;
	/**
	 * True when the block carries something the model must act on now (a one-shot
	 * warning). The content is otherwise frozen for the run, so a steering note
	 * would be invisible without this.
	 */
	reanchor?: boolean | undefined;
}

interface RetainedBlock {
	anchorIndex: number;
	/** The message the block follows, as it was when the block was added. */
	anchorSnapshot: Snapshot | null;
	state: string;
	taskId: string | undefined;
	scope: string;
}

interface SessionRetention {
	retained: RetainedBlock | undefined;
	/** Every base message as it was at the last apply; any earlier rewrite resets. */
	baseSnapshots: Array<Snapshot | null>;
}

/**
 * A message as it looked at the last request, kept to compare against the next
 * one. Short strings are kept as they are; long ones as a length and a hash, so
 * the copy stays small and big tool results are not held twice. Null means the
 * message could not be copied, and a null never matches anything.
 */
type Snapshot = unknown;

/** Strings up to this long are kept as they are. Longer ones are hashed. */
const RAW_STRING_MAX = 4096;
/** Deeper than any real message. Guards against cycles. */
const MAX_DEPTH = 64;

class LongString {
	readonly length: number;
	readonly hash: string;
	constructor(length: number, hash: string) {
		this.length = length;
		this.hash = hash;
	}
}

const hashText = (text: string): string => hash("sha256", text, "base64");

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function copyForComparison(value: unknown, depth: number): Snapshot {
	if (typeof value === "string") return value.length > RAW_STRING_MAX ? new LongString(value.length, hashText(value)) : value;
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= MAX_DEPTH || typeof value !== "object") throw new Error("not copyable");
	if (Array.isArray(value)) return value.map(item => copyForComparison(item, depth + 1));
	if (!isPlainObject(value)) throw new Error("not copyable");
	const copy: Record<string, Snapshot> = {};
	for (const key of Object.keys(value)) copy[key] = copyForComparison((value as Record<string, unknown>)[key], depth + 1);
	return copy;
}

function snapshotMessage(message: unknown): Snapshot | null {
	try {
		return copyForComparison(message, 0);
	} catch {
		return null;
	}
}

function sameAsSnapshot(snapshot: Snapshot, value: unknown, depth = 0): boolean {
	if (typeof snapshot === "string") return snapshot === value;
	if (snapshot instanceof LongString) return typeof value === "string" && value.length === snapshot.length && hashText(value) === snapshot.hash;
	if (snapshot === null || typeof snapshot !== "object") return Object.is(snapshot, value);
	if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return false;
	if (Array.isArray(snapshot)) {
		if (!Array.isArray(value) || value.length !== snapshot.length) return false;
		for (let i = 0; i < snapshot.length; i++) if (!sameAsSnapshot(snapshot[i], value[i], depth + 1)) return false;
		return true;
	}
	if (Array.isArray(value) || !isPlainObject(value)) return false;
	const keys = Object.keys(snapshot);
	if (Object.keys(value).length !== keys.length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(value, key) || !sameAsSnapshot((snapshot as Record<string, Snapshot>)[key], (value as Record<string, unknown>)[key], depth + 1)) return false;
	}
	return true;
}

/** True when the message is unchanged since the snapshot was taken. */
const unchanged = (snapshot: Snapshot | null, message: unknown): boolean => snapshot !== null && sameAsSnapshot(snapshot, message);

/**
 * Tool results must stay adjacent to the call they answer, so a retained block
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

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveBlock | null): { messages: Array<T | LiveMessage>; transientContents: string[]; stableLength: number } {
		if (fresh === null) {
			this.sessions.delete(sessionKey);
			return { messages: [...base], transientContents: [], stableLength: base.length };
		}
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = { retained: undefined, baseSnapshots: [] };
			if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.sessions.keys().next();
				if (!oldest.done) this.sessions.delete(oldest.value);
			}
			this.sessions.set(sessionKey, session);
		}
		const reset = () => {
			session!.retained = undefined;
			session!.baseSnapshots = [];
		};
		// A different goal, a different lifecycle state, or a changed objective,
		// contract or style shares nothing with the earlier block, so start over:
		// with one block there is no earlier copy to supersede, and keeping the old
		// one would put a contradicting state in front of the model.
		if (session.retained !== undefined && session.retained.scope !== fresh.scope) reset();
		// A block anchored while history was empty would linger at the head once
		// real history arrives. Reset once so the block anchors at the tail.
		if (session.retained !== undefined && session.retained.anchorIndex === 0 && base.length > 0) reset();
		// Any rewrite earlier than the anchor — middle-message edits, filter
		// changes, checkpoint normalization — breaks the prefix even when the
		// trailing message is identical, so verify the whole preceding history.
		// Pi hands every request a fresh copy of the messages, and extensions may
		// edit them, so the check compares content with what was seen last time.
		// Comparing is much cheaper than hashing every message on every request.
		if (session.baseSnapshots.length > base.length) reset();
		else {
			for (let i = 0; i < session.baseSnapshots.length; i++) {
				if (!unchanged(session.baseSnapshots[i] ?? null, base[i])) {
					reset();
					break;
				}
			}
		}
		// The verified history keeps its snapshots; only new messages are copied.
		const snapshots = session.baseSnapshots;
		for (let i = snapshots.length; i < base.length; i++) snapshots.push(snapshotMessage(base[i]));
		// An unsafe anchor invalidates the replay: a block inserted before a tool
		// result would break the call/answer pairing, and an anchor whose preceding
		// message changed would sit somewhere the cache cannot follow.
		const retained = session.retained;
		if (retained !== undefined) {
			if (retained.anchorIndex > base.length) reset();
			else if (retained.anchorIndex > 0 && !unchanged(retained.anchorSnapshot, base[retained.anchorIndex - 1])) reset();
			else if (splitsToolBatch(base[retained.anchorIndex])) reset();
		}
		// One-shot steering packed into the block would stay invisible while the
		// block is frozen, so it re-anchors instead.
		if (fresh.reanchor === true) reset();
		// Pin the block at the current tail. Inside the run every later request is
		// a literal extension of this one; the next run re-anchors with fresh state.
		if (session.retained === undefined) {
			session.retained = {
				anchorIndex: base.length,
				anchorSnapshot: snapshots.at(-1) ?? null,
				state: fresh.state,
				taskId: fresh.taskId,
				scope: fresh.scope,
			};
		}
		const kept = session.retained!;
		const messages: Array<T | LiveMessage> = [...base];
		messages.splice(kept.anchorIndex, 0, makeLiveMessage(kept.state));
		// Nothing follows the block, so the whole request is the prefix the next
		// request can reuse.
		return { messages, transientContents: [kept.state], stableLength: messages.length };
	}

	/** The block replayed for this session, for the explicit-cache marker to skip. */
	contents(sessionKey: string): string[] | undefined {
		const session = this.sessions.get(sessionKey);
		return session?.retained === undefined ? undefined : [session.retained.state];
	}

	taskId(sessionKey: string): string | undefined {
		return this.sessions.get(sessionKey)?.retained?.taskId;
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
