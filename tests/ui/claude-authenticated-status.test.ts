// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAccessSource } from '@matrix-os/contracts';
import { HarnessRail } from '../../packages/ui/src/agents-providers/HarnessRail';
import { BotUseAuthorizationPanel } from '../../packages/ui/src/agents-providers/BotUseAuthorizationPanel';
import { AccountLifecycleActions } from '../../packages/ui/src/agents-providers/AccountLifecycleActions';
import { hasConfiguredConnection } from '../../packages/ui/src/agents-providers/harness-connection';
import { disconnectedSnapshot } from './chat-provider-settings-fixture';

afterEach(cleanup);

function fixture(enabled: boolean, authState: 'authenticated' | 'unknown' | 'unauthenticated' | 'expired' | 'failed' = 'authenticated') {
  const snapshot = disconnectedSnapshot();
  const harness = snapshot.harnesses[0]!;
  const source: ProviderAccessSource = { id: 'owner_claude_profile', kind: 'provider_account', fundingKind: 'owner_account', providerId: 'anthropic',
    accountId: 'owner_claude_profile', displayName: 'Claude account', eligibleModelIds: ['sonnet'],
    readiness: { state: 'unknown', checkedAt: null, staleAfter: null, action: 'retry', safeReason: 'unknown' },
    usage: { kind: 'unavailable', authority: 'unavailable', state: 'unavailable', scope: 'account', reason: 'unknown', asOf: null } };
  Object.assign(harness, { authState, enabled, configuredEnabled: enabled, accessSourceId: source.id,
    selectedAccountId: source.accountId, accountIds: [source.accountId!], connectivity: 'unknown' });
  snapshot.harnesses = [harness]; snapshot.accessSources = [source];
  // Even a displayed saved account/logout action cannot override unknown CLI auth.
  snapshot.accounts = [{ id: source.accountId!, providerId: 'anthropic', displayName: 'saved@example.invalid', authMethod: 'terminal',
    authState: 'authenticated', lastCheckedAt: snapshot.refreshedAt, accessSourceId: source.id,
    dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } }];
  return { snapshot, harness, source };
}

function setup(enabled: boolean, bot: 'pending' | 'unavailable', override?: string, authState: Parameters<typeof fixture>[1] = 'authenticated') {
  const f = fixture(enabled, authState);
  const authorizeConnection = vi.fn(), onMutate = vi.fn(), onEnable = vi.fn();
  const client = { connections: vi.fn(() => bot === 'pending' ? new Promise<never>(() => undefined) : Promise.resolve({ connections: [{
    id: 'claude_code_tasks' as const, providerId: 'anthropic' as const, executionKind: 'native_task' as const,
    availability: 'unavailable' as const, unavailableReason: 'unsupported_runtime' as const, models: [],
    authorization: { revision: 0, enabled: false, background: false }, coordinatorFunding: 'separate' as const,
  }] })), authorizeConnection, execution: vi.fn(), configureExecution: vi.fn() };
  const before = structuredClone(f.snapshot);
  render(createElement(HarnessRail, { harnesses: f.snapshot.harnesses, sources: [f.source], accounts: f.snapshot.accounts,
    selectedId: f.harness.id, disabled: false, canEnable: () => true, onSelect: vi.fn(), onEnable,
    statusOverride: override ? { [f.harness.id]: override } : undefined,
    renderDetails: () => createElement(Fragment, {},
      createElement(BotUseAuthorizationPanel, { client, harness: 'claude', disabled: false }),
      createElement(AccountLifecycleActions, { accounts: f.snapshot.accounts, snapshot: f.snapshot, harnessId: f.harness.id,
        scopeOwner: client, disabled: false, canLogout: true, canRemove: false, canReassign: false, onMutate, onRefresh: vi.fn() })),
  }));
  return { ...f, before, authorizeConnection, onMutate, onEnable };
}

it.each([true, false])('shows verified Claude auth as Connected while Bot discovery is pending and enabled=%s', enabled => {
  const f = setup(enabled, 'pending', 'Connecting');
  expect(screen.getByRole('button', { name: /Claude Code.*Connected/ })).toBeVisible();
  expect(screen.getByText('Loading Bot authorization…')).toBeVisible();
  expect(hasConfiguredConnection(f.harness, f.source)).toBe(enabled);
  expect(f.snapshot).toEqual(f.before);
  expect(f.authorizeConnection).not.toHaveBeenCalled(); expect(f.onEnable).not.toHaveBeenCalled(); expect(f.onMutate).not.toHaveBeenCalled();
});

it.each([true, false])('keeps verified Claude auth Connected when Bot capability is unavailable and enabled=%s', async enabled => {
  const f = setup(enabled, 'unavailable');
  await screen.findByText('Bot execution is unavailable on this computer.');
  expect(screen.getByRole('button', { name: /Claude Code.*Connected/ })).toBeVisible();
  expect(f.snapshot).toEqual(f.before);
  expect(f.authorizeConnection).not.toHaveBeenCalled(); expect(f.onEnable).not.toHaveBeenCalled(); expect(f.onMutate).not.toHaveBeenCalled();
});

it.each(['unknown', 'unauthenticated', 'expired', 'failed'] as const)('does not treat a saved email/logout action as proof when native auth is %s', authState => {
  setup(false, 'pending', undefined, authState);
  expect(screen.getByRole('button', { name: 'Log out saved@example.invalid' })).toBeVisible();
  expect(screen.getByRole('button', { name: /Claude Code.*Not connected/ })).toBeVisible();
});
