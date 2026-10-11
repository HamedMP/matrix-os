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

describe("GitRepository", { timeout: 30_000 }, () => {
  let f: BrainGitFixture;
  let warn: ReturnType<typeof vi.spyOn>;
  let shas: string[];

  beforeEach(async () => {
    f = await createBrainGitFixture();
    shas = [
      await f.commit({ message: "Initial commit", files: { "README.md": "r\n", "specs/001-a/spec.md": "# A\n" } }),
      await f.commit({ message: "feat: two\n\nBody two.", files: { "src/two.ts": "2\n" } }),
      await f.commit({ message: "feat: three", files: { "specs/001-a/spec.md": "# A v2\n", "src/two.ts": null } }),
    ];
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warn.mockRestore();
    await f.destroy();
  });

  const open = (runner: GitRunner = defaultGitRunner): Promise<GitRepository> =>
    openGitRepository({ repoPath: f.repoPath, homePath: f.homePath, runner, limits: LIMITS });
  const answering = (match: (sub: readonly string[]) => boolean, result: () => GitRunResult | Promise<GitRunResult>) =>
    fakeRunner(defaultGitRunner, (sub) => (match(sub) ? result() : undefined));

  it("resolves the tip from origin/HEAD, an explicit branch, or the fallbacks, never HEAD", async () => {
    const repo = await open();
    expect(await repo.resolveTip(null)).toEqual({ ref: "refs/heads/main", sha: shas[2] });
    await f.setOriginHead("main", shas[1]!);
    expect(await repo.resolveTip(null)).toEqual({ ref: "refs/remotes/origin/main", sha: shas[1] });
    expect(await repo.resolveTip("main")).toEqual({ ref: "refs/remotes/origin/main", sha: shas[1] });
    await expectCode(repo.resolveTip("release"), "branch_unavailable");
    await expectCode(repo.resolveTip("-bad"), "invalid_options");

    await f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main"]);
    await f.git(["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(await repo.resolveTip(null)).toEqual({ ref: "refs/heads/main", sha: shas[2] });
    const unsafe = await open(answering((sub) => sub[0] === "symbolic-ref", () => gitRunResult("refs/remotes/origin/-x\n")));
    expect(await unsafe.resolveTip(null)).toEqual({ ref: "refs/heads/main", sha: shas[2] });
    const twoLines = await open(answering((sub) => sub.includes("--verify"), () => gitRunResult(`${shas[0]}\n${shas[1]}\n`)));
    await expectCode(twoLines.resolveTip("main"), "git_output_malformed");
  });

  it("reports branch_unavailable for a repository without commits", async () => {
    const empty = await createBrainGitFixture();
    try {
      const repo = await openGitRepository({ repoPath: empty.repoPath, homePath: empty.homePath, runner: defaultGitRunner, limits: LIMITS });
      await expectCode(repo.resolveTip(null), "branch_unavailable");
    } finally {
      await empty.destroy();
    }
  });

  it("reads the origin url, or null when it is unset or unusable", async () => {
    expect(await (await open()).readOriginUrl()).toBe("https://github.com/acme/widgets.git");
    for (const stdout of ["\n", `https://github.com/${"a".repeat(2_048)}\n`, "https://github.com/a\u0007/b\n"]) {
      const repo = await open(answering((sub) => sub[0] === "config", () => gitRunResult(stdout)));
      expect(await repo.readOriginUrl()).toBeNull();
    }
    await f.setRemote(null);
    expect(await (await open()).readOriginUrl()).toBeNull();
  });

  it("answers ancestry, counts and first-parent positions, validating shas and skips", async () => {
    const repo = await open();
    expect(await repo.isAncestor(shas[0]!, shas[2]!)).toBe(true);
    expect(await repo.isAncestor(shas[2]!, shas[0]!)).toBe(false);
    expect(await repo.isAncestor("f".repeat(40), shas[2]!)).toBe(false);
    await expectCode(repo.isAncestor("HEAD", shas[2]!), "internal_error");
    expect(await repo.countFirstParent({ from: null, to: shas[2]! })).toBe(3);
    expect(await repo.countFirstParent({ from: shas[0]!, to: shas[2]! })).toBe(2);
    expect(await repo.firstParentAt({ from: null, to: shas[2]! }, 0)).toBe(shas[2]);
    expect(await repo.firstParentAt({ from: shas[0]!, to: shas[2]! }, 1)).toBe(shas[1]);
    await expectCode(repo.firstParentAt({ from: null, to: shas[2]! }, 5), "git_output_malformed");
    for (const skip of [-1, 0.5]) await expectCode(repo.firstParentAt({ from: null, to: shas[2]! }, skip), "internal_error");
  });

  it("reads a window oldest first, and falls back to per-commit reads with identical results", async () => {
    const repo = await open();
    const window = await repo.readCommits({ from: null, to: shas[2]! }, { isSpecPath });
    expect(window.map((c) => [c.sha, c.subject, c.body, c.parents.length])).toEqual([
      [shas[0], "Initial commit", "", 0], [shas[1], "feat: two", "Body two.", 1], [shas[2], "feat: three", "", 1],
    ]);
    expect(window[2]!.changes).toEqual({
      paths: [{ status: "M", path: "specs/001-a/spec.md" }, { status: "D", path: "src/two.ts" }],
      totalPaths: 2, invalidPaths: 0, truncated: false, specPaths: ["specs/001-a/spec.md"],
    });
    expect(await repo.readCommits({ from: shas[2]!, to: shas[2]! }, { isSpecPath })).toEqual([]);

    const { runner, calls } = recording(fakeRunner(defaultGitRunner, (sub) => {
      if (isGitLog(sub, { window: true })) throw new GitRunnerError("output_too_large");
      return undefined;
    }));
    const fallback = await (await open(runner)).readCommits({ from: null, to: shas[2]! }, { isSpecPath });
    expect(fallback).toEqual(window);
    const perCommit = calls.filter((c) => c.args.includes("-1"));
    expect(perCommit).toHaveLength(6);
    expect(perCommit.map((c) => c.options.overflow)).toEqual(Array(6).fill("truncate"));
  });

  it("marks a per-commit message cut at its cap as truncated", async () => {
    const long = await f.commit({ message: `feat: long\n\n${"word ".repeat(60_000)}`, files: { "src/long.ts": "l\n" } });
    const runner = fakeRunner(defaultGitRunner, (sub) => {
      if (isGitLog(sub, { window: true, nameStatus: false })) throw new GitRunnerError("output_too_large");
      return undefined;
    });
    const [commit] = await (await open(runner)).readCommits({ from: shas[2]!, to: long }, { isSpecPath });
    expect(commit).toMatchObject({ sha: long, subject: "feat: long", messageTruncated: true });
    expect(Buffer.byteLength(commit!.body)).toBeLessThan(256 * 1024);
  });

  it("refuses window outputs that disagree with rev-list", async () => {
    const range = { from: null, to: shas[2]! };
    const tooMany = Array.from({ length: GIT_SYNC_LIMIT_CEILINGS.commitsPerWindow + 1 }, () => shas[0]).join("\n");
    const metadataRecords = async (sub: readonly string[]): Promise<Buffer[]> => {
      const real = await defaultGitRunner([...GIT_GLOBAL_ARGS, ...sub], {
        cwd: await realpath(f.repoPath), timeoutMs: 10_000, maxBuffer: 1024 * 1024, overflow: "fail",
      });
      const records = Buffer.from(real.stdout).toString("latin1").split("\u0000").slice(0, -1);
      return records.map((record) => Buffer.from(`${record}\u0000`, "latin1"));
    };
    const cases: GitRunner[] = [
      answering((sub) => sub.includes(`--max-count=${GIT_SYNC_LIMIT_CEILINGS.commitsPerWindow + 1}`), () => gitRunResult(`${tooMany}\n`)),
      fakeRunner(defaultGitRunner, async (sub) =>
        (isGitLog(sub, { window: true, nameStatus: false }) ? gitRunResult(Buffer.concat((await metadataRecords(sub)).reverse())) : undefined)),
      fakeRunner(defaultGitRunner, async (sub) =>
        (isGitLog(sub, { window: true, nameStatus: false }) ? gitRunResult((await metadataRecords(sub))[0]!) : undefined)),
      fakeRunner(defaultGitRunner, (sub) => {
        if (isGitLog(sub, { window: true, nameStatus: true })) throw new GitRunnerError("output_too_large");
        return isGitLog(sub, { window: false, nameStatus: true }) ? gitRunResult("") : undefined;
      }),
    ];
    for (const runner of cases) await expectCode((await open(runner)).readCommits(range, { isSpecPath }), "git_output_malformed");
    const timeout = fakeRunner(defaultGitRunner, (sub) => {
      if (isGitLog(sub, { window: true, nameStatus: false })) throw new GitRunnerError("timeout");
      return undefined;
    });
    await expectCode((await open(timeout)).readCommits(range, { isSpecPath }), "git_timeout");
  });

  it("lists the entries at exact literal paths and reads blobs of exactly the listed size", async () => {
    const { runner, calls } = recording(defaultGitRunner);
    const repo = await open(runner);
    calls.length = 0;
    expect(await repo.listTree(shas[2]!, [])).toEqual([]);
    expect(calls).toHaveLength(0);
    const entries = await repo.listTree(shas[2]!, ["specs/001-a/spec.md", "specs/*/spec.md", "specs/missing/spec.md"]);
    expect(entries).toEqual([expect.objectContaining({ mode: "100644", type: "blob", size: 7, path: "specs/001-a/spec.md" })]);
    expect(calls[0]!.args.slice(GIT_GLOBAL_ARGS.length)).toEqual([
      "ls-tree", "-z", "-l", "--full-tree", shas[2], "--", "specs/001-a/spec.md", "specs/*/spec.md", "specs/missing/spec.md",
    ]);
    // A directory is one tree entry, never its children.
    expect(await repo.listTree(shas[2]!, ["specs"])).toEqual([expect.objectContaining({ type: "tree", size: null, path: "specs" })]);
    await expectCode(repo.listTree(shas[2]!, Array.from({ length: GIT_MAX_SPEC_FILES_PER_WINDOW + 1 }, (_, i) => `p${i}`)), "internal_error");
    await expectCode(repo.listTree(shas[2]!, ["../x"]), "internal_error");

    const oid = entries[0]!.oid;
    expect(text(await repo.readBlob(oid, 7))).toBe("# A v2\n");
    // A short read is a length mismatch; a longer blob overflows maxBuffer (size + 1) and is a mismatch too.
    await expectCode(repo.readBlob(oid, 8), "git_output_malformed");
    await expectCode(repo.readBlob(oid, 5), "git_output_malformed");
    for (const size of [-1, 1.5, GIT_SPEC_FILE_MAX_BYTES + 1]) await expectCode(repo.readBlob(oid, size), "internal_error");
    const slow = await open(fakeRunner(defaultGitRunner, (sub) => {
      if (sub[0] === "cat-file") throw new GitRunnerError("timeout");
      return undefined;
    }));
    await expectCode(slow.readBlob(oid, 7), "git_timeout");
  });
});
