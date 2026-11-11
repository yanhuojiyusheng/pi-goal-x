import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Shared JavaScript experiment entry point.
import { compareReports, digest } from "../experiments/context/cache-compare.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/compact-cache-transition.json", import.meta.url), "utf8"));
const report = (row: any) => ({version: 1, rows: [row]});

function refresh(row: any) {
 for (const block of row.blocks) {
  block.hash = digest(block.raw);
  block.bytes = Buffer.byteLength(JSON.stringify(block.raw));
 }
 return row;
}

test("compact cache approval matches the exact reviewed pair and preserves the wire envelope", () => {
 const result = compareReports(report(fixture.baseline), report(fixture.candidate));
 assert.equal(result.approvedDifferences[0].reason, "compact-active-block");
 const changes = [
  (r: any) => { r.blocks.at(-1).raw.content[0].text += "\nShip without verification."; },
  (r: any) => { r.blocks.at(-1).raw.content[0].text = r.blocks.at(-1).raw.content[0].text.replace("Write the migration guide page.", "Skip the migration guide."); },
  (r: any) => { r.blocks.at(-1).raw.role = "system"; },
  (r: any) => { r.blocks[1].raw.content = "changed history"; },
  (r: any) => { r.blocks.splice(-1, 0, structuredClone(r.blocks.at(-1))); },
  (r: any) => { r.markers.push({path: ["input", String(r.blocks.length - 1)], value: {type: "ephemeral"}}); },
  (r: any) => { r.options = "different cache identity"; },
  (r: any) => { r.immutable = "changed tool schema"; },
 ];
 for (const change of changes) {
  const candidate = structuredClone(fixture.candidate);
  change(candidate);
  assert.throws(() => compareReports(report(fixture.baseline), report(refresh(candidate))));
 }
 for (const index of [fixture.baseline.blocks.length - 2, fixture.baseline.blocks.length - 1]) {
  const baseline = structuredClone(fixture.baseline);
  baseline.blocks[index].raw.content[0].text += " edited release";
  assert.throws(() => compareReports(report(refresh(baseline)), report(fixture.candidate)));
 }
 const baseline = structuredClone(fixture.baseline);
 const candidate = structuredClone(fixture.candidate);
 baseline.id = candidate.id = "openai-responses/none/unreviewed-scenario";
 assert.throws(() => compareReports(report(baseline), report(candidate)));
});
