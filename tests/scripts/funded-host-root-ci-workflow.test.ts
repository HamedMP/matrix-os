import { chmodSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const root = workflow.jobs["funded-host-root"];
const aggregate = workflow.jobs["ci-results"];

function executeRootStep(pullFails = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "funded-host-ci-images-")));
  try {
    const trace = join(dir, "docker-arguments");
    writeFileSync(trace, "");
    writeFileSync(join(dir, "docker"), [
      "#!/usr/bin/env bash",
      'printf "%s\\0" "$@" >> "$DOCKER_TRACE"',
      'printf "\\0" >> "$DOCKER_TRACE"',
      'if [[ "$1" == pull && "$PULL_FAILS" == true ]]; then exit 42; fi',
      "",
    ].join("\n"));
    writeFileSync(join(dir, "timeout"), '#!/usr/bin/env bash\nshift 2\nexec "$@"\n');
    chmodSync(join(dir, "docker"), 0o700);
    chmodSync(join(dir, "timeout"), 0o700);
    const step = root.steps.find((candidate: { name?: string }) =>
      candidate.name === "Execute isolated root fixtures without skipped cases");
    const result = spawnSync("bash", ["-eu", "-c", step.run], {
      cwd: dir, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", DOCKER_TRACE: trace,
        PULL_FAILS: String(pullFails) },
    });
    const calls = readFileSync(trace, "utf8").split("\0\0").filter(Boolean).map(call => call.split("\0"));
    return { status: result.status, calls, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("protected funded host disposable root CI", () => {
  it("pulls and runs the same Docker Official Image from ECR Public with fixture isolation", () => {
    const result = executeRootStep();
    const image = "public.ecr.aws/docker/library/node:24-bookworm";
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["pull", image],
      ["run", "--rm", "--init", "--name", "funded-host-root-123-2", "--network", "none",
        "--cpus", "2", "--memory", "2g", "--pids-limit", "256",
        "--env", "MATRIX_DISPOSABLE_ROOT_TEST=true",
        "--mount", `type=bind,src=${result.dir},dst=/work,readonly`,
        image, "python3", "-I", "/work/scripts/ci/run-funded-host-root-tests.py"],
      ["rm", "-f", "funded-host-root-123-2"],
    ]);
  });

  it("fails before root execution when the image pull fails and still cleans up", () => {
    const result = executeRootStep(true);
    expect(result.status).toBe(42);
    expect(result.calls.map(call => call[0])).toEqual(["pull", "rm"]);
    expect(result.calls[1]).toEqual(["rm", "-f", "funded-host-root-123-2"]);
  });

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
