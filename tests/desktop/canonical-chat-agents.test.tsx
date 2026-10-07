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
import { createBotClient } from "../../packages/ui/src/chat-agents/bots/client";
import { clientFixture, saved } from "./chat-agents-fixture";
const agent = { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper" };
const contextChat = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);
it("keeps a rail Agent's identity on a new draft and clears it for a later ordinary draft", async () => {
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [] });
  const resource = { ...agent, revision: "3" };
  const props = { client, projectId: "matrix-os", active: true, catalog: providerCatalog };
  const view = render(<CanonicalChatWorkspace {...props} draftRequest={{ id: 1, text: "", resources: [resource] }} />);
  const editor = await screen.findByRole("textbox", { name: "Start a chat" });
  expect(screen.getByRole("checkbox", { name: /Allow Full access/ })).toBeTruthy();
  await appendSharedComposerText(editor, " Review synthetic notes");
  expect(screen.getByRole("checkbox", { name: /Allow Full access/ })).toBeTruthy();
  view.rerender(<CanonicalChatWorkspace {...props} draftRequest={{ id: 1, text: "", resources: [resource] }} />);
  expect(editor.textContent).toContain("Review synthetic notes");
  expect(client.create).not.toHaveBeenCalled();
  view.rerender(<CanonicalChatWorkspace {...props} draftRequest={{ id: 2, text: "Ordinary draft" }} />);
  await waitFor(() => expect(editor.textContent).toBe("Ordinary draft"));
  expect(screen.queryByRole("checkbox", { name: /Allow Full access/ })).toBeNull();
  expect(client.create).not.toHaveBeenCalled();
});

it("resets optional Full access when the same Agent replaces a draft, while retaining it during typing", async () => {
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [] });
  const resource = { ...agent, revision: "3" };
  const props = { client, projectId: "matrix-os", active: true, catalog: providerCatalog };
  const view = render(<CanonicalChatWorkspace {...props} draftRequest={{ id: 11, text: "First request", resources: [resource] }} />);
  const editor = await screen.findByRole("textbox", { name: "Start a chat" });
  const checkbox = screen.getByRole("checkbox", { name: /Allow Full access/ }) as HTMLInputElement;
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  await appendSharedComposerText(editor, " with details");
  expect(checkbox.checked).toBe(true);
  view.rerender(<CanonicalChatWorkspace {...props} draftRequest={{ id: 12, text: "Second request", resources: [resource] }} />);
  await waitFor(() => expect(editor.textContent).toContain("Second request"));
  expect((screen.getByRole("checkbox", { name: /Allow Full access/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  expect(client.create).not.toHaveBeenCalled();
});

it("opens a mentioned saved Bot's dedicated Chat before admitting its own executor request", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const botChatId = "chat_meeting_bot";
  const sourceChatId = canonicalChatRecord.chat.id;
  const botRequest = vi.fn(async (path: string, method: string) => {
    if (path === `/api/chat-agents/${saved.id}/direct-chat` && (method === "GET" || method === "POST")) {
      return { chatId: botChatId };
    }
    if (path === `/api/chats/${botChatId}/bot` && method === "GET") return { agentId: saved.id };
    if (path === `/api/chats/${sourceChatId}/bot` && method === "GET") return { agentId: null };
    throw new Error(`Unexpected Bot request: ${method} ${path}`);
  });
  const agents = { ...clientFixture(), bots: createBotClient(botRequest) };
  agents.list.mockResolvedValue({ enabled: true, agents: [saved] });
  agents.search.mockResolvedValue({ enabled: true, resources: [agent, contextChat] });
  client.agents = agents;
  const catalog = await agents.catalog();
  const hermes = catalog.instances.find(instance => instance.id === saved.selection.instanceId)!;
  hermes.supports = { ...hermes.supports, permissionModes: ["full_access"] };
  const sourceDetail = await client.getDetail(sourceChatId);
  vi.mocked(client.getDetail).mockImplementation(async chatId => chatId === botChatId ? {
    record: { ...canonicalChatRecord, providerBinding: undefined,
      chat: { ...canonicalChatRecord.chat, id: botChatId, title: saved.name, currentSelection: saved.selection } },
    messages: [], turns: [], runs: [], activities: [],
  } : sourceDetail);
  vi.mocked(client.admitTurn).mockRejectedValue(new Error("Service unavailable"));
  const onActiveChatChanged = vi.fn();
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={sourceChatId}
    initialView="conversation" active catalog={catalog} onActiveChatChanged={onActiveChatChanged} />);
  const sourceEditor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(sourceEditor, "Review this meeting @mee");
  fireEvent.click(await screen.findByRole("option", { name: /Meeting helper/ }));
  await waitFor(() => expect(botRequest).toHaveBeenCalledWith(`/api/chat-agents/${saved.id}/direct-chat`, "POST", {}));
  await waitFor(() => expect(onActiveChatChanged.mock.calls.some(([chatId]) => chatId === botChatId)).toBe(true));
  await waitFor(() => expect(client.getDetail).toHaveBeenCalledWith(botChatId, expect.anything()));
  const consent = await screen.findByRole("checkbox", { name: "Allow Full access on this computer for this Bot request." });
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await waitFor(() => expect(editor.textContent).toBe("Review this meeting"));
  expect(client.create).not.toHaveBeenCalled();
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.queueTurn).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(botChatId, expect.objectContaining({
    selection: saved.selection, permissionMode: "full_access",
    parts: expect.arrayContaining([{ type: "text", text: "Review this meeting" },
      { type: "resource_reference", resource: { ...agent, revision: String(saved.revision) } }]),
  }), expect.anything()));
  expect(editor.textContent).toBe("Review this meeting");
  const firstRequest = vi.mocked(client.admitTurn).mock.calls[0]![1];
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.admitTurn).mock.calls.every(([chatId]) => chatId === botChatId)).toBe(true);
  expect(vi.mocked(client.admitTurn).mock.calls[1]![1].clientRequestId).toBe(firstRequest.clientRequestId);
  expect(client.create).not.toHaveBeenCalled();
  expect(client.queueTurn).not.toHaveBeenCalled();
  expect(botRequest.mock.calls.some(([path]) => /\/(authority|interactions|bot-tasks)$/.test(path))).toBe(false);
});

