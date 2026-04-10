// @vitest-environment jsdom

import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
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
});
