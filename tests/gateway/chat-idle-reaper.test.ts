import { describe, expect, it, vi } from "vitest";
import { createChatIdleReaper } from "../../packages/gateway/src/coding-agents/chat-idle-reaper.js";
import { workspaceRuntimeId } from "../../packages/gateway/src/user-systemd-zellij-runtime.js";

describe("Chat idle reaper", () => {
  it("reclaims bounded proven idle runtimes, preserves unrelated sessions, and recovers a recorded stop intent", async () => {
    const runtimes = ["sess_old", "sess_busy", "sess_unknown", "sess_stopping"].map((displayName) => ({
      runtimeId: workspaceRuntimeId(displayName), displayName, scope: "workspace", createdAt: "2026-09-08T00:00:00Z",
      layoutPath: "/owned/runtime.kdl", ...(displayName === "sess_stopping" ? { hibernatedAt: "2026-09-08T00:01:00Z" } : {}),
    }));
    const alive = new Set(runtimes.map((runtime) => runtime.runtimeId));
    const hibernate = vi.fn(async () => {});
    const controller = { list: async () => runtimes, isRunning: async (id: string) => alive.has(id),
      hibernateWorkspace: vi.fn(async (id: string) => { alive.delete(id); return { ok: true }; }) };
    const threads = { withIdleWorkspace: async (id: string, _cutoff: number, action: (identity: unknown) => Promise<boolean>) => {
      if (["sess_busy", "sess_unknown"].includes(id)) return false;
      return action({ ownerId: "owner", sessionId: id, threadId: `thread_${id.slice(5)}`, providerThreadId: "native_saved" });
    } };
    const reaper = createChatIdleReaper({ controller, threads, control: { hibernate },
      sessions: { getSession: async (id: string) => ({ ok: true, session: { id, ownerId: "owner", kind: "agent", agent: "codex", attachedClients: 0, lastActivityAt: "2026-09-08T00:00:00Z" } }) },
      admitCanonical: async (_identity: unknown, action: () => Promise<boolean>) => action(),
      unwatch: vi.fn(), underPressure: async () => true, now: () => Date.parse("2026-09-08T01:00:00Z"),
    } as never);
    try {
      expect((await reaper.sweep()).reclaimed).toBe(2);
      expect(hibernate).toHaveBeenCalledTimes(1);
      expect(alive.has(workspaceRuntimeId("sess_busy"))).toBe(true);
      expect(alive.has(workspaceRuntimeId("sess_unknown"))).toBe(true);
      expect((await reaper.sweep()).reclaimed).toBe(0);
    } finally { await reaper.close(); }
  });

  it("never force-stops an unsupported runner or an attached owner terminal", async () => {
    const stop = vi.fn();
    const control = vi.fn(async () => { throw new Error("old runner does not support idle admission"); });
    const reaper = createChatIdleReaper({
      controller: { list: async () => ["sess_old", "sess_attached"].map((displayName) => ({ runtimeId: workspaceRuntimeId(displayName), displayName,
        scope: "workspace", createdAt: "2026-09-08T00:00:00Z", layoutPath: "/owned/runtime.kdl" })), isRunning: async () => true, hibernateWorkspace: stop },
      threads: { withIdleWorkspace: async (id: string, _cutoff: number, action: (identity: unknown) => Promise<boolean>) => action({ ownerId: "owner", sessionId: id, providerThreadId: "native_saved" }) },
      sessions: { getSession: async (id: string) => ({ ok: true, session: { id, ownerId: "owner", kind: "agent", agent: "codex", attachedClients: id === "sess_attached" ? 1 : 0, lastActivityAt: "2026-09-08T00:00:00Z" } }) },
      control: { hibernate: control }, admitCanonical: async (_identity: unknown, action: () => Promise<boolean>) => action(),
      unwatch: vi.fn(), underPressure: async () => false, now: () => Date.parse("2026-09-08T01:00:00Z"),
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await reaper.sweep(); expect(stop).not.toHaveBeenCalled(); expect(control).toHaveBeenCalledTimes(1); }
    finally { await reaper.close(); warn.mockRestore(); }
  });
});
