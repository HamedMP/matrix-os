import { randomUUID } from 'node:crypto';
import type { PlatformDB } from '../db.js';
import type { InvoiceTrackingPurchase, InvoiceAcquisitionIdentity } from './tracking-events.js';

export interface GooglePurchaseSender { send(purchase: InvoiceTrackingPurchase): Promise<'sent' | 'disabled' | 'skipped'> }

export async function enqueueGooglePurchase(db: PlatformDB, purchase: InvoiceTrackingPurchase,
  at = new Date().toISOString(), clerkUserId = ''): Promise<void> {
  await insertGoogleAcquisition(db, { subscriptionId: purchase.subscriptionId,
    transactionId: purchase.event.ecommerce.transaction_id }, JSON.stringify(purchase), at, clerkUserId);
}

export async function rememberSkippedGoogleAcquisition(db: PlatformDB, identity: InvoiceAcquisitionIdentity,
  at: string, clerkUserId: string): Promise<void> {
  await insertGoogleAcquisition(db, identity, null, at, clerkUserId);
}

async function insertGoogleAcquisition(db: PlatformDB, identity: InvoiceAcquisitionIdentity,
  payload: string | null, at: string, clerkUserId: string): Promise<void> {
  await db.ready;
  // One acquisition per subscription, regardless of webhook ID, delivery retries or invoice renewals.
  await db.executor.insertInto('billing_google_purchases').values({
    subscription_id: identity.subscriptionId, transaction_id: identity.transactionId,
    clerk_user_id: clerkUserId, payload, created_at: at, sent_at: null,
    attempts: 0, available_at: at, lease_until: null, lease_token: null,
  }).onConflict(oc => oc.doNothing()).execute();
}

export async function deliverGooglePurchases(db: PlatformDB, sender: GooglePurchaseSender,
  at = new Date().toISOString(), subscriptionId?: string): Promise<{ failed: number; pending: boolean }> {
  await db.ready;
  await expireGoogleTracking(db, at);
  const token = randomUUID();
  let failed = 0;
  const jobs = await db.transaction(async trx => {
    let query = trx.executor.selectFrom('billing_google_purchases').selectAll()
      .where('sent_at', 'is', null).where('payload', 'is not', null)
      .where(eb => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      .orderBy('created_at').limit(subscriptionId ? 1 : 3).forUpdate().skipLocked();
    if (subscriptionId) query = query.where('subscription_id', '=', subscriptionId);
    else query = query.where('available_at', '<=', at);
    const rows = await query.execute();
    if (!rows.length) return [];
    // Recheck admission in the write, even if a dialect shares its connection
    // between callers. Only RETURNING rows belong to this lease holder.
    return trx.executor.updateTable('billing_google_purchases')
      .set({ lease_token: token, lease_until: new Date(Date.parse(at) + 60000).toISOString() })
      .where('subscription_id', 'in', rows.map(row => row.subscription_id))
      .where('sent_at', 'is', null).where('payload', 'is not', null)
      .where(eb => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      .returningAll().execute();
  });
  for (const job of jobs) {
    try {
      const purchase = JSON.parse(job.payload!) as InvoiceTrackingPurchase;
      const result = await sender.send(purchase);
      await db.executor.updateTable('billing_google_purchases').set({
        ...(result === 'sent' ? { sent_at: at, payload: null } : result === 'skipped' ? { payload: null } : {}),
        available_at: new Date(Date.parse(at) + 60000).toISOString(), lease_until: null, lease_token: null,
      }).where('subscription_id', '=', job.subscription_id).where('lease_token', '=', token).execute();
    } catch (error: unknown) {
      failed++;
      console.warn('[billing] Google purchase delivery unavailable:', error instanceof Error ? error.name : typeof error);
      await db.executor.updateTable('billing_google_purchases').set({ attempts: job.attempts + 1,
        available_at: new Date(Date.parse(at) + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6))).toISOString(),
        lease_until: null, lease_token: null,
      }).where('subscription_id', '=', job.subscription_id).where('lease_token', '=', token).execute();
    }
  }
  const pending = subscriptionId ? await db.executor.selectFrom('billing_google_purchases').select('subscription_id')
    .where('subscription_id', '=', subscriptionId).where('sent_at', 'is', null).where('payload', 'is not', null).executeTakeFirst() : undefined;
  return { failed, pending: Boolean(pending) };
}

/** Retention runs even when collection is disabled; cleared acquisition markers are not rewritten. */
export async function expireGoogleTracking(db: PlatformDB, at = new Date().toISOString()): Promise<{ purchases: number; snapshots: number }> {
  await db.ready;
  return db.transaction(async trx => {
    const purchases = await trx.executor.updateTable('billing_google_purchases').set({ payload: null })
      .where('payload', 'is not', null)
      .where('created_at', '<', new Date(Date.parse(at) - 72 * 3600000).toISOString()).executeTakeFirst();
    const snapshots = await trx.executor.deleteFrom('billing_google_checkout_attribution')
      .where('created_at', '<', new Date(Date.parse(at) - 7 * 86400000).toISOString()).executeTakeFirst();
    return { purchases: Number(purchases.numUpdatedRows), snapshots: Number(snapshots.numDeletedRows) };
  });
}
