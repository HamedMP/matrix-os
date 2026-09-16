// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";

afterEach(cleanup);

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
