// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatSafeError } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Owner outcome (ENG-554): a failed Chat in Electron Desktop names the harness
// and offers the action that fixes the failure, and each action opens its target.
// Fault caught: a renderer that reads only `retryable` and drops recovery actions.
class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function renderFailedChat(error: CanonicalChatSafeError) {
  const failed = createCanonicalChatFixture("failed").snapshot;
  const record = { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, id: failed.chat.id, revision: failed.chat.revision } };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [record] });
  vi.mocked(client.getDetail).mockResolvedValue({
    record, messages: failed.messages, turns: failed.turns, runs: failed.runs,
    activities: [{ id: "act_failure", chatId: failed.chat.id, runId: failed.runs[0]!.id, sequence: 1,
      occurredAt: failed.runs[0]!.updatedAt, type: "run.error", error }],
  });
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" projectLabel="Matrix OS"
    initialChatId={failed.chat.id} initialView="conversation" active catalog={providerCatalog} />);
  return client;
}

describe("Electron Desktop Chat failure recovery", () => {
  beforeAll(() => { globalThis.ResizeObserver = NoopResizeObserver; });
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useUi.setState({ requestedSettingsSection: null });
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("names the harness and opens Agents & providers for a legacy sign-in failure", async () => {
    renderFailedChat({ code: "authorization_failed", retryable: true, recoveryActions: ["retry"],
      safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude." });
    const notice = await screen.findByRole("status", { name: "Codex fixture could not finish" });
    expect(notice.textContent).toContain("Sign-in required. Reconnect in Agents & providers on this computer.");
    expect(screen.queryByRole("button", { name: /^Retry / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Agents & providers Codex fixture could not finish" }));
    await waitFor(() => expect(useUi.getState().requestedSettingsSection).toBe("agents-providers"));
    expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({ kind: "settings" }));
  });

  it("opens the composer model picker for an unavailable model", async () => {
    // jsdom has no layout; the picker opens only from a visible trigger.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 32, height: 32 }] as unknown as DOMRectList);
    renderFailedChat({ code: "model_unavailable", safeMessage: "Model unavailable. Choose another model.",
      retryable: false, recoveryActions: ["select_provider"] });
    fireEvent.click(await screen.findByRole("button", { name: "Choose model Codex fixture could not finish" }));
    expect(await screen.findByRole("listbox", { name: "Models and connections" })).toBeTruthy();
  });

  it("starts a new Chat for a run that cannot be resumed", async () => {
    renderFailedChat({ code: "run_not_resumable", safeMessage: "Conversation is too long. Start a new chat.",
      retryable: false, recoveryActions: ["start_new_chat"] });
    fireEvent.click(await screen.findByRole("button", { name: "New chat Codex fixture could not finish" }));
    expect(await screen.findByRole("textbox", { name: "Start a chat" })).toBeTruthy();
  });
});
