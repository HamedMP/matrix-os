import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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

const ambientHome = process.env.HOME;
const ambientXdgConfigHome = process.env.XDG_CONFIG_HOME;
const ambientPath = process.env.PATH;

/** Identity reads honour ordinary Git config precedence, so tests pin the owner home they assert against. */
async function ownerHome(gitconfig?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "matrix-git-home-"));
  rootPaths.push(home);
  if (gitconfig) await writeFile(join(home, ".gitconfig"), gitconfig);
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  return home;
}

afterEach(async () => {
  if (ambientHome === undefined) delete process.env.HOME;
  else process.env.HOME = ambientHome;
  if (ambientXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ambientXdgConfigHome;
  if (ambientPath === undefined) delete process.env.PATH;
  else process.env.PATH = ambientPath;
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
    await ownerHome();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const setup = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(setup.identity).toEqual({ status: "ready", label: "Project Owner <owner@example.test>" });
    expect(["ready", "missing", "unavailable"]).toContain(setup.forgeCredential.status);
    expect(JSON.stringify(setup)).not.toMatch(/(token|oauth|gho_|ghp_)/i);
    await git(root, "config", "--unset", "user.email");
    const missing = await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT });
    expect(missing.identity).toEqual({ status: "missing" });
  });

  it("resolves the owner identity from the owner's ordinary global Git configuration", async () => {
    const root = await repository();
    await git(root, "config", "--unset", "user.name");
    await git(root, "config", "--unset", "user.email");
    await ownerHome("[user]\n\tname = Global Owner\n\temail = global@example.test\n");
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    expect(await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT }))
      .toEqual({ name: "Global Owner", email: "global@example.test", label: "Global Owner <global@example.test>" });
    expect((await driver.getGitSetup({ ownerId: OWNER, projectId: PROJECT })).identity)
      .toEqual({ status: "ready", label: "Global Owner <global@example.test>" });
  });

  it("reconciles a landed commit by operation instead of leaving its effect unattested", async () => {
    const root = await repository();
    await ownerHome();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const before = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "member edit\n");
    await git(root, "add", "README.md");
    const execution = {
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
      request: {
        type: "commit" as const,
        clientRequestId: "80000000-0000-4000-8000-000000000003",
        expectedRevision: "1",
        payloadHash: "a".repeat(64),
        message: "feat: shared edit",
        expectedHeadSha: before,
      },
    };
    expect(await driver.reconcile(execution)).toBeNull();
    await driver.run(execution);
    expect(await driver.reconcile(execution)).toEqual({ commitSha: await git(root, "rev-parse", "HEAD") });
  });

  it("does not claim an unrelated commit as the reconciled effect", async () => {
    const root = await repository();
    await ownerHome();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const before = await git(root, "rev-parse", "HEAD");
    await git(root, "-c", "user.name=Someone Else", "-c", "user.email=other@example.test",
      "commit", "--allow-empty", "-m", "chore: unrelated");
    expect(await driver.reconcile({
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
      request: {
        type: "commit" as const,
        clientRequestId: "80000000-0000-4000-8000-000000000004",
        expectedRevision: "1",
        payloadHash: "b".repeat(64),
        message: "feat: shared edit",
        expectedHeadSha: before,
      },
    })).toBeNull();
  });

  it("keeps a commit failure that never moved HEAD a definite failure", async () => {
    const root = await repository();
    await ownerHome();
    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const before = await git(root, "rev-parse", "HEAD");
    await expect(driver.run({
      operationId: "80000000-0000-4000-8000-000000000001",
      scopeId: "80000000-0000-4000-8000-000000000002",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
      request: {
        type: "commit" as const,
        clientRequestId: "80000000-0000-4000-8000-000000000005",
        expectedRevision: "1",
        payloadHash: "c".repeat(64),
        message: "feat: nothing staged",
        expectedHeadSha: before,
      },
    })).rejects.toMatchObject({ code: "unavailable" });
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
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

  it.each([
    ["SSH", "git@github.com:HamedMP/matrix-os.git"],
    ["HTTPS", "https://github.com/HamedMP/matrix-os.git"],
  ])("preserves an existing %s GitHub remote for owner-authenticated pushes", async (_label, remoteUrl) => {
    const root = await repository();
    const home = await ownerHome();
    await git(root, "remote", "add", "origin", remoteUrl);
    const realGit = (await run("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const fakeBin = join(home, "bin");
    const logPath = join(home, "git-commands.log");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "git"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case " $* " in
  *" push "*) exit 0 ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`);
    await chmod(join(fakeBin, "git"), 0o755);
    process.env.PATH = `${fakeBin}:${ambientPath ?? "/usr/bin:/bin"}`;

    const driver = createProjectGitDriver({ resolveProjectRoot: async () => root });
    const ownerIdentity = await driver.resolveOwnerIdentity({ ownerId: OWNER, projectId: PROJECT });
    const head = await git(root, "rev-parse", "HEAD");
    await expect(driver.run({
      operationId: "80000000-0000-4000-8000-000000000011",
      scopeId: "80000000-0000-4000-8000-000000000012",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity,
      request: {
        type: "push",
        clientRequestId: "80000000-0000-4000-8000-000000000013",
        expectedRevision: "1",
        payloadHash: "d".repeat(64),
        branch: "feature/member",
        expectedHeadSha: head,
      },
    })).resolves.toEqual({ commitSha: head, remoteBranch: "feature/member" });
    expect(await readFile(logPath, "utf8")).toContain(`push --porcelain -- ${remoteUrl} ${head}:refs/heads/feature/member`);
  });

  it.each(["ordinary checkout", "linked worktree", "shallow clone"])("isolates the SSH transport for a %s", async (kind) => {
    const main = await repository();
    const home = await ownerHome();
    const linked = kind === "linked worktree";
    const shallow = kind === "shallow clone";
    const root = linked || shallow ? join(home, "checkout") : main;
    const branch = linked ? "feature/linked" : "feature/member";
    if (linked) await git(main, "worktree", "add", "-b", branch, root);
    const remote = join(home, "remote.git");
    if (shallow) {
      await git(main, "commit", "--allow-empty", "-m", "base history");
      await git(home, "clone", "--depth=1", pathToFileURL(main).href, root);
      await git(home, "clone", "--bare", main, remote);
      await git(root, "-c", "user.name=Member", "-c", "user.email=member@example.test", "commit", "--allow-empty", "-m", "shallow change");
    } else {
      await git(home, "init", "--bare", remote);
    }
    // The fixture only connects to the local bare remote through a fake SSH process.
    const fakeBin = join(home, "bin");
    const sshLog = join(home, "ssh.log");
    const unsafeMarker = join(home, "unsafe-command-executed");
    const unsafeCommand = join(home, "checkout-ssh");
    await mkdir(fakeBin);
    await writeFile(unsafeCommand, `#!/bin/sh
touch "${unsafeMarker}"
exit 1
`, { mode: 0o700 });
    await git(root, "remote", shallow ? "set-url" : "add", "origin", "git@github.com:owner/private-repo");
    await git(root, "config", "core.sshCommand", unsafeCommand);
    await git(root, "config", "ssh.variant", "ssh");
    // A rewrite that applies only to the normalized outbound URL.
    await writeFile(join(linked ? main : root, ".git", "extra-config"), `[url "ext::${unsafeCommand}"]\n\tinsteadOf = git@github.com:owner/private-repo.git\n[protocol "ext"]\n\tallow = always\n`);
    await git(root, "config", "include.path", "extra-config");
    await writeFile(join(fakeBin, "ssh"), `#!/bin/sh
printf '%s\\n' "$@" >> "${sshLog}"
for arg do command=$arg; done
case "$command" in
  "git-receive-pack "*) exec git receive-pack "${remote}" ;;
  "git-upload-pack "*) exec git upload-pack "${remote}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const head = await git(root, "rev-parse", "HEAD");
    const tree = await git(root, "rev-parse", "HEAD^{tree}");
    const next = await git(root, "-c", "user.name=Member", "-c", "user.email=member@example.test",
      "commit-tree", tree, "-p", head, "-m", "concurrent branch update");
    const realGit = (await run("which", ["git"], { encoding: "utf8" })).stdout.trim();
    await writeFile(join(fakeBin, "git"), `#!/bin/sh
for arg do
  if [ "$arg" = push ]; then
    [ "$("${realGit}" rev-parse --is-shallow-repository)" = "${shallow}" ] || exit 1
    "${realGit}" -C "${root}" update-ref "refs/heads/${branch}" "${next}" || exit 1
    break
  fi
done
exec "${realGit}" "$@"
`, { mode: 0o700 });
    process.env.PATH = `${fakeBin}:${ambientPath ?? "/usr/bin:/bin"}`;

    const driver = createProjectGitDriver({ homePath: home, resolveProjectRoot: async () => root });
    const execution = {
      operationId: "80000000-0000-4000-8000-000000000021",
      scopeId: "80000000-0000-4000-8000-000000000022",
      ownerId: OWNER,
      projectId: PROJECT,
      requestingActorId: "user_member",
      ownerIdentity: { name: "Owner", email: "owner@example.test", label: "Owner <owner@example.test>" },
      request: {
        type: "push" as const,
        clientRequestId: "80000000-0000-4000-8000-000000000023",
        expectedRevision: "1",
        payloadHash: "e".repeat(64),
        branch,
        expectedHeadSha: head,
      },
    };
    await expect(driver.run(execution)).resolves.toEqual({ commitSha: head, remoteBranch: branch });
    expect(await git(root, "rev-parse", "HEAD")).toBe(next);
    expect(await git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(head);
    await expect(driver.reconcile(execution)).resolves.toEqual({ commitSha: head, remoteBranch: branch });
    await expect(readFile(unsafeMarker)).rejects.toMatchObject({ code: "ENOENT" });
    const sshArgs = await readFile(sshLog, "utf8");
    expect(sshArgs).toContain("StrictHostKeyChecking=yes");
    expect(sshArgs).toContain(`UserKnownHostsFile=${join(home, ".ssh", "matrix-github-known-hosts")}`);
    if (linked) {
      const forged = join(home, "forged");
      await mkdir(forged);
      await writeFile(join(forged, ".git"), await readFile(join(root, ".git")));
      const forgedDriver = createProjectGitDriver({ homePath: home, resolveProjectRoot: async () => forged });
      await expect(forgedDriver.run({ ...execution, request: { ...execution.request, expectedHeadSha: next } }))
        .rejects.toMatchObject({ code: "unavailable" });
      expect(await readFile(sshLog, "utf8")).toBe(sshArgs);
    }
  });
});
