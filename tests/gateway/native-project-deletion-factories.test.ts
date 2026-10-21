import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { createWorkspaceStartupRecovery } from "../../packages/gateway/src/workspace-startup-recovery.js";
import { createCodexExecutionSessions } from "../../packages/gateway/src/coding-agents/codex-execution-sessions.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";

it.each(["route", "recovery"] as const)("%s factory releases the native registration before removing project sessions", async (factory) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-native-delete-factory-"));
  const terminalList = vi.spyOn(TerminalRuntimeSocketClient.prototype, "listWorkspaces").mockResolvedValue([]);
  const ownerScope = { type: "user" as const, id: "owner_a" };
  const sessionId = "sess_child";
  const sessionPath = join(homePath, "system/sessions", `${sessionId}.json`);
  const stopSession = vi.fn(async () => { throw new Error("deleted session must not be stopped again"); });
  const admission = createCodexExecutionAdmission({ homePath, isOwner: id => id === ownerScope.id,
    stopSession, getSnapshot: vi.fn(), readNativeAccount: vi.fn(),
  });
  const beforeProjectSessionRemove = vi.fn(async ({ ownerId, sessionId: id, proof }: Parameters<NonNullable<Parameters<typeof createWorkspaceRoutes>[0]["beforeProjectSessionRemove"]>>[0]) => {
    await expect(stat(sessionPath)).resolves.toBeDefined();
    await admission.releaseStoppedSession(ownerId, id, proof);
  });
  let close: (() => void) | undefined;
  try {
    const projects = createProjectManager({ homePath });
    expect((await projects.createProject({ mode: "scratch", slug: "repo", name: "Repo", ownerScope })).ok).toBe(true);
    await mkdir(join(homePath, "system/sessions"), { recursive: true });
    await writeFile(sessionPath, JSON.stringify({ id: sessionId, kind: "agent", projectSlug: "repo", ownerId: ownerScope.id,
      runtime: { type: "zellij", status: "exited" }, transcriptPath: "unused", attachedClients: 0, writeMode: "closed",
      startedAt: "2026-08-18T00:00:00Z", lastActivityAt: "2026-08-18T00:00:00Z" }));
    await createCodexExecutionSessions(homePath).register(ownerScope.id, sessionId, "a".repeat(64));
    if (factory === "route") {
      const app = createWorkspaceRoutes({ homePath, beforeProjectSessionRemove, getOwnerScope: () => ownerScope });
      const response = await app.request("/api/projects/repo/actions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "delete", confirmation: "Repo", confirmTerminate: true }),
      });
      expect(response.status).toBe(200);
    } else {
      expect((await projects.setProjectLifecycleState({ slug: "repo", ownerScope, deletingAt: "2026-08-18T00:00:00Z" })).ok).toBe(true);
      const recovery = createWorkspaceStartupRecovery({ homePath, beforeProjectSessionRemove });
      close = recovery.close;
      expect((await recovery.run()).steps).toContainEqual(expect.objectContaining({ name: "projectDeletions", recovered: 1, failed: 0 }));
    }
    expect(beforeProjectSessionRemove).toHaveBeenCalledOnce();
    expect(beforeProjectSessionRemove).toHaveBeenCalledWith(expect.objectContaining({ ownerId: ownerScope.id, sessionId }));
    await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
    const release = await admission.prepareRevocation();
    expect(stopSession).not.toHaveBeenCalled();
    await release();
  } finally {
    close?.();
    terminalList.mockRestore();
    await rm(homePath, { recursive: true, force: true });
  }
});
