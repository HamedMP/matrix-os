// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function pendingAdmission(mode: "send" | "queue" | "edit", withReference = false) {
  const fixture = createCanonicalChatFixture(mode === "send" ? "completed" : "running").snapshot;
  const record = { chat: fixture.chat, projectId: "matrix-os", providerBinding: fixture.chat.providerBinding, activeRun: fixture.chat.activeRun };
  const queued = { id: "queued_test", chatId: fixture.chat.id, clientRequestId: "request_test", position: 1,
    parts: [{ type: "text" as const, text: "Existing queued draft" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default", permissionMode: "supervised", executionRoot: { kind: "project" as const, projectId: "matrix-os" },
    createdAt: "2026-08-31T02:00:00.000Z", updatedAt: "2026-08-31T02:00:00.000Z" };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [record] });
  vi.mocked(client.getDetail).mockResolvedValue({ record, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs, activities: fixture.activities, queuedTurns: mode === "edit" ? [queued] : [] });
  let resolve!: (value: never) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((yes, no) => { resolve = yes; reject = no; });
  const request = mode === "send" ? client.admitTurn : mode === "queue" ? client.queueTurn : client.updateQueuedTurn;
  vi.mocked(request).mockReturnValue(pending);
  const api = { baseUrl: "https://matrix.test", get: vi.fn(async () => ({ results: ["notes.md"] })), putBytes: vi.fn(async (url: string) => ({ ok: true, path: decodeURIComponent(url.split("path=")[1]!), size: 9 })) } as never;
  const props = { api, client, projectId: "matrix-os", active: true, initialChatId: fixture.chat.id, catalog: providerCatalog };
  const view = render(<CanonicalChatWorkspace {...props} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  if (mode === "edit") {
    fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions for Existing queued draft" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Existing queued draft" }));
  }
  if (mode === "edit") await waitFor(() => expect(editor.textContent).toBe("Existing queued draft"));
  await setSharedComposerText(editor, withReference ? "Original admission draft @notes" : "Original admission draft");
  if (withReference) {
    fireEvent.click(await screen.findByRole("option", { name: /notes.md/ }));
    await waitFor(() => expect(screen.getByTestId("composer-reference-token-file-notes.md")).toBeTruthy());
  }
  if (!withReference) fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["synthetic"], "original.txt", { type: "text/plain" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const success = mode === "send" ? { record, message: fixture.messages[0]!, turn: fixture.turns[0]!, run: fixture.runs[0]!, admission: "accepted" }
    : { queuedTurn: queued, queueDepth: 1 };
  return { editor, view, props, request, client, detail: { record, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs, activities: fixture.activities, queuedTurns: [queued] },
    fail: () => act(async () => reject(new AppError("offline"))),
    succeed: () => act(async () => resolve(success as never)),
  };
}

it.each(["queue", "edit"] as const)("retains failed %s admission draft and attachment after Settings invalidation", async (mode) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  expect(pending.editor.textContent).toBe("Original admission draft");
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await pending.fail();
  await waitFor(() => expect(pending.editor.textContent).toBe("Original admission draft"));
  expect(screen.getByText("original.txt")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(pending.request).toHaveBeenCalledOnce();
});

it.each(["send", "queue", "edit"] as const)("acknowledges successful %s admission despite Settings invalidation without leaving the submitted attachment", async (mode) => {
  const pending = await pendingAdmission(mode);
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await pending.succeed();
  await waitFor(() => expect(pending.editor.textContent).toBe(""));
  expect(screen.queryByText("original.txt")).toBeNull();
  expect(pending.request).toHaveBeenCalledOnce();
});

it.each(["send", "queue", "edit"] as const)("preserves newer text after successful %s admission during Settings invalidation", async (mode) => {
  const pending = await pendingAdmission(mode);
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await setSharedComposerText(pending.editor, "Newer draft");
  await pending.succeed();
  expect(pending.editor.textContent).toBe("Newer draft");
  expect(screen.queryByText("original.txt")).toBeNull();
});

it.each(["queue", "edit"] as const)("does not overwrite a newer draft after failed %s admission", async (mode) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  await setSharedComposerText(pending.editor, "Newer draft");
  await pending.fail();
  expect(pending.editor.textContent).toBe("Newer draft");
  expect(screen.getByText("original.txt")).toBeTruthy();
});


