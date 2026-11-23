import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const gate = jobs["ci-results"].steps.find(({ name }: { name?: string }) => name === "Summarize required CI jobs");

function runGate(overrides: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pr-size-ci-gate-"));
  try {
    const env = {
      ...process.env,
      ...Object.fromEntries(Object.keys(gate.env).map((name) => [name, "success"])),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      CI_TRIGGER_REQUESTED: "true",
      SHOULD_RUN: "false",
      ...overrides,
    };
    return spawnSync("bash", ["-c", gate.run], { env, encoding: "utf8", timeout: 5_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PR size CI lane", () => {
  it("runs for every fresh PR head, including docs-only changes", () => {
    const job = jobs["pr-size"];
    expect(job.if).toContain("github.event_name == 'pull_request'");
    expect(job.if).toContain("needs.changes.outputs.fresh_head == 'true'");
    expect(job.if).not.toContain("should_run");
    expect(job.steps.map((step: { run?: string }) => step.run ?? "").join("\n")).toContain(
      "check-added-patterns.mjs --base \"origin/$BASE_REF\" --only pr-size",
    );
    expect(jobs.changes.outputs.fresh_head).toContain("steps.superseded.outputs.stale");
    expect(jobs["ci-results"].needs).toContain("pr-size");
  });

  it("measures the PR head rather than charging newer main changes from its merge candidate", () => {
    const checkout = jobs["pr-size"].steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("leaves PR size to its own lane instead of the source-only pattern scan", () => {
    const scan = jobs.patterns.steps.find(({ name }: { name?: string }) => name === "Run CLAUDE.md pattern scanner on changed files");
    expect(scan.run).not.toContain("--pr");
  });

  it.each([
    ["success", 0],
    ["failure", 1],
    ["skipped", 1],
  ])("requires the lane on a fresh docs-only PR head (%s)", (result, status) => {
    const actual = runGate({ EVENT_NAME: "pull_request", FRESH_HEAD: "true", PR_SIZE_RESULT: result });
    expect(actual.status, actual.stderr).toBe(status);
  });

  it("allows the lane to skip on push events", () => {
    const actual = runGate({ EVENT_NAME: "push", FRESH_HEAD: "true", PR_SIZE_RESULT: "skipped" });
    expect(actual.status, actual.stderr).toBe(0);
  });
});
