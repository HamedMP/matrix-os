import { describe, expect, it, vi } from 'vitest';
import { waitForPreparedCheckout } from '../../shell/src/lib/billing-checkout-preparation.js';

describe('billing checkout preparation', () => {
  it('polls an owner-bound attempt and returns only the ready checkout URL', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'preparing' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ url: 'https://checkout.stripe.test/ready' }));

    await expect(waitForPreparedCheckout({
      attemptId: '76edda9c-1431-4777-bd55-ebfa73fa938d',
      signal: new AbortController().signal,
      fetcher,
      wait: vi.fn().mockResolvedValue(undefined),
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/ready' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      '/billing/checkout/status?attemptId=76edda9c-1431-4777-bd55-ebfa73fa938d',
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
    );
  });

  it('fails safely when preparation does not become ready', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 'billing_unavailable' }, { status: 503 }));
    await expect(waitForPreparedCheckout({
      attemptId: '76edda9c-1431-4777-bd55-ebfa73fa938d',
      signal: new AbortController().signal,
      fetcher,
      wait: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('checkout_preparation_failed');
  });
});
