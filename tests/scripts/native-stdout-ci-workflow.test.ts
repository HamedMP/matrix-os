import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const gate = jobs["ci-results"].steps.find(({ name }: { name?: string }) =>
  name === "Summarize required CI jobs");

describe("native stdout Linux CI", () => {
  it("qualifies the exact source with a bounded Linux fixture", () => {
    const job = jobs["native-stdout-linux"];
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.if).toContain("should_run == 'true'");
    expect(job["timeout-minutes"]).toBe(5);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.steps[0].with).toEqual({
      ref: "${{ needs.changes.outputs.source_sha }}",
      "persist-credentials": false,
    });
    expect(job.steps[2].run).toBe("timeout --kill-after=5s 120s bash scripts/ci/run-native-stdout-linux.sh");
    expect(jobs["completion-handoff"].needs).toContain("native-stdout-linux");
    expect(jobs["ci-results"].needs).toContain("native-stdout-linux");
  });

  it.each(["success", "failure", "cancelled", "skipped"])("requires native qualification for source CI (%s)", result => {
    const dir = mkdtempSync(join(tmpdir(), "native-stdout-ci-gate-"));
    try {
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.keys(gate.env).map(name => [name, "success"])),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        CI_TRIGGER_REQUESTED: "true",
        SHOULD_RUN: "true",
        NATIVE_STDOUT_LINUX_RESULT: result,
      };
      const actual = spawnSync("bash", ["-c", gate.run], { env, encoding: "utf8", timeout: 5_000 });
      expect(actual.status, actual.stderr).toBe(result === "success" ? 0 : 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
