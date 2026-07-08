import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentSourceControlStore } from "../../packages/gateway/src/coding-agents/source-control.js";
import { MissingRequestPrincipalError, type RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = "2026-07-07T12:00:00.000Z";
const worktreeId = "wt_abc123def456";
const projectId = "matrix-os";
const gitIdentity = ["-c", "user.email=ci@matrix-os.test", "-c", "user.name=Matrix Test"];

function runtimeSummary() {
  return RuntimeSummarySchema.parse({
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: now,
  });
}

async function createRouteHarness(options: {
  principal?: RequestPrincipal | null;
  ownerIds?: string[];
  gitCommandFactory?: (homePath: string) => Promise<string>;
  maxQueueDepth?: number;
} = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-source-control-"));
  const worktreeRoot = join(homePath, "projects", projectId, "worktrees", worktreeId);
  await mkdir(join(worktreeRoot, "src"), { recursive: true });
  await writeFile(join(worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init"], { cwd: worktreeRoot, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: worktreeRoot, stdio: "ignore" });
  execFileSync("git", [...gitIdentity, "commit", "-m", "init"], { cwd: worktreeRoot, stdio: "ignore" });
  const gitCommand = await options.gitCommandFactory?.(homePath);

  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: async () => runtimeSummary() },
    sourceControl: createCodingAgentSourceControlStore({
      homePath,
      ownerId: options.ownerIds?.[0],
      principalOwnerIds: options.ownerIds,
      gitCommand,
      maxQueueDepth: options.maxQueueDepth,
    }),
    getPrincipal: () => {
      if (options.principal === null) throw new MissingRequestPrincipalError();
      return options.principal ?? testPrincipal;
    },
  }));

  return { app, homePath, worktreeRoot };
}

async function createFakeGit(homePath: string, script: string): Promise<string> {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const commandPath = join(homePath, "fake-git");
  await writeFile(commandPath, `#!/usr/bin/env bash\nREAL_GIT=${JSON.stringify(realGit)}\n${script}\nexec "$REAL_GIT" "$@"\n`);
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("coding agent source-control route", () => {
  it("prepares a bounded commit in an owner worktree without exposing credentials or paths", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "other.ts"), "export const other = 1;\n");
      execFileSync("git", ["add", "src/other.ts"], { cwd: harness.worktreeRoot, stdio: "ignore" });
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 43;\n");

      const res = await harness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          clientRequestId: "req_prepare_commit",
        }),
      });
      const body = await res.json();
      const committedContent = execFileSync("git", ["show", "HEAD:src/index.ts"], {
        cwd: harness.worktreeRoot,
        encoding: "utf8",
      });
      const stillStaged = execFileSync("git", ["diff", "--cached", "--name-only", "--", "src/other.ts"], {
        cwd: harness.worktreeRoot,
        encoding: "utf8",
      });

      expect(res.status).toBe(201);
      expect(committedContent).toBe("export const answer = 43;\n");
      expect(() => execFileSync("git", ["show", "HEAD:src/other.ts"], {
        cwd: harness.worktreeRoot,
        stdio: "ignore",
      })).toThrow();
      expect(stillStaged.trim()).toBe("src/other.ts");
      expect(body).toMatchObject({
        status: "committed",
        branch: expect.any(String),
        changedFileCount: 1,
        safeMessage: "Changes were committed.",
      });
      expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-source-control|src\/index|token|bearer|secret/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("unstages bounded paths after a commit failure", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
      gitCommandFactory: (homePath) => createFakeGit(homePath, 'if [ "$1" = "commit" ]; then exit 1; fi'),
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 44;\n");
      execFileSync("git", ["add", "src/index.ts"], { cwd: harness.worktreeRoot, stdio: "ignore" });
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 45;\n");

      const res = await harness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          clientRequestId: "req_prepare_commit_failure",
        }),
      });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", "src/index.ts"], {
        cwd: harness.worktreeRoot,
        encoding: "utf8",
      });
      const stagedContent = execFileSync("git", ["show", ":src/index.ts"], {
        cwd: harness.worktreeRoot,
        encoding: "utf8",
      });

      expect(res.status).toBe(503);
      expect(staged.trim()).toBe("src/index.ts");
      expect(stagedContent).toBe("export const answer = 44;\n");
      expect(await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8")).toBe("export const answer = 45;\n");
      expect(JSON.stringify(await res.json())).not.toMatch(/src\/index|\/tmp|token|secret/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("applies same-worktree backpressure instead of growing an unbounded queue", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
      maxQueueDepth: 1,
      gitCommandFactory: (homePath) => createFakeGit(homePath, 'if [ "$1" = "status" ]; then sleep 1; fi'),
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 45;\n");

      const first = harness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          clientRequestId: "req_prepare_commit_slow",
        }),
      });
      await delay(50);
      const second = await harness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          clientRequestId: "req_prepare_commit_queued",
        }),
      });

      expect(second.status).toBe(503);
      expect(JSON.stringify(await second.json())).not.toMatch(/src\/index|\/tmp|token|secret/i);
      expect((await first).status).toBe(201);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects unchanged, non-owner, invalid, and oversized prepare-commit requests safely", async () => {
    const ownerHarness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    const otherHarness = await createRouteHarness({
      principal: { userId: "other_user", source: "jwt" },
      ownerIds: [testPrincipal.userId],
    });
    try {
      const unchanged = await ownerHarness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          clientRequestId: "req_prepare_commit_clean",
        }),
      });
      const nonOwner = await otherHarness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          clientRequestId: "req_prepare_commit_non_owner",
        }),
      });
      const invalid = await ownerHarness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["../secret.txt"],
          clientRequestId: "req_prepare_commit_invalid_path",
        }),
      });
      const oversized = await ownerHarness.app.request("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          message: "fix: update reviewed files",
          paths: ["src/index.ts"],
          extra: "x".repeat(300_000),
          clientRequestId: "req_prepare_commit_oversized",
        }),
      });

      expect(unchanged.status).toBe(409);
      expect(nonOwner.status).toBe(404);
      expect(invalid.status).toBe(400);
      expect(oversized.status).toBe(413);
      expect(JSON.stringify(await unchanged.json())).not.toMatch(/\/tmp|src\/index|other_user|token|secret/i);
      expect(JSON.stringify(await nonOwner.json())).not.toMatch(/\/tmp|src\/index|other_user|token|secret/i);
      expect(JSON.stringify(await invalid.json())).not.toMatch(/\/tmp|secret\.txt|token/i);
      expect(JSON.stringify(await oversized.json())).not.toMatch(/x{64}|\/tmp|token/i);
      expect(await readFile(join(ownerHarness.worktreeRoot, "src", "index.ts"), "utf8")).toBe("export const answer = 42;\n");
    } finally {
      await rm(ownerHarness.homePath, { recursive: true, force: true });
      await rm(otherHarness.homePath, { recursive: true, force: true });
    }
  });
});
