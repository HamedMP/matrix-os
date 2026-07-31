import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyDockerChanges,
  formatGitFailure,
  GIT_DIFF_TIMEOUT_MS,
  GIT_MAX_BUFFER_BYTES,
  MAX_DIAGNOSTIC_CHARS,
  readChangedPaths,
} from "../../scripts/ci/docker-relevance.mjs";

describe("Docker CI relevance classifier", () => {
  it.each([
    "Dockerfile",
    "Dockerfile.dev",
    ".dockerignore",
    ".env.docker.example",
    "docker-compose.dev.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    ".github/workflows/docker-test.yml",
    "scripts/docker-test/fresh-install.sh",
    "scripts/build-default-apps.mjs",
    "scripts/branch-dev.sh",
    "scripts/ci/docker-relevance.mjs",
    "scripts/fix-node-pty-perms.mjs",
    "scripts/sync-matrix-agent-skills.sh",
    "distro/docker-dev-entrypoint.sh",
    "distro/init-postgres.sh",
    "distro/observability/prometheus.yml",
    "packages/brand/src/index.ts",
    "packages/contracts/src/index.ts",
    "packages/gateway/src/index.ts",
    "packages/kernel/src/index.ts",
    "packages/mcp-browser/src/index.ts",
    "packages/observability/src/index.ts",
    "packages/ui/src/Button.tsx",
    "shell/app/page.tsx",
    "home/system/config.json",
    "skills/matrix/SKILL.md",
    "packages/sync-client/src/protocol/messages.ts",
  ])("runs for Docker/local-runtime input %s", (path) => {
    expect(classifyDockerChanges([path])).toMatchObject({
      shouldRun: true,
      matchedPaths: [path],
    });
  });

  it.each([
    "Dockerfile.platform",
    "distro/docker-compose.platform.yml",
    "packages/cli/src/index.ts",
    "packages/sync-client/package.json",
    "packages/sync-client/src/commands/login.ts",
    "packages/platform/src/index.ts",
    "packages/proxy/src/index.ts",
    "packages/edge-router/src/index.ts",
    "packages/clerk-sync/src/index.ts",
    "packages/neo-worker/src/index.ts",
    "packages/symphony-elixir/lib/symphony.ex",
    "desktop/src/main.ts",
    "apps/mobile/app/index.tsx",
    "docs/dev/docker-development.md",
    "specs/001-example/spec.md",
    "README.md",
    ".github/workflows/ci.yml",
    "scripts/build-host-bundle.sh",
  ])("skips unrelated input %s", (path) => {
    expect(classifyDockerChanges([path])).toEqual({
      shouldRun: false,
      reason: "no Docker/local-runtime inputs changed",
      matchedPaths: [],
    });
  });

  it("runs when any path in a mixed change set is relevant", () => {
    expect(
      classifyDockerChanges([
        "docs/dev/docker-development.md",
        "packages/cli/src/index.ts",
        "packages/gateway/src/index.ts",
      ]),
    ).toEqual({
      shouldRun: true,
      reason: "Docker/local-runtime inputs changed",
      matchedPaths: ["packages/gateway/src/index.ts"],
    });
  });

  it("skips an empty change set", () => {
    expect(classifyDockerChanges([])).toEqual({
      shouldRun: false,
      reason: "no Docker/local-runtime inputs changed",
      matchedPaths: [],
    });
  });

  it("normalizes relative prefixes and Windows separators", () => {
    expect(classifyDockerChanges(["./shell\\app\\page.tsx"]).matchedPaths).toEqual([
      "shell/app/page.tsx",
    ]);
  });

  it("uses bounded, timed git execution and fails closed on timeouts", () => {
    expect(GIT_DIFF_TIMEOUT_MS).toBe(30_000);
    expect(GIT_MAX_BUFFER_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);

    expect(() =>
      readChangedPaths(
        { base: "origin/main", head: "head-sha", commit: "" },
        {
          spawnGit: (_command, _args, options) => {
            expect(options.timeout).toBe(GIT_DIFF_TIMEOUT_MS);
            expect(options.maxBuffer).toBe(GIT_MAX_BUFFER_BYTES);
            return {
              status: null,
              stdout: "",
              stderr: "",
              error: Object.assign(new Error("spawn git ETIMEDOUT"), {
                code: "ETIMEDOUT",
              }),
            };
          },
        },
      ),
    ).toThrow(/ETIMEDOUT/);
  });

  it("bounds git diagnostics before surfacing a failure", () => {
    const message = formatGitFailure(["diff"], {
      status: 128,
      stdout: "",
      stderr: "x".repeat(MAX_DIAGNOSTIC_CHARS * 2),
    });

    expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 1);
    expect(message).toMatch(/…$/);
  });

  it("emits only the GitHub output assignment on stdout", () => {
    const script = join(process.cwd(), "scripts/ci/docker-relevance.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--path", "packages/gateway/src/index.ts", "--format", "github"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("should_run=true\n");
    expect(result.stderr).toContain("Docker/local-runtime inputs changed");
  });

  it.each([
    [[]],
    [["--base", "origin/main"]],
    [["--commit", "HEAD", "--path", "shell/app/page.tsx"]],
    [["--path", "shell/app/page.tsx", "--format", "xml"]],
    [["--unknown"]],
  ])("rejects invalid CLI arguments: %j", (args) => {
    const script = join(process.cwd(), "scripts/ci/docker-relevance.mjs");
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("docker-relevance:");
  });

  it("fails closed when git cannot resolve the requested revision", () => {
    const script = join(process.cwd(), "scripts/ci/docker-relevance.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--commit", "definitely-not-a-real-revision"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("docker-relevance:");
  });
});
