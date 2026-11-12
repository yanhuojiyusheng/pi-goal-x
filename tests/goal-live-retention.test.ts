import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention, MAX_STATE_REANCHOR_REQUESTS } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);
const live = (messages: any[]): string[] => messages.filter(m => m.customType === "pi-goal-live-context").map(m => m.content);

test("agent runs freeze the pointer across requests and append on the next run", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const first = retention.apply("s", base, { state: "S", pointer: "P1", run: 1 });
	base.push(msg("assistant", "tool call", 2), msg("toolResult", "result", 3));
	const inRun = retention.apply("s", base, { state: "S", pointer: "P changed", run: 1 });
	assert.deepEqual(live(inRun.messages), ["S", "P1"]);
	assert.deepEqual(inRun.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(inRun.transientContents, ["S", "P1"]);
	const next = retention.apply("s", base, { state: "S", pointer: "P changed", run: 2 });
	assert.deepEqual(live(next.messages), ["S", "P1", "P changed"]);
	assert.deepEqual(next.messages.slice(0, inRun.messages.length), inRun.messages);
});

test("the run window counts copies even when pointer text is identical", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	for (let run = 1; run <= 12; run++) {
		base.push(msg("assistant", `run ${run}`, run + 1));
		const result = retention.apply("s", base, { state: "S", pointer: "P", run });
		assert.equal(live(result.messages).length, run + 1);
	}
	base.push(msg("assistant", "run 13", 14));
	assert.deepEqual(live(retention.apply("s", base, { state: "S", pointer: "P", run: 13 }).messages), ["S", "P"]);
});

test("each new pointer is appended after the previous copy while the policy block stays anchored", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	assert.deepEqual(contents(retention.apply("s", base1, { state: "S", pointer: "P1" }).messages), ["h", "S", "P1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", base2, { state: "S", pointer: "P2" }).messages), ["h", "S", "P1", "a", "P2"]);
	const base3 = [...base2, msg("assistant", "b", 3)];
	assert.deepEqual(contents(retention.apply("s", base3, { state: "S", pointer: "P3" }).messages), ["h", "S", "P1", "a", "P2", "b", "P3"]);
});

test("every pointer copy is retained until the window drops them together", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let out: any[] = [];
	for (let i = 0; i < 5; i++) {
		base.push(msg("assistant", `a${i}`, i + 2));
		out = retention.apply("s", base, { state: "S", pointer: `P${i}`, window: 3 }).messages;
	}
	assert.deepEqual(live(out).filter(c => c.startsWith("P")), ["P3", "P4"], "the exhausted window dropped the older copies");
	assert.equal(live(out).filter(c => c === "S").length, 1, "stale policy copies are never accumulated");
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

test("the policy block is re-anchored once per window of appended pointers", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const window = MAX_STATE_REANCHOR_REQUESTS;
	const positions: number[] = [];
	for (let i = 1; i <= window * 2 + 1; i++) {
		// History grows every request, so a frozen anchor and a re-anchored one land
		// on different indexes instead of both being the tail of a static array.
		base.push(msg("assistant", `turn ${i}`, i + 1));
		const out = retention.apply("s", base, { state: "S", pointer: `P${i}` }).messages;
		positions.push(out.findIndex(m => m.content === "S"));
		assert.equal(live(out).filter(content => content === "S").length, 1, "the old policy copy is dropped, never duplicated");
	}
	// Request 1 sees one user message plus one pushed turn, so the policy block is
	// appended at index 2 and stays there while pointers accumulate behind it.
	assert.equal(positions[0], 2, "the first request anchors the policy block at the tail");
	assert.equal(positions[window - 1], 2, "the anchor does not move while the window fills");
	assert.equal(positions[window], 1 + (window + 1), "the first pointer past the window re-anchors it");
	assert.equal(positions[2 * window], 1 + (2 * window + 1), "the following window re-anchors again");
});

