import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention, MAX_STATE_REANCHOR_REQUESTS } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);
const live = (messages: any[]): string[] => messages.filter(m => m.customType === "pi-goal-live-context").map(m => m.content);

test("the pointer is replaced at the tail while the policy block stays anchored", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	assert.deepEqual(contents(retention.apply("s", base1, { state: "S", pointer: "P1" }).messages), ["h", "S", "P1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", base2, { state: "S", pointer: "P2" }).messages), ["h", "S", "a", "P2"]);
	const base3 = [...base2, msg("assistant", "b", 3)];
	assert.deepEqual(contents(retention.apply("s", base3, { state: "S", pointer: "P3" }).messages), ["h", "S", "a", "b", "P3"]);
});

test("only one pointer copy is ever retained", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let out: any[] = [];
	for (let i = 0; i < 10; i++) {
		base.push(msg("assistant", `a${i}`, i + 2));
		out = retention.apply("s", base, { state: "S", pointer: `P${i}` }).messages;
	}
	assert.equal(live(out).filter(c => c.startsWith("P")).length, 1, "stale pointers are dropped, never accumulated");
	assert.equal(out.at(-1).content, "P9", "the newest pointer rides at the tail");
	assert.deepEqual(retention.contents("s"), ["S", "P9"]);
});

test("unchanged content across repeats and advances adds zero blocks", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "S", pointer: "P" };
	const first = retention.apply("s", base, fresh);
	assert.deepEqual(retention.apply("s", base, fresh).messages, first.messages);
	const advanced = [...base, msg("assistant", "a", 2)];
	const third = retention.apply("s", advanced, fresh).messages;
	assert.deepEqual(third.slice(0, first.messages.length), first.messages);
	assert.equal(third.length, first.messages.length + 1);
});

test("rewritten history resets once and never loses the live state", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [msg("user", "h", 1)], { state: "S", pointer: "P1" });
	const next = retention.apply("s", [msg("user", "compacted summary", 10)], { state: "S", pointer: "P1" });
	assert.deepEqual(contents(next.messages), ["compacted summary", "S", "P1"]);
});

test("a changed policy block drops stale blocks and starts a fresh tail", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S1", pointer: "P1" });
	assert.deepEqual(contents(retention.apply("s", base, { state: "S2", pointer: "P2" }).messages), ["h", "S2", "P2"]);
});

test("the policy block is re-anchored once per window of requests", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const positions: number[] = [];
	for (let i = 1; i <= MAX_STATE_REANCHOR_REQUESTS * 2; i++) {
		const out = retention.apply("s", base, { state: "S", pointer: `P${i}` }).messages;
		positions.push(out.findIndex(m => m.content === "S"));
	}
	assert.equal(positions[0], 1, "first request anchors the policy block at the tail");
	assert.ok(positions[MAX_STATE_REANCHOR_REQUESTS - 2] === 1, "the anchor does not move between windows");
	assert.equal(positions[MAX_STATE_REANCHOR_REQUESTS - 1], 1, "the exhausted window re-anchors it");
	const out = retention.apply("s", base, { state: "S", pointer: "P-last" }).messages;
	assert.equal(live(out).filter(c => c === "S").length, 1, "the old copy is dropped, never duplicated");
});

test("an identical retry never advances the re-anchor window", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const first = retention.apply("s", base, { state: "S", pointer: "P1" }).messages;
	// A retry of the same request must be byte-identical: a reset here would
	// break the warm prefix exactly when a retry needs it most.
	for (let i = 0; i < MAX_STATE_REANCHOR_REQUESTS * 2; i++) {
		assert.deepEqual(retention.apply("s", base, { state: "S", pointer: "P1" }).messages, first);
	}
	assert.deepEqual(contents(retention.apply("s", base, { state: "S", pointer: "P2" }).messages), ["h", "S", "P2"]);
});

test("sessions are tracked independently", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("a", base, { state: "SA", pointer: "PA" });
	assert.deepEqual(contents(retention.apply("b", base, { state: "SB", pointer: "PB" }).messages), ["h", "SB", "PB"]);
	assert.deepEqual(contents(retention.apply("a", base, { state: "SA", pointer: "PA" }).messages), ["h", "SA", "PA"]);
});

test("null fresh clears the session so the next request starts over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", pointer: "P" });
	const cleared = retention.apply("s", base, null);
	assert.deepEqual(cleared.messages, base);
	assert.deepEqual(cleared.transientContents, []);
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", advanced, { state: "S", pointer: "P" }).messages), ["h", "a", "S", "P"]);
});

test("transient contents cover retained and fresh blocks for marker relocation", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", pointer: "P1" });
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(retention.apply("s", advanced, { state: "S", pointer: "P2" }).transientContents, ["S", "P2"]);
});

