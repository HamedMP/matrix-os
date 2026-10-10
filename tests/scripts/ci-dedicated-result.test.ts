import {describe,expect,it,vi} from "vitest";
import {waitForDedicatedResult} from "../../scripts/ci/dedicated-result.mjs";
const headSha="a".repeat(40),baseSha="b".repeat(40),sourceSha="c".repeat(40),controllerSha="d".repeat(40);
const expected={owner:"HamedMP",repo:"matrix-os",headSha,baseSha,sourceSha,prNumber:2440,serverUrl:"https://github.com"};
function fixture(change:Record<string,unknown>={}) {
  const summary={schemaVersion:1,suite:"qualification",headSha,baseSha,sourceSha,prNumber:2440,controllerSha,controllerRef:"refs/heads/main",controllerWorkflow:".github/workflows/ci-dedicated.yml",...change};
  const check={name:"Dedicated CI Results",head_sha:headSha,status:"completed",conclusion:"success",app:{slug:"github-actions"},details_url:"https://github.com/HamedMP/matrix-os/actions/runs/123",output:{summary:JSON.stringify(summary)}};
  const run={id:123,workflow_id:99,event:"pull_request_target",path:".github/workflows/ci-dedicated.yml@main",status:"completed",conclusion:"success",head_sha:controllerSha,repository:{full_name:"HamedMP/matrix-os"},head_repository:{full_name:"HamedMP/matrix-os"}};
  const github={rest:{checks:{listForRef:vi.fn(async()=>({data:{check_runs:[check]}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:99,path:".github/workflows/ci-dedicated.yml"}})),getWorkflowRun:vi.fn(async()=>({data:run})),listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440`,expired:false,size_in_bytes:1024,workflow_run:{id:123}}]}})),listJobsForWorkflowRun:vi.fn(async()=>({data:{jobs:[{name:"benchmark",status:"completed",conclusion:"success"}]}}))}}};
  return {github,check,run};
}
const options={maxAttempts:2,delay:async()=>{}};
describe("exact merge revision dedicated qualification evidence",()=>{
  it("accepts only completed default-branch controller run and qualification provenance",async()=>{
    const {github}=fixture(); await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
  });
  it.each([{sourceSha:"e".repeat(40)},{baseSha:"e".repeat(40)},{headSha:"e".repeat(40)},{prNumber:1},{suite:"unit"},{controllerRef:"refs/heads/untrusted"},{schemaVersion:2}])("rejects mismatched scope/revision provenance %j",async change=>{
    const {github}=fixture(change); await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
  });
  it.each(["workflow_id","event","path","head_sha","repository","head_repository"])("rejects an unauthenticated controller property %s",async field=>{
    const {github,run}=fixture(); Object.assign(run,{[field]:field.endsWith("repository")?{full_name:"other/repo"}:"untrusted"});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
  });
  it("rejects check substitution from a different app or remote details URL",async()=>{
    for(const patch of [{app:{slug:"other"}},{details_url:"https://other.invalid/actions/runs/123"},{head_sha:"e".repeat(40)}]) {
      const {github,check}=fixture(); Object.assign(check,patch); await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
    }
  });
  it("fails on authenticated controller, dispatch job or source-check failure",async()=>{
    for(const failure of ["check","run","job"]) {
      const {github,check,run}=fixture();
      if(failure==="check") check.conclusion="failure";
      if(failure==="run")run.conclusion="failure";
      if(failure==="job")github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{jobs:[{name:"benchmark",status:"completed",conclusion:"failure"}]}});
      await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("failed");
    }
  });
  it("waits for controller settlement and fails closed on missing evidence",async()=>{
    const {github,run}=fixture(); run.status="in_progress"; await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
    expect(github.rest.checks.listForRef).toHaveBeenCalledTimes(2);
  });
});

it('rejects checksummary spoofing without immutable same-run revision provenance',async()=>{
  for(const artifact of [undefined,{name:'wrong',expired:false,size_in_bytes:1024,workflow_run:{id:123}},{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440`,expired:true,size_in_bytes:1024,workflow_run:{id:123}},{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440`,expired:false,size_in_bytes:1024,workflow_run:{id:999}}]) {
    const {github}=fixture(); github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:artifact?[artifact]:[]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
  }
});
