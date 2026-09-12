// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingPanel } from '../../shell/src/components/settings/sections/BillingPanel';
import type { MatrixBillingPublicEntitlement } from '@matrix-os/contracts';

vi.mock('@clerk/nextjs', () => ({useUser: () => ({user: {publicMetadata: {}}})}));
vi.mock('../../shell/src/lib/posthog-client', () => ({capturePostHogEvent: vi.fn(), capturePostHogLog: vi.fn()}));
const entitlement: MatrixBillingPublicEntitlement = {
 source: 'override', planSlug: 'matrix_builder', status: 'active',
 maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
 allowedPlanSlugs: ['matrix_builder'], allowedSelections: [], portalAvailable: true,
 billingInterval: null, recurringPrice: null, runtimePlacement: null,
 gracePeriodEndsAt: null, trialStartedAt: null, trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null,
 effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveUntil: null, updatedAt: '2026-09-01T00:00:00.000Z',
};
afterEach(() => {cleanup(); vi.restoreAllMocks();});
describe('Web Desktop and Web Canvas billing portal access', () => {
 it('allows a customer with a support override to request invoices', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {status: 503}));
  render(<BillingPanel active entitlement={entitlement} mode="settings" />);
  const receipts = screen.getByRole('button', {name: 'View receipts'}) as HTMLButtonElement;
  expect(receipts.disabled).toBe(false);
  expect(screen.queryByText(/managed internally/)).toBeNull();
  fireEvent.click(receipts);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/billing/portal', expect.objectContaining({method: 'POST', credentials: 'include', signal: expect.any(AbortSignal)})));
  await waitFor(() => expect(screen.getByText('Billing portal is unavailable. Try again in a moment.')).toBeTruthy());
 });
 it('does not label a Stripe customer as internally managed when the portal is unavailable', () => {
  render(<BillingPanel active entitlement={{...entitlement, source: 'stripe', portalAvailable: false}} mode="settings" />);
  expect(screen.queryByText(/managed internally/)).toBeNull();
  expect(screen.getAllByText(/Billing management is not available for this account yet/).length).toBeGreaterThan(0);
 });
 it.each(['past_due', 'canceled', 'unpaid'] as const)('keeps receipts accessible when runtime billing is %s', () => {
  render(<BillingPanel active={false} entitlement={{...entitlement, source: 'stripe', status}} mode="settings" />);
  expect((screen.getByRole('button', {name: 'View receipts'}) as HTMLButtonElement).disabled).toBe(false);
 });

 // A malformed or regressed platform response must never navigate the shell to a
 // relative, plaintext, or executable-scheme target.
 it.each([
  ['a relative path', '/billing/portal'],
  ['a plaintext URL', 'http://billing.stripe.com/p/session'],
  // eslint-disable-next-line no-script-url
  ['an executable scheme', 'javascript:alert(1)'],
  ['a data URL', 'data:text/html,<script>alert(1)</script>'],
  ['an overlong URL', `https://billing.stripe.com/p/${'a'.repeat(2048)}`],
  ['a missing URL', undefined],
 ])('refuses to navigate to %s returned by the portal endpoint', async (_label, url) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
   new Response(JSON.stringify(url === undefined ? {} : {url}), {status: 200}),
  );
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {configurable: true, value: {...original, assign}});
  try {
   render(<BillingPanel active entitlement={entitlement} mode="settings" />);
   fireEvent.click(screen.getByRole('button', {name: 'View receipts'}));
   await waitFor(() =>
    expect(screen.getByText('Billing portal is unavailable. Try again in a moment.')).toBeTruthy(),
   );
   expect(assign).not.toHaveBeenCalled();
  } finally {
   Object.defineProperty(window, 'location', {configurable: true, value: original});
  }
 });

 it('navigates to a normal Stripe HTTPS portal redirect', async () => {
  const target = 'https://billing.stripe.com/p/session/live_abc123';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
   new Response(JSON.stringify({url: target}), {status: 200}),
  );
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {configurable: true, value: {...original, assign}});
  try {
   render(<BillingPanel active entitlement={entitlement} mode="settings" />);
   fireEvent.click(screen.getByRole('button', {name: 'View receipts'}));
   await waitFor(() => expect(assign).toHaveBeenCalledWith(target));
  } finally {
   Object.defineProperty(window, 'location', {configurable: true, value: original});
  }
 });
});
