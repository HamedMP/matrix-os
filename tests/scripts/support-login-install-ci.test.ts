import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string; env?: Record<string, string> };
const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const job = jobs["support-login-install"];
const steps: Step[] = job.steps;
const gate: string = jobs["ci-results"].steps.map((step: Step) => step.run ?? "").join("\n");

// The self-hosted unit pool cannot create the namespace the fixture needs, so
// the fresh-VPS support-login scenarios skipped in every CI run.
describe("support-login install scenarios are a required hosted CI job", () => {
  it("runs on a GitHub-hosted runner for every source change", () => {
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.if).toContain("should_run == 'true'");
  });

  it("fails the job when the fixture's tmpfs cannot be mounted", () => {
    const probe = steps.find(({ run }) => run?.includes("unshare -Ur -m mount -t tmpfs tmpfs /etc"));
    expect(probe?.run).toContain("set -euo pipefail");
    expect(probe?.run).not.toContain("||");
  });

  it("runs the scenarios with skips turned into failures", () => {
    const run = steps.find(({ run }) => run?.includes("tests/platform/support-access-bootstrap.test.ts"));
    expect(run?.env?.MATRIX_REQUIRE_ISOLATED_INSTALL_TESTS).toBe("1");
    expect(steps.indexOf(run as Step)).toBeGreaterThan(
      steps.findIndex(({ run }) => run?.includes("apparmor_restrict_unprivileged_userns=0")),
    );
  });

  it("is required by CI Results and may not be skipped for a source change", () => {
    expect(jobs["ci-results"].needs).toContain("support-login-install");
    const neverSkip = gate.slice(gate.indexOf("These lanes never skip"));
    expect(neverSkip.slice(0, neverSkip.indexOf("done"))).toContain("$SUPPORT_LOGIN_INSTALL_RESULT");
  });
});
