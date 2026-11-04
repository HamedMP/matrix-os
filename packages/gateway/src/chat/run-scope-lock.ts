import type { Kysely, Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type { ChatDatabase } from "./database.js";
import { ChatConflictError } from "./errors.js";
import type { ChatOwner } from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

/** Match shared admission's Project -> scope -> Chat lock order before run writes.
 * This is a storage fence; all existing caller/run/organization checks remain.
 * Private runs have no shared queue binding and never query collaboration tables.
 */
export async function lockRunCollaborationScope(
  executor: Executor, owner: ChatOwner, chatId: string, runId: string,
): Promise<void> {
  const queued = await executor.selectFrom("chat_queued_turns as queued")
    .innerJoin("chats as chat", "chat.id", "queued.chat_id")
    .select("queued.collaboration_scope_id")
    .where("queued.claimed_run_id", "=", runId).where("queued.chat_id", "=", chatId)
    .where("chat.owner_type", "=", owner.type).where("chat.owner_id", "=", owner.ownerId)
    .executeTakeFirst();
  if (!queued?.collaboration_scope_id) return;
  const trx = executor as unknown as Transaction<OwnerCollaborationDatabase>;
  const scope = await trx.selectFrom("collaboration_scopes").select(["id", "parent_scope_id"])
    .where("id", "=", queued.collaboration_scope_id)
    .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
    .where("kind", "=", "chat").where("resource_id", "=", chatId).executeTakeFirst();
  if (!scope) return; // Owner cleanup can still finish a run after scope removal.
  if (scope.parent_scope_id) {
    const parent = await trx.selectFrom("collaboration_scopes").select("id")
      .where("id", "=", scope.parent_scope_id)
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .forUpdate().executeTakeFirst();
    if (!parent) throw new ChatConflictError(chatId, 0);
  }
  const locked = await trx.selectFrom("collaboration_scopes").select("id")
    .where("id", "=", scope.id).where("kind", "=", "chat").where("resource_id", "=", chatId)
    .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
    .where("parent_scope_id", scope.parent_scope_id === null ? "is" : "=", scope.parent_scope_id)
    .forUpdate().executeTakeFirst();
  // Never acquire a newly assigned Project after taking the Chat lock.
  if (!locked) throw new ChatConflictError(chatId, 0);
}
