import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { NotificationDatabase } from "./schema.js";
import type { NotificationEventsTable } from "./events-schema.js";
import type { AttentionRequest } from "./request-source.js";

export type NotificationEvent = Selectable<NotificationEventsTable>;
export function createNotificationRepository(db: Kysely<NotificationDatabase>, ownerId: string) {
  return {
    async insert(request: AttentionRequest) {
      await db.insertInto("notification_events").values({
        id: randomUUID(), owner_id: ownerId, dedupe_key: request.dedupeKey, kind: request.kind, source: request.source,
        source_ref: request.ref, chat_id: request.chatId, run_id: request.runId, title: "Matrix OS", preview: null,
        urgency: "high", state: "open", phone_send_after: new Date(request.createdAt.getTime() + 15_000),
        evaluated_at: null, claimed_at: null, claim_token: null, push_attempts: 0,
        expires_at: request.expiresAt, created_at: request.createdAt, resolved_at: null,
      }).onConflict(conflict => conflict.columns(["owner_id", "dedupe_key"]).doNothing()).execute();
    },
    async claim(now: number): Promise<NotificationEvent[]> {
      return db.transaction().execute(async trx => {
        await sql`SET LOCAL statement_timeout='5s'`.execute(trx);
        await trx.updateTable("notification_events").set({ state: "expired", resolved_at: new Date(now), claim_token: null })
          .where("owner_id", "=", ownerId).where("state", "in", ["open", "sending"])
          .where("expires_at", "<=", new Date(now)).execute();
        await trx.updateTable("notification_events").set({ state: "open", claim_token: null, claimed_at: null })
          .where("owner_id", "=", ownerId).where("state", "=", "sending")
          .where("claimed_at", "<", new Date(now - 60_000)).execute();
        const due = await trx.selectFrom("notification_events").select("id")
          .where("owner_id", "=", ownerId).where("state", "=", "open").where("phone_send_after", "<=", new Date(now))
          .orderBy("phone_send_after").orderBy("id").limit(50).forUpdate().skipLocked().execute();
        if (!due.length) return [];
        return trx.updateTable("notification_events").set({ state: "sending", claimed_at: new Date(now),
          claim_token: randomUUID(), evaluated_at: new Date(now) })
          .where("id", "in", due.map(row => row.id)).where("state", "=", "open").returningAll().execute();
      });
    },
    async finish(event: NotificationEvent, state: "resolved" | "suppressed" | "pushed" | "failed", now: number) {
      await db.transaction().execute(async trx => {
        const updated = await trx.updateTable("notification_events").set({ state, claim_token: null,
          ...(state === "resolved" ? { resolved_at: new Date(now) } : {}) })
          .where("id", "=", event.id).where("owner_id", "=", ownerId).where("state", "=", "sending")
          .where("claim_token", "=", event.claim_token).returning("id").executeTakeFirst();
        if (updated && (state === "pushed" || state === "failed")) await trx.insertInto("notification_attempts").values({
          id: randomUUID(), event_id: event.id, channel: "expo_push", device_id: null,
          outcome: state === "pushed" ? "sent" : "failed", created_at: new Date(now),
        }).execute();
      });
    },
    async retry(event: NotificationEvent, now: number) {
      const attempts = event.push_attempts + 1;
      const due = now + [2_000, 8_000, 30_000][Math.min(attempts - 1, 2)]!;
      await db.transaction().execute(async trx => {
        const updated = await trx.updateTable("notification_events").set({
          state: attempts >= 3 || due >= new Date(event.expires_at).getTime() ? "failed" : "open",
          push_attempts: attempts, phone_send_after: new Date(due), claim_token: null,
        }).where("id", "=", event.id).where("owner_id", "=", ownerId).where("state", "=", "sending")
          .where("claim_token", "=", event.claim_token).returning("id").executeTakeFirst();
        if (updated) await trx.insertInto("notification_attempts").values({ id: randomUUID(), event_id: event.id,
          channel: "expo_push", device_id: null, outcome: "failed", created_at: new Date(now) }).execute();
      });
    },
    async stillClaimed(event: NotificationEvent): Promise<boolean> {
      return !!await db.selectFrom("notification_events").select("id").where("id", "=", event.id)
        .where("owner_id", "=", ownerId).where("state", "=", "sending").where("claim_token", "=", event.claim_token).executeTakeFirst();
    },
    async sweep(now: number) {
      await db.deleteFrom("notification_events").where("owner_id", "=", ownerId)
        .where("created_at", "<", new Date(now - 30 * 24 * 60 * 60_000)).execute();
    },
  };
}
