import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string; if?: string };
const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const steps: Step[] = jobs.unit.steps;
const userns = steps.find(({ name }) => name === "Allow user namespaces for isolated install tests");

// Ubuntu's AppArmor userns restriction makes `unshare -Ur` fail on hosted
// runners, so tests/platform/support-access-bootstrap.test.ts skipped its
// mount-namespace install test in every CI run.
describe("unit shards provide user namespaces on hosted runners", () => {
  it("relaxes the restriction before the test run", () => {
    expect(userns?.if).toContain("should_run == 'true'");
    const testRun = steps.findIndex(({ run }) => run?.includes("bun run test -- --shard="));
    expect(steps.indexOf(userns as Step)).toBeGreaterThan(-1);
    expect(steps.indexOf(userns as Step)).toBeLessThan(testRun);
  });

  function runStep(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "unit-userns-ci-"));
    try {
      const log = join(dir, "calls.log");
      const fake = (name: string, body: string) => {
        writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >>"${log}"\n${body}\n`);
        chmodSync(join(dir, name), 0o755);
      };
      fake("sudo", 'exec "$@"');
      fake("sysctl", "exit 0");
      fake("unshare", `exit "\${FAKE_UNSHARE_STATUS:-0}"`);
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", userns?.run ?? "exit 99"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
        encoding: "utf8",
        timeout: 5_000,
      });
      writeFileSync(log, "", { flag: "a" });
      return { ...result, calls: readFileSync(log, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("disables the AppArmor restriction and confirms unshare works on hosted runners", () => {
    const actual = runStep({ RUNNER_ENVIRONMENT: "github-hosted" });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.calls).toContain("sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(actual.calls).toContain("unshare -Ur -m true");
    expect(actual.stdout).not.toContain("::warning::");
  });

  it("leaves self-hosted pool containers' kernel settings untouched", () => {
    const actual = runStep({ RUNNER_ENVIRONMENT: "self-hosted" });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.calls).not.toContain("sysctl");
  });

  it.each(["github-hosted", "self-hosted"])("warns visibly instead of skipping silently when unshare fails (%s)", (runner) => {
    const actual = runStep({ RUNNER_ENVIRONMENT: runner, FAKE_UNSHARE_STATUS: "1" });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.stdout).toContain("::warning::");
    expect(actual.stdout).toContain("support-access-bootstrap");
  });
});
