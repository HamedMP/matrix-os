import { z } from 'zod/v4';

export const MAX_BILLING_AUDIT_OWNERS = 1000;
export const MAX_BILLING_AUDIT_SUBSCRIPTIONS = 1000;
const Owners = z.array(z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/)).max(MAX_BILLING_AUDIT_OWNERS);
const MissingIdentity = z.object({ errors: z.array(z.object({ code: z.string() })).max(100) });
const Identity = z.object({ id: z.string() });
const SubscriptionId = z.string().regex(/^sub_[A-Za-z0-9_]{1,200}$/);
const Status = z.string().min(1).max(64);
const Inventory = z.array(z.object({ clerk_user_id: Owners.element, stripe_subscription_id: SubscriptionId, status: Status }))
  .max(MAX_BILLING_AUDIT_SUBSCRIPTIONS);
export type BillingAuditSubscription = z.infer<typeof Inventory>[number];

export async function loadBillingAuditInventory(query: (
  sql: string, values: number[],
) => Promise<{ rows: BillingAuditSubscription[] }>): Promise<BillingAuditSubscription[]> {
  const result = await query(
    `SELECT clerk_user_id, stripe_subscription_id, status FROM billing_subscriptions
     WHERE status NOT IN ('canceled', 'incomplete_expired')
     ORDER BY clerk_user_id, stripe_subscription_id LIMIT $1`, [MAX_BILLING_AUDIT_SUBSCRIPTIONS + 1]);
  if (result.rows.length > MAX_BILLING_AUDIT_SUBSCRIPTIONS) throw new Error('Billing audit inventory capacity exceeded');
  return Inventory.parse(result.rows);
}

/** The platform normalizes paused and expired statuses alike to ended. Resolve those through Stripe. */
export async function selectBillingAuditOwners(inventory: BillingAuditSubscription[], options: {
  readEndedStatus(id: string): Promise<string>;
}): Promise<string[]> {
  const rows = Inventory.parse(inventory);
  const owners = new Set<string>(); // At most 1,000 validated rows; discarded on return.
  let cursor = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(5, rows.length) }, async () => {
    while (!stopped && cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const status = row.status === 'ended' ? Status.parse(await options.readEndedStatus(row.stripe_subscription_id)) : row.status;
        if (!['canceled', 'incomplete_expired'].includes(status)) owners.add(row.clerk_user_id);
      } catch (error: unknown) {
        stopped = true;
        if (error instanceof Error) throw error;
        throw new Error('Billing audit subscription lookup unavailable');
      }
    }
  }));
  return [...owners].sort();
}

export async function readStripeAuditStatus(id: string, key: string, request: typeof fetch = fetch): Promise<string> {
  SubscriptionId.parse(id);
  if (!key.trim()) throw new Error('Billing audit subscription configuration unavailable');
  const response = await request(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('Billing audit subscription lookup unavailable');
  }
  const live = z.object({ id: SubscriptionId, status: Status }).parse(await response.json());
  if (live.id !== id) throw new Error('Billing audit subscription mismatch');
  return live.status;
}

/** Read-only evidence: never use an inconclusive lookup to authorize cancellation. */
export async function auditBillingOwners(owners: string[], options: {
  clerkSecretKey: string;
  request?: typeof fetch;
}): Promise<{ checked: number; present: number; missing: number; inconclusive: number }> {
  Owners.parse(owners);
  if (!options.clerkSecretKey.trim()) throw new Error('Billing audit identity configuration unavailable');
  const unique = [...new Set(owners)]; // The validated inventory caps this set at 1,000; discarded on return.
  const request = options.request ?? fetch;
  const counts = { checked: unique.length, present: 0, missing: 0, inconclusive: 0 };
  let cursor = 0;
  async function inspect(owner: string): Promise<'present' | 'missing' | 'inconclusive'> {
    try {
      const response = await request(`https://api.clerk.com/v1/users/${encodeURIComponent(owner)}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${options.clerkSecretKey}` },
      });
      if (response.status === 200) {
        const identity = Identity.safeParse(await response.json());
        return identity.success && identity.data.id === owner ? 'present' : 'inconclusive';
      }
      if (response.status === 404) {
        const missing = MissingIdentity.safeParse(await response.json());
        return missing.success && missing.data.errors.some(error => error.code === 'resource_not_found')
          ? 'missing' : 'inconclusive';
      }
      await response.body?.cancel();
      return 'inconclusive';
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      // Transport, timeout and malformed-response failures stay visible in the result.
      return 'inconclusive';
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, unique.length) }, async () => {
    while (cursor < unique.length) {
      const owner = unique[cursor++];
      counts[await inspect(owner)] += 1;
    }
  }));
  return counts;
}