it.each(["send", "queue", "edit"] as const)("preserves a retyped same-text draft and newly added attachment after successful %s admission", async (mode) => {
  const pending = await pendingAdmission(mode);
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await setSharedComposerText(pending.editor, "Intermediate edit");
  await setSharedComposerText(pending.editor, "Original admission draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["new"], "newer.txt", { type: "text/plain" })] } });
  await pending.succeed();
  expect(pending.editor.textContent).toBe("Original admission draft");
  expect(screen.queryByText("original.txt")).toBeNull();
  expect(screen.getByText("newer.txt")).toBeTruthy();
});

it.each(["queue", "edit"] as const)("does not replace a newer empty revision after failed %s admission", async (mode) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  await setSharedComposerText(pending.editor, "Newer draft");
  await setSharedComposerText(pending.editor, "");
  await pending.fail();
  expect(pending.editor.textContent).toBe("");
  expect(screen.getByText("original.txt")).toBeTruthy();
});

it.each(["queue", "edit"].flatMap((mode) => ["client", "chat", "auth", "runtime"].map((boundary) => ({ mode: mode as "queue" | "edit", boundary }))))("does not settle failed $mode admission into another $boundary scope", async ({ mode, boundary }) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  if (boundary === "client") pending.view.rerender(<CanonicalChatWorkspace {...pending.props} client={createCanonicalChatWorkspaceClient()} />);
  if (boundary === "chat") pending.view.rerender(<CanonicalChatWorkspace {...pending.props} initialChatId="other_chat" />);
  if (boundary === "auth") act(() => useConnection.setState({ authGeneration: 1 }));
  if (boundary === "runtime") act(() => useConnection.setState({ runtimeSlot: "other" }));
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Other scope draft");
  await pending.fail();
  expect(editor.textContent).toBe("Other scope draft");
  if (boundary === "client" || boundary === "chat") expect(screen.queryByRole("alert")).toBeNull();
});


it.each(["client", "chat"] as const)("does not publish an edit failure after its recovery refresh crosses %s scope", async (boundary) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission("edit");
  let finishRefresh!: (value: never) => void;
  vi.mocked(pending.client.getDetail).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
  const calls = vi.mocked(pending.client.getDetail).mock.calls.length;
  await pending.fail();
  await waitFor(() => expect(pending.client.getDetail).toHaveBeenCalledTimes(calls + 1));
  pending.view.rerender(<CanonicalChatWorkspace {...pending.props}
    client={boundary === "client" ? createCanonicalChatWorkspaceClient() : pending.client}
    initialChatId={boundary === "chat" ? "another_chat" : pending.props.initialChatId} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "New scope draft");
  await act(async () => finishRefresh(pending.detail as never));
  expect(editor.textContent).toBe("New scope draft");
  expect(screen.queryByRole("alert")).toBeNull();
});


it.each(["send", "queue", "edit"].flatMap((mode) => ["client", "chat", "auth", "runtime"].map((boundary) => ({ mode: mode as "send" | "queue" | "edit", boundary }))))("does not settle successful $mode admission into another $boundary scope", async ({ mode, boundary }) => {
  const pending = await pendingAdmission(mode);
  if (boundary === "client") pending.view.rerender(<CanonicalChatWorkspace {...pending.props} client={createCanonicalChatWorkspaceClient()} />);
  if (boundary === "chat") pending.view.rerender(<CanonicalChatWorkspace {...pending.props} initialChatId="other_chat" />);
  if (boundary === "auth") act(() => useConnection.setState({ authGeneration: 1 }));
  if (boundary === "runtime") act(() => useConnection.setState({ runtimeSlot: "other" }));
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Other scope draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["new"], "scope.txt", { type: "text/plain" })] } });
  await pending.succeed();
  expect(editor.textContent).toBe("Other scope draft");
  expect(screen.getByText("scope.txt")).toBeTruthy();
});

it("acknowledges a newly created Chat's first successful admission after Settings invalidation", async () => {
  const fixture = createCanonicalChatFixture("completed").snapshot;
  const record = { chat: fixture.chat, providerBinding: fixture.chat.providerBinding };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [] });
  vi.mocked(client.create).mockResolvedValue(record);
  let finish!: (value: never) => void;
  vi.mocked(client.admitTurn).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<CanonicalChatWorkspace client={client} projectId={null} active initialView="draft" catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Start a chat" });
  await setSharedComposerText(editor, "First accepted draft");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledOnce());
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await act(async () => finish({ record, message: fixture.messages[0], turn: fixture.turns[0], run: fixture.runs[0], admission: "accepted" } as never));
  expect((await screen.findByRole("textbox", { name: "Reply to chat" })).textContent).toBe("");
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.admitTurn).toHaveBeenCalledOnce();
});

async function visitChat(pending: Awaited<ReturnType<typeof pendingAdmission>>, chatId: string) {
  vi.mocked(pending.client.getDetail).mockImplementation(async (id) => ({ ...pending.detail,
    record: { ...pending.detail.record, chat: { ...pending.detail.record.chat, id } } }));
  vi.mocked(pending.client.list).mockResolvedValue({ items: [pending.detail.record,
    { ...pending.detail.record, chat: { ...pending.detail.record.chat, id: "chat_other" } }] });
  pending.view.rerender(<CanonicalChatWorkspace {...pending.props} initialChatId={chatId} />);
  return screen.findByRole("textbox", { name: "Reply to chat" });
}

