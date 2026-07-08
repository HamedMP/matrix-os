import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index.js";
import { createCodingAgentFileStore } from "../../packages/gateway/src/coding-agents/file-read.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = "2026-07-06T12:00:00.000Z";
const worktreeId = "wt_abc123def456";
const projectId = "matrix-os";

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
  readLimitBytes?: number;
} = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-files-"));
  const worktreeRoot = join(homePath, "projects", projectId, "worktrees", worktreeId);
  await mkdir(join(worktreeRoot, "src"), { recursive: true });
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: async () => runtimeSummary() },
    files: createCodingAgentFileStore({
      homePath,
      ownerId: options.ownerIds?.[0],
      principalOwnerIds: options.ownerIds,
      readLimitBytes: options.readLimitBytes,
    }),
    getPrincipal: () => {
      if (options.principal === null) throw new MissingRequestPrincipalError();
      return options.principal ?? testPrincipal;
    },
  }));
  return { app, homePath, worktreeRoot };
}

describe("coding agent file read route", () => {
  it("returns a bounded text snapshot from an owner worktree", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");

      const res = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        metadata: {
          path: "src/index.ts",
          kind: "file",
          sizeBytes: 26,
        },
        content: "export const answer = 42;\n",
        encoding: "utf8",
        truncated: false,
      });
      expect(body.metadata.etag).toMatch(/^sha256_/);
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-files|secret|token/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlink reads without leaking filesystem paths", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.homePath, "secret.txt"), "secret token");
      await symlink(join(harness.homePath, "secret.txt"), join(harness.worktreeRoot, "src", "linked.txt"));

      const traversal = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=..%2F..%2Fsecret.txt`,
      );
      const symlinkRead = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Flinked.txt`,
      );

      expect(traversal.status).toBe(400);
      expect(await traversal.json()).toEqual({
        error: expect.objectContaining({
          code: "validation_failed",
          safeMessage: "Request could not be processed. Check the inputs and try again.",
        }),
      });
      expect(symlinkRead.status).toBe(404);
      expect(JSON.stringify(await symlinkRead.json())).not.toMatch(/secret|\/tmp|linked\.txt/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("requires the authenticated owner principal", async () => {
    const harness = await createRouteHarness({
      principal: { userId: "other_user", source: "jwt" },
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");

      const res = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );

      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toMatch(/other_user|user_activation_test|\/tmp/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("returns a truncated snapshot when the file exceeds the read limit", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
      readLimitBytes: 12,
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "large.txt"), "0123456789abcdef");

      const res = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Flarge.txt`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.content).toBe("0123456789ab");
      expect(body.truncated).toBe(true);
      expect(body.limitBytes).toBe(12);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });
});
