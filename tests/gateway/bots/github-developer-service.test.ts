import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
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

it("does not create a PR until the remote branch matches, then verifies draft, actor and exact head", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/pr"], { cwd: repo });
  let pushed = false; let created = false;
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    if (command === "gh") {
      if (args[1] === "create") { expect(args).toContain("--draft"); created = true; return { stdout: "", stderr: "" }; }
      return { stdout: JSON.stringify(created ? [{ number: 1, url: "https://github.com/owner/private-test/pull/1", author: { login: "owner" }, isDraft: true, headRefOid: head }] : []), stderr: "" };
    }
    if (args.includes("ls-remote")) return { stdout: `${pushed ? head : "0".repeat(40)}\trefs/heads/matrix/pr\n`, stderr: "" };
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  const action = { action: "pull_request" as const, path: "repo", expectedHead: head, base: "main", title: "Demo", body: "Proof" };
  await expect(service.execute(workspace, action, signal())).rejects.toThrow(); expect(created).toBe(false);
  pushed = true;
  await expect(service.execute(workspace, action, signal())).resolves.toMatchObject({ account: "owner", draft: true, pullRequest: "https://github.com/owner/private-test/pull/1", head });
  expect(run.mock.calls.filter(([command, args]) => command === "gh" && args[1] === "create")).toHaveLength(1);
});

it("removes clone staging without deleting a concurrent owner file in the visible reservation", async () => {
  const run = vi.fn(async () => { await writeFile(join(workspace, "new", "owner.txt"), "keep"); throw new Error("Clone failed"); });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "clone", repository: "owner/private-test", path: "new" }, signal())).rejects.toThrow();
  expect(await readFile(join(workspace, "new", "owner.txt"), "utf8")).toBe("keep");
  expect((await readdir(workspace)).some(name => name.startsWith(".github-clone-"))).toBe(false);
  expect(await readdir(join(home, ".matrix-github-staging"))).toEqual([]);
});

it("marks a post-create actor/draft mismatch as an unconfirmed effect rather than a replayable refusal", async () => {
  const { repo, head } = await repository();
  await exec("git", ["switch", "-c", "matrix/readback"], { cwd: repo });
  let created = false;
  const run = vi.fn(async (command: string, args: string[], options: Parameters<NonNullable<Parameters<typeof createGithubDeveloperService>[0]["run"]>>[2]) => {
    if (command === "gh") {
      if (args[1] === "create") { created = true; return { stdout: "", stderr: "" }; }
      return { stdout: JSON.stringify(created ? [{ number: 1, url: "https://github.com/owner/private-test/pull/1", author: { login: "owner" }, isDraft: false, headRefOid: head }] : []), stderr: "" };
    }
    if (args.includes("ls-remote")) return { stdout: `${head}\trefs/heads/matrix/readback\n`, stderr: "" };
    return exec(command, args, options);
  });
  const service = createGithubDeveloperService({ homePath: home, status, run });
  await expect(service.execute(workspace, { action: "pull_request", path: "repo", expectedHead: head, base: "main", title: "Demo", body: "Proof" }, signal()))
    .rejects.toThrow("GitHub pull request outcome unconfirmed");
  expect(created).toBe(true);
});

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
