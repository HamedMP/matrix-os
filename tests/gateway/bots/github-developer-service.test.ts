import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { GithubDeveloperActionSchema, type GithubDeveloperAction } from "@matrix-os/contracts";
import { createGithubDeveloperService as createService } from "../../../packages/gateway/src/bots/github-developer-service.js";

const services: ReturnType<typeof createService>[] = [];
function createGithubDeveloperService(deps: Parameters<typeof createService>[0]) {
  const service = createService(deps); services.push(service); return service;
}
const exec = promisify(execFile);
let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "github-broker-"));
  home = join(root, "owner"); workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  await writeFile(join(home, ".gitconfig"), '[user]\n name = Owner Example\n email = owner@example.com\n');
});
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const status = async () => ({ ready: true, user: "owner" });
async function repository() {
  const repo = join(workspace, "repo"); await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "remote.origin.url", "git@github.com:owner/private-test.git"], { cwd: repo });
  await writeFile(join(repo, "first.txt"), "first\n");
  await exec("git", ["add", "first.txt"], { cwd: repo });
  await exec("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"], { cwd: repo });
  return { repo, head: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim() };
}

it("branches and commits only explicit paths with the confirmed owner author and committer", async () => {
  const { repo, head } = await repository();
  const service = createGithubDeveloperService({ homePath: home, status });
  await service.execute(workspace, { action: "branch", path: "repo", name: "matrix/developer-demo", expectedHead: head }, signal());
  await writeFile(join(repo, "demo.txt"), "demo\n"); await writeFile(join(repo, "unrelated.txt"), "leave\n");
  await exec("git", ["add", "unrelated.txt"], { cwd: repo });
  const result = await service.execute(workspace, { action: "commit", path: "repo", files: ["demo.txt"], message: "demo", expectedHead: head }, signal());
  expect(result).toMatchObject({ author: "Owner Example <owner@example.com>" });
  expect((await exec("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], { cwd: repo })).stdout.trim())
    .toBe("Owner Example <owner@example.com>|Owner Example <owner@example.com>");
  expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("A  unrelated.txt\n");
});

it("binds approval to the canonical repository and selected bytes, refusing drift before any effect", async () => {
  const { repo, head } = await repository();
  const service = createGithubDeveloperService({ homePath: home, status });
  const action = { action: "branch" as const, path: "repo", name: "matrix/approved", expectedHead: head };
  const plan = await service.inspect(workspace, action, signal());
  await exec("git", ["config", "remote.origin.url", "git@github.com:owner/different.git"], { cwd: repo });
  await expect(service.execute(workspace, action, signal(), { plan, assertCurrent: async () => undefined })).rejects.toMatchObject({ code: "denied" });
  await exec("git", ["config", "remote.origin.url", "git@github.com:owner/private-test.git"], { cwd: repo });
  await service.execute(workspace, action, signal());
  await writeFile(join(repo, "demo.txt"), "approved bytes\n");
  const commit = { action: "commit" as const, path: "repo", expectedHead: head, files: ["demo.txt"], message: "approved" };
  const approved = await service.inspect(workspace, commit, signal());
  await writeFile(join(repo, "demo.txt"), "changed after approval\n");
  await expect(service.execute(workspace, commit, signal(), { plan: approved, assertCurrent: async () => undefined })).rejects.toMatchObject({ code: "denied" });
  await writeFile(join(repo, "demo.txt"), "approved bytes\n");
  await writeFile(join(home, ".gitconfig"), '[user]\n name = Changed Identity\n email = changed@example.com\n');
  await expect(service.execute(workspace, commit, signal(), { plan: approved, assertCurrent: async () => undefined })).rejects.toMatchObject({ code: "denied" });
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).toBe(head);
});

it.each([
  ["branch", "branch"],
  ["commit", "branch"],
  ["push", "branch"],
  ["push", "origin"],
  ["pull_request", "branch"],
  ["pull_request", "origin"],
] as const)("refuses a %s if the %s changes during approval revalidation at the same SHA", async (kind, drift) => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/approved"], { cwd: repo });
  await writeFile(join(repo, "demo.txt"), "approved bytes\n");
  const existing = { path: "repo", expectedHead: head };
  const actions: Record<typeof kind, GithubDeveloperAction> = {
    branch: { ...existing, action: "branch", name: "matrix/new" },
    commit: { ...existing, action: "commit", files: ["demo.txt"], message: "Approved" },
    push: { ...existing, action: "push" },
    pull_request: { ...existing, action: "pull_request", base: "main", title: "Demo", body: "Proof" },
  };
  const run = vi.fn<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>(async (command, args, options) => {
    if (command === "gh" || args.includes("push") || args.includes("ls-remote")) {
      throw new Error("Remote Git operation reached the offline test");
    }
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  const action = actions[kind];
  const plan = await service.inspect(workspace, action, signal());
  const assertCurrent = vi.fn(async () => {
    if (drift === "branch") await exec("git", ["switch", "main"], { cwd: repo });
    else await exec("git", ["remote", "set-url", "origin", "git@github.com:owner/other.git"], { cwd: repo });
  });
  await expect(service.execute(workspace, action, signal(), { plan, assertCurrent })).rejects.toMatchObject({ code: "denied" });
  expect(assertCurrent).toHaveBeenCalled();
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).toBe(head);
  expect(run.mock.calls.some(([command, args]) => command === "gh" ||
    args.some(arg => ["push", "ls-remote", "update-ref", "switch"].includes(arg)))).toBe(false);
});

it("commit compare-and-swap retains a concurrent Terminal commit and removes its temporary index", async () => {
  const { repo, head } = await repository();
  const setup = createGithubDeveloperService({ homePath: home, status });
  await setup.execute(workspace, { action: "branch", path: "repo", name: "matrix/concurrent", expectedHead: head }, signal());
  await writeFile(join(repo, "demo.txt"), "demo\n");
  let concurrent = "";
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    if (args.includes("update-ref")) {
      await exec("git", ["-c", "user.name=Terminal", "-c", "user.email=terminal@example.com", "commit", "--allow-empty", "-m", "concurrent"], { cwd: repo });
      concurrent = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    }
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "commit", path: "repo", files: ["demo.txt"], message: "demo", expectedHead: head }, signal())).rejects.toThrow();
  expect(concurrent).not.toBe(head);
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).toBe(concurrent);
  expect((await readdir(join(repo, ".git"))).some(name => name.startsWith("matrix-index-"))).toBe(false);
  expect(await readdir(join(home, ".matrix-github-staging"))).toEqual([]);
});

