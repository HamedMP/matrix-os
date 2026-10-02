import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatMessagePartSchema } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type { ChatOwner } from "./records.js";
import {
  assistantCredentialOccurrenceId,
  openAssistantCredential,
  SealedAssistantCredentialSchema,
  type SealedAssistantCredential,
} from "./assistant-credential-crypto.js";

const MAX_PER_MESSAGE = 16;
const MAX_PER_CHAT = 1_024;
const MAX_MESSAGE_IDS = 64;
const PLACEHOLDERS = ["[redacted credential]", "[redacted]"] as const;
const SafeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const OccurrenceId = z.string().regex(/^cred_[a-f0-9]{32}$/);

export interface CredentialMetadata {
  id: string;
  messageId: string;
  offset: number;
  length: number;
  revealed: boolean;
}

/** A single safe error for every missing, unauthorized, stale, or corrupt value. */
export class ChatCredentialUnavailableError extends Error {
  constructor() { super("Credential unavailable"); }
}

/** Called inside the same locked transaction that appends masked assistant text. */
export async function storeAssistantCredentialSidecars(
  trx: Transaction<ChatDatabase> | Kysely<ChatDatabase>,
  input: {
    owner: ChatOwner;
    chatId: string;
    runId: string;
    messageId: string;
    delta: string;
    baseOffset: number;
    credentials?: readonly SealedAssistantCredential[];
    createdAt: string;
    privateChat: boolean;
  },
): Promise<void> {
  if (!input.credentials?.length || !input.privateChat || input.owner.type !== "personal") return;
  if (input.credentials.length > MAX_PER_MESSAGE) return;
  const parsed = z.array(SealedAssistantCredentialSchema).max(MAX_PER_MESSAGE).safeParse(input.credentials);
  if (!parsed.success) return;
  let perMessage = Number((await trx.selectFrom("chat_credentials").select(({ fn }) => fn.count("id").as("count"))
    .where("message_id", "=", input.messageId).executeTakeFirst())?.count ?? 0);
  let perChat = Number((await trx.selectFrom("chat_credentials").select(({ fn }) => fn.count("id").as("count"))
    .where("chat_id", "=", input.chatId).executeTakeFirst())?.count ?? 0);
  for (const item of parsed.data) {
    const absoluteOffset = input.baseOffset + item.offset;
    const placeholder = PLACEHOLDERS.find((candidate) => candidate.length === item.length);
    if (!placeholder || input.delta.slice(item.offset, item.offset + item.length) !== placeholder
      || item.occurrenceId !== assistantCredentialOccurrenceId(input.messageId, absoluteOffset)) continue;
    const existing = await trx.selectFrom("chat_credentials")
      .select(["id", "chat_id", "message_id", "run_id", "owner_id", "safe_offset", "placeholder_length"])
      .where("id", "=", item.occurrenceId).executeTakeFirst();
    if (existing) {
      if (existing.chat_id !== input.chatId || existing.message_id !== input.messageId
        || existing.run_id !== input.runId || existing.owner_id !== input.owner.ownerId
        || existing.safe_offset !== absoluteOffset || existing.placeholder_length !== item.length) {
        throw new ChatCredentialUnavailableError();
      }
      continue;
    }
    if (perMessage >= MAX_PER_MESSAGE || perChat >= MAX_PER_CHAT) continue;
    await trx.insertInto("chat_credentials").values({
      id: item.occurrenceId,
      chat_id: input.chatId,
      message_id: input.messageId,
      run_id: input.runId,
      owner_id: input.owner.ownerId,
      safe_offset: absoluteOffset,
      placeholder_length: item.length,
      envelope: JSON.stringify(item.envelope),
      created_at: input.createdAt,
    }).onConflict((conflict) => conflict.column("id").doNothing()).execute();
    perMessage += 1;
    perChat += 1;
  }
}

function messageText(parts: unknown): string | null {
  const parsed = z.array(CanonicalChatMessagePartSchema).safeParse(parts);
  return parsed.success
    ? parsed.data.filter((part) => part.type === "text").map((part) => part.text).join("")
    : null;
}

function matchesPlaceholder(text: string | null, offset: number, length: number): boolean {
  return text !== null && PLACEHOLDERS.some((placeholder) =>
    placeholder.length === length && text.slice(offset, offset + length) === placeholder);
}

export class ChatCredentialRepository {
  constructor(
    private readonly db: Kysely<ChatDatabase>,
    private readonly key: Buffer | undefined,
    private readonly runtimeOwnerIds: readonly string[],
  ) {}

