import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOSTED_LABEL, POOL_LABEL, selectPoolRunner } from "../../scripts/ci/select-runner.mjs";

const now = 1_800_000_000;
const fresh = (idle: number, age = 30) => `${now - age} ${idle}`;
const select = (overrides: Partial<Parameters<typeof selectPoolRunner>[0]> = {}) =>
  selectPoolRunner({
    heartbeat: fresh(4), now, eventName: "pull_request", headRepository: "HamedMP/matrix-os", repository: "HamedMP/matrix-os",
    ...overrides,
  });

describe("source runner selection", () => {
  it("admits trusted source with four idle slots and allows seven jobs to queue", () => {
    expect(select()).toBe(POOL_LABEL);
    expect(select({ heartbeat: fresh(6) })).toBe(POOL_LABEL);
    expect(select({ eventName: "push", headRepository: "" })).toBe(POOL_LABEL);
    expect(select({ eventName: "merge_group", headRepository: "" })).toBe(POOL_LABEL);
  });

  it.each([
    ["a fork PR", { headRepository: "someone/matrix-os" }],
    ["a PR without repository identity", { headRepository: "", repository: "" }],
    // Exact-source refresh dispatches run on main but can check out a fork PR's merge.
    ["a manual dispatch", { eventName: "workflow_dispatch", headRepository: "" }],
    ["an unknown event", { eventName: undefined }],
    ["a missing heartbeat", { heartbeat: undefined }],
    ["a malformed heartbeat", { heartbeat: "online" }],
    ["a heartbeat without an idle count", { heartbeat: String(now) }],
    ["a stale heartbeat", { heartbeat: fresh(4, 181) }],
    ["a heartbeat from the future", { heartbeat: fresh(4, -61) }],
    ["too few idle slots", { heartbeat: fresh(3) }],
  ])("stays on hosted runners for %s", (_, overrides) => {
    expect(select(overrides)).toBe(HOSTED_LABEL);
  });

  it("routes unit, pattern and browser jobs through the same trusted-source decision", () => {
    const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"));
    const routed = Object.entries(workflow.jobs as Record<string, { "runs-on": string }>)
      .filter(([, job]) => job["runs-on"] !== "ubuntu-latest" && !String(job["runs-on"]).startsWith("ubuntu-"))
      .map(([id]) => id);
    expect(routed).toEqual(["patterns", "unit", "e2e"]);
    expect(workflow.jobs.patterns["runs-on"]).toBe("${{ needs.changes.outputs.source_runner }}");
    expect(workflow.jobs.e2e["runs-on"]).toBe("${{ needs.changes.outputs.browser_runner }}");
    expect(workflow.jobs.changes.outputs.browser_runner).toBe("${{ steps.runner.outputs.browser_runner || 'ubuntu-24.04' }}");
    expect(workflow.jobs.unit["runs-on"]).toBe("${{ needs.changes.outputs.source_runner }}");
    expect(workflow.jobs.unit.needs).toBe("changes");
    expect(workflow.jobs.changes.outputs.source_runner).toBe("${{ steps.runner.outputs.source_runner || 'ubuntu-latest' }}");
    const step = workflow.jobs.changes.steps.find((s: { id?: string }) => s.id === "runner");
    expect(step.env.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(step.env.HEAD_REPOSITORY).toBe("${{ github.event.pull_request.head.repo.full_name }}");
    expect(step.env.REPOSITORY).toBe("${{ github.repository }}");
    // One worker per two CPUs; more starves the gateway build inside customer-vps-runtime-loader.
    const test = workflow.jobs.unit.steps.find((s: { run?: string }) => s.run?.includes("bun run test -- --shard="));
    expect(test.env.MATRIX_TEST_WORKERS).toBe("${{ runner.environment == 'self-hosted' && '4' || '2' }}");
    expect(step.env.POOL_HEARTBEAT).toBe("${{ vars.MATRIX_CI_POOL_HEARTBEAT }}");
  });
});

// Execute the actual workflow commands with stand-in executables: the regression
// is an apt dependency install before any assertions, not browser test behavior.
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function runStep(command: string, environment: string) {
  const path = mkdtempSync(join(tmpdir(), "ci-system-deps-"));
  temporary.push(path);
  const log = join(path, "calls");
  for (const name of ["rg", "sudo", "pnpm"]) {
    const executable = join(path, name);
    writeFileSync(executable, `#!/bin/bash\nprintf '%s\\n' '${name}'" $*" >> "$CI_COMMAND_LOG"\n`);
    chmodSync(executable, 0o755);
  }
  const result = spawnSync("bash", ["-e", "-c", command], {
    env: { ...process.env, PATH: `${path}:${process.env.PATH}`, CI_COMMAND_LOG: log, RUNNER_ENVIRONMENT: environment },
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(log, "utf8").trim().split("\n");
}

describe("prepared CI image dependency setup", () => {
  const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"));
  it.each([
    ["pull_request", "source_runner=matrix-ci\nbrowser_runner=matrix-ci\n"],
    ["workflow_dispatch", "source_runner=ubuntu-latest\nbrowser_runner=ubuntu-24.04\n"],
  ])("emits the workflow's actual runner outputs for %s", (event, expected) => {
    const path = mkdtempSync(join(tmpdir(), "ci-runner-output-"));
    temporary.push(path);
    const output = join(path, "output");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../scripts/ci/select-runner.mjs")], {
      env: { ...process.env, GITHUB_OUTPUT: output, EVENT_NAME: event,
        POOL_HEARTBEAT: `${Math.floor(Date.now() / 1000)} 4`,
        HEAD_REPOSITORY: "HamedMP/matrix-os", REPOSITORY: "HamedMP/matrix-os" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(expected);
  });
  it.each(["patterns", "unit"])("%s uses installed ripgrep without contacting apt", job => {
    const step = workflow.jobs[job].steps.find((s: { name?: string }) => s.name?.startsWith("Install ripgrep"));
    expect(runStep(step.run, "self-hosted")).toEqual(["rg --version"]);
  });
  it.each(["self-hosted", "github-hosted"])("installs both Chromium revisions on %s with the right dependency boundary", environment => {
    const commands = workflow.jobs.e2e.steps.filter((s: { run?: string }) => s.run?.includes("playwright install"));
    const calls = commands.flatMap((s: { run: string }) => runStep(s.run, environment));
    const dependencies = environment === "self-hosted" ? "" : " --with-deps";
    expect(calls).toEqual([
      `pnpm --filter @matrix-os/mcp-browser exec playwright install${dependencies} chromium`,
      `pnpm --filter shell exec playwright install${dependencies} chromium`,
    ]);
  });
});
