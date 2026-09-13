// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, it, vi, expect } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { setSharedComposerText, appendSharedComposerText } from "./shared-chat-composer-test-utils";
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import type { CanonicalChatInvalidation, CanonicalChatEventSource } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client";
const agent = { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper" };
const contextChat = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);
it("extends the existing picker, sends typed references with explicit access, and retains a failed draft", async () => {
  const client = createCanonicalChatWorkspaceClient();
  client.agents = { search: vi.fn(async () => ({ enabled: true, resources: [agent, contextChat] })) } as unknown as ChatAgentClient;
  vi.mocked(client.admitTurn).mockRejectedValue(new Error("Service unavailable"));
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={canonicalChatRecord.chat.id} initialView="conversation" active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  const transcript = screen.getByRole("log");
  const originalContent = transcript.textContent;
  await setSharedComposerText(editor, "@mee");
  fireEvent.click(await screen.findByRole("option", { name: /Meeting helper/ }));
  expect(client.admitTurn).not.toHaveBeenCalled();
  await appendSharedComposerText(editor, " Review this meeting");
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Allow Full access/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalled());
  expect(vi.mocked(client.admitTurn).mock.calls[0]![1]).toMatchObject({
    selection: { instanceId: canonicalChatRecord.chat.currentSelection!.instanceId }, permissionMode: "full_access",
    parts: expect.arrayContaining([{ type: "resource_reference", resource: agent }]),
  });
  expect(screen.getByRole("log")).toBe(transcript);
  expect(transcript.textContent).toBe(originalContent);
  expect(editor.textContent).toContain("Review this meeting");
  const firstRequest = vi.mocked(client.admitTurn).mock.calls[0]![1];
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.admitTurn).mock.calls[1]![1].clientRequestId).toBe(firstRequest.clientRequestId);

});
it("attributes saved Agent output from the persisted Run without relabelling ordinary turns", () => {
  const normal = canonicalChatPresentation(snapshot);
  expect(normal.some((turn) => turn.agentLabel)).toBe(false);
  const lastRun = snapshot.runs.at(-1)!;
  const invoked = canonicalChatPresentation({ ...snapshot, runs: snapshot.runs.map((run) => run.id === lastRun.id ? {
    ...run, driverKind: "hermes", context: { version: 1, requestHash: "a".repeat(64), chats: [],
      agent: { id: agent.id, revision: 1, name: agent.label, instructions: "Prepare meetings" } },
  } : run) });
  expect(invoked.find((turn) => turn.id === lastRun.turnId)?.agentLabel).toBe("Meeting helper · Hermes");
});

it.each([false, true])("retries a mentioned draft through its original operation after active state changes (%s)", async (initiallyActive) => {
  const client = createCanonicalChatWorkspaceClient();
  client.agents = { search: vi.fn(async () => ({ enabled: true, resources: [contextChat] })) } as unknown as ChatAgentClient;
  let active = initiallyActive;
  vi.mocked(client.getDetail).mockImplementation(async () => ({ record: { ...canonicalChatRecord,
    ...(active ? { activeRun: { runId: "run_busy", turnId: "cturn_busy", status: "running" as const } } : {}),
  }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities }));
  let listener: ((event: CanonicalChatInvalidation) => void) | undefined;
  const eventSource = {
    subscribe(next: (event: CanonicalChatInvalidation) => void) { listener = next; return { dispose: () => { listener = undefined; } }; },
  } as CanonicalChatEventSource;
  const fail = async () => { active = !initiallyActive; throw new Error("Ambiguous acknowledgement"); };
  vi.mocked(client.admitTurn).mockImplementation(fail);
  vi.mocked(client.queueTurn).mockImplementation(fail);
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={canonicalChatRecord.chat.id} initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "@mee");
  fireEvent.click(await screen.findByRole("option", { name: /Meeting notes/ }));
  await appendSharedComposerText(editor, " Summarize");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const original = initiallyActive ? client.queueTurn : client.admitTurn;
  const other = initiallyActive ? client.admitTurn : client.queueTurn;
  await waitFor(() => expect(original).toHaveBeenCalledTimes(1));
  const reads = vi.mocked(client.getDetail).mock.calls.length;
  await act(async () => { listener?.({ type: "chat.changed", chatId: canonicalChatRecord.chat.id, cursor: 100, revision: 100, eventType: "chat.updated" }); });
  await waitFor(() => expect(vi.mocked(client.getDetail).mock.calls.length).toBeGreaterThan(reads));
  const retryButton = await screen.findByRole("button", { name: "Send" });
  await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retryButton);
  await waitFor(() => expect(original).toHaveBeenCalledTimes(2));
  expect(other).not.toHaveBeenCalled();
  expect(vi.mocked(original).mock.calls[1]![1].clientRequestId).toBe(vi.mocked(original).mock.calls[0]![1].clientRequestId);
});