it("keeps cancellation after a committed ref update an unknown effect", async () => {
  const { repo, head } = await repository();
  const setup = createGithubDeveloperService({ homePath: home, status });
  await setup.execute(workspace, { action: "branch", path: "repo", name: "matrix/cancelled", expectedHead: head }, signal());
  await writeFile(join(repo, "demo.txt"), "committed before cancellation\n");
  const controller = new AbortController();
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    const result = await exec(command, args, options);
    if (args.includes("update-ref")) controller.abort();
    return result;
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "commit", path: "repo", files: ["demo.txt"], message: "demo", expectedHead: head }, controller.signal))
    .rejects.toThrow("GitHub action outcome unconfirmed");
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).not.toBe(head);
  expect((await readdir(join(repo, ".git"))).some(name => name.startsWith("matrix-index-"))).toBe(false);
  expect(await readdir(join(home, ".matrix-github-staging"))).toEqual([]);
});

it("pushes the approved SHA even when Terminal changes HEAD and preserves an existing HTTPS origin", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/push"], { cwd: repo });
  await exec("git", ["config", "remote.origin.url", "https://github.com/owner/private-test.git"], { cwd: repo });
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    if (args.includes("push")) {
      expect(args.slice(-2)).toEqual(["https://github.com/owner/private-test.git", `${head}:refs/heads/matrix/push`]);
      await exec("git", ["-c", "user.name=Terminal", "-c", "user.email=terminal@example.com", "commit", "--allow-empty", "-m", "later"], { cwd: repo });
      return { stdout: "", stderr: "" };
    }
    if (args.includes("ls-remote")) return { stdout: `${head}\trefs/heads/matrix/push\n`, stderr: "" };
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "push", path: "repo", expectedHead: head }, signal())).resolves.toMatchObject({ head, pushed: true });
  expect((await exec("git", ["remote", "get-url", "origin"], { cwd: repo })).stdout.trim()).toBe("https://github.com/owner/private-test.git");
});

