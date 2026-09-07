import type { MatrixBillingManagement, MatrixBillingPublicEntitlement } from '@matrix-os/contracts';

/** Deterministic data, used only behind NEXT_PUBLIC_E2E_TEST_BYPASS. */
export function billingManagementScenario(scenario: string | null): {
  entitlement: MatrixBillingPublicEntitlement;
  management: MatrixBillingManagement;
} | null {
  if (scenario !== 'team-access' && scenario !== 'override-paid') return null;
  const paid = scenario === 'override-paid';
  return {
    entitlement: {
      source: 'override', planSlug: 'internal', status: 'active', maxRuntimeSlots: 3, includedRuntimeSlots: 3, addonRuntimeSlots: 0,
      allowedPlanSlugs: ['matrix_starter', 'matrix_max'], allowedSelections: [], portalAvailable: paid,
      billingInterval: null, recurringPrice: null, runtimePlacement: null, gracePeriodEndsAt: null,
      trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null,
      effectiveFrom: '2026-09-07T00:00:00.000Z', effectiveUntil: null, updatedAt: '2026-09-07T00:00:00.000Z',
    },
    management: {
      portalAvailable: paid, runtimeSlot: 'primary', computerCount: 2,
      runtimePlacement: { regionSlug: 'region_fsn1', label: 'Falkenstein', countryLabel: 'Germany', networkZone: 'eu-central' },
      subscription: paid ? {
        planSlug: 'matrix_builder', status: 'active', billingInterval: 'annual',
        recurringPrice: { unitAmountMinor: 99000, currency: 'usd', interval: 'annual', intervalCount: 1, quantity: 1 },
        currentPeriodEnd: '2027-09-07T00:00:00.000Z', trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null,
      } : null,
    },
  };
}
