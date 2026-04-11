// @vitest-environment jsdom

import { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const subscribeMock = vi.fn(() => () => {});
const loadMock = vi.fn();
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
