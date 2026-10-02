import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
const workflow = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const job = workflow.jobs.preview;
const sha = "a".repeat(40);
function source(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preview-source-"));
  const output = join(dir, "output"), envFile = join(dir, "env");
  try {
    const run = job.steps.find((s: { id?: string }) => s.id === "source")?.run;
    const result = spawnSync("bash", ["-euc", `gh() { printf '%s\\n' "$PR_JSON"; }\n${run ?? "exit 99"}`], {
      encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_ENV: envFile,
        GITHUB_REPOSITORY: "Matrix/example", PR_NUMBER: "2079", EVENT_NAME: "workflow_dispatch",
        EVENT_HEAD_SHA: "b".repeat(40), ISOLATED_PREVIEW_ORIGIN: "false",
        PR_JSON: JSON.stringify({ head: { sha, repo: { full_name: "Matrix/example" } }, labels: [{ name: "preview-isolated" }] }), ...overrides },
    });
    return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "",
      env: result.status === 0 ? readFileSync(envFile, "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe("manual platform preview source", () => {
  it("isolates unrelated labels while sharing a group for actual deployment events", () => {
    // This group uses GitHub's string/boolean equality and short-circuit operators,
    // which have the same outcomes as JavaScript for these concrete fixture values.
    const group = (action: string, label: string, runId: number, pr = 2079) =>
      workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_match: string, expression: string) =>
        String(new Function("github", "inputs", `return (${expression});`)({
          event: { action, label: { name: label }, pull_request: { number: pr } }, run_id: runId,
        }, {})));
    const active = group("synchronize", "", 1);
    expect(group("labeled", "preview-platform", 2)).toBe(active);
    expect(group("synchronize", "", 3)).toBe(active);
    for (const label of ["ready-for-ci", "preview-vps", "documentation"]) {
      expect(group("labeled", label, 4)).not.toBe(active);
      expect(group("labeled", label, 5)).not.toBe(group("labeled", label, 4));
    }
    expect(group("synchronize", "", 6, 2078)).not.toBe(active);
  });
  it("resolves the exact PR head and isolation label on manual deployment", () => {
    const result = source(); expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(`head_sha=${sha}\n`);
    expect(result.env).toBe("ISOLATED_PREVIEW_ORIGIN=true\n");
    expect(job.steps.find((s: { uses?: string }) => s.uses === "actions/checkout@v6").with.ref).toBe("${{ steps.source.outputs.head_sha }}");
    expect(job.steps.find((s: { name?: string }) => s.name === "Build platform image").run).toContain("steps.source.outputs.head_sha");
  });
  it("preserves shared mode for an unlabeled PR", () => {
    expect(source({ PR_JSON: JSON.stringify({ head: { sha, repo: { full_name: "Matrix/example" } }, labels: [] }) }).env)
      .toBe("ISOLATED_PREVIEW_ORIGIN=false\n");
  });
  it("retains the pull-request event source and selected isolation", () => {
    const result = source({ EVENT_NAME: "pull_request", ISOLATED_PREVIEW_ORIGIN: "true", PR_JSON: "invalid" });
    expect(result.status, result.stderr).toBe(0); expect(result.output).toBe(`head_sha=${"b".repeat(40)}\n`);
    expect(result.env).toBe("ISOLATED_PREVIEW_ORIGIN=true\n");
  });
  it.each([
    { PR_NUMBER: "2079/path" },
    { PR_JSON: JSON.stringify({ head: { sha, repo: { full_name: "Other/fork" } }, labels: [{ name: "preview-isolated" }] }) },
    { PR_JSON: JSON.stringify({ head: { sha: "wrong", repo: { full_name: "Matrix/example" } }, labels: [] }) },
  ])("rejects an invalid manual source %j", (overrides) => { expect(source(overrides).status).not.toBe(0); });
});
