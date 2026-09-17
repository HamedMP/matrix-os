// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeChatBadge } from "../../desktop/src/renderer/src/features/chat/NativeChatBadge";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { canonicalChatRecord } from "./canonical-chat-workspace-test-utils";

const mocks = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn(), start: vi.fn(), dispose: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/lib/canonical-chat-client", () => ({
  createCanonicalChatClient: () => ({ list: mocks.list }),
  createCanonicalChatEventSource: () => ({ subscribe: mocks.subscribe, start: mocks.start, dispose: mocks.dispose }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("wires the native Dock to Chat history and refreshes after read-state events", async () => {
  const invoke = vi.fn(async () => undefined);
  window.operator = { invoke, on: vi.fn(() => () => undefined) };
  useConnection.setState({ status: "signed-in", api: { baseUrl: "https://example.test" } as never });
  let refresh!: () => void;
  mocks.subscribe.mockImplementation((listener) => {
    refresh = () => listener({ type: "chat.full_refresh" });
    return { dispose: vi.fn() };
  });
  mocks.list.mockResolvedValue({ items: [{ ...canonicalChatRecord,
    readState: { unread: true, markedUnread: true, latestIncomingSeq: 0, readThroughSeq: 0, version: 1 },
  }] });
  const view = render(<NativeChatBadge />);
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("badge:set", { count: 1 }));
  mocks.list.mockResolvedValue({ items: [] });
  act(() => refresh());
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("badge:set", { count: 0 }));
  view.unmount();
});
