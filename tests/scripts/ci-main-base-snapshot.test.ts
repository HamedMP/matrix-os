import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parse} from 'yaml';
import {describe,expect,it,vi} from 'vitest';
import {admitDedicatedSource,verifyCurrentDedicatedSource,verifyDedicatedLeaseGrant} from '../../scripts/ci/dedicated-admission.mjs';
import * as admissionHelpers from '../../scripts/ci/dedicated-admission.mjs';
import {mainPrCoverage,mainPrSourceBindings} from '../../scripts/ci/dedicated-main-pr.mjs';
import {decideCiBackend,requestingSnapshot} from '../../scripts/ci/dedicated-backend.mjs';
import {authenticatedControllerRun,admitRefreshController} from '../../scripts/ci/dedicated-refresh.mjs';
import {reconcileSourceQualification} from '../../scripts/ci/dedicated-source-gate.mjs';
import {verifyMetadataCoverage} from '../../scripts/ci/metadata-result.mjs';
import {pins,repo,stableMainFixture} from './helpers/stable-main-fixture';

// Real API shape seen on #2514/#2612: pull.base.sha retains an older snapshot
// while merge_commit_sha points to a generated merge with a newer main parent.
function storedBaseLags(){
 const f=stableMainFixture();f.pull.base.sha='1'.repeat(40);
 f.github.rest.checks.listForRef.mockImplementation(async({check_name})=>({data:{check_runs:check_name==='CI Source Qualification'?[]:[f.check]}}));
 return f;
}

