// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { QueuedTurnsPanel } from "@desktop/renderer/src/features/chat/QueuedTurnsPanel";
import { ChatQueuedRequests } from "../../shell/src/components/chat/ChatQueuedRequests";

afterEach(cleanup);
const answer: CanonicalChatQueuedTurn = {
  id: "qturn_answer", chatId: "chat_answer", clientRequestId: "req_answer_in_0123456789abcdef",
  position: 1, parts: [{ type: "text", text: "Which format?\nPlain text." }],
  selection: { instanceId: "matrix_bot_default", model: "auto" },
  interactionMode: "default", permissionMode: "default",
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
};

it.each(["Electron Desktop", "Web"] as const)("shows a submitted answer directly without manual steering in %s", surface => {
  const callbacks = { onSteer: vi.fn(), onEdit: vi.fn(), onReorder: vi.fn(), onCancel: vi.fn() };
  render(surface === "Electron Desktop"
    ? <QueuedTurnsPanel turns={[answer]} canSteer {...callbacks} />
    : <ChatQueuedRequests turns={[answer]} onCancel={vi.fn()} />);
  expect(screen.getByText("Which format? Plain text.", { exact: false })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Continuing automatically");
  expect(screen.queryByRole("region", { name: "Queued turns" })).toBeNull();
  expect(screen.queryByLabelText("Queued requests")).toBeNull();
  expect(screen.queryByText("Queued next")).toBeNull();
  expect(screen.queryByRole("button", { name: /Steer|Edit|Reorder|More actions/ })).toBeNull();
});

it("keeps ordinary queued messages steerable alongside the automatic answer", () => {
  render(<QueuedTurnsPanel turns={[answer, { ...answer, id: "qturn_ordinary", clientRequestId: "req_ordinary", position: 2,
    parts: [{ type: "text", text: "Use a table instead" }] }]} canSteer onSteer={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Steer Use a table instead" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Steer Which format/ })).toBeNull();
});

it("keeps automatic answers in place when ordinary queued messages are reordered", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const onReorder = vi.fn();
  render(<QueuedTurnsPanel turns={[answer,
    { ...answer, id: "qturn_a", clientRequestId: "req_a", position: 2, parts: [{ type: "text", text: "A" }] },
    { ...answer, id: "qturn_b", clientRequestId: "req_b", position: 3, parts: [{ type: "text", text: "B" }] },
  ]} onSteer={vi.fn()} onEdit={vi.fn()} onReorder={onReorder} onCancel={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Reorder A" }), { key: "ArrowDown" });
  expect(onReorder).toHaveBeenCalledWith([answer.id, "qturn_b", "qturn_a"], "qturn_a");
});

it.each(["Electron Desktop", "Web"] as const)("keeps cancellation available before the answer starts in %s", async surface => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const onCancel = vi.fn(async () => true);
  render(surface === "Electron Desktop"
    ? <QueuedTurnsPanel turns={[answer]} onSteer={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()} onCancel={onCancel} />
    : <ChatQueuedRequests turns={[answer]} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel pending answer" }));
  await waitFor(() => expect(onCancel).toHaveBeenCalledWith(answer.id));
});
