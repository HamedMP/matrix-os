// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HarnessWorkflowPanel } from '../../packages/ui/src/agents-providers/HarnessWorkflowPanel';
import { createProviderWorkflowClient } from '../../packages/ui/src/agents-providers/provider-workflow-client';
import { ProviderSettingsController } from '../../packages/ui/src/agents-providers/provider-settings-controller';
import { invalidateDesktopProviderCatalog } from '../../desktop/src/renderer/src/features/chat/provider-catalog-invalidation';
import { stopDesktopProviderCatalogCoordinator } from '../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator';
import { desktopProviderIdentityKey } from '../../desktop/src/renderer/src/lib/provider-settings-identity';
import { useConnection } from '../../desktop/src/renderer/src/stores/connection';
import { disconnectedSnapshot } from '../ui/chat-provider-settings-fixture';

afterEach(() => {
  cleanup(); stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true); vi.restoreAllMocks();
});
const device = { id: 'openai_device_code', providerId: 'openai', authKind: 'subscription', method: 'device_code', billingKind: 'subscription', executionKind: 'native', availability: 'available' } as const;

it.each(['accepted', 'refused'] as const)('keeps natural Settings completion and the existing catalog invalidation boundary ordered when refresh is %s', async result => {
  const identityKey = desktopProviderIdentityKey(useConnection.getState());
  const generation = useConnection.getState().providerCatalogGeneration;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const getSnapshot = vi.fn(() => new Promise<unknown>((done, fail) => { resolve = done; reject = fail; }));
  const mutate = vi.fn();
  const onCatalogChanged = vi.fn(() => invalidateDesktopProviderCatalog(identityKey));
  const controller = new ProviderSettingsController({ identityKey, transport: { getSnapshot, mutate }, onCatalogChanged });
  const request = vi.fn(async () => ({
    id: 'workflow_fixture', harnessInstanceId: 'harness_codex', kind: 'login', state: 'succeeded',
    expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: null, deviceCode: null,
    terminalSessionId: null, safeFailure: null, connectionOption: device,
  }));
  const openTerminal = vi.fn(), openAuthorization = vi.fn();
  try {
    render(<HarnessWorkflowPanel
      harness={{ id: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'installed', authState: 'unauthenticated' }}
      capability={{ harnessInstanceId: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], connectionOptions: [device], apiKeyProviders: [], install: false, uninstall: false, logs: false }}
      client={createProviderWorkflowClient(request)} disabled={false} onRefresh={vi.fn()}
      onRefreshAfterLogin={async () => { if (!await controller.refreshForConnection()) throw new Error('Refresh unavailable'); }}
      onOpenTerminal={openTerminal} onOpenAuthorizationUrl={openAuthorization} />);
    fireEvent.click(screen.getByRole('button', { name: /ChatGPT account.*Sign in with a code/ }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    expect(screen.getByRole('status', { name: 'Updating connection' })).toBeVisible();
    expect(onCatalogChanged).not.toHaveBeenCalled();
    expect(useConnection.getState().providerCatalogGeneration).toBe(generation);
    await act(async () => { if (result === 'accepted') resolve(disconnectedSnapshot()); else reject(new Error('Synthetic refusal')); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Updating connection' })).toBeNull());
    expect(getSnapshot).toHaveBeenCalledWith(expect.any(AbortSignal), { refresh: true });
    expect(getSnapshot).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled(); expect(openTerminal).not.toHaveBeenCalled(); expect(openAuthorization).not.toHaveBeenCalled();
    if (result === 'accepted') {
      expect(onCatalogChanged).toHaveBeenCalledOnce();
      expect(useConnection.getState().providerCatalogGeneration).toBe(generation + 1);
      expect(screen.queryByRole('alert')).toBeNull();
    } else {
      expect(onCatalogChanged).not.toHaveBeenCalled();
      expect(useConnection.getState().providerCatalogGeneration).toBe(generation);
      expect(screen.getByText('Sign-in completed. Connection status is unavailable. Check again.')).toBeVisible();
    }
  } finally { controller.dispose(); }
});
