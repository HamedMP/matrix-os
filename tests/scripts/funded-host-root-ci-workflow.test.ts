import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const root = workflow.jobs["funded-host-root"];
const aggregate = workflow.jobs["ci-results"];

describe("protected funded host disposable root CI", () => {
  it("isolates root execution, resource limits and checkout credentials", () => {
    expect(root.if).toContain("should_run == 'true'");
    expect(root["timeout-minutes"]).toBe(10);
    expect(root.permissions).toEqual({ contents: "read" });
    expect(root.steps[0].with["persist-credentials"]).toBe(false);
    const run = root.steps.find((step: { run?: string }) => step.run)?.run;
    expect(run).toContain("--network none");
    expect(run).toContain("--cpus 2 --memory 2g --pids-limit 256");
    expect(run).toContain("dst=/work,readonly");
    expect(run).toContain("MATRIX_DISPOSABLE_ROOT_TEST=true");
    expect(run).toContain("timeout --kill-after=10s 180s docker run");
    expect(run).toContain("docker rm -f");
    expect(run).toContain("python3 -I /work/scripts/ci/run-funded-host-root-tests.py");
    expect(aggregate.needs).toContain("funded-host-root");
  });

  it.each(["success", "failure", "cancelled", "skipped"])("requires actual root job success when result is %s", result => {
    const step = aggregate.steps.find((candidate: { name?: string }) => candidate.name === "Summarize required CI jobs");
    const dir = mkdtempSync(join(tmpdir(), "funded-host-ci-gate-"));
    try {
      const env = { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
      for (const name of Object.keys(step.env)) Object.assign(env, { [name]: "success" });
      Object.assign(env, { CI_TRIGGER_REQUESTED: "true", SHOULD_RUN: "true", FUNDED_HOST_ROOT_RESULT: result });
      const actual = spawnSync("bash", ["-c", step.run], { env, encoding: "utf8", timeout: 5_000 });
      expect(actual.status, actual.stderr).toBe(result === "success" ? 0 : 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
