// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveBillingPanel } from '../../shell/src/components/settings/sections/BillingManagementPanel';
import type { MatrixBillingPublicEntitlement, MatrixBillingManagement } from '@matrix-os/contracts';
vi.mock('../../shell/src/lib/posthog-client', () => ({ capturePostHogLog: vi.fn() }));
const entitlement: MatrixBillingPublicEntitlement = {
  source: 'override', planSlug: 'internal', status: 'active', maxRuntimeSlots: 3, includedRuntimeSlots: 3, addonRuntimeSlots: 0,
  allowedPlanSlugs: ['matrix_starter'], allowedSelections: [], portalAvailable: false,
  billingInterval: null, recurringPrice: null, runtimePlacement: null, gracePeriodEndsAt: null,
  trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null,
  effectiveFrom: '2026-09-07T00:00:00.000Z', effectiveUntil: null, updatedAt: '2026-09-07T00:00:00.000Z',
};
afterEach(cleanup);
describe('Web Canvas and Web Desktop billing management', () => {
  it('renders team access without fictional billing or unusable subscription actions', () => {
    render(<ActiveBillingPanel entitlement={entitlement} accessReason="active" />);
    expect(screen.getByText('Team-provided access')).toBeTruthy();
    expect(screen.getByText('Up to 3 computers')).toBeTruthy();
    expect(screen.queryByText('Monthly')).toBeNull();
    expect(screen.queryByText('Managed subscription')).toBeNull();
    expect(screen.queryByText('Canceling')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
  });
  const management: MatrixBillingManagement = {
    portalAvailable: true, runtimeSlot: 'primary', computerCount: 1, runtimePlacement: null,
    subscription: { planSlug: 'matrix_builder', status: 'active', billingInterval: 'annual',
      recurringPrice: { unitAmountMinor: 99000, currency: 'usd', interval: 'annual', intervalCount: 1, quantity: 1 },
      currentPeriodEnd: null, trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null },
  };
  it('shows the actual subscription and receipts despite an internal override', () => {
    render(<ActiveBillingPanel entitlement={entitlement} management={management} accessReason="active" />);
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('$990/year')).toBeTruthy();
    expect(screen.getByText('1 computers on this account')).toBeTruthy();
    expect(screen.getByText('Not available')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'View receipts' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Internal')).toBeNull();
  });
  it('retains receipts for a linked customer without an entitlement or subscription', () => {
    render(<ActiveBillingPanel entitlement={null} management={{ ...management, subscription: null }} accessReason="no_entitlement" />);
    expect((screen.getByRole('button', { name: 'View receipts' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
  });
  it('shows one explanation when an internal account has no billing customer', () => {
    render(<ActiveBillingPanel entitlement={entitlement} management={{ ...management, subscription: null, portalAvailable: false }} accessReason="active" />);
    expect(screen.getAllByText(/Billing management is not available/)).toHaveLength(1);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('Monthly')).toBeNull();
  });

});
