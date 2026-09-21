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
  await git(root, "config", "user.name", "Project Owner");
  await git(root, "config", "user.email", "owner@example.test");
  return root;
}

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("owner Git driver", () => {
  it("creates new commits under the configured owner identity without rewriting imported authorship", async () => {
    const root = await repository();
    const before = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "member edit\n");
    await git(root, "add", "README.md");
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
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
  });

  it("reports owner Git identity and forge readiness without exposing credentials", async () => {
    const root = await repository();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const setup = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(setup.identity).toEqual({ status: "ready", label: "Project Owner <owner@example.test>" });
    expect(["ready", "missing", "unavailable"]).toContain(setup.forgeCredential.status);
    expect(JSON.stringify(setup)).not.toMatch(/(token|oauth|gho_|ghp_)/i);
    await git(root, "config", "--unset", "user.email");
    const missing = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(missing.identity).toEqual({ status: "missing" });
  });

  it("rejects stale refs and a local or changed push remote before any remote effect", async () => {
    const root = await repository();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
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
