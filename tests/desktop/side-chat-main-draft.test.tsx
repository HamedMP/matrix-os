// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { SideChatDraftContext, type SideChatDraftRequest } from "@desktop/renderer/src/features/work/SideChatDraftContext";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("adds a side-chat answer after an unsent main-chat draft", async () => {
  const client = createCanonicalChatWorkspaceClient();
  let sendAnswer!: (text: string) => void;
  function Harness() {
    const [pending, setPending] = useState<SideChatDraftRequest | null>(null);
    sendAnswer = text => setPending({ id: 1, chatId: canonicalChatRecord.chat.id, text });
    return <SideChatDraftContext.Provider value={{ pending, request: sendAnswer, consume: id => setPending(current => current?.id === id ? null : current) }}>
      <CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={canonicalChatRecord.chat.id}
        initialView="conversation" active catalog={providerCatalog}/>
    </SideChatDraftContext.Provider>;
  }
  render(<Harness/>);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Keep this thought");
  await act(async () => sendAnswer("Side answer"));
  await waitFor(() => expect(editor.textContent).toContain("Side answer"));
  expect(editor.textContent).toContain("Keep this thought");
});
