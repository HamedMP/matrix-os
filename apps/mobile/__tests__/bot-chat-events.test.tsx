import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

const mockInvalidateQueries = jest.fn();
let emitEvent: ((event: unknown) => void) | undefined;
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: "owner", getToken: jest.fn() }) }));
let mockBotState: unknown;
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({
  invalidateQueries: mockInvalidateQueries, getQueryState: () => mockBotState,
}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({
  computer: { handle: "test", runtimeSlot: "primary", gatewayPath: "/vm/test" },
}) }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
jest.mock("@/lib/canonical-chat-events", () => ({ createCanonicalChatEventSource: () => ({
  connect: jest.fn(), disconnect: jest.fn(),
  subscribe: (listener: (event: unknown) => void) => { emitEvent = listener; return () => { emitEvent = undefined; }; },
}) }));

import { CanonicalChatSessionProvider, useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { BotStatusUnsupportedError } from "@/lib/requests/bots";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

function SelectChat() {
  const session = useCanonicalChatSession();
  return <Pressable onPress={() => session.selectChat("chat_bot")}><Text>Open bot chat</Text></Pressable>;
}

it("refreshes the active bot snapshot when its chat changes or a full refresh arrives", () => {
  render(<CanonicalChatSessionProvider><SelectChat /></CanonicalChatSessionProvider>);
  fireEvent.press(screen.getByText("Open bot chat"));
  mockInvalidateQueries.mockClear();
  act(() => emitEvent?.({ type: "chat.changed", chatId: "chat_bot", cursor: 1 }));
  expect(mockInvalidateQueries).toHaveBeenCalledWith({
    queryKey: mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_bot"),
  });
  mockInvalidateQueries.mockClear();
  act(() => emitEvent?.({ type: "chat.full_refresh", cursor: 2 }));
  expect(mockInvalidateQueries).toHaveBeenCalledWith({
    queryKey: mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_bot"),
  });
});

describe("a chat whose bot status has nothing to follow", () => {
  afterEach(() => { mockBotState = undefined; });

  it.each([
    ["the computer confirmed it has no bot", { data: null, error: null }],
    ["the computer has no bot-status route", { data: undefined, error: new BotStatusUnsupportedError() }],
  ])("is left alone when the chat changes: %s", (_case, state) => {
    mockBotState = state;
    render(<CanonicalChatSessionProvider><SelectChat /></CanonicalChatSessionProvider>);
    fireEvent.press(screen.getByText("Open bot chat"));
    mockInvalidateQueries.mockClear();
    act(() => emitEvent?.({ type: "chat.changed", chatId: "chat_bot", cursor: 1 }));
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_bot"),
    });
  });

  it("is still refreshed when a status read failed, so the error can clear", () => {
    mockBotState = { data: undefined, error: new Error("Bot status could not be loaded. Try again.") };
    render(<CanonicalChatSessionProvider><SelectChat /></CanonicalChatSessionProvider>);
    fireEvent.press(screen.getByText("Open bot chat"));
    mockInvalidateQueries.mockClear();
    act(() => emitEvent?.({ type: "chat.changed", chatId: "chat_bot", cursor: 1 }));
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_bot"),
    });
  });
});
