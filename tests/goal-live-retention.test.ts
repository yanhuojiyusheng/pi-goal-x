import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention, MAX_TRACKED_SESSIONS } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);
const live = (messages: any[]): string[] => messages.filter(m => m.customType === "pi-goal-live-context").map(m => m.content);

test("a run retains the initial block and its position until the run ends", () => {
	const retention = new LiveTailRetention();
	const first = [msg("user", "start", 1)];
	assert.deepEqual(contents(retention.apply("s", first, { state: "B1", scope: "g" }).messages), ["start", "B1"]);
	const next = [...first, msg("assistant", "work", 2), msg("toolResult", "result", 3)];
	assert.deepEqual(contents(retention.apply("s", next, { state: "B2", scope: "g" }).messages), ["start", "B1", "work", "result"]);
});

test("the block remains at its initial position during a run", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	assert.deepEqual(contents(retention.apply("s", base1, { state: "B1", scope: "g" }).messages), ["h", "B1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", base2, { state: "B2", scope: "g" }).messages), ["h", "B1", "a"]);
	const base3 = [...base2, msg("assistant", "b", 3)];
	assert.deepEqual(contents(retention.apply("s", base3, { state: "B3", scope: "g" }).messages), ["h", "B1", "a", "b"]);
});

test("only one copy of the block is ever retained", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let out: any[] = [];
	for (let i = 0; i < 10; i++) {
		base.push(msg("assistant", `a${i}`, i + 2));
		out = retention.apply("s", base, { state: `B${i}`, scope: "g" }).messages;
	}
	assert.equal(live(out).length, 1, "stale copies are dropped, never accumulated");
	assert.equal(live(out)[0], "B0", "the first block remains unchanged");
	assert.deepEqual(retention.contents("s"), ["B0"]);
});

test("the same request always renders the same messages", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "B", scope: "g" };
	const first = retention.apply("s", base, fresh);
	assert.deepEqual(retention.apply("s", base, fresh).messages, first.messages, "an identical retry must stay byte-identical");
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", advanced, fresh).messages), ["h", "B", "a"], "the original anchor stays fixed");
});

test("rewritten history resets once and never loses the live state", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [msg("user", "h", 1)], { state: "B1", scope: "g" });
	const next = retention.apply("s", [msg("user", "compacted summary", 10)], { state: "B1", scope: "g" });
	assert.deepEqual(contents(next.messages), ["compacted summary", "B1"]);
});

test("a changed block waits for the next run", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", scope: "g" });
	assert.deepEqual(contents(retention.apply("s", base, { state: "B2", scope: "g" }).messages), ["h", "B1"]);
});

test("the block stays anchored for a thousand changing requests", () => {
	const retention = new LiveTailRetention();
	const base: unknown[] = [{ role: "user", content: "start" }];
	for (let i = 0; i < 1000; i++) {
		base.push({ role: "assistant", content: `turn ${i}` });
		const out = retention.apply("s", base, { state: `B${i}: ${"x".repeat(180)}`, scope: "g" });
		assert.equal(live(out.messages as any[]).length, 1, "exactly one block per request");
		assert.equal(live(out.messages as any[])[0], `B0: ${"x".repeat(180)}`);
		assert.equal((out.messages as any[]).length, base.length + 1, "the block never displaces history");
	}
});

test("a new run re-anchors: the block moves to the tail with the current state", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", scope: "g" });
	const advanced = [...base, msg("assistant", "a", 2)];
	retention.clear("s");
	const out = retention.apply("s", advanced, { state: "B2", scope: "g" });
	assert.deepEqual(contents(out.messages), ["h", "a", "B2"], "the refresh lands at the tail, nothing stale stays behind");
	assert.deepEqual(retention.contents("s"), ["B2"]);
});

test("every request inside one run is a literal prefix of the next", () => {
	const retention = new LiveTailRetention();
	const base: any[] = [msg("user", "h", 1)];
	let previous: any[] = [];
	for (let i = 0; i < 20; i++) {
		const out = retention.apply("s", base, { state: "B0", scope: "g" });
		if (i > 0) assert.deepEqual(out.messages.slice(0, previous.length), previous, "the prefix is byte-identical");
		previous = out.messages;
		base.push(msg("assistant", `a${i}`, i + 2));
	}
	// The last apply ran before the final push, so its request had one message
	// fewer than the history holds now, plus the block itself.
	assert.equal(previous.length, base.length);
});

test("a focused task that completes is dropped so the next run re-anchors", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", taskId: "t2", scope: "g" });
	assert.equal(retention.taskId("s"), "t2");
	// goal-events clears the session when the retained task is complete, so the
	// refreshed block lands at the tail instead of keeping a stale task header.
	retention.clear("s");
	const next = [...base, msg("assistant", "a", 2)];
	const out = retention.apply("s", next, { state: "B2", taskId: "t3", scope: "g" });
	assert.deepEqual(contents(out.messages), ["h", "a", "B2"]);
	assert.equal(retention.taskId("s"), "t3");
	assert.equal(out.transientContents[0]!.startsWith("B2"), true);
});

test("sessions are tracked independently", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("a", base, { state: "BA", scope: "g" });
	assert.deepEqual(contents(retention.apply("b", base, { state: "BB", scope: "g" }).messages), ["h", "BB"]);
	assert.deepEqual(contents(retention.apply("a", base, { state: "BA", scope: "g" }).messages), ["h", "BA"]);
});

test("null fresh clears the session so the next request starts over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B", scope: "g" });
	const cleared = retention.apply("s", base, null);
	assert.deepEqual(cleared.messages, base);
	assert.deepEqual(cleared.transientContents, []);
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", advanced, { state: "B", scope: "g" }).messages), ["h", "a", "B"]);
});

