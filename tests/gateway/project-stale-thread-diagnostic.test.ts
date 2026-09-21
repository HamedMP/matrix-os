import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createProjectManager } from "../../packages/gateway/src/domains/workspace/project-manager.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/domains/workspace/workspace-routes.js";

// Diagnostic fixture: historical running thread, no surviving execution or active turn.
it("deletes historical running threads without requiring startup recovery", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-stale-thread-diagnostic-"));
  const principal = { userId: "user_diagnostic", source: "jwt" as const };
  try {
    await mkdir(join(homePath, "system", "coding-agents"), { recursive: true });
    await writeFile(join(homePath, "system", "coding-agents", "threads.json"), JSON.stringify({
      version: 1,
      threads: [{
        id: "thread_legacy", ownerId: principal.userId, clientRequestId: "req_legacy",
        providerId: "codex", projectId: "chess", title: "Coding agent run",
        status: "running", attention: "none", terminalSessionId: "matrix-rt_legacy",
        createdAt: "2026-08-18T12:53:58.304Z", updatedAt: "2026-08-18T12:54:39.229Z",
      }], events: [], turns: [], pendingTerminalStops: [],
    }));
    const threads = createCodingAgentThreadStore({ homePath, providers: [], restoreProviderThread: async () => false });
    const manager = createProjectManager({ homePath });
    const created = await manager.createProject({ mode: "scratch", name: "chess", slug: "chess", ownerScope: { type: "user", id: principal.userId } });
    expect(created.ok).toBe(true);
    await mkdir(join(homePath, "system", "sessions"), { recursive: true });
    await writeFile(join(homePath, "system", "sessions", "sess_child.json"), JSON.stringify({
      id: "sess_child", kind: "agent", projectSlug: "chess", ownerId: principal.userId,
      runtime: { type: "zellij", status: "running" },
      terminalRef: { workspaceId: "tws_00000000000000000000000000000001", tabId: "tt_00000000000000000000000000000001" },
      transcriptPath: join(homePath, "system", "session-output", "sess_child.jsonl"),
      attachedClients: 0, writeMode: "owner", startedAt: "2026-08-18T00:00:00Z", lastActivityAt: "2026-08-18T00:00:00Z",
    }));
    const terminateTab = vi.fn(async () => undefined);
    const app = createWorkspaceRoutes({
      homePath, projectManager: manager, codingAgentThreadStore: threads,
      getOwnerScope: () => ({ type: "user", id: principal.userId }),
      terminalRuntime: { listWorkspaces: vi.fn(async () => []), terminateTab } as never,
    });
    const response = await app.request("/api/projects/chess/actions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "delete", confirmation: "chess", confirmTerminate: true }),
    });
    expect(await response.json()).toMatchObject({ ok: true, action: "delete" });
    expect(response.status).toBe(200);
    expect(terminateTab).toHaveBeenCalledOnce();
    await expect(stat(join(homePath, "system", "sessions", "sess_child.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await threads.getProjectLifecycleState(principal, "chess")).toEqual({ activeThreadCount: 0, threadCount: 0 });
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});
