import { acceptedRoutineOriginTarget, beginOriginTransaction, hasAcceptedBinding } from "../bots/routine-chat-origin-target.js";
import { directRoutineOriginLiveSql, isCurrentDirectRoutineOrigin } from "../bots/routine-direct-chat-lifecycle.js";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { BOT_OUTPUT_MAX_SEGMENTS, CanonicalChatMessageSchema, RoutineChatReceiptPartSchema, canonicalAssistantContinuationId, canonicalAssistantOutputMessages, canonicalAssistantOutputRootId, type CanonicalChatMessage, type CanonicalChatMessagePart, type RoutineChatReceiptPart } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { ChatDatabase } from "./database.js";
import { RoutineCliSourceContextSchema } from "../bots/routine-cli-source-context.js";
import { BotStateError } from "../bots/repositories/shared.js";
import { asIso, jsonb, messageSearchText, parseJson, toMessage, type ChatOwner } from "./records.js";
import { hasNonPrivateChatScope } from "./private-routine-authority.js";
import { redactAssistantParts } from "./safe-activity-projection.js";
export interface AppendRoutineReceiptInput {
  sourceChatId: string; computerId: string; fireId: string; kind: "status" | "output"; now: string;
}
type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type AppendOutbox = (executor: Executor, owner: ChatOwner, revision: number, message: CanonicalChatMessage) => Promise<void>;
const statusText = (status: RoutineChatReceiptPart["status"]) => ({
  completed: "Scheduled task output is unavailable.", failed: "Scheduled task failed. Review its execution history.",
  cancelled: "Scheduled task was cancelled. Stopping execution is unconfirmed.",
  unknown: "Scheduled task outcome is unknown. Review its execution history before running it again.",
  missed: "Scheduled task occurrence was missed.", skipped: "Scheduled task occurrence was skipped.",
})[status];
/** Appends only from committed canonical rows. No source turn/Run/selection/checkpoint writes. */
export async function appendRoutineReceiptWithin(executor: Executor, ownerId: string, input: AppendRoutineReceiptInput, appendOutbox: AppendOutbox): Promise<CanonicalChatMessage | null> {
  if (!executor.isTransaction) throw new BotStateError("invalid_input");
  const db = executor as unknown as Transaction<OwnerBotDatabase>;
  await beginOriginTransaction(db, ownerId);
  const sourceChat = await db.selectFrom("chats").selectAll().where("id", "=", input.sourceChatId)
    .where("owner_type", "=", "personal").where("owner_id", "=", ownerId).where("lifecycle", "=", "active")
    .where("collaboration", "is", null).forNoKeyUpdate().executeTakeFirst();
  if (!sourceChat || await hasNonPrivateChatScope(executor, { type: "personal", ownerId }, input.sourceChatId)) return null;
  const record = await db.selectFrom("bot_routine_fires as fire")
    .innerJoin("bot_routines as routine", join => join.onRef("routine.owner_id", "=", "fire.owner_id").onRef("routine.routine_id", "=", "fire.routine_id"))
    .innerJoin("routine_cli_requests as receipt", join => join.onRef("receipt.owner_id", "=", "routine.owner_id")
      .onRef("receipt.computer_id", "=", "routine.origin_computer_id").onRef("receipt.client_request_id", "=", "routine.origin_request_id"))
    .selectAll("fire").select(["routine.chat_id", "routine.bot_id", "routine.proposal", "receipt.source_context", "receipt.target_snapshot", "receipt.client_request_id"])
    .where("fire.owner_id", "=", ownerId).where("fire.fire_id", "=", input.fireId).where("routine.origin_computer_id", "=", input.computerId)
    .where("fire.status", "in", ["completed", "failed", "cancelled", "uncertain"])
    .where(directRoutineOriginLiveSql({ ownerId: sql.ref("routine.owner_id"), botId: sql.ref("routine.bot_id"), chatId: sql.ref("routine.chat_id"),
      computerId: sql.ref("routine.origin_computer_id"), requestId: sql.ref("routine.origin_request_id") }))
    .executeTakeFirst();
  if (!record || record.chat_id === input.sourceChatId) return null;
  const context = RoutineCliSourceContextSchema.safeParse(parseJson(record.source_context));
  if (!context.success || context.data.ownerId !== ownerId || context.data.computerId !== input.computerId
    || context.data.identity.kind !== "chat_run" || context.data.identity.chatId !== input.sourceChatId) return null;
  // Read locks fence canonical privacy changes through append commit. Only source Chat is written.
  const target = acceptedRoutineOriginTarget(record.target_snapshot, ownerId, input.computerId, record.bot_id, record.chat_id, input.sourceChatId);
  if (!target) return null;
  const bound = "purpose" in target ? await isCurrentDirectRoutineOrigin(db, {
    ownerId, computerId: input.computerId, requestId: record.client_request_id, sourceChatId: input.sourceChatId,
    sourceRunId: context.data.identity.runId, canonicalChatId: record.chat_id, botId: record.bot_id, bindingCreatedAt: target.bindingCreatedAt, directChat: true,
  }, "ordered") : await hasAcceptedBinding(db, ownerId, record.chat_id, record.bot_id, target.bindingCreatedAt);
  if (!bound) return null;
  const sourceRun = await db.selectFrom("chat_runs").select("id").where("id", "=", context.data.identity.runId).where("chat_id", "=", input.sourceChatId).executeTakeFirst();
  if (!sourceRun) return null;
  const existing = await db.selectFrom("routine_chat_deliveries").select("message_id").where("owner_id", "=", ownerId)
    .where("source_chat_id", "=", input.sourceChatId).where("routine_id", "=", record.routine_id).where("fire_id", "=", record.fire_id)
    .where("attempt", "=", record.attempts).where("kind", "=", input.kind).executeTakeFirst();
  if (existing) return null;
  const task = await db.selectFrom("bot_tasks").select("run_id").where("task_id", "=", record.task_id).where("owner_id", "=", ownerId)
    .where("bot_id", "=", record.bot_id).where("chat_id", "=", record.chat_id).executeTakeFirst();
  let output: { id: string; run_id: string | null; parts: CanonicalChatMessagePart[] } | undefined;
  if (input.kind === "output" && task?.run_id) {
    const committed = db.selectFrom("chat_messages as message").innerJoin("chat_runs as run", join => join.onRef("run.id", "=", "message.run_id").onRef("run.chat_id", "=", "message.chat_id"))
      .selectAll("message").where("run.id", "=", task.run_id).where("run.chat_id", "=", record.chat_id)
      .where("run.status", "in", ["completed", "failed", "aborted"]).where("message.role", "=", "assistant").where("message.state", "=", "committed");
    const latest = await committed.orderBy("message.seq", "desc").limit(1).executeTakeFirst();
    if (latest) {
      let parts = parseJson<CanonicalChatMessagePart[]>(latest.parts);
      const rootId = canonicalAssistantOutputRootId(latest.id);
      if (rootId !== latest.id && latest.turn_id) {
        // Match only the same bounded continuation group, then redact its joined text.
        const ids = [rootId, ...Array.from({ length: BOT_OUTPUT_MAX_SEGMENTS - 1 }, (_, index) => canonicalAssistantContinuationId(rootId, index + 1))];
        const previous = await committed.where("message.turn_id", "=", latest.turn_id).where("message.seq", "<", latest.seq)
          .where("message.id", "in", ids).execute();
        parts = canonicalAssistantOutputMessages([...previous, latest].map(toMessage)).at(-1)!.parts;
      }
      output = { id: latest.id, run_id: latest.run_id, parts };
    }
  }
  if (input.kind === "output" && !output || input.kind === "status" && record.status === "completed") return null;
  const status = record.status === "uncertain" ? "unknown" : record.status as RoutineChatReceiptPart["status"];
  const proposal = parseJson<{ selection: { model: string } }>(record.proposal);
  const receipt = RoutineChatReceiptPartSchema.parse({ type: "routine_receipt", engine: "matrix", kind: input.kind,
    routineId: record.routine_id, fireId: record.fire_id, attempt: record.attempts, status,
    scheduledFor: asIso(record.scheduled_for), canonicalChatId: record.chat_id, canonicalTaskId: record.task_id,
    ...(output ? { canonicalRunId: output.run_id, canonicalMessageId: output.id } : {}),
    ...(status === "cancelled" ? { stop: "unconfirmed" } : {}), model: proposal.selection.model });
  const original = output ? redactAssistantParts(output.parts).filter(part => part.type === "text").map(part => part.text).join("\n") : statusText(status);
  const text = original.slice(0, 24_000).trim();
  if (input.kind === "output" && !text) return null;
  const latest = await db.selectFrom("chat_messages").select(eb => eb.fn.max<number>("seq").as("seq")).where("chat_id", "=", input.sourceChatId).executeTakeFirst();
  const message = CanonicalChatMessageSchema.parse({ id: `msg_${randomUUID().replaceAll("-", "")}`, chatId: input.sourceChatId,
    seq: Number(latest?.seq ?? 0) + 1, role: "system", state: "committed", purpose: "system", parts: [receipt, { type: "text", text: text || statusText(status) }], createdAt: input.now });
  await db.insertInto("chat_messages").values({ id: message.id, chat_id: message.chatId, seq: message.seq, role: "system", purpose: "system", state: "committed",
    actor_id: null, run_id: null, turn_id: null, parts: jsonb(message.parts), byte_count: Buffer.byteLength(JSON.stringify(message)), search_text: messageSearchText(message), created_at: message.createdAt }).execute();
  const claimed = await db.insertInto("routine_chat_deliveries").values({ owner_id: ownerId, source_chat_id: input.sourceChatId,
    routine_id: record.routine_id, fire_id: record.fire_id, attempt: record.attempts, kind: input.kind, message_id: message.id, receipt, created_at: input.now })
    .onConflict(conflict => conflict.columns(["owner_id", "source_chat_id", "routine_id", "fire_id", "attempt", "kind"]).doNothing()).returning("message_id").executeTakeFirst();
  if (!claimed) throw new BotStateError("conflict"); // Roll back message/seq too; never leave an orphan append.
  const revision = Number(sourceChat.revision) + 1;
  await db.updateTable("chats").set({ revision, message_count: sql<number>`message_count+1`, last_message_preview: text.slice(0,280),
    activity_at: input.now, updated_at: input.now }).where("id", "=", input.sourceChatId).execute();
  await appendOutbox(executor, { type: "personal", ownerId }, revision, message);
  return message;
}
