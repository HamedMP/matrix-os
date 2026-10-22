// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "@desktop/renderer/src/features/chat/ChatTab";
import { createLegacyGlobalProviderCatalog } from "@desktop/renderer/src/features/chat/canonical-composer-adapter";
import {
  desktopProviderCatalogCache,
  startDesktopProviderCatalogCoordinator,
  stopDesktopProviderCatalogCoordinator,
} from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { AppError } from "@desktop/shared/app-error";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

async function prewarmHermesCatalog(overrides: Record<string, unknown> = {}) {
  const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/chat-providers")) return catalog;
    if (path.startsWith("/api/chats")) return { legacy: true };
    if (path === "/api/conversations") return { conversations: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  useConnection.setState({ api: { baseUrl: "https://matrix.test", get, ...overrides } as never });
  startDesktopProviderCatalogCoordinator();
  await waitFor(() => expect(desktopProviderCatalogCache.getSnapshot().lastSuccessAt).not.toBeNull());
}

describe("ChatTab send failures", () => {
  beforeEach(() => {
    stopDesktopProviderCatalogCoordinator();
    useConnection.setState(useConnection.getInitialState(), true);
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useHermesChat.setState({ messages: [], status: "idle", view: "conversation" });
    useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
    useCodingAgentWorkspace.setState({ summary: { providers: [] } as never, status: "ready" });
    resetProviderPreferences({ hydrated: true });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      userId: "user_operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:get") return { value: null };
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    stopDesktopProviderCatalogCoordinator();
    useConnection.setState(useConnection.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("retains a failed attachment preview and shows the upload reason", async () => {
    const send = vi.fn(() => true);
    const putBytes = vi.fn().mockRejectedValue(new AppError("offline"));
    useHermesChat.setState({ send });
    await prewarmHermesCatalog({ putBytes });
    render(<ChatTab />);
    const pane = await screen.findByRole("region", { name: "Hermes conversation" });
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    });

    const sendButton = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Attachment upload failed. Can't reach Matrix OS. Check your connection.",
    );
    expect(screen.getByRole("button", { name: "Retry notes.txt" })).toBeTruthy();
    expect(putBytes).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the draft and explains when Hermes rejects the send", async () => {
    const send = vi.fn(() => false);
    useHermesChat.setState({ send });
    await prewarmHermesCatalog();
    render(<ChatTab />);
    const input = await screen.findByRole("textbox", { name: "How can I help you today?" });
    await setSharedComposerText(input, "Keep this draft");

    const sendButton = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Can't reach Matrix OS. Check your connection.",
    );
    expect(input.textContent).toBe("Keep this draft");
    expect(send).toHaveBeenCalledExactlyOnceWith("Keep this draft");
  });
});
