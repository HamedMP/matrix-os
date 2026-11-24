// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { AppError } from "@desktop/shared/app-error";
import { canonicalChatRecord as record, createCanonicalChatWorkspaceClient as client, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

// ENG-540: on Electron Desktop a new Chat's first message stayed greyed in the
// composer with no bubble until the Chat was created and its turn admitted;
// Web Desktop showed it at once. Both now share the pending-send projection.

class WorkspaceResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

beforeEach(() => {
  globalThis.ResizeObserver = WorkspaceResizeObserver;
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The composer keeps the draft until acceptance; only the transcript counts.
const OUTSIDE_COMPOSER = "script, style, [contenteditable], [contenteditable] *";
const createdRecord = { ...record, chat: { ...record.chat, revision: 0, messageCount: 0 } };

function newChatClient() {
  const routeClient = client();
  vi.mocked(routeClient.list).mockResolvedValue({ items: [] });
  const created = deferred<typeof createdRecord>();
  vi.mocked(routeClient.create).mockReturnValue(created.promise as never);
  vi.mocked(routeClient.admitTurn).mockImplementation(async (_chatId: string, request: CanonicalCreateChatTurnRequest) => ({
    record,
    message: { ...snapshot.messages[0]!, id: "msg_sent", role: "user" as const, turnId: "cturn_sent", parts: request.parts },
    turn: { ...snapshot.turns[0]!, id: "cturn_sent", clientRequestId: request.clientRequestId, inputMessageId: "msg_sent" },
    run: { ...snapshot.runs[0]!, turnId: "cturn_sent" },
    admission: "accepted" as const,
  }) as never);
  vi.mocked(routeClient.getDetail).mockImplementation(async () => {
    const admitted = vi.mocked(routeClient.admitTurn).mock.calls[0]?.[1];
    return {
      record, runs: [], activities: [],
      messages: admitted ? [{ ...snapshot.messages[0]!, id: "msg_sent", role: "user" as const, turnId: "cturn_sent", parts: admitted.parts }] : [],
      turns: admitted ? [{ ...snapshot.turns[0]!, id: "cturn_sent", clientRequestId: admitted.clientRequestId, inputMessageId: "msg_sent" }] : [],
    };
  });
  return { routeClient, created };
}

async function sendFromNewChat(routeClient: ReturnType<typeof client>, text: string) {
  render(<CanonicalChatWorkspace client={routeClient} projectId="matrix-os" projectLabel="Matrix OS" active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Start a chat" });
  await setSharedComposerText(editor, text);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  return editor;
}

it("shows a new Chat's first message before the Chat exists, and once after admission", async () => {
  const { routeClient, created } = newChatClient();
  const editor = await sendFromNewChat(routeClient, "Plan the launch");

  await waitFor(() => expect(routeClient.create).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("Plan the launch", { ignore: OUTSIDE_COMPOSER })).toBeTruthy();

  await act(async () => { created.resolve(createdRecord); });
  await waitFor(() => expect(editor.textContent).toBe(""));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" })).toBeTruthy());
  expect(screen.getAllByText("Plan the launch", { ignore: OUTSIDE_COMPOSER })).toHaveLength(1);
});

it("keeps the composer draft and drops the bubble when the new Chat cannot be created", async () => {
  const { routeClient, created } = newChatClient();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await sendFromNewChat(routeClient, "Lost on the way");
  expect(await screen.findByText("Lost on the way", { ignore: OUTSIDE_COMPOSER })).toBeTruthy();

  await act(async () => { created.reject(new AppError("offline")); });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Lost on the way", { ignore: OUTSIDE_COMPOSER })).toBeNull();
  // The composer moves between the pending transcript and the welcome screen.
  expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe("Lost on the way");
  warn.mockRestore();
});

it("does not carry a pending draft send into the next New Chat", async () => {
  const { routeClient, created } = newChatClient();
  const input = { parts: [{ type: "text" as const, text: "Draft send" }],
    selection: { instanceId: "codex_test", model: "test" }, interactionMode: "default", permissionMode: "supervised" };
  const hook = renderHook(() => useCanonicalChatRouteController({ client: routeClient, projectId: null, active: true, autoSelectFirst: false }));
  try {
    await act(async () => {});
    let sending!: Promise<unknown>;
    await act(async () => { sending = hook.result.current.submitTurn(input, "Draft"); });
    const shown = hook.result.current.displayTranscript;
    expect(shown?.kind).toBe("draft");
    expect(shown?.kind === "draft" && shown.transcript.messages.map(message => message.parts)).toEqual([input.parts]);

    await act(async () => { hook.result.current.startNewChat(); });
    expect(hook.result.current.displayTranscript).toBeNull();
    await act(async () => { created.resolve(createdRecord); await sending; });
    expect(hook.result.current.pendingTurn).toBeNull();
  } finally { hook.unmount(); }
});
