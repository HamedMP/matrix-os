import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

const SHA = "a".repeat(40);

const COMMIT = {
  sha: SHA,
  parents: [],
  author: "Alice",
  timestamp: "2026-07-19T10:00:00+00:00",
  subject: "Initial commit",
  refs: ["main"],
  tags: [],
  head: true,
};

const DIFF_FILE = {
  path: "src/a.ts",
  oldPath: null,
  status: "M",
  additions: 2,
  deletions: 1,
  binary: false,
  patch: "@@ -1 +1 @@\n-old\n+new",
  truncated: false,
};

function makeGitLog(overrides: Record<string, unknown> = {}) {
  return {
    listCommits: vi.fn(async () => ({ ok: true as const, commits: [COMMIT], nextCursor: null, refreshedAt: "2026-07-19T12:00:00.000Z" })),
    getCommitDiff: vi.fn(async () => ({ ok: true as const, files: [DIFF_FILE], truncated: false, refreshedAt: "2026-07-19T12:00:00.000Z" })),
    ...overrides,
  };
}

describe("git log routes", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-git-routes-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("GET /api/projects/:slug/commits", () => {
    it("returns commits with defaults for limit and cursor", async () => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request("/api/projects/repo/commits");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        commits: [COMMIT],
        nextCursor: null,
        refreshedAt: "2026-07-19T12:00:00.000Z",
      });
      expect(gitLog.listCommits).toHaveBeenCalledWith("repo", { limit: 200, offset: 0 });
    });

    it("passes bounded limit and cursor through to the service", async () => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request("/api/projects/repo/commits?limit=50&cursor=120");

      expect(res.status).toBe(200);
      expect(gitLog.listCommits).toHaveBeenCalledWith("repo", { limit: 50, offset: 120 });
    });

    it.each([
      "/api/projects/repo/commits?limit=0",
      "/api/projects/repo/commits?limit=501",
      "/api/projects/repo/commits?limit=abc",
      "/api/projects/repo/commits?cursor=abc",
      "/api/projects/repo/commits?cursor=-5",
    ])("rejects invalid query parameters: %s", async (path) => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request(path);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).not.toMatch(/limit|cursor|Expected/i);
      expect(gitLog.listCommits).not.toHaveBeenCalled();
    });

    it("maps service failures to status and generic error body", async () => {
      const gitLog = makeGitLog({
        listCommits: vi.fn(async () => ({
          ok: false as const,
          status: 404,
          error: { code: "not_found", message: "Project was not found" },
        })),
      });
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request("/api/projects/missing/commits");

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: { code: "not_found", message: "Project was not found" } });
    });
  });

  describe("GET /api/projects/:slug/commits/:sha/diff", () => {
    it("returns parsed diff files", async () => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request(`/api/projects/repo/commits/${SHA}/diff`);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        files: [DIFF_FILE],
        truncated: false,
        refreshedAt: "2026-07-19T12:00:00.000Z",
      });
      expect(gitLog.getCommitDiff).toHaveBeenCalledWith("repo", SHA, { maxFiles: 200, maxLines: 400 });
    });

    it("accepts bounded maxFiles and maxLines overrides", async () => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request(`/api/projects/repo/commits/${SHA}/diff?maxFiles=50&maxLines=100`);

      expect(res.status).toBe(200);
      expect(gitLog.getCommitDiff).toHaveBeenCalledWith("repo", SHA, { maxFiles: 50, maxLines: 100 });
    });

    it.each([
      "/api/projects/repo/commits/not-a-sha/diff",
      `/api/projects/repo/commits/${SHA}/diff?maxFiles=0`,
      `/api/projects/repo/commits/${SHA}/diff?maxFiles=501`,
      `/api/projects/repo/commits/${SHA}/diff?maxLines=10`,
      `/api/projects/repo/commits/${SHA}/diff?maxLines=2001`,
    ])("rejects invalid parameters: %s", async (path) => {
      const gitLog = makeGitLog();
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request(path);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(gitLog.getCommitDiff).not.toHaveBeenCalled();
    });

    it("maps an unknown commit to 404", async () => {
      const gitLog = makeGitLog({
        getCommitDiff: vi.fn(async () => ({
          ok: false as const,
          status: 404,
          error: { code: "not_found", message: "Commit was not found" },
        })),
      });
      const app = createWorkspaceRoutes({ homePath, gitLog });

      const res = await app.request(`/api/projects/repo/commits/${SHA}/diff`);

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: { code: "not_found", message: "Commit was not found" } });
    });
  });
});
