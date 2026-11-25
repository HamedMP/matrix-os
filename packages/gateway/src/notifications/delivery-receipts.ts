import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { NotificationDatabase } from "./schema.js";
export interface PushDeliveryReceipts {
  delivered(eventId: string, ownerId: string): Promise<string[]>;
  remember(eventId: string, ownerId: string, tokenHashes: string[]): Promise<void>;
}
export function createPushDeliveryReceipts(db: Kysely<NotificationDatabase>): PushDeliveryReceipts {
  return {
    async delivered(eventId, ownerId) {
      const rows = await db.selectFrom("notification_attempts as a").innerJoin("notification_events as e", "e.id", "a.event_id")
        .select("a.device_id").where("e.id", "=", eventId).where("e.owner_id", "=", ownerId)
        .where("a.outcome", "=", "sent").where("a.device_id", "is not", null).limit(256).execute();
      return rows.flatMap(row => row.device_id ? [row.device_id] : []);
    },
    async remember(eventId, ownerId, tokenHashes) {
      if (!tokenHashes.length) return;
      const bounded = [...new Set(tokenHashes.slice(0, 256))]; // cap 256; request-local and discarded after the write
      await db.transaction().execute(async trx => {
        await sql`SET LOCAL statement_timeout='5s'`.execute(trx);
        const event = await trx.selectFrom("notification_events").select("id").where("id", "=", eventId)
          .where("owner_id", "=", ownerId).forShare().executeTakeFirst();
        if (!event) throw new Error("Notification delivery unavailable");
        await trx.insertInto("notification_attempts").values(bounded.map(hash => ({ id: randomUUID(), event_id: eventId,
          channel: "expo_push" as const, device_id: hash, outcome: "sent" as const, created_at: new Date() })))
          .onConflict(conflict => conflict.columns(["event_id", "device_id"]).where("outcome", "=", "sent")
            .where("device_id", "is not", null).doNothing()).execute();
      });
    },
  };
}
