import { z } from 'zod/v4';
import type { HetznerClient } from './customer-vps-hetzner.js';

export interface TrialRetentionProviderTarget {
  ownerId: string; machineId: string; serverId: number; customerId: string;
  subscriptionId: string; trialEndsAt: string;
}
const Subscription = z.object({ id: z.string(), customer: z.string(), status: z.string(), trial_end: z.number().nullable() });
const Invoice = z.object({ customer: z.string(), status: z.string().nullable(), amount_paid: z.number().int().nonnegative() });
const subscriptions = z.object({ data: z.array(Subscription).max(100), has_more: z.literal(false) });
const invoices = z.object({ data: z.array(Invoice).max(100), has_more: z.literal(false) });
function requireSafe(value: unknown): asserts value {
  if (!value) throw new Error('Expired trial provider verification refused');
}
async function boundedJson(response: Response): Promise<unknown> {
  requireSafe(response.ok && response.body);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); requireSafe(false); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Read-only provider preflight. No cancellation, collection, email, or deletion calls. */
export function createTrialRetentionProviderVerifier(options: {
  stripeSecretKey: string; getServer: HetznerClient['getServer']; fetcher?: typeof fetch;
}) {
  requireSafe(options.stripeSecretKey.length > 0);
  const fetcher = options.fetcher ?? fetch;
  return async (target: TrialRetentionProviderTarget): Promise<void> => {
    const get = async (path: 'subscriptions' | 'invoices') => {
      const url = new URL(`https://api.stripe.com/v1/${path}`);
      url.searchParams.set('customer', target.customerId); url.searchParams.set('limit', '100');
      if (path === 'subscriptions') url.searchParams.set('status', 'all');
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${options.stripeSecretKey}` },
        signal: AbortSignal.timeout(10_000), redirect: 'error' });
      return boundedJson(response);
    };
    const [subscriptionResponse, invoiceResponse, server] = await Promise.all([
      get('subscriptions'), get('invoices'), options.getServer(target.serverId),
    ]);
    const subscriptionList = subscriptions.safeParse(subscriptionResponse);
    const invoiceList = invoices.safeParse(invoiceResponse);
    requireSafe(subscriptionList.success && invoiceList.success);
    const selected = subscriptionList.data.data.find(item => item.id === target.subscriptionId);
    requireSafe(selected && selected.status === 'canceled' && selected.customer === target.customerId
      && selected.trial_end !== null && selected.trial_end * 1000 === Date.parse(target.trialEndsAt));
    requireSafe(subscriptionList.data.data.every(item => item.customer === target.customerId
      && ['canceled', 'incomplete_expired'].includes(item.status)));
    requireSafe(invoiceList.data.data.every(item => item.customer === target.customerId && item.amount_paid === 0
      && ['paid', 'void'].includes(item.status ?? '')));
    requireSafe(server && server.id === target.serverId && server.status === 'off'
      && server.labels?.app === 'matrix-os' && server.labels.machine_id === target.machineId
      && server.labels.clerk_user_id === target.ownerId && server.labels.runtime_slot === 'primary');
  };
}
