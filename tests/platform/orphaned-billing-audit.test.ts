import { describe, expect, it, vi } from 'vitest';
import { auditBillingOwners, readStripeAuditStatus, selectBillingAuditOwners } from '../../packages/platform/src/account-deletion/orphaned-billing-audit.js';

const owner = 'user_trialOwner';
const missing = () => Response.json({ errors: [{ code: 'resource_not_found' }] }, { status: 404 });

describe('billing owner identity audit', () => {
  it('reports a deleted trial owner while an existing owner remains healthy', async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).endsWith(owner)
      ? missing() : Response.json({ id: 'user_existing' }));
    const result = await auditBillingOwners([owner, 'user_existing'], { clerkSecretKey: 'secret', request });
    expect(result).toEqual({ checked: 2, present: 1, missing: 1, inconclusive: 0 });
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it.each([401, 403, 429, 500, 503])('treats HTTP %s as inconclusive, never as deleted', async status => {
    const request = vi.fn(async () => Response.json({ errors: [{ code: 'resource_not_found' }] }, { status }));
    expect(await auditBillingOwners([owner], { clerkSecretKey: 'secret', request }))
      .toEqual({ checked: 1, present: 0, missing: 0, inconclusive: 1 });
  });

  it('does not mistake a proxy 404 or malformed response for identity deletion', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ errors: [{ code: 'unknown' }] }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: 'user_wrong' }));
    expect(await auditBillingOwners([owner, 'user_second', 'user_third'], { clerkSecretKey: 'secret', request }))
      .toEqual({ checked: 3, present: 0, missing: 0, inconclusive: 3 });
  });

  it('counts network failures without leaking secret-bearing error details', async () => {
    const request = vi.fn(async () => { throw new Error('private credential details'); });
    const result = await auditBillingOwners([owner], { clerkSecretKey: 'secret', request });
    expect(result).toEqual({ checked: 1, present: 0, missing: 0, inconclusive: 1 });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('deduplicates owners and bounds external requests with timeouts and no redirects', async () => {
    const request = vi.fn<typeof fetch>(async () => missing());
    expect((await auditBillingOwners([owner, owner], { clerkSecretKey: 'secret', request })).checked).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('rejects incomplete inventories, invalid owners and missing credentials before requesting', async () => {
    const request = vi.fn(async () => missing());
    await expect(auditBillingOwners(Array.from({ length: 1001 }, (_, i) => `user_${i}`), { clerkSecretKey: 'secret', request })).rejects.toThrow();
    await expect(auditBillingOwners(['../users'], { clerkSecretKey: 'secret', request })).rejects.toThrow();
    await expect(auditBillingOwners([owner], { clerkSecretKey: '', request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('caps concurrent identity lookups', async () => {
    let active = 0;
    let maximum = 0;
    const request = vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return missing();
    });
    await auditBillingOwners(Array.from({ length: 15 }, (_, i) => `user_${i}`), { clerkSecretKey: 'secret', request });
    expect(maximum).toBeLessThanOrEqual(5);
  });
});

describe('ambiguous stored subscription status lookup', () => {
  it('stops queued provider reads after the first failure', async () => {
    const inventory = Array.from({ length: 20 }, (_, n) => ({ clerk_user_id: `user_${n}`, stripe_subscription_id: `sub_${n}`, status: 'ended' }));
    const readEndedStatus = vi.fn(async (id: string) => {
      if (id === 'sub_0') throw new Error('provider unavailable');
      await new Promise(resolve => setTimeout(resolve, 2));
      return 'paused';
    });
    await expect(selectBillingAuditOwners(inventory, { readEndedStatus })).rejects.toThrow('provider unavailable');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(readEndedStatus.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it('reads the exact live subscription with a timeout and rejects redirects', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ id: 'sub_paused', status: 'paused' }));
    expect(await readStripeAuditStatus('sub_paused', 'fixture', request)).toBe('paused');
    expect(request).toHaveBeenCalledWith('https://api.stripe.com/v1/subscriptions/sub_paused',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  it.each([404, 503])('fails instead of treating HTTP %s as terminal', async status => {
    const request = vi.fn<typeof fetch>(async () => new Response('', { status }));
    await expect(readStripeAuditStatus('sub_paused', 'fixture', request)).rejects.toThrow('lookup unavailable');
  });

  it('rejects a response for a different subscription', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ id: 'sub_other', status: 'canceled' }));
    await expect(readStripeAuditStatus('sub_paused', 'fixture', request)).rejects.toThrow('mismatch');
  });
});
