import { CanonicalChatIdSchema, AgentAttachmentSchema, CanonicalChatMessagePartSchema, CanonicalChatMessageSchema, CanonicalOwnerScopeSchema, type CanonicalChatMessage, type CanonicalChatRun, type AgentAttachment } from "@matrix-os/contracts";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { AssistantDeltaDependencies, AssistantDeltaExecutor } from "./assistant-delta-repository.js";
import { ChatConflictError, ChatNotFoundError, ChatRunNotActiveError, ChatBusyError } from "./errors.js";
import { jsonb, messageAttribution, messageSearchText, toMessage, toRun, type ChatOwner, type ChatOutboxEventType } from "./records.js";
import { ChatRunFailureDiagnosticSchema, type ChatRunFailureDiagnostic } from "./failure-diagnostic.js";
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;
const encoded = new TextEncoder();
const validateOwner = (owner: ChatOwner) => CanonicalOwnerScopeSchema.parse(owner);
const requireSafeRef = (value: string) => z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(value);
const preview = (message: CanonicalChatMessage) => message.parts.find(part => part.type === "text")?.text.slice(0, 280) ?? null;
export async function appendAssistantAttachment(deps: AssistantDeltaDependencies, ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    messageId: string;
    attachment: AgentAttachment;
    createdAt: string;
  }, signal?: AbortSignal): Promise<CanonicalChatMessage> {
    const owner = validateOwner(ownerInput);
    input = Object.freeze({ ...input, attachment: AgentAttachmentSchema.parse(input.attachment) });
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    [input.runId, input.messageId].forEach(requireSafeRef);
    const attachment = AgentAttachmentSchema.parse(input.attachment);
    if (!attachment.path) throw new ChatConflictError(chatId, 0);
    const createdAt = new Date(input.createdAt).toISOString();
    const part = CanonicalChatMessagePartSchema.parse({
      type: "attachment_reference",
      attachmentId: attachment.id,
      kind: attachment.kind === "image" ? "image" : "file",
      label: attachment.label,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      ownerReference: attachment.path,
      resource: { kind: "home", path: attachment.path },
    });
    const content = async (trx: AssistantDeltaExecutor) => {
      const chat = await deps.selectOwnedChat(trx, owner, chatId, true);
      if (!chat) throw new ChatNotFoundError(chatId);
      const run = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", input.runId).where("chat_id", "=", chatId)
        .forUpdate().executeTakeFirst();
      if (!run) throw new ChatNotFoundError(chatId);
      if (!ACTIVE_RUNS.includes(run.status as typeof ACTIVE_RUNS[number])) {
        throw new ChatRunNotActiveError(chatId, input.runId);
      }
      const existing = await trx.selectFrom("chat_messages").selectAll()
        .where("id", "=", input.messageId).forUpdate().executeTakeFirst();
      let next: CanonicalChatMessage;
      let inserted = false;
      let replay = false;
      if (existing) {
        const current = toMessage(existing);
        if (current.chatId !== chatId || current.runId !== input.runId
          || current.turnId !== run.turn_id || current.role !== "assistant"
          || current.state !== "pending") {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        const duplicate = current.parts.find((candidate) =>
          candidate.type === "attachment_reference" && candidate.attachmentId === attachment.id);
        if (duplicate) {
          if (JSON.stringify(duplicate) !== JSON.stringify(part)) {
            throw new ChatConflictError(chatId, Number(chat.revision));
          }
          next = current;
          replay = true;
        } else {
          if (current.parts.filter((candidate) => candidate.type === "attachment_reference").length >= 8) {
            // Provider output may contain more media than a canonical message allows.
            // Keep the first eight; an extra artifact must not fail the agent run.
            return current;
          }
          next = CanonicalChatMessageSchema.parse({ ...current, parts: [...current.parts, part] });
          await trx.updateTable("chat_messages").set({
            parts: jsonb(next.parts),
            byte_count: encoded.encode(JSON.stringify(next)).byteLength,
            search_text: messageSearchText(next),
          }).where("id", "=", next.id).execute();
        }
      } else {
        const latest = await trx.selectFrom("chat_messages")
          .select(({ fn }) => fn.max("seq").as("seq"))
          .where("chat_id", "=", chatId).executeTakeFirst();
        next = CanonicalChatMessageSchema.parse({
          id: input.messageId,
          chatId,
          seq: Number(latest?.seq ?? 0) + 1,
          role: "assistant",
          purpose: "assistant",
          state: "pending",
          turnId: run.turn_id,
          runId: input.runId,
          parts: [part],
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
      await trx.insertInto("chat_attachments").values({
        id: attachment.id,
        chat_id: chatId,
        message_id: input.messageId,
        kind: attachment.kind === "image" ? "image" : "file",
        label: attachment.label,
        mime_type: attachment.mimeType ?? null,
        size_bytes: attachment.sizeBytes ?? null,
        owner_reference: attachment.path,
        created_at: createdAt,
      }).onConflict((conflict) => conflict.column("id").doNothing()).execute();
      const stored = await trx.selectFrom("chat_attachments").selectAll()
        .where("id", "=", attachment.id).executeTakeFirstOrThrow();
      if (stored.chat_id !== chatId || stored.message_id !== input.messageId
        || stored.owner_reference !== attachment.path || stored.label !== attachment.label) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      if (replay) return next;
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        ...(inserted ? { message_count: sql<number>`message_count + 1` } : {}),
        updated_at: createdAt,
      }).where("id", "=", chatId).execute();
      await deps.appendOutbox(trx, owner, chatId, revision, "run.message", {
        runId: input.runId,
        messageId: input.messageId,
      });
      return next;
    };
  return deps.hook ? deps.hook.write({ owner, chatId, runId: input.runId, messageId: input.messageId }, deps.transact, content, signal) : deps.transact(content);
}
