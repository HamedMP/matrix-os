import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import * as provenanceHelpers from '../../scripts/ci/dedicated-main-provenance.mjs';
import * as outcomeHelpers from '../../scripts/ci/dedicated-outcome.mjs';
import * as admissionHelpers from '../../scripts/ci/dedicated-admission.mjs';
import * as configurationHelpers from '../../scripts/ci/dedicated-config-token.mjs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {parse} from 'yaml';
const nodeRequire=createRequire(import.meta.url);
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),controller='d'.repeat(40);
function workflow(){return parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));}
async function execute(name:string,github:unknown,context:unknown,core:unknown,helperOverrides:Record<string,unknown>={}) {
 const source=workflow().jobs.benchmark.steps.find((step:{name:string})=>step.name===name).with.script;
 // Vitest's VM has no native dynamic-import callback. Inject only that loader,
 // checking the actual workflow-resolved path and executing the real helper.
 const script=source.replaceAll('await import(', 'await loadHelper(');
 const loadHelper=async (url:string)=>{const files={'scripts/ci/dedicated-main-provenance.mjs':provenanceHelpers,'scripts/ci/dedicated-admission.mjs':admissionHelpers,'scripts/ci/dedicated-outcome.mjs':outcomeHelpers,'scripts/ci/dedicated-config-token.mjs':configurationHelpers,...helperOverrides};for(const [file,helpers]of Object.entries(files))if(url===pathToFileURL(resolve(process.cwd(),file)).href)return helpers;throw new Error('Unexpected protected workflow helper path');};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 return new AsyncFunction('github','context','core','require','loadHelper',script)(github,context,core,nodeRequire,loadHelper);
}
async function admit(overrides:Record<string,unknown>={},ref='refs/heads/main') {
 vi.stubEnv('CONTROLLER_SHA',controller);vi.stubEnv('RACE_LOST_ERRORS',workflow().jobs.benchmark.env.RACE_LOST_ERRORS);vi.stubEnv('INPUT_SHA','');vi.stubEnv('GITHUB_WORKSPACE',process.cwd());vi.stubEnv('CONTROLLER_ATTEMPT','1');vi.stubEnv('MATRIX_CI_DEDICATED_ENABLED','true');vi.stubEnv('IMAGE_DIGEST','sha256:'+'e'.repeat(64));vi.stubEnv('HARNESS_DIGEST','f'.repeat(64));
 vi.stubEnv('CONTROLLER_WORKFLOW_REF','HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main');
 const original={number:2440,base:{ref:'main',sha:base,repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge,state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'fast-ci'}],head:{sha:head,repo:{full_name:'HamedMP/matrix-os'}}};
 const pull={...structuredClone(original),...overrides};
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull}))},repos:{getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:base}}})),getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[{id:77,run_attempt:1,workflow_id:98,event:'pull_request',path:'.github/workflows/ci.yml',head_sha:head,status:'in_progress',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI coverage-v1 · ${merge}`,pull_requests:[{number:2440,head:{sha:head},base:{sha:base,ref:'main'}}]}]}}))},checks:{create:vi.fn(async(_args:{output:{summary:string}})=>({data:{id:123}})),update:vi.fn(async(_args:{conclusion:string})=>({data:{}}))}}};
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},sha:controller,ref,eventName:'pull_request_target',payload:{repository:{id:42},action:'synchronize',pull_request:original},serverUrl:'https://github.com',runId:1};
 const outputs:Record<string,string>={};
 const core={setOutput:(key:string,value:string)=>outputs[key]=value,warning:vi.fn(),notice:vi.fn(),setFailed:vi.fn()};
 await execute('Admit current source head',github,context,core);
 return{outputs,github,pull,context,core};
}
afterEach(()=>vi.unstubAllEnvs());
describe('dedicated CI trusted dispatcher integration',()=>{
 it('attaches pending tuple provenance to the exact admitted source head',async()=>{
  const {outputs,github}=await admit();
  expect(outputs).toEqual({sha:merge,source_kind:'',merge_parents:JSON.stringify([base,head]),head_sha:head,base_sha:base,base_ref:'main',merge_parent_sha:base,pr_number:'2440',check_id:'123',admitted:'true',mode:'delegated',requesting_run_id:'77',requesting_run_attempt:'1'});
  const args=github.rest.checks.create.mock.calls[0][0];
  expect(args).toMatchObject({head_sha:head,status:'in_progress',name:'Dedicated CI Results'});
  expect(JSON.parse(args.output.summary)).toMatchObject({schemaVersion:3,baseRef:'main',controllerSha:controller,controllerRef:'refs/heads/main',controllerRunId:1,controllerAttempt:1});
 });
 it.each([{state:'closed'},{base:{ref:'other',sha:base,repo:{full_name:'HamedMP/matrix-os'}}},{draft:true},{labels:[]},{head:{sha:base,repo:{full_name:'HamedMP/matrix-os'}}},{head:{sha:head,repo:{full_name:'other/matrix-os'}}}])('rejects an obsolete or unadmitted snapshot %j',async patch=>{
  const {outputs,github}=await admit(patch);
  expect(outputs).toEqual({admitted:'false'});expect(github.rest.checks.create).not.toHaveBeenCalled();expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
 });
 it.each([{merge_commit_sha:null},{merge_commit_sha:'e'.repeat(40)}])('retains the immutable event source despite a later mutable merge %j',async patch=>{
  const f=await admit(patch);expect(f.outputs).toMatchObject({admitted:'true',sha:merge,base_sha:base});
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
  expect(ssh.with.script).toContain('dispatchDedicatedLease');const client=readFileSync('scripts/ci/dedicated-ssh.mjs','utf8');expect(client).toContain('StrictHostKeyChecking=yes');expect(client).toContain('IdentitiesOnly=yes');expect(client).toContain('lease-v1 run');expect([...client.matchAll(/spawn\('([^']+)'/g)].map(match=>match[1])).toEqual(['/usr/bin/ssh','/usr/bin/ssh']);
 });
 it('subscribes to retarget/reopen and gate invalidation without claiming remote cancellation',()=>{
  const value=workflow();expect(value.on.pull_request_target.types).toEqual(expect.arrayContaining(['edited','reopened','closed','unlabeled','converted_to_draft']));
  const text=readFileSync('.github/workflows/ci-dedicated.yml','utf8');expect(text).toContain('dispatch fresh main-defined CI');expect(text).toContain('the root lease kills owned CPU');
 });
 it('revalidates after admission and refuses dispatch when the target branch changes',async()=>{
  const {outputs,github,pull,context,core}=await admit();vi.stubEnv('SNAPSHOT',JSON.stringify(outputs));
  await execute('Revalidate exact PR snapshot before dispatch',github,context,core);expect(outputs.current).toBe('true');
  pull.base.ref='another-parent';delete outputs.current;
  // A retarget stands the controller down: no dispatch credit, neutral settlement.
  await execute('Revalidate exact PR snapshot before dispatch',github,context,core);
  expect(outputs.current).toBeUndefined();expect(outputs.superseded).toBe('true');
 });
 it.each(['success','failure','skipped'])('settles dispatch %s without treating skipped work as success',async outcome=>{
  const {outputs,github,context,core}=await admit();
  for(const [key,value] of Object.entries({CHECK_ID:outputs.check_id,HEAD_SHA:head,MERGE_PARENT_SHA:base,MERGE_PARENTS:JSON.stringify([base,head]),BASE_SHA:base,BASE_REF:'main',PR_NUMBER:'2440',SOURCE_SHA:merge,DISPATCH_OUTCOME:outcome,SUITE:'qualification'}))vi.stubEnv(key,value);
  await execute('Settle source-head check',github,context,core);
  expect(github.rest.checks.update.mock.calls[0][0].conclusion).toBe('failure'); // Exit-only or missing receipt evidence can never qualify.
 });
 it('settles a successful execution whose source became stale as neutral without receipt credit',async()=>{
  const {outputs,github,pull,context,core}=await admit();pull.base.ref='another-parent';
  for(const [key,value] of Object.entries({CHECK_ID:outputs.check_id,HEAD_SHA:head,MERGE_PARENT_SHA:base,MERGE_PARENTS:JSON.stringify([base,head]),BASE_SHA:base,BASE_REF:'main',PR_NUMBER:'2440',SOURCE_SHA:merge,DISPATCH_OUTCOME:'success',SUITE:'qualification'}))vi.stubEnv(key,value);
  await execute('Settle source-head check',github,context,core);
  expect(core.setFailed).not.toHaveBeenCalled();const settled=github.rest.checks.update.mock.calls[0][0];
  expect(settled.conclusion).toBe('neutral');expect(JSON.parse(settled.output.summary)).toMatchObject({superseded:true,receiptVerified:false});
 });
 it('completes the source check as failed when credential cleanup fails',async()=>{
  const {outputs,github,context,core}=await admit();
  for(const [key,value] of Object.entries({CHECK_ID:outputs.check_id,HEAD_SHA:head,MERGE_PARENTS:JSON.stringify([base,head]),BASE_SHA:base,BASE_REF:'main',PR_NUMBER:'2440',SOURCE_SHA:merge,DISPATCH_OUTCOME:'failure',SUITE:'qualification'}))vi.stubEnv(key,value);
  const close=vi.fn().mockRejectedValue(new Error('sensitive revocation request headers'));
  await execute('Settle source-head check',github,context,core,{'scripts/ci/dedicated-config-token.mjs':{createConfigurationSession:()=>({github,close})}});
  expect(close).toHaveBeenCalledOnce();expect(core.setFailed).toHaveBeenCalledWith('Configuration read token revocation failed');
  expect(github.rest.checks.update).toHaveBeenCalledOnce();expect(github.rest.checks.update.mock.calls[0][0]).toMatchObject({status:'completed',conclusion:'failure'});
 });
 it('keeps title edits and unrelated label removal from superseding active qualification',()=>{
  const group=workflow().concurrency.group;
  expect(group).toContain("github.event.changes.base == null");
  expect(group).toContain("github.event.label.name != 'ready-for-ci'");
 });
 // GitHub expression subset used by the non-admitting predicate. GitHub compares strings
 // case-insensitively and this evaluator does not; repository labels are lowercase and
 // admission (admittedPull) requires their exact case.
 const js=(expression:string)=>expression.replace(/contains\(github\.event\.pull_request\.labels\.\*\.name, ('[^']+')\)/g,'github.event.pull_request.labels.map((l:any)=>l.name).includes($1)').replace(/:any/g,'').replaceAll('github.event.label.name','github.event.label?.name').replaceAll('github.event.changes.base','github.event.changes?.base');
 const nonAdmitting=()=>{
  const group=workflow().concurrency.group as string;
  const body=group.slice(group.indexOf('}}-${{ ')+7,group.lastIndexOf(" && github.run_id || 'shared' }}"));
  expect(body.startsWith("(github.event_name == 'pull_request_target' && (")).toBe(true);
  return body;
 };
 it('uses one non-admitting predicate for the group, the requested flag and both jobs',()=>{
  const value=workflow(),predicate=nonAdmitting();
  expect(value['run-name']).toContain(`github.event_name == 'pull_request_target' && !${predicate} && (`);
  expect(value.jobs.benchmark.if).toContain(`github.ref == 'refs/heads/main' && !${predicate} && (`);
  expect(value.jobs.reconcile.if).toContain(`github.ref == 'refs/heads/main' && !${predicate} && (`);
 });
 it.each([
  // [event, action, label, labels after the event, base edit, isolated, requested flag]
  ['pull_request_target','labeled','fast-ci',['fast-ci'],false,true,'false'],
  ['pull_request_target','labeled','ready-for-ci',['fast-ci','ready-for-ci'],false,false,'true'],
  ['pull_request_target','labeled','fast-ci',['ready-for-ci','fast-ci'],false,false,'true'],
  ['pull_request_target','labeled','preview-vps',['fast-ci','ready-for-ci','preview-vps'],false,true,'false'],
  ['pull_request_target','labeled','ready-for-ci',['ready-for-ci'],false,true,'false'],
  ['pull_request_target','unlabeled','preview-vps',['fast-ci','ready-for-ci'],false,true,'false'],
  ['pull_request_target','unlabeled','fast-ci',['ready-for-ci'],false,false,'false'],
  ['pull_request_target','unlabeled','ready-for-ci',['fast-ci'],false,false,'false'],
  ['pull_request_target','edited',null,['fast-ci','ready-for-ci'],false,true,'false'],
  ['pull_request_target','edited',null,['fast-ci','ready-for-ci'],true,false,'true'],
  ['pull_request_target','opened',null,['fast-ci','ready-for-ci'],false,false,'true'],
  ['pull_request_target','synchronize',null,['fast-ci','ready-for-ci'],false,false,'true'],
  ['pull_request_target','closed',null,['fast-ci','ready-for-ci'],false,false,'false'],
  ['pull_request_target','converted_to_draft',null,['fast-ci','ready-for-ci'],false,false,'false'],
  ['workflow_run','requested',null,[],false,false,'false'],
  ['workflow_run','completed',null,[],false,false,'false'],
  ['schedule',null,null,[],false,false,'false'],
  ['push',null,null,[],false,false,'false'],
 ])('%s %s %s (labels %j) is isolated only when it cannot admit, and is then never requested',(eventName,action,label,labels,baseEdit,isolated,expectedFlag)=>{
  // A superseded run shows as a cancelled red benchmark and reconcile on the PR head.
  const github={event_name:eventName,run_id:'4242',event:{action,label:label?{name:label}:undefined,changes:{base:baseEdit?{ref:{from:'main'}}:null},pull_request:{labels:labels.map(name=>({name}))}}};
  const predicate=nonAdmitting();
  expect(new Function('github',`return (${js(predicate)});`)(github)).toBe(isolated);
  const marker=workflow()['run-name'] as string;const requested=marker.slice(marker.lastIndexOf("github.event_name == 'pull_request_target' && !(")).replace(/\) \}\}$/,'');
  const flag=new Function('github',`return (${js(requested)});`)(github);
  expect(flag).toBe(expectedFlag);
  if(isolated)expect(flag).toBe('false');
 });
 it.each(['fast-ci','ready-for-ci'])('isolates the %s event when both admission labels are added to a draft together',label=>{
  const github={event_name:'pull_request_target',run_id:'4242',event:{action:'labeled',label:{name:label},pull_request:{draft:true,labels:[{name:'fast-ci'},{name:'ready-for-ci'}]}}};
  expect(new Function('github',`return (${js(nonAdmitting())});`)(github)).toBe(true);
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
  const marker=workflow()['run-name'];const expression=js(marker.slice(marker.lastIndexOf("github.event_name == 'pull_request_target' && !(")).replace(/\) \}\}$/, ''));
  const github={event_name:eventName,event:{action,changes:{base:baseEdit?{ref:{from:'main'}}:null},pull_request:{labels:[{name:'fast-ci'},{name:'ready-for-ci'}]}}};
  expect(new Function('github',`return (${expression});`)(github)).toBe(requested);
 });
 it('binds immutable evidence names to the current controller rerun attempt',()=>{
  const value=workflow();const upload=value.jobs.benchmark.steps.find((step:{name:string})=>step.name==='Upload immutable qualification provenance');
  expect(upload.with.name).toContain('-attempt${{ github.run_attempt }}');
  expect(upload.with.name).toContain('-request${{ steps.admit.outputs.requesting_run_id }}-${{ steps.admit.outputs.requesting_run_attempt }}');expect(upload.with.path).toBe('output/ci-dedicated/receipt.json');
 });
});

it('keeps shadow canaries hosted and leaves priority admission to the host queue',()=>{
 const value=workflow(),job=value.jobs.benchmark;
 expect(job.if).toContain("vars.MATRIX_CI_DEDICATED_SHADOW == 'true'");
 expect(job.concurrency).toBeUndefined();
 expect(value.concurrency.group).toContain("github.event.label.name != 'fast-ci'");
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
 const core={setOutput:vi.fn()},github={rest:{repos:{getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:controller}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:controller}}}))}}};
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
it('restricts App keys to authenticated main helpers and creates a checks-only separate gate client',()=>{
 const value=workflow(),job=value.jobs.reconcile;expect(job.environment).toBe('matrix-ci');expect(job.permissions.checks).toBe('read');
 const token=job.steps.find((step:{id?:string})=>step.id==='gate-token');expect(token.uses).toBe('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349');expect(token.with).toEqual(expect.objectContaining({'app-id':'${{ vars.MATRIX_CI_GATE_APP_ID }}','private-key':'${{ secrets.MATRIX_CI_GATE_APP_PRIVATE_KEY }}',owner:'${{ github.repository_owner }}',repositories:'${{ github.event.repository.name }}','permission-checks':'write'}));expect(Object.keys(token.with).filter(key=>key.startsWith('permission-'))).toEqual(['permission-checks']);
 const gate=job.steps.find((step:{name?:string})=>step.name==='Reconcile completed child source checks');expect(gate.env.GATE_TOKEN).toBe('${{ steps.gate-token.outputs.token }}');expect(gate.with.script).toContain('new github.constructor({auth:process.env.GATE_TOKEN');expect(gate.with.script).toContain('gateGithub');expect(gate.with.script).toContain('gateAppId');
 const benchmark=value.jobs.benchmark;expect(benchmark.if).toContain("github.ref == 'refs/heads/main'");expect(benchmark.steps.filter((step:any)=>JSON.stringify(step).includes('MATRIX_CI_GATE_APP_PRIVATE_KEY')).map((step:any)=>step.name)).toEqual(['Dispatch authenticated PR qualification lease','Settle source-head check']);expect(JSON.stringify(benchmark)).not.toContain('GATE_TOKEN');expect(JSON.stringify(parse(readFileSync('.github/workflows/ci.yml','utf8')))).not.toContain('GATE_TOKEN');
});

it.each(['Authenticate reviewed controller pin before helper or secret use','Authenticate default-main reconciliation source'])('rejects renamed branch in workflow bootstrap %s',async name=>{
 const all=Object.values(workflow().jobs).flatMap((job:any)=>job.steps);
 const step:any=all.find((step:any)=>step.name===name);
 vi.stubEnv('CONTROLLER_SHA',controller);vi.stubEnv('CONTROLLER_WORKFLOW_REF','HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main');
 const github={rest:{repos:{getBranch:vi.fn(async()=>({data:{name:'renamed',commit:{sha:controller}}})),compareCommitsWithBasehead:vi.fn()}}};
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},ref:'refs/heads/main',sha:controller},core={setOutput:vi.fn()};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 await expect(new AsyncFunction('github','context','core',step.with.script)(github,context,core)).rejects.toThrow(/branch identity/);
 expect(github.rest.repos.compareCommitsWithBasehead).not.toHaveBeenCalled();expect(core.setOutput).not.toHaveBeenCalled();
});

it.each(['head','target','draft','closed','labels'])('stands down before waiting for provenance when %s changes after admission',async kind=>{
 const f=await admit();vi.stubEnv('SNAPSHOT',JSON.stringify(f.outputs));
 if(kind==='head')f.pull.head.sha='e'.repeat(40);if(kind==='target')f.pull.base.ref='another-parent';if(kind==='draft')f.pull.draft=true;if(kind==='closed')f.pull.state='closed';if(kind==='labels')f.pull.labels=[];
 f.pull.merge_commit_sha='f'.repeat(40);
 await execute('Revalidate exact PR snapshot before dispatch',f.github,f.context,f.core);
 expect(f.outputs.superseded).toBe('true');expect(f.outputs.current).toBeUndefined();
 expect(f.core.setFailed).not.toHaveBeenCalled();
});
