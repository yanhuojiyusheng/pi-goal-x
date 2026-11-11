/** Pure payload comparisons and deterministic retention measurements. */
import assert from 'node:assert/strict';
import approvedCompactBlocks from './approved-compact-blocks.json' with {type: 'json'};
import {createHash} from 'node:crypto';
import {LiveTailRetention} from '../../extensions/goal-live-retention.ts';
// Namespace import: this driver also runs against the archived release tree, which has no
// window constant. A named import there is a hard link error, not an undefined binding.
import * as retentionModel from '../../extensions/goal-live-retention.ts';
import {createGoal} from '../../extensions/goal-record.ts';
// Namespace import for the same reason as the window constant: the archived release
// tree has no merged block helper, and a named import there is a hard link error.
import * as goalPrompts from '../../extensions/prompts/goal-prompts.ts';
import {userMessage, assistantMessage} from './fixtures.mjs';

/** The archived 0.34.x release tree keeps counters and has no window constant; the
 *  candidate defines it, so the bound follows the code instead of a copied literal. */
const reanchorWindow = () => retentionModel.MAX_STATE_REANCHOR_REQUESTS ?? 1;

/** True when the tree under test emits one merged block replaced per request. */
export const mergedBlock = () => typeof goalPrompts.goalPromptBlock === 'function';

/**
 * The argument the retention model under test expects. A merged tree ships
 * `goalPromptBlock` and takes `{block}`; a released tree takes the split
 * `{state, counters|pointer}` pairing, which its `apply` still understands.
 */