test("an identical pointer never advances the re-anchor window", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const first = retention.apply("s", base, { state: "S", pointer: "P1" }).messages;
	// A retry of the same request must be byte-identical: reappending or a reset
	// here would break the warm prefix exactly when a retry needs it most.
	for (let i = 0; i < MAX_STATE_REANCHOR_REQUESTS * 2; i++) {
		assert.deepEqual(retention.apply("s", base, { state: "S", pointer: "P1" }).messages, first);
	}
	assert.deepEqual(contents(retention.apply("s", base, { state: "S", pointer: "P2" }).messages), ["h", "S", "P1", "P2"]);
});

test("an explicit window overrides the default; 0 never re-anchors", () => {
	const run = (window: number | undefined, requests: number) => {
		const retention = new LiveTailRetention();
		const base = [msg("user", "h", 1)];
		const positions: number[] = [];
		for (let i = 1; i <= requests; i++) {
			base.push(msg("assistant", `turn ${i}`, i + 1));
			const out = retention.apply("s", base, { state: "S", pointer: `P${i}`, window }).messages;
			positions.push(out.findIndex(m => m.content === "S"));
			assert.equal(live(out).filter(content => content === "S").length, 1, "one policy copy per request");
		}
		return positions;
	};
	const custom = run(3, 7);
	assert.equal(custom[0], 2, "the first request anchors at the tail");
	assert.equal(custom[2], 2, "three appended copies fill the window without moving the anchor");
	assert.equal(custom[3], 5, "the first pointer past the window re-anchors at the current tail");
	assert.equal(custom[5], 5, "the next window fills without moving the anchor");
	assert.equal(custom[6], 8, "the third window re-anchors at the new tail");
	assert.deepEqual(run(MAX_STATE_REANCHOR_REQUESTS, 8), run(undefined, 8), "an explicit default window matches the omitted one");
	const frozen = run(0, 100);
	assert.ok(frozen.every(index => index === 2), "window 0 keeps the first anchor for the whole session");
	assert.equal(frozen.length, 100, "window 0 does not reset, so history still grows");
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
	assert.deepEqual(retention.apply("s", advanced, { state: "S", pointer: "P2" }).transientContents, ["S", "P1", "P2"]);
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

test("a thousand changing requests keep a bounded wire footprint", () => {
	const retention = new LiveTailRetention();
	const base: unknown[] = [{ role: "user", content: "start" }];
	for (let i = 0; i < 1000; i++) {
		base.push({ role: "assistant", content: `turn ${i}` });
		const out = retention.apply("s", base, { state: "S", pointer: `Snapshot ${i}: ${"x".repeat(180)}` });
		assert.equal(live(out.messages as any[]).filter(content => content === "S").length, 1, "one policy block");
		assert.ok(live(out.messages as any[]).length <= MAX_STATE_REANCHOR_REQUESTS + 1, "pointer copies stay bounded by the window");
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

for (const resultRole of ["toolResult", "tool", "tool_result"] as const) {
	test(`a delayed ${resultRole} result never splits the batch around the policy block`, () => {
		const retention = new LiveTailRetention();
		const user = msg("user", "go", 1);
		const call: any = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] };
		const result: any = { role: resultRole, toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false };
		retention.apply("s", [user, call], { state: "S", pointer: "P1" });
		const out = retention.apply("s", [user, call, result], { state: "S", pointer: "P2" }).messages;
		assert.deepEqual(out.map((m: any) => m.role), ["user", "assistant", resultRole, "custom", "custom"], "the result stays next to its call");
	});
}

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

test("an unchanged request keeps its retained copies instead of re-appending", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "S", pointer: "P" };
	const first = retention.apply("s", base, fresh);
	const repeat = retention.apply("s", base, fresh);
	assert.deepEqual(repeat.messages, first.messages);
	assert.equal(live(repeat.messages as any[]).length, 2);
});
