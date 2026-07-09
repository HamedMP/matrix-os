jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

import {
  AGENT_WORKSPACE_STATE_STORAGE_KEY,
  loadAgentWorkspaceState,
  parseAgentWorkspaceState,
  reconcileAgentWorkspaceState,
  saveAgentWorkspaceState,
} from "../lib/agent-workspace-state";

const summary = {
  activeThreads: {
    items: [{ id: "thread_keep" }],
  },
  attentionThreads: {
    items: [{ id: "thread_attention" }],
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

  it("keeps selected attention thread references from the runtime summary", () => {
    const state = parseAgentWorkspaceState({
      selectedThreadId: "thread_attention",
      selectedTerminalSessionId: "matrix-abc1234",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });

    expect(reconcileAgentWorkspaceState(state, summary)).toEqual({
      selectedThreadId: "thread_attention",
      selectedTerminalSessionId: "matrix-abc1234",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
  });

  it("loads and saves only sanitized safe references", async () => {
    const storage = {
      getItem: jest.fn().mockResolvedValue(JSON.stringify({
        selectedThreadId: "thread_keep",
        selectedTerminalSessionId: "matrix-abc1234",
        updatedAt: "2026-07-06T00:00:00.000Z",
        transcript: "do not store me",
        fileContents: "/home/matrix/private",
      })),
      setItem: jest.fn().mockResolvedValue(undefined),
    };

    await expect(loadAgentWorkspaceState(storage)).resolves.toEqual({
      selectedThreadId: "thread_keep",
      selectedTerminalSessionId: "matrix-abc1234",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });

    await saveAgentWorkspaceState({
      selectedThreadId: "thread_keep",
      selectedTerminalSessionId: "../bad",
      updatedAt: "2026-07-06T00:00:00.000Z",
    }, storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      AGENT_WORKSPACE_STATE_STORAGE_KEY,
      JSON.stringify({
        selectedThreadId: "thread_keep",
        selectedTerminalSessionId: null,
        updatedAt: "2026-07-06T00:00:00.000Z",
      }),
    );
  });
});
