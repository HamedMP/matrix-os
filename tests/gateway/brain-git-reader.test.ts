/**
 * reader.ts: defaultGitRunner against real git, and openGitRepository /
 * GitRepository against a real fixture repo, with fake runners for the
 * outputs real git will not produce on demand. Containment and the child
 * environment's trust rules live in brain-git-reader-containment.test.ts.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open as openFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGitRunner, openGitRepository } from "../../packages/gateway/src/brain/git/reader.js";
import {
  GIT_GLOBAL_ARGS, GIT_MAX_SPEC_FILES_PER_WINDOW, GIT_SHA_PATTERN, GIT_SMALL_OUTPUT_MAX_BYTES, GIT_SPEC_FILE_MAX_BYTES,
  GIT_SYNC_DEFAULT_LIMITS,
  GIT_SYNC_LIMIT_CEILINGS, GitRunnerError, GitSourceError,
  type GitRepository, type GitRunOptions, type GitRunResult, type GitRunner, type GitSyncErrorCode,
} from "../../packages/gateway/src/brain/git/types.js";
import {
  createBrainGitFixture, fakeRunner, gitRunResult, isGitLog, type BrainGitFixture,
} from "./helpers/brain-git-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const LIMITS = GIT_SYNC_DEFAULT_LIMITS;
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
const isSpecPath = (path: string): boolean => /^specs\/[^/]+\/spec\.md$/.test(path);

async function expectCode(promise: Promise<unknown>, code: GitSyncErrorCode): Promise<void> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(GitSourceError);
  expect((error as GitSourceError).code).toBe(code);
  expect((error as GitSourceError).message).toBe("Git source request failed");
}

/** Raw git for setup outside the fixture (clone, init); bounded like the fixture. */
function rawGit(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd, timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }, (error) => (error === null ? resolve() : reject(error)));
  });
}

/** Wraps a runner and records every call. */
function recording(base: GitRunner): { runner: GitRunner; calls: Array<{ args: readonly string[]; options: GitRunOptions }> } {
  const calls: Array<{ args: readonly string[]; options: GitRunOptions }> = [];
  return { calls, runner: (args, options) => { calls.push({ args, options }); return base(args, options); } };
}


describe("defaultGitRunner", { timeout: 30_000 }, () => {
  let f: BrainGitFixture;
  let tip: string;

  beforeEach(async () => {
    f = await createBrainGitFixture();
    tip = await f.commit({ message: "Initial commit", files: { "README.md": "readme\n" } });
  });
  afterEach(() => f.destroy());

  const run = (args: readonly string[], options: Partial<GitRunOptions> = {}): Promise<GitRunResult> =>
    defaultGitRunner([...GIT_GLOBAL_ARGS, ...args], {
      cwd: f.repoPath, timeoutMs: 10_000, maxBuffer: 1024 * 1024, overflow: "fail", ...options,
    });

  it("resolves exit 0 and non-zero exits with their exit code", async () => {
    const version = await run(["version"]);
    expect(version).toMatchObject({ exitCode: 0, truncated: false });
    expect(text(version.stdout)).toMatch(/^git version \d+\.\d+/);
    expect(await run(["config", "--local", "--get", "no.such.key"])).toMatchObject({ exitCode: 1, truncated: false });
    const missing = await run(["merge-base", "--is-ancestor", "f".repeat(40), tip]);
    expect(missing.exitCode).toBe(128);
    expect(missing.stderr.length).toBeGreaterThan(0);
  });

  it("truncates or rejects output over maxBuffer", async () => {
    const truncated = await run(["log", "--format=%H%n%B", tip], { maxBuffer: 10, overflow: "truncate" });
    expect(truncated).toMatchObject({ exitCode: null, truncated: true });
    expect(text(truncated.stdout)).toBe(tip.slice(0, 10));
    const error = await run(["log", tip], { maxBuffer: 10 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitRunnerError);
    expect(error).toMatchObject({ name: "GitRunnerError", failure: "output_too_large", message: "Git command failed" });
  });

  it("rejects a timeout and a failed spawn", async () => {
    // cat-file --batch waits on stdin, which execFile leaves open, until the timeout kills it.
    await expect(run(["cat-file", "--batch"], { timeoutMs: 200 })).rejects.toMatchObject({ failure: "timeout" });
    await expect(run(["version"], { cwd: join(f.homePath, "missing") })).rejects.toMatchObject({ failure: "spawn_failed" });
  });

  it("builds the child environment from scratch, with fallbacks for PATH and HOME", async () => {
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_DIR: process.env.GIT_DIR };
    try {
      process.env.GIT_DIR = join(f.homePath, "elsewhere");
      expect(text((await run(["rev-parse", "--git-dir"])).stdout).trim()).toBe(".git");
      delete process.env.PATH;
      delete process.env.HOME;
      await expect(run(["version"], { cwd: join(f.homePath, "missing") })).rejects.toMatchObject({ failure: "spawn_failed" });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
