import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

it('binds actual ordered parents through admission, signed dispatch and final settlement',()=>{
 const job=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.benchmark;
 const admission=job.steps.find((s:{id?:string})=>s.id==='admit');
 const dispatch=job.steps.find((s:{id?:string})=>s.id==='dispatch');
 const settlement=job.steps.find((s:{name?:string})=>s.name==='Settle source-head check');
 expect(admission.with.script).toContain("merge_parent_sha:admission.mergeParents?.[0]");
 expect(dispatch.with.script).toContain('mergeParents:[data.merge_parent_sha,data.head_sha]');
 expect(settlement.env.MERGE_PARENT_SHA).toContain('steps.admit.outputs.merge_parent_sha');
 expect(settlement.with.script).toContain('mergeParents:[process.env.MERGE_PARENT_SHA,process.env.HEAD_SHA]');
 expect(JSON.stringify(job)).not.toContain('mergeParents:[data.base_sha,data.head_sha]');
});
