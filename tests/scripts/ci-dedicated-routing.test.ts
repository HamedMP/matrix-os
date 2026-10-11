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
    expect(text).toContain('sourceSha: snapshot?.sourceSha || context.sha'); expect(text).toContain('baseSha: snapshot?.baseSha || pull.base.sha');
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
      writeFileSync(resolve(dir,'event.json'),JSON.stringify({pull_request:{base:{ref:base,repo:{full_name:'HamedMP/matrix-os'}},head:{repo:{full_name:repo}},state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'ci-linux'}]}}));
      const script=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route').run;
      const body=script.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)![1];
      const env={...process.env,MATRIX_CI_DEDICATED_ENABLED:enabled,SHOULD_RUN:source,GITHUB_EVENT_NAME:event,GITHUB_REPOSITORY:'HamedMP/matrix-os',GITHUB_EVENT_PATH:resolve(dir,'event.json'),GITHUB_OUTPUT:resolve(dir,'output')};
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
      Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'true',DEDICATED_REQUIRED:'true',DEDICATED_LINUX_RESULT:outcome});
      for(const key of ['TYPECHECK_RESULT','SHELL_PRODUCTION_BUILD_RESULT','AGENT_SDK_COMPATIBILITY_RESULT','UNIT_RESULT','DOCS_CONTRACT_RESULT','OS_VIEW_PARITY_RESULT','E2E_RESULT'])env[key]='skipped';
      const result=spawnSync('bash',['-c',step.run],{encoding:'utf8',env,timeout:10000});
      expect(result.status,result.stderr).toBe(outcome==='success'?0:1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

it('requires shadow qualification in the real aggregate while retaining every hosted lane',()=>{
 const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
 expect(ci.jobs.changes.outputs.dedicated_required).toContain('steps.route.outputs.required');
 expect(ci.jobs['dedicated-linux'].if).toContain("dedicated_required == 'true'");
 const step=ci.jobs['ci-results'].steps[0];expect(step.env.DEDICATED_REQUIRED).toContain('needs.changes.outputs.dedicated_required');
 expect(step.run).toContain('"$DEDICATED_REQUIRED" = "true"');
});
it.each(['true','false'])('runs all hosted lanes and no Linux waiter for hosted-only rollback with routing=%s',enabled=>{
 const dir=mkdtempSync(resolve(tmpdir(),'matrix-hosted-recovery-route-'));
 try{writeFileSync(resolve(dir,'event.json'),'{}');const body=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route').run.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)![1];
 const result=spawnSync(process.execPath,['--input-type=module','-e',body],{env:{...process.env,REFRESH_SNAPSHOT:JSON.stringify({executionMode:'hosted-only'}),MATRIX_CI_DEDICATED_ENABLED:enabled,MATRIX_CI_DEDICATED_SHADOW:'true',SHOULD_RUN:'true',GITHUB_EVENT_PATH:resolve(dir,'event.json'),GITHUB_OUTPUT:resolve(dir,'output')},encoding:'utf8',timeout:10000});expect(result.status,result.stderr).toBe(0);expect(readFileSync(resolve(dir,'output'),'utf8')).toBe('eligible=false\nrequired=false\n');
 const env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')},step=ci.jobs['ci-results'].steps[0];for(const key of Object.keys(step.env))env[key]='success';Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_LINUX_RESULT:'skipped',DOCS_CONTRACT_RESULT:'skipped'});expect(spawnSync('bash',['-c',step.run],{env,encoding:'utf8',timeout:10000}).status).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
