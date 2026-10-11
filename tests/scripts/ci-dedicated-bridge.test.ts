import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import * as admissionHelpers from '../../scripts/ci/dedicated-admission.mjs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {parse} from 'yaml';
const nodeRequire=createRequire(import.meta.url);
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),controller='d'.repeat(40);
function workflow(){return parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));}
async function execute(name:string,github:unknown,context:unknown,core:unknown) {
 const source=workflow().jobs.benchmark.steps.find((step:{name:string})=>step.name===name).with.script;
 // Vitest's VM has no native dynamic-import callback. Inject only that loader,
 // checking the actual workflow-resolved path and executing the real helper.
 const script=source.replace('await import(', 'await loadHelper(');
 const loadHelper=async (url:string)=>{expect(url).toBe(pathToFileURL(resolve(process.cwd(),'scripts/ci/dedicated-admission.mjs')).href);return admissionHelpers;};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 return new AsyncFunction('github','context','core','require','loadHelper',script)(github,context,core,nodeRequire,loadHelper);
}
async function admit(overrides:Record<string,unknown>={},ref='refs/heads/main') {
 vi.stubEnv('CONTROLLER_SHA',controller);vi.stubEnv('INPUT_SHA','');vi.stubEnv('GITHUB_WORKSPACE',process.cwd());vi.stubEnv('CONTROLLER_ATTEMPT','1');vi.stubEnv('MATRIX_CI_DEDICATED_ENABLED','true');vi.stubEnv('IMAGE_DIGEST','sha256:'+'e'.repeat(64));vi.stubEnv('HARNESS_DIGEST','f'.repeat(64));
 vi.stubEnv('CONTROLLER_WORKFLOW_REF','HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main');
 const original={number:2440,base:{ref:'main',sha:base,repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge,state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'ci-linux'}],head:{sha:head,repo:{full_name:'HamedMP/matrix-os'}}};
 const pull={...structuredClone(original),...overrides};
 const github={rest:{git:{getRef:vi.fn(async()=>({data:{object:{sha:base}}}))},pulls:{get:vi.fn(async()=>({data:pull}))},repos:{getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[{id:77,run_attempt:1,workflow_id:98,event:'pull_request',path:'.github/workflows/ci.yml',head_sha:head,status:'in_progress',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI coverage-v1 · ${merge}`,pull_requests:[{number:2440,head:{sha:head},base:{sha:base,ref:'main'}}]}]}}))},checks:{create:vi.fn(async(_args:{output:{summary:string}})=>({data:{id:123}})),update:vi.fn(async(_args:{conclusion:string})=>({data:{}}))}}};
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},sha:controller,ref,eventName:'pull_request_target',payload:{action:'synchronize',pull_request:original},serverUrl:'https://github.com',runId:1};
 const outputs:Record<string,string>={};
 const core={setOutput:(key:string,value:string)=>outputs[key]=value,warning:vi.fn(),setFailed:vi.fn()};
 await execute('Admit current source head',github,context,core);
 return{outputs,github,pull,context,core};
}
afterEach(()=>vi.unstubAllEnvs());
describe('dedicated CI trusted dispatcher integration',()=>{
 it('attaches pending tuple provenance to the exact admitted source head',async()=>{
  const {outputs,github}=await admit();
  expect(outputs).toEqual({sha:merge,head_sha:head,base_sha:base,base_ref:'main',pr_number:'2440',check_id:'123',admitted:'true',mode:'delegated',requesting_run_id:'77',requesting_run_attempt:'1'});
  const args=github.rest.checks.create.mock.calls[0][0];
  expect(args).toMatchObject({head_sha:head,status:'in_progress',name:'Dedicated CI Results'});
  expect(JSON.parse(args.output.summary)).toMatchObject({schemaVersion:3,baseRef:'main',controllerSha:controller,controllerRef:'refs/heads/main',controllerAttempt:1});
 });
 it.each([{state:'closed'},{base:{ref:'other',sha:base,repo:{full_name:'HamedMP/matrix-os'}}},{draft:true},{labels:[]},{head:{sha:base,repo:{full_name:'HamedMP/matrix-os'}}},{head:{sha:head,repo:{full_name:'other/matrix-os'}}}])('rejects an obsolete or unadmitted snapshot %j',async patch=>{
  const {outputs,github}=await admit(patch);
  expect(outputs).toEqual({admitted:'false'});expect(github.rest.checks.create).not.toHaveBeenCalled();expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
 });
 it.each([{merge_commit_sha:null},{merge_commit_sha:'e'.repeat(40)}])('rejects unavailable or mismatched merge provenance %j',async patch=>{
  await expect(admit(patch)).rejects.toThrow(/merge commit|Merge commit/i);
 });
 it('rejects a controller outside default main before creating a source check',async()=>{
  await expect(admit({},'refs/heads/stack/parent')).rejects.toThrow(/default.branch/);
 });
 it('checks out only controller-owned helper bytes at the immutable default SHA',()=>{
  const value=workflow(),job=value.jobs.benchmark;
  expect(value.on.pull_request_target.branches).toBeUndefined();expect(value.on.pull_request).toBeUndefined();
  expect(job.environment).toBe('matrix-ci');expect(job.if).toContain("github.ref == 'refs/heads/main'");expect(job.if).toContain("vars.MATRIX_CI_DEDICATED_ENABLED == 'true'");
  expect(value.permissions).toEqual({actions:'write',contents:'read',checks:'write','pull-requests':'read'});
  const checkouts=job.steps.filter((step:{uses?:string})=>step.uses?.startsWith('actions/checkout'));
  expect(checkouts).toHaveLength(1);expect(checkouts[0].with).toEqual({ref:'${{ vars.MATRIX_CI_CONTROLLER_SHA }}','persist-credentials':false,'sparse-checkout':'scripts/ci'});
  expect(JSON.stringify(checkouts)).not.toContain('pull_request');
  const ssh=job.steps.find((step:{id?:string})=>step.id==='dispatch');
  expect(ssh.if).toContain("steps.current.outputs.current == 'true'");
  expect(ssh.with.script).toContain('dispatchDedicatedLease');const client=readFileSync('scripts/ci/dedicated-ssh.mjs','utf8');expect(client).toContain('StrictHostKeyChecking=yes');expect(client).toContain('IdentitiesOnly=yes');expect(client).toContain('lease-v1 run');
 });
 it('subscribes to retarget/reopen and gate invalidation without claiming remote cancellation',()=>{
  const value=workflow();expect(value.on.pull_request_target.types).toEqual(expect.arrayContaining(['edited','reopened','closed','unlabeled','converted_to_draft']));
  const text=readFileSync('.github/workflows/ci-dedicated.yml','utf8');expect(text).toContain('dispatch fresh main-defined CI');expect(text).toContain('the root lease kills owned CPU');
 });
 it('revalidates after admission and refuses dispatch when the parent moved',async()=>{
  const {outputs,github,pull,context,core}=await admit();vi.stubEnv('SNAPSHOT',JSON.stringify(outputs));
  await execute('Revalidate exact PR snapshot before dispatch',github,context,core);expect(outputs.current).toBe('true');
  pull.base.sha='e'.repeat(40);
  await expect(execute('Revalidate exact PR snapshot before dispatch',github,context,core)).rejects.toThrow(/stale/);
 });
 it.each(['success','failure','skipped'])('settles dispatch %s without treating skipped work as success',async outcome=>{
  const {outputs,github,context,core}=await admit();
  for(const [key,value] of Object.entries({CHECK_ID:outputs.check_id,HEAD_SHA:head,BASE_SHA:base,BASE_REF:'main',PR_NUMBER:'2440',SOURCE_SHA:merge,DISPATCH_OUTCOME:outcome,SUITE:'qualification'}))vi.stubEnv(key,value);
  await execute('Settle source-head check',github,context,core);
  expect(github.rest.checks.update.mock.calls[0][0].conclusion).toBe('failure'); // Exit-only or missing receipt evidence can never qualify.
 });
 it('fails settlement and logs revalidation failure when successful execution became stale',async()=>{
  const {outputs,github,pull,context,core}=await admit();pull.base.ref='another-parent';
  for(const [key,value] of Object.entries({CHECK_ID:outputs.check_id,HEAD_SHA:head,BASE_SHA:base,BASE_REF:'main',PR_NUMBER:'2440',SOURCE_SHA:merge,DISPATCH_OUTCOME:'success',SUITE:'qualification'}))vi.stubEnv(key,value);
  await execute('Settle source-head check',github,context,core);
  expect(core.warning).toHaveBeenCalledOnce();expect(core.setFailed).toHaveBeenCalledOnce();expect(github.rest.checks.update.mock.calls[0][0].conclusion).toBe('failure');
 });
 it('keeps title edits and unrelated label removal from superseding active qualification',()=>{
  const group=workflow().concurrency.group;
  expect(group).toContain("github.event.changes.base == null");
  expect(group).toContain("github.event.label.name != 'ready-for-ci'");
 });
 it('publishes immutable source request identity before admission can start',()=>{
  const marker=workflow()['run-name'];
  expect(marker).toContain('dedicated-ci-v2 pr={0} head={1} base={2} requested={3}');
  expect(marker).toContain('github.event.pull_request.head.sha || github.sha');
  expect(marker).toContain("github.event.pull_request.base.sha || 'manual'");
  expect(marker).toContain('github.event.changes.base != null');
 });
 it.each([
  ['pull_request_target','opened',false,'true'],['pull_request_target','synchronize',false,'true'],['pull_request_target','reopened',false,'true'],
  ['pull_request_target','edited',true,'true'],['pull_request_target','edited',false,'false'],
  ['pull_request_target','unlabeled',false,'false'],['pull_request_target','closed',false,'false'],
  ['pull_request_target','converted_to_draft',false,'false'],['workflow_dispatch','synchronize',false,'false'],
 ])('marks only source request events before admission (%s/%s)',(eventName,action,baseEdit,requested)=>{
  const marker=workflow()['run-name'];const expression=marker.slice(marker.lastIndexOf("github.event_name == 'pull_request_target'")).replace(/\) \}\}$/, '');
  const github={event_name:eventName,event:{action,changes:{base:baseEdit?{ref:{from:'main'}}:null}}};
  expect(new Function('github',`return (${expression});`)(github)).toBe(requested);
 });
 it('binds immutable evidence names to the current controller rerun attempt',()=>{
  const value=workflow();const upload=value.jobs.benchmark.steps.find((step:{name:string})=>step.name==='Upload immutable qualification provenance');
  expect(upload.with.name).toContain('-attempt${{ github.run_attempt }}');
  expect(upload.with.name).toContain('-request${{ steps.admit.outputs.requesting_run_id }}-${{ steps.admit.outputs.requesting_run_attempt }}');expect(upload.with.path).toBe('output/ci-dedicated/receipt.json');
 });
});

it('keeps independent shadow canaries hosted while globally queueing all Linux dispatches',()=>{
 const value=workflow(),job=value.jobs.benchmark;
 expect(job.if).toContain("vars.MATRIX_CI_DEDICATED_SHADOW == 'true'");
 expect(job.concurrency).toEqual({group:'matrix-ci-linux-dispatch',queue:'max','cancel-in-progress':false});
 expect(value.concurrency.group).toContain("github.event.label.name != 'ci-linux'");
});

it('dispatches PR qualification through the two-phase authenticated lease and never settles exit-only evidence',()=>{
 const steps=workflow().jobs.benchmark.steps;
 const dispatch=steps.find((s:{id?:string})=>s.id==='dispatch');
 expect(dispatch.with?.script).toContain('dispatchDedicatedLease');
 expect(dispatch.with?.script).toContain('requestingRunId:');
 expect(dispatch.with?.script).toContain('harnessDigest:');
 expect(steps.find((s:{name:string})=>s.name==='Settle source-head check').with.script).toContain("process.env.QUALIFICATION_VERIFIED === 'true'");
});
it('boots the all-PR N/A reconciler from authenticated main without execution configuration',async()=>{
 const value=workflow().jobs.reconcile,origin=value.steps[0];const source=origin.with.script;
 vi.stubEnv('CONTROLLER_SHA','');vi.stubEnv('CONTROLLER_WORKFLOW_REF','HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main');
 const core={setOutput:vi.fn()},github={rest:{git:{getRef:vi.fn(async()=>({data:{object:{sha:controller}}}))},repos:{compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:controller}}}))}}};
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},ref:'refs/heads/main',sha:controller};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 await new AsyncFunction('github','context','core',source)(github,context,core);
 expect(core.setOutput).toHaveBeenCalledWith('controller_sha',controller);
 const checkout=value.steps.find((step:{uses?:string})=>step.uses?.startsWith('actions/checkout'));
 expect(checkout.with.ref).toBe('${{ steps.origin.outputs.controller_sha }}');
 expect(workflow().jobs.benchmark.steps.find((step:{uses?:string})=>step.uses?.startsWith('actions/checkout')).with.ref).toBe('${{ vars.MATRIX_CI_CONTROLLER_SHA }}');
});

it('supersedes obsolete CI for arbitrary parent branch names without executing that branch',()=>{
 const value=parse(readFileSync('.github/workflows/ci-pr-supersede.yml','utf8'));
 expect(value.on.pull_request_target.branches).toBeUndefined();expect(value.jobs.supersede.steps.every((step:{uses:string})=>!step.uses.startsWith('actions/checkout'))).toBe(true);
});
