import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/domains/sessions/agent-session-manager.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createProjectManager } from "../../packages/gateway/src/domains/workspace/project-manager.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/domains/workspace/workspace-routes.js";

const sessionId = "sess_11111111-2222-4333-8444-555555555555";
const legacyNames = ["matrix-rt_old", `matrix-${sessionId}`, sessionId, undefined];
it.each(legacyNames.flatMap((name) => ["running", "completed"].flatMap((status) =>
  [false, true].map((stopFails) => ({ name, status, stopFails })),
)))(
  "deletes a $status legacy provider session through HTTP ($name, stop fails: $stopFails)", async ({ name, status, stopFails }) => {
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
      version: 1, threads: [{ id: "thread_11111111-2222-4333-8444-555555555555", ownerId: principal.userId, clientRequestId: "req_legacy",
        providerId: "codex", projectId: "old-project", title: "Legacy run", status, attention: "none",
        terminalSessionId: name, createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z" }],
      events: [], turns: [], pendingTerminalStops: [],
    }));
    const sessionPath = join(homePath, `system/sessions/${sessionId}.json`);
    await writeFile(sessionPath, JSON.stringify({ id: sessionId, kind: "agent", projectSlug: "old-project",
      ownerId: principal.userId, runtime: { type: "zellij", status: name === undefined ? "exited" : "degraded", zellijSession: name, fallbackReason: "runtime_not_running" },
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
    if (name === undefined) expect(deleteSession).not.toHaveBeenCalled();
    else expect(deleteSession).toHaveBeenCalledWith(name, { force: true });
    const failed = stopFails && name !== undefined;
    expect(terminal.terminateTab).not.toHaveBeenCalled();
    expect(response.status).toBe(failed ? 500 : 200);
    expect((await threads.getProjectLifecycleState(principal, "old-project")).threadCount).toBe(failed ? 1 : 0);
    if (failed) await expect(stat(sessionPath)).resolves.toBeDefined();
    else await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { sessions.shutdown(); await rm(homePath, { recursive: true, force: true }); }
});