describe('canonical main merge with an older stored PR base',()=>{
 it('authenticates the GitHub canonical source using its actual ordered parents, without historical credit',async()=>{
  const f=storedBaseLags();
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).resolves.toMatchObject({mergeParents:[pins.base,pins.head]});
  expect(f.github.rest.checks.listForRef).not.toHaveBeenCalled();
 });
 it('journals the actual canonical main parent instead of the stored PR base',async()=>{
  const f=storedBaseLags();
  await expect(mainPrSourceBindings(f.github,repo,f.pull,null)).resolves.toEqual([{baseSha:pins.base,sourceSha:pins.source}]);
 });
 it('does not wait for historical provenance when the requester still uses the canonical source',async()=>{
  const f=storedBaseLags();
  await expect(mainPrCoverage(f.github,repo,f.snapshot,{waitForProvenance:true,provenanceDelay:async()=>{}})).resolves.toMatchObject({snapshot:{baseSha:pins.base,sourceSha:pins.source}});
  expect(f.github.rest.checks.listForRef).not.toHaveBeenCalled();
 });
 it('freezes actual ordered parents at trusted PR event admission without rewriting a lease later',async()=>{
  const f=storedBaseLags();
  await expect(admitDedicatedSource(f.github,{repo,controller:f.origin,eventName:'pull_request_target',payload:{action:'ready_for_review',pull_request:structuredClone(f.pull)}})).resolves.toMatchObject({...f.snapshot,mergeParents:[pins.base,pins.head]});
 });
 it('grants the unchanged exact request even when the stored PR base lags',async()=>{
  const f=storedBaseLags();
  await expect(verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request)).resolves.toBeUndefined();
 });
 it('binds the actual ordinary PR event requester and native PTR controller to the admitted source',async()=>{
  const f=storedBaseLags(),event=structuredClone(f.pull);
  f.run.display_title=`dedicated-ci-v2 pr=${event.number} head=${event.head.sha} base=${event.base.sha} requested=true`;
  const admitted=await admitDedicatedSource(f.github,{repo,controller:f.origin,eventName:'pull_request_target',payload:{action:'ready_for_review',pull_request:event}});
  const requested=await requestingSnapshot(f.github,{repo,eventName:'pull_request',sha:pins.source,payload:{pull_request:event}},null);
  expect(requested).toMatchObject({...f.snapshot,mergeParents:[pins.base,pins.head]});
  expect(authenticatedControllerRun(f.run,repo,{...admitted,requestingRunId:321},{id:99},'child')).toBe(true);
  await expect(verifyCurrentDedicatedSource(f.github,repo,requested)).resolves.toMatchObject({mergeParents:[pins.base,pins.head]});
  await expect(verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request)).resolves.toBeUndefined();
 });
 it('keeps refresh input immutable and rejects a changed head in an ordinary PR requester',async()=>{
  const f=storedBaseLags(),context={repo,eventName:'pull_request',sha:pins.source,payload:{pull_request:structuredClone(f.pull)}};
  await expect(requestingSnapshot(f.github,context,f.snapshot)).resolves.toBe(f.snapshot);
  f.pull.head.sha=pins.advanced;
  await expect(requestingSnapshot(f.github,context,null)).rejects.toThrow(/stale/);
 });
 it('keeps the event source through renewal, receipt verification and final requester verification after main advances',async()=>{
  const f=storedBaseLags(),event=structuredClone(f.pull),context={repo,eventName:'pull_request',sha:pins.source,payload:{pull_request:event}};
  f.run.display_title=`dedicated-ci-v2 pr=2454 head=${pins.head} base=${event.base.sha} requested=true`;
  const admitted=await requestingSnapshot(f.github,context,null);
  await verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request);
  f.advance();
  f.github.rest.checks.listForRef.mockImplementation(async({check_name})=>({data:{check_runs:check_name==='CI Source Qualification'?[f.provenance]:[f.check]}}));
  await verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request);
  f.run.status='completed';f.run.conclusion='success';
  await expect(decideCiBackend(f.github,{...repo,...admitted,requestingRunId:321,requestingRunAttempt:1,controllerSha:pins.controller,imageDigest:f.request.imageDigest,harnessDigest:f.request.harnessDigest,mode:'delegated',serverUrl:'https://github.com'},{maxAttempts:1})).resolves.toMatchObject({provider:'linux',infrastructureFallback:false,controllerRunId:124});
  await expect(requestingSnapshot(f.github,context,null)).resolves.toMatchObject({...f.snapshot,mergeParents:[pins.base,pins.head]});
  expect(f.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({basehead:`${pins.base}...${pins.advanced}`}));
 });
 it('executes the workflow pre-dispatch check for a canonical source without historical provenance',async()=>{
  const f=storedBaseLags(),workflow=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
  const step=workflow.jobs.benchmark.steps.find((value:{id?:string})=>value.id==='current');
  const core={setOutput:vi.fn(),notice:vi.fn()};
  const env={GITHUB_WORKSPACE:process.cwd(),RACE_LOST_ERRORS:'[]',SNAPSHOT:JSON.stringify({sha:pins.source,head_sha:pins.head,base_sha:pins.base,base_ref:'main',pr_number:'2454',merge_parents:JSON.stringify([pins.base,pins.head])})};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const loadHelper=async(url:string)=>{expect(url).toBe(new URL('../../scripts/ci/dedicated-admission.mjs',import.meta.url).href);return admissionHelpers;};
  await new AsyncFunction('require','process','github','context','core','loadHelper',step.with.script.replace('await import(','await loadHelper('))(createRequire(import.meta.url),{env},f.github,{repo},core,loadHelper);
  expect(core.setOutput).toHaveBeenCalledWith('current','true');
  expect(f.github.rest.checks.listForRef).not.toHaveBeenCalled();
 });
 it('admits a canonical explicit refresh without waiting for a historical journal',async()=>{
  const f=storedBaseLags();Object.assign(f.ci,{event:'workflow_dispatch',head_branch:'main',head_sha:pins.controller,pull_requests:[],display_title:`CI refresh-v1 pr=2454 head=${pins.head} base=${pins.base} merge=${pins.source}`});
  await expect(admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci},{provenanceDelay:async()=>{}})).resolves.toMatchObject(f.snapshot);
  expect(f.github.rest.checks.listForRef).not.toHaveBeenCalled();
 });
 it('retains strict non-main PTR marker matching and rejects altered controller identities',()=>{
  const f=storedBaseLags(),scope={...f.snapshot,requestingRunId:321};
  f.run.display_title=`dedicated-ci-v2 pr=2454 head=${pins.head} base=${f.pull.base.sha} requested=true`;
  expect(authenticatedControllerRun(f.run,repo,{...scope,baseRef:'parent'},{id:99},'child')).toBe(false);
  for(const change of [{head_sha:pins.advanced},{head_branch:'other'},{head_repository:{full_name:'foreign/repo'}},{display_title:f.run.display_title.replace('requested=true','requested=false')},{display_title:f.run.display_title.replace('pr=2454','pr=2455')}])expect(authenticatedControllerRun({...f.run,...change},repo,scope,{id:99},'child')).toBe(false);
 });
 it('reuses genuine hosted coverage for metadata without another branch update',async()=>{
  const f=storedBaseLags();f.complete();
  await expect(verifyMetadataCoverage(f.github,repo,f.snapshot,400)).resolves.toMatchObject({runId:321,baseSha:pins.base,sourceSha:pins.source});
 });
 it('dispatches fresh exact-source CI with the actual merge parent when coverage is missing',async()=>{
  const f=storedBaseLags();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
  f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[]}});
  await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({inputs:expect.objectContaining({base_sha:pins.base,source_sha:pins.source,head_sha:pins.head})}));
 });
 it('records a trusted event source by its actual parents after the live canonical merge changes',async()=>{
  const f=storedBaseLags(),event=structuredClone(f.pull);f.advance();
  await expect(mainPrSourceBindings(f.github,repo,f.pull,null,event)).resolves.toEqual([{baseSha:pins.base,sourceSha:pins.source},{baseSha:pins.advanced,sourceSha:pins.newSource}]);
 });
 it('keeps a mismatched immutable request red instead of substituting the actual parent',async()=>{
  const f=storedBaseLags();
  await expect(verifyCurrentDedicatedSource(f.github,repo,{...f.snapshot,baseSha:f.pull.base.sha})).rejects.toThrow(/parents/);
 });
 it('still requires protected provenance for a source that is no longer canonical',async()=>{
  const f=storedBaseLags();f.advance();
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow(/provenance/);
 });
 it('rejects a canonical pointer whose ordered merge parents do not bind the current head',async()=>{
  const f=storedBaseLags();f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:pins.source,parents:[{sha:pins.base},{sha:pins.advanced}]}});
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow(/parents/);
 });
 it('rejects an actual merge parent that is no longer an ancestor of main',async()=>{
  const f=storedBaseLags();f.advance();f.pull.merge_commit_sha=pins.source;
  f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({data:{status:'diverged',merge_base_commit:{sha:'9'.repeat(40)}}});
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow(/ancestor/);
 });
});
