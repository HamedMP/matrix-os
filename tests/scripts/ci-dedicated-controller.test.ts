import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
