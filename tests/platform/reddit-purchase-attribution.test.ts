import { describe, expect, it, vi } from 'vitest';
import { deliverRedditPurchaseAttribution } from '../../packages/platform/src/reddit-purchase-attribution.js';

describe('Reddit purchase attribution', () => {
  it('maps a completed Stripe checkout into a bounded Reddit purchase', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const result = await deliverRedditPurchaseAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'cs_reddit_purchase',
          client_reference_id: 'user_123',
          amount_total: 10000,
          currency: 'usd',
          metadata: {
            clerk_user_id: 'user_123',
            matrix_attr_rdt_cid: 'reddit-click',
            matrix_attr_landing_path: '/?rdt_cid=reddit-click&utm_source=reddit',
          },
        },
      },
    }, { sendPurchase });

    expect(result).toBe('sent');
    expect(sendPurchase).toHaveBeenCalledWith({
      eventAt: 1_779_753_600_000,
      checkoutSessionId: 'cs_reddit_purchase',
      clerkUserId: 'user_123',
      clickId: 'reddit-click',
      eventSourceUrl: 'https://matrix-os.com/?rdt_cid=reddit-click&utm_source=reddit',
      currency: 'usd',
      value: 100,
    });
  });

  it('ignores non-purchase and malformed Stripe events', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');

    await expect(deliverRedditPurchaseAttribution({
      type: 'checkout.session.expired',
      created: 1_779_753_600,
      data: { object: {} },
    }, { sendPurchase })).resolves.toBe('ignored');
    await expect(deliverRedditPurchaseAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: { object: { id: 'invalid' } },
    }, { sendPurchase })).resolves.toBe('ignored');
    expect(sendPurchase).not.toHaveBeenCalled();
  });
});
