import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema, CanonicalChatTurnIdSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import { chatContextRequestHash } from "./agent-context.js";
import { ChatConflictError, ChatNotFoundError } from "./errors.js";
import { toMessage, toRun, toTurn, type ChatOwner } from "./records.js";
import type { AdmittedRun, AdmittedTurn } from "./repository.js";
import type { TurnAdmissionDependencies } from "./turn-admission-repository.js";

type Dependencies = Pick<TurnAdmissionDependencies, "transact" | "selectOwnedChat" | "toPrincipalRecord">;

/** Acknowledging persisted work never revalidates mutable execution dependencies or dispatches it again. */
export async function findChatTurnAdmission(
  deps: Dependencies, ownerInput: ChatOwner, chatId: string, clientRequestId: string, requestHash: string,
): Promise<AdmittedTurn | null> {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  CanonicalChatIdSchema.parse(chatId);
  CanonicalChatRequestIdSchema.parse(clientRequestId);
  return deps.transact(async (trx) => {
    const chat = await deps.selectOwnedChat(trx, owner, chatId, true);
    if (!chat) throw new ChatNotFoundError(chatId);
    const turnRow = await trx.selectFrom("chat_turns").selectAll()
      .where("chat_id", "=", chatId).where("client_request_id", "=", clientRequestId).executeTakeFirst();
    // Queue keys belong to queue admission even after they become committed turns.
    const queued = await trx.selectFrom("chat_queued_turns").select("id")
      .where("chat_id", "=", chatId).where("client_request_id", "=", clientRequestId).executeTakeFirst();
    if (queued) throw new ChatConflictError(chatId, Number(chat.revision));
    if (!turnRow) return null;
    const row = await trx.selectFrom("chat_runs").selectAll()
      .where("turn_id", "=", turnRow.id).orderBy("attempt", "asc").executeTakeFirstOrThrow();
    const messageRow = await trx.selectFrom("chat_messages").selectAll()
      .where("id", "=", turnRow.input_message_id).executeTakeFirstOrThrow();
    const run = toRun(row);
    const message = toMessage(messageRow);
    // Older rows can only attest to their persisted fields/context; new rows keep the original input hash.
    const originalHash = row.request_hash ?? run.context?.requestHash ?? chatContextRequestHash({ ...run, parts: message.parts });
    if (originalHash !== requestHash) throw new ChatConflictError(chatId, Number(chat.revision));
    return { chat: await deps.toPrincipalRecord(trx, owner, chat), message, turn: toTurn(turnRow), run, alreadyAccepted: true };
  });
}

export async function findChatRetryAdmission(
  deps: Dependencies, ownerInput: ChatOwner, chatId: string, turnId: string, clientRequestId: string,
): Promise<AdmittedRun | null> {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  CanonicalChatIdSchema.parse(chatId);
  CanonicalChatTurnIdSchema.parse(turnId);
  CanonicalChatRequestIdSchema.parse(clientRequestId);
  return deps.transact(async (trx) => {
    const chat = await deps.selectOwnedChat(trx, owner, chatId, true);
    if (!chat) throw new ChatNotFoundError(chatId);
    const row = await trx.selectFrom("chat_runs").selectAll()
      .where("chat_id", "=", chatId).where("turn_id", "=", turnId)
      .where("client_request_id", "=", clientRequestId).executeTakeFirst();
    if (!row) return null;
    if (row.attempt < 2) throw new ChatConflictError(chatId, Number(chat.revision));
    const turnRow = await trx.selectFrom("chat_turns").selectAll()
      .where("chat_id", "=", chatId).where("id", "=", turnId).executeTakeFirstOrThrow();
    return { chat: await deps.toPrincipalRecord(trx, owner, chat), turn: toTurn(turnRow), run: toRun(row), alreadyAccepted: true };
  });
}
