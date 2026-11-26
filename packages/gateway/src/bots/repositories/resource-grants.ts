import { sql, type Selectable } from "kysely";
import type { BotResourceGrantKind } from "@matrix-os/contracts";
import type { BotResourceGrantsTable } from "../database.js";
import type { BotResourceGrantCandidate, BotResourceGrantTarget } from "../resource-grant-scope.js";
import { isoTimestamp, type BotExecutor } from "./shared.js";

type ResourceGrantRow = Selectable<BotResourceGrantsTable>;
type BindingScope = BotResourceGrantTarget & { bindingCreatedAt: string };

export async function findPrivateResourceBinding(
  db: BotExecutor,
  ownerId: string,
  agentId: string,
): Promise<BindingScope | undefined> {
  const row = await db.selectFrom("bot_chat_bindings as binding")
    .innerJoin("chats as chat", "chat.id", "binding.chat_id")
    .select(["binding.chat_id", "binding.created_at"])
    .where("binding.owner_id", "=", ownerId)
    .where("binding.bot_id", "=", agentId)
    .where("binding.kind", "=", "direct")
    .where("binding.removed_at", "is", null)
    .where("chat.owner_id", "=", ownerId)
    .where("chat.owner_type", "=", "personal")
    .where("chat.lifecycle", "=", "active")
    .where("chat.project_id", "is", null)
    .where("chat.collaboration", "is", null)
    .forShare(["binding", "chat"])
    .executeTakeFirst();
  return row && { ownerId, agentId, chatId: row.chat_id, bindingCreatedAt: isoTimestamp(row.created_at) };
}

export function isGrantForBinding(grant: ResourceGrantRow, binding: BindingScope): boolean {
  return grant.chat_id === binding.chatId && isoTimestamp(grant.binding_created_at) === binding.bindingCreatedAt;
}

export function createBotResourceGrantsRepository(db: BotExecutor, binding: BindingScope) {
  const activeScope = (kind: BotResourceGrantKind) => db.selectFrom("bot_resource_grants")
    .selectAll()
    .where("owner_id", "=", binding.ownerId)
    .where("bot_id", "=", binding.agentId)
    .where("kind", "=", kind);

  return {
    list() {
      return db.selectFrom("bot_resource_grants").selectAll()
        .where("owner_id", "=", binding.ownerId).where("bot_id", "=", binding.agentId).execute();
    },
    findActive(kind: BotResourceGrantKind) {
      return activeScope(kind)
        .where("chat_id", "=", binding.chatId)
        .where("binding_created_at", "=", binding.bindingCreatedAt)
        .where("revoked_at", "is", null).forShare().executeTakeFirst();
    },
    save(input: { id: string; candidateId: string; candidate: BotResourceGrantCandidate; now: string; previous?: ResourceGrantRow }) {
      const values = {
        grant_id: input.id,
        candidate_id: input.candidateId,
        chat_id: binding.chatId,
        binding_created_at: binding.bindingCreatedAt,
        label: input.candidate.label,
        connection_id: input.candidate.connectionId,
        scope: JSON.stringify(input.candidate.scope),
        created_at: input.now,
        revoked_at: null,
      };
      return db.insertInto("bot_resource_grants").values({
        ...values, owner_id: binding.ownerId, bot_id: binding.agentId, kind: input.candidate.scope.kind,
      }).onConflict((conflict) => {
        const target = conflict.columns(["owner_id", "bot_id", "kind"]);
        if (!input.previous) return target.doNothing();
        return target.doUpdateSet({
          ...values,
          revision: sql<number>`bot_resource_grants.revision + 1`,
        }).where("bot_resource_grants.grant_id", "=", input.previous.grant_id)
          .where((eb) => eb.or([
            eb("bot_resource_grants.revoked_at", "is not", null),
            eb("bot_resource_grants.chat_id", "!=", binding.chatId),
            eb("bot_resource_grants.binding_created_at", "!=", binding.bindingCreatedAt),
          ]));
      }).returningAll().executeTakeFirst();
    },
    revoke(id: string, revision: number, now: string) {
      return db.updateTable("bot_resource_grants")
        .set({ revoked_at: now, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", binding.ownerId).where("bot_id", "=", binding.agentId)
        .where("grant_id", "=", id).where("revision", "=", revision)
        .where("revoked_at", "is", null).returning("revision").executeTakeFirst();
    },
  };
}
