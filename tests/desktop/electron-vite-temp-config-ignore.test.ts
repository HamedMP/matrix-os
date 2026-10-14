import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const ignored = (path: string) => {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: root, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error && error.status === 1) return false;
    throw error;
  }
};

// readBuildSource (scripts/release/build-source.mjs) rejects untracked files when
// GITHUB_SHA is set. electron-vite writes the bundled config next to the source
// while loading it, so a concurrent load in another test worker would otherwise
// fail with "Release checkout has uncommitted source changes".
describe("electron-vite temporary config bundles", () => {
  it("are ignored so concurrent config loads keep the checkout clean", () => {
    expect(ignored("desktop/electron.vite.config.1792001262925.mjs")).toBe(true);
  });

  it("ignores Python bytecode caches written by script tests", () => {
    expect(ignored("scripts/ops/__pycache__/repair-funded-chat-config.cpython-312.pyc")).toBe(true);
    expect(ignored("scripts/ops/repair-funded-chat-config.py")).toBe(false);
  });

  it("do not hide the real config or other desktop sources", () => {
    expect(ignored("desktop/electron.vite.config.ts")).toBe(false);
    expect(ignored("desktop/electron.vite.config.local.mjs")).toBe(false);
    expect(ignored("desktop/src/main/index.ts")).toBe(false);
  });
});

describe("release build source guard", () => {
  it("names the uncommitted paths it rejects", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readBuildSource } = await import("../../scripts/release/build-source.mjs");
    const repo = mkdtempSync(join(tmpdir(), "build-source-guard-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
    try {
      git("init", "-q");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git("add", ".");
      git("commit", "-qm", "init");
      const head = git("rev-parse", "HEAD");
      expect(readBuildSource(repo, head)?.commit).toBe(head);
      writeFileSync(join(repo, "stray.txt"), "x\n");
      writeFileSync(join(repo, "a.txt"), "changed\n");
      expect(() => readBuildSource(repo, head)).toThrow("Release checkout has uncommitted source changes: a.txt, stray.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
