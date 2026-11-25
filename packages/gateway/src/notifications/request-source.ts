import { CanonicalChatRunActivitySchema } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { NotificationDatabase } from "./schema.js";
import type { NotificationEventsTable } from "./events-schema.js";
import { ROUTINE_DIRECT_CHAT_ID_PATTERN } from "../bots/routine-direct-chat-identity.js";

export interface AttentionRequest {
  ref: string; chatId: string; runId: string | null; kind: "approval" | "question";
  source: "canonical_chat" | "bot"; dedupeKey: string; createdAt: Date; expiresAt: Date;
  preview?: string;
}
type RequestRow = { ref: string; chat_id: string; run_id: string | null; event: unknown; created_at: Date; expires_at?: Date; kind?: string };

/** Reads the same durable requests/outcomes as Needs you, never transcript/replay buffers. */
export function createAttentionRequestSource(db: Kysely<NotificationDatabase>, ownerId: string) {
  type ListOptions = { chatId?: string; runId?: string; ref?: string; refs?: readonly string[]; key?: string; missingOnly?: boolean; limit?: number; source?: string };
  async function listIn(db: Transaction<NotificationDatabase>, now: number, options: ListOptions): Promise<AttentionRequest[]> {
    const cutoff = sql`(SELECT applied_at FROM notification_schema_migrations WHERE version=2)`;
    const missing = (key: ReturnType<typeof sql>) => options.missingOnly
      ? sql`AND NOT EXISTS (SELECT 1 FROM notification_events n WHERE n.owner_id=${ownerId} AND n.dedupe_key=${key})` : sql``;
    const canonicalKey = sql`r.run_id || ':' || CASE WHEN r.event->>'type'='approval.requested' THEN 'approval' ELSE 'question' END || ':' || COALESCE(r.event->>'approvalId',r.event->>'requestId')`;
    const canonical = options.source === "bot" ? [] : (await sql<RequestRow>`
      SELECT r.id AS ref,r.chat_id,r.run_id,r.event,r.occurred_at AS created_at
      FROM chat_run_events r JOIN chat_runs run ON run.id=r.run_id JOIN chats c ON c.id=r.chat_id
      WHERE c.owner_type='personal' AND c.owner_id=${ownerId} AND c.lifecycle='active'
        AND c.id !~ ${ROUTINE_DIRECT_CHAT_ID_PATTERN.source}
        AND run.status IN ('accepted','running','waiting_for_approval','waiting_for_input')
        AND r.event->>'type' IN ('approval.requested','input.requested') AND r.occurred_at >= ${cutoff}
        AND COALESCE((r.event->>'expiresAt')::timestamptz,(r.event->'browserApproval'->>'expiresAt')::timestamptz,r.occurred_at+interval '24 hours')>${new Date(now)}
        AND (r.event->>'type'!='input.requested' OR jsonb_array_length(COALESCE(r.event->'questions','[]'::jsonb))>0)
        AND (r.event->'browserApproval'->>'resolution') IS NULL
        ${options.chatId ? sql`AND r.chat_id=${options.chatId}` : sql``}
        ${options.runId ? sql`AND r.run_id=${options.runId}` : sql``}
        ${options.ref ? sql`AND r.id=${options.ref}` : sql``}
        ${options.refs ? sql`AND r.id IN (${sql.join(options.refs)})` : sql``}
        ${options.key ? sql`AND ${canonicalKey}=${options.key}` : sql``}
        AND NOT EXISTS (SELECT 1 FROM chat_approval_outcomes o WHERE o.run_id=r.run_id AND o.approval_id=r.event->>'approvalId')
        AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved WHERE resolved.run_id=r.run_id AND (
          (resolved.event->>'type'='approval.resolved' AND resolved.event->>'approvalId'=r.event->>'approvalId') OR
          (resolved.event->>'type'='input.resolved' AND resolved.event->>'requestId'=r.event->>'requestId') OR
          (resolved.event->>'type'='input.submitted' AND resolved.event->>'requestId'=r.event->>'requestId'
            AND resolved.run_seq>r.run_seq)))
        ${missing(canonicalKey)} ORDER BY r.occurred_at,r.id LIMIT ${options.limit ?? 50}
    `.execute(db)).rows;
    const requests: AttentionRequest[] = [];
    for (const row of canonical) {
      const parsed = CanonicalChatRunActivitySchema.safeParse(row.event);
      if (!parsed.success) continue;
      const activity = parsed.data;
      if (activity.type !== "approval.requested" && activity.type !== "input.requested") continue;
      if (activity.type === "input.requested" && !activity.questions?.length) continue;
      if (activity.type === "approval.requested" && activity.browserApproval?.resolution) continue;
      const kind = activity.type === "approval.requested" ? "approval" : "question";
      const requestId = activity.type === "approval.requested" ? activity.approvalId : activity.requestId;
      const expiry = activity.type === "approval.requested" ? activity.browserApproval?.expiresAt : activity.expiresAt;
      const createdAt = new Date(row.created_at);
      const expiresAt = new Date(expiry ?? createdAt.getTime() + 24 * 60 * 60_000);
      if (expiresAt.getTime() <= now) continue;
      requests.push({ ref: row.ref, chatId: row.chat_id, runId: row.run_id, source: "canonical_chat", kind,
        dedupeKey: `${row.run_id}:${kind}:${requestId}`, createdAt, expiresAt, preview: activity.title });
    }
    // Bot tables are bootstrapped later than Chats and are optional on older owner databases.
    const hasBots = options.source !== "canonical_chat" && (await sql<{ present: boolean }>`SELECT to_regclass('bot_interactions') IS NOT NULL AS present`.execute(db)).rows[0]?.present;
    if (hasBots) {
      const rows = (await sql<RequestRow>`SELECT b.interaction_id AS ref,b.chat_id,b.source_run_id AS run_id,b.kind,b.created_at,b.expires_at
        FROM bot_interactions b JOIN chats c ON c.id=b.chat_id
        WHERE b.owner_id=${ownerId} AND b.responder_actor_id=${ownerId} AND c.owner_type='personal' AND c.owner_id=${ownerId}
          AND c.lifecycle='active' AND c.id !~ ${ROUTINE_DIRECT_CHAT_ID_PATTERN.source}
          AND b.status='pending' AND b.expires_at>${new Date(now)} AND b.created_at>=${cutoff}
          ${options.chatId ? sql`AND b.chat_id=${options.chatId}` : sql``}
          ${options.ref ? sql`AND b.interaction_id=${options.ref}` : sql``}
          ${missing(sql`'interaction:' || b.interaction_id`)} ORDER BY b.created_at,b.interaction_id LIMIT ${options.limit ?? 50}
      `.execute(db)).rows;
      for (const row of rows) requests.push({ ref: row.ref, chatId: row.chat_id, runId: row.run_id, source: "bot",
        kind: row.kind === "approval" ? "approval" : "question", dedupeKey: `interaction:${row.ref}`,
        createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at!) });
    }
    return requests.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.ref.localeCompare(b.ref)).slice(0, options.limit ?? 50);
  }
  function list(now: number, options: ListOptions = {}): Promise<AttentionRequest[]> {
    return db.transaction().execute(async trx => {
      await sql`SET LOCAL statement_timeout='5s'`.execute(trx);
      return listIn(trx, now, options);
    });
  }
  return { list, async pending(event: Pick<NotificationEventsTable, "source" | "source_ref" | "dedupe_key" | "run_id">, now: number) {
    return (await list(now, { ...(event.source === "canonical_chat" ? { key: event.dedupe_key, ...(event.run_id ? { runId: event.run_id } : {}) } : { ref: event.source_ref }),
      source: event.source, limit: 1 })).find(request => request.dedupeKey === event.dedupe_key);
  } };
}
