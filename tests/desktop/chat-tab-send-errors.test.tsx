// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "@desktop/renderer/src/features/chat/ChatTab";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { AppError } from "@desktop/shared/app-error";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

describe("ChatTab send failures", () => {
  beforeEach(() => {
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
    useProviderPreferences.setState({ defaultProviderId: null, composerSelections: {}, hydrated: true });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
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
    vi.restoreAllMocks();
  });

  it("retains a failed attachment preview and shows the upload reason", async () => {
    const send = vi.fn(() => true);
    useHermesChat.setState({ send });
    useConnection.setState({ api: { putBytes: vi.fn().mockRejectedValue(new AppError("offline")) } as never });
    render(<ChatTab />);
    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Attachment upload failed. Can't reach Matrix OS. Check your connection.",
    );
    expect(screen.getByRole("button", { name: "Retry notes.txt" })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the draft and explains when Hermes rejects the send", async () => {
    const send = vi.fn(() => false);
    useHermesChat.setState({ send });
    render(<ChatTab />);
    const input = screen.getByRole("textbox", { name: "How can I help you today?" });
    await setSharedComposerText(input, "Keep this draft");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Can't reach Matrix OS. Check your connection.",
    );
    expect(input.textContent).toBe("Keep this draft");
  });
});