it.each(["queue", "edit"] as const)("retains original %s draft when a deferred request fails while another Chat is visible", async (mode) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  const other = await visitChat(pending, "chat_other");
  await setSharedComposerText(other, "Other Chat draft");
  await pending.fail();
  expect(other.textContent).toBe("Other Chat draft");
  expect(screen.queryByRole("alert")).toBeNull();
  const original = await visitChat(pending, pending.props.initialChatId);
  await waitFor(() => expect(original.textContent).toBe("Original admission draft"));
  expect(pending.request).toHaveBeenCalledOnce();
});

it.each(["send", "queue", "edit"] as const)("clears only the original %s draft after actual success while another Chat is visible", async (mode) => {
  const pending = await pendingAdmission(mode);
  const other = await visitChat(pending, "chat_other");
  await setSharedComposerText(other, "Other Chat draft");
  await pending.succeed();
  expect(other.textContent).toBe("Other Chat draft");
  const original = await visitChat(pending, pending.props.initialChatId);
  await waitFor(() => expect(original.textContent).toBe(""));
  expect(pending.request).toHaveBeenCalledOnce();
});

it.each(["send", "queue", "edit"].flatMap((mode) => [false, true].map((retyped) => ({ mode: mode as "send" | "queue" | "edit", retyped }))))("preserves a newer original $mode draft after navigation and acceptance (retyped=$retyped)", async ({ mode, retyped }) => {
  const pending = await pendingAdmission(mode);
  await setSharedComposerText(pending.editor, "Newer original draft");
  if (retyped) await setSharedComposerText(pending.editor, "Original admission draft");
  const other = await visitChat(pending, "chat_other");
  await setSharedComposerText(other, "Other Chat draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["other"], "other.txt", { type: "text/plain" })] } });
  await pending.succeed();
  expect(other.textContent).toBe("Other Chat draft");
  expect(screen.getByText("other.txt")).toBeTruthy();
  const original = await visitChat(pending, pending.props.initialChatId);
  await waitFor(() => expect(original.textContent).toBe(retyped ? "Original admission draft" : "Newer original draft"));
});

it.each(["queue", "edit"].flatMap((mode) => [false, true].map((retyped) => ({ mode: mode as "queue" | "edit", retyped }))))("preserves a newer original $mode draft after navigation and rejection (retyped=$retyped)", async ({ mode, retyped }) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode);
  await setSharedComposerText(pending.editor, "Newer original draft");
  if (retyped) await setSharedComposerText(pending.editor, "Original admission draft");
  const other = await visitChat(pending, "chat_other");
  await setSharedComposerText(other, "Other Chat draft");
  await pending.fail();
  expect(other.textContent).toBe("Other Chat draft");
  const original = await visitChat(pending, pending.props.initialChatId);
  await waitFor(() => expect(original.textContent).toBe(retyped ? "Original admission draft" : "Newer original draft"));
});

it.each(["queue", "edit"] as const)("retains original %s reference tokens after a deferred rejection in another Chat", async (mode) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = await pendingAdmission(mode, true);
  expect(pending.editor.textContent).toContain("notes.md");
  const other = await visitChat(pending, "chat_other");
  await setSharedComposerText(other, "Other Chat draft");
  expect(screen.queryByTestId("composer-reference-token-file-notes.md")).toBeNull();
  await pending.fail();
  expect(other.textContent).toBe("Other Chat draft");
  await visitChat(pending, pending.props.initialChatId);
  expect(await screen.findByTestId("composer-reference-token-file-notes.md")).toBeTruthy();
});

it.each(["send", "queue"] as const)("allocates a new resource-mention request ID after actual %s acceptance while another Chat is visible", async (mode) => {
  const pending = await pendingAdmission(mode, true);
  const first = vi.mocked(pending.request).mock.calls[0]![1];
  expect(first.clientRequestId).toBeTruthy();
  await visitChat(pending, "chat_other");
  await pending.succeed();
  const original = await visitChat(pending, pending.props.initialChatId);
  await setSharedComposerText(original, "Original admission draft @notes");
  fireEvent.click(await screen.findByRole("option", { name: /notes.md/ }));
  await waitFor(() => expect(screen.getByTestId("composer-reference-token-file-notes.md")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(pending.request).toHaveBeenCalledTimes(2));
  const second = vi.mocked(pending.request).mock.calls[1]![1];
  expect(second.parts).toEqual(first.parts);
  expect(second.clientRequestId).not.toBe(first.clientRequestId);
});
