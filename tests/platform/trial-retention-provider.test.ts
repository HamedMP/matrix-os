import { describe, expect, it, vi } from 'vitest';
import { createTrialRetentionProviderVerifier } from '../../packages/platform/src/trial-retention-provider.js';

const target = { ownerId: 'user_trial', machineId: '5b8d4091-4b05-4aae-94ba-928900fa32a0', serverId: 12345,
  customerId: 'cus_trial', subscriptionId: 'sub_trial', trialEndsAt: '2026-10-01T00:00:00.000Z' };
const subscription = { id: 'sub_trial', customer: 'cus_trial', status: 'canceled', trial_end: 1790812800 };
const server = { id: 12345, status: 'off', labels: { app: 'matrix-os', machine_id: target.machineId,
  clerk_user_id: target.ownerId, runtime_slot: 'primary' } };
function setup(subscriptions = [subscription], invoices: unknown[] = [], hasMore = false) {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: subscriptions, has_more: hasMore }))
    .mockResolvedValueOnce(Response.json({ data: invoices, has_more: false }));
  const getServer = vi.fn().mockResolvedValue(server);
  return { fetcher, getServer, verify: createTrialRetentionProviderVerifier({ stripeSecretKey: 'sk_test_private', fetcher, getServer }) };
}
describe('expired-trial provider verification', () => {
  it('reads bounded complete live customer history and matches the exact stopped provider resource', async () => {
    const { verify, fetcher, getServer } = setup(); await expect(verify(target)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'error' });
    expect(String(fetcher.mock.calls[0][0])).toContain('customer=cus_trial');
    expect(getServer).toHaveBeenCalledWith(12345);
  });
  it.each(['active', 'past_due', 'unpaid', 'trialing'])('rejects live %s even if local projection is canceled', async status => {
    const { verify } = setup([{ ...subscription, status }]); await expect(verify(target)).rejects.toThrow(/refused/);
  });
  it.each([
    { status: 'paid', amount_paid: 1 }, { status: 'open', amount_paid: 0 },
    { status: 'uncollectible', amount_paid: 0 }, { status: 'draft', amount_paid: 0 },
  ])('rejects paid history or a recoverable invoice: $status', async invoice => {
    const { verify } = setup([subscription], [{ customer: 'cus_trial', ...invoice }]);
    await expect(verify(target)).rejects.toThrow(/refused/);
  });
  it('allows the zero-cost settled trial invoice', async () => {
    const { verify } = setup([subscription], [{ customer: 'cus_trial', status: 'paid', amount_paid: 0 }]);
    await expect(verify(target)).resolves.toBeUndefined();
  });
  it('fails closed on pagination, identity mismatch, changed trial date, provider errors and wrong machine labels', async () => {
    await expect(setup([subscription], [], true).verify(target)).rejects.toThrow(/refused/);
    await expect(setup([{ ...subscription, customer: 'cus_other' }]).verify(target)).rejects.toThrow(/refused/);
    await expect(setup([{ ...subscription, trial_end: subscription.trial_end + 86400 }]).verify(target)).rejects.toThrow(/refused/);
    const failed = setup(); failed.fetcher.mockReset().mockResolvedValue(new Response('', { status: 503 }));
    await expect(failed.verify(target)).rejects.toThrow(/refused/);
    const changed = setup(); changed.getServer.mockResolvedValue({ ...server, labels: { ...server.labels, machine_id: 'other' } });
    await expect(changed.verify(target)).rejects.toThrow(/refused/);
  });
  it('bounds Stripe response bytes even without a trustworthy Content-Length', async () => {
    const { verify, fetcher } = setup();
    fetcher.mockReset().mockImplementation(async () => new Response(' '.repeat(1_048_577), { status: 200 }));
    await expect(verify(target)).rejects.toThrow(/refused/);
  });
});