export function freshLiveBlock(goal, settings, usage) {
 return mergedBlock()
  ? {block: goalPrompts.goalPromptBlock(goal, settings, usage)}
  : goalPrompts.goalPromptParts(goal, settings, usage);
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const textBlock = block => typeof block.content === 'string' ? block.content : undefined;

export function summarize(payload, transients=[]) {
 const blocks=payload.input??payload.messages;
 assert.ok(Array.isArray(blocks) && blocks.length, 'adapter omitted model-visible input');
 const markers=[];
 function visit(value, trail=[]) {
  if(!value || typeof value!=='object') return;
  if(value.cache_control || value.cachePoint) {
   assert.ok(!transients.includes(value.text), 'cache marker on a transient block');
   markers.push({path:trail, value:value.cache_control??value.cachePoint});
  }
  for(const [key, child] of Object.entries(value)) visit(child,[...trail,key]);
 }
 visit(payload);
 return {
  immutable:digest({system:payload.system,instructions:payload.instructions,systemMessages:blocks.filter(b=>b.role==='system'||b.role==='developer'),tools:payload.tools}),
  options:digest(Object.fromEntries(Object.entries(payload).filter(([k])=>!['system','instructions','tools','messages','input'].includes(k)))),
  blocks:blocks.map(block=>({hash:digest(block),bytes:Buffer.byteLength(JSON.stringify(block)),raw:block,...(textBlock(block)===undefined?{}:{text:textBlock(block)})})),
  bytes:Buffer.byteLength(JSON.stringify(payload)), markers,
 };
}

/**
 * Verified delta #1 (0.34.1, Milestone F): hide the fresh context line. The only
 * permitted edit is removing that one line from a release counter block.
 */
const hideContextLine = value => typeof value==='string' && value.startsWith('Goal snapshot:') && value.includes('\nContext snapshot: unavailable\n')
 ? value.replace('\nContext snapshot: unavailable\n','\n') : undefined;

/**
 * Verified delta #2 (this tree): the release `Goal snapshot:` counter block is
 * replaced by the next-step pointer block. The comparison is never relaxed: the
 * block must still be one user/input text block in the same position, the release
 * usage segment must survive in the pointer header, the pointer body must match
 * exactly one of the grammar shapes below line for line, and a release context
 * line must be reproduced verbatim as the pointer's final line. Anything else
 * stays an unexplained edit.
 */
const replaceWithPointer = value => {
 if(typeof value!=='string' || !value.startsWith('Goal snapshot:')) return undefined;
 const lines=value.split('\n').filter(line=>line.length>0);
 const usage=lines[0].slice('Goal snapshot:'.length).trim();
 const context=lines.slice(1).find(line=>line.startsWith('Context snapshot:'));
 if(lines.length>1 && !context) return undefined;
 if(lines.slice(1).some(line=>line!==context)) return undefined;
 return {usage,context};
};

/**
 * The pointer's own grammar. Exactly one shape is accepted, line for line:
 *   - current task: header with taskId, no task-summary lines;
 *   - none current: `Now: no task is marked current.`, optionally followed by
 *     the first pending task and its `update_goal_task` example;
 *   - no task list: guidance to advance the objective and request an audit.
 * A missing, reordered or extra body line is not approved. A release context
 * line may be dropped or reproduced verbatim as the last line, never rewritten.
 */
const RELEASE_ONLY_LINE = /^(Goal snapshot|Autonomous runs):/;
const NO_CURRENT_LINE = "Now: no task is marked current.";
const START_PENDING_LINE = /^Start with the first pending task: \S/;
const MARK_CURRENT_LINE = /^Mark it current with update_goal_task\(\{task_id:"[^"]+", status:"start"\}\)\.$/;
const NO_TASK_LINE = "Now: keep advancing the objective above.";
const WHEN_MET_LINE = 'When it is actually met, call update_goal({status:"complete"}) to request an independent audit.';

function pointerLinesOk(body,header) {
 // Removing the closing bracket first avoids accepting an empty taskId at the
 // end of a header; task ids may themselves contain spaces or brackets.
 const hasTaskId=/\staskId=\S/.test(header.slice(0,-1));
 if(body.length===0) return hasTaskId;
 if(hasTaskId) return false;
 if(body[0]===NO_CURRENT_LINE)
  return body.length===1||(body.length===3&&START_PENDING_LINE.test(body[1])&&MARK_CURRENT_LINE.test(body[2]));
 if(body[0]===NO_TASK_LINE) return body.length===2&&body[1]===WHEN_MET_LINE;
 return false;
}

function pointerBodyOk(text,releaseContext) {
 const lines=text.split('\n');
 const contextLines=lines.filter(line=>line.startsWith('Context snapshot:'));
 const body=lines.slice(1).filter(line=>!line.startsWith('Context snapshot:'));
 if(body.some(line=>RELEASE_ONLY_LINE.test(line))) return false;
 if(!pointerLinesOk(body,lines[0])) return false;
 if(contextLines.length>1) return false;
 if(contextLines.length===1) {
  if(releaseContext===undefined) return false;
  if(contextLines[0]!==releaseContext) return false;
  if(lines.at(-1)!==contextLines[0]) return false;
 }
 return true;
}

/** Map a release block onto the pointer block, or 0 when the shape is not approved. */
function approvePointer(baselineRaw,candidateRaw) {
 const pairs=[];
 function walk(a,b) {
  if(typeof a==='string') {
   if(a===b) return;
   const replacement=replaceWithPointer(a);
   if(!replacement || typeof b!=='string') {pairs.push(false);return;}
   const header=(b.split('\n')[0])??'';
   const usageOk=replacement.usage==='none'
    ? !/(^|\s)\d+ tokens/.test(header)
    : header.includes(replacement.usage);
   pairs.push(header.startsWith('[PI GOAL NOW ') && header.endsWith(']') && usageOk && pointerBodyOk(b,replacement.context));
   return;
  }
  if(a===null||typeof a!=='object') {if(a!==b) pairs.push(false);return;}
  if(Array.isArray(a)) {
   if(!Array.isArray(b)||a.length!==b.length) {pairs.push(false);return;}
   for(let i=0;i<a.length;i++) walk(a[i],b[i]);
   return;
  }
  if(!b||typeof b!=='object'||Array.isArray(b)) {pairs.push(false);return;}
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  if(keys.size!==Object.keys(a).length||keys.size!==Object.keys(b).length) {pairs.push(false);return;}
  for(const key of keys) walk(a[key],b[key]);
 }
 walk(baselineRaw,candidateRaw);
 const replacements=pairs.filter(Boolean).length;
 return pairs.every(Boolean)&&replacements>0?replacements:0;
}

/**
 * The merged delta: one block that must be the release policy text byte for byte,
 * a newline, then a pointer that passes the same grammar the split model is held
 * to, carrying the release usage segment and its context line verbatim when the
 * release printed one.
 */
function blockText(raw) {
 const strings=[];
 const walk=value=>{
  if(typeof value==='string') strings.push(value);
  else if(Array.isArray(value)) value.forEach(walk);
  else if(value&&typeof value==='object') Object.values(value).forEach(walk);
 };
 walk(raw);
 // The block's own text is its longest string; `replaceOneText` below then
 // requires that this exact value occurs once, so a wrong pick cannot pass.
 return strings.sort((a,b)=>b.length-a.length)[0];
}

/** Replace the one string occurrence `from` with `to`; undefined unless exactly one. */
function replaceOneText(raw,from,to) {
 let hits=0;
 const walk=value=>{
  if(typeof value==='string') {if(value===from) {hits++;return to;} return value;}
  if(Array.isArray(value)) return value.map(walk);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walk(child)]));
  return value;
 };
 const out=walk(raw);
 return hits===1?out:undefined;
}

