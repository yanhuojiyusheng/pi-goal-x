/** Offline retention cost/space gate: no provider requests or agent runs. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LiveTailRetention } from '../../extensions/goal-live-retention.ts';
import { mergedBlock } from './cache-compare.mjs';

const median = values => values.sort((a,b) => a-b)[Math.floor(values.length / 2)];
const rows = [];
for (const shape of ['text', 'tool-output', 'image']) for (const bytes of [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
 const base = Array.from({length: 64}, (_,i) => {
  const data = 'x'.repeat(bytes / 64);
  return shape === 'text' ? {role:i % 2 ? 'assistant' : 'user',content:data}
   : shape === 'tool-output' ? {role:'toolResult',toolCallId:`call-${i}`,content:[{type:'text',text:data}]}
   : {role:'user',content:[{type:'image',mimeType:'image/png',data}]};
 });
 const retention = new LiveTailRetention();
 const serialize = [], retained = [], retainedSizes = [], retainedBytes = [];
 for (let i=0;i<45;i++) {
  let start=performance.now(); JSON.stringify(base); const plain=performance.now()-start;
  // Fixed-width content keeps this a history-growth check, not a digit-count one.
  const step = String(i).padStart(3, '0');
  // Both fields ride so this gate covers every retention model: the archived
  // release accumulates `counters`, this tree replaces `pointer`.
  const merged=`current policy\nGoal snapshot: snapshot ${step}\n[PI GOAL NOW goalId=fixture]\nNow: step ${step}`;
  const fresh=mergedBlock()?{block:merged}:{state:'current policy',counters:`snapshot ${step}`,pointer:`[PI GOAL NOW goalId=fixture]\nNow: step ${step}`};
  start=performance.now(); const result=retention.apply('fixture',base,fresh); const elapsed=performance.now()-start;
  assert.ok(result.transientContents.length<=2,`live blocks exceed one policy plus one pointer (${result.transientContents.length})`);
  assert.ok(result.transientContents.reduce((n,text)=>n+Buffer.byteLength(text),0)<=4096+14);
  retainedSizes.push(result.transientContents.length);
  retainedBytes.push(result.transientContents.reduce((n,text)=>n+Buffer.byteLength(text),0));
  if(i>=5) {serialize.push(plain);retained.push(elapsed);}
 }
 const baselineMs=median(serialize), retentionMs=median(retained);
 // Existing project's absolute 10ms allowance protects the noise floor.
 assert.ok(retentionMs<=Math.max(baselineMs*1.5,baselineMs+10), `retention CPU regression: ${bytes} bytes, ${retentionMs}ms`);
 rows.push({shape,historyBytes:bytes,maxRetainedTails:Math.max(...retainedSizes),maxRetainedBytes:Math.max(...retainedBytes),serializationMedianMs:+baselineMs.toFixed(3),retentionMedianMs:+retentionMs.toFixed(3)});
}
console.log(JSON.stringify({retention:rows},null,2));
