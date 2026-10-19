import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parse} from 'yaml';
import {canonicalRequest} from '../../scripts/ci/dedicated-ssh.mjs';
import {diagnosticPhases,verifyQualificationDiagnostics,qualificationDiagnosticsSummary} from '../../scripts/ci/dedicated-diagnostics.mjs';

const receipt={leaseId:'1'.repeat(32),requestDigest:'2'.repeat(64),sourceSha:'3'.repeat(40),imageDigest:'sha256:'+'4'.repeat(64),harnessDigest:'5'.repeat(64),queueSeconds:7,wallSeconds:60,startedUtc:'2026-10-18T12:00:00Z',finishedUtc:'2026-10-18T12:01:00Z',request:{limits:{memoryMiB:114688}}};
function diagnostic(){return{schemaVersion:1,kind:'qualification-diagnostics',...Object.fromEntries(['leaseId','requestDigest','sourceSha','imageDigest','harnessDigest','queueSeconds','wallSeconds'].map(k=>[k,(receipt as any)[k]])),receiptSha256:createHash('sha256').update(canonicalRequest(receipt)).digest('hex'),phaseSeconds:Object.fromEntries(Object.values(diagnosticPhases).flat().map(x=>[x,1])),phaseTimeline:null,memory:{status:'available',measurement:'cgroup-v2',peakBytes:512*1024*1024,limitBytes:114688*1024*1024,swapPeakBytes:null,events:{oom:0,oomKill:0}}};}

