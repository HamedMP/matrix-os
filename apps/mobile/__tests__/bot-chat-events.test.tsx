import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

const mockInvalidateQueries = jest.fn();
let emitEvent: ((event: unknown) => void) | undefined;
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: "owner", getToken: jest.fn() }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({
  invalidateQueries: mockInvalidateQueries, getQueryData: () => undefined, isFetching: () => 0,
}) }));
jest.mock("@/lib/queries/use-canonical-chats", () => ({ useCanonicalChats: () => ({
  computer: { handle: "test", runtimeSlot: "primary", gatewayPath: "/vm/test" },
}) }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://example.test" }));
jest.mock("@/lib/canonical-chat-events", () => ({ createCanonicalChatEventSource: () => ({
  connect: jest.fn(), disconnect: jest.fn(), subscribeLive: () => () => undefined,
  subscribe: (listener: (event: unknown) => void) => { emitEvent = listener; return () => { emitEvent = undefined; }; },
}) }));

import { CanonicalChatSessionProvider, useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

function SelectChat() {
  const session = useCanonicalChatSession();
  return <Pressable onPress={() => session.selectChat("chat_bot")}><Text>Open bot chat</Text></Pressable>;
}

const botKey = mobileQueryKeys.botChat("owner", "https://example.test/vm/test", "chat_bot");

function openBotChat() {
  render(<CanonicalChatSessionProvider><SelectChat /></CanonicalChatSessionProvider>);
  fireEvent.press(screen.getByText("Open bot chat"));
  mockInvalidateQueries.mockClear();
}

afterEach(() => jest.useRealTimers());

it("refreshes the active bot snapshot when its chat changes or a full refresh arrives", () => {
  openBotChat();
  jest.useFakeTimers();
  act(() => emitEvent?.({ type: "chat.changed", chatId: "chat_bot", cursor: 1, eventType: "interaction.requested" }));
  expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: botKey });
  mockInvalidateQueries.mockClear();
  // A refresh this soon after the last one waits for the interval to end.
  act(() => emitEvent?.({ type: "chat.full_refresh", cursor: 2 }));
  act(() => { jest.advanceTimersByTime(2_000); });
  expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: botKey });
});

it("does not refresh the bot snapshot for every piece of streamed text", () => {
  openBotChat();
  jest.useFakeTimers();
  for (let cursor = 1; cursor <= 50; cursor += 1) {
    act(() => emitEvent?.({ type: "chat.changed", chatId: "chat_bot", cursor, eventType: "run.message" }));
  }
  act(() => { jest.advanceTimersByTime(60_000); });
  expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: botKey });
});
