import { expect, it } from "vitest";
import { CanonicalChatRunSchema } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { MANAGED_PI_CHAT_SUPPORTS } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

it("preserves a historical funded Claude conversation without silently rebinding new admission", async () => {
  const database = await createTestPGlite();
  const repository = new ChatRepository(database.dialect);
  const owner = { type: "personal" as const, ownerId: "owner_retired_route" };
  const selection = { instanceId: "claude_code_matrix_included", model: "claude-sonnet-5" };
  const now = "2026-10-14T00:00:00Z";
  try {
    await repository.bootstrap();
    const { chat } = await repository.create(owner, { id: "chat_retired_claude",
      clientRequestId: "req_retired_create", title: "Historical conversation" });
    const message = { id: "msg_retired", chatId: chat.id, seq: 1, role: "user" as const,
      state: "committed" as const, turnId: "cturn_retired", purpose: "ai_request" as const,
      parts: [{ type: "text" as const, text: "Retained original prompt" }], createdAt: now };
    const turn = { id: message.turnId, chatId: chat.id, clientRequestId: "req_retired_turn",
      baseMessageSeq: 0, inputMessageId: message.id, status: "accepted" as const, createdAt: now, updatedAt: now };
    // Seed through the same public persistence API used by the historical adapter.
    const run = CanonicalChatRunSchema.parse({ id: "run_retired", chatId: chat.id, turnId: turn.id,
      attempt: 1, driverKind: "claude_code", instanceId: selection.instanceId, selection,
      interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0,
      capabilitySnapshot: { ...MANAGED_PI_CHAT_SUPPORTS, revision: "historical_catalog" },
      createdAt: now, updatedAt: now });
    await repository.admitTurn(owner, { chatId: chat.id, baseRevision: chat.revision, message, turn, run });
    await repository.finishRun(owner, { chatId: chat.id, runId: run.id, outcome: "completed", completedAt: now });
    const before = await repository.exportChat(owner, chat.id);
    expect(before?.runs[0]?.selection).toEqual(selection);
    expect(before?.messages[0]?.parts).toEqual(message.parts);
    expect(validateChatProviderSelection({ selection, boundInstanceId: selection.instanceId,
      catalog: { revision: "current", drivers: [], instances: [] } }))
      .toMatchObject({ ok: false, error: { code: "provider_unavailable", retryable: false,
        recoveryActions: ["start_new_chat"] } });
    expect(await repository.exportChat(owner, chat.id)).toEqual(before);
    expect(await repository.exportChat({ ...owner, ownerId: "other_owner" }, chat.id)).toBeNull();
  } finally {
    await repository.kysely.destroy();
  }
});
