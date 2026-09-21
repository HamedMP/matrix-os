import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPushFailure, createProjectGitDriver } from "../../packages/gateway/src/collaboration/project-git-operations.js";

const run = promisify(execFile);
const HEAD_SHA = /^[a-f0-9]{40}$/;
const OWNER = "user_git_owner";
const PROJECT = "proj_git_identity";
const rootPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-git-broker-"));
  rootPaths.push(root);
  await mkdir(root, { recursive: true });
  await git(root, "init", "-b", "feature/member");
  await writeFile(join(root, "README.md"), "imported\n");
  await git(root, "add", "README.md");
  await git(root, "-c", "user.name=Imported Author", "-c", "user.email=imported@example.test", "commit", "-m", "imported");
  // The repository config is member-writable inside the sandbox; it must never supply the owner identity.
  await git(root, "config", "user.name", "Repo Local Impostor");
  await git(root, "config", "user.email", "impostor@example.test");
  return root;
}

/** Owner-controlled home with the owner's global Git identity; never mounted into the sandbox. */
async function ownerHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "matrix-git-owner-home-"));
  rootPaths.push(home);
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Project Owner\n\temail = owner@example.test\n");
  return home;
}

/** A recording `gh` stand-in: no forge is contacted, every invocation is appended to `record`. */
async function fakeGh(): Promise<{ bin: string; record: string; failMarker: string }> {
  const bin = await mkdtemp(join(tmpdir(), "matrix-fake-gh-"));
  rootPaths.push(bin);
  const record = join(bin, "record.jsonl");
  const failMarker = join(bin, "fail-create");
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("--body-file") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, stdinLength: stdin.length }) + "\\n");
if (args[0] === "auth") process.exit(0);
if (args[0] === "pr" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }
if (args[0] === "pr" && args[1] === "create") {
  if (fs.existsSync(${JSON.stringify(failMarker)})) { process.stderr.write("GraphQL: validation failed\\n"); process.exit(1); }
  process.stdout.write("https://github.com/owner/repo/pull/7\\n");
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  return { bin, record, failMarker };
}