function draftPullRequest(head: string, branch: string, base: string) {
  return {
    number: 1, url: "https://github.com/owner/private-test/pull/1", author: { login: "owner" },
    isDraft: true, isCrossRepository: false, headRefOid: head, headRefName: branch, baseRefName: base,
    title: "Demo", body: "Proof",
  };
}

it("creates and reuses only the draft matching the approved content and refs", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/pr"], { cwd: repo });
  let pushed = false; let created = false;
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    if (command === "gh") {
      expect(args[args.indexOf("--base") + 1]).toBe("release/1.0");
      if (args[1] === "create") {
        expect(args).toContain("--draft");
        expect(args.slice(-4)).toEqual(["--title", "Demo", "--body", "Proof"]);
        created = true;
        return { stdout: "", stderr: "" };
      }
      expect(args[args.indexOf("--json") + 1]?.split(",")).toEqual(expect.arrayContaining([
        "title", "body", "headRefName", "baseRefName", "isCrossRepository",
      ]));
      return { stdout: JSON.stringify(created ? [draftPullRequest(head, "matrix/pr", "release/1.0")] : []), stderr: "" };
    }
    if (args.includes("ls-remote")) return { stdout: `${pushed ? head : "0".repeat(40)}\trefs/heads/matrix/pr\n`, stderr: "" };
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  const action = { action: "pull_request" as const, path: "repo", expectedHead: head, base: "release/1.0", title: "Demo", body: "Proof" };
  await expect(service.execute(workspace, action, signal())).rejects.toThrow(); expect(created).toBe(false);
  pushed = true;
  await expect(service.execute(workspace, action, signal())).resolves.toMatchObject({ account: "owner", draft: true, pullRequest: "https://github.com/owner/private-test/pull/1", head });
  await expect(service.execute(workspace, action, signal())).resolves.toMatchObject({ draft: true, head });
  expect(run.mock.calls.filter(([command, args]) => command === "gh" && args[1] === "create")).toHaveLength(1);
});

it.each(["release/..", "release/.hidden", "release/1.0.lock", "release/1.0.", "refs/heads/main", "release//1.0", "-main"])(
  "rejects an unsafe pull request base %s",
  base => {
    expect(GithubDeveloperActionSchema.safeParse({
      action: "pull_request", path: "repo", expectedHead: "a".repeat(40), base, title: "Demo", body: "Proof",
    }).success).toBe(false);
  },
);

it("removes clone staging without deleting a concurrent owner file in the visible reservation", async () => {
  const run = vi.fn(async () => { await writeFile(join(workspace, "new", "owner.txt"), "keep"); throw new Error("Clone failed"); });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "clone", repository: "owner/private-test", path: "new" }, signal())).rejects.toThrow();
  expect(await readFile(join(workspace, "new", "owner.txt"), "utf8")).toBe("keep");
  expect((await readdir(workspace)).some(name => name.startsWith(".github-clone-"))).toBe(false);
  expect(await readdir(join(home, ".matrix-github-staging"))).toEqual([]);
});

it.each([
  { title: "Different title" },
  { body: "Proof " },
  { headRefName: "matrix/other" },
  { baseRefName: "release/1.0" },
  { isCrossRepository: true },
])("refuses an existing draft with a different approval payload (%j)", async difference => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/readback"], { cwd: repo });
  const run = vi.fn<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>(async (command, args, options) => {
    if (command === "gh") {
      expect(args[1]).toBe("list");
      return { stdout: JSON.stringify([{ ...draftPullRequest(head, "matrix/readback", "main"), ...difference }]), stderr: "" };
    }
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "pull_request", path: "repo", expectedHead: head, base: "main", title: "Demo", body: "Proof" }, signal()))
    .rejects.toMatchObject({ code: "invalid_arguments" });
  expect(run.mock.calls.filter(([command]) => command === "gh")).toHaveLength(1);
});

