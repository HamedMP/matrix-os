import {spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync,readFileSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";
import {parse} from "yaml";
const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
describe('dedicated Linux routing preserves protected hosted contracts',()=>{
  it('routes only opted-in same-repository main PRs and keeps all fallback events hosted',()=>{
    expect(ci.jobs.changes.outputs.dedicated_eligible).toContain('steps.route.outputs.eligible');
    const route=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route');
    expect(route.env).toEqual(expect.objectContaining({MATRIX_CI_DEDICATED_ENABLED:expect.any(String)}));
    expect(route.run).toContain('pull_request'); expect(route.run).toContain('main'); expect(route.run).toContain('head.repo');
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
    expect(job.if).toContain("dedicated_eligible == 'true'");
    const text=JSON.stringify(job);
    expect(text).toContain('sourceSha: context.sha'); expect(text).toContain('baseSha: context.payload.pull_request.base.sha');
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
    ['true','true','pull_request','stack/base','HamedMP/matrix-os',false],
    ['true','true','pull_request','main','other/matrix-os',false],
  ])('routes optin=%s source=%s event=%s base=%s repo=%s correctly',(enabled,source,event,base,repo,expected)=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-linux-route-'));
    try{
      writeFileSync(resolve(dir,'event.json'),JSON.stringify({pull_request:{base:{ref:base},head:{repo:{full_name:repo}},state:'open',draft:false,labels:[{name:'ready-for-ci'}]}}));
      const script=ci.jobs.changes.steps.find((step:{id?:string})=>step.id==='route').run;
      // Execute the actual embedded admission body in the existing Node runtime;
      // a fresh Node binary startup adds no coverage to this pure decision.
      const body=script.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)![1]
        .replace(/^import \{readFileSync, appendFileSync\} from 'node:fs';\n/,'');
      const env={MATRIX_CI_DEDICATED_ENABLED:enabled,SHOULD_RUN:source,GITHUB_EVENT_NAME:event,GITHUB_REPOSITORY:'HamedMP/matrix-os',GITHUB_EVENT_PATH:resolve(dir,'event.json'),GITHUB_OUTPUT:resolve(dir,'output')};
      new Function('process','readFileSync','appendFileSync',body)({env},readFileSync,appendFileSync);
      expect(readFileSync(resolve(dir,'output'),'utf8').trim()).toBe(`eligible=${expected}`);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it.each(['success','failure','cancelled','skipped','unknown'])('aggregate accepts only verified dedicated success (%s)',outcome=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-linux-aggregate-'));
    try{
      const step=ci.jobs['ci-results'].steps[0];
      const env:Record<string,string>={PATH:process.env.PATH!,GITHUB_STEP_SUMMARY:resolve(dir,'summary')};
      for(const key of Object.keys(step.env))env[key]='success';
      Object.assign(env,{CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'true',DEDICATED_ELIGIBLE:'true',DEDICATED_LINUX_RESULT:outcome});
      for(const key of ['TYPECHECK_RESULT','SHELL_PRODUCTION_BUILD_RESULT','AGENT_SDK_COMPATIBILITY_RESULT','UNIT_RESULT','DOCS_CONTRACT_RESULT','OS_VIEW_PARITY_RESULT','E2E_RESULT'])env[key]='skipped';
      const result=spawnSync('bash',['-c',step.run],{encoding:'utf8',env,timeout:10000});
      expect(result.status,result.stderr).toBe(outcome==='success'?0:1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
