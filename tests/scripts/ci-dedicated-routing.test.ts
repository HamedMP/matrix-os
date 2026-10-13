import {spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";
import {parse} from "yaml";
const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
describe('dedicated Linux routing preserves protected hosted contracts',()=>{
  it('routes only opted-in same-repository PRs and keeps all fallback events hosted',()=>{
    expect(ci.jobs.changes.outputs.dedicated_eligible).toContain('steps.route.outputs.eligible');
    const route=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route');
    expect(route.env).toEqual(expect.objectContaining({MATRIX_CI_DEDICATED_ENABLED:expect.any(String)}));
    expect(route.run).toContain('selectDedicatedRoute'); expect(route.run).toContain('pull:event.pull_request');
    expect(ci.on.pull_request.branches).toBeUndefined();
    expect(ci.on.pull_request.types).toEqual(expect.arrayContaining(['edited','reopened']));
  });
  it('delegates heavy Linux lanes but preserves funded/root/security and Node20 package compatibility',()=>{
    for(const job of ['typecheck','shell-production-build','agent-sdk-compatibility','unit','os-view-parity','e2e'])
      expect(ci.jobs[job].if).toContain("needs.changes.outputs.dedicated_eligible != 'true'");
    for(const job of ['patterns','react-doctor','funded-postgres','funded-host-root','sync-client'])
      expect(ci.jobs[job].if).not.toContain('dedicated_eligible');
  });
  it('uses a read-only waiter with exact synthetic merge SHA and no deployment secret',()=>{
    const job=ci.jobs['dedicated-linux'];
    expect(job.permissions).toEqual({actions:'read',checks:'read',contents:'read'});
    expect(job.if).toContain("dedicated_required == 'true'");
    const text=JSON.stringify(job);
    expect(text).toContain('requestingSnapshot(github,context'); expect(text).toContain('...context.repo,...snapshot,requestingRunId:context.runId');
    expect(text).not.toContain('secrets.'); expect(text).toContain('waitForDedicatedResult');
  });
  it('requires successful verified Linux result in CI Results whenever hosted lanes delegate',()=>{
    expect(ci.jobs['ci-results'].needs).toContain('dedicated-linux');
    const step=ci.jobs['ci-results'].steps[0];
    expect(step.env.DEDICATED_ELIGIBLE).toContain('needs.changes.outputs.dedicated_eligible');
    expect(step.run).toContain('"$DEDICATED_LINUX_RESULT" != "success"');
  });
});

describe('executable delegation and aggregate admission',()=>{
  it.each([
    ['true','true','pull_request','main','HamedMP/matrix-os',true],
    ['false','true','pull_request','main','HamedMP/matrix-os',false],
    ['true','false','pull_request','main','HamedMP/matrix-os',false],
    ['true','true','push','main','HamedMP/matrix-os',false],
    ['true','true','merge_group','main','HamedMP/matrix-os',false],
    ['true','true','pull_request','stack/base','HamedMP/matrix-os',true],
    ['true','true','pull_request','main','other/matrix-os',false],
  ])('routes optin=%s source=%s event=%s base=%s repo=%s correctly',(enabled,source,event,base,repo,expected)=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-linux-route-'));
    try{
      writeFileSync(resolve(dir,'event.json'),JSON.stringify({pull_request:{base:{ref:base,repo:{full_name:'HamedMP/matrix-os'}},head:{repo:{full_name:repo}},state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'fast-ci'}]}}));
      const script=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route').run;
      const body=script.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)![1];
      const env={...process.env,MATRIX_CI_DEDICATED_ENABLED:enabled,SHOULD_RUN:source,GITHUB_EVENT_NAME:event,GITHUB_REF:'refs/heads/fixture',MATRIX_CI_DEDICATED_SHADOW:'false',REFRESH_SNAPSHOT:'',GITHUB_REPOSITORY:'HamedMP/matrix-os',GITHUB_EVENT_PATH:resolve(dir,'event.json'),GITHUB_OUTPUT:resolve(dir,'output')};
      const execution=spawnSync(process.execPath,['--input-type=module','-e',body],{env,encoding:'utf8',timeout:10000});
      expect(execution.status,execution.stderr).toBe(0);
      expect(readFileSync(resolve(dir,'output'),'utf8').trim().split('\n')[0]).toBe(`eligible=${expected}`);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it.each([
    ['reopened','false','true',true],['reopened','false','false',false],
    ['edited','true','true',true],['edited','false','true',false],['edited','true','false',false],
    ['synchronize','false','true',true],['ready_for_review','false','false',true],
  ])('preserves ready-gated source classification for %s baseEdit=%s ready=%s',(action,baseEdit,ready,requested)=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-ci-stack-trigger-'));
    try{
      // Inert source discovery: exercise the real gating shell without network.
      writeFileSync(resolve(dir,'git'),'#!/bin/sh\nif [ "$1" = diff ]; then printf "%s\\n" "packages/kernel/src/index.ts"; fi\n',{mode:0o755});
      const step=ci.jobs.changes.steps.find((value:{id?:string})=>value.id==='changed');
      const env={...process.env,PATH:`${dir}:${process.env.PATH}`,GITHUB_EVENT_NAME:'pull_request',GITHUB_BASE_REF:'stack/parent',GITHUB_SHA:'a'.repeat(40),GITHUB_OUTPUT:resolve(dir,'output'),PR_ACTION:action,PR_BASE_EDIT:baseEdit,PR_HAS_READY_FOR_CI:ready,PR_LABEL_NAME:''};
      const execution=spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000});
      expect(execution.status,execution.stderr).toBe(0);
      const outputs=readFileSync(resolve(dir,'output'),'utf8');
      expect(outputs).toContain(`trigger_requested=${requested}`);
      expect(outputs).toContain(`should_run=${requested}`);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it.each(['success','failure','cancelled','skipped','unknown'])('aggregate accepts only verified dedicated success (%s)',outcome=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-linux-aggregate-'));
    try{
      const step=ci.jobs['ci-results'].steps[0];
      const env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')};
      for(const key of Object.keys(step.env))env[key]='success';
      Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'true',DEDICATED_REQUIRED:'true',DEDICATED_LINUX_RESULT:'skipped',CI_BACKEND_RESULT:outcome,CI_BACKEND_PROVIDER:'linux',INFRASTRUCTURE_FALLBACK:'false'});
      for(const key of ['TYPECHECK_RESULT','SHELL_PRODUCTION_BUILD_RESULT','AGENT_SDK_COMPATIBILITY_RESULT','UNIT_RESULT','DOCS_CONTRACT_RESULT','OS_VIEW_PARITY_RESULT','E2E_RESULT'])env[key]='skipped';
      const result=spawnSync('bash',['-c',step.run],{encoding:'utf8',env,timeout:10000});
      expect(result.status,result.stderr).toBe(outcome==='success'?0:1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

it('observes shadow qualification without letting it block the aggregate',()=>{
 const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
 expect(ci.jobs.changes.outputs.dedicated_required).toContain('steps.route.outputs.required');
 expect(ci.jobs['dedicated-linux'].if).toContain("dedicated_required == 'true'");
 const step=ci.jobs['ci-results'].steps[0];expect(step.env.DEDICATED_REQUIRED).toContain('needs.changes.outputs.dedicated_required');
 expect(step.env.DEDICATED_MODE).toBe("${{ vars.MATRIX_CI_DEDICATED_ENABLED == 'true' && 'delegated' || 'shadow' }}");
 expect(step.run).toContain('"$DEDICATED_REQUIRED" = "true"');
});
it.each([['shadow','failure',0],['shadow','skipped',0],['delegated','failure',1],['delegated','skipped',1],['delegated','success',0]])('aggregate with required Linux in %s mode and Linux %s exits %i',(mode,linux,code)=>{
 const dir=mkdtempSync(resolve(tmpdir(),'matrix-shadow-aggregate-'));
 try{const step=ci.jobs['ci-results'].steps[0],env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')};for(const key of Object.keys(step.env))env[key]='success';
 Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'true',DEDICATED_LINUX_RESULT:linux,DEDICATED_MODE:mode});
 expect(spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000}).status).toBe(code);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it.each([['shadow',false],['delegated',true]])('verifier in %s mode %s on missing Linux evidence',async(mode,throws)=>{
 const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
 const script=ci.jobs['dedicated-linux'].steps.find((step:{name:string})=>step.name==='Verify exact merge revision Linux outcome').with.script as string;
 const warnings:string[]=[],summary:string[]=[];
 const core={info:()=>{},warning:(m:string)=>warnings.push(m),summary:{addRaw:(m:string)=>{summary.push(m);return core.summary;},write:async()=>{}}};
 const loadHelper=async(url:string)=>url.endsWith('/dedicated-result.mjs')?{waitForDedicatedResult:async()=>{throw new Error('No verified dedicated Linux qualification completed within the bounded wait');}}:{requestingSnapshot:async()=>({sourceSha:'a'.repeat(40)})};
 const previous=process.env.MODE,workspace=process.env.GITHUB_WORKSPACE;process.env.MODE=mode;process.env.GITHUB_WORKSPACE=process.cwd();
 try{
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const run=new AsyncFunction('github','context','core','require','loadHelper',script.replaceAll('await import(','await loadHelper('));
  const result=run({},{repo:{owner:'HamedMP',repo:'matrix-os'},runId:1,serverUrl:'https://github.com'},core,require,loadHelper);
  if(throws)await expect(result).rejects.toThrow('bounded wait');
  else{await result;expect(warnings.join()).toContain('Shadow Linux qualification not verified');expect(summary.join()).toContain('bounded wait');}
 }finally{if(previous===undefined)delete process.env.MODE;else process.env.MODE=previous;if(workspace===undefined)delete process.env.GITHUB_WORKSPACE;else process.env.GITHUB_WORKSPACE=workspace;}
});
it.each(['true','false'])('runs all hosted lanes and no Linux waiter for hosted-only rollback with routing=%s',enabled=>{
 const dir=mkdtempSync(resolve(tmpdir(),'matrix-hosted-recovery-route-'));
 try{writeFileSync(resolve(dir,'event.json'),'{}');const body=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route').run.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)![1];
 const result=spawnSync(process.execPath,['--input-type=module','-e',body],{env:{...process.env,REFRESH_SNAPSHOT:JSON.stringify({executionMode:'hosted-only'}),MATRIX_CI_DEDICATED_ENABLED:enabled,MATRIX_CI_DEDICATED_SHADOW:'true',SHOULD_RUN:'true',GITHUB_EVENT_PATH:resolve(dir,'event.json'),GITHUB_OUTPUT:resolve(dir,'output')},encoding:'utf8',timeout:10000});expect(result.status,result.stderr).toBe(0);expect(readFileSync(resolve(dir,'output'),'utf8')).toBe('eligible=false\nrequired=false\n');
 const env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')},step=ci.jobs['ci-results'].steps[0];for(const key of Object.keys(step.env))env[key]='success';Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_LINUX_RESULT:'skipped',DOCS_CONTRACT_RESULT:'skipped'});expect(spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000}).status).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it.each(['success','skipped','failure','cancelled'])('hosted infrastructure recovery aggregate requires every delegated lane: %s',outcome=>{
 const dir=mkdtempSync(resolve(tmpdir(),'matrix-ci-infra-aggregate-'));
 try{const step=ci.jobs['ci-results'].steps[0],env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')};for(const key of Object.keys(step.env))env[key]='success';Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'true',DEDICATED_REQUIRED:'true',DEDICATED_LINUX_RESULT:'skipped',CI_BACKEND_RESULT:'success',CI_BACKEND_PROVIDER:'hosted',INFRASTRUCTURE_FALLBACK:'true',E2E_RESULT:outcome});
 expect(spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000}).status).toBe(outcome==='success'?0:1);
 env.INFRASTRUCTURE_FALLBACK='false';expect(spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000}).status).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

describe('shadow Linux failures outside the verifier script',()=>{
 it('keeps job-level failures non-blocking only in shadow mode',()=>{
  expect(ci.jobs['dedicated-linux']['continue-on-error']).toBe("${{ vars.MATRIX_CI_DEDICATED_ENABLED != 'true' }}");
 });
 const release=parse(readFileSync('.github/workflows/host-bundle-release.yml','utf8'));
 const gate=Object.values(release.jobs as Record<string,{steps?:{name:string,env?:Record<string,string>,run?:string}[]}>).flatMap(job=>job.steps??[]).find(step=>step.name==='Wait for CI on this commit')!;
 const failedJob=(shadow:string,jobs:unknown[])=>{
  const line=gate.run!.split('\n').find(value=>value.includes('failed_job='))!.trim();
  const result=spawnSync('bash',['-c',`set -euo pipefail\n${line}\nprintf '%s' "$failed_job"`],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH!,DEDICATED_SHADOW_ONLY:shadow,run_jobs:JSON.stringify({jobs})}});
  expect(result.status,result.stderr).toBe(0);return result.stdout;
 };
 it('aligns the host bundle release gate with the shadow policy',()=>{
  expect(gate.env!.DEDICATED_SHADOW_ONLY).toBe("${{ vars.MATRIX_CI_DEDICATED_ENABLED != 'true' }}");
  const linux={name:'Verified Dedicated Linux Qualification',conclusion:'failure'},unit={name:'Unit Tests (1/4)',conclusion:'success'};
  expect(failedJob('true',[linux,unit])).toBe('');
  expect(failedJob('false',[linux,unit])).toBe('Verified Dedicated Linux Qualification (failure)');
  expect(failedJob('true',[linux,{...unit,conclusion:'failure'}])).toBe('Unit Tests (1/4) (failure)');
 });
});
