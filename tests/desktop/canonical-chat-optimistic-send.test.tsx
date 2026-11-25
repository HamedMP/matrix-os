// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { CanonicalNewChatContent } from "@desktop/renderer/src/features/chat/CanonicalNewChatContent";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { pendingCanonicalTurnRows } from "@matrix-os/ui";
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

// Text in the composer is not a transcript bubble; only the transcript counts.
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
  // The sent text leaves the composer when its pending message shows, so it is never shown twice.
  await waitFor(() => expect(editor.textContent).toBe(""));

  await act(async () => { created.resolve(createdRecord); });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" })).toBeTruthy());
  expect(screen.getAllByText("Plan the launch", { ignore: OUTSIDE_COMPOSER })).toHaveLength(1);
});

it("puts the draft back and drops the bubble when the new Chat cannot be created", async () => {
  const { routeClient, created } = newChatClient();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await sendFromNewChat(routeClient, "Lost on the way");
  expect(await screen.findByText("Lost on the way", { ignore: OUTSIDE_COMPOSER })).toBeTruthy();

  await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe(""));

  await act(async () => { created.reject(new AppError("offline")); });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Lost on the way", { ignore: OUTSIDE_COMPOSER })).toBeNull();
  // The rejected send's text comes back to the composer to retry.
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe("Lost on the way"));
  warn.mockRestore();
});

it("empties the composer when a follow-up's pending message shows, before admission", async () => {
  const routeClient = client();
  const admitted = deferred<never>();
  vi.mocked(routeClient.admitTurn).mockReturnValue(admitted.promise);
  render(<CanonicalChatWorkspace client={routeClient} projectId="matrix-os" initialChatId={record.chat.id}
    initialView="conversation" active catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "One more thing");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(routeClient.admitTurn).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("One more thing", { ignore: OUTSIDE_COMPOSER })).toBeTruthy();
  await waitFor(() => expect(editor.textContent).toBe(""));
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

// Greptile on #3633: the pending transcript remounted the composer, so state it
// holds itself (selected project skills) was gone when a failed send returned
// the draft. The composer keeps its place while the transcript swaps in.
function StatefulComposer() {
  const [selected, setSelected] = React.useState(false);
  return <button type="button" aria-pressed={selected} onClick={() => setSelected(true)}>Skill</button>;
}

it.each([true, false])("keeps the composer mounted while a new Chat's pending message shows (welcome=%s)", (showWelcome) => {
  const { message, turn } = pendingCanonicalTurnRows({ requestId: "req_skill", chatId: "", parts: [{ type: "text", text: "Use the skill" }], createdAt: "2026-11-24T00:00:00.000Z" });
  const turns = canonicalChatPresentation({ messages: [message], turns: [turn], runs: [], activities: [] });
  const props = { projectId: "matrix-os", showWelcome, workspaceLayout: "wide" as const, composer: <StatefulComposer />, onSelect: () => undefined };
  const view = render(<CanonicalNewChatContent {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Skill" }));

  view.rerender(<CanonicalNewChatContent {...props} pending={{ turns, copyText: async () => undefined }} />);
  expect(screen.getByText("Use the skill")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Skill" }).getAttribute("aria-pressed")).toBe("true");

  view.rerender(<CanonicalNewChatContent {...props} />);
  expect(screen.queryByText("Use the skill")).toBeNull();
  expect(screen.getByRole("button", { name: "Skill" }).getAttribute("aria-pressed")).toBe("true");
});
