import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  it("browses direct owner worktree entries without exposing symlinks or internal paths", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await mkdir(join(harness.worktreeRoot, "src", "nested"), { recursive: true });
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      await writeFile(join(harness.worktreeRoot, "src", "nested", "helper.ts"), "export {};\n");
      await writeFile(join(harness.worktreeRoot, "src", "readme.md"), "# Notes\n");
      await symlink(join(harness.homePath, "secret.txt"), join(harness.worktreeRoot, "src", "linked.txt"));

      const res = await harness.app.request(
        `/api/coding-agents/files/browse?projectId=${projectId}&worktreeId=${worktreeId}&path=src&limit=2`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.directory).toMatchObject({ path: "src", kind: "directory" });
      expect(body.entries).toMatchObject({
        hasMore: true,
        limit: 2,
      });
      expect(body.entries.items.map((entry: { path: string }) => entry.path)).toEqual([
        "src/index.ts",
        "src/nested",
      ]);
      expect(body.entries.items.find((entry: { path: string }) => entry.path.includes("linked"))).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-files|secret|token/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("marks browse results partial when skipped entries exhaust the inspect budget", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await mkdir(join(harness.worktreeRoot, "skipped"), { recursive: true });
      await Promise.all(Array.from({ length: 105 }, async (_, index) => {
        await symlink(
          join(harness.homePath, `missing-${index}.txt`),
          join(harness.worktreeRoot, "skipped", `link-${String(index).padStart(4, "0")}.txt`),
        );
      }));

      const res = await harness.app.request(
        `/api/coding-agents/files/browse?projectId=${projectId}&worktreeId=${worktreeId}&path=skipped&limit=10`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.entries.items).toEqual([]);
      expect(body.entries.hasMore).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-files|missing-104/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("searches bounded owner worktree file paths and hides inaccessible worktrees", async () => {
    const ownerHarness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    const otherHarness = await createRouteHarness({
      principal: { userId: "other_user", source: "jwt" },
      ownerIds: [testPrincipal.userId],
    });
    try {
      await mkdir(join(ownerHarness.worktreeRoot, "src", "nested"), { recursive: true });
      await writeFile(join(ownerHarness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      await writeFile(join(ownerHarness.worktreeRoot, "src", "nested", "index.test.ts"), "test('answer', () => {});\n");
      await writeFile(join(ownerHarness.worktreeRoot, "src", "nested", "ignore.md"), "# Notes\n");

      const res = await ownerHarness.app.request(
        `/api/coding-agents/files/search?projectId=${projectId}&worktreeId=${worktreeId}&query=index&path=src&limit=1`,
      );
      const body = await res.json();
      const otherRes = await otherHarness.app.request(
        `/api/coding-agents/files/search?projectId=${projectId}&worktreeId=${worktreeId}&query=index`,
      );

      expect(res.status).toBe(200);
      expect(body.matches).toMatchObject({
        hasMore: true,
        limit: 1,
      });
      expect(body.matches.items).toEqual([expect.objectContaining({
        path: "src/index.ts",
        kind: "file",
      })]);
      expect(otherRes.status).toBe(404);
      expect(JSON.stringify(await otherRes.json())).not.toMatch(/other_user|user_activation_test|\/tmp/i);
    } finally {
      await rm(ownerHarness.homePath, { recursive: true, force: true });
      await rm(otherHarness.homePath, { recursive: true, force: true });
    }
  });

  it("marks wide search results partial when the scan budget is exhausted", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await mkdir(join(harness.worktreeRoot, "wide"), { recursive: true });
      await Promise.all(Array.from({ length: 2_005 }, async (_, index) => {
        await writeFile(join(harness.worktreeRoot, "wide", `entry-${String(index).padStart(4, "0")}.ts`), "export {};\n");
      }));

      const res = await harness.app.request(
        `/api/coding-agents/files/search?projectId=${projectId}&worktreeId=${worktreeId}&query=missing&path=wide&limit=10`,
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.matches.items).toEqual([]);
      expect(body.matches.hasMore).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-files|entry-2004/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

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

  it("writes a bounded text update when the base etag matches", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      const readRes = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const readBody = await readRes.json();

      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/index.ts",
          content: "export const answer = 43;\n",
          encoding: "utf8",
          baseEtag: readBody.metadata.etag,
          clientRequestId: "req_write_index",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8")).toBe("export const answer = 43;\n");
      expect(body).toMatchObject({
        metadata: {
          path: "src/index.ts",
          kind: "file",
          sizeBytes: 26,
        },
        encoding: "utf8",
        writtenBytes: 26,
      });
      expect(body.metadata.etag).toMatch(/^sha256_/);
      expect(body.metadata.etag).not.toBe(readBody.metadata.etag);
      expect(JSON.stringify(body)).not.toMatch(/\/tmp\/matrix-coding-agent-files|secret|token/i);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects stale file writes without changing content or leaking paths", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");

      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/index.ts",
          content: "export const answer = 43;\n",
          encoding: "utf8",
          baseEtag: "sha256_stale",
          clientRequestId: "req_write_stale",
        }),
      });

      expect(res.status).toBe(409);
      expect(await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8")).toBe("export const answer = 42;\n");
      expect(await res.json()).toEqual({
        error: expect.objectContaining({
          code: "file_conflict",
          safeMessage: "File changed before the update could be saved. Refresh and try again.",
        }),
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes so only one matching base etag update wins", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      const readRes = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const readBody = await readRes.json();
      const writeBody = (content: string, clientRequestId: string) => JSON.stringify({
        projectId,
        worktreeId,
        path: "src/index.ts",
        content,
        encoding: "utf8",
        baseEtag: readBody.metadata.etag,
        clientRequestId,
      });

      const [first, second] = await Promise.all([
        harness.app.request("/api/coding-agents/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: writeBody("export const answer = 43;\n", "req_write_race_a"),
        }),
        harness.app.request("/api/coding-agents/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: writeBody("export const answer = 44;\n", "req_write_race_b"),
        }),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);

      expect(statuses).toEqual([200, 409]);
      expect(["export const answer = 43;\n", "export const answer = 44;\n"]).toContain(
        await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8"),
      );
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("serializes matching base etag updates through symlinked directories by canonical target", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      await symlink(join(harness.worktreeRoot, "src"), join(harness.worktreeRoot, "alias"));
      const readRes = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const readBody = await readRes.json();
      const writeBody = (path: string, content: string, clientRequestId: string) => JSON.stringify({
        projectId,
        worktreeId,
        path,
        content,
        encoding: "utf8",
        baseEtag: readBody.metadata.etag,
        clientRequestId,
      });

      const [direct, alias] = await Promise.all([
        harness.app.request("/api/coding-agents/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: writeBody("src/index.ts", "export const answer = 43;\n", "req_write_direct_path"),
        }),
        harness.app.request("/api/coding-agents/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: writeBody("alias/index.ts", "export const answer = 44;\n", "req_write_alias_path"),
        }),
      ]);
      const statuses = [direct.status, alias.status].sort((a, b) => a - b);

      expect(statuses).toEqual([200, 409]);
      expect(["export const answer = 43;\n", "export const answer = 44;\n"]).toContain(
        await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8"),
      );
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("preserves existing executable file mode when saving content", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      const scriptPath = join(harness.worktreeRoot, "src", "script.sh");
      await writeFile(scriptPath, "#!/usr/bin/env bash\necho old\n");
      await chmod(scriptPath, 0o755);
      const readRes = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Fscript.sh`,
      );
      const readBody = await readRes.json();

      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/script.sh",
          content: "#!/usr/bin/env bash\necho new\n",
          encoding: "utf8",
          baseEtag: readBody.metadata.etag,
          clientRequestId: "req_write_executable",
        }),
      });

      expect(res.status).toBe(200);
      expect((await stat(scriptPath)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects updates based on truncated snapshots before replacing the file", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
      readLimitBytes: 12,
    });
    try {
      const filePath = join(harness.worktreeRoot, "src", "large.txt");
      await writeFile(filePath, "0123456789abcdef");
      const readRes = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Flarge.txt`,
      );
      const readBody = await readRes.json();
      expect(readBody.truncated).toBe(true);

      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/large.txt",
          content: "0123456789ab",
          encoding: "utf8",
          baseEtag: readBody.metadata.etag,
          clientRequestId: "req_write_truncated_base",
        }),
      });

      expect(res.status).toBe(409);
      expect(await readFile(filePath, "utf8")).toBe("0123456789abcdef");
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("treats identical retries as idempotent but rejects stale retries after newer content", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(harness.worktreeRoot, "src", "index.ts"), "export const answer = 42;\n");
      const readInitial = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const initialBody = await readInitial.json();
      const firstSave = {
        projectId,
        worktreeId,
        path: "src/index.ts",
        content: "export const answer = 43;\n",
        encoding: "utf8",
        baseEtag: initialBody.metadata.etag,
        clientRequestId: "req_write_retry",
      };

      const first = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstSave),
      });
      const sameRetry = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstSave),
      });
      const readCurrent = await harness.app.request(
        `/api/coding-agents/files/read?projectId=${projectId}&worktreeId=${worktreeId}&path=src%2Findex.ts`,
      );
      const currentBody = await readCurrent.json();
      const newer = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...firstSave,
          content: "export const answer = 44;\n",
          baseEtag: currentBody.metadata.etag,
          clientRequestId: "req_write_newer",
        }),
      });
      const staleRetry = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstSave),
      });

      expect(first.status).toBe(200);
      expect(sameRetry.status).toBe(200);
      expect(newer.status).toBe(200);
      expect(staleRetry.status).toBe(409);
      expect(await readFile(join(harness.worktreeRoot, "src", "index.ts"), "utf8")).toBe("export const answer = 44;\n");
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("creates a new file only when the client declares no base etag", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/new.ts",
          content: "export {};\n",
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_new",
        }),
      });

      expect(res.status).toBe(201);
      expect(await readFile(join(harness.worktreeRoot, "src", "new.ts"), "utf8")).toBe("export {};\n");
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects traversal, symlink, non-owner, and oversized file writes safely", async () => {
    const ownerHarness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    const otherHarness = await createRouteHarness({
      principal: { userId: "other_user", source: "jwt" },
      ownerIds: [testPrincipal.userId],
    });
    try {
      await writeFile(join(ownerHarness.homePath, "secret.txt"), "secret token");
      await symlink(join(ownerHarness.homePath, "secret.txt"), join(ownerHarness.worktreeRoot, "src", "linked.txt"));

      const traversal = await ownerHarness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "../secret.txt",
          content: "unsafe",
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_traversal",
        }),
      });
      const symlinkWrite = await ownerHarness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/linked.txt",
          content: "unsafe",
          encoding: "utf8",
          baseEtag: "sha256_stale",
          clientRequestId: "req_write_symlink",
        }),
      });
      const nonOwner = await otherHarness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/index.ts",
          content: "unsafe",
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_non_owner",
        }),
      });
      const oversized = await ownerHarness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/large.txt",
          content: "x".repeat(70_000),
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_large",
        }),
      });
      const multibyteOversized = await ownerHarness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/multibyte.txt",
          content: "é".repeat(40_000),
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_multibyte_large",
        }),
      });

      expect(traversal.status).toBe(400);
      expect(symlinkWrite.status).toBe(404);
      expect(nonOwner.status).toBe(404);
      expect(oversized.status).toBe(400);
      expect(multibyteOversized.status).toBe(400);
      for (const response of [traversal, symlinkWrite, nonOwner, oversized, multibyteOversized]) {
        expect(JSON.stringify(await response.json())).not.toMatch(/secret|other_user|\/tmp|linked\.txt/i);
      }
      expect(await readFile(join(ownerHarness.homePath, "secret.txt"), "utf8")).toBe("secret token");
    } finally {
      await rm(ownerHarness.homePath, { recursive: true, force: true });
      await rm(otherHarness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects file write request bodies over the route limit", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/large.txt",
          content: "x".repeat(600_000),
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_body_limit",
        }),
      });

      expect(res.status).toBe(413);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("accepts a contract-valid 64 KiB write even when JSON escaping expands the request body", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      const content = "\"".repeat(64 * 1024);
      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          worktreeId,
          path: "src/quoted.txt",
          content,
          encoding: "utf8",
          baseEtag: null,
          clientRequestId: "req_write_escaped_limit",
        }),
      });

      expect(res.status).toBe(201);
      expect(await readFile(join(harness.worktreeRoot, "src", "quoted.txt"), "utf8")).toBe(content);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("maps malformed file write JSON to a safe validation error", async () => {
    const harness = await createRouteHarness({
      ownerIds: [testPrincipal.userId],
    });
    try {
      const res = await harness.app.request("/api/coding-agents/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: expect.objectContaining({
          code: "validation_failed",
          safeMessage: "Request could not be processed. Check the inputs and try again.",
        }),
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });
});
