// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderSettingsSnapshot, ProviderWorkflowCapability } from '@matrix-os/contracts';
import { AgentsProvidersView } from '../../packages/ui/src/agents-providers/AgentsProvidersView';
import type { ProviderWorkflowClient } from '../../packages/ui/src/agents-providers/types';
afterEach(cleanup);
const snapshot = { refreshedAt: '2026-10-04T00:00:00Z', access: { mode: 'writable' }, supportedActions: [], configurationHarnessKinds: [], gatewayPolicy: null, modelProviders: [], accounts: [], accessSources: [], harnesses: [{ id: 'codex', harness: 'codex', displayName: 'Codex', enabled: true, installState: 'installed', authState: 'authenticated', loginMethods: ['terminal'], connectivity: 'online', accountIds: [], selectedAccountId: null, accessSourceId: null, route: { kind: 'fixed', providerId: 'openai', modelId: 'test' } }] } as unknown as ProviderSettingsSnapshot;
const capability = { harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: ['openai'], install: false, uninstall: false, logs: false, activeOperationId: 'previous-login' } as ProviderWorkflowCapability;
function client(state: 'failed' | 'expired' | 'running'): ProviderWorkflowClient {
  return { capabilities: vi.fn().mockResolvedValue([capability]), get: vi.fn().mockResolvedValue({ id: 'previous-login', harnessInstanceId: 'codex', kind: 'login', state, expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: state === 'running' ? null : 'unavailable' }), start: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
}
it.each(['failed', 'expired'] as const)('keeps the confirmed connected row over a stale %s login receipt', async state => {
  const api = client(state); const mutate = vi.fn();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="codex" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={mutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} workflowClient={api} onAddCredit={vi.fn()} />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  const row = screen.getByRole('button', { name: /^Codex/ });
  await waitFor(() => expect(within(row).getByText('Connected')).toBeVisible());
  expect(within(row).queryByText("Couldn't connect")).toBeNull();
  expect(screen.queryByRole('button', { name: /Continue in Terminal/ })).toBeNull();
  expect(api.start).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
});
it('gives an active replacement login precedence without automatically starting another login', async () => {
  const api = client('running');
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="codex" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} workflowClient={api} onAddCredit={vi.fn()} />);
  await waitFor(() => expect(within(screen.getByRole('button', { name: /^Codex/ })).getByText('Connecting')).toBeVisible());
  expect(api.start).not.toHaveBeenCalled();
});
