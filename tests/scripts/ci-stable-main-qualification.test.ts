import {describe,expect,it} from 'vitest';
import {admitDedicatedSource,verifyCurrentDedicatedSource,verifyDedicatedLeaseGrant,reconcileDedicatedChildren} from '../../scripts/ci/dedicated-admission.mjs';
import {decideCiBackend} from '../../scripts/ci/dedicated-backend.mjs';
import {reconcileSourceQualification} from '../../scripts/ci/dedicated-source-gate.mjs';
import {verifyMetadataCoverage} from '../../scripts/ci/metadata-result.mjs';
import {admitRefreshController} from '../../scripts/ci/dedicated-refresh.mjs';
import {pins,repo,stableMainFixture} from './helpers/stable-main-fixture';

describe('unchanged PR coverage survives main advancing',()=>{
 it('keeps the original event source when main advances before controller admission',async()=>{
  const f=stableMainFixture(),event=structuredClone(f.pull);f.advance();
  expect(await admitDedicatedSource(f.github,{repo,controller:f.origin,eventName:'pull_request_target',payload:{action:'synchronize',pull_request:event}})).toMatchObject({...f.snapshot,mergeParents:[pins.base,pins.head]});
 });
 it('accepts the tested source while the PR API still shows the previous main tip',async()=>{
  const f=stableMainFixture();f.github.rest.repos.getBranch.mockImplementation(async({branch})=>({data:{name:branch,commit:{sha:pins.advanced}}}));
  expect(await verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).toMatchObject({mergeParents:[pins.base,pins.head]});
 });
 it('admits the workflow-run requester even when GitHub updates its mutable PR base association',async()=>{
  const f=stableMainFixture();f.advance();f.ci.pull_requests[0].base.sha=pins.advanced;
  expect(await admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci})).toMatchObject({...f.snapshot,mergeParents:[pins.base,pins.head]});
 });
 it('exercises admission, host grant, renewal, immutable receipt, source gate and metadata with main moving during CI',async()=>{
  const f=stableMainFixture();
  const snapshot=await admitDedicatedSource(f.github,{repo,controller:f.origin,eventName:'pull_request_target',payload:{action:'synchronize',pull_request:structuredClone(f.pull)}});
  await verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request);
  f.advance();
  await verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request);
  f.run.status='completed';f.run.conclusion='success';
  expect(await decideCiBackend(f.github,{...repo,...snapshot,requestingRunId:321,requestingRunAttempt:1,controllerSha:pins.controller,imageDigest:f.request.imageDigest,harnessDigest:f.request.harnessDigest,mode:'delegated',serverUrl:'https://github.com'},{maxAttempts:1})).toMatchObject({provider:'linux',infrastructureFallback:false,controllerRunId:124});
  f.complete();
  await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
  const written=(f.gateGithub.rest.checks.update.mock.calls.at(-1)?.[0]??f.gateGithub.rest.checks.create.mock.calls.at(-1)![0]);
  expect(written).toMatchObject({check_run_id:f.provenance.id,conclusion:'success'});
  expect(JSON.parse(written.output.summary)).toMatchObject({baseSha:pins.base,sourceSha:pins.source,requestingRunId:321});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  expect(await reconcileDedicatedChildren(f.github,repo,f.origin,{prNumber:2454})).toMatchObject({invalidated:0});
  expect(await verifyMetadataCoverage(f.github,repo,{...f.snapshot,baseSha:pins.advanced,sourceSha:pins.newSource},400)).toEqual({runId:321,runAttempt:1,sourceSha:pins.source,baseSha:pins.base});
 });
 it.each(['head','target','draft','closed','label','foreign'])('still rejects a changed %s after main advances',async kind=>{
  const f=stableMainFixture();f.advance();
  if(kind==='head')f.pull.head.sha=pins.advanced;if(kind==='target')f.pull.base.ref='release/other';if(kind==='draft')f.pull.draft=true;if(kind==='closed')f.pull.state='closed';if(kind==='label')f.pull.labels=[];if(kind==='foreign')f.pull.head.repo.full_name='other/repo';
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow();
 });
 it.each(['behind','diverged','unknown'])('rejects main rewrites and incomplete ancestry (%s)',async status=>{
  const f=stableMainFixture();f.advance();f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({data:{status,merge_base_commit:{sha:pins.base}}});
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow();
 });
 it('keeps stacked-parent freshness strict',async()=>{
  const f=stableMainFixture();f.pull.base.ref='stack/parent';f.snapshot.baseRef='stack/parent';f.advance();
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow();
 });
 it('cannot relabel an old receipt as the new main merge',async()=>{
  const f=stableMainFixture();f.advance();f.complete();
  await expect(decideCiBackend(f.github,{...repo,...f.snapshot,baseSha:pins.advanced,sourceSha:pins.newSource,requestingRunId:321,requestingRunAttempt:1,controllerSha:pins.controller,imageDigest:f.request.imageDigest,harnessDigest:f.request.harnessDigest,mode:'delegated',serverUrl:'https://github.com'},{maxAttempts:1})).rejects.toThrow();
 });
 it.each(['failure','cancelled','pending'])('does not fall back past a newer %s request against a different main base',async outcome=>{
  const f=stableMainFixture();f.complete();f.advance();
  const newer={...f.ci,id:322,status:outcome==='pending'?'in_progress':'completed',conclusion:outcome==='pending'?null:outcome,display_title:`CI coverage-v1 · ${pins.newSource}`};
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async({workflow_id})=>({data:{workflow_runs:workflow_id===98?[newer,f.ci]:[f.run]}}));
  await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
  const written=(f.gateGithub.rest.checks.update.mock.calls.at(-1)?.[0]??f.gateGithub.rest.checks.create.mock.calls.at(-1)![0]);expect(written.conclusion).not.toBe('success');
  expect(written.status).toBe(outcome==='pending'?'in_progress':'completed');
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  await expect(verifyMetadataCoverage(f.github,repo,{...f.snapshot,baseSha:pins.advanced,sourceSha:pins.newSource},400)).rejects.toThrow();
 });
 it('does not grant an old request when a newer same-head/different-main request is queued',async()=>{
  const f=stableMainFixture();f.advance();const newer={...f.ci,id:322,status:'queued',display_title:`CI coverage-v1 · ${pins.newSource}`};
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async({workflow_id})=>({data:{workflow_runs:workflow_id===98?[newer,f.ci]:[f.run]}}));
  await expect(verifyDedicatedLeaseGrant(f.github,repo,f.origin,f.request)).rejects.toThrow(/newer|superseded/);
 });
 it('does not settle an old receipt when another main-base request supersedes it during verification',async()=>{
  const f=stableMainFixture();f.advance();f.complete();
  const newer={...f.ci,id:322,status:'queued',display_title:`CI coverage-v1 · ${pins.newSource}`};
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async({workflow_id})=>({data:{workflow_runs:workflow_id===98?[newer,f.ci]:[f.run]}}));
  await expect(decideCiBackend(f.github,{...repo,...f.snapshot,requestingRunId:321,requestingRunAttempt:1,controllerSha:pins.controller,imageDigest:f.request.imageDigest,harnessDigest:f.request.harnessDigest,mode:'delegated',serverUrl:'https://github.com'},{maxAttempts:1})).rejects.toThrow(/newer|superseded/);
 });
 it('writes a failed gate on API denial without dispatching or adopting older coverage',async()=>{
  const f=stableMainFixture();f.advance();f.complete();f.github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error('API denied'));
  await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
  expect((f.gateGithub.rest.checks.update.mock.calls.at(-1)?.[0]??f.gateGithub.rest.checks.create.mock.calls.at(-1)![0])).toMatchObject({conclusion:'failure'});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
});

it('rejects an old receipt superseded at the same main base',async()=>{
 const f=stableMainFixture();f.complete();
 const newer={...f.ci,id:322,status:'completed',conclusion:'failure',display_title:`CI coverage-v1 · ${pins.newSource}`};
 f.github.rest.actions.listWorkflowRuns.mockImplementation(async({workflow_id})=>({data:{workflow_runs:workflow_id===98?[newer,f.ci]:[f.run]}}));
 await expect(decideCiBackend(f.github,{...repo,...f.snapshot,requestingRunId:321,requestingRunAttempt:1,controllerSha:pins.controller,imageDigest:f.request.imageDigest,harnessDigest:f.request.harnessDigest,mode:'delegated',serverUrl:'https://github.com'},{maxAttempts:1})).rejects.toThrow(/newer|superseded/);
});
