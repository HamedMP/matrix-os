import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {parse} from 'yaml';

const workflow=parse(readFileSync('.github/workflows/host-bundle-release.yml','utf8'));
const gate=workflow.jobs['ci-gate'].steps.find((step: {name: string})=>step.name==='Wait for CI on this commit');
const job=(status: string, conclusion: string|null)=>({name:'Unit Tests (4/4)',status,conclusion});

function runGate(snapshots: unknown[][], shadow='false'){
 const directory=mkdtempSync(join(tmpdir(),'matrix-release-ci-gate-'));
 try{
  const counter=join(directory,'reads');
  writeFileSync(join(directory,'gh'),`#!${process.execPath}
const fs=require('node:fs');
if(process.argv[3]==='list') console.log(JSON.stringify([{databaseId:123,status:'completed',conclusion:'success',url:'https://github.com/HamedMP/matrix-os/actions/runs/123'}]));
else {
 const file=${JSON.stringify(counter)},snapshots=${JSON.stringify(snapshots)};
 const index=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;
 fs.writeFileSync(file,String(index+1));
 console.log(JSON.stringify({jobs:snapshots[Math.min(index,snapshots.length-1)]}));
}
`,{mode:0o700});
  // Advance the gate's shell clock instead of waiting on wall time. Success
  // fixtures have room for three reads; stuck fixtures hit the real deadline.
  const result=spawnSync('bash',['-c',`sleep() { SECONDS=$((SECONDS + 120)); }\n${gate.run}`],{
   encoding:'utf8',timeout:5000,
   env:{PATH:`${directory}:${process.env.PATH}`,GITHUB_REPOSITORY:'HamedMP/matrix-os',TARGET_SHA:'a'.repeat(40),CI_WORKFLOW_FILE:'ci.yml',CI_GATE_TIMEOUT_SECONDS:'300',DEDICATED_SHADOW_ONLY:shadow},
  });
  return {...result,reads:Number(readFileSync(counter,'utf8'))};
 }finally{rmSync(directory,{recursive:true,force:true});}
}

describe('host bundle waits for consistent same-commit job results',()=>{
 it.each([null,''])('retries incomplete job conclusion %j after the workflow reports success',conclusion=>{
  const result=runGate([[job('in_progress',conclusion)],[job('completed',conclusion)],[job('completed','success')]]);
  expect(result.status,result.stderr).toBe(0);
  expect(result.reads).toBe(3);
 });
 it('retries an empty job inventory instead of publishing without job verification',()=>{
  const result=runGate([[],[job('completed','success')]]);
  expect(result.status,result.stderr).toBe(0);expect(result.reads).toBe(2);
 });
 it('keeps a permanently incomplete inventory bounded',()=>{
  const result=runGate([[job('in_progress',null)]]);
  expect(result.status,result.error?.message).toBe(1);expect(result.stderr).toContain('Timed out');
 });
 it.each(['failure','cancelled','timed_out','neutral'])('rejects a terminal %s job even when the workflow reports success',conclusion=>{
  const result=runGate([[job('completed',conclusion)]]);
  expect(result.status).toBe(1);expect(result.reads).toBe(1);
 });
 it('accepts a neutral redundant-controller diagnostic alongside successful CI jobs',()=>{
  const result=runGate([[job('completed','success'),{name:'Dedicated CI Results',status:'completed',conclusion:'neutral'}]]);
  expect(result.status,result.stderr).toBe(0);expect(result.reads).toBe(1);
 });
 it('does not use a neutral diagnostic alone as a nonempty CI job inventory',()=>{
  const diagnostic={name:'Dedicated CI Results',status:'completed',conclusion:'neutral'};
  const result=runGate([[diagnostic],[job('completed','success'),diagnostic]]);
  expect(result.status,result.stderr).toBe(0);expect(result.reads).toBe(2);
 });
 it.each(['failure','cancelled','timed_out'])('still blocks a %s dedicated diagnostic',conclusion=>{
  const result=runGate([[job('completed','success'),{name:'Dedicated CI Results',status:'completed',conclusion}]]);
  expect(result.status).toBe(1);expect(result.stderr).toContain('Dedicated CI Results');
 });
 it('waits for the dedicated diagnostic to finish before accepting neutral',()=>{
  const result=runGate([
   [job('completed','success'),{name:'Dedicated CI Results',status:'in_progress',conclusion:null}],
   [job('completed','success'),{name:'Dedicated CI Results',status:'in_progress',conclusion:'neutral'}],
   [job('completed','success'),{name:'Dedicated CI Results',status:'completed',conclusion:'neutral'}],
  ]);
  expect(result.status,result.stderr).toBe(0);expect(result.reads).toBe(3);
 });
 it('does not let a neutral dedicated diagnostic hide an actual job failure',()=>{
  const result=runGate([[{name:'Dedicated CI Results',status:'completed',conclusion:'neutral'},job('completed','failure')]]);
  expect(result.status).toBe(1);expect(result.stderr).toContain('Unit Tests (4/4) (failure)');
 });
 it('ignores only the explicitly nonblocking shadow job',()=>{
  const result=runGate([[job('completed','success'),{name:'Verified Dedicated Linux Qualification',status:'in_progress',conclusion:null}]],'true');
  expect(result.status,result.stderr).toBe(0);
 });
});
