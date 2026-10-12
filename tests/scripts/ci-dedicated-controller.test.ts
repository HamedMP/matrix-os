import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { parse } from "yaml";

describe("dedicated controller timeout budgets", () => {
  it("covers host lock admission, execution, artifact transfers, and settlement", () => {
    const host = readFileSync("scripts/ci/runner/start-ephemeral.sh", "utf8");
    const workflow = parse(readFileSync(".github/workflows/ci-dedicated.yml", "utf8"));
    const job = workflow.jobs.benchmark;
    const client = readFileSync("scripts/ci/dedicated-ssh.mjs", "utf8");
    const lockWait = Number(host.match(/flock -w (\d+) /)![1]);
    const [, executionKill, executionWait] = host.match(/--kill-after=(\d+)s (\d+)s[\s\\]+docker exec/)!.map(Number);
    const [, transferKill, transferWait] = host.match(/--kill-after=(\d+)s (\d+)s docker exec --user 10001:10001 "\$container" \/usr\/bin\/tar /)!.map(Number);
    const artifactCount = host.match(/for file in ([^;]+); do/)![1].trim().split(/\s+/).length;
    const sshWait = Number(client.match(/maxMilliseconds\?\?([0-9_]+)/)![1].replaceAll("_", "")) / 1000;
    const sshKill = 20;
    const boundedHostPhases = lockWait + executionWait + executionKill + artifactCount * (transferWait + transferKill);
    // Leave room for SSH setup and bounded log collection, then for artifact
    // upload and the API call settling the source-head check.
    expect(sshWait).toBeGreaterThanOrEqual(boundedHostPhases + 120);
    expect(job["timeout-minutes"] * 60).toBeGreaterThanOrEqual(sshWait + sshKill + 240);
  });
});

it('retains the executable controller URL when settling a failed dispatch check',async()=>{
 const source='a'.repeat(40),parent='b'.repeat(40),runId=123;
 const env={GITHUB_WORKSPACE:process.cwd(),SOURCE_KIND:'main',SOURCE_SHA:source,HEAD_SHA:source,
  BASE_SHA:parent,BASE_REF:'main',PR_NUMBER:'0',MERGE_PARENTS:JSON.stringify([parent]),
  DISPATCH_OUTCOME:'failure',QUALIFICATION_VERIFIED:'false',CHECK_ID:'456',
  INFRASTRUCTURE_PROOF:'',CONFIGURATION_APP_ID:'1',CONFIGURATION_INSTALLATION_ID:'2',
  CONFIGURATION_PRIVATE_KEY:'test-only-unused'};
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},runId,serverUrl:'https://github.com',payload:{repository:{id:3}}};
 const job=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.benchmark;
 const script=job.steps.find((s:{name:string})=>s.name==='Settle source-head check').with.script;
 const program=`import {createRequire} from 'node:module';
 const require=createRequire(import.meta.url),source=${JSON.stringify(source)},parent=${JSON.stringify(parent)};
 Object.assign(process.env,${JSON.stringify(env)});
 const context=${JSON.stringify(context)},calls=[];
 const github={rest:{repos:{getBranch:async()=>({data:{name:'main',commit:{sha:source}}}),
 getCommit:async()=>({data:{sha:source,parents:[{sha:parent}],commit:{tree:{sha:source}}}})},
 checks:{update:async value=>{calls.push(value);return{};}},actions:{listRepoVariables:()=>{throw Error('Unexpected API request');}}}};
 const core={setSecret:()=>{},warning:()=>{},setFailed:()=>{throw Error('Unexpected revalidation failure');}};
 await(async()=>{${script}})();console.log(JSON.stringify(calls));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{timeout:10_000,maxBuffer:16_384});
 expect(JSON.parse(stdout)).toEqual([expect.objectContaining({check_run_id:456,conclusion:'failure',
  details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123'})]);
});

it('binds actual ordered parents through admission, signed dispatch and final settlement',()=>{
 const job=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.benchmark;
 const admission=job.steps.find((s:{id?:string})=>s.id==='admit');
 const dispatch=job.steps.find((s:{id?:string})=>s.id==='dispatch');
 const settlement=job.steps.find((s:{name?:string})=>s.name==='Settle source-head check');
 expect(admission.with.script).toContain("merge_parent_sha:admission.mergeParents?.[0]");
 expect(dispatch.with.script).toContain('mergeParents:JSON.parse(data.merge_parents)' );
 expect(settlement.env.MERGE_PARENT_SHA).toContain('steps.admit.outputs.merge_parent_sha');
 expect(settlement.with.script).toContain("mergeParents:JSON.parse(process.env.MERGE_PARENTS||'[]')");
 expect(JSON.stringify(job)).not.toContain('mergeParents:[data.base_sha,data.head_sha]');
});

describe('duplicate controllers that lose the newest-controller race',()=>{
 const job=()=>parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.benchmark as {env:Record<string,string>,steps:{name:string,id?:string,env?:Record<string,string>,with:{script:string}}[]};
 const steps=()=>job().steps;
 const workspaces:string[]=[];
 afterEach(async()=>{const {rm}=await import('node:fs/promises');await Promise.all(workspaces.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
 const step=(name:string)=>steps().find(s=>s.name===name)!;
 const context={repo:{owner:'HamedMP',repo:'matrix-os'},runId:123,serverUrl:'https://github.com',ref:'refs/heads/main',eventName:'workflow_run',payload:{repository:{id:3}}};
 async function stubWorkspace(admission:string,lease:string,grant=''){
  const {mkdtemp,mkdir,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'matrix-ci-race-'));workspaces.push(root);await mkdir(join(root,'scripts/ci'),{recursive:true});
  await writeFile(join(root,'scripts/ci/dedicated-admission.mjs'),`export async function admitDedicatedSource(){${admission}}