  private async privateOwner<T>(owner: ChatOwner, chatId: string, fn: (trx: Transaction<ChatDatabase>) => Promise<T>): Promise<T> {
    SafeRef.parse(chatId);
    if (!this.key || this.key.length !== 32 || owner.type !== "personal" || !this.runtimeOwnerIds.includes(owner.ownerId)) {
      throw new ChatCredentialUnavailableError();
    }
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const chat = await trx.selectFrom("chats").select("id")
        .where("id", "=", chatId).where("owner_type", "=", "personal")
        .where("owner_id", "=", owner.ownerId).where("collaboration", "is", null)
        .forUpdate().executeTakeFirst();
      if (!chat) throw new ChatCredentialUnavailableError();
      // Whole-project publication shares an inherited Chat through its scope
      // without writing chats.collaboration. Read that authority after taking
      // the Chat lock also used by project publication, so a concurrent share
      // cannot leave a credential read authorized after it commits.
      const sharedScope = await (trx as unknown as Transaction<OwnerCollaborationDatabase>)
        .selectFrom("collaboration_scopes").select("id")
        .where("owner_type", "=", "personal").where("owner_id", "=", owner.ownerId)
        .where("kind", "=", "chat").where("resource_id", "=", chatId)
        // Archive, transfer and deletion do not make a previously shared
        // transcript private again. Only a never-published scope can pass.
        .where("lifecycle", "not in", ["private", "preparing"])
        .executeTakeFirst();
      if (sharedScope) throw new ChatCredentialUnavailableError();
      return fn(trx);
    });
  }

  async list(owner: ChatOwner, chatId: string, messageIds: readonly string[]): Promise<CredentialMetadata[]> {
    if (!messageIds.length || messageIds.length > MAX_MESSAGE_IDS || messageIds.some((id) => !SafeRef.safeParse(id).success)) {
      throw new ChatCredentialUnavailableError();
    }
    return this.privateOwner(owner, chatId, async (trx) => {
      const rows = await trx.selectFrom("chat_credentials as credential")
        .innerJoin("chat_messages as message", "message.id", "credential.message_id")
        .select(["credential.id", "credential.message_id", "credential.safe_offset", "credential.placeholder_length",
          "credential.revealed", "message.parts"])
        .where("credential.chat_id", "=", chatId).where("credential.owner_id", "=", owner.ownerId)
        .where("credential.message_id", "in", [...new Set(messageIds)]).limit(MAX_MESSAGE_IDS * MAX_PER_MESSAGE).execute();
      return rows.filter((row) => matchesPlaceholder(messageText(row.parts), row.safe_offset, row.placeholder_length))
        .map((row) => ({ id: row.id, messageId: row.message_id, offset: row.safe_offset,
          length: row.placeholder_length, revealed: row.revealed }));
    });
  }

  private async one(owner: ChatOwner, chatId: string, occurrenceId: string, action: "reveal" | "hide" | "value") {
    OccurrenceId.parse(occurrenceId);
    return this.privateOwner(owner, chatId, async (trx) => {
      const row = await trx.selectFrom("chat_credentials as credential")
        .innerJoin("chat_messages as message", "message.id", "credential.message_id")
        .select(["credential.id", "credential.chat_id", "credential.message_id", "credential.run_id", "credential.owner_id",
          "credential.safe_offset", "credential.placeholder_length", "credential.envelope", "credential.revealed", "message.parts"])
        .where("credential.id", "=", occurrenceId).where("credential.chat_id", "=", chatId)
        .where("credential.owner_id", "=", owner.ownerId).executeTakeFirst();
      if (!row || !matchesPlaceholder(messageText(row.parts), row.safe_offset, row.placeholder_length)
        || (action === "value" && !row.revealed)) throw new ChatCredentialUnavailableError();
      if (action === "hide") {
        await trx.updateTable("chat_credentials").set({ revealed: false }).where("id", "=", occurrenceId).execute();
        return { id: occurrenceId, revealed: false as const };
      }
      let value: string;
      try {
        value = openAssistantCredential(this.key!, { ownerId: owner.ownerId, chatId, runId: row.run_id,
          messageId: row.message_id, occurrenceId }, row.envelope);
      } catch (error: unknown) {
        const errorKind = error instanceof Error ? error.name : typeof error;
        console.warn(`[chat-credential] unable to open captured value (${errorKind})`);
        throw new ChatCredentialUnavailableError();
      }
      if (action === "reveal" && !row.revealed) {
        await trx.updateTable("chat_credentials").set({ revealed: true }).where("id", "=", occurrenceId).execute();
      }
      return { id: occurrenceId, value, revealed: true as const };
    });
  }

  reveal(owner: ChatOwner, chatId: string, occurrenceId: string) { return this.one(owner, chatId, occurrenceId, "reveal"); }
  hide(owner: ChatOwner, chatId: string, occurrenceId: string) { return this.one(owner, chatId, occurrenceId, "hide"); }
  value(owner: ChatOwner, chatId: string, occurrenceId: string) { return this.one(owner, chatId, occurrenceId, "value"); }
}
