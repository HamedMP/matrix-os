import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

it.each([false, true])("deletes a legacy provider session through the HTTP route (stop fails: %s)", async (stopFails) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-legacy-cascade-"));
  const principal = { userId: "user_diagnostic", source: "jwt" as const };
  const terminal = { listWorkspaces: vi.fn(async () => []), terminateTab: vi.fn() };
  const deleteSession = vi.fn(async () => { if (stopFails) throw new Error("Runtime unavailable"); });
  const sessions = createAgentSessionManager({ homePath, terminalRuntime: terminal as never,
    agentLauncher: { buildLaunch: vi.fn() },
    worktreeManager: { listWorktrees: vi.fn(), acquireLease: vi.fn(), releaseLease: vi.fn() },
    legacyZellij: { deleteSession },
  });
  try {
    await mkdir(join(homePath, "system/coding-agents"), { recursive: true });
    await mkdir(join(homePath, "system/sessions"), { recursive: true });
    await writeFile(join(homePath, "system/coding-agents/threads.json"), JSON.stringify({
      version: 1, threads: [{ id: "thread_legacy", ownerId: principal.userId, clientRequestId: "req_legacy",
        providerId: "codex", projectId: "old-project", title: "Legacy run", status: "running", attention: "none",
        terminalSessionId: "matrix-rt_old", createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z" }],
      events: [], turns: [], pendingTerminalStops: [],
    }));
    const sessionPath = join(homePath, "system/sessions/sess_legacy.json");
    await writeFile(sessionPath, JSON.stringify({ id: "sess_legacy", kind: "agent", projectSlug: "old-project",
      ownerId: principal.userId, runtime: { type: "zellij", status: "degraded", zellijSession: "matrix-rt_old", fallbackReason: "runtime_not_running" },
      transcriptPath: "unused", attachedClients: 0, writeMode: "closed", startedAt: "2026-08-18T00:00:00Z", lastActivityAt: "2026-08-18T00:00:00Z" }));
    const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex",
      runtime: { startSession: vi.fn(), stopSession: (id) => sessions.killSession(id) },
    });
    const threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
    const projects = createProjectManager({ homePath });
    expect((await projects.createProject({ mode: "scratch", name: "Old project", slug: "old-project", ownerScope: { type: "user", id: principal.userId } })).ok).toBe(true);
    const app = createWorkspaceRoutes({ homePath, projectManager: projects, codingAgentThreadStore: threads,
      agentSessionManager: sessions, terminalRuntime: terminal as never,
      getOwnerScope: () => ({ type: "user", id: principal.userId }),
    });
    const response = await app.request("/api/projects/old-project/actions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "delete", confirmation: "Old project", confirmTerminate: true }),
    });
    expect(deleteSession).toHaveBeenCalledWith("matrix-rt_old", { force: true });
    expect(terminal.terminateTab).not.toHaveBeenCalled();
    expect(response.status).toBe(stopFails ? 500 : 200);
    expect((await threads.getProjectLifecycleState(principal, "old-project")).threadCount).toBe(stopFails ? 1 : 0);
    if (stopFails) await expect(stat(sessionPath)).resolves.toBeDefined();
    else await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { sessions.shutdown(); await rm(homePath, { recursive: true, force: true }); }
});