it("extends the existing picker, sends typed Chat context in Supervised mode, and retains a failed draft", async () => {
  const client = createCanonicalChatWorkspaceClient();
  client.agents = { search: vi.fn(async () => ({ enabled: true, resources: [agent, contextChat] })) } as unknown as ChatAgentClient;
  vi.mocked(client.admitTurn).mockRejectedValue(new Error("Service unavailable"));
  render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={canonicalChatRecord.chat.id} initialView="conversation" active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  const transcript = screen.getByRole("log");
  const originalContent = transcript.textContent;
  await setSharedComposerText(editor, "@mee");
  fireEvent.click(await screen.findByRole("option", { name: /Meeting notes/ }));
  expect(client.admitTurn).not.toHaveBeenCalled();
  await appendSharedComposerText(editor, " Review this meeting");
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalled());
  expect(vi.mocked(client.admitTurn).mock.calls[0]![1]).toMatchObject({
    selection: { instanceId: canonicalChatRecord.chat.currentSelection!.instanceId }, permissionMode: "supervised",
    parts: expect.arrayContaining([{ type: "resource_reference", resource: contextChat }]),
  });
  expect(screen.getByRole("log")).toBe(transcript);
  expect(transcript.textContent).toBe(originalContent);
  expect(editor.textContent).toContain("Review this meeting");
  const firstRequest = vi.mocked(client.admitTurn).mock.calls[0]![1];
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.admitTurn).mock.calls[1]![1].clientRequestId).toBe(firstRequest.clientRequestId);

});
it.each(["hermes", "codex"] as const)("attributes saved Agent output from the persisted %s Run without relabelling ordinary turns", (driverKind) => {
  const normal = canonicalChatPresentation(snapshot);
  expect(normal.some((turn) => turn.agentLabel)).toBe(false);
  const lastRun = snapshot.runs.at(-1)!;
  const invoked = canonicalChatPresentation({ ...snapshot, runs: snapshot.runs.map((run) => run.id === lastRun.id ? {
    ...run, driverKind, context: { version: 1, requestHash: "a".repeat(64), chats: [],
      agent: { id: agent.id, revision: 1, name: agent.label, instructions: "Prepare meetings" } },
  } : run) });
  expect(invoked.find((turn) => turn.id === lastRun.turnId)?.agentLabel).toBe(`Meeting helper · ${driverKind === "codex" ? "Codex" : "Hermes"}`);
});

it.each([false, true])("retries a mentioned draft through its original operation after active state changes (%s)", async (initiallyActive) => {
  const client = createCanonicalChatWorkspaceClient();
  client.agents = { search: vi.fn(async () => ({ enabled: true, resources: [contextChat] })) } as unknown as ChatAgentClient;
  let active = initiallyActive;
  vi.mocked(client.getDetail).mockImplementation(async () => ({ record: { ...canonicalChatRecord,
    ...(active ? { activeRun: { runId: "run_busy", turnId: "cturn_busy", status: "running" as const } } : {}),
  }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities }));
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  const eventSource = {
    subscribe(next: (event: CanonicalChatInvalidation) => void) {
      if (listeners.size >= 8) throw new Error("Too many fixture subscribers");
      listeners.add(next);
      return { dispose: () => { listeners.delete(next); } };
    },
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
  await act(async () => {
    for (const listener of [...listeners]) listener({ type: "chat.changed", chatId: canonicalChatRecord.chat.id, cursor: 100, revision: 100, eventType: "chat.updated" });
  });
  await waitFor(() => expect(vi.mocked(client.getDetail).mock.calls.length).toBeGreaterThan(reads));
  const retryButton = await screen.findByRole("button", { name: "Send" });
  await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retryButton);
  await waitFor(() => expect(original).toHaveBeenCalledTimes(2));
  expect(other).not.toHaveBeenCalled();
  expect(vi.mocked(original).mock.calls[1]![1].clientRequestId).toBe(vi.mocked(original).mock.calls[0]![1].clientRequestId);
});
