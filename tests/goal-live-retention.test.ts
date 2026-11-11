import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);
const live = (messages: any[]): string[] => messages.filter(m => m.customType === "pi-goal-live-context").map(m => m.content);

test("the block is replaced at the tail on every request", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	assert.deepEqual(contents(retention.apply("s", base1, { block: "B1" }).messages), ["h", "B1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", base2, { block: "B2" }).messages), ["h", "a", "B2"]);
	const base3 = [...base2, msg("assistant", "b", 3)];
	assert.deepEqual(contents(retention.apply("s", base3, { block: "B3" }).messages), ["h", "a", "b", "B3"]);
});

test("only one copy of the block is ever retained", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let out: any[] = [];
	for (let i = 0; i < 10; i++) {
		base.push(msg("assistant", `a${i}`, i + 2));
		out = retention.apply("s", base, { block: `B${i}` }).messages;
	}
	assert.equal(live(out).length, 1, "stale copies are dropped, never accumulated");
	assert.equal(out.at(-1).content, "B9", "the newest block rides at the tail");
	assert.deepEqual(retention.contents("s"), ["B9"]);
});

test("the same request always renders the same messages", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { block: "B" };
	const first = retention.apply("s", base, fresh);
	assert.deepEqual(retention.apply("s", base, fresh).messages, first.messages, "an identical retry must stay byte-identical");
	const advanced = [...base, msg("assistant", "a", 2)];
	const third = retention.apply("s", advanced, fresh).messages;
	assert.deepEqual(contents(third), ["h", "a", "B"], "the block follows the newest message, never an old anchor");
});

test("rewritten history resets once and never loses the live state", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [msg("user", "h", 1)], { block: "B1" });
	const next = retention.apply("s", [msg("user", "compacted summary", 10)], { block: "B1" });
	assert.deepEqual(contents(next.messages), ["compacted summary", "B1"]);
});

test("a changed block drops the previous copy and starts a fresh tail", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { block: "B1" });
	assert.deepEqual(contents(retention.apply("s", base, { block: "B2" }).messages), ["h", "B2"]);
});

test("the block follows the tail for a thousand changing requests", () => {
	const retention = new LiveTailRetention();
	const base: unknown[] = [{ role: "user", content: "start" }];
	for (let i = 0; i < 1000; i++) {
		base.push({ role: "assistant", content: `turn ${i}` });
		const out = retention.apply("s", base, { block: `B${i}: ${"x".repeat(180)}` });
		assert.equal(live(out.messages as any[]).length, 1, "exactly one block per request");
		assert.equal((out.messages.at(-1) as { content: string }).content, `B${i}: ${"x".repeat(180)}`);
		assert.equal((out.messages as any[]).length, base.length + 1, "the block never displaces history");
	}
});

test("sessions are tracked independently", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("a", base, { block: "BA" });
	assert.deepEqual(contents(retention.apply("b", base, { block: "BB" }).messages), ["h", "BB"]);
	assert.deepEqual(contents(retention.apply("a", base, { block: "BA" }).messages), ["h", "BA"]);
});

test("null fresh clears the session so the next request starts over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { block: "B" });
	const cleared = retention.apply("s", base, null);
	assert.deepEqual(cleared.messages, base);
	assert.deepEqual(cleared.transientContents, []);
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(contents(retention.apply("s", advanced, { block: "B" }).messages), ["h", "a", "B"]);
});

test("transient contents cover retained and fresh blocks for marker relocation", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { block: "B1" });
	const advanced = [...base, msg("assistant", "a", 2)];
	assert.deepEqual(retention.apply("s", advanced, { block: "B2" }).transientContents, ["B2"]);
});

test("a retained block never splits a tool-call batch when history diverges", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const call = (ids: string[]): any => ({ role: "assistant", timestamp: 2, content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) });
	const result = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false });
	const fresh = { block: "B" };
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
		retention.apply("s", base, { block: "B1" });
		base.push(msg("assistant", "reply", 3));
		retention.apply("s", base, { block: "B2" });
		if (editInPlace) early.content[0]!.text = "edited";
		else base[0] = { ...early, content: [{ type: "text", text: "edited" }] };
		const next = retention.apply("s", base, { block: "B3" });
		assert.deepEqual(contents(next.messages.slice(0, base.length)), base.map(m => m.content), "no old block remains between history messages");
		assert.deepEqual(contents(next.messages.slice(base.length)), ["B3"]);
	});
}

test("a block anchored on empty history resets once real history arrives", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [], { block: "B1" });
	const out = retention.apply("s", [msg("user", "real", 1)], { block: "B1" });
	assert.deepEqual(contents(out.messages), ["real", "B1"]);
});

test("eviction bounds provider metadata as well as retention", () => {
	const retention = new LiveTailRetention();
	for (let i = 0; i < 40; i++) retention.apply(`s${i}`, [msg("user", "h", 1)], { block: `B${i}` });
	assert.equal(retention.contents("s0"), undefined);
	assert.deepEqual(retention.contents("s39"), ["B39"]);
});

for (const resultRole of ["toolResult", "tool", "tool_result"] as const) {
	test(`a delayed ${resultRole} result never splits the batch around the live block`, () => {
		const retention = new LiveTailRetention();
		const user = msg("user", "go", 1);
		const call: any = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] };
		const result: any = { role: resultRole, toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false };
		retention.apply("s", [user, call], { block: "B1" });
		const out = retention.apply("s", [user, call, result], { block: "B2" }).messages;
		assert.deepEqual(out.map((m: any) => m.role), ["user", "assistant", resultRole, "custom"], "the result stays next to its call");
	});
}

test("image and large tool-output edits invalidate hashes without changing stored history", () => {
	const retention = new LiveTailRetention();
	const large = "y".repeat(200_000);
	const base: any[] = [
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
		{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: large }], timestamp: 2, isError: false },
	];
	retention.apply("s", base, { block: "B1" });
	base[0].content[1].data = "BBB";
	base[1].content[0].text = `${large}!`;
	const out = retention.apply("s", base, { block: "B2" });
	assert.deepEqual(contents(out.messages.slice(base.length)), ["B2"]);
	assert.equal(base.length, 2);
});
