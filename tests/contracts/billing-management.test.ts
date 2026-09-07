import { describe, expect, it } from 'vitest';
import { deriveBillingManagementView, MatrixBillingManagementSchema } from '@matrix-os/contracts';

describe('shared billing presentation', () => {
  it('does not invent a monthly interval when price and interval are unknown', () => {
    const management = MatrixBillingManagementSchema.parse({
      portalAvailable: true, runtimeSlot: 'primary', computerCount: 0, runtimePlacement: null,
      subscription: { planSlug: 'matrix_builder', status: 'active', billingInterval: null, recurringPrice: null,
        trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null, currentPeriodEnd: null },
    });
    expect(deriveBillingManagementView(null, management)).toMatchObject({ planName: 'Builder', billingLabel: 'Not available', portalAvailable: true });
  });
  it('rejects private customer and provider identifiers in management details', () => {
    expect(MatrixBillingManagementSchema.safeParse({
      portalAvailable: false, subscription: null, runtimeSlot: 'primary', computerCount: 0, runtimePlacement: null,
      stripeCustomerId: 'cus_private',
    }).success).toBe(false);
  });
});

describe('trial presentation boundaries', () => {
  const now = Date.parse('2026-09-07T12:00:00.000Z');
  function trial(trialEndsAt: string) {
    return MatrixBillingManagementSchema.parse({
      portalAvailable: true, runtimeSlot: 'primary', computerCount: 1, runtimePlacement: null,
      subscription: { planSlug: 'matrix_builder', status: 'trialing', billingInterval: 'monthly', recurringPrice: null,
        trialEndsAt, trialConvertedAt: null, firstTrialPaymentFailedAt: null, currentPeriodEnd: null },
    });
  }
  it.each(['2026-09-07T11:59:59.000Z', '2026-09-07T12:00:00.000Z'])(
    'requires payment at or beyond the trial deadline %s even before a webhook', (deadline) => {
      expect(deriveBillingManagementView(null, trial(deadline), 'active', now)).toMatchObject({
        paymentRequired: true, trialEndsAt: null, statusLabel: 'Payment required',
      });
    },
  );
  it('does not advertise an active trial when the server requires payment', () => {
    expect(deriveBillingManagementView(null, trial('2026-09-08T00:00:00.000Z'), 'payment_required', now))
      .toMatchObject({ paymentRequired: true, trialEndsAt: null });
  });
  it('keeps an unexpired trial active', () => {
    expect(deriveBillingManagementView(null, trial('2026-09-08T00:00:00.000Z'), 'active', now))
      .toMatchObject({ paymentRequired: false, trialEndsAt: '2026-09-08T00:00:00.000Z' });
  });
  it('does not request payment for an already converted trial', () => {
    const management = trial('2026-09-01T00:00:00.000Z');
    management.subscription!.trialConvertedAt = '2026-09-01T00:00:00.000Z';
    expect(deriveBillingManagementView(null, management, 'active', now))
      .toMatchObject({ paymentRequired: false, trialEndsAt: null });
  });
});
