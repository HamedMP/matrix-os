import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingAgentSessionStopReconciler } from "../../packages/gateway/src/coding-agents/session-stop-reconciler.js";

const WORKSPACE_ID = "tws_00000000000000000000000000000001";
function ref(index: number) {
  return { workspaceId: WORKSPACE_ID, tabId: `tt_${index.toString(16).padStart(32, "0")}` };
}

function stoppedSession(index: number, runtimeStatus: "exited" | "failed" | "degraded" = "exited") {
  return {
    id: `sess_${index}`,
    kind: "agent",
    ownerId: "owner_user",
    runtime: { status: runtimeStatus },
    terminalRef: ref(index),
  };
}

describe("coding agent session stop reconciler", () => {
  afterEach(() => vi.useRealTimers());

  it("buffers stopped tabs until the thread store is attached", async () => {
    const store = { reconcileTerminalTabStopped: vi.fn(async () => []) };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4 });

    await reconciler.handleSessionStopped(stoppedSession(1, "failed"));
    expect(store.reconcileTerminalTabStopped).not.toHaveBeenCalled();
    await reconciler.attachThreadStore(store);

    expect(store.reconcileTerminalTabStopped).toHaveBeenCalledWith({
      ownerId: "owner_user",
      workspaceSessionId: "sess_1",
      terminalRef: ref(1),
      runtimeStatus: "failed",
    });
  });

  it("caps pending stopped tabs and evicts the oldest", async () => {
    const store = { reconcileTerminalTabStopped: vi.fn(async () => []) };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 2 });
    await reconciler.handleSessionStopped(stoppedSession(1));
    await reconciler.handleSessionStopped(stoppedSession(2));
    await reconciler.handleSessionStopped(stoppedSession(3));
    await reconciler.attachThreadStore(store);

    expect(store.reconcileTerminalTabStopped).toHaveBeenCalledTimes(2);
    expect(store.reconcileTerminalTabStopped).toHaveBeenNthCalledWith(1, expect.objectContaining({ terminalRef: ref(2) }));
    expect(store.reconcileTerminalTabStopped).toHaveBeenNthCalledWith(2, expect.objectContaining({ terminalRef: ref(3) }));
  });

  it("retains failed flushes for bounded retry and cancels retries on dispose", async () => {
    vi.useFakeTimers();
    let fail = true;
    const store = {
      reconcileTerminalTabStopped: vi.fn(async () => {
        if (fail) throw new Error("store unavailable");
        return [];
      }),
    };
    const reconciler = createCodingAgentSessionStopReconciler({ maxPending: 4, retryDelayMs: 100 });
    await reconciler.handleSessionStopped(stoppedSession(1));
    await expect(reconciler.attachThreadStore(store)).rejects.toThrow("store unavailable");
    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(store.reconcileTerminalTabStopped).toHaveBeenCalledTimes(2);

    await reconciler.handleSessionStopped(stoppedSession(2));
    reconciler.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.reconcileTerminalTabStopped).toHaveBeenCalledTimes(3);
  });
});