it.each([{ isDraft: false }, { title: "Different title" }, { body: "Proof " }])(
  "marks a post-create mismatch as an unconfirmed effect (%j)",
  async difference => {
    const { repo, head } = await repository();
    await exec("git", ["switch", "-c", "matrix/readback"], { cwd: repo });
    let created = false;
    const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
      if (command === "gh") {
        if (args[1] === "create") { created = true; return { stdout: "", stderr: "" }; }
        return { stdout: JSON.stringify(created ? [{ ...draftPullRequest(head, "matrix/readback", "main"), ...difference }] : []), stderr: "" };
      }
      if (args.includes("ls-remote")) return { stdout: `${head}\trefs/heads/matrix/readback\n`, stderr: "" };
      return exec(command, args, options);
    });
    const service = createGithubDeveloperService({ homePath: home, status, run });
    await expect(service.execute(workspace, { action: "pull_request", path: "repo", expectedHead: head, base: "main", title: "Demo", body: "Proof" }, signal()))
      .rejects.toThrow("GitHub pull request outcome unconfirmed");
    expect(created).toBe(true);
  },
);

it("rejects stale HEAD, unready identity, symlinks, outside paths and executable repository config before effects", async () => {
  const { repo, head } = await repository();
  const service = createGithubDeveloperService({ homePath: home, status });
  await expect(service.execute(workspace, { action: "branch", path: "repo", name: "matrix/test", expectedHead: "0".repeat(40) }, signal())).rejects.toThrow();
  await symlink(repo, join(workspace, "linked"));
  await expect(service.execute(workspace, { action: "status", path: "linked" }, signal())).rejects.toThrow();
  await exec("git", ["config", "core.sshCommand", "touch injected"], { cwd: repo });
  await expect(service.execute(workspace, { action: "branch", path: "repo", name: "matrix/test", expectedHead: head }, signal())).rejects.toThrow();
  await expect(createGithubDeveloperService({ homePath: home, status: async () => ({ ready: false, user: null }) })
    .execute(workspace, { action: "clone", repository: "owner/private-test", path: "new" }, signal())).rejects.toThrow();
  await expect(service.execute(workspace, { action: "status", path: "../owner" }, signal())).rejects.toThrow();
  await expect(readFile(join(repo, "injected"))).rejects.toThrow();
});

it("uses only canonical GitHub remotes and clears ambient token and Git override environments", async () => {
  const { head } = await repository();
  vi.stubEnv("GH_TOKEN", "service-secret"); vi.stubEnv("GIT_CONFIG_COUNT", "1");
  const run = vi.fn(async (command: string, args: string[], options: {cwd: string;env: NodeJS.ProcessEnv;signal: AbortSignal;maxBuffer: number}) => {
    expect(options.env.GH_TOKEN).toBeUndefined(); expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(options.env.HOME).toBe(home); expect(options.env.GH_CONFIG_DIR).toBe(join(home, ".config", "gh"));
    return exec(command, args, options);
  });
  try {
    const service = createGithubDeveloperService({ homePath: home, status, run });
    await service.execute(workspace, { action: "branch", path: "repo", name: "matrix/clean-env", expectedHead: head }, signal());
    expect(run).toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it("treats approved wildcard characters literally and preserves matching private files in the owner index", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/literal"], { cwd: repo });
  await writeFile(join(repo, "note*.txt"), "approved\n");
  await writeFile(join(repo, "note-private.txt"), "private\n");
  await exec("git", ["add", "note-private.txt"], { cwd: repo });
  const priorIndex = (await exec("git", ["ls-files", "--stage", "-z"], { cwd: repo })).stdout;
  const service = createGithubDeveloperService({ homePath: home, status });
  await service.execute(workspace, { action: "commit", path: "repo", expectedHead: head, files: ["note*.txt"], message: "literal only" }, signal());
  expect((await exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: repo })).stdout).toBe("note*.txt\n");
  expect((await exec("git", ["ls-files", "--stage", "-z", "--", "note-private.txt"], { cwd: repo })).stdout)
    .toBe(priorIndex.split("\0").find(row => row.endsWith("\tnote-private.txt")) + "\0");
  expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("A  note-private.txt\n");
});

