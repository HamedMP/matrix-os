// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient as client, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("labels active-run drafts Queue next and preserves edit, reorder, cancel and steering receipts", async () => {
  const running = createCanonicalChatFixture("running").snapshot;
  const activeRunRecord = {
    ...running.runs[0]!,
    capabilitySnapshot: {
      ...running.runs[0]!.capabilitySnapshot,
      steering: "same_run" as const,
    },
  };
  const runningRecord = {
    chat: {
      id: running.chat.id,
      ownerScope: running.chat.ownerScope,
      title: running.chat.title,
      lifecycle: running.chat.lifecycle,
      attention: running.chat.attention,
      revision: running.chat.revision,
      messageCount: running.chat.messageCount,
      lastMessagePreview: running.chat.lastMessagePreview,
      currentSelection: running.chat.currentSelection,
      createdAt: running.chat.createdAt,
      updatedAt: running.chat.updatedAt,
    },
    projectId: "matrix-os",
    providerBinding: running.chat.providerBinding,
    activeRun: running.chat.activeRun,
  };
  const queuedTurn = (id: string, position: number, text: string) => ({
    id,
    chatId: running.chat.id,
    clientRequestId: `req_${id}`,
    position,
    parts: [{ type: "text" as const, text }],
    selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default",
    permissionMode: "supervised",
    executionRoot: { kind: "project" as const, projectId: "matrix-os" },
    createdAt: "2026-08-31T02:00:00.000Z",
    updatedAt: "2026-08-31T02:00:00.000Z",
  });
  const first = queuedTurn("qturn_workspace_1", 1, "First queued turn");
  const second = queuedTurn("qturn_workspace_2", 2, "Second queued turn");
  const editedSecond = { ...second, parts: [{ type: "text" as const, text: "Edited second queued turn" }] };
  const third = queuedTurn("qturn_workspace_3", 3, "Third queued turn");
  const routeClient = client();
  vi.mocked(routeClient.list).mockResolvedValue({ items: [runningRecord] });
  vi.mocked(routeClient.getDetail).mockResolvedValue({
    record: runningRecord,
    messages: running.messages,
    turns: running.turns,
    runs: [activeRunRecord],
    activities: running.activities,
    queuedTurns: [first, second],
  });
  let finishSteer!: (value: Awaited<ReturnType<CanonicalChatClient["steerQueuedTurn"]>>) => void;
  const steering = new Promise<Awaited<ReturnType<CanonicalChatClient["steerQueuedTurn"]>>>((resolve) => {
    finishSteer = resolve;
  });
  vi.mocked(routeClient.steerQueuedTurn).mockReturnValue(steering);
  const steered = {
    runId: activeRunRecord.id,
    turnId: activeRunRecord.turnId,
    message: {
      id: "msg_workspace_steer",
      chatId: running.chat.id,
      seq: 2,
      role: "user",
      state: "committed",
      turnId: activeRunRecord.turnId,
      runId: activeRunRecord.id,
      parts: first.parts,
      createdAt: "2026-08-31T02:00:01.000Z",
    },
    steering: "accepted" as const,
  };
  let finishQueue!: (value: Awaited<ReturnType<CanonicalChatClient["queueTurn"]>>) => void;
  const queueMutation = new Promise<Awaited<ReturnType<CanonicalChatClient["queueTurn"]>>>((resolve) => {
    finishQueue = resolve;
  });
  vi.mocked(routeClient.queueTurn).mockReturnValue(queueMutation);
  vi.mocked(routeClient.updateQueuedTurn).mockResolvedValue({
    queuedTurn: editedSecond,
  });
  let finishReorder!: (value: Awaited<ReturnType<CanonicalChatClient["reorderQueuedTurns"]>>) => void;
  const reorderMutation = new Promise<Awaited<ReturnType<CanonicalChatClient["reorderQueuedTurns"]>>>((resolve) => {
    finishReorder = resolve;
  });
  vi.mocked(routeClient.reorderQueuedTurns).mockReturnValue(reorderMutation);
  vi.mocked(routeClient.cancelQueuedTurn).mockResolvedValue({
    queuedTurnId: second.id,
    queueDepth: 2,
    cancellation: "cancelled",
  });

  render(
    <CanonicalChatWorkspace
      client={routeClient}
      projectId="matrix-os"
      projectLabel="Matrix OS"
      initialChatId={running.chat.id}
      initialView="conversation"
      active
      catalog={providerCatalog}
    />,
  );

  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  const queuePanel = await screen.findByRole("region", { name: "Queued turns" });
  expect(queuePanel.getAttribute("data-attached-to-composer")).toBe("true");
  expect(queuePanel.getAttribute("data-queue-card-style")).toBe("codex");
  expect(queuePanel.getAttribute("data-queue-density")).toBe("compact");
  expect(within(queuePanel).getAllByRole("listitem")[0]?.className).toContain("min-h-10");
  expect(screen.queryByText("Up next")).toBeNull();
  expect(screen.queryByText("2 turns")).toBeNull();
  expect(screen.getByText("First queued turn")).toBeTruthy();
  expect(screen.getByText("Second queued turn")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Steer current run" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Queue next" })).toBeNull();

  await setSharedComposerText(editor, "Third queued turn");
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Queue next" }));
  await waitFor(() => expect(routeClient.queueTurn).toHaveBeenCalledWith(
    running.chat.id,
    expect.objectContaining({ parts: [{ type: "text", text: "Third queued turn" }] }),
  ));
  expect(editor.textContent).toBe("Third queued turn");
  expect(within(queuePanel).queryByText("Third queued turn")).toBeNull();
  finishQueue({ queuedTurn: third, queueDepth: 3 });
  await waitFor(() => expect(within(queuePanel).getByText("Third queued turn")).toBeTruthy());
  expect(editor.textContent).toBe("");
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Second queued turn" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Second queued turn" }));
  await waitFor(() => expect(editor.textContent).toContain("Second queued turn"));
  await setSharedComposerText(editor, "Edited second queued turn");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(routeClient.updateQueuedTurn).toHaveBeenCalledWith(
    running.chat.id,
    second.id,
    expect.objectContaining({ parts: [{ type: "text", text: "Edited second queued turn" }] }),
  ));

  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Edited second queued turn" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("menuitem", { name: "Edit Edited second queued turn" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Move .* (up|down)/ })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  const firstDragHandle = screen.getByRole("button", { name: "Reorder First queued turn" });
  const secondRow = screen.getByText("Edited second queued turn").closest("li");
  if (!secondRow) throw new Error("Second queued turn row not found");
  const dataTransfer = {
    dropEffect: "none",
    effectAllowed: "none",
    setData: vi.fn(),
  } as unknown as DataTransfer;
  fireEvent.dragStart(firstDragHandle, { dataTransfer });
  fireEvent.dragOver(secondRow, { dataTransfer });
  fireEvent.drop(secondRow, { dataTransfer });
  expect(within(queuePanel).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    expect.stringContaining("Edited second queued turn"),
    expect.stringContaining("First queued turn"),
    expect.stringContaining("Third queued turn"),
  ]);
  await waitFor(() => expect(routeClient.reorderQueuedTurns).toHaveBeenCalledWith(
    running.chat.id,
    expect.objectContaining({ queuedTurnIds: [second.id, first.id, third.id] }),
  ));
  finishReorder({ queuedTurns: [editedSecond, first, third] });
  await waitFor(() => expect(screen.getByRole("button", { name: "Reorder First queued turn" })).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "Cancel Edited second queued turn" }));
  await waitFor(() => expect(routeClient.cancelQueuedTurn).toHaveBeenCalledWith(
    running.chat.id,
    second.id,
    expect.objectContaining({ baseRevision: running.chat.revision + 3 }),
  ));

  fireEvent.click(screen.getByRole("button", { name: "Steer First queued turn" }));
  expect(within(queuePanel).getByText("First queued turn")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Steering First queued turn" })).toBeTruthy();
  expect(within(screen.getByRole("log")).queryByText("First queued turn")).toBeNull();
  expect(routeClient.steerQueuedTurn).toHaveBeenCalledTimes(1);
  finishSteer(steered);
  await waitFor(() => expect(routeClient.steerQueuedTurn).toHaveBeenCalledWith(
    running.chat.id,
    activeRunRecord.id,
    first.id,
    expect.objectContaining({ expectedTurnId: activeRunRecord.turnId }),
  ));
  await waitFor(() => expect(within(queuePanel).queryByText("First queued turn")).toBeNull());
  await waitFor(() => expect(within(screen.getByRole("log")).getByText("First queued turn")).toBeTruthy());
});
