// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole("button", {name: /^Codex/}));
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
  fireEvent.click(screen.getByRole('button', {name: /^Codex/}));
  await waitFor(() => expect(within(screen.getByRole('button', { name: /^Codex/ })).getByText('Connecting')).toBeVisible());
  expect(api.start).not.toHaveBeenCalled();
});

it.each(['pi', 'opencode'] as const)('preserves %s saved model and access controls only inside collapsed Advanced configuration', async kind => {
  const row = { ...snapshot.harnesses[0]!, id: kind, harness: kind, displayName: kind, enabled: false,
    authState: 'unauthenticated' as const, route: { kind: 'configurable' as const, providerId: 'anthropic', modelId: 'test' } };
  const source = { id: 'matrix_included', kind: 'matrix_gateway', providerId: 'anthropic', accountId: null, displayName: 'Matrix AI',
    fundingKind: 'matrix_included', eligibleModelIds: ['test', 'other'],
    readiness: { state: 'ready', checkedAt: snapshot.refreshedAt, staleAfter: '2099-01-01T00:00:00Z', action: 'none', safeReason: null },
    usage: { kind: 'unavailable', authority: 'unavailable', state: 'not_applicable', scope: 'access_source', reason: 'provider_does_not_report', asOf: snapshot.refreshedAt } };
  const next = { ...snapshot, atomicConnectSupported: true, harnesses: [row], configurationHarnessKinds: [kind],
    supportedActions: ['set_route', 'select_access_source'], accessSources: [source],
    modelProviders: [{ id: 'anthropic', displayName: 'Anthropic', models: [{ id: 'test', displayName: 'Test', enabled: true }, { id: 'other', displayName: 'Other', enabled: true }] }],
    gatewayPolicy: { accessSourceId: 'matrix_included', allowedModelIds: ['test', 'other'], monthlyBudgetMicrousd: 100000, topUpEnabled: false } } as unknown as ProviderSettingsSnapshot;
  const api = client('running');
  api.capabilities = vi.fn().mockResolvedValue([{ ...capability, harnessInstanceId: kind, harness: kind, displayName: kind, activeOperationId: undefined }]);
  const mutate = vi.fn();
  render(<AgentsProvidersView snapshot={next} selectedHarnessId={kind} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={mutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} workflowClient={api} onAddCredit={vi.fn()} />);
  const summary = await screen.findByText('Advanced configuration');
  const advanced = summary.closest('details')!;
  expect(advanced).not.toHaveAttribute('open');
  expect(within(advanced).getByText('Use Matrix AI').closest('button')).toBeInTheDocument();
  expect(within(advanced).getByLabelText('Model')).toHaveValue('test');
  expect(within(advanced).getByLabelText('Paid through')).toBeInTheDocument();
  expect(screen.queryByText('Enable this agent')).not.toBeInTheDocument();
  fireEvent.click(summary);
  fireEvent.change(within(advanced).getByLabelText('Model'), { target: { value: 'other' } });
  expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_route', harnessInstanceId: kind,
    route: { kind: 'configurable', providerId: 'anthropic', modelId: 'other' }, accessSourceId: 'matrix_included', accountId: null }));
});