async function recorded(record: string): Promise<{ args: string[]; cwd: string; env: Record<string, string>; stdinLength: number }[]> {
  return (await readFile(record, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function driverFor(root: string, home: string) {
  return createProjectGitDriver({ resolveProjectRoot: async () => root, ownerHome: home });
}

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("push failure classification", () => {
  it("treats spawn, rejected-ref and pre-transfer failures as failed and only transfer-phase loss as unknown", () => {
    expect(classifyPushFailure({ code: "E2BIG" })).toBe("failed");
    expect(classifyPushFailure({ code: "ENOENT" })).toBe("failed");
    expect(classifyPushFailure({ code: 1, stdout: "!\trefs/heads/feature/member:refs/heads/feature/member\t[rejected] (fetch first)\nDone\n", stderr: "error: failed to push some refs to 'https://github.com/owner/repo.git'\n" })).toBe("failed");
    expect(classifyPushFailure({ code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" })).toBe("failed");
    expect(classifyPushFailure({ code: 128, stderr: "remote: Permission to owner/repo.git denied to member.\nfatal: unable to access 'https://github.com/owner/repo.git/': The requested URL returned error: 403\n" })).toBe("failed");
    expect(classifyPushFailure({ code: 128, stderr: "fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com\n" })).toBe("failed");
    expect(classifyPushFailure({ code: 1, stderr: "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nsend-pack: unexpected disconnect while reading sideband packet\n" })).toBe("unknown");
    expect(classifyPushFailure({ code: null, killed: true, signal: "SIGTERM" })).toBe("unknown");
  });
});

describe("owner Git driver", () => {
  it("creates new commits under the owner's global identity, ignoring the member-writable repository config", async () => {
    const root = await repository();
    const before = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "member edit\n");
    await git(root, "add", "README.md");
    const driver = driverFor(root, await ownerHome());
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    expect(ownerIdentity).toEqual({ name: "Project Owner", email: "owner@example.test", label: "Project Owner <owner@example.test>" });
    const result = await driver.run({
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      runId: "run_member_commit",
      ownerIdentity,
      request: { type: "commit", clientRequestId: "80000000-0000-4000-8000-000000000003", expectedRevision: "1", payloadHash: "a".repeat(64), message: "feat: shared edit", expectedHeadSha: before },
    });
    expect(result.commitSha).toMatch(HEAD_SHA);
    expect(await git(root, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe("Project Owner <owner@example.test>|Project Owner <owner@example.test>");
    expect(await git(root, "log", "-2", "--format=%an <%ae>")).toContain("Imported Author <imported@example.test>");
    expect(await git(root, "log", "--format=%an %cn")).not.toContain("Impostor");
  });

  it("reports the identity as missing when the owner has no global identity even if the repository config has one", async () => {
    const root = await repository();
    const home = await mkdtemp(join(tmpdir(), "matrix-git-owner-home-empty-"));
    rootPaths.push(home);
    const driver = driverFor(root, home);
    await expect(driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT })).rejects.toMatchObject({ code: "unavailable" });
    const setup = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(setup.identity).toEqual({ status: "missing" });
  });

  it("reports owner Git identity and forge readiness without exposing credentials", async () => {
    const root = await repository();
    const home = await ownerHome();
    const driver = driverFor(root, home);
    const setup = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(setup.identity).toEqual({ status: "ready", label: "Project Owner <owner@example.test>" });
    expect(["ready", "missing", "unavailable"]).toContain(setup.forgeCredential.status);
    expect(JSON.stringify(setup)).not.toMatch(/(token|oauth|gho_|ghp_)/i);
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Project Owner\n");
    const missing = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(missing.identity).toEqual({ status: "missing" });
  });

  it("fails closed when the member-writable repository config carries transport or include overrides", async () => {
    const root = await repository();
    await git(root, "remote", "add", "origin", "https://github.com/owner/repo.git");
    const driver = driverFor(root, await ownerHome());
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const execution = {
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
      request: { type: "push" as const, clientRequestId: "80000000-0000-4000-8000-000000000005", expectedRevision: "1", payloadHash: "c".repeat(64), branch: "feature/member", expectedHeadSha: await git(root, "rev-parse", "HEAD") },
    };
    await git(root, "config", "http.proxy", "http://127.0.0.1:9");
    await expect(driver.run(execution)).rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
    await expect(driver.reconcile(execution)).rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
    await git(root, "config", "--unset", "http.proxy");
    await writeFile(join(root, ".git", "member.inc"), '[url "http://127.0.0.1:9/"]\n\tpushInsteadOf = https://github.com/\n');
    await git(root, "config", "include.path", "member.inc");
    await expect(driver.run(execution)).rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
    await expect(driver.reconcile(execution)).rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
  });

  it("streams a large PR body over stdin and runs gh in an empty private cwd without repository or global Git config", async () => {
    const root = await repository();
    await git(root, "remote", "add", "origin", "https://github.com/owner/repo.git");
    const home = await ownerHome();
    const gh = await fakeGh();
    const originalPath = process.env.PATH;
    const originalToken = process.env.GH_TOKEN;
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "must-not-leak";
    const driver = driverFor(root, home);
    try {
      const body = "x".repeat(200 * 1024);
      const execution = {
        operationId: "80000000-0000-4000-8000-000000000001",
        scopeId: "80000000-0000-4000-8000-000000000002",
        ownerId: OWNER,
        projectId: PROJECT,
        requestingActorId: "user_member",
        ownerIdentity: { name: "Project Owner", email: "owner@example.test", label: "Project Owner <owner@example.test>" },
        request: { type: "pr" as const, clientRequestId: "80000000-0000-4000-8000-000000000007", expectedRevision: "1", payloadHash: "e".repeat(64), title: "Large body", baseBranch: "main", headBranch: "feature/member", body, expectedHeadSha: await git(root, "rev-parse", "HEAD") },
      };
      const result = await driver.run(execution);
      expect(result).toEqual({ commitSha: execution.request.expectedHeadSha, remoteBranch: "feature/member", prUrl: "https://github.com/owner/repo/pull/7" });
      const calls = await recorded(gh.record);
      const create = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
      expect(create).toBeDefined();
      expect(create!.args).toEqual(expect.arrayContaining(["--repo", "owner/repo", "--base", "main", "--head", "feature/member", "--title", "Large body", "--body-file", "-"]));
      expect(create!.args).not.toContain("--body");
      expect(create!.args.join("\n")).not.toContain("xxxx");
      expect(create!.stdinLength).toBe(body.length);
      for (const call of calls) {
        expect(call.cwd).not.toBe(root);
        expect(call.cwd.startsWith(root)).toBe(false);
        expect(call.cwd.startsWith(home)).toBe(false);
        expect(await readdir(call.cwd)).toEqual([]);
        expect((await stat(call.cwd)).mode & 0o077).toBe(0);
        expect(call.env).toMatchObject({ HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GH_PROMPT_DISABLED: "1" });
        expect(call.env.GH_TOKEN).toBeUndefined();
      }
      await writeFile(gh.failMarker, "");
      await expect(driver.run({ ...execution, request: { ...execution.request, clientRequestId: "80000000-0000-4000-8000-000000000008" } }))
        .rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
      const cwd = calls[0]!.cwd;
      await driver.close();
      await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.env.PATH = originalPath;
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    }
  });

  it("refuses a project root whose .git is a gitdir file or symlink pointing at another repository", async () => {
    const victim = await repository();
    const victimHead = await git(victim, "rev-parse", "HEAD");
    const home = await ownerHome();
    for (const variant of ["gitdir-file", "symlink"] as const) {
      const root = await mkdtemp(join(tmpdir(), "matrix-git-broker-alias-"));
      rootPaths.push(root);
      if (variant === "gitdir-file") await writeFile(join(root, ".git"), `gitdir: ${join(victim, ".git")}\n`);
      else await symlink(join(victim, ".git"), join(root, ".git"));
      const driver = driverFor(root, home);
      await expect(driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT })).resolves.toMatchObject({ identity: { status: "unavailable" } });
      await expect(driver.run({
        operationId: "80000000-0000-4000-8000-000000000001",
        scopeId: "80000000-0000-4000-8000-000000000002",
        ownerId: OWNER,
        projectId: PROJECT,
        requestingActorId: "user_member",
        ownerIdentity: { name: "Project Owner", email: "owner@example.test", label: "Project Owner <owner@example.test>" },
        request: { type: "commit", clientRequestId: "80000000-0000-4000-8000-000000000006", expectedRevision: "1", payloadHash: "d".repeat(64), message: "hijack", expectedHeadSha: victimHead },
      })).rejects.toMatchObject({ name: "ProjectGitBrokerError", code: "unavailable" });
    }
    expect(await git(victim, "rev-parse", "HEAD")).toBe(victimHead);
  });

  it("rejects stale refs and a local or changed push remote before any remote effect", async () => {
    const root = await repository();
    const driver = driverFor(root, await ownerHome());
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const common = {
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
    };
    await expect(driver.run({ ...common, request: { type: "commit", clientRequestId: "80000000-0000-4000-8000-000000000003", expectedRevision: "1", payloadHash: "a".repeat(64), message: "stale", expectedHeadSha: "0".repeat(40) } }))
      .rejects.toMatchObject({ code: "conflict" });
    await git(root, "remote", "add", "origin", root);
    await expect(driver.run({ ...common, request: { type: "push", clientRequestId: "80000000-0000-4000-8000-000000000004", expectedRevision: "1", payloadHash: "b".repeat(64), branch: "feature/member", expectedHeadSha: await git(root, "rev-parse", "HEAD") } }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
