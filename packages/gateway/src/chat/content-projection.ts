import { CanonicalChatContentSchema, type CanonicalChatContent } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import { toActivities, toMessage, toRun, toTurn, type ChatOwner, type ChatOutboxEventType, type ChatRecord } from "./records.js";
import { toQueuedTurn } from "./queue-repository.js";

// Capture public changes under the mutation's transaction and Chat lock.
// Text/activity events never hydrate the entire transcript.
export async function captureChatContent(
  db: Kysely<ChatDatabase>, owner: ChatOwner, chatId: string,
  eventType: ChatOutboxEventType, payload: Record<string, unknown>,
  getRecord: (owner: ChatOwner, chatId: string) => Promise<ChatRecord | null>,
): Promise<CanonicalChatContent | undefined> {
  // Owner-local read/pin state does not advance Chat revision; keep its legacy refresh semantics.
  if (eventType === "chat.user_state_updated" || eventType === "chat.deleted") return undefined;
  const record = await getRecord(owner, chatId);
  if (!record) return undefined;
  if (eventType === "run.message") {
    if (!payload.messageDelta) return undefined;
    return CanonicalChatContentSchema.parse({ record, messageDelta: payload.messageDelta });
  }
  const runId = typeof payload.runId === "string" ? payload.runId : record.activeRun?.runId;
  const run = runId ? await db.selectFrom("chat_runs").selectAll()
    .where("chat_id", "=", chatId).where("id", "=", runId).executeTakeFirst() : undefined;
  const turn = run ? await db.selectFrom("chat_turns").selectAll()
    .where("chat_id", "=", chatId).where("id", "=", run.turn_id).executeTakeFirst() : undefined;
  const hot = eventType === "run.activity";
  const messages = !hot && run && turn ? await db.selectFrom("chat_messages").selectAll()
    .where("chat_id", "=", chatId)
    .where(({ eb, or }) => or([eb("run_id", "=", run.id), eb("id", "=", turn.input_message_id)]))
    .orderBy("seq", "desc").limit(200).execute() : [];
  const activityIds = Array.isArray(payload.activityIds)
    ? payload.activityIds.filter((id): id is string => typeof id === "string").slice(0, 100) : undefined;
  let activityQuery = db.selectFrom("chat_run_events").selectAll().where("chat_id", "=", chatId);
  if (run) activityQuery = activityQuery.where("run_id", "=", run.id);
  if (activityIds?.length) activityQuery = activityQuery.where("id", "in", activityIds);
  const activities = run ? toActivities(await activityQuery.orderBy("occurred_at", "desc")
    .orderBy("run_seq", "desc").limit(500).execute()) : [];
  const queues = !hot ? await db.selectFrom("chat_queued_turns").selectAll()
    .where("chat_id", "=", chatId).where("status", "=", "queued").orderBy("position").limit(20).execute() : undefined;
  const terminals = !hot || activities.some((a) => a.type === "terminal.bound")
    ? await db.selectFrom("chat_terminal_bindings").select("session_id")
      .where("chat_id", "=", chatId).orderBy("bound_at", "desc").limit(100).execute() : undefined;
  return CanonicalChatContentSchema.parse({
    record, messages: messages.reverse().map(toMessage), turns: turn ? [toTurn(turn)] : [], runs: run ? [toRun(run)] : [], activities,
    ...(payload.removedActivityIds ? { removedActivityIds: payload.removedActivityIds } : {}),
    ...(queues ? { queuedTurns: queues.map(toQueuedTurn) } : {}),
    ...(terminals ? { terminalSessionIds: terminals.reverse().map((t) => t.session_id) } : {}),
  });
}
