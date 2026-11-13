import { z } from 'zod/v4';

export const MAX_BILLING_AUDIT_OWNERS = 1000;
const Owners = z.array(z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/)).max(MAX_BILLING_AUDIT_OWNERS);
const MissingIdentity = z.object({ errors: z.array(z.object({ code: z.string() })).max(100) });
const Identity = z.object({ id: z.string() });

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