test("a retained block never splits a tool-call batch when history diverges", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const call = (ids: string[]): any => ({ role: "assistant", timestamp: 2, content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) });
	const result = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false });
	const fresh = { state: "S", pointer: "P" };
	retention.apply("s", [user, call(["a"]), result("a")], fresh);
	const out = retention.apply("s", [user, call(["b", "c"]), result("b"), result("c")], fresh).messages;
	const roles = out.map((m: any) => m.role);
	const firstResult = roles.indexOf("toolResult");
	assert.deepEqual(roles.slice(firstResult, firstResult + 2), ["toolResult", "toolResult"], "tool results stay adjacent");
	assert.deepEqual(roles.slice(-2), ["custom", "custom"], "live state rides at the tail");
});

test("a thousand changing requests keep a fixed wire footprint", () => {
	const retention = new LiveTailRetention();
	const base: unknown[] = [{ role: "user", content: "start" }];
	for (let i = 0; i < 1000; i++) {
		base.push({ role: "assistant", content: `turn ${i}` });
		const out = retention.apply("s", base, { state: "S", pointer: `Snapshot ${i}: ${"x".repeat(180)}` });
		assert.equal(live(out.messages as any[]).length, 2, "policy block plus exactly one pointer");
		assert.equal((out.messages.at(-1) as { content: string }).content, `Snapshot ${i}: ${"x".repeat(180)}`);
	}
});

for (const editInPlace of [false, true]) {
	test(`a middle-history ${editInPlace ? "in-place edit" : "replacement"} drops previously retained blocks`, () => {
		const retention = new LiveTailRetention();
		const early = { role: "user", content: [{ type: "text", text: "early" }], timestamp: 1 };
		const base = [early, msg("user", "late", 2)];
		retention.apply("s", base, { state: "S", pointer: "P1" });
		base.push(msg("assistant", "reply", 3));
		retention.apply("s", base, { state: "S", pointer: "P2" });
		if (editInPlace) early.content[0]!.text = "edited";
		else base[0] = { ...early, content: [{ type: "text", text: "edited" }] };
		const next = retention.apply("s", base, { state: "S", pointer: "P3" });
		assert.deepEqual(contents(next.messages.slice(0, base.length)), base.map(m => m.content), "no old block remains between history messages");
		assert.deepEqual(contents(next.messages.slice(base.length)), ["S", "P3"]);
	});
}

test("tails anchored on empty history reset once real history arrives", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [], { state: "S", pointer: "P1" });
	const out = retention.apply("s", [msg("user", "real", 1)], { state: "S", pointer: "P1" });
	assert.deepEqual(contents(out.messages), ["real", "S", "P1"]);
});

test("eviction bounds provider metadata as well as retention", () => {
	const retention = new LiveTailRetention();
	for (let i = 0; i < 40; i++) retention.apply(`s${i}`, [msg("user", "h", 1)], { state: `S${i}`, pointer: `P${i}` });
	assert.equal(retention.contents("s0"), undefined);
	assert.deepEqual(retention.contents("s39"), ["S39", "P39"]);
});

test("a delayed result resets earlier policy as well as the unsafe pointer anchor", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "go", 1);
	const call: any = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] };
	const result: any = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false };
	retention.apply("s", [user, call], { state: "S", pointer: "P1" });
	const out = retention.apply("s", [user, call, result], { state: "S", pointer: "P2" }).messages;
	assert.deepEqual(out.map((m: any) => m.role), ["user", "assistant", "toolResult", "custom", "custom"]);
});

test("removing optional observations does not replay their old values", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", pointer: "P1" });
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", advanced, { state: "S" }).messages), ["h", "a", "S"]);
});

test("image and large tool-output edits invalidate hashes without changing stored history", () => {
	const retention = new LiveTailRetention();
	const large = "y".repeat(200_000);
	const base: any[] = [
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
		{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: large }], timestamp: 2, isError: false },
	];
	retention.apply("s", base, { state: "S", pointer: "P1" });
	base[0].content[1].data = "BBB";
	base[1].content[0].text = `${large}!`;
	const out = retention.apply("s", base, { state: "S", pointer: "P2" });
	assert.deepEqual(contents(out.messages.slice(base.length)), ["S", "P2"]);
	assert.equal(base.length, 2);
});

test("an unchanged request keeps its single pointer in place instead of re-appending", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "S", pointer: "P" };
	const first = retention.apply("s", base, fresh);
	const repeat = retention.apply("s", base, fresh);
	assert.deepEqual(repeat.messages, first.messages);
	assert.equal(live(repeat.messages as any[]).length, 2);
});
