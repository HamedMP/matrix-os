import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectGitDriver } from "../../packages/gateway/src/collaboration/project-git-operations.js";

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

function driverFor(root: string, home: string) {
  return createProjectGitDriver({ resolveProjectRoot: async () => root, ownerHome: home });
}

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
