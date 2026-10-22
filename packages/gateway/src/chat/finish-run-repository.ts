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
export async function finishRun(deps: AssistantDeltaDependencies, ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    outcome: "completed" | "failed" | "aborted";
    sharedRequestState?: "interrupted" | "unauthorized" | "unavailable" | "cancelled";
    completedAt: string;
    diagnostic?: ChatRunFailureDiagnostic;
    output?: CanonicalChatMessage;
  }, signal?: AbortSignal): Promise<{ run: CanonicalChatRun; transitioned: boolean }> {
    const owner = validateOwner(ownerInput);
    const completedAt = new Date(input.completedAt).toISOString();
    const output = input.output === undefined ? undefined : CanonicalChatMessageSchema.parse(input.output);
    input = Object.freeze({ ...input, output, ...(deps.hook && input.diagnostic ? { diagnostic: ChatRunFailureDiagnosticSchema.parse(input.diagnostic) } : {}) });
    const content = async (trx: AssistantDeltaExecutor) => {
      const chat = await deps.selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(input.chatId), true);
      if (!chat) throw new ChatNotFoundError(input.chatId);
      const current = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).forUpdate().executeTakeFirst();
      if (!current) throw new ChatNotFoundError(input.chatId);
      if (!ACTIVE_RUNS.includes(current.status as typeof ACTIVE_RUNS[number])) {
        return { run: toRun(current), transitioned: false };
      }
      const expectedState = input.outcome === "completed" ? "committed" : "failed";
      const pendingRows = await trx.selectFrom("chat_messages").selectAll()
        .where("chat_id", "=", input.chatId)
        .where("run_id", "=", input.runId)
        .where("role", "=", "assistant")
        .orderBy("seq")
        .forUpdate()
        .execute();
      let finalizedOutput: CanonicalChatMessage | undefined;
      let insertedOutput = false;
      if (pendingRows.length > 0) {
        const pendingMessages = pendingRows.map(toMessage);
        if (pendingMessages.some((pending) => pending.state !== "pending")) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        if (output !== undefined && !pendingMessages.some((pending) => (
          output.id === pending.id && output.seq === pending.seq
        ))) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        for (const pending of pendingMessages) {
          const finalized = CanonicalChatMessageSchema.parse({
            ...(output?.id === pending.id ? output : pending),
            state: expectedState,
          });
          await trx.updateTable("chat_messages").set({
            state: expectedState,
            parts: jsonb(finalized.parts),
            byte_count: encoded.encode(JSON.stringify(finalized)).byteLength,
            search_text: messageSearchText(finalized),
          }).where("id", "=", pending.id).execute();
          finalizedOutput = finalized;
        }
      } else if (output !== undefined) {
        if (output.chatId !== input.chatId || output.runId !== input.runId
          || output.turnId !== current.turn_id || output.role !== "assistant"
          || output.state !== expectedState) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        const latest = await trx.selectFrom("chat_messages")
          .select(({ fn }) => fn.max("seq").as("seq"))
          .where("chat_id", "=", input.chatId)
          .executeTakeFirst();
        if (output.seq !== Number(latest?.seq ?? 0) + 1) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        await trx.insertInto("chat_messages").values({
          id: output.id,
          chat_id: output.chatId,
          seq: output.seq,
          role: output.role,
          state: output.state,
          turn_id: output.turnId ?? null,
          run_id: output.runId ?? null,
          parts: jsonb(output.parts),
          byte_count: encoded.encode(JSON.stringify(output)).byteLength,
          search_text: messageSearchText(output),
          ...messageAttribution(output),
          created_at: output.createdAt,
        }).execute();
        finalizedOutput = output;
        insertedOutput = true;
      }
      const updated = await trx.updateTable("chat_runs").set({
        status: input.outcome,
        outcome: input.outcome,
        started_at: current.started_at ?? completedAt,
        completed_at: completedAt,
        updated_at: completedAt,
      }).where("id", "=", input.runId).where("status", "in", [...ACTIVE_RUNS])
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatBusyError(input.chatId);
      if (input.sharedRequestState) {
        const sharedRequest = await trx.updateTable("chat_queued_turns").set({
          status: input.sharedRequestState,
          updated_at: completedAt,
        }).where("chat_id", "=", input.chatId)
          .where("claimed_run_id", "=", input.runId)
          .where("collaboration_scope_id", "is not", null)
          .where("status", "=", "claimed")
          .returning("id")
          .executeTakeFirst();
        if (!sharedRequest) throw new ChatConflictError(input.chatId, Number(chat.revision));
      }
      await trx.updateTable("chat_turns").set({ status: input.outcome, updated_at: completedAt })
        .where("id", "=", updated.turn_id).execute();
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        ...(finalizedOutput === undefined ? {} : {
          ...(insertedOutput ? { message_count: sql<number>`message_count + 1` } : {}),
          last_message_preview: preview(finalizedOutput),
        }),
        attention: input.outcome === "failed" ? "failed" : "none",
        updated_at: completedAt,
      }).where("id", "=", input.chatId).execute();
      await deps.appendOutbox(trx, owner, input.chatId, revision, `run.${input.outcome}` as ChatOutboxEventType, {
        runId: input.runId,
        ...(input.outcome === "failed" && input.diagnostic
          ? { failureDiagnostic: ChatRunFailureDiagnosticSchema.parse(input.diagnostic) } : {}),
      });
      return { run: toRun(updated), transitioned: true };
    };
  return deps.hook ? deps.hook.writeRun({ owner, chatId: input.chatId, runId: input.runId, ...(output ? { outputMessageId: output.id } : {}) }, deps.transact, content, signal) : deps.transact(content);
}
