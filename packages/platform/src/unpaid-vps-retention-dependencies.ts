import { buildSyncStoragePrefix } from '@matrix-os/contracts';
import Stripe from 'stripe';
import { z } from 'zod/v4';
import { buildCustomerVpsR2Key, validateDbLatestPointer } from './customer-vps-r2.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { PlatformDB } from './db.js';
import type { R2Client } from './r2-client.js';
import { createUnpaidVpsRetentionSweep, type RetentionRecoveryWindow } from './unpaid-vps-retention.js';

type RecoveryStorage = Pick<R2Client, 'getObject' | 'headObject' | 'hasRecentObjectUnderPrefix'>;
type RecoveryWindow = { earliest: Date; latest: Date };

function withinWindow(date: Date | undefined, window: RecoveryWindow): boolean {
  return !!date && date >= window.earliest && date <= window.latest;
}

function hasFreshObject(object: Awaited<ReturnType<R2Client['headObject']>>, window: RecoveryWindow): boolean {
  return object.exists && (object.contentLength ?? 0) > 0 && withinWindow(object.lastModified, window);
}

export async function hasUnpaidVpsRecoveryCopy(options: {
  r2: RecoveryStorage;
  prefixRoot: string;
}, ownerId: string, runtimeSlot: string, window: RetentionRecoveryWindow): Promise<boolean> {
  const { r2, prefixRoot } = options;
  const systemPrefix = runtimeSlot === 'primary' ? 'system/db' : `system/runtime-slots/${runtimeSlot}/db`;
  const key = (relative: string) => buildCustomerVpsR2Key(prefixRoot, ownerId, relative);
  const syncPrefix = buildSyncStoragePrefix({ ownerId, runtimeSlot });
  const signal = AbortSignal.timeout(10_000);
  try {
    const home = await r2.headObject(`${syncPrefix}/manifest.json`, { signal });
    if (!hasFreshObject(home, window)
      && !await r2.hasRecentObjectUnderPrefix(`${syncPrefix}/manifests/`, {
        earliest: window.earliest,
        latest: window.latest,
        namePattern: /^[1-9]\d{0,15}-[a-f0-9]{64}\.json$/,
        signal,
      })) return false;
    const pointer = await r2.getObject(key(`${systemPrefix}/latest`), { signal });
    if (!pointer.body) return false;
    if (pointer.contentLength === undefined || pointer.contentLength > 512) {
      await pointer.body.cancel();
      return false;
    }
    const snapshot = (await new Response(pointer.body).text()).trim();
    if (!snapshot.startsWith(`${systemPrefix}/snapshots/`) || !validateDbLatestPointer(snapshot)) return false;
    const name = snapshot.slice(`${systemPrefix}/snapshots/`.length);
    const capturedAtText = `${name.slice(0, 13)}:${name.slice(13, 15)}:00Z`;
    if (!z.iso.datetime().safeParse(capturedAtText).success) return false;
    const capturedAt = new Date(capturedAtText);
    const databaseWindow = { earliest: window.databaseEarliest, latest: window.latest };
    if (!withinWindow(capturedAt, databaseWindow)) return false;
    const stored = await r2.headObject(key(snapshot), { signal });
    return hasFreshObject(stored, databaseWindow);
  } catch (error: unknown) {
    if (error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name)) return false;
    throw error;
  }
}

export function createConfiguredUnpaidVpsRetention(options: {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  getServer: HetznerClient['getServer'];
  r2?: RecoveryStorage;
  prefixRoot: string;
}) {
  const { db, env, getServer, r2, prefixRoot } = options;
  const startsAt = env.MATRIX_UNPAID_VPS_RETENTION_STARTS_AT?.trim();
  if (!startsAt) return undefined;
  const policyStartsAt = new Date(z.iso.datetime().parse(startsAt));
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey || !r2) throw new Error('Unpaid VPS retention requires Stripe and backup storage');
  const stripe = new Stripe(secretKey, { timeout: 10_000, maxNetworkRetries: 0 });
  return createUnpaidVpsRetentionSweep({
    db, env, policyStartsAt, getServer,
    hasRecoveryCopy: (owner, slot, window) => hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, slot, window),
    async listSubscriptions(customerId) {
      const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, expand: ['data.latest_invoice'] });
      if (list.has_more || list.data.some(item => item.items.has_more || typeof item.latest_invoice === 'string')) return null;
      return list.data.map(item => {
        const invoice = typeof item.latest_invoice === 'object' ? item.latest_invoice : null;
        const timestamps = item.items.data;
        return {
          id: item.id,
          customerId: typeof item.customer === 'string' ? item.customer : item.customer.id,
          runtimeSlot: item.metadata.matrix_runtime_slot ?? 'primary',
          status: item.status,
          createdAt: new Date(item.created * 1000).toISOString(),
          currentPeriodStart: timestamps.length > 0
            ? new Date(Math.max(...timestamps.map(price => price.current_period_start)) * 1000).toISOString()
            : null,
          endedAt: item.ended_at === null ? null : new Date(item.ended_at * 1000).toISOString(),
          latestInvoiceOutstanding: !!invoice && (invoice.status === 'open' || invoice.status === 'uncollectible')
            && invoice.amount_remaining > 0,
          paidThrough: invoice?.status === 'paid' && timestamps.length > 0
            ? new Date(Math.max(...timestamps.map(price => price.current_period_end)) * 1000).toISOString()
            : null,
        };
      });
    },
  });
}
