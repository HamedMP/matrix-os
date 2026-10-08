// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderAccountSchema, ProviderAccessSourceSchema, ProviderHarnessInstanceSchema } from '@matrix-os/contracts';
import { ConnectedAccountCard } from '../../packages/ui/src/agents-providers/ConnectedAccountCard.js';
afterEach(cleanup);
// Contract-valid synthetic data only: no provider call, credentials, or live entitlement.
const harness = ProviderHarnessInstanceSchema.parse({
  id: 'harness_claude', harness: 'claude', displayName: 'Claude Code',
  authState: 'authenticated', enabled: true, accentColor: null, version: null,
  installState: 'installed', loginMethods: ['oauth'], recommendedLoginMethod: 'oauth',
  connectivity: 'unknown', accountIds: ['synthetic_claude'], selectedAccountId: 'synthetic_claude',
  accessSourceId: 'synthetic_claude_source',
  route: { kind: 'fixed', providerId: 'anthropic', modelId: 'claude-sonnet' }, activeChatCount: 0,
});
const account = ProviderAccountSchema.parse({
  id: 'synthetic_claude', providerId: 'anthropic', displayName: 'Synthetic Claude account',
  authMethod: 'oauth', authState: 'authenticated', lastCheckedAt: null,
  accessSourceId: 'synthetic_claude_source',
  dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 },
  // The current identity contract does not support Claude plan names.
  connectionDetails: { email: 'fixture@example.test' },
});
const sourceBase = {
  id: 'synthetic_claude_source', kind: 'provider_account', fundingKind: 'owner_subscription',
  providerId: 'anthropic', accountId: 'synthetic_claude', displayName: 'Synthetic Claude source',
  eligibleModelIds: [],
  readiness: { state: 'unknown', checkedAt: null, staleAfter: null, action: 'retry', safeReason: 'unknown' },
};
it('renders simulated authoritative Claude identity and remaining allowance, independently of model execution', () => {
  const source = ProviderAccessSourceSchema.parse({ ...sourceBase, usage: { kind: 'subscription_allowance', authority: 'provider_allowance', state: 'current', scope: 'account', usedBasisPoints: 4200, resetsAt: '2026-10-10T00:00:00Z', asOf: '2026-10-03T00:00:00Z' } });
  render(<ConnectedAccountCard harness={harness} account={account} source={source} disabled={false} onRefresh={vi.fn()} action={<button>Change account</button>} />);
  expect(screen.getByRole('region', { name: 'Claude Code connection' })).toBeInTheDocument();
  expect(screen.getByText('Claude account')).toBeVisible();
  expect(screen.queryByText('Claude Max')).not.toBeInTheDocument();
  expect(screen.getByText('fixture@example.test')).toBeVisible();
  expect(screen.getByText('42% used')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '5800');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '58% remaining');
  expect(screen.getByText(/Resets Oct 10, 2026/)).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Change account' })).toHaveLength(1);
  expect(source.readiness.state).toBe('unknown');
});
it('does not fabricate a Claude subscription, email, allowance or reset from authentication alone', () => {
  const source = ProviderAccessSourceSchema.parse({ ...sourceBase, usage: { kind: 'unavailable', reason: 'unknown', authority: 'unavailable', state: 'unavailable', scope: 'account', asOf: null } });
  const noEntitlement = { ...account, connectionDetails: undefined };
  render(<ConnectedAccountCard harness={harness} account={noEntitlement} source={source} disabled={false} onRefresh={vi.fn()} action={<button>Change account</button>} />);
  expect(screen.getByText('Claude account')).toBeVisible();
  expect(screen.getByText('Synthetic Claude account')).toBeVisible();
  expect(screen.getByText('Usage unavailable')).toBeVisible();
  expect(screen.queryByText('Claude Max')).not.toBeInTheDocument();
  expect(screen.queryByText('fixture@example.test')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText(/Resets/)).not.toBeInTheDocument();
  expect(screen.queryByText('0% used')).not.toBeInTheDocument();
});