test("transient contents cover the retained block for marker relocation", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", scope: "g" });
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(retention.apply("s", advanced, { state: "B2", scope: "g" }).transientContents, ["B1"]);
});

test("a retained block never splits a tool-call batch when history diverges", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const call = (ids: string[]): any => ({ role: "assistant", timestamp: 2, content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) });
	const result = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false });
	const fresh = { state: "B", scope: "g" };
	retention.apply("s", [user, call(["a"]), result("a")], fresh);
	const out = retention.apply("s", [user, call(["b", "c"]), result("b"), result("c")], fresh).messages;
	const roles = out.map((m: any) => m.role);
	const firstResult = roles.indexOf("toolResult");
	assert.deepEqual(roles.slice(firstResult, firstResult + 2), ["toolResult", "toolResult"], "tool results stay adjacent");
	assert.deepEqual(roles.slice(-1), ["custom"], "the live block rides at the tail");
});

for (const editInPlace of [false, true]) {
	test(`a middle-history ${editInPlace ? "in-place edit" : "replacement"} drops the retained block`, () => {
		const retention = new LiveTailRetention();
		const early = { role: "user", content: [{ type: "text", text: "early" }], timestamp: 1 };
		const base = [early, msg("user", "late", 2)];
		retention.apply("s", base, { state: "B1", scope: "g" });
		base.push(msg("assistant", "reply", 3));
		retention.apply("s", base, { state: "B2", scope: "g" });
		if (editInPlace) early.content[0]!.text = "edited";
		else base[0] = { ...early, content: [{ type: "text", text: "edited" }] };
		const next = retention.apply("s", base, { state: "B3", scope: "g" });
		assert.deepEqual(contents(next.messages.slice(0, base.length)), base.map(m => m.content), "no old block remains between history messages");
		assert.deepEqual(contents(next.messages.slice(base.length)), ["B3"]);
	});
}

test("a block anchored on empty history resets once real history arrives", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [], { state: "B1", scope: "g" });
	const out = retention.apply("s", [msg("user", "real", 1)], { state: "B1", scope: "g" });
	assert.deepEqual(contents(out.messages), ["real", "B1"], "nothing lingers at the head");
});

test("a different goal or a changed objective starts a fresh prefix", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", scope: "goal-a:1" });
	const edited = retention.apply("s", base, { state: "B2", scope: "goal-a:2" });
	assert.deepEqual(contents(edited.messages), ["h", "B2"], "a changed objective is shown at once, not one run late");
});

test("a paused or blocked state replaces the active block immediately", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "ACTIVE", scope: "g:1" });
	const paused = retention.apply("s", base, { state: "PAUSED", scope: "paused:g:1" });
	assert.deepEqual(contents(paused.messages), ["h", "PAUSED"], "a lifecycle change is visible at once");
	const resumed = retention.apply("s", base, { state: "ACTIVE", scope: "g:1" });
	assert.deepEqual(contents(resumed.messages), ["h", "ACTIVE"]);
});

test("a one-shot note re-anchors so the model sees it now", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "B1", scope: "g" });
	const advanced = [...base, msg("assistant", "a", 2)];
	const flagged = retention.apply("s", advanced, { state: "B1\n[GOAL STALLED]", scope: "g", reanchor: true });
	assert.deepEqual(contents(flagged.messages), ["h", "a", "B1\n[GOAL STALLED]"]);
	const after = [...advanced, msg("assistant", "b", 3)];
	const settled = retention.apply("s", after, { state: "B2", scope: "g" });
	assert.deepEqual(contents(settled.messages), ["h", "a", "B1\n[GOAL STALLED]", "b"], "the note stays pinned where it landed for the rest of the run");
});

test("large payloads are hashed rather than copied, and an edit is still noticed", () => {
	const retention = new LiveTailRetention();
	const image = { type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png" };
	const base: any[] = [{ role: "user", content: [image] }, { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] }];
	retention.apply("s", base, { state: "B1", scope: "g" });
	image.data = "B" + image.data.slice(1);
	const out = retention.apply("s", base, { state: "B2", scope: "g" });
	assert.deepEqual(out.messages.slice(0, base.length), base);
	assert.deepEqual(contents(out.messages.slice(base.length)), ["B2"], "the edited image invalidates the anchor");
});

test("an unreadable message never matches, so the block cannot sit on stale history", () => {
	const retention = new LiveTailRetention();
	const circular: any = { role: "user", content: "h", timestamp: 1 };
	circular.self = circular;
	retention.apply("s", [circular], { state: "B1", scope: "g" });
	const out = retention.apply("s", [circular], { state: "B2", scope: "g" });
	assert.deepEqual(contents(out.messages), ["h", "B2"], "an uncopyable message resets rather than assumes equality");
});

test("eviction bounds provider metadata as well as retention", () => {
	const retention = new LiveTailRetention();
	for (let i = 0; i < MAX_TRACKED_SESSIONS + 20; i++) retention.apply(`s${i}`, [{ role: "user", content: "start" }], { state: "B", scope: "g" });
	assert.equal(retention.contents("s0"), undefined);
	assert.deepEqual(retention.contents(`s${MAX_TRACKED_SESSIONS + 19}`), ["B"]);
});

test("the retained block stays the last message, so the whole request is reusable prefix", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1), msg("assistant", "a", 2)];
	const out = retention.apply("s", base, { state: "B", scope: "g" });
	assert.equal(out.messages.length, out.stableLength, "nothing follows the block");
	assert.equal((out.messages.at(-1) as any).customType, "pi-goal-live-context");
});
