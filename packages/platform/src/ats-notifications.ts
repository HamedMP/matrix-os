import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { AtsDB } from './ats-db.js';

export const NotificationSchema = z.object({
  name: z.string().max(200), email: z.string().max(320),
  role: z.string().max(100), path: z.string().regex(/^\/admin\/ats(?:\/[a-zA-Z0-9-]+)?$/),
  source: z.enum(['careers_page', 'group_email', 'legacy']),
  applicationId: z.uuid().optional(), messageId: z.uuid().optional(),
});
export type AtsNotification = z.infer<typeof NotificationSchema>;

export async function enqueueAtsNotification(db: AtsDB, entityKey: string, payload: AtsNotification, at: string) {
  await db.executor.insertInto('ats_notification_outbox').values({
    id: randomUUID(), entity_key: entityKey, payload: JSON.stringify(NotificationSchema.parse(payload)),
    attempts: 0, available_at: at, lease_until: null, lease_token: null, sent_at: null, slack_ts: null, created_at: at,
  }).onConflict((oc) => oc.column('entity_key').doNothing()).execute();
}

export async function deliverAtsNotifications(
  db: AtsDB, send: (payload: AtsNotification, context: {entityKey:string;jobId:string}) => Promise<{ ts: string }>, at = new Date().toISOString(),
) {
  await db.ready;
  // A bounded claim with a lease permits multiple platform processes and recovers crashes.
  const token = randomUUID();
  const leaseUntil = new Date(Date.parse(at) + 10 * 60_000).toISOString();
  const jobs = await db.transaction(async (trx) => {
    const pending = await trx.executor.selectFrom('ats_notification_outbox').selectAll()
      .where('sent_at', 'is', null).where('available_at', '<=', at)
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      .orderBy('created_at').limit(2).forUpdate().skipLocked().execute();
    if (pending.length) await trx.executor.updateTable('ats_notification_outbox')
      .set({ lease_token: token, lease_until: leaseUntil }).where('id', 'in', pending.map((row) => row.id)).execute();
    return pending;
  });
  for (const job of jobs) {
    try {
      const payload = NotificationSchema.parse(JSON.parse(job.payload));
      const result = await send(payload, {entityKey:job.entity_key,jobId:job.id});
      await db.executor.updateTable('ats_notification_outbox').set({ sent_at: at, slack_ts: result.ts, lease_token: null, lease_until: null })
        .where('id', '=', job.id).where('lease_token', '=', token).execute();
    } catch (error) {
      if (!(error instanceof AtsDeliveryPendingError)) console.error('[ats] Notification delivery failed:', error instanceof Error ? error.name : typeof error);
      const delay = error instanceof AtsDeliveryPendingError ? 60_000 : error instanceof AtsSlackRetryError ? error.delayMs : Math.min(60 * 60_000, 60_000 * 2 ** Math.min(job.attempts, 6));
      await db.executor.updateTable('ats_notification_outbox').set({ attempts: job.attempts + (error instanceof AtsDeliveryPendingError ? 0 : 1), available_at: new Date((error instanceof AtsSlackRetryError ? Date.now() : Date.parse(at)) + delay).toISOString(), lease_token: null, lease_until: null })
        .where('id', '=', job.id).where('lease_token', '=', token).execute();
    }
  }
  // Delivered jobs contain personal data; keep at most 30 days of delivery bookkeeping.
  await db.executor.deleteFrom('ats_notification_outbox').where('sent_at', '<', new Date(Date.parse(at) - 30 * 86400_000).toISOString()).execute();
}

export class AtsDeliveryPendingError extends Error { constructor(){super('Applicant delivery is already running');this.name='AtsDeliveryPendingError';} }
export class AtsSlackRetryError extends Error { constructor(readonly delayMs:number){super('Slack delivery temporarily unavailable');} }
