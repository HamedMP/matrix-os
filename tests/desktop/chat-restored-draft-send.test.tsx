// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $getRoot, getNearestEditorFromDOMNode } from "lexical";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import {
  canonicalChatRecord as record,
  createCanonicalChatWorkspaceClient,
  providerCatalog,
  snapshot,
} from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("admits an unchanged restored draft when only its cursor moves during Send", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const detail = {
    record,
    messages: snapshot.messages,
    turns: snapshot.turns,
    runs: snapshot.runs,
    activities: snapshot.activities,
  };
  vi.mocked(client.admitTurn).mockResolvedValue({
    record: { ...record, chat: { ...record.chat, revision: record.chat.revision + 1 } },
    message: { ...snapshot.messages[0]!, id: "message_cursor_draft" },
    turn: { ...snapshot.turns[0]!, id: "turn_cursor_draft", userMessageId: "message_cursor_draft" },
    run: { ...snapshot.runs[0]!, id: "run_cursor_draft", turnId: "turn_cursor_draft" },
    admission: "accepted",
  });
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" projectLabel="Matrix OS"
    initialChatId={record.chat.id} initialView="conversation" active catalog={providerCatalog} />);

  await setSharedComposerText(await screen.findByRole("textbox", { name: "Reply to chat" }), "1");
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe(""));

  let finishDetail!: (value: typeof detail) => void;
  vi.mocked(client.getDetail).mockReturnValueOnce(new Promise((resolve) => { finishDetail = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: record.chat.title }));
  expect(await screen.findByRole("status", { name: "Loading chat" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Reply to chat" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(client.create).not.toHaveBeenCalled();
  expect(client.admitTurn).not.toHaveBeenCalled();
  await act(async () => finishDetail(detail));
  const editorElement = await screen.findByRole("textbox", { name: "Reply to chat" });
  await waitFor(() => expect(editorElement.textContent).toBe("1"));
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  expect(send.disabled).toBe(false);
  const editor = getNearestEditorFromDOMNode(editorElement);

  fireEvent.click(send);
  // The real zero-attachment upload path yields before its draft-revision
  // check. Flush a selection-only Lexical update in that interval; no text,
  // token, route, account, runtime, or provider setting has changed.
  act(() => editor.update(() => { $getRoot().selectStart(); }, { discrete: true }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledOnce());
  expect(vi.mocked(client.admitTurn).mock.calls[0]?.[0]).toBe(record.chat.id);
  expect(vi.mocked(client.admitTurn).mock.calls[0]?.[1].parts).toEqual([{ type: "text", text: "1" }]);
  expect(client.create).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe(""));
});
