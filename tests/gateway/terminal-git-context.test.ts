import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalGitContextResolver } from "../../packages/gateway/src/shell/terminal-git-context.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-terminal-git-context-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal Git context", () => {
  it("uses existing workspace and worktree metadata without spawning Git or GitHub lookups", async () => {
    const homePath = await tempRoot();
    const projectRoot = join(homePath, "projects", "matrix-os");
    const worktreeId = "wt_abc123def456";
    const worktreePath = join(projectRoot, "worktrees", worktreeId);
    await mkdir(join(worktreePath, ".matrix"), { recursive: true });
    await mkdir(join(homePath, "system", "sessions"), { recursive: true });
    await writeFile(join(projectRoot, "config.json"), JSON.stringify({
      id: "project_matrix",
      name: "Matrix OS",
      slug: "matrix-os",
      localPath: join(projectRoot, "repo"),
      github: {
        owner: "HamedMP",
        repo: "matrix-os",
        htmlUrl: "https://github.com/HamedMP/matrix-os",
        authState: "ok",
      },
    }));
    await writeFile(join(worktreePath, ".matrix", "worktree.json"), JSON.stringify({
      id: worktreeId,
      projectSlug: "matrix-os",
      path: worktreePath,
      sourceBranch: "main",
      currentBranch: "codex/agent-aware-terminal-sessions",
      pr: { number: 1032 },
      dirtyState: "clean",
      createdAt: "2026-07-19T10:00:00.000Z",
    }));
    await writeFile(join(homePath, "system", "sessions", "sess_context.json"), JSON.stringify({
      id: "sess_context",
      kind: "agent",
      projectSlug: "matrix-os",
      worktreeId,
      pr: 1032,
      runtime: { type: "zellij", status: "running", zellijSession: "calm-otter" },
    }));
    const runCommand = vi.fn();
    const resolver = new TerminalGitContextResolver({ homePath, runCommand });

    await expect(resolver.resolve({ sessionName: "calm-otter" })).resolves.toEqual({
      project: "Matrix OS",
      repository: "HamedMP/matrix-os",
      branch: "codex/agent-aware-terminal-sessions",
      pullRequest: {
        number: 1032,
        url: "https://github.com/HamedMP/matrix-os/pull/1032",
      },
    });
    expect(runCommand).not.toHaveBeenCalled();

    runCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === "git" && args.includes("--show-toplevel")) {
        return { stdout: `${worktreePath}\nupdated-branch\n`, stderr: "" };
      }
      if (command === "git" && args.includes("get-url")) {
        return { stdout: "git@github.com:HamedMP/matrix-os.git\n", stderr: "" };
      }
      if (command === "gh") {
        return {
          stdout: JSON.stringify({ number: 1040, url: "https://github.com/HamedMP/matrix-os/pull/1040" }),
          stderr: "",
        };
      }
      throw new Error("unexpected command");
    });
    await expect(resolver.resolve({ sessionName: "calm-otter", cwd: worktreePath })).resolves.toMatchObject({
      project: "Matrix OS",
      repository: "HamedMP/matrix-os",
      branch: "updated-branch",
      pullRequest: { number: 1040 },
    });
  });

  it("derives repository, branch, and pull request from a focused pane cwd and caches the result", async () => {
    const homePath = await tempRoot();
    const cwd = join(homePath, "projects", "manual-repo", "packages", "gateway");
    const repositoryRoot = join(homePath, "projects", "manual-repo");
    await mkdir(cwd, { recursive: true });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args.includes("--show-toplevel")) {
        return { stdout: `${repositoryRoot}\nfeature/session-context\n`, stderr: "" };
      }
      if (command === "git" && args.includes("get-url")) {
        return { stdout: "git@github.com:acme/manual-repo.git\n", stderr: "" };
      }
      if (command === "gh") {
        return { stdout: JSON.stringify({ number: 77, url: "https://github.com/acme/manual-repo/pull/77" }), stderr: "" };
      }
      throw new Error("unexpected command");
    });
    const resolver = new TerminalGitContextResolver({ homePath, runCommand });

    const expected = {
      project: "manual-repo",
      repository: "acme/manual-repo",
      branch: "feature/session-context",
      pullRequest: { number: 77, url: "https://github.com/acme/manual-repo/pull/77" },
    };
    await expect(resolver.resolve({ sessionName: "manual-shell", cwd })).resolves.toEqual(expected);
    await expect(resolver.resolve({ sessionName: "manual-shell", cwd })).resolves.toEqual(expected);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("omits unavailable context and negatively caches failed Git lookups", async () => {
    const homePath = await tempRoot();
    const cwd = join(homePath, "notes");
    await mkdir(cwd, { recursive: true });
    const runCommand = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    const resolver = new TerminalGitContextResolver({ homePath, runCommand });

    await expect(resolver.resolve({ sessionName: "plain-shell", cwd })).resolves.toBeNull();
    await expect(resolver.resolve({ sessionName: "plain-shell", cwd })).resolves.toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("retries a cache loader after an unexpected metadata read failure", async () => {
    const homePath = await tempRoot();
    const systemPath = join(homePath, "system");
    const sessionsPath = join(systemPath, "sessions");
    await mkdir(systemPath, { recursive: true });
    await writeFile(sessionsPath, "not a directory");
    const resolver = new TerminalGitContextResolver({ homePath, runCommand: vi.fn() });

    await expect(resolver.resolve({ sessionName: "plain-shell" })).rejects.toMatchObject({
      code: "ENOTDIR",
    });

    await rm(sessionsPath);
    await mkdir(sessionsPath);
    await expect(resolver.resolve({ sessionName: "plain-shell" })).resolves.toBeNull();
  });
});