/** Pointer grammar applied to a whole pointer text, sharing the split model's checks. */
function pointerTextOk(text,replacement) {
 const header=text.split('\n')[0];
 const usageOk=replacement.usage==='none'
  ? !/(^|\s)\d+ tokens/.test(header)
  : header.includes(replacement.usage);
 return header.startsWith('[PI GOAL NOW ')&&header.endsWith(']')&&usageOk&&pointerBodyOk(text,replacement.context);
}

/** Exact, fixture-scoped SHA-256 approvals for the reviewed compact format.
 * All three texts must match; payload containers, history and markers are still
 * checked independently below. These are reviewed snapshots, never regenerated
 * during a gate run. */
function approveCompactBlock(scenario, policy, counters, compact) {
 const approved=approvedCompactBlocks[scenario.split('/').slice(2).join('/')];
 return approved && digest(policy)===approved.releasePolicy
  && digest(counters)===approved.releaseCounters && digest(compact)===approved.compactBlock;
}

/**
 * No payload normalization: a permitted delta must match an exact approved
 * transformation of the release block, never a fuzzy or order-insensitive match.
 */
export function compareReports(baseline, candidate) {
 assert.equal(candidate.version,baseline.version);
 assert.ok(baseline.rows.length>0,'empty baseline');
 assert.deepEqual(candidate.rows.map(r=>r.id),baseline.rows.map(r=>r.id),'missing/reordered scenario');
 if(baseline.corpus) {
  assert.equal(candidate.corpus.transitions,baseline.corpus.transitions,'retention corpus length changed');
  // A merged block is a single tail that is replaced per request, so the
  // two-block counts (accumulated copies, separate pointer swaps, re-anchored
  // policy) only apply to the legacy shape.
  if(candidate.corpus.retentionModel==='merged') {
   assert.equal(candidate.corpus.maxRetainedMessages,1,'a merged block must ride as exactly one tail');
   assert.ok(candidate.corpus.maxRetainedBytes<=4096,`retained bytes grew to ${candidate.corpus.maxRetainedBytes}`);
   assert.equal(candidate.corpus.pointerReplacements,0,'the snapshot must stay fixed throughout the run');
   assert.equal(candidate.corpus.breaks,0,'advancing history must preserve the snapshot prefix');
  } else {
   assert.ok(candidate.corpus.maxRetainedMessages<=2,`retained block count grew to ${candidate.corpus.maxRetainedMessages}`);
   assert.ok(candidate.corpus.maxRetainedBytes<=2048,`retained bytes grew to ${candidate.corpus.maxRetainedBytes}`);
   assert.equal(candidate.corpus.pointerReplacements,candidate.corpus.transitions-1,'the pointer must be replaced on every fresh request');
   assert.ok(candidate.corpus.policyAnchorMoves<=Math.ceil(candidate.corpus.transitions/Math.max(reanchorWindow(),1))+1,`policy re-anchored ${candidate.corpus.policyAnchorMoves} times`);
  }
  if(candidate.corpus.retentionModel!=='merged') assert.ok(candidate.corpus.breaks>0,'legacy advancing history must move at least one retained block');
 }
 if(baseline.dependencies) assert.equal(candidate.dependencies,baseline.dependencies,'comparison dependencies differ');
 if(baseline.investigation) {
  // The classification itself is model-specific: a released tree reuses until the
  // goal moves, a merged tree re-emits on every changed request.
  if(mergedBlock()) assert.ok(candidate.investigation.stateChanges.every(step=>!step.prefixBreak),'the block must stay fixed within an agent run');
  else assert.deepEqual(candidate.investigation.stateChanges.map(({kind,prefixBreak})=>({kind,prefixBreak})),baseline.investigation.stateChanges.map(({kind,prefixBreak})=>({kind,prefixBreak})),'state reset classification changed');
  assert.equal(candidate.investigation.occupancy[1].breaks,0,'hidden occupancy invalidated retention');
  assert.equal(candidate.investigation.occupancy[1].changedRequests,0,'hidden occupancy changed the request');
  for(const [n,step] of candidate.investigation.stateChanges.entries()) {
   // A merged block trades the pinned policy block for a shorter jump: it must
   // still lose only the text this request added plus itself, never history.
   if(mergedBlock()) assert.ok(step.suffixMessages<=3,`${step.kind}: the block displaced ${step.suffixMessages} history messages`);
   else assert.ok(step.reusableBlocks>=baseline.investigation.stateChanges[n].reusableBlocks,'unchanged workflow lost reusable history');
  }
 }
 const differences=[];
 // A merged tree injects one block where the release injects two: the pinned
 // policy block and the accumulated counter block both disappear, and a single
 // block at the tail carries the policy bytes followed by the pointer.
 const merged=mergedBlock();
 for(let i=0;i<baseline.rows.length;i++) {
  const a=baseline.rows[i], b=candidate.rows[i];
  assert.equal(b.immutable,a.immutable,`${b.id}: immutable prefix changed`);
  assert.equal(b.options,a.options,`${b.id}: cache/provider options changed`);
  // Shared vocabulary: a live block is one of ours, a synthetic message id is
  // assigned per request, and markers are recorded as index paths.
  const isLive=raw=>{const text=blockText(raw);return text!==undefined&&(text.startsWith('[PI GOAL ACTIVE')||text.startsWith('Goal snapshot:')||text.startsWith('[PI GOAL NOW'))};
  const withoutSyntheticId=raw=>{if(!raw||typeof raw!=='object')return raw;const {id,...rest}=raw;return rest;};
  // Only message containers hold live blocks; `tools.7` indexes the tool array.
  const markersOnLive=b.markers.some(({path})=>(path[0]==='messages'||path[0]==='input')&&isLive(b.blocks[Number(path[1])]?.raw));
  const aLive=a.blocks.filter(block=>isLive(block.raw)), bLive=b.blocks.filter(block=>isLive(block.raw));
  // Per row, not per tree: synthetic fixtures below exercise the split grammar
  // directly and must keep being compared that way.
  if(merged&&aLive.length>bLive.length) {
   // A merged tree keeps every history message, drops both release live blocks
   // (the pinned policy block and the accumulated counter block) and appends one
   // block carrying the policy bytes followed by an approved pointer.
   const history=blocks=>blocks.filter(block=>!isLive(block.raw)).map(block=>digest(withoutSyntheticId(block.raw)));
   assert.deepEqual(history(a.blocks),history(b.blocks),`${b.id}: history changed`);
   // Marker indices shift with the dropped block; the values and their targets must not.
   assert.deepEqual(b.markers.map(marker=>marker.value),a.markers.map(marker=>marker.value),`${b.id}: cache marker values changed`);
   assert.ok(!markersOnLive,`${b.id}: cache marker landed on the live block`);
   if(aLive.length===0) {
    assert.equal(bLive.length,0,`${b.id}: a goal-free scenario must stay goal-free`);
    if(a.reuse) assert.deepEqual(b.reuse,a.reuse,`${b.id}: warm-prefix blocks lost`);
    continue;
   }
   assert.equal(aLive.length,2,`${b.id}: release must carry a policy block and a counter block`);
   assert.equal(bLive.length,1,`${b.id}: a merged tree must emit exactly one live block`);
   const policyText=blockText(aLive[0].raw), countersText=blockText(aLive[1].raw), mergedText=blockText(bLive[0].raw);
   const replacement=countersText===undefined?undefined:replaceWithPointer(countersText);
   assert.ok(policyText!==undefined&&countersText!==undefined&&replacement!==undefined&&mergedText!==undefined,`${b.id}: the merged block must carry readable text`);
   const compactApproved=approveCompactBlock(b.id,policyText,countersText,mergedText);
   if(!compactApproved) {
    assert.equal(mergedText.slice(0,policyText.length),policyText,`${b.id}: the merged block must start with the release policy bytes or match the exact approved compact transition`);
    assert.ok(mergedText[policyText.length]==='\n',`${b.id}: the pointer must follow the policy on its own line`);
    assert.ok(pointerTextOk(mergedText.slice(policyText.length+1),replacement),`${b.id}: the merged block must end with an approved pointer`);
   }
   assert.deepEqual(bLive[0].raw,replaceOneText(aLive[0].raw,policyText,mergedText),`${b.id}: the merge must only replace the policy text`);
   if(a.reuse) assert.ok(b.reuse?.blocks>=a.reuse.blocks-2,`${b.id}: warm-prefix blocks lost`);
   differences.push({scenario:b.id,reason:compactApproved?'compact-active-block':'next-step-pointer-merged',replacedBlocks:2,removedBytes:aLive.reduce((sum,block)=>sum+block.bytes,0)-bLive[0].bytes});
   continue;
  }
  assert.deepEqual(b.markers,a.markers,`${b.id}: cache markers changed`);
  assert.equal(b.blocks.length,a.blocks.length,`${b.id}: unexpected block count`);
  for(let j=0;j<a.blocks.length;j++) {
   if(a.blocks[j].hash===b.blocks[j].hash) continue;
   // Delta #2 first: a release counter block becomes the pointer (it may also
   // carry the hidden context line, so both deltas can describe one block).
   const replaced=approvePointer(a.blocks[j].raw,b.blocks[j].raw);
   if(replaced>0) {
    differences.push({scenario:b.id,block:j,reason:'next-step-pointer',replacedBlocks:replaced,removedBytes:a.blocks[j].bytes-b.blocks[j].bytes});
    continue;
   }
   // Explicit opt-in keeps the release context line: the pointer replacement
   // above is the only delta it may show.
   assert.ok(!b.id.endsWith('/context-explicit-true'),`${b.id}: explicit opt-in differs from release`);
   let edits=0;
   const expected=value=>{
    const hidden=hideContextLine(value);
    if(hidden!==undefined) {edits++;return hidden;}
    if(Array.isArray(value))return value.map(expected);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expected(v)]));
    return value;
   };
   const approved=expected(a.blocks[j].raw);
   assert.ok(edits>0,`${b.id}: unexplained block ${j}`);
   assert.deepEqual(b.blocks[j].raw,approved,`${b.id}: unexpected counter edit`);
   differences.push({scenario:b.id,block:j,reason:'default-context-display-off',removedBytes:a.blocks[j].bytes-b.blocks[j].bytes});
  }
  if(a.reuse) {
   assert.equal(b.reuse?.blocks,a.reuse.blocks,`${b.id}: warm-prefix blocks lost`);
   const removed=a.blocks.slice(0,a.reuse.blocks).reduce((sum,block,j)=>sum+block.bytes-b.blocks[j].bytes,0);
   assert.equal(b.reuse.bytes,a.reuse.bytes-removed,`${b.id}: reusable history lost`);
  }
 }
 return {scenarios:candidate.rows.length,approvedDifferences:differences};
}

