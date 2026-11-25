import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, run, productionStrategy, splitStrategy } from "../experiments/prompt-cache/simulate.ts";

// Request construction only: this checks how much of each request extends the
// one before it. It does not measure live provider hit rates.
for (const scenario of SCENARIOS) test(`simulated ${scenario.name} session keeps its prompt prefix`, () => {
	const result = run(productionStrategy(), scenario);
	assert.equal(result.bigBreaks, 0, "no request loses most of the previous prefix");
	assert.ok(result.cacheShare > 0.98, `cache share ${result.cacheShare}`);
	// The single block refreshes at each run boundary, so it costs a little more
	// than the append-only split layout. The bound keeps that known trade honest:
	// one block per turn is the price of never showing two contradicting states.
	const split = run(splitStrategy(), scenario);
	assert.ok(result.cost <= split.cost * 1.06, `cost ${result.cost} vs split ${split.cost}`);
	assert.ok(result.totalTokens <= split.totalTokens, "one block must not send more text than the split layout");
});
