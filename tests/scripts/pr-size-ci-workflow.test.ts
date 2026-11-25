import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("measures the PR head without unrelated files from the CI merge commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-size-ci-merge-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "CI");
      git("config", "user.email", "ci@example.com");
      writeFileSync(join(dir, "README.md"), "base\n");
      git("add", "."); git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-qb", "feature");
      writeFileSync(join(dir, "feature.md"), "feature\n");
      git("add", "."); git("commit", "-qm", "feature");
      const head = git("rev-parse", "HEAD");
      git("checkout", "-q", "main");
      for (let index = 0; index < 51; index++) writeFileSync(join(dir, `upstream-${index}.md`), "upstream\n");
      git("add", "."); git("commit", "-qm", "advance main");
      git("merge", "-q", "--no-ff", "feature", "-m", "synthetic CI merge");
      const merge = git("rev-parse", "HEAD");
      const checkout = jobs["pr-size"].steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
      const refs: Record<string, string> = {
        "${{ github.event.pull_request.head.sha }}": head,
        "${{ needs.changes.outputs.source_sha }}": merge,
      };
      expect(refs[checkout.with.ref]).toBeDefined();
      git("checkout", "-q", "--detach", refs[checkout.with.ref]!);
      const actual = spawnSync(process.execPath, [join(process.cwd(), "scripts/review/check-added-patterns.mjs"),
        "--base", base, "--only", "pr-size"], { cwd: dir, encoding: "utf8", timeout: 5_000 });
      expect(actual.status, actual.stdout + actual.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs for every fresh PR head, including docs-only changes", () => {
    const job = jobs["pr-size"];
    expect(job.if).toContain("github.event_name == 'pull_request'");
    expect(job.if).toContain("needs.changes.outputs.fresh_head == 'true'");
    expect(job.if).not.toContain("should_run");
    expect(job.steps.map((step: { run?: string }) => step.run ?? "").join("\n")).toContain(
      "check-added-patterns.mjs --base \"$REVIEW_BASE_SHA\" --only pr-size",
    );
    expect(jobs.changes.outputs.fresh_head).toContain("steps.superseded.outputs.stale");
    expect(jobs["ci-results"].needs).toContain("pr-size");
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
