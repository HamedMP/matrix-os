import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createStripeBillingClient } from '../../packages/platform/src/stripe-billing.js';

/**
 * ENG-520 launch guard: the Stripe side of compensating one blocked Checkout
 * session that a free owner paid anyway. Faults detected: refunding anything
 * but that session's own invoice, reporting done while the invoice could still
 * be paid, creating a second refund instead of polling, a repeated cancel, and
 * an already refunded charge treated as a failure.
 */

type Invoice = { id: string; status: string; amount_paid: number };

function fakeStripe(options: {
  session?: Partial<{ status: string; subscription: string | null; invoice: string | null; payment_status: string }>;
  subscriptionStatus?: string;
  invoice?: Invoice;
  refundError?: Error;
}) {
  const calls = {
    cancel: vi.fn(async () => ({})),
    refundCreate: vi.fn(async () => {
      if (options.refundError) throw options.refundError;
      return { id: 're_new', status: 'pending' };
    }),
    refundRetrieve: vi.fn(async (id: string) => ({ id, status: 'succeeded' })),
    voidInvoice: vi.fn(async (id: string) => ({ id, status: 'void' })),
    invoiceRetrieve: vi.fn(async () => options.invoice),
    invoiceList: vi.fn(async () => { throw new Error('other invoices must not be listed'); }),
  };
  const stripe = {
    checkout: { sessions: { retrieve: vi.fn(async () => ({
      status: 'complete', subscription: 'sub_x', invoice: 'in_first', payment_status: 'paid', ...options.session,
    })) } },
    subscriptions: { retrieve: vi.fn(async () => ({ status: options.subscriptionStatus ?? 'active' })), cancel: calls.cancel },
    invoices: { retrieve: calls.invoiceRetrieve, voidInvoice: calls.voidInvoice, list: calls.invoiceList },
    invoicePayments: { list: vi.fn(async ({ invoice }: { invoice: string }) => ({
      data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${invoice}` } }],
    })) },
    refunds: { create: calls.refundCreate, retrieve: calls.refundRetrieve },
  } as unknown as Stripe;
  return { client: createStripeBillingClient({ secretKey: 'sk_test', stripe }), calls };
}

const compensate = (client: ReturnType<typeof fakeStripe>['client'], input: Partial<{ refundId: string | null; refundRound: number }> = {}) =>
  client.compensateFreeOwnerCheckout!({ sessionId: 'cs_x', refundId: null, refundRound: 0, ...input });

describe('compensateFreeOwnerCheckout', () => {
  it('cancels once and refunds only the session\'s own paid invoice', async () => {
    const { client, calls } = fakeStripe({ invoice: { id: 'in_first', status: 'paid', amount_paid: 2000 } });
    expect(await compensate(client)).toEqual({ subscriptionId: 'sub_x', settled: false, refund: { id: 're_new', status: 'pending' } });
    expect(calls.cancel).toHaveBeenCalledWith('sub_x', { invoice_now: false, prorate: false },
      { idempotencyKey: 'matrix-free-owner-cancel:sub_x' });
    expect(calls.invoiceRetrieve).toHaveBeenCalledWith('in_first');
    expect(calls.invoiceList).not.toHaveBeenCalled();
    expect(calls.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_in_first' }),
      { idempotencyKey: 'matrix-free-owner-refund:pi_in_first' });
  });

  it('polls an existing refund instead of creating another', async () => {
    const { client, calls } = fakeStripe({ subscriptionStatus: 'canceled', invoice: { id: 'in_first', status: 'paid', amount_paid: 2000 } });
    expect(await compensate(client, { refundId: 're_1' })).toEqual({ subscriptionId: 'sub_x', settled: false, refund: { id: 're_1', status: 'succeeded' } });
    expect(calls.refundCreate).not.toHaveBeenCalled();
    expect(calls.cancel).not.toHaveBeenCalled();
  });

  it('starts a new refund round with a new idempotency key after a failed refund', async () => {
    const { client, calls } = fakeStripe({ invoice: { id: 'in_first', status: 'paid', amount_paid: 2000 } });
    await compensate(client, { refundRound: 2 });
    expect(calls.refundCreate).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: 'matrix-free-owner-refund:pi_in_first:2' });
  });

  it('voids an open invoice, reports a draft as unsettled, and treats void, uncollectible and zero-charge as settled', async () => {
    const open = fakeStripe({ invoice: { id: 'in_first', status: 'open', amount_paid: 0 } });
    expect(await compensate(open.client)).toEqual({ subscriptionId: 'sub_x', settled: true, refund: null });
    expect(open.calls.voidInvoice).toHaveBeenCalledWith('in_first', {}, { idempotencyKey: 'matrix-free-owner-void:in_first' });
    expect((await compensate(fakeStripe({ invoice: { id: 'in_first', status: 'draft', amount_paid: 0 } }).client)).settled).toBe(false);
    for (const status of ['void', 'uncollectible']) {
      expect((await compensate(fakeStripe({ invoice: { id: 'in_first', status, amount_paid: 0 } }).client)).settled).toBe(true);
    }
    expect((await compensate(fakeStripe({ invoice: { id: 'in_first', status: 'paid', amount_paid: 0 } }).client)).settled).toBe(true);
  });

  it('treats a session that never completed as nothing to refund once expired', async () => {
    const expired = fakeStripe({ session: { status: 'expired', subscription: null, invoice: null } });
    expect(await compensate(expired.client)).toEqual({ subscriptionId: null, settled: true, refund: null });
    expect(expired.calls.cancel).not.toHaveBeenCalled();
  });

  it('treats an already refunded charge as settled and fails on any other refund error', async () => {
    const refunded = Object.assign(new Error('already refunded'), { code: 'charge_already_refunded' });
    const done = fakeStripe({ invoice: { id: 'in_first', status: 'paid', amount_paid: 2000 }, refundError: refunded });
    expect(await compensate(done.client)).toEqual({ subscriptionId: 'sub_x', settled: true, refund: null });
    const failing = fakeStripe({ invoice: { id: 'in_first', status: 'paid', amount_paid: 2000 }, refundError: new Error('network') });
    await expect(compensate(failing.client)).rejects.toThrow('network');
  });
});
