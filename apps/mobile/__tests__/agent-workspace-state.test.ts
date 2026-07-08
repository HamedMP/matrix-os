import {
  parseAgentWorkspaceState,
  reconcileAgentWorkspaceState,
} from "../lib/agent-workspace-state";

const summary = {
  activeThreads: {
    items: [{ id: "thread_keep" }],
  },
  terminalSessions: {
    items: [{ id: "matrix-abc1234" }],
  },
};

describe("agent workspace state", () => {
  it("stores only bounded safe references", () => {
    expect(parseAgentWorkspaceState({
      selectedThreadId: "thread_keep",
      selectedTerminalSessionId: "matrix-abc1234",
      updatedAt: "2026-07-06T00:00:00.000Z",
      transcript: "private",
      rawPayload: { path: "/home/matrix/private" },
    })).toEqual({
      selectedThreadId: "thread_keep",
      selectedTerminalSessionId: "matrix-abc1234",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });

    expect(parseAgentWorkspaceState({
      selectedThreadId: "../bad",
      selectedTerminalSessionId: "/tmp/secret",
      updatedAt: "not a date",
    })).toEqual({
      selectedThreadId: null,
      selectedTerminalSessionId: null,
      updatedAt: null,
    });
  });

  it("drops stale references that are absent from the runtime summary", () => {
    const state = parseAgentWorkspaceState({
      selectedThreadId: "thread_missing",
      selectedTerminalSessionId: "matrix-missing",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });

    expect(reconcileAgentWorkspaceState(state, summary)).toEqual({
      selectedThreadId: null,
      selectedTerminalSessionId: null,
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
  });
});
