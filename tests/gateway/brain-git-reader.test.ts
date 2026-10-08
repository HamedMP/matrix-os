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

describe("openGitRepository", { timeout: 30_000 }, () => {
  let f: BrainGitFixture;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    f = await createBrainGitFixture();
    await f.commit({ message: "Initial commit", files: { "README.md": "readme\n", "specs/001-a/spec.md": "# A\n" } });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warn.mockRestore();
    await f.destroy();
  });

  const open = (input: { repoPath?: string; homePath?: string; runner?: GitRunner; gitTimeoutMs?: number } = {}) =>
    openGitRepository({
      repoPath: input.repoPath ?? f.repoPath, homePath: input.homePath ?? f.homePath,
      runner: input.runner ?? defaultGitRunner, limits: { ...LIMITS, gitTimeoutMs: input.gitTimeoutMs ?? LIMITS.gitTimeoutMs },
    });

  it("opens a checkout inside home and runs every command with the global args, cwd and limits", async () => {
    const { runner, calls } = recording(defaultGitRunner);
    const repo = await open({ runner, gitTimeoutMs: 10 * GIT_SYNC_LIMIT_CEILINGS.gitTimeoutMs });
    expect(repo).toMatchObject({ root: await realpath(f.repoPath), objectFormat: "sha1", shaPattern: GIT_SHA_PATTERN.sha1 });
    expect(repo.version.major).toBeGreaterThanOrEqual(2);
    expect(calls.map((c) => c.args.slice(GIT_GLOBAL_ARGS.length)[0])).toEqual(["version", "rev-parse"]);
    for (const call of calls) {
      expect(call.args.slice(0, GIT_GLOBAL_ARGS.length)).toEqual(GIT_GLOBAL_ARGS);
      expect(call.options).toEqual({
        cwd: repo.root, timeoutMs: GIT_SYNC_LIMIT_CEILINGS.gitTimeoutMs, maxBuffer: GIT_SMALL_OUTPUT_MAX_BYTES, overflow: "fail",
      });
    }
  });

  it("rejects bad input paths and timeouts as invalid_options", async () => {
    for (const repoPath of ["", "relative/repo", `${f.repoPath}\u0000x`, `/${"a".repeat(4096)}`]) {
      await expectCode(open({ repoPath }), "invalid_options");
    }
    await expectCode(open({ homePath: "home" }), "invalid_options");
    for (const gitTimeoutMs of [0, 1.5]) await expectCode(open({ gitTimeoutMs }), "invalid_options");
  });

  it("refuses anything that is not a checkout strictly inside home", async () => {
    const outsideHome = join(f.homePath, "other-home");
    const subdirectory = join(f.repoPath, "sub");
    const plain = join(f.homePath, "plain");
    const file = join(f.homePath, "file.txt");
    await Promise.all([mkdir(outsideHome), mkdir(subdirectory), mkdir(plain), writeFile(file, "x")]);
    for (const input of [
      { homePath: outsideHome }, { homePath: f.repoPath }, { repoPath: subdirectory }, { repoPath: plain },
      { repoPath: join(f.homePath, "missing") }, { repoPath: file },
    ]) {
      await expectCode(open(input), "not_a_repository");
    }

    const versionedHome = await realpath(await mkdtemp(join(tmpdir(), "brain-git-home-")));
    try {
      await rawGit(["init", "-q", versionedHome], versionedHome);
      await mkdir(join(versionedHome, "plain"));
      await expectCode(open({ homePath: versionedHome, repoPath: join(versionedHome, "plain") }), "not_a_repository");
    } finally {
      await rm(versionedHome, { recursive: true, force: true });
    }
  });

  it("refuses a shallow clone and reads a sha256 object format", async () => {
    const shallow = join(f.homePath, "projects", "shallow");
    await rawGit(["clone", "-q", "--no-checkout", "--depth", "1", `file://${f.repoPath}`, shallow], f.homePath);
    await expectCode(open({ repoPath: shallow }), "shallow_repository");

    const root = await realpath(f.repoPath);
    const info = `false\nsha256\n${root}\n${root}/.git\n${root}/.git\n`;
    const sha256 = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "rev-parse" ? gitRunResult(info) : undefined));
    expect(await open({ runner: sha256 })).toMatchObject({ objectFormat: "sha256", shaPattern: GIT_SHA_PATTERN.sha256 });
  });

  it("maps versions, runner failures and unexpected exits to codes, logging capped stderr", async () => {
    const answer = (result: GitRunResult | Error) => fakeRunner(defaultGitRunner, (sub) => {
      if (sub[0] !== "version") return undefined;
      if (result instanceof Error) throw result;
      return result;
    });
    await expectCode(open({ runner: answer(gitRunResult("git version 2.20.1\n")) }), "git_version_unsupported");
    await expectCode(open({ runner: answer(gitRunResult("not git\n")) }), "git_output_malformed");
    await expectCode(open({ runner: answer(new GitRunnerError("timeout")) }), "git_timeout");
    await expectCode(open({ runner: answer(new GitRunnerError("spawn_failed")) }), "git_unavailable");
    await expectCode(open({ runner: answer(new GitRunnerError("output_too_large")) }), "git_output_too_large");
    const unexpected = new Error("runner bug");
    await expect(open({ runner: answer(unexpected) })).rejects.toBe(unexpected);

    warn.mockClear();
    await expectCode(open({ runner: answer({ ...gitRunResult(""), exitCode: 2, stderr: "e".repeat(4_000) }) }), "git_command_failed");
    expect(warn).toHaveBeenCalledWith("[brain-git] git command failed", { subcommand: "version", exitCode: 2, stderr: "e".repeat(500) });
  });

  it("rethrows a filesystem error that does not mean a missing checkout", async () => {
    const failure = Object.assign(new Error("I/O error"), { code: "EIO" });
    vi.mocked(realpath).mockRejectedValueOnce(failure);
    await expect(open()).rejects.toBe(failure);
    // The second realpath is home's own `.git`, which may be absent but must not fail otherwise.
    const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).realpath;
    vi.mocked(realpath).mockImplementationOnce(actual).mockRejectedValueOnce(failure);
    await expect(open()).rejects.toBe(failure);
    vi.mocked(openFile).mockRejectedValueOnce(failure);
    await expect(open()).rejects.toBe(failure);
  });
});
