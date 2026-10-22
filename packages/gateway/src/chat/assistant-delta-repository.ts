/** Streaming assistant writes extracted before adding optional Google-copy composition. */
import { CanonicalChatIdSchema, CanonicalChatMessagePartSchema, CanonicalChatMessageSchema, CanonicalOwnerScopeSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatsTable } from "./database.js";
import { storeAssistantCredentialSidecars } from "./credential-repository.js";
import { SealedAssistantCredentialSchema, type SealedAssistantCredential } from "./assistant-credential-crypto.js";
import { ChatConflictError, ChatNotFoundError, ChatRunNotActiveError } from "./errors.js";
import { jsonb, messageAttribution, messageSearchText, toMessage, type ChatOwner, type ChatOutboxEventType } from "./records.js";
export type AssistantDeltaExecutor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
import type { ChatCommitReleaseCheck } from "./outbox-delivery.js";
export type AssistantDeltaTransact = <T>(work: (tx: AssistantDeltaExecutor) => Promise<T>, beforeRelease?: ChatCommitReleaseCheck) => Promise<T>;
export interface AssistantDeltaWriteKey { owner: ChatOwner; chatId: string; runId: string; messageId: string }
export interface AssistantDeltaWriteHook {
  write<T>(key: AssistantDeltaWriteKey, transact: AssistantDeltaTransact,
    content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
interface AssistantDeltaDependencies {
  hook?: AssistantDeltaWriteHook;
  transact: AssistantDeltaTransact;
  selectOwnedChat(tx: AssistantDeltaExecutor, owner: ChatOwner, chatId: string, lock?: boolean): Promise<Selectable<ChatsTable> | undefined>;
  appendOutbox(tx: AssistantDeltaExecutor, owner: ChatOwner, chatId: string, revision: number, event: ChatOutboxEventType, payload?: Record<string, unknown>): Promise<void>;
}
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;
const encoded = new TextEncoder();
const validateOwner = (owner: ChatOwner) => CanonicalOwnerScopeSchema.parse(owner);
const requireSafeRef = (value: string) => z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(value);
const preview = (message: CanonicalChatMessage) => message.parts.find(part => part.type === "text")?.text.slice(0, 280) ?? null;

export type AssistantDeltaInput = {
    chatId: string;
    runId: string;
    messageId: string;
    delta: string;
    createdAt: string;
    /** Full backing text, merged by prefix under the same Run/message locks. */
    snapshot?: boolean;
    credentials?: readonly SealedAssistantCredential[];
  };

function recoveredTextParts(text: string) {
  if (Buffer.byteLength(text) > 96 * 1024) throw new RangeError("Recovered output limit exceeded");
  return (text.match(/[\s\S]{1,4000}/gu) ?? [""]).map((chunk) =>
    CanonicalChatMessagePartSchema.parse({ type: "text", text: chunk }));
}

export async function appendAssistantDelta(deps: AssistantDeltaDependencies, ownerInput: ChatOwner, input: AssistantDeltaInput, signal?: AbortSignal): Promise<CanonicalChatMessage> {
  const owner = validateOwner(ownerInput);
  const parsedCredentials = deps.hook && input.credentials ? z.array(SealedAssistantCredentialSchema).max(16).safeParse(input.credentials) : undefined;
  input = Object.freeze({ ...input, ...(deps.hook ? { credentials: parsedCredentials?.success ? parsedCredentials.data : undefined } : {}) });
  const chatId = CanonicalChatIdSchema.parse(input.chatId);
  [input.runId, input.messageId].forEach(requireSafeRef);
  const createdAt = new Date(input.createdAt).toISOString();
  const content = async (trx: AssistantDeltaExecutor) => {
    let delta = input.delta;
    const chat = await deps.selectOwnedChat(trx, owner, chatId, true);
    if (!chat) throw new ChatNotFoundError(chatId);
    const run = await trx.selectFrom("chat_runs").selectAll()
      .where("id", "=", input.runId)
      .where("chat_id", "=", chatId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw new ChatNotFoundError(chatId);
    if (!ACTIVE_RUNS.includes(run.status as typeof ACTIVE_RUNS[number])) {
      throw new ChatRunNotActiveError(chatId, input.runId);
    }
    const existing = await trx.selectFrom("chat_messages").selectAll()
      .where("id", "=", input.messageId)
      .forUpdate()
      .executeTakeFirst();
    let next: CanonicalChatMessage;
    let inserted = false;
    let baseOffset = 0;
    if (existing) {
      const current = toMessage(existing);
      const textParts = current.parts.every((part) => part.type === "text")
        ? current.parts
        : undefined;
      if (current.chatId !== chatId || current.runId !== input.runId
        || current.turnId !== run.turn_id || current.role !== "assistant"
        || current.state !== "pending" || !textParts?.length) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      const last = textParts.at(-1)!;
      baseOffset = textParts.map((part) => part.text.length).reduce((sum, length) => sum + length, 0);
      if (input.snapshot) {
        const persisted = textParts.map((part) => part.text).join("");
        if (!input.delta.startsWith(persisted)) throw new ChatConflictError(chatId, Number(chat.revision));
        delta = input.delta.slice(persisted.length);
        if (delta.length === 0) return current;
      }
      const combined = CanonicalChatMessagePartSchema.safeParse({
        type: "text",
        text: `${last.text}${delta}`,
      });
      const parts = input.snapshot ? recoveredTextParts(input.delta) : combined.success
        ? [...textParts.slice(0, -1), combined.data]
        : [...textParts, CanonicalChatMessagePartSchema.parse({ type: "text", text: delta })];
      next = CanonicalChatMessageSchema.parse({
        ...current,
        parts,
      });
      await trx.updateTable("chat_messages").set({
        parts: jsonb(next.parts),
        byte_count: encoded.encode(JSON.stringify(next)).byteLength,
        search_text: messageSearchText(next),
      }).where("id", "=", next.id).execute();
    } else {
      const latest = await trx.selectFrom("chat_messages")
        .select(({ fn }) => fn.max("seq").as("seq"))
        .where("chat_id", "=", chatId)
        .executeTakeFirst();
      const seq = Number(latest?.seq ?? 0) + 1;
      next = CanonicalChatMessageSchema.parse({
        id: input.messageId,
        chatId,
        seq,
        role: "assistant",
        purpose: "assistant",
        state: "pending",
        turnId: run.turn_id,
        runId: input.runId,
        parts: input.snapshot ? recoveredTextParts(input.delta) : [{ type: "text", text: input.delta }],
        createdAt,
      });
      await trx.insertInto("chat_messages").values({
        id: next.id,
        chat_id: next.chatId,
        seq: next.seq,
        role: next.role,
        state: next.state,
        turn_id: next.turnId ?? null,
        run_id: next.runId ?? null,
        parts: jsonb(next.parts),
        byte_count: encoded.encode(JSON.stringify(next)).byteLength,
        search_text: messageSearchText(next),
        ...messageAttribution(next),
        created_at: next.createdAt,
      }).execute();
      inserted = true;
    }
    if (!input.snapshot) {
      await storeAssistantCredentialSidecars(trx, {
        owner, chatId, runId: input.runId, messageId: input.messageId,
        delta, baseOffset, credentials: input.credentials,
        createdAt, privateChat: chat.collaboration === null,
      });
    }
    const revision = Number(chat.revision) + 1;
    await trx.updateTable("chats").set({
      revision,
      ...(inserted ? { message_count: sql<number>`message_count + 1` } : {}),
      last_message_preview: preview(next),
      updated_at: createdAt,
    }).where("id", "=", chatId).execute();
    await deps.appendOutbox(trx, owner, chatId, revision, "run.message", {
      runId: input.runId,
      messageId: input.messageId,
      // Recovery can replace part boundaries; use the existing invalidation
      // fallback rather than pretending it is a single-part live delta.
      ...(input.snapshot ? {} : { messageDelta: {
        message: { ...next, parts: [{ type: "text", text: delta }] },
        partIndex: next.parts.length - 1,
        offset: (next.parts.at(-1) as { text: string }).text.length - delta.length,
      } }),
    });
    return next;
  };
  return deps.hook ? deps.hook.write({ owner, chatId, runId: input.runId, messageId: input.messageId }, deps.transact, content, signal)
    : deps.transact(content);
}
