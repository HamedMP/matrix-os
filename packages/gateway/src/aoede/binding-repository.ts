import type { Kysely } from "kysely";
import type { ChatOwner } from "../chat/records.js";
import { ChatRepository } from "../chat/repository.js";
import type { AoedeDatabase } from "./binding-schema.js";

export interface AoedeBindingKey {
  owner: ChatOwner;
  runtimeScope: string;
  projectScope: string;
}

/** Borrowed shared owner Kysely; this pointer repository never destroys it. */
export class AoedeBindingRepository {
  private readonly db: Kysely<AoedeDatabase>;
  constructor(readonly chats: ChatRepository) {
    this.db = chats.kysely as unknown as Kysely<AoedeDatabase>;
  }

  withTransaction<T>(fn: (repository: AoedeBindingRepository) => Promise<T>): Promise<T> {
    return this.chats.withTransaction((chats) => fn(new AoedeBindingRepository(chats)));
  }

  getBinding(key: AoedeBindingKey) {
    return this.bindingQuery(key).executeTakeFirst();
  }

  getRequest(key: AoedeBindingKey, requestId: string) {
    return this.db.selectFrom("aoede_bootstrap_requests").selectAll()
      .where("owner_type", "=", key.owner.type).where("owner_id", "=", key.owner.ownerId)
      .where("runtime_scope", "=", key.runtimeScope).where("request_id", "=", requestId)
      .executeTakeFirst();
  }

  /** Called only inside withTransaction. ON CONFLICT waits before FOR UPDATE. */
  async lockBinding(key: AoedeBindingKey) {
    const inserted = await this.db.insertInto("aoede_bindings").values({
      owner_type: key.owner.type, owner_id: key.owner.ownerId,
      runtime_scope: key.runtimeScope, project_scope: key.projectScope, chat_id: null,
    }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "runtime_scope", "project_scope"]).doNothing())
      .returningAll().executeTakeFirst();
    const binding = await this.bindingQuery(key).forUpdate().executeTakeFirstOrThrow();
    return { binding, firstBinding: inserted !== undefined };
  }

  async bind(key: AoedeBindingKey, chatId: string): Promise<void> {
    await this.db.updateTable("aoede_bindings").set({ chat_id: chatId })
      .where("owner_type", "=", key.owner.type).where("owner_id", "=", key.owner.ownerId)
      .where("runtime_scope", "=", key.runtimeScope).where("project_scope", "=", key.projectScope)
      .executeTakeFirstOrThrow();
  }

  /** Returns the elected row: cross-scope request races cannot evade deduplication. */
  async recordRequest(key: AoedeBindingKey, requestId: string, semanticHash: string, chatId: string) {
    await this.db.insertInto("aoede_bootstrap_requests").values({
      owner_type: key.owner.type, owner_id: key.owner.ownerId, runtime_scope: key.runtimeScope,
      request_id: requestId, semantic_hash: semanticHash, created_chat_id: chatId,
    }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "runtime_scope", "request_id"]).doNothing())
      .execute();
    return this.getRequest(key, requestId);
  }

  private bindingQuery(key: AoedeBindingKey) {
    return this.db.selectFrom("aoede_bindings").selectAll()
      .where("owner_type", "=", key.owner.type).where("owner_id", "=", key.owner.ownerId)
      .where("runtime_scope", "=", key.runtimeScope).where("project_scope", "=", key.projectScope);
  }
}
