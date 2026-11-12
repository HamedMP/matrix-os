import { createHash } from 'node:crypto';
import type { DevstackBrowserMembership } from './devstack-preview-auth.js';

const privatePreviewEndpoint = 'https://app.matrix-os.com/api/private-previews';
const membershipTimeoutMs = 3_000;
const maxPendingMembershipRequests = 32;

/** Check the same first-party eligibility gate as the Private Preview CLI. */
export function createDevstackPreviewMembershipLookup(fetchImpl = fetch): DevstackBrowserMembership {
  const pending = new Map<string, Promise<boolean>>();

  async function request(token: string): Promise<boolean> {
    try {
      const response = await fetchImpl(privatePreviewEndpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(membershipTimeoutMs),
      });
      if (response.body) void response.body.cancel().catch((error: unknown) => {
        console.warn('[platform] DevStack membership response cleanup failed', error instanceof Error ? error.name : 'Unknown error');
      });
      return response.status === 200 && !response.redirected
        && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    } catch (error: unknown) {
      // Never log the request or an upstream error that could include its data.
      if (error instanceof Error) return false;
      throw error;
    }
  }

  return (actorId, token) => {
    // The caller has verified this exact browser token and its actor. Avoid
    // retaining the raw bearer as a map key, and keep no completed decisions.
    const key = createHash('sha256').update(actorId).update('\0').update(token).digest('hex');
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= maxPendingMembershipRequests) return Promise.resolve(false);
    const result = request(token).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}
