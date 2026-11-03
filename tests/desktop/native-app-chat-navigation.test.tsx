// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  cancelRequest: vi.fn(),
  getOpened: vi.fn(() => null as object | null),
}));
vi.mock("@matrix-os/ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@matrix-os/ui")>(),
  useChatAgentsNavigation: () => navigation,
}));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(async () => ({ ok: true })) }));

import { NativeAppChatNavigationHost, useNativeAppChatNavigation } from "../../desktop/src/renderer/src/features/chat/native-app-chat-navigation";

afterEach(() => {
  cleanup();
  navigation.open.mockReset();
  navigation.close.mockReset();
  navigation.cancelRequest.mockReset();
  navigation.getOpened.mockReset();
  navigation.getOpened.mockReturnValue(null);
  useNativeAppChatNavigation.setState(useNativeAppChatNavigation.getInitialState(), true);
});

it("revalidates runtime authority immediately before opening a queued recipe", async () => {
  useNativeAppChatNavigation.getState().queue({
    requestId: "request-stale-runtime",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "target-chat");
  render(<NativeAppChatNavigationHost
    active
    tabId="target-chat"
    client={{ agents: {} } as never}
    onStartChat={vi.fn()}
    runtimeSlot="secondary"
    authGeneration={8}
  />);
  await waitFor(() => expect(useNativeAppChatNavigation.getState().pending).toBeNull());
  expect(navigation.open).not.toHaveBeenCalled();
});

it("closes an old Agents scope before opening the queued recipe", async () => {
  navigation.getOpened.mockReturnValueOnce({}).mockReturnValue(null);
  useNativeAppChatNavigation.getState().queue({
    requestId: "request-route-change",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "target-chat");
  render(<NativeAppChatNavigationHost
    active
    tabId="target-chat"
    client={{ agents: {} } as never}
    onStartChat={vi.fn()}
    runtimeSlot="primary"
    authGeneration={7}
  />);
  await waitFor(() => expect(navigation.open).toHaveBeenCalledOnce());
  expect(navigation.close).toHaveBeenCalledOnce();
  expect(navigation.close.mock.invocationCallOrder[0]).toBeLessThan(navigation.open.mock.invocationCallOrder[0]!);
});

it("closes only the Agents panel owned by a request canceled during catalog loading", async () => {
  useNativeAppChatNavigation.getState().queue({
    requestId: "request-catalog-loading",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "target-chat");
  render(<NativeAppChatNavigationHost
    active
    tabId="target-chat"
    client={{ agents: {} } as never}
    onStartChat={vi.fn()}
    runtimeSlot="primary"
    authGeneration={7}
  />);
  await waitFor(() => expect(navigation.open).toHaveBeenCalledOnce());
  act(() => useNativeAppChatNavigation.getState().cancel("request-catalog-loading"));
  await waitFor(() => expect(navigation.cancelRequest).toHaveBeenCalledWith("request-catalog-loading"));
});

it("does not let a removed Chat tab's stale cancellation block a new target tab", async () => {
  useNativeAppChatNavigation.getState().queue({
    requestId: "request-removed-tab",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "removed-chat");
  act(() => useNativeAppChatNavigation.getState().cancel("request-removed-tab"));

  useNativeAppChatNavigation.getState().queue({
    requestId: "request-new-tab",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "new-chat");
  render(<NativeAppChatNavigationHost
    active
    tabId="new-chat"
    client={{ agents: {} } as never}
    onStartChat={vi.fn()}
    runtimeSlot="primary"
    authGeneration={7}
  />);

  await waitFor(() => expect(navigation.open).toHaveBeenCalledOnce());
});
