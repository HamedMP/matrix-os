// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@matrix-os/ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@matrix-os/ui")>(),
  useChatAgentsNavigation: () => navigation,
}));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(async () => ({ ok: true })) }));

import { NativeAppChatNavigationHost, useNativeAppChatNavigation } from "../../desktop/src/renderer/src/features/chat/native-app-chat-navigation";

afterEach(() => {
  cleanup();
  navigation.open.mockReset();
  useNativeAppChatNavigation.setState(useNativeAppChatNavigation.getInitialState(), true);
});

it("revalidates runtime authority immediately before opening a queued recipe", async () => {
  useNativeAppChatNavigation.getState().queue({
    requestId: "request-stale-runtime",
    view: "recipes",
    recipeId: "company-brain",
    runtimeSlot: "primary",
    authGeneration: 7,
  });
  render(<NativeAppChatNavigationHost
    active
    client={{ agents: {} } as never}
    onStartChat={vi.fn()}
    runtimeSlot="secondary"
    authGeneration={8}
  />);
  await waitFor(() => expect(useNativeAppChatNavigation.getState().pending).toBeNull());
  expect(navigation.open).not.toHaveBeenCalled();
});
