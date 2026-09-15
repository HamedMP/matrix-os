// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";

const agent = { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper", revision: "3" };
const chat = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
const file = { kind: "file" as const, id: "file_notes", label: "Meeting file" };
const turn: CanonicalChatQueuedTurn = {
  id: "qturn_context_edit", chatId: snapshot.chat.id, clientRequestId: "req_context_edit",
  position: 1,
  parts: [
    { type: "text", text: "Original request" },
    { type: "resource_reference", resource: agent },
    { type: "resource_reference", resource: chat },
    { type: "resource_reference", resource: file },
  ],
  context: {
    version: 1, requestHash: "a".repeat(64),
    agent: { id: agent.id, name: "Pinned meeting helper", revision: 3, instructions: "Review notes" },
    chats: [{ chatId: chat.id, title: "Pinned meeting notes", throughSeq: 7, text: "Previously admitted notes", truncated: false }],
  },
  selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
  interactionMode: "default", permissionMode: "full_access",
  createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
};

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

async function startEditing(queued = turn) {
  const client = createCanonicalChatWorkspaceClient();
  const preview = vi.fn();
  client.agents = { search: vi.fn(async () => ({ enabled: true, resources: [agent, chat, file] })), preview } as unknown as ChatAgentClient;
  vi.mocked(client.getDetail).mockResolvedValue({ record: canonicalChatRecord,
    messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs,
    activities: snapshot.activities, queuedTurns: [queued],
  });
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
    initialView="conversation" active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Original request" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Original request" }));
  await waitFor(() => expect(editor.textContent).toBe("Original request"));
  return { client, editor, preview };
}

it("shows immutable queued references, access and original snapshots while saving each original part once", async () => {
  const { client, editor, preview } = await startEditing();
  const receipt = screen.getByRole("region", { name: "Queued request context" });
  expect(within(receipt).getByText("Full access")).toBeTruthy();
  expect(within(receipt).getByText("Meeting helper")).toBeTruthy();
  expect(within(receipt).getByText("Meeting notes")).toBeTruthy();
  expect(within(receipt).getByText("Meeting file")).toBeTruthy();
  expect(within(receipt).getByText("Agent revision 3")).toBeTruthy();
  fireEvent.click(within(receipt).getByText("Context used · 1 Chat"));
  expect(within(receipt).getByText("Previously admitted notes")).toBeTruthy();
  expect(within(receipt).queryByRole("button", { name: /Remove|Preview/ })).toBeNull();
  expect(preview).not.toHaveBeenCalled();
  await setSharedComposerText(editor, "Revised request");
  vi.mocked(client.updateQueuedTurn).mockResolvedValue({ queuedTurn: { ...turn, parts: [
    ...turn.parts.slice(1), { type: "text", text: "Revised request" },
  ] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.updateQueuedTurn).toHaveBeenCalledWith(snapshot.chat.id, turn.id,
    expect.objectContaining({ parts: [...turn.parts.slice(1), { type: "text", text: "Revised request" }] })));
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.queueTurn).not.toHaveBeenCalled();
});

it("does not offer new Agent or Chat references while editing admitted context", async () => {
  const { editor } = await startEditing();
  await setSharedComposerText(editor, "@Meeting");
  expect(await screen.findByRole("option", { name: /Meeting file/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Meeting helper|Meeting notes/ })).toBeNull();
});

it("keeps pinned evidence and revised text visible after a rejected save", async () => {
  const { client, editor, preview } = await startEditing();
  vi.mocked(client.updateQueuedTurn).mockRejectedValue(new Error("Conflict"));
  await setSharedComposerText(editor, "Keep this revision");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.updateQueuedTurn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(editor.textContent).toBe("Keep this revision"));
  expect(screen.getByRole("region", { name: "Queued request context" })).toBeTruthy();
  expect(preview).not.toHaveBeenCalled();
});
