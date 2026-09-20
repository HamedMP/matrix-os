import { expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatTurn, CanonicalChatRun } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatSharing, bootstrapChatSharing } from "../../packages/gateway/src/chat/sharing.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createOwnerToolOutputProjection } from "../../packages/gateway/src/chat/owner-tool-output.js";
import { sealToolOutput } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
const now = "2026-09-20T00:00:00.000Z";
function selection(instanceId = "codex_default") {
  return { instanceId, model: "gpt-5.6-sol" };
}

function message(chatId: string, seq = 1): CanonicalChatMessage {
  return {
    id: `msg_${chatId}_${seq}`,
    chatId,
    seq,
    role: "user",
    state: "committed",
    purpose: "ai_request",
    turnId: `cturn_${chatId}_${seq}`,
    parts: [{ type: "text", text: `message ${seq}` }],
    createdAt: now,
  };
}

function turn(chatId: string, input: CanonicalChatMessage, request = "req_turn_1"): CanonicalChatTurn {
  return {
    id: `cturn_${chatId}_${input.seq}`,
    chatId,
    clientRequestId: request,
    baseMessageSeq: input.seq - 1,
    inputMessageId: input.id,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
}

function run(chatId: string, inputTurn: CanonicalChatTurn, attempt = 1): CanonicalChatRun {
  return {
    id: `run_${chatId}_${attempt}`,
    chatId,
    turnId: inputTurn.id,
    attempt,
    driverKind: "codex",
    instanceId: "codex_default",
    selection: selection(),
    interactionMode: "default",
    permissionMode: "supervised",
    status: "accepted",
    historyBoundarySeq: inputTurn.baseMessageSeq,
    capabilitySnapshot: {
      revision: "catalog_1",
      rootChat: true,
      attachments: ["file"],
      resources: ["file", "folder", "project"],
      tools: ["read", "write"],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: true,
      steering: "same_run",
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: now,
    updatedAt: now,
  };
}


it("stores only ciphertext, restores owner details, and excludes private results from shares", async () => {
  const pg = await KyselyPGlite.create();
  const repository = new ChatRepository(pg.dialect);
  try {
    await repository.bootstrap();
    await bootstrapChatSharing(repository.kysely);
    const owner = { type: "personal" as const, ownerId: "owner_test" };
    const key = Buffer.alloc(32, 9);
    const created = await repository.create(owner, { id: "chat_private", clientRequestId: "req_create", title: "Test" });
    const input = message(created.chat.id), accepted = turn(created.chat.id, input), active = run(created.chat.id, accepted);
    await repository.admitTurn(owner, { chatId: created.chat.id, baseRevision: 0, message: input, turn: accepted, run: active });
    await repository.appendRunActivities(owner, created.chat.id, active.id, [{
      id: "activity_private", type: "tool.output", chatId: created.chat.id, runId: active.id, occurredAt: now,
      toolCallId: "tool_private", text: "Tool output is private to its owner.", truncated: false,
      protectedOutput: sealToolOutput(key, "tool_private", "PRIVATE_OPAQUE_VALUE"),
    }]);
    const rows = await repository.kysely.selectFrom("chat_run_events").selectAll().execute();
    const outbox = await repository.kysely.selectFrom("chat_outbox").selectAll().execute();
    expect(JSON.stringify([rows, outbox])).not.toContain("PRIVATE_OPAQUE_VALUE");
    expect(JSON.stringify(rows)).toContain("protectedOutput");
    const service = createCanonicalChatService(repository, { projectOwnerToolOutput: createOwnerToolOutputProjection(key, [owner.ownerId]) });
    expect(JSON.stringify(await service.getDetail(owner, created.chat.id, { limit: 20 }))).toContain("PRIVATE_OPAQUE_VALUE");
    expect(await service.getDetail({ type: "personal", ownerId: "other" }, created.chat.id, { limit: 20 })).toBeNull();
    expect(JSON.stringify(await repository.exportChat(owner, created.chat.id))).not.toContain("PRIVATE_OPAQUE_VALUE");
    const sharing = new ChatSharing(repository.kysely);
    const preview = await sharing.preview(owner, created.chat.id);
    const share = await sharing.create(owner, created.chat.id, preview.revision, preview.fingerprint);
    const shared = JSON.stringify(await sharing.read(share.token));
    expect(shared).not.toContain("PRIVATE_OPAQUE_VALUE");
    expect(shared).not.toContain("protectedOutput");
    expect(shared).not.toContain("tool_private");
  } finally { await repository.kysely.destroy(); }
});
