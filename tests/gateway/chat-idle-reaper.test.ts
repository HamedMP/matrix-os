import { describe, expect, it, vi } from "vitest";
import {
  createChatIdleReaper,
  isWorkspaceSessionRuntimeAlive,
} from "../../packages/gateway/src/coding-agents/chat-idle-reaper.js";

function session(id: string, attachedClients = 0) {
  return {
    id,
    ownerId: "owner",
    kind: "agent",
    agent: "codex",
    attachedClients,
    lastActivityAt: "2026-09-08T00:00:00Z",
    runtime: { status: "running" },
    terminalRef: { workspaceId: "tw_project", tabId: `tt_${id.slice(5)}` },
  };
}

describe("Chat idle reaper", () => {
  it("reports liveness for the exact persisted tab rather than a sibling tab", async () => {
    const sessions = {
      getSession: vi.fn(async () => ({
        ok: true,
        session: session("sess_target"),
      })),
    };
    const terminalRuntime = {
      listWorkspaces: vi.fn(async () => [{
        id: "tw_project",
        tabs: [
          { id: "tt_target", status: "exited" },
          { id: "tt_sibling", status: "running" },
        ],
      }]),
    };

    await expect(isWorkspaceSessionRuntimeAlive(
      "sess_target",
      sessions as never,
      terminalRuntime as never,
    )).resolves.toBe(false);
  });

  it("reclaims bounded proven-idle tabs without stopping their shared project workspace", async () => {
    const sessions = [session("sess_old"), session("sess_busy"), session("sess_unknown")];
    const statuses = new Map(sessions.map((item) => [item.terminalRef.tabId, "running"]));
    const hibernate = vi.fn(async () => {});
    const terminateTab = vi.fn(async (ref: { tabId: string }) => {
      statuses.set(ref.tabId, "exited");
    });
    const deleteWorkspace = vi.fn();
    const threads = {
      withIdleWorkspace: async (
        id: string,
        _cutoff: number,
        action: (identity: unknown) => Promise<boolean>,
      ) => {
        if (["sess_busy", "sess_unknown"].includes(id)) return false;
        return action({
          ownerId: "owner",
          sessionId: id,
          threadId: `thread_${id.slice(5)}`,
          providerThreadId: "native_saved",
        });
      },
    };
    const runtime = {
      listWorkspaces: async () => [{
        id: "tw_project",
        tabs: sessions.map((item) => ({
          id: item.terminalRef.tabId,
          status: statuses.get(item.terminalRef.tabId),
        })),
      }],
      terminateTab,
      deleteWorkspace,
    };
    const reaper = createChatIdleReaper({
      threads,
      control: { hibernate },
      sessions: {
        listSessions: async () => ({ ok: true, sessions, nextCursor: null }),
        getSession: async (id: string) => ({ ok: true, session: sessions.find((item) => item.id === id)! }),
      },
      terminalRuntime: runtime,
      admitCanonical: async (_identity: unknown, action: () => Promise<boolean>) => action(),
      unwatch: vi.fn(),
      underPressure: async () => true,
      now: () => Date.parse("2026-09-08T01:00:00Z"),
    } as never);
    try {
      expect((await reaper.sweep()).reclaimed).toBe(1);
      expect(hibernate).toHaveBeenCalledTimes(1);
      expect(terminateTab).toHaveBeenCalledWith(sessions[0]!.terminalRef);
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(statuses.get(sessions[1]!.terminalRef.tabId)).toBe("running");
      expect(statuses.get(sessions[2]!.terminalRef.tabId)).toBe("running");
      expect((await reaper.sweep()).reclaimed).toBe(0);
    } finally {
      await reaper.close();
    }
  });

  it("never force-stops an unsupported runner or an attached owner terminal", async () => {
    const sessions = [session("sess_old"), session("sess_attached", 1)];
    const terminateTab = vi.fn();
    const control = vi.fn(async () => {
      throw new Error("old runner does not support idle admission");
    });
    const reaper = createChatIdleReaper({
      threads: {
        withIdleWorkspace: async (
          id: string,
          _cutoff: number,
          action: (identity: unknown) => Promise<boolean>,
        ) => action({ ownerId: "owner", sessionId: id, providerThreadId: "native_saved" }),
      },
      sessions: {
        listSessions: async () => ({ ok: true, sessions, nextCursor: null }),
        getSession: async (id: string) => ({ ok: true, session: sessions.find((item) => item.id === id)! }),
      },
      terminalRuntime: {
        listWorkspaces: async () => [{
          id: "tw_project",
          tabs: sessions.map((item) => ({ id: item.terminalRef.tabId, status: "running" })),
        }],
        terminateTab,
      },
      control: { hibernate: control },
      admitCanonical: async (_identity: unknown, action: () => Promise<boolean>) => action(),
      unwatch: vi.fn(),
      underPressure: async () => false,
      now: () => Date.parse("2026-09-08T01:00:00Z"),
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await reaper.sweep();
      expect(terminateTab).not.toHaveBeenCalled();
      expect(control).toHaveBeenCalledTimes(1);
    } finally {
      await reaper.close();
      warn.mockRestore();
    }
  });
});
