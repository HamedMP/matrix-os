// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, snapshot } from "./canonical-chat-workspace-test-utils";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["queued", "promoted", "different_request", "different_chat", "different_payload", "incomplete_promotion"])(
  "acknowledges a lost queue reply only with this request's durable receipt (%s)", async (state) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createCanonicalChatWorkspaceClient();
    const request = { clientRequestId: "req_lost_queue_reply", parts: [{ type: "text" as const, text: "Original request" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "full_access" };
    const queued = { ...request, id: "qturn_lost_reply", chatId: state === "different_chat" ? "chat_other" : canonicalChatRecord.chat.id,
      clientRequestId: state === "different_request" ? "req_other_request" : request.clientRequestId, position: 1,
      parts: state === "different_payload" ? [{ type: "text" as const, text: "Previous version of the draft" }] : request.parts,
      createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" };
    const { result } = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os",
      initialChatId: canonicalChatRecord.chat.id, active: true }));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(canonicalChatRecord.chat.id));
    const promoted = state === "promoted" || state === "incomplete_promotion";
    vi.mocked(client.getDetail).mockResolvedValue({ record: canonicalChatRecord,
      messages: snapshot.messages.map(message => message.role === "user" ? { ...message, parts: request.parts } : message),
      turns: snapshot.turns.map(turn => ({ ...turn, clientRequestId: promoted ? request.clientRequestId : turn.clientRequestId })),
      runs: state === "incomplete_promotion" ? [] : snapshot.runs, activities: snapshot.activities, queuedTurns: promoted ? [] : [queued] });
    vi.mocked(client.queueTurn).mockRejectedValue(new Error("ReplyLost"));
    const onAccepted = vi.fn();
    await act(async () => { await result.current.queueTurn(request, onAccepted); });
    expect(onAccepted).toHaveBeenCalledTimes(state === "queued" || state === "promoted" ? 1 : 0);
    expect(result.current.error).toBe(state === "queued" || state === "promoted" ? null : "The message could not be queued. Refresh and try again.");
    expect(client.queueTurn).toHaveBeenCalledOnce();
  },
);

it("reconciles a claimed queue acknowledgement without restoring the consumed row", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const queuedTurn = {
    id: "qturn_consumed", chatId: canonicalChatRecord.chat.id, clientRequestId: "req_consumed", position: 1,
    parts: [{ type: "text" as const, text: "Original request" }],
    selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default", permissionMode: "full_access",
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  };
  vi.mocked(client.queueTurn).mockResolvedValue({ queuedTurn, queueDepth: 0, alreadyClaimed: true });
  const { result } = renderHook(() => useCanonicalChatRouteController({
    client, projectId: "matrix-os", initialChatId: canonicalChatRecord.chat.id, active: true,
  }));
  await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(canonicalChatRecord.chat.id));
  let accepted: unknown;
  await act(async () => { accepted = await result.current.queueTurn(queuedTurn); });
  expect(accepted).toMatchObject({ alreadyClaimed: true });
  expect(client.queueTurn).toHaveBeenCalledTimes(1);
  expect(result.current.detail?.queuedTurns ?? []).toEqual([]);
  expect(result.current.detail?.record.chat.revision).toBe(canonicalChatRecord.chat.revision);
  expect(result.current.error).toBeNull();
});
