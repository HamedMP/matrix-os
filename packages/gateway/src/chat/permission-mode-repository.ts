import { createHash } from "node:crypto";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatRequestIdSchema, CanonicalOwnerScopeSchema,
  CanonicalChatRunActivitySchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { parseJson, toRun, type ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type ModeActivity = Extract<CanonicalChatRunActivity, { type: "run.permission_mode" }>;
export function permissionModeActivityId(runId: string, clientRequestId: string, phase: "pending" | "applied" | "confirmed" = "applied") {
  return `activity_permission_${createHash("sha256").update(JSON.stringify([runId, clientRequestId])).digest("hex").slice(0, 40)}_${phase}`;
}
/** Must also be checked under the admission lock: pending native authority cannot survive into a retry. */
export async function hasUnconfirmedPermissionMode(db: Executor, chatId: string, runId: string) {
  const result = await sql<{ blocked: boolean }>`select exists (
    select 1 from chat_run_events pending where pending.chat_id = ${chatId} and pending.run_id = ${runId}
      and pending.event->>'type' = 'run.permission_mode' and pending.event->>'phase' = 'pending'
      and not exists (select 1 from chat_run_events confirmed where confirmed.chat_id = pending.chat_id
        and confirmed.run_id = pending.run_id and confirmed.event->>'type' = 'run.permission_mode'
        and confirmed.event->>'phase' = 'confirmed'
        and confirmed.event->>'clientRequestId' = pending.event->>'clientRequestId'
        and confirmed.event->>'permissionMode' = pending.event->>'permissionMode')
    ) as blocked`.execute(db);
  return result.rows[0]?.blocked === true;
}
export async function getPermissionModeContext(db: Executor, ownerInput: ChatOwner, chatId: string, runId: string, clientRequestId: string) {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  CanonicalChatIdSchema.parse(chatId); CanonicalChatRunIdSchema.parse(runId); CanonicalChatRequestIdSchema.parse(clientRequestId);
  const row = await db.selectFrom("chat_runs").innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .selectAll("chat_runs").select("chats.collaboration")
    .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
    .where("chats.lifecycle", "=", "active").where("chat_runs.chat_id", "=", chatId).where("chat_runs.id", "=", runId).executeTakeFirst();
  if (!row) return null;
  const events = await db.selectFrom("chat_run_events").select("event")
    .where("id", "in", ["pending", "applied", "confirmed"].map(phase => permissionModeActivityId(runId, clientRequestId, phase as "pending" | "applied" | "confirmed")))
    .where("chat_id", "=", chatId).where("run_id", "=", runId).execute();
  const activities = events.map(event => CanonicalChatRunActivitySchema.parse(parseJson(event.event)));
  return { run: toRun(row), shared: row.collaboration !== null,
    unconfirmed: await hasUnconfirmedPermissionMode(db, chatId, runId),
    attempted: activities.length > 0,
    previous: activities.find((event): event is ModeActivity => event.type === "run.permission_mode" && event.phase === "confirmed") };
}
/** Called only inside appendRunActivities' owner/chat/run transaction. The row is LAST CONFIRMED authority. */
export async function applyPermissionModeActivity(db: Executor, activity: ModeActivity, revision: number) {
  const conflict = () => new ChatConflictError(activity.chatId, revision);
  const row = await db.selectFrom("chat_runs").selectAll().where("id", "=", activity.runId).where("chat_id", "=", activity.chatId).executeTakeFirst();
  if (!row || !activity.phase || activity.id !== permissionModeActivityId(activity.runId, activity.clientRequestId, activity.phase)) throw conflict();
  const run = toRun(row);
  if (run.driverKind !== "claude_code" || run.interactionMode !== "default" || run.context?.agent
    || !run.capabilitySnapshot.permissionModes.includes(activity.permissionMode)) throw conflict();
  // Each receipt is exact request/run/mode bound; terminal confirmation cannot invent a transition.
  for (const phase of activity.phase === "confirmed" ? ["pending", "applied"] as const : activity.phase === "applied" ? ["pending"] as const : []) {
    const prior = await db.selectFrom("chat_run_events").select("event")
      .where("chat_id", "=", activity.chatId).where("run_id", "=", activity.runId)
      .where("id", "=", permissionModeActivityId(activity.runId, activity.clientRequestId, phase)).executeTakeFirst();
    const value = prior && CanonicalChatRunActivitySchema.parse(parseJson(prior.event));
    if (!value || value.type !== "run.permission_mode" || value.phase !== phase || value.permissionMode !== activity.permissionMode
      || value.clientRequestId !== activity.clientRequestId) throw conflict();
  }
  if (activity.phase !== "confirmed") return;
  // A native operation may finish the run before its final receipt reaches Postgres.
  await db.updateTable("chat_runs").set({ permission_mode: activity.permissionMode, updated_at: activity.occurredAt })
    .where("id", "=", activity.runId).where("chat_id", "=", activity.chatId).executeTakeFirst();
}
