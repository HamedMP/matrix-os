import { describe, expect, it, vi } from 'vitest';
import { deliverRedditAttribution } from '../../packages/platform/src/reddit-purchase-attribution.js';

describe('Reddit Stripe attribution', () => {
  it('maps a completed one-time Checkout payment into Purchase', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const sendSignUp = vi.fn().mockResolvedValue('sent');
    const result = await deliverRedditAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'cs_reddit_purchase',
          mode: 'payment',
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
    }, { sendPurchase, sendSignUp });

    expect(result).toBe('sent');
    expect(sendPurchase).toHaveBeenCalledWith({
      eventAt: 1_779_753_600_000,
      conversionId: 'cs_reddit_purchase',
      clerkUserId: 'user_123',
      clickId: 'reddit-click',
      eventSourceUrl: 'https://matrix-os.com/?rdt_cid=reddit-click&utm_source=reddit',
      currency: 'usd',
      value: 100,
    });
    expect(sendSignUp).not.toHaveBeenCalled();
  });

  it('maps a completed zero-value subscription trial into Sign Up', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const sendSignUp = vi.fn().mockResolvedValue('sent');
    const result = await deliverRedditAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'cs_reddit_trial',
          mode: 'subscription',
          client_reference_id: 'user_123',
          amount_total: 0,
          currency: 'usd',
          metadata: {
            matrix_attr_rdt_cid: 'reddit-click',
            matrix_attr_landing_path: '/pricing?utm_source=reddit',
          },
        },
      },
    }, { sendPurchase, sendSignUp });

    expect(result).toBe('sent');
    expect(sendSignUp).toHaveBeenCalledWith({
      eventAt: 1_779_753_600_000,
      conversionId: 'cs_reddit_trial',
      clerkUserId: 'user_123',
      clickId: 'reddit-click',
      eventSourceUrl: 'https://matrix-os.com/pricing?utm_source=reddit&rdt_cid=reddit-click',
    });
    expect(sendPurchase).not.toHaveBeenCalled();
  });

  it('maps collected subscription invoice revenue into Purchase', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const sendSignUp = vi.fn().mockResolvedValue('sent');
    const result = await deliverRedditAttribution({
      type: 'invoice.paid',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'in_reddit_purchase',
          amount_paid: 2000,
          currency: 'usd',
          parent: {
            subscription_details: {
              metadata: {
                clerk_user_id: 'user_123',
                matrix_attr_rdt_cid: 'reddit-click',
                matrix_attr_landing_path: '/pricing?utm_source=reddit',
              },
            },
          },
        },
      },
    }, { sendPurchase, sendSignUp });

    expect(result).toBe('sent');
    expect(sendPurchase).toHaveBeenCalledWith({
      eventAt: 1_779_753_600_000,
      conversionId: 'in_reddit_purchase',
      clerkUserId: 'user_123',
      clickId: 'reddit-click',
      eventSourceUrl: 'https://matrix-os.com/pricing?utm_source=reddit&rdt_cid=reddit-click',
      currency: 'usd',
      value: 20,
    });
    expect(sendSignUp).not.toHaveBeenCalled();
  });

  it('does not double-count an immediate subscription charge at Checkout', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const sendSignUp = vi.fn().mockResolvedValue('sent');

    await expect(deliverRedditAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'cs_subscription_charge',
          mode: 'subscription',
          client_reference_id: 'user_123',
          amount_total: 10000,
          currency: 'usd',
          metadata: { clerk_user_id: 'user_123' },
        },
      },
    }, { sendPurchase, sendSignUp })).resolves.toBe('ignored');
    expect(sendPurchase).not.toHaveBeenCalled();
    expect(sendSignUp).not.toHaveBeenCalled();
  });

  it('ignores non-conversions, zero-value invoices, and malformed events', async () => {
    const sendPurchase = vi.fn().mockResolvedValue('sent');
    const sendSignUp = vi.fn().mockResolvedValue('sent');
    const client = { sendPurchase, sendSignUp };

    await expect(deliverRedditAttribution({
      type: 'checkout.session.expired',
      created: 1_779_753_600,
      data: { object: {} },
    }, client)).resolves.toBe('ignored');
    await expect(deliverRedditAttribution({
      type: 'checkout.session.completed',
      created: 1_779_753_600,
      data: { object: { id: 'invalid' } },
    }, client)).resolves.toBe('ignored');
    await expect(deliverRedditAttribution({
      type: 'invoice.paid',
      created: 1_779_753_600,
      data: {
        object: {
          id: 'in_zero',
          amount_paid: 0,
          currency: 'usd',
          parent: { subscription_details: { metadata: { clerk_user_id: 'user_123' } } },
        },
      },
    }, client)).resolves.toBe('ignored');
    expect(sendPurchase).not.toHaveBeenCalled();
    expect(sendSignUp).not.toHaveBeenCalled();
  });
});
