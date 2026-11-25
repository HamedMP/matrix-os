import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();
const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const resolveHead = jobs.changes.steps.find((step: { id?: string }) => step.id === "superseded");
const sizeStep = jobs["pr-size"].steps.find((step: { name?: string }) => step.name === "Enforce the 50-file / 3000-addition PR limit");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function checkLayer(childFiles: number, stacked: boolean, apiUnavailable = false) {
  const dir = mkdtempSync(join(tmpdir(), "native-stack-size-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    git("add", "seed.txt");
    git("commit", "-qm", "seed");
    const trunk = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", trunk);
    git("checkout", "-qb", "feature-parent");
    for (let i = 0; i < 51; i++) writeFileSync(join(dir, `parent-${i}.txt`), "parent\n");
    git("add", ".");
    git("commit", "-qm", "parent layer");
    const parent = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/feature-parent", parent);
    git("checkout", "-qb", "feature-child");
    for (let i = 0; i < childFiles; i++) writeFileSync(join(dir, `child-${i}.txt`), "child\n");
    git("add", ".");
    git("commit", "-qm", "child layer");
    const head = git("rev-parse", "HEAD");

    // Execute the production metadata producer with the real native-stack
    // mismatch: the event base is trunk; the live PR base is its parent.
    const output: Record<string, string> = {};
    await new AsyncFunction("github", "context", "core", resolveHead.with.script)(
      { rest: { pulls: { get: async () => {
        if (apiUnavailable) throw new Error("Metadata unavailable");
        return { data: { head: { sha: head }, base: { sha: stacked ? parent : trunk } } };
      } } } },
      { repo: { owner: "fixture", repo: "fixture" }, payload: { pull_request: { number: 1, head: { sha: head }, base: { ref: "main", sha: trunk } } } },
      { setOutput: (name: string, value: unknown) => { output[name] = String(value); }, notice: () => {}, warning: () => {} },
    );

    // Run the actual workflow command and production scanner in a real git
    // repository; never replace the size policy with a test-local counter.
    const command = sizeStep.run.replace("scripts/review/check-added-patterns.mjs", '"$SCANNER_PATH"');
    const result = spawnSync("bash", ["-c", command], {
      cwd: dir,
      env: {
        ...process.env,
        SCANNER_PATH: resolve(root, "scripts/review/check-added-patterns.mjs"),
        BASE_REF: "main",
        REVIEW_BASE_SHA: output.review_base_sha ?? "",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { ...result, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("native-stack PR size boundary", () => {
  it("checks only the child layer when GitHub's event base names trunk", async () => {
    const result = await checkLayer(1, true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(jobs.changes.outputs.review_base_sha).toBe("${{ steps.superseded.outputs.review_base_sha }}");
    expect(sizeStep.env.REVIEW_BASE_SHA).toBe("${{ needs.changes.outputs.review_base_sha }}");
  });

  it("still rejects an oversized child layer", async () => {
    const result = await checkLayer(51, true);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain("VIOLATION [pr-size]");
  });

  it("still counts the entire change for a standalone PR", async () => {
    const result = await checkLayer(1, false);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain("VIOLATION [pr-size]");
  });

  it("conservatively enforces the event base when live metadata is unavailable", async () => {
    const result = await checkLayer(1, true, true);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain("VIOLATION [pr-size]");
  });
});
