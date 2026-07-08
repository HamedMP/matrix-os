import { describe, expect, it, vi } from "vitest";
import { runWorkspaceStartupRecovery } from "../../packages/gateway/src/workspace-startup-recovery.js";

describe("workspace startup recovery", () => {
  it("runs recovery in dependency order and reports sanitized component status", async () => {
    const calls: string[] = [];
    const sessions = [{ id: "sess_abc123", runtime: { status: "running" } }];

    const result = await runWorkspaceStartupRecovery({
      stateOps: {
        recoverOperations: vi.fn(async () => {
          calls.push("state-ops");
          return { cleanedStaging: ["/home/matrixos/home/system/clone-staging/repo"] };
        }),
      },
      projectManager: {
        listManagedProjects: vi.fn(async () => {
          calls.push("projects");
          return { projects: [{ slug: "repo" }], nextCursor: null };
        }),
      },
      worktreeManager: {
        listWorktrees: vi.fn(async () => {
          calls.push("worktree-leases");
          return { ok: true, worktrees: [{ id: "wt_abc123def456" }] };
        }),
      },
      agentSessionManager: {
        reconcileStartup: vi.fn(async () => {
          calls.push("runtime-sessions");
          return { checked: 1, degraded: 0, releasedLeases: 0, stoppedSessions: [] };
        }),
        listSessions: vi.fn(async () => {
          calls.push("session-records");
          return { ok: true, sessions, nextCursor: null };
        }),
      },
      bridgeRecovery: {
        recoverStartup: vi.fn(async () => {
          calls.push("bridges");
          return { checked: 1 };
        }),
      },
      transcriptManager: {
        rehydrate: vi.fn(async () => {
          calls.push("transcripts:rehydrate");
          return { ok: true, entriesLoaded: 2, hotEntries: 2, nextSeq: 2, truncated: false };
        }),
        applyRetention: vi.fn(async () => {
          calls.push("transcripts:retention");
          return { deleted: [], truncated: [], bytesBefore: 32, bytesAfter: 32 };
        }),
      },
      reviewStore: {
        listReviews: vi.fn(async () => {
          calls.push("reviews");
          return { ok: true, reviews: [{ id: "rev_abc123" }], nextCursor: null };
        }),
      },
      agentSandbox: {
        status: vi.fn(async () => {
          calls.push("sandbox");
          return { available: true, enforced: true, requiresAdminOverride: false, reason: "ok" };
        }),
      },
      browserIde: {
        status: vi.fn(async () => {
          calls.push("browser-ide");
          return { enabled: true, configured: true };
        }),
      },
      previewManager: {
        listPreviews: vi.fn(async () => {
          calls.push("previews");
          return { ok: true, previews: [{ id: "prev_abc123" }], nextCursor: null };
        }),
      },
      logger: { warn: vi.fn() },
    });

    expect(calls).toEqual([
      "state-ops",
      "projects",
      "worktree-leases",
      "runtime-sessions",
      "session-records",
      "bridges",
      "transcripts:rehydrate",
      "transcripts:retention",
      "reviews",
      "sandbox",
      "browser-ide",
      "previews",
    ]);
    expect(result.status).toBe("ok");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "stateOps", status: "ok", cleanedStaging: 1 }),
      expect.objectContaining({ name: "projects", status: "ok", projects: 1 }),
      expect.objectContaining({ name: "worktreeLeases", status: "ok", worktrees: 1 }),
      expect.objectContaining({ name: "runtimeSessions", status: "ok", checked: 1 }),
      expect.objectContaining({ name: "bridges", status: "ok", checked: 1 }),
      expect.objectContaining({ name: "transcripts", status: "ok", rehydrated: 1 }),
      expect.objectContaining({ name: "reviews", status: "ok", reviews: 1 }),
      expect.objectContaining({ name: "sandbox", status: "ok" }),
      expect.objectContaining({ name: "browserIde", status: "ok" }),
      expect.objectContaining({ name: "previews", status: "ok", previews: 1 }),
    ]);
    expect(JSON.stringify(result)).not.toContain("/home/matrixos");
  });

  it("routes degraded startup agent sessions through the session stopped publisher", async () => {
    const stoppedSession = {
      id: "sess_abc123",
      ownerId: "owner_user",
      kind: "agent" as const,
      projectSlug: "repo",
      taskId: "task_abc123",
      worktreeId: "wt_abc123def456",
      pr: 42,
      agent: "codex",
      runtime: { type: "zellij" as const, status: "degraded" as const, fallbackReason: "zellij_unavailable" },
      terminalSessionId: "term_sess_abc123",
      transcriptPath: "/home/matrix/home/system/session-output/sess_abc123.jsonl",
      attachedClients: 0,
      writeMode: "closed" as const,
      startedAt: "2026-04-26T00:00:00.000Z",
      lastActivityAt: "2026-04-26T00:00:00.000Z",
    };
    const publishSessionStopped = vi.fn(async () => undefined);

    const result = await runWorkspaceStartupRecovery({
      stateOps: { recoverOperations: vi.fn(async () => ({ cleanedStaging: [] })) },
      projectManager: { listManagedProjects: vi.fn(async () => ({ projects: [{ slug: "repo" }], nextCursor: null })) },
      worktreeManager: { listWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })) },
      agentSessionManager: {
        reconcileStartup: vi.fn(async () => ({
          checked: 1,
          degraded: 1,
          releasedLeases: 1,
          stoppedSessions: [stoppedSession],
        })),
        listSessions: vi.fn(async () => ({ ok: true, sessions: [], nextCursor: null })),
      },
      eventPublisher: { publishSessionStopped },
      transcriptManager: {
        rehydrate: vi.fn(async () => ({ ok: true })),
        applyRetention: vi.fn(async () => ({ deleted: [], truncated: [] })),
      },
      reviewStore: { listReviews: vi.fn(async () => ({ ok: true, reviews: [], nextCursor: null })) },
      agentSandbox: {
        status: vi.fn(async () => ({ available: true, enforced: true, requiresAdminOverride: false, reason: "ok" })),
      },
      browserIde: { status: vi.fn(async () => ({ enabled: true, configured: true })) },
      previewManager: { listPreviews: vi.fn(async () => ({ ok: true, previews: [], nextCursor: null })) },
      logger: { warn: vi.fn() },
    });

    expect(result.steps).toContainEqual(expect.objectContaining({
      name: "runtimeSessions",
      status: "ok",
      checked: 1,
      degraded: 1,
    }));
    expect(publishSessionStopped).toHaveBeenCalledWith(stoppedSession);
  });
});
