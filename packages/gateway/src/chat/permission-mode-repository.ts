import { createHash } from "node:crypto";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatRequestIdSchema, CanonicalOwnerScopeSchema,
  CanonicalChatRunActivitySchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { parseJson, toRun, type ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
export function permissionModeActivityId(runId: string, clientRequestId: string) {
  return `activity_permission_${createHash("sha256").update(JSON.stringify([runId, clientRequestId])).digest("hex").slice(0, 40)}`;
}
export async function getPermissionModeContext(db: Executor, ownerInput: ChatOwner, chatId: string, runId: string, clientRequestId: string) {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  CanonicalChatIdSchema.parse(chatId); CanonicalChatRunIdSchema.parse(runId); CanonicalChatRequestIdSchema.parse(clientRequestId);
  const row = await db.selectFrom("chat_runs").innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .selectAll("chat_runs").select("chats.collaboration")
    .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
    .where("chats.lifecycle", "=", "active").where("chat_runs.chat_id", "=", chatId).where("chat_runs.id", "=", runId).executeTakeFirst();
  if (!row) return null;
  const event = await db.selectFrom("chat_run_events").select("event").where("id", "=", permissionModeActivityId(runId, clientRequestId))
    .where("chat_id", "=", chatId).where("run_id", "=", runId).executeTakeFirst();
  const previous = event ? CanonicalChatRunActivitySchema.parse(parseJson(event.event)) : undefined;
  return { run: toRun(row), shared: row.collaboration !== null,
    previous: previous?.type === "run.permission_mode" ? previous : undefined };
}
/** Called only inside appendRunActivities' owner/chat/run transaction. */
export async function applyPermissionModeActivity(db: Executor, activity: Extract<CanonicalChatRunActivity, { type: "run.permission_mode" }>, revision: number) {
  const row = await db.selectFrom("chat_runs").selectAll().where("id", "=", activity.runId).where("chat_id", "=", activity.chatId).executeTakeFirst();
  if (!row) throw new ChatConflictError(activity.chatId, revision);
  const run = toRun(row);
  if (run.driverKind !== "claude_code" || run.interactionMode !== "default" || run.context?.agent
    || !run.capabilitySnapshot.permissionModes.includes(activity.permissionMode)) throw new ChatConflictError(activity.chatId, revision);
  const updated = await db.updateTable("chat_runs").set({ permission_mode: activity.permissionMode, updated_at: activity.occurredAt })
    .where("id", "=", activity.runId).where("chat_id", "=", activity.chatId)
    .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
    .returning("id").executeTakeFirst();
  if (!updated) throw new ChatConflictError(activity.chatId, revision);
}
