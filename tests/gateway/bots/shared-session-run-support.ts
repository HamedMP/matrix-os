import type { Kysely } from "kysely";
import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { NOW } from "./bot-state-support.js";

/** Canonical run transitions supply the same active-run/Chat lock fence as production. */
export async function admitSessionRun(db: Kysely<OwnerBotDatabase>, ownerId: string, chatId: string, runId: string) {
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const chat = await db.selectFrom("chats").select(["revision", "message_count"]).where("id", "=", chatId).executeTakeFirstOrThrow();
  const turnId = `cturn_${runId}`, messageId = `msg_${runId}`, clientRequestId = `req_${runId}`;
  await repository.admitTurn({ type: "personal", ownerId }, { chatId, baseRevision: Number(chat.revision),
    message: { id: messageId, chatId, seq: Number(chat.message_count) + 1, role: "user", state: "committed", actorId: ownerId, purpose: "ai_request", turnId, parts: [{ type: "text", text: "Shared session request" }], createdAt: NOW },
    turn: { id: turnId, chatId, clientRequestId, baseMessageSeq: Number(chat.message_count), inputMessageId: messageId, status: "accepted", createdAt: NOW, updatedAt: NOW },
    run: { id: runId, chatId, turnId, driverKind: "matrix_bot", instanceId: MATRIX_BOT_SELECTION.instanceId, selection: MATRIX_BOT_SELECTION,
      attempt: 1, status: "accepted", interactionMode: "default", permissionMode: "supervised", historyBoundarySeq: Number(chat.message_count),
      capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: false, userInput: false, resume: false, cancellation: true, steering: "none", worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: NOW, updatedAt: NOW },
  });
  return { complete: () => repository.finishRun({ type: "personal", ownerId }, { chatId, runId, outcome: "completed", completedAt: NOW }) };
}
