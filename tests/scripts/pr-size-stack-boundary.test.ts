import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const job = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs["pr-size"];

function runLayerGate(parentFiles: number, childFiles: number, corrupt?: "head" | "base" | "api") {
  const root = mkdtempSync(join(tmpdir(), "matrix-pr-layer-size-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 10_000 }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), "scripts/\nbin/\npull.json\noutputs\n");
    git("add", ".gitignore"); git("commit", "-m", "trunk");
    const trunk = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", trunk);
    const commitFiles = (prefix: string, count: number) => {
      for (let n = 0; n < count; n++) writeFileSync(join(root, `${prefix}-${n}.ts`), `export const value${n} = ${n};\n`);
      if (count) { git("add", "--", "."); git("commit", "-m", prefix); }
      return git("rev-parse", "HEAD");
    };
    git("checkout", "-b", "parent"); const parent = commitFiles("parent", parentFiles);
    git("checkout", "-b", "child"); const head = commitFiles("child", childFiles);
    git("checkout", "-b", "integration", trunk); commitFiles("integration", 1);
    git("merge", "--no-ff", "child", "-m", "synthetic integration merge");
    const integration = git("rev-parse", "HEAD");
    // Execute the production workflow scripts against real Git histories. Only
    // the upstream GitHub response is substituted; the size enforcer stays real.
    // Copy the actual CLI entrypoints: symlinks would bypass their direct-run
    // import.meta guards and falsely report a successful enforcer invocation.
    for (const file of ["review/check-added-patterns.mjs", "review/swallowed-errors.mjs", "ci/pr-size-base.mjs"]) {
      const source = resolve("scripts", file);
      if (!existsSync(source)) continue;
      const target = join(root, "scripts", file);
      mkdirSync(join(target, ".."), { recursive: true }); copyFileSync(source, target);
    }
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "pull.json"), JSON.stringify({
      head: { sha: corrupt === "head" ? "0".repeat(40) : head },
      base: { sha: corrupt === "base" ? "main; echo untrusted" : parent },
    }));
    const gh = join(root, "bin", "gh");
    writeFileSync(gh, corrupt === "api" ? "#!/bin/sh\nexit 1\n" : '#!/bin/sh\ncat "$CI_TEST_PULL_JSON"\n'); chmodSync(gh, 0o755);
    const output = join(root, "outputs"); writeFileSync(output, "");
    const expand = (value: unknown): string => {
      const text = String(value);
      if (text.includes("github.event.pull_request.head.sha")) return head;
      if (text.includes("needs.changes.outputs.source_sha")) return integration;
      if (text.includes("github.event.pull_request.number")) return "7";
      if (text.includes("github.base_ref")) return "main";
      if (text.includes("github.token")) return "fixture-no-authority";
      if (text.includes("steps.layer-base.outputs.base_sha")) return readFileSync(output, "utf8").match(/^base_sha=(.+)$/m)?.[1] ?? "";
      return text;
    };
    const checkout = job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
    git("checkout", "--detach", expand(checkout.with.ref));
    for (const step of job.steps.filter((step: { run?: string }) => step.run)) {
      const env = {
        ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "Fixture/repo", GITHUB_OUTPUT: output, CI_TEST_PULL_JSON: join(root, "pull.json"),
        ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(value)])),
      };
      const result = spawnSync("bash", ["-c", step.run], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
      if (result.status !== 0) return result;
    }
    return { status: 0, stdout: "", stderr: "" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it("measures a native stack layer against its verified parent instead of cumulative main", () => {
  const result = runLayerGate(35, 30);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("keeps the same size gate for a standalone PR", () => {
  const result = runLayerGate(0, 30);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("still rejects a layer that independently exceeds 50 files", () => {
  const result = runLayerGate(35, 51);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("VIOLATION [pr-size]");
});

it.each(["head", "base", "api"] as const)("fails closed when the live PR %s cannot be verified", corrupt => {
  expect(runLayerGate(0, 2, corrupt).status).not.toBe(0);
});
