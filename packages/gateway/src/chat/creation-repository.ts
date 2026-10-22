/** Creation extracted before adding the optional private, transaction-bound classification hook. */
import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema, CanonicalChatModelSelectionSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import type { Kysely, Transaction, Selectable } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatsTable } from "./database.js";
import { ChatConflictError, ChatNotFoundError } from "./errors.js";
import { jsonb, toChatRecord, type ChatOwner, type ChatRecord, type ChatOutboxEventType } from "./records.js";
import type { CreateChatInput } from "./repository.js";
type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
export interface ServerChatInsertReceipt { readonly serverChatInsert: unique symbol }
export type ServerCreatedEmptyChatHook = (tx: Executor, owner: ChatOwner, chatId: string, receipt: ServerChatInsertReceipt) => Promise<void>;
// At most 64 active callback receipts; every receipt is invalidated on callback settlement.
const insertReceipts = new WeakMap<object, { tx: object; owner: ChatOwner; chatId: string; used: boolean }>();
let activeReceipts = 0;
/** Trusted verifier only; no caller can mint a receipt by constructing an object or JSON value. */
export function consumeServerChatInsertReceipt(receipt: ServerChatInsertReceipt, tx: object, owner: ChatOwner, chatId: string): boolean {
  const admission = insertReceipts.get(receipt);
  if (!admission || admission.used || admission.tx !== tx || admission.chatId !== chatId
    || admission.owner.type !== owner.type || admission.owner.ownerId !== owner.ownerId) return false;
  admission.used = true;
  return true;
}
async function onInserted(hook: ServerCreatedEmptyChatHook | undefined, tx: Executor, owner: ChatOwner, chatId: string) {
  if (!hook) return;
  if (activeReceipts >= 64) throw new Error("Chat creation unavailable");
  const receipt = Object.freeze({}) as ServerChatInsertReceipt;
  activeReceipts++;
  insertReceipts.set(receipt, { tx, owner: { ...owner }, chatId, used: false });
  try { await hook(tx, owner, chatId, receipt); }
  finally { insertReceipts.delete(receipt); activeReceipts--; }
}
export interface ChatCreationOptions { onServerCreatedEmptyChat?: ServerCreatedEmptyChatHook }
interface ChatCreationDependencies extends ChatCreationOptions {
  transact<T>(fn: (trx: Executor) => Promise<T>): Promise<T>;
  hydrateRecord(tx: Executor, owner: ChatOwner, chatId: string): Promise<ChatRecord | null>;
  toPrincipalRecord(tx: Executor, owner: ChatOwner, row: Selectable<ChatsTable>): Promise<ChatRecord>;
  appendOutbox(tx: Executor, owner: ChatOwner, chatId: string, revision: number, event: ChatOutboxEventType): Promise<void>;
}
const validateOwner = (value: ChatOwner) => CanonicalOwnerScopeSchema.parse(value);
const requireSafeRef = (value: string) => z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(value);

export async function createChat(deps: ChatCreationDependencies, ownerInput: ChatOwner, input: CreateChatInput): Promise<ChatRecord> {
  const owner = validateOwner(ownerInput);
  CanonicalChatIdSchema.parse(input.id);
  CanonicalChatRequestIdSchema.parse(input.clientRequestId);
  if (input.projectId !== undefined) requireSafeRef(input.projectId);
  if (input.currentSelection !== undefined) CanonicalChatModelSelectionSchema.parse(input.currentSelection);
  const timestamp = new Date().toISOString();

  return deps.transact(async (trx) => {
    const candidate = toChatRecord({
      id: input.id,
      owner_type: owner.type,
      owner_id: owner.ownerId,
      create_request_id: input.clientRequestId,
      project_id: input.projectId ?? null,
      title: input.title,
      title_version: 0,
      title_manual: false,
      activity_at: timestamp,
      lifecycle: "active",
      attention: "none",
      revision: 0,
      message_count: 0,
      collaboration: null,
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: input.currentSelection ?? null,
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    const inserted = await trx.insertInto("chats").values({
      id: candidate.chat.id,
      owner_type: owner.type,
      owner_id: owner.ownerId,
      create_request_id: input.clientRequestId,
      project_id: input.projectId ?? null,
      title: candidate.chat.title,
      title_manual: false,
      lifecycle: candidate.chat.lifecycle,
      attention: candidate.chat.attention,
      revision: 0,
      message_count: 0,
      collaboration: null,
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: input.currentSelection ? jsonb(input.currentSelection) : null,
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
    }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "create_request_id"]).doNothing())
      .returningAll().executeTakeFirst();

    if (!inserted) {
      const existing = await trx.selectFrom("chats").selectAll()
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .where("create_request_id", "=", input.clientRequestId)
        .executeTakeFirst();
      if (!existing) throw new ChatConflictError(input.id, 0);
      const record = await deps.hydrateRecord(trx, owner, existing.id);
      if (!record) throw new ChatNotFoundError(existing.id);
      return record;
    }

    await trx.insertInto("chat_members").values({
      chat_id: inserted.id,
      principal_type: owner.type === "organization" ? "organization" : "user",
      principal_id: owner.ownerId,
      role: "owner",
    }).execute();
    await trx.insertInto("chat_user_state").values({
      chat_id: inserted.id,
      principal_id: owner.ownerId,
      read_through_seq: 0,
      pinned: false,
      muted: false,
      attention_acknowledged_at: null,
      last_opened_at: null,
    }).execute();
    await onInserted(deps.onServerCreatedEmptyChat, trx, owner, inserted.id);
    await deps.appendOutbox(trx, owner, inserted.id, 0, "chat.created");
    return deps.toPrincipalRecord(trx, owner, inserted);
  });
}
