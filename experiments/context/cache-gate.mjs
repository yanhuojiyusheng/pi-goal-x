/** Compare the candidate with pinned release code using the same capture driver. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildReport} from './cache-report.mjs';
import {compareReports} from './cache-compare.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const ref='fe0e38f8cd03bfacc9baca730e9a902d3cff116e';
const output=process.env.PI_GOAL_CACHE_REPORT_DIR??mkdtempSync(path.join(tmpdir(),'goal-cache-evidence-'));
mkdirSync(output,{recursive:true});
const baselineRoot=mkdtempSync(path.join(tmpdir(),'goal-cache-baseline-'));
try {
 try {execFileSync('git',['cat-file','-e',`${ref}^{commit}`],{cwd:root,stdio:'ignore'});}
 catch {execFileSync('git',['fetch','--no-tags','--depth=1','origin',ref],{cwd:root,stdio:'inherit'});}
 const archive=execFileSync('git',['archive',ref,'extensions','experiments/context','package.json','package-lock.json'],{cwd:root,maxBuffer:16*1024*1024});
 execFileSync('tar',['-x','-C',baselineRoot],{input:archive});
 // Both trees use exactly the same fixtures, driver and installed SDK.
 for(const name of ['capture-context.mjs','fixtures.mjs','cache-report.mjs','cache-compare.mjs','approved-compact-blocks.json']) cpSync(path.join(root,'experiments/context',name),path.join(baselineRoot,'experiments/context',name));
 symlinkSync(path.join(root,'node_modules'),path.join(baselineRoot,'node_modules'),'dir');
 const baselineFile=path.join(output,'baseline.json');
 execFileSync(process.execPath,['--experimental-strip-types','experiments/context/cache-report.mjs','--retention=legacy',`--output=${baselineFile}`],{cwd:baselineRoot,maxBuffer:1024*1024});
 const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
 baseline.source=ref;
 writeFileSync(baselineFile,JSON.stringify(baseline,null,2)+'\n');
 const candidate=await buildReport();
 writeFileSync(path.join(output,'candidate.json'),JSON.stringify(candidate,null,2)+'\n');
 const comparison=compareReports(baseline,candidate);
 writeFileSync(path.join(output,'comparison.json'),JSON.stringify(comparison,null,2)+'\n');
 console.log(`Cache gate PASS: ${comparison.scenarios} adapter scenarios; ${comparison.approvedDifferences.length} exact approved display deltas; 1,000 bounded transitions. Evidence: ${output}`);
} finally {rmSync(baselineRoot,{recursive:true,force:true});}
