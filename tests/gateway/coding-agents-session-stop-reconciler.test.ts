import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingAgentSessionStopReconciler } from "../../packages/gateway/src/coding-agents/session-stop-reconciler.js";

function stoppedSession(terminalSessionId: string, runtimeStatus: "exited" | "failed" | "degraded" = "exited") {
  return {
    id: `sess_${terminalSessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    kind: "agent",
    ownerId: "owner_user",
    runtime: { status: runtimeStatus },
    terminalSessionId,
  };
}

describe("coding agent session stop reconciler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers stopped sessions until the thread store is attached", async () => {
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async () => []),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4 });

    await reconciler.handleSessionStopped(stoppedSession("term_sess_early", "failed"));
    expect(store.reconcileTerminalSessionStopped).not.toHaveBeenCalled();

    await reconciler.attachThreadStore(store);

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledWith({
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_early",
      terminalSessionId: "term_sess_early",
      runtimeStatus: "failed",
    });
  });

  it("caps pending stopped sessions and evicts the oldest before attach", async () => {
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async () => []),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 2 });

    await reconciler.handleSessionStopped(stoppedSession("term_sess_one"));
    await reconciler.handleSessionStopped(stoppedSession("term_sess_two"));
    await reconciler.handleSessionStopped(stoppedSession("term_sess_three"));
    await reconciler.attachThreadStore(store);

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledTimes(2);
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(1, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_two",
      terminalSessionId: "term_sess_two",
      runtimeStatus: "exited",
    });
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(2, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_three",
      terminalSessionId: "term_sess_three",
      runtimeStatus: "exited",
    });
  });

  it("retains only failed buffered stops when startup flush partially fails", async () => {
    let failFirstStop = true;
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async (input: { terminalSessionId: string }) => {
        if (input.terminalSessionId === "term_sess_one" && failFirstStop) {
          throw new Error("store unavailable");
        }
        return [];
      }),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4 });
    await reconciler.handleSessionStopped(stoppedSession("term_sess_one"));
    await reconciler.handleSessionStopped(stoppedSession("term_sess_two"));

    await expect(reconciler.attachThreadStore(store)).rejects.toThrow("store unavailable");
    failFirstStop = false;
    await reconciler.attachThreadStore(store);

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledTimes(3);
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(1, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_one",
      terminalSessionId: "term_sess_one",
      runtimeStatus: "exited",
    });
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(2, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_two",
      terminalSessionId: "term_sess_two",
      runtimeStatus: "exited",
    });
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(3, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_one",
      terminalSessionId: "term_sess_one",
      runtimeStatus: "exited",
    });
  });

  it("drains retained startup failures before handling later stop events", async () => {
    let failFirstStop = true;
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async (input: { terminalSessionId: string }) => {
        if (input.terminalSessionId === "term_sess_one" && failFirstStop) {
          throw new Error("store unavailable");
        }
        return [];
      }),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4 });
    await reconciler.handleSessionStopped(stoppedSession("term_sess_one"));
    await expect(reconciler.attachThreadStore(store)).rejects.toThrow("store unavailable");

    failFirstStop = false;
    await reconciler.handleSessionStopped(stoppedSession("term_sess_two"));

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledTimes(3);
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(1, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_one",
      terminalSessionId: "term_sess_one",
      runtimeStatus: "exited",
    });
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(2, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_one",
      terminalSessionId: "term_sess_one",
      runtimeStatus: "exited",
    });
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(3, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_two",
      terminalSessionId: "term_sess_two",
      runtimeStatus: "exited",
    });
  });

  it("retries retained startup failures without requiring a later stop event", async () => {
    vi.useFakeTimers();
    let failFirstStop = true;
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async (input: { terminalSessionId: string }) => {
        if (input.terminalSessionId === "term_sess_one" && failFirstStop) {
          throw new Error("store unavailable");
        }
        return [];
      }),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4, retryDelayMs: 25 });
    await reconciler.handleSessionStopped(stoppedSession("term_sess_one"));
    await expect(reconciler.attachThreadStore(store)).rejects.toThrow("store unavailable");

    failFirstStop = false;
    await vi.advanceTimersByTimeAsync(25);

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledTimes(2);
    expect(store.reconcileTerminalSessionStopped).toHaveBeenNthCalledWith(2, {
      ownerId: "owner_user",
      workspaceSessionId: "sess_term_sess_one",
      terminalSessionId: "term_sess_one",
      runtimeStatus: "exited",
    });

    reconciler.dispose();
  });

  it("cancels retained-stop retries on dispose", async () => {
    vi.useFakeTimers();
    const store = {
      reconcileTerminalSessionStopped: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4, retryDelayMs: 25 });
    await reconciler.handleSessionStopped(stoppedSession("term_sess_one"));
    await expect(reconciler.attachThreadStore(store)).rejects.toThrow("store unavailable");

    reconciler.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(store.reconcileTerminalSessionStopped).toHaveBeenCalledTimes(1);
  });
});