describe('receipt-bound advisory qualification diagnostics',()=>{
 it('keeps the diagnostic labels identical to the authoritative qualification contract',()=>{
  const phases=JSON.parse(execFileSync('python3',['-B','-c','import json,sys;sys.path.insert(0,"scripts/ci/qualification");from contract import PHASES;print(json.dumps(PHASES))'],{encoding:'utf8',timeout:10000,maxBuffer:16384}));
  expect(diagnosticPhases).toEqual(phases);
 });
 it('accepts exactly the complete trusted 55-phase scope and renders bounded metrics',()=>{
  const d=diagnostic();expect(Object.keys(d.phaseSeconds)).toHaveLength(55);expect(verifyQualificationDiagnostics(d,receipt)).toEqual(d);
  const summary=qualificationDiagnosticsSummary(d);expect(summary).toContain('Queue: **7s**');expect(summary).toContain('Workload: **60s**');expect(summary).toContain('0.50 GiB / 112.00 GiB');expect(summary).toContain('OOM: 0; OOM kills: 0');expect(summary).toContain('timeline unavailable');expect(summary).toContain('includes tmpfs and file cache');expect(summary).toContain('excludes separate host helper processes');expect(summary.length).toBeLessThan(12000);
 });
 it.each(['leaseId','requestDigest','sourceSha','imageDigest','harnessDigest','receiptSha256','queueSeconds','wallSeconds'])('rejects mismatched %s',key=>{
  const d:any=diagnostic();d[key]=typeof d[key]==='number'?d[key]+1:'0'.repeat(64);expect(()=>verifyQualificationDiagnostics(d,receipt)).toThrow(/diagnostics/);
 });
 it.each(['extra','missing-phase','unknown-phase','negative-time','large-time','fraction','memory-extra','events-extra','memory-limit','memory-peak','memory-enum'])('rejects invalid %s without accepting candidate-controlled labels',kind=>{
  const d:any=diagnostic();
  if(kind==='extra')d.extra=true;if(kind==='missing-phase')delete d.phaseSeconds.unit;if(kind==='unknown-phase')d.phaseSeconds['# injected']=1;
  if(kind==='negative-time')d.phaseSeconds.unit=-1;if(kind==='large-time')d.phaseSeconds.unit=1801;if(kind==='fraction')d.phaseSeconds.unit=0.5;
  if(kind==='memory-extra')d.memory.path='/private';if(kind==='events-extra')d.memory.events.extra=1;if(kind==='memory-limit')d.memory.limitBytes++;
  if(kind==='memory-peak')d.memory.peakBytes=Number.MAX_SAFE_INTEGER;if(kind==='memory-enum')d.memory={status:'unavailable',reason:'raw failure'};
  expect(()=>verifyQualificationDiagnostics(d,receipt)).toThrow(/diagnostics/);
 });
 it.each(['unsupported_cgroup','unavailable','invalid_metrics','container_identity_mismatch'])('renders explicitly unavailable %s memory',reason=>{
  const d:any={...diagnostic(),memory:{status:'unavailable',reason}};expect(verifyQualificationDiagnostics(d,receipt)).toEqual(d);expect(qualificationDiagnosticsSummary(d)).toContain('Memory: **unavailable**');
 });
 it('uses overlapping timeline spans instead of phase sums for the longest concurrent lane',()=>{
  const d:any=diagnostic(),start=Date.parse(receipt.startedUtc);d.phaseTimeline=Object.fromEntries(Object.keys(d.phaseSeconds).map(x=>[x,{startedUnixMs:start,finishedUnixMs:start+1000}]));
  d.phaseSeconds.unit=30;d.phaseTimeline.unit.finishedUnixMs=start+30000;
  expect(verifyQualificationDiagnostics(d,receipt)).toEqual(d);expect(qualificationDiagnosticsSummary(d)).toContain('unit (30s span)');
  d.phaseTimeline.unit.finishedUnixMs=start+70000;expect(()=>verifyQualificationDiagnostics(d,receipt)).toThrow(/diagnostics/);
 });
 it.each(['missing','unknown','fields','unsafe','reverse','duration'])('rejects invalid timeline %s',kind=>{
  const d:any=diagnostic(),start=Date.parse(receipt.startedUtc);d.phaseTimeline=Object.fromEntries(Object.keys(d.phaseSeconds).map(x=>[x,{startedUnixMs:start,finishedUnixMs:start+1000}]));
  if(kind==='missing')delete d.phaseTimeline.unit;if(kind==='unknown')d.phaseTimeline.extra={startedUnixMs:start,finishedUnixMs:start+1000};if(kind==='fields')d.phaseTimeline.unit.extra=1;
  if(kind==='unsafe')d.phaseTimeline.unit.startedUnixMs=Number.MAX_SAFE_INTEGER+1;if(kind==='reverse')d.phaseTimeline.unit.finishedUnixMs=start-1000;if(kind==='duration')d.phaseTimeline.unit.finishedUnixMs=start+5000;
  expect(()=>verifyQualificationDiagnostics(d,receipt)).toThrow(/diagnostics/);
 });
 it('keeps the receipt archive one-file-only and uploads diagnostics independently',()=>{
  const workflow=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));const steps=workflow.jobs.benchmark.steps;
  const upload=steps.find((s:any)=>s.with?.name?.startsWith('dedicated-diagnostics-'));
  expect(upload.with.path).toBe('output/ci-dedicated-diagnostics/diagnostics.json');expect(upload.with['if-no-files-found']).toBe('ignore');
  const receiptUpload=steps.find((s:any)=>s.with?.name?.startsWith('dedicated-qualification-'));expect(receiptUpload.with.path).toBe('output/ci-dedicated/receipt.json');
  const dispatch=steps.find((s:any)=>s.id==='dispatch').with.script;expect(dispatch).toContain('onDiagnostics:');expect(dispatch).toContain('qualificationDiagnosticsSummary');
 });
 it('tolerates an artifact outage only for the advisory diagnostics upload',()=>{
  const steps=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.benchmark.steps;
  const uploads=steps.filter((step:any)=>step.uses?.startsWith('actions/upload-artifact@'));
  const diagnosticsUpload=uploads.find((step:any)=>step.with.name.startsWith('dedicated-diagnostics-'));
  expect(diagnosticsUpload['continue-on-error']).toBe(true);
  const receiptUpload=uploads.find((step:any)=>step.with.name.startsWith('dedicated-qualification-'));
  expect(receiptUpload['continue-on-error']).toBeUndefined();
  expect(uploads.filter((step:any)=>step['continue-on-error']===true)).toEqual([diagnosticsUpload]);
 });
});