it("commits approved CRLF bytes through built-in text normalization while preserving the worktree", async () => {
  const { repo } = await repository();
  await writeFile(join(repo, ".gitattributes"), "*.txt text eol=lf\n");
  await exec("git", ["add", ".gitattributes"], { cwd: repo });
  await exec("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "attributes"], { cwd: repo });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec("git", ["switch", "-c", "matrix/crlf"], { cwd: repo });
  await writeFile(join(repo, "demo.txt"), "approved\r\n");
  const service = createGithubDeveloperService({ homePath: home, status });
  const action = { action: "commit" as const, path: "repo", expectedHead: head, files: ["demo.txt"], message: "normalize" };
  const plan = await service.inspect(workspace, action, signal());
  // Equal normalized blobs do not authorize different owner working bytes.
  await writeFile(join(repo, "demo.txt"), "approved\n");
  await expect(service.execute(workspace, action, signal(), { plan, assertCurrent: async () => undefined })).rejects.toMatchObject({ code: "denied" });
  await writeFile(join(repo, "demo.txt"), "approved\r\n");
  await service.execute(workspace, action, signal(), { plan, assertCurrent: async () => undefined });
  expect((await exec("git", ["show", "HEAD:demo.txt"], { cwd: repo })).stdout).toBe("approved\n");
  expect(await readFile(join(repo, "demo.txt"), "utf8")).toBe("approved\r\n");
});

it("refuses attributes changed after approval or after staging before moving the ref", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/attributes"], { cwd: repo });
  await writeFile(join(repo, "demo.txt"), "approved\n");
  await writeFile(join(repo, ".gitattributes"), "*.txt text eol=lf\n");
  const service = createGithubDeveloperService({ homePath: home, status });
  const action = { action: "commit" as const, path: "repo", expectedHead: head, files: ["demo.txt"], message: "safe attrs" };
  const plan = await service.inspect(workspace, action, signal());
  await writeFile(join(repo, ".gitattributes"), "*.txt -text\n");
  await expect(service.execute(workspace, action, signal(), { plan, assertCurrent: async () => undefined })).rejects.toThrow();
  await writeFile(join(repo, ".gitattributes"), "*.txt text eol=lf\n");
  let changed = false;
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createService>[0]["run"]>>[2]) => {
    const result = await exec(command, args, options);
    if (args.includes("write-tree")) { await writeFile(join(repo, ".gitattributes"), "*.txt -text\n"); changed = true; }
    return result;
  });
  const guarded = createGithubDeveloperService({ homePath: home, status, run });
  await expect(guarded.execute(workspace, action, signal(), { plan, assertCurrent: async () => undefined })).rejects.toThrow();
  expect(changed).toBe(true);
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).toBe(head);
});

it("accepts a real clone with dotted tracking branch names while still rejecting executable branch config", async () => {
  const { repo } = await repository();
  await exec("git", ["branch", "-m", "release/1.0"], { cwd: repo });
  await exec("git", ["clone", "--no-local", repo, join(workspace, "cloned")]);
  await exec("git", ["config", "remote.origin.url", "git@github.com:owner/private-test.git"], { cwd: join(workspace, "cloned") });
  const service = createGithubDeveloperService({ homePath: home, status });
  await expect(service.execute(workspace, { action: "status", path: "cloned" }, signal())).resolves.toMatchObject({ branch: "release/1.0", repository: "owner/private-test" });
  await exec("git", ["config", "branch.release/1.0.command", "touch injected"], { cwd: join(workspace, "cloned") });
  await expect(service.execute(workspace, { action: "status", path: "cloned" }, signal())).rejects.toThrow();
});
