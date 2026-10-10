import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("dedicated controller timeout budgets", () => {
  it("covers host lock admission, execution, artifact transfers, and settlement", () => {
    const host = readFileSync("scripts/ci/runner/start-ephemeral.sh", "utf8");
    const workflow = parse(readFileSync(".github/workflows/ci-dedicated.yml", "utf8"));
    const job = workflow.jobs.benchmark;
    const dispatch = job.steps.find((step: { id?: string }) => step.id === "dispatch").run;
    const lockWait = Number(host.match(/flock -w (\d+) /)![1]);
    const [, executionKill, executionWait] = host.match(/--kill-after=(\d+)s (\d+)s[\s\\]+docker exec/)!.map(Number);
    const [, transferKill, transferWait] = host.match(/--kill-after=(\d+)s (\d+)s docker exec --user 10001:10001 "\$container" \/usr\/bin\/tar /)!.map(Number);
    const artifactCount = host.match(/for file in ([^;]+); do/)![1].trim().split(/\s+/).length;
    const [, sshKill, sshWait] = dispatch.match(/--kill-after=(\d+)s (\d+)s ssh/)!.map(Number);
    const boundedHostPhases = lockWait + executionWait + executionKill + artifactCount * (transferWait + transferKill);
    // Leave room for SSH setup and bounded log collection, then for artifact
    // upload and the API call settling the source-head check.
    expect(sshWait).toBeGreaterThanOrEqual(boundedHostPhases + 120);
    expect(job["timeout-minutes"] * 60).toBeGreaterThanOrEqual(sshWait + sshKill + 240);
  });
});
