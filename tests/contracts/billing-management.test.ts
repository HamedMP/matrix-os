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