/** Reproduce #108's four breaks in ten state/task transitions; keep safety resets. */
export function investigateCache() {
 let goal=createGoal({objective:'Complete three verified tasks',autoContinue:true,sisyphus:false},0);
 goal.id='cache-investigation';
 const history=[userMessage('Begin')], retention=new LiveTailRetention();
 let previous=retention.apply('state-workflow',history,freshLiveBlock(goal)).messages;
 const kinds=['work','set-tasks','work','complete-1','work','complete-2','work','complete-3','work','work'];
 const stateChanges=[];
 for(const [n,kind] of kinds.entries()) {
  if(kind==='set-tasks') goal={...goal,taskList:{tasks:[1,2,3].map(i=>({id:`t${i}`,title:`Required task ${i}`,status:'pending'})),blockCompletion:true,proposedAt:'1970-01-01T00:00:00Z'}};
  else if(kind.startsWith('complete')) goal={...goal,taskList:{...goal.taskList,tasks:goal.taskList.tasks.map(task=>task.id===`t${kind.at(-1)}`?{...task,status:'complete',evidence:'verified'}:task)}};
  history.push(assistantMessage(`Work ${n}`),userMessage('Continue'));
  const next=retention.apply('state-workflow',history,freshLiveBlock(goal)).messages;
  let shared=0;while(shared<previous.length && JSON.stringify(previous[shared])===JSON.stringify(next[shared]))shared++;
  const prefixBreak=shared!==previous.length;
  // A merged tree re-emits its single block on every changed request, so any fresh
  // text breaks the prefix; a split tree only loses the prefix when the goal moves.
  assert.equal(prefixBreak,mergedBlock()?false:kind!=='work',`${kind}: unexplained reset/reuse`);
  stateChanges.push({kind,prefixBreak,reusableBlocks:shared,suffixMessages:previous.length-shared,reusableBytes:Buffer.byteLength(JSON.stringify(previous.slice(0,shared))),requestBytes:Buffer.byteLength(JSON.stringify(next))});
  previous=next;
 }
 assert.equal(stateChanges.filter(step=>step.prefixBreak).length,mergedBlock()?0:4);
 const occupancy=[];
 for(const showContextUsage of [true,false]) {
  const retained=new LiveTailRetention();
  const base=[userMessage('Unchanged history')];
  let prior,breaks=0,changedRequests=0,totalRequestBytes=0;
  for(let n=0;n<80;n++) {
   const result=retained.apply('occupancy',base,freshLiveBlock(goal,{showContextUsage},{tokens:n+1,contextWindow:1000}));
   if(prior && JSON.stringify(result.messages.slice(0,prior.length))!==JSON.stringify(prior))breaks++;
   if(prior && JSON.stringify(result.messages)!==JSON.stringify(prior))changedRequests++;
   totalRequestBytes+=Buffer.byteLength(JSON.stringify(result.messages));
   prior=result.messages;
  }
  occupancy.push({showContextUsage,requests:80,breaks,changedRequests,totalRequestBytes});
 }
 return {stateChanges,occupancy,decision:'retain policy resets; task progress changes active task instructions and completion gates'};
}

