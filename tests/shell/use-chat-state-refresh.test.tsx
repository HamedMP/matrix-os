// @vitest-environment jsdom

import React, { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const subscribeMock = vi.fn(() => () => {});
const loadMock = vi.fn();
let mockConnectionEpoch = 0;
let mockConversations: Array<{
  id: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}> = [];

vi.mock("../../shell/src/hooks/useSocket.js", () => ({
  useSocket: () => ({
    connected: true,
    connectionEpoch: mockConnectionEpoch,
    subscribe: subscribeMock,
    send: sendMock,
  }),
}));

vi.mock("../../shell/src/hooks/useConversation.js", () => ({
  useConversation: () => ({
    conversations: mockConversations,
    load: loadMock,
    refresh: vi.fn(),
  }),
}));

import { useChatState } from "../../shell/src/hooks/useChatState.js";

function Probe({ onState }: { onState: (state: ReturnType<typeof useChatState>) => void }) {
  const state = useChatState();

  useEffect(() => {
    onState(state);
  }, [state, onState]);

  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useChatState refresh recovery", () => {
  beforeEach(() => {
    sendMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockImplementation(() => () => {});
    loadMock.mockReset();
    mockConnectionEpoch = 0;
    mockConversations = [];
  });

  it("reattaches the latest stored conversation on startup", async () => {
    mockConversations = [
      {
        id: "conv-1",
        preview: "hello",
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    loadMock.mockResolvedValue({
      id: "conv-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: "hi", timestamp: 2 },
      ],
    });

    render(<Probe onState={() => {}} />);

    await waitFor(() => {
      expect(loadMock).toHaveBeenCalledWith("conv-1");
    });

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({
        type: "switch_session",
        sessionId: "conv-1",
      });
    });
  });

  it("sends configured prompt text while keeping the visible user message plain", async () => {
    let latestState: ReturnType<typeof useChatState> | null = null;

    render(<Probe onState={(state) => { latestState = state; }} />);

    await act(async () => {
      latestState?.submitMessage("Build a calendar app", undefined, {
        displayText: "Build a calendar app",
        promptText: "<matrix_hermes_setup>model=Hermes</matrix_hermes_setup>\n\nBuild a calendar app",
      });
    });

    expect(sendMock).toHaveBeenCalledWith({
      type: "message",
      text: "<matrix_hermes_setup>model=Hermes</matrix_hermes_setup>\n\nBuild a calendar app",
      displayText: "Build a calendar app",
      sessionId: undefined,
      requestId: expect.stringMatching(/^req-/),
    });
    await waitFor(() => {
      expect(latestState?.messages[0]?.content).toBe("Build a calendar app");
    });
  });

  it("reattaches the active conversation after a socket reconnect epoch", async () => {
    mockConversations = [];
    let latestState: ReturnType<typeof useChatState> | null = null;
    loadMock.mockResolvedValue({
      id: "conv-replay",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });
    const { rerender } = render(<Probe onState={(state) => { latestState = state; }} />);

    await waitFor(() => {
      expect(latestState).not.toBeNull();
    });
    await act(async () => {
      latestState?.switchConversation("conv-replay");
    });

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({
        type: "switch_session",
        sessionId: "conv-replay",
      });
    });
    sendMock.mockClear();

    mockConnectionEpoch = 1;
    rerender(<Probe onState={(state) => { latestState = state; }} />);

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({
        type: "switch_session",
        sessionId: "conv-replay",
      });
    });
  });

  it("ignores replayed live events that were already rendered", async () => {
    let handler: ((msg: unknown) => void) | null = null;
    subscribeMock.mockImplementation((next: (msg: unknown) => void) => {
      handler = next;
      return () => {};
    });
    let latestState: ReturnType<typeof useChatState> | null = null;
    render(<Probe onState={(state) => { latestState = state; }} />);

    await act(async () => {
      handler?.({ type: "kernel:text", text: "Hello", requestId: "req-1", eventId: "evt-1" });
      handler?.({ type: "kernel:text", text: "Hello", requestId: "req-1", eventId: "evt-1" });
    });

    await waitFor(() => {
      expect(latestState?.messages.map((message) => message.content)).toEqual(["Hello"]);
    });
  });

  it("restores the active abort target when replaying an active run", async () => {
    let handler: ((msg: unknown) => void) | null = null;
    subscribeMock.mockImplementation((next: (msg: unknown) => void) => {
      handler = next;
      return () => {};
    });
    let latestState: ReturnType<typeof useChatState> | null = null;
    render(<Probe onState={(state) => { latestState = state; }} />);

    await act(async () => {
      handler?.({
        type: "kernel:init",
        sessionId: "conv-replay",
        requestId: "req-replay",
        eventId: "conv-replay:req-replay:0",
      });
    });
    await waitFor(() => {
      expect(latestState?.busy).toBe(true);
    });

    await act(async () => {
      latestState?.abortCurrent();
    });

    expect(sendMock).toHaveBeenCalledWith({
      type: "abort",
      requestId: "req-replay",
    });
  });

  it("ignores stale restore loads when conversations change mid-restore", async () => {
    const conv1 = {
      id: "conv-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const conv2 = {
      id: "conv-2",
      createdAt: 2,
      updatedAt: 3,
      messages: [{ role: "assistant", content: "newer", timestamp: 3 }],
    };
    const firstLoad = deferred<typeof conv1 | null>();
    const secondLoad = deferred<typeof conv2 | null>();

    mockConversations = [
      {
        id: "conv-1",
        preview: "hello",
        messageCount: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    loadMock.mockImplementation((id: string) => {
      if (id === "conv-1") return firstLoad.promise;
      if (id === "conv-2") return secondLoad.promise;
      return Promise.resolve(null);
    });

    const { rerender } = render(<Probe onState={() => {}} />);

    await waitFor(() => {
      expect(loadMock).toHaveBeenCalledWith("conv-1");
    });

    mockConversations = [
      {
        id: "conv-2",
        preview: "newer",
        messageCount: 1,
        createdAt: 2,
        updatedAt: 3,
      },
    ];
    rerender(<Probe onState={() => {}} />);

    await waitFor(() => {
      expect(loadMock).toHaveBeenCalledWith("conv-2");
    });

    await act(async () => {
      secondLoad.resolve(conv2);
      await secondLoad.promise;
    });

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({
        type: "switch_session",
        sessionId: "conv-2",
      });
    });

    await act(async () => {
      firstLoad.resolve(conv1);
      await firstLoad.promise;
    });

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock).not.toHaveBeenCalledWith({
      type: "switch_session",
      sessionId: "conv-1",
    });
  });
});
