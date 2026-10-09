import { act, renderHook } from "@testing-library/react-native";

import { useAgentChatSync } from "../components/agents/use-agent-chat-sync";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockInvalidateQueries = jest.fn(() => Promise.resolve());
const mockUnsubscribe = jest.fn();
let mockListener: ((event: unknown) => void) | undefined;
let mockActiveChatId: string | null = null;
let mockStreamLive = true;
let mockGatewayUrl: string | null = "https://example.test/vm/test";

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
    getQueryData: () => undefined,
    setQueryData: jest.fn(),
    isFetching: () => 0,
  }),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: mockActiveChatId,
    streamLive: mockStreamLive,
    subscribe: (listener: (event: unknown) => void) => {
      mockListener = listener;
      return () => {
        mockListener = undefined;
        mockUnsubscribe();
      };
    },
  }),
}));
jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({ userId: "owner", computerKey: "test:primary", gatewayUrl: mockGatewayUrl }),
}));

const detailKey = mobileQueryKeys.canonicalChatDetail("owner", "test:primary", "chat_agent");
const botKey = mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_agent");
const chatsKey = mobileQueryKeys.canonicalChats("owner", "test:primary");

const emit = (event: unknown) => act(() => mockListener?.(event));

describe("keeping an agent's chat in step with the event stream", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockListener = undefined;
    mockActiveChatId = null;
    mockStreamLive = true;
    mockGatewayUrl = "https://example.test/vm/test";
  });

  afterEach(() => jest.useRealTimers());

  it("reads the chat and the agent's status again when the agent asks for something", () => {
    renderHook(() => useAgentChatSync("chat_agent"));

    emit({ type: "chat.changed", chatId: "chat_agent", cursor: 1, eventType: "interaction.requested" });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: detailKey });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: botKey });
  });

  it("reads both again after a gap in the stream", () => {
    renderHook(() => useAgentChatSync("chat_agent"));

    emit({ type: "chat.full_refresh", cursor: 2 });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: detailKey });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: botKey });
  });

  it("does not read the agent's status again for every piece of streamed text", () => {
    renderHook(() => useAgentChatSync("chat_agent"));

    for (let cursor = 1; cursor <= 50; cursor += 1) {
      emit({ type: "chat.changed", chatId: "chat_agent", cursor, eventType: "run.message" });
    }
    act(() => { jest.advanceTimersByTime(60_000); });

    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: botKey });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: detailKey });
  });

  it("ignores what happens in other chats", () => {
    renderHook(() => useAgentChatSync("chat_agent"));

    emit({ type: "chat.changed", chatId: "chat_other", cursor: 1, eventType: "interaction.requested" });

    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: detailKey });
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: botKey });
  });

  it("leaves the chat list to the session, which already refreshes it on every event", () => {
    renderHook(() => useAgentChatSync("chat_agent"));

    emit({ type: "chat.changed", chatId: "chat_agent", cursor: 1, eventType: "turn.accepted" });
    emit({ type: "chat.full_refresh", cursor: 2 });
    act(() => { jest.advanceTimersByTime(60_000); });

    expect(mockInvalidateQueries).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: chatsKey }));
  });

  it("listens to nothing until the chat and the computer are known", () => {
    const view = renderHook(({ chatId }: { chatId: string | null }) => useAgentChatSync(chatId), {
      initialProps: { chatId: null as string | null },
    });
    expect(mockListener).toBeUndefined();

    mockGatewayUrl = null;
    view.rerender({ chatId: "chat_agent" });
    expect(mockListener).toBeUndefined();

    mockGatewayUrl = "https://example.test/vm/test";
    view.rerender({ chatId: "chat_agent" });
    expect(mockListener).toBeDefined();
  });

  it("stays out of the way when the Chats tab already has this chat open", () => {
    mockActiveChatId = "chat_agent";
    renderHook(() => useAgentChatSync("chat_agent"));

    expect(mockListener).toBeUndefined();
  });

  it("stops listening when the screen is left", () => {
    const view = renderHook(() => useAgentChatSync("chat_agent"));
    expect(mockListener).toBeDefined();

    view.unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockListener).toBeUndefined();
  });

  it("listens again once the stream is back, as it may then be another stream", () => {
    const view = renderHook(() => useAgentChatSync("chat_agent"));
    const first = mockListener;

    mockStreamLive = false;
    view.rerender(undefined);
    mockStreamLive = true;
    view.rerender(undefined);

    expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
    expect(mockListener).toBeDefined();
    expect(mockListener).not.toBe(first);
  });
});
