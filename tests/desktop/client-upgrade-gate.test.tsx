// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientUpgradeGate } from '../../desktop/src/renderer/src/features/updates/ClientUpgradeGate';
const policy = { latestVersion: '2.0.0', minSupportedVersion: '1.5.0', downloadUrl: 'https://matrix-os.com/download', enforceAfter: '2026-01-01T00:00:00.000Z' };
describe('desktop client minimum gate', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('blocks an unsupported client but leaves upgrade actions available', async () => {
    vi.stubGlobal('operator', { invoke: vi.fn(async () => ({ version: '1.0.0', schemaVersion: 1, revision: 1, policy })) });
    render(<ClientUpgradeGate><div>Workspace</div></ClientUpgradeGate>);
    await waitFor(() => expect(screen.getByText('Update Matrix OS to continue')).toBeTruthy());
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download update' })).toBeTruthy();
  });
  it('preserves access when no policy exists', async () => {
    vi.stubGlobal('operator', { invoke: vi.fn(async () => ({ version: '1.0.0', schemaVersion: 1, revision: 0, policy: null })) });
    render(<ClientUpgradeGate><div>Workspace</div></ClientUpgradeGate>);
    await waitFor(() => expect(screen.getByText('Workspace')).toBeTruthy());
  });
});