export async function newestRequestingCiRun(){return null;}
export async function verifyCurrentDedicatedSource(){${admission}}
export async function dispatchDedicatedLease(){${lease}}
export async function verifyDedicatedLeaseGrant(){${grant}}`);
  await writeFile(join(root,'scripts/ci/dedicated-config-token.mjs'),`export function createConfigurationSession(){return{github:{},close:async()=>{}};}`);
  await writeFile(join(root,'scripts/ci/dedicated-outcome.mjs'),`export function validInfrastructureProof(){return false;}`);
  return root;
 }
 async function execute(name:string,workspace:string,env:Record<string,string>={}){
  const program=`import {createRequire} from 'node:module';
  const require=createRequire(import.meta.url);
  Object.assign(process.env,${JSON.stringify({...job().env,GITHUB_WORKSPACE:workspace,SNAPSHOT:JSON.stringify({sha:'a'.repeat(40),head_sha:'a'.repeat(40),base_sha:'b'.repeat(40),base_ref:'main',pr_number:'0',source_kind:'main',merge_parents:JSON.stringify(['b'.repeat(40)]),requesting_run_id:'1',requesting_run_attempt:'1',mode:'shadow'}),...env})});
  const context=${JSON.stringify(context)},outputs={},calls=[],notices=[];
  const github={rest:{checks:{update:async value=>{calls.push(value);return{};},create:async()=>{throw Error('Unexpected check creation');}}}};
  const core={setOutput:(k,v)=>{outputs[k]=String(v);},notice:m=>notices.push(m),info:()=>{},setSecret:()=>{},warning:()=>{},setFailed:m=>{throw Error('setFailed '+m);}};
  await(async()=>{${step(name).with.script}})();console.log(JSON.stringify({outputs,calls,notices}));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{timeout:10_000,maxBuffer:65_536,cwd:workspace});
  return JSON.parse(stdout) as {outputs:Record<string,string>,calls:Record<string,any>[],notices:string[]};
 }
 it.each(['Dedicated qualification revision or admission is stale','Current main source is stale','Main moved during source attestation'])('stands down before creating a check when admission lost the race: %s',async message=>{
  const root=await stubWorkspace(`throw new Error(${JSON.stringify(message)});`,'');
  const result=await execute('Admit current source head',root);
  expect(result.outputs.admitted).toBe('false');expect(result.notices.join()).toContain(message);
 });
 it('lists only errors the pinned helpers actually throw',()=>{
  const errors=JSON.parse(job().env.RACE_LOST_ERRORS) as string[];
  const helpers=['dedicated-admission','dedicated-lease','dedicated-main'].map(name=>readFileSync(`scripts/ci/${name}.mjs`,'utf8')).join('\n');
  for(const message of errors)expect(helpers,message).toContain(`throw new Error('${message}')`);
 });
 it('settles neutral when a newer controller appears during final settlement',async()=>{
  const root=await stubWorkspace('return {};','',`throw new Error('A newer controller superseded this lease');`);
  const result=await execute('Settle source-head check',root,{CHECK_ID:'456',SOURCE_KIND:'main',PR_NUMBER:'0',MERGE_PARENTS:'[]',DISPATCH_OUTCOME:'success',QUALIFICATION_VERIFIED:'true',LEASE_REQUEST:'{}'});
  expect(result.calls).toEqual([expect.objectContaining({check_run_id:456,conclusion:'neutral'})]);
  expect(JSON.parse(result.calls[0].output.summary)).toMatchObject({receiptVerified:false,superseded:true});
 });
 it('still fails settlement when final revalidation hits an unrelated error',async()=>{
  const root=await stubWorkspace('throw new Error("Invalid main commit proof");','');
  await expect(execute('Settle source-head check',root,{CHECK_ID:'456',SOURCE_KIND:'main',PR_NUMBER:'0',MERGE_PARENTS:'[]',DISPATCH_OUTCOME:'failure'})).rejects.toThrow('setFailed Current PR revision could not be revalidated');
 });
 it.each(['A newer controller superseded this lease','A newer requesting CI attempt superseded this lease'])('marks dispatch superseded on %s',async message=>{
  const root=await stubWorkspace('return {};',`throw new Error(${JSON.stringify(message)});`);
  const result=await execute('Dispatch authenticated PR qualification lease',root);
  expect(result.outputs.superseded).toBe('true');expect(result.outputs.verified).toBeUndefined();
 });
 it('still fails dispatch on an unrelated error',async()=>{
  const root=await stubWorkspace('return {};',`throw new Error('Pinned host key mismatch');`);
  await expect(execute('Dispatch authenticated PR qualification lease',root)).rejects.toThrow('Pinned host key mismatch');
 });
 it('settles a superseded controller check as neutral without receipt credit',async()=>{
  const root=await stubWorkspace('throw new Error("revalidation must be skipped");','');
  const result=await execute('Settle source-head check',root,{SUPERSEDED:'true',CHECK_ID:'456',SOURCE_KIND:'main',PR_NUMBER:'0',MERGE_PARENTS:'[]',DISPATCH_OUTCOME:'success',QUALIFICATION_VERIFIED:''});
  expect(result.calls).toEqual([expect.objectContaining({check_run_id:456,conclusion:'neutral',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123'})]);
  expect(JSON.parse(result.calls[0].output.summary)).toMatchObject({receiptVerified:false,superseded:true});
  expect(step('Settle source-head check').env!.SUPERSEDED).toContain('steps.dispatch.outputs.superseded');
 });
});
