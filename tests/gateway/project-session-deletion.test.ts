import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TerminalRuntimeError } from "@matrix-os/terminal-runtime";
import { createAgentSessionManager } from "../../packages/gateway/src/domains/sessions/agent-session-manager.js";

it.each(["missing", "unavailable", "running"])("cascades a %s child session without dropping state on failure", async (runtimeState) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-cascade-session-"));
  const terminateTab = vi.fn(async () => {
    if (runtimeState === "missing") throw new TerminalRuntimeError("not_found");
    if (runtimeState === "unavailable") throw new TerminalRuntimeError("unavailable");
  });
  const manager = createAgentSessionManager({
    homePath,
    terminalRuntime: { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab, writeInput: vi.fn(), listWorkspaces: vi.fn() },
    agentLauncher: { buildLaunch: vi.fn() },
    worktreeManager: { listWorktrees: vi.fn(), acquireLease: vi.fn(), releaseLease: vi.fn() },
  });
  try {
    for (const dir of ["sessions", "session-output", "coding-agents/provider-events"]) await mkdir(join(homePath, "system", dir), { recursive: true });
    const session = {
      id: "sess_child", kind: "agent", projectSlug: "repo", ownerId: "owner_a",
      runtime: { type: "zellij", status: "running" },
      terminalRef: { workspaceId: "tws_00000000000000000000000000000001", tabId: "tt_00000000000000000000000000000001" },
      transcriptPath: join(homePath, "original-file.txt"), attachedClients: 0, writeMode: "owner",
      startedAt: "2026-08-18T00:00:00Z", lastActivityAt: "2026-08-18T00:00:00Z",
    };
    await writeFile(session.transcriptPath, "preserve original files");
    await writeFile(join(homePath, "system/sessions/sess_child.json"), JSON.stringify(session));
    await writeFile(join(homePath, "system/session-output/sess_child.jsonl"), "session transcript");
    await writeFile(join(homePath, "system/coding-agents/provider-events/sess_child.jsonl"), "provider transcript");
    const result = await manager.deleteProjectSessions({ projectSlug: "repo", ownerId: "owner_a" });
    expect(terminateTab).toHaveBeenCalledOnce();
    if (runtimeState === "unavailable") {
      expect(result).toMatchObject({ ok: false });
      await expect(stat(join(homePath, "system/sessions/sess_child.json"))).resolves.toBeDefined();
      await expect(stat(join(homePath, "system/session-output/sess_child.jsonl"))).resolves.toBeDefined();
    } else {
      expect(result).toEqual({ ok: true, deleted: 1 });
      for (const path of ["sessions/sess_child.json", "session-output/sess_child.jsonl", "coding-agents/provider-events/sess_child.jsonl"]) {
        await expect(stat(join(homePath, "system", path))).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    expect(await readFile(session.transcriptPath, "utf8")).toBe("preserve original files");
  } finally {
    manager.shutdown();
    await rm(homePath, { recursive: true, force: true });
  }
});

it.each(["missing", "running", "unavailable"])("cleans a legacy Zellij session with no terminalRef (%s)", async (state) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-legacy-delete-"));
  const deleteSession = vi.fn(async () => {
    if (state === "unavailable") throw new Error("Runtime unavailable");
  });
  const manager = createAgentSessionManager({
    homePath,
    terminalRuntime: { terminateTab: vi.fn(), listWorkspaces: vi.fn() } as never,
    agentLauncher: { buildLaunch: vi.fn() },
    worktreeManager: { listWorktrees: vi.fn(), acquireLease: vi.fn(), releaseLease: vi.fn() },
    legacyZellij: { deleteSession },
  });
  try {
    await mkdir(join(homePath, "system/sessions"), { recursive: true });
    const path = join(homePath, "system/sessions/sess_legacy.json");
    await writeFile(path, JSON.stringify({
      id: "sess_legacy", kind: "agent", projectSlug: "chess", ownerId: "owner_a",
      runtime: { type: "zellij", status: "degraded", zellijSession: "matrix-rt_legacy", fallbackReason: "runtime_not_running" },
      transcriptPath: "unused", attachedClients: 0, writeMode: "closed",
      startedAt: "2026-08-18T00:00:00Z", lastActivityAt: "2026-08-18T00:00:00Z",
    }));
    const result = await manager.deleteProjectSessions({ projectSlug: "chess", ownerId: "owner_a" });
    expect(deleteSession).toHaveBeenCalledWith("matrix-rt_legacy", { force: true });
    if (state === "unavailable") {
      expect(result.ok).toBe(false);
      await expect(stat(path)).resolves.toBeDefined();
    } else {
      expect(result).toEqual({ ok: true, deleted: 1 });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    manager.shutdown();
    await rm(homePath, { recursive: true, force: true });
  }
});
