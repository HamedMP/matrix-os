import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createStripeBillingClient } from '../../packages/platform/src/stripe-billing.js';

/**
 * ENG-520 launch guard: the Stripe side of compensating a paid subscription
 * that landed for a free owner. Faults detected: refunding invoices paid before
 * free admission (real paid service), a finished result while an invoice can
 * still be paid, a repeated cancel or refund, and an already refunded charge
 * treated as a failure.
 */

const SINCE = new Date('2026-11-27T12:00:00.000Z');
const seconds = (offsetMs: number) => Math.floor((SINCE.getTime() + offsetMs) / 1000);

type Invoice = { id: string; status: string; status_transitions?: { paid_at?: number | null } };

function fakeStripe(options: { subscriptionStatus?: string; invoices: Invoice[]; refundError?: Error }) {
  const calls = {
    cancel: vi.fn(async () => ({})),
    refund: vi.fn(async () => {
      if (options.refundError) throw options.refundError;
      return {};
    }),
    voidInvoice: vi.fn(async (id: string) => ({ id, status: 'void' })),
  };
  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async () => ({ status: options.subscriptionStatus ?? 'active' })),
      cancel: calls.cancel,
    },
    invoices: {
      list: vi.fn(async () => ({ data: options.invoices, has_more: false })),
      voidInvoice: calls.voidInvoice,
    },
    invoicePayments: {
      list: vi.fn(async ({ invoice }: { invoice: string }) => ({
        data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${invoice}` } }],
      })),
    },
    refunds: { create: calls.refund },
  } as unknown as Stripe;
  return { client: createStripeBillingClient({ secretKey: 'sk_test', stripe }), calls };
}

describe('cancelAndRefundSubscription', () => {
  it('cancels once and refunds only invoices paid at or after free admission', async () => {
    const { client, calls } = fakeStripe({ invoices: [
      { id: 'in_before', status: 'paid', status_transitions: { paid_at: seconds(-86_400_000) } },
      { id: 'in_after', status: 'paid', status_transitions: { paid_at: seconds(60_000) } },
      { id: 'in_void', status: 'void' },
      { id: 'in_bad', status: 'uncollectible' },
    ] });
    expect(await client.cancelAndRefundSubscription!('sub_x', { refundPaidSince: SINCE })).toEqual({ settled: true });
    expect(calls.cancel).toHaveBeenCalledWith('sub_x', { invoice_now: false, prorate: false },
      { idempotencyKey: 'matrix-free-owner-cancel:sub_x' });
    expect(calls.refund).toHaveBeenCalledTimes(1);
    expect(calls.refund).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_in_after' }),
      { idempotencyKey: 'matrix-free-owner-refund:pi_in_after' });
  });

  it('voids an open invoice so it can no longer be paid, and reports a draft as not yet settled', async () => {
    const open = fakeStripe({ subscriptionStatus: 'canceled', invoices: [{ id: 'in_open', status: 'open' }] });
    expect(await open.client.cancelAndRefundSubscription!('sub_x', { refundPaidSince: SINCE })).toEqual({ settled: true });
    expect(open.calls.voidInvoice).toHaveBeenCalledWith('in_open', {}, { idempotencyKey: 'matrix-free-owner-void:in_open' });
    expect(open.calls.cancel).not.toHaveBeenCalled();

    const draft = fakeStripe({ subscriptionStatus: 'canceled', invoices: [{ id: 'in_draft', status: 'draft' }] });
    expect(await draft.client.cancelAndRefundSubscription!('sub_x', { refundPaidSince: SINCE })).toEqual({ settled: false });
  });

  it('treats an already refunded charge as done', async () => {
    const refunded = Object.assign(new Error('already refunded'), { code: 'charge_already_refunded' });
    const { client } = fakeStripe({ invoices: [{ id: 'in_after', status: 'paid', status_transitions: { paid_at: seconds(1_000) } }],
      refundError: refunded });
    expect(await client.cancelAndRefundSubscription!('sub_x', { refundPaidSince: SINCE })).toEqual({ settled: true });
  });

  it('fails (for a retry) on any other refund error', async () => {
    const { client } = fakeStripe({ invoices: [{ id: 'in_after', status: 'paid', status_transitions: { paid_at: seconds(1_000) } }],
      refundError: new Error('network') });
    await expect(client.cancelAndRefundSubscription!('sub_x', { refundPaidSince: SINCE })).rejects.toThrow('network');
  });
});
